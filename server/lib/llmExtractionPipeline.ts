/**
 * Phase 27.4.6 (D-04 / D-10) — shared LLM extraction dispatch helper.
 *
 * `runRefreshExtraction` owns the v3 extraction kick-off that used to
 * live as a fire-and-forget block inside `/api/events`. After the
 * cron-driven trigger phase shipped, the route is cache-only — every
 * code path that fires an extraction calls this helper instead.
 *
 * The function is fire-and-forget by design: the actual `processEventGroupsV3`
 * + `geocodeEnrichedEventsV3` work is launched as a `void async () => {}` IIFE
 * so the caller's response cycle is not held open while the LLM pipeline runs
 * (~13 minutes typical; bounded by the Vercel Pro 800s `maxDuration` ceiling).
 *
 * Decisions tracked:
 *   - D-04: verbatim port of the prior fire-and-forget body — zero re-implementation.
 *   - D-06: stamps `lastTriggerSource` into `llmProgress` so DevApiStatus can
 *     differentiate cron-fired runs from /api/events-fired runs (the latter
 *     no longer happens after Phase 27.4.6).
 *   - D-10: cold-cache probe BEFORE the cooldown check — when the active
 *     `events:llm:v3` key is empty, the cooldown is bypassed automatically so
 *     the first invocation after a fresh deploy always populates the cache.
 *   - D-11: `forceCooldown` opt-in lets the cron route's `?force=true` query
 *     param bypass the 15-min cooldown for operator-driven re-extractions.
 *
 * Phase 29 D-02 part C collapsed the v1/v2/v3 dispatch to v3-only:
 *   - `LLM_EVENTS_KEY_ACTIVE` is now the literal `'events:llm:v3'`.
 *   - `LLM_SUMMARY_KEY_ACTIVE` is now the literal `'events:llm-summary:v3'`.
 *   - `BATCH_SIZE_ACTIVE` is the v3 default (2; see llmEventExtractor.v3.ts).
 *   - The v1 + v2 entity adapters were deleted along with the extractor modules.
 *
 * Phase 38 LLM-PURGE-01 — the `llmEventExtractor.ts` v3-only re-export barrel
 * was deleted; this module imports `processEventGroupsV3` +
 * `geocodeEnrichedEventsV3` directly from `./llmEventExtractor.v3.js`.
 */

import { isLLMConfigured } from '../adapters/llm-provider.js';
import { saveDevLLMCacheV2 } from '../cache/devFileCache.js';
import { cacheGetSafe, cacheSetReported, cacheSetSafe, redis } from '../cache/redis.js';
import { env } from '../config.js';

import { checkCorroboration } from './corroboration.js';
import { dedupHighConfidence, enrichedIdForGroup, groupGdeltRows } from './eventGrouping.js';
import { countDLQ } from './llmDLQ.js';
import { runEval } from './llmEvalHarness.js';
import {
  processEventGroupsV3,
  geocodeEnrichedEventsV3,
  type GeocodedEnrichedEventV3,
} from './llmEventExtractor.v3.js';
import {
  llmProgress,
  resetProgress,
  updateProgress,
  buildSummary,
  type RunHistoryEntry,
} from './llmProgress.js';
// Phase 39 OBS-FLIGHT-02 — durable per-run record at the run boundary. GA-2:
// openRunRecord writes a 'running' record at run start (so a maxDuration-killed
// run leaves an honest "run that died" trace, Pitfall 5); closeRunRecord
// re-LPUSHes the terminal record at every run-exit branch. Degrade-open.
import { openRunRecord, closeRunRecord } from './llmRunHistory.js';
import { shouldPauseNewEvents, prioritizeBySeverity } from './llmTokenBudget.js';
import { logger } from './logger.js';
import { EVENTS_KEY, EVENTS_LOGICAL_TTL_MS, refreshRawEvents } from './rawEventsRefresh.js';
import { computeCompositeScore } from './relevanceScorer.js';
import { safeWaitUntil } from './safeWaitUntil.js';
import { getHighestTier } from './sourceTiers.js';
// Phase 32 Plan 32-03 Task 3 — cron post-step. After the existing
// extraction work resolves inside the safeWaitUntil IIFE, run the URL
// liveness probe sweep (Plan 32-02) and then the auto-prune helper
// (Plan 32-03 Task 1) — gated on a wall-clock deadline so we stay
// inside Vercel Pro's 800s `maxDuration` (Pitfall 1, RESEARCH A6).
//
// DIRECT helper invocation (NOT self-HTTP) per RESEARCH A4 / Discretion
// §3 — simpler tests, no env-dependent deployment URL, audit-log path
// is identical (helper writes `bearerFingerprint:'cron:refresh-events'`
// per RESEARCH A8). The HTTP route at POST /api/events/prune-dead-urls
// (Plan 32-03 Task 2) is for operator clicks only.
import {
  buildProbeCandidates,
  pruneDeadUrlEvents,
  runProbeSweep,
  SWEEP_SAFETY_MARGIN_MS,
} from './urlLiveness.js';

import type { ConflictEventEntity, NewsCluster } from '../types.js';
import type { EventGroup } from './eventGrouping.js';
import type { GeocodeProvenance } from './llmSchema.js';

const log = logger.child({ module: 'llm-extraction-pipeline' });

// ---------------------------------------------------------------------------
// Cache keys + TTL constants (mirrors the values previously held in events.ts).
// Phase 29 D-02 part C — `*_ACTIVE` inlined to v3 constants since v1+v2 are gone.
// ---------------------------------------------------------------------------

/**
 * Active terminal LLM cache key. v3-only post-Phase-29.
 *
 * Phase 32 Plan 32-03 exports this so `pruneDeadUrlEvents`
 * (server/lib/urlLiveness.ts) shares one truth source on the v3 key
 * literal — the splice writer would otherwise hand-roll the string,
 * which is the exact drift class CLAUDE.md §"Serverless Cache" warns
 * against.
 */
export const LLM_EVENTS_KEY_ACTIVE = 'events:llm:v3';

/** Active LLM run-summary key. v3-only post-Phase-29. */
const LLM_SUMMARY_KEY_ACTIVE = 'events:llm-summary:v3';

// Phase 30 D-04 (SIMPLIFY-01): the local `PARTIAL_KEY_ACTIVE` const was
// retired here when the periodic-flush callback (its sole reader) was
// deleted.
// Phase 35 D-12 (SIMPLIFY-02): the `events:llm:v3:partial` observability key
// has now been retired in the v3 extractor too. The v3 extractor's
// writePartialCache writer was deleted in this phase; the terminal-key write
// at end of run is the sole canonical shape going forward.

/** Redis key tracking the last LLM run start time (15-min cooldown). */
const LLM_PROCESS_KEY = 'events:llm-process-ts';

/** 15 minute cooldown between LLM processing runs. */
const LLM_COOLDOWN_MS = 900_000;

/**
 * Hard Redis TTL for the `events:llm-process-ts` cooldown sentinel (2.5h).
 *
 * Bounds how long the cooldown stamp lives; the cooldown *duration* itself is
 * the separate LLM_COOLDOWN_MS (15 min). NOT used for the terminal
 * `events:llm:v3` enrichment cache — that uses LLM_TERMINAL_TTL_SEC below.
 */
export const LLM_REDIS_TTL_SEC = 9000;

/**
 * Hard Redis TTL for the terminal `events:llm:v3` enrichment cache (48h).
 *
 * MUST exceed the daily 04:00 UTC refresh-events cron interval (24h) so the
 * enriched cache survives the full inter-cron window. The old 2.5h
 * LLM_REDIS_TTL_SEC was a Hobby-era "10x the 15-min logical TTL" sizing —
 * far shorter than the once-daily cron cadence — which left `events:llm:v3`
 * empty for ~21.5h of every day, so `/api/events` fell through to the
 * raw-GDELT Pitfall-1 bridge and events rendered unenriched most of the day.
 * 48h gives one full day of margin: a single missed/failed cron run still
 * serves the prior day's enriched cache.
 *
 * Used by BOTH the cron terminal write (`mergeAndPersistLlmEntities`) AND the
 * `pruneDeadUrlEvents` splice-back (urlLiveness.ts) so a prune never silently
 * re-TTLs the v3 cache back down to the short cooldown TTL.
 */
export const LLM_TERMINAL_TTL_SEC = 172_800;

/** 24-hour TTL for LLM run summary (retained across runs). */
const LLM_SUMMARY_TTL_SEC = 86_400;

/** v3 BATCH_SIZE used for progress math. v2's BATCH_SIZE=2 is gone; v3 also uses 2. */
const BATCH_SIZE_ACTIVE = 2;

// Run budget, measured from the start of the cron request. The function is
// killed at 800 s (`maxDuration` in vercel.json), and the URL-liveness sweep
// that follows the extraction ends itself 60 s before that.
/** No new LLM wave starts after this; a wave in flight still finishes. */
const LLM_PHASE_BUDGET_MS = 480_000;
/** Geocoding stops here; whatever is geocoded by then is persisted. */
const GEOCODE_PHASE_BUDGET_MS = 660_000;
/** The eval harness only starts if the run got here faster than this. */
const EVAL_START_BUDGET_MS = 540_000;

function describeFatalStatus(status: number): string {
  if (status === 410)
    return 'the model has been retired; probe a replacement (/api/cron/llm-probe)';
  if (status === 404) return 'the model is not served to this key; probe a replacement';
  return 'the NIM API key was rejected';
}

// ---------------------------------------------------------------------------
// Phase 30 D-04 (SIMPLIFY-01) — incremental flush retired. The Pro 800s
// ceiling makes the prior Hobby-era 300s-budget crash-protection rationale
// obsolete (Plan 06 Run 2 validated 0 watchdog hard-kills inside budget).
// The terminal write at the end of `runRefreshExtraction`'s IIFE is now
// the canonical (and only) writer of `events:llm:v3`.
// ---------------------------------------------------------------------------

/**
 * Phase 28.2.6 Plan 01 — shared merge-and-persist helper.
 *
 * Single-purpose: end-of-run terminal write of `ConflictEventEntity[]` to
 * the active LLM cache key (`events:llm:v3`). Sole writer of the terminal
 * key (Phase 35 D-12 / SIMPLIFY-02 retired the partial-key observability
 * envelope; the previous two-key discipline collapses to one-key discipline).
 *
 * Phase 30 D-04: single callsite (end-of-run terminal write only). Periodic
 * flush retired (SIMPLIFY-01). The earlier periodic-flush hook inside the
 * onBatchComplete callback was removed because the Pro 800s ceiling makes
 * the prior Hobby-era crash-protection rationale obsolete.
 *
 * Pitfall 4 — merge-by-id with prior cache. The terminal flush merges with
 * llmCachedRef.data so events from earlier cron ticks survive the write.
 *
 * Pitfall 8 — does NOT call runEval(). The eval harness stays at its
 * existing post-FINAL-geocode location.
 *
 * Phase 29 D-02 part C — `pipelineV2 / pipelineV3` params dropped; the dev
 * file cache helper is unconditionally `saveDevLLMCacheV2` (the v3 path also
 * uses the v2 dev-file shape per the helper's documented contract).
 */
async function mergeAndPersistLlmEntities(
  newlyEnriched: ConflictEventEntity[],
  llmCachedRef: { data: ConflictEventEntity[] } | null,
  key: string,
): Promise<
  { writtenCount: number; total: number; merged: ConflictEventEntity[] } & (
    | { ok: true }
    | { ok: false; error: string }
  )
> {
  const llmMergeMap = new Map<string, ConflictEventEntity>();
  if (llmCachedRef?.data) {
    for (const e of llmCachedRef.data) llmMergeMap.set(e.id, e);
  }
  for (const e of newlyEnriched) llmMergeMap.set(e.id, e);
  const llmMerged = Array.from(llmMergeMap.values());
  const written = await cacheSetReported(key, llmMerged, LLM_TERMINAL_TTL_SEC);
  saveDevLLMCacheV2(llmMerged);
  const counts = { writtenCount: newlyEnriched.length, total: llmMerged.length };
  if (!written.ok) {
    log.error({ ...counts, err: written.error }, 'LLM: write to the enriched cache FAILED');
    return { ...counts, merged: llmMerged, ok: false, error: written.error };
  }
  log.info(counts, 'LLM: persisted enriched events');
  return { ...counts, merged: llmMerged, ok: true };
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/** Options for `runRefreshExtraction` — caller-supplied trigger metadata + cooldown override. */
export interface RunRefreshOpts {
  /** Provenance label stamped onto `llmProgress.lastTriggerSource` (D-06). */
  triggeredBy: 'cron' | 'manual';
  /** When true, bypass the 15-min `events:llm-process-ts` cooldown.
   *  Wired from `?force=true` (D-11) and from the cold-cache self-heal (D-10). */
  forceCooldown?: boolean;
}

/** Result of `runRefreshExtraction` — dispatch decision + skip reason if not dispatched. */
export interface RunRefreshResult {
  /** true if a fresh extraction was kicked off (fire-and-forget). */
  dispatched: boolean;
  /** Populated when `dispatched=false`. */
  reason?: 'cooldown' | 'llm_unconfigured' | 'no_raw_events' | 'pipeline_busy';
  /** Set when the cold-cache probe forced a bypass (D-10). */
  coldCacheBypass?: boolean;
  /** Schema version of the active pipeline at dispatch time (D-06). v3-only post-Phase-29. */
  schemaVersion?: 'v3';
}

/**
 * Kick off a new LLM extraction run if the cooldown / cold-cache / busy /
 * configured / raw-events guards permit. The actual work runs as a
 * fire-and-forget IIFE; this function returns synchronously after the
 * dispatch decision is made.
 */
export async function runRefreshExtraction(opts: RunRefreshOpts): Promise<RunRefreshResult> {
  // Phase 32 Plan 32-03 Task 3 — wall-clock start captured at function
  // entry. The post-extraction probe sweep computes its deadline as
  // `cronStart + 800_000 - SWEEP_SAFETY_MARGIN_MS` so we stay inside
  // Vercel Pro's 800s `maxDuration` with a 60s safety margin reserved
  // for the prune + audit-log writes (Pitfall 1 / RESEARCH A6). One
  // truth source across handler boundary — the SWEEP_SAFETY_MARGIN_MS
  // constant is exported from urlLiveness.ts (Plan 32-02).
  const cronStart = Date.now();

  // 1. Active pipeline is v3-only post-Phase-29 — no version dispatch needed.

  // 2. D-10 cold-cache probe — BEFORE the cooldown check. If the active LLM
  //    cache is empty (no entry OR zero events), bypass the cooldown so the
  //    first invocation after a fresh deploy always populates the cache.
  let isColdCache = false;
  try {
    const cachedLLM = await cacheGetSafe<ConflictEventEntity[]>(LLM_EVENTS_KEY_ACTIVE, 999_999_999);
    isColdCache = !cachedLLM?.data || cachedLLM.data.length === 0;
  } catch {
    // Treat Redis hiccup as NOT cold — preserve cooldown so we don't
    // hammer the LLM provider when Redis is flapping.
    isColdCache = false;
  }
  const effectiveForceCooldown = opts.forceCooldown === true || isColdCache;

  // 3. Cooldown check (mirrors the prior `shouldRunLLM` helper inline).
  if (!effectiveForceCooldown) {
    try {
      const lastTs = await redis.get<number>(LLM_PROCESS_KEY);
      if (lastTs !== null && lastTs !== undefined) {
        if (Date.now() - lastTs <= LLM_COOLDOWN_MS) {
          return { dispatched: false, reason: 'cooldown', schemaVersion: 'v3' };
        }
      }
    } catch {
      // Redis hiccup → treat as cooldown elapsed (matches existing
      // shouldRunLLM resilience behavior — better to attempt and fail than
      // silently skip).
    }
  }

  // 4. LLM-configured guard.
  if (!isLLMConfigured()) {
    return { dispatched: false, reason: 'llm_unconfigured', schemaVersion: 'v3' };
  }

  // 5. Read raw GDELT — the v3 extractor needs the raw rows to group. The cron
  //    has no incoming client to keep `events:gdelt` warm, so when the key is
  //    missing or stale, refresh it here. (Before 2026-09 this was a cache-only
  //    read: with no dashboard tab open inside the key's 150-min hard TTL every
  //    run exited `no_raw_events` and `events:llm:v3` stayed cold indefinitely.)
  let rawCached: { data: ConflictEventEntity[]; stale?: boolean } | null = null;
  try {
    rawCached = await cacheGetSafe<ConflictEventEntity[]>(EVENTS_KEY, EVENTS_LOGICAL_TTL_MS);
  } catch {
    rawCached = null;
  }
  let merged: ConflictEventEntity[] = rawCached?.data ?? [];
  if (merged.length === 0 || rawCached?.stale) {
    try {
      merged = await refreshRawEvents({ cached: rawCached, skipBackfill: true });
      log.info({ count: merged.length }, 'cron: refreshed raw GDELT cache before extraction');
    } catch (err) {
      // GDELT down → fall back to whatever (stale) raw rows we already had.
      log.warn({ err }, 'cron: raw GDELT refresh failed; using cached rows if any');
    }
  }
  if (merged.length === 0) {
    return { dispatched: false, reason: 'no_raw_events', schemaVersion: 'v3' };
  }

  // 6. Pipeline-busy guard — preserves single-flight semantics so we never
  //    stack two parallel extractor runs (anti-pattern #18).
  if (
    llmProgress.stage !== 'idle' &&
    llmProgress.stage !== 'done' &&
    llmProgress.stage !== 'error'
  ) {
    return { dispatched: false, reason: 'pipeline_busy', schemaVersion: 'v3' };
  }

  // 7. Stamp the cooldown timestamp BEFORE spawning so concurrent dispatches
  //    short-circuit on the cooldown (best-effort on Redis errors).
  try {
    await redis.set(LLM_PROCESS_KEY, Date.now(), { ex: LLM_REDIS_TTL_SEC });
  } catch {
    /* best-effort */
  }

  // 8. D-06 — stamp triggerBy on the live progress singleton so DevApiStatus
  //    can differentiate cron-fired runs from manual-fired runs.
  updateProgress({ lastTriggerSource: opts.triggeredBy });

  // 9. Spawn the fire-and-forget body — verbatim port of the prior block at
  //    server/routes/events.ts:1063-1306, adapted to use the local KEYs and
  //    the helper's `merged` raw GDELT input.
  const llmCachedRef = await cacheGetSafe<ConflictEventEntity[]>(
    LLM_EVENTS_KEY_ACTIVE,
    LLM_COOLDOWN_MS,
  );

  // Phase 28.2.6 Plan 02 (D-09 / D-10 / D-12) — wrap the fire-and-forget
  // body in safeWaitUntil so the function instance survives past res.end()
  // on Vercel Fluid Compute. NEVER await this call — D-12 hard block;
  // safeWaitUntil's `void` return type makes `await` a TypeScript error.
  safeWaitUntil(
    (async () => {
      resetProgress(); // sets stage='grouping', startedAt=now

      // Phase 39 OBS-FLIGHT-02 / -05 (GA-2) — generate the per-run id and stamp
      // it on the singleton so every callHistory writer in freeClaudeRouter.ts
      // inherits it onto each appended entry (call→run back-correlation).
      // crypto.randomUUID is global in the pinned Node ≥20 runtime.
      const runId = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      // Stamp schemaVersion + lastTriggerSource + runId onto the freshly-reset
      // progress singleton (resetProgress() wipes optional fields).
      updateProgress({ schemaVersion: 'v3', lastTriggerSource: opts.triggeredBy, runId });

      // GA-2 start-write: open the run record with outcome:'running' so a run
      // killed by Vercel's maxDuration leaves a never-closed 'running' row — the
      // "what happened to last night's 3am run that died?" signal (Pitfall 5).
      // Degrade-open (openRunRecord try/caught internally; never throws).
      await openRunRecord({ runId, startedAt });

      // Phase 39 SC39-3 (WR-01) — DLQ size snapshot at run OPEN. dlqDelta in the
      // closed run record is computed as max(0, close - open) so the FlightRecorder
      // can surface how many groups this run pushed to the dead-letter queue
      // (the prior hardcoded `dlqDelta: 0` made the 'partial' band dead code).
      //
      // CAVEAT (bounded-set): `events:llm-dlq` is a 200-entry / 7d-TTL bounded
      // set (server/lib/llmDLQ.ts). When the set is at its cap, new enqueues
      // LRU-evict the oldest, so SCARD(close) - SCARD(open) UNDERCOUNTS the true
      // run delta in a saturated DLQ. The max(0, …) floor also masks a delta
      // that goes negative because TTL expiry or eviction outpaced this run's
      // enqueues. This is an honest lower bound on DLQ growth, not an exact
      // per-run enqueue count — acceptable for the operator decision-support
      // signal (a non-zero delta truthfully indicates failures occurred).
      const dlqSizeAtOpen = await countDLQ();

      // Mutable outcome witness — each terminal branch sets this, and the single
      // close in the `finally` block re-LPUSHes the terminal record (Open Q3:
      // prefer a finally close so a missed branch still closes the run). Defaults
      // to 'error' so an unexpected throw past every branch still closes honestly.
      let runOutcome: RunHistoryEntry['outcome'] = 'error';

      // Snapshot the current llmProgress into a terminal RunHistoryEntry. v3/NIM
      // single-provider per D-04.
      //
      // Phase 39 SC39-3 (WR-01) — honest failure accounting:
      //   - `batchesFailed` comes from the v3 extractor's per-run failure tally
      //     (llmProgress.failedBatches), which counts ONLY genuine-failure
      //     terminal branches. The prior `totalBatches - completedBatches`
      //     derivation was structurally ~0 because finishBatch() ticks
      //     completedBatches on EVERY terminal branch (success AND failure).
      //   - `batchesCompleted` is now the true SUCCESS count (total - failed) so
      //     the FlightRecorder's `{done}/{total} groups` reads honestly and the
      //     'partial'/'failed' outcome bands can fire.
      //   - `dlqDelta` is the real DLQ growth across the run (close - open,
      //     floored at 0) — see the bounded-set caveat at the open snapshot.
      const buildRunHistoryEntry = async (
        outcome: RunHistoryEntry['outcome'],
      ): Promise<RunHistoryEntry> => {
        const totalBatches = llmProgress.totalBatches ?? 0;
        const failedBatches = Math.min(totalBatches, llmProgress.failedBatches ?? 0);
        const succeededBatches = Math.max(0, totalBatches - failedBatches);
        const cost = llmProgress.costShadow;
        let dlqDelta = 0;
        try {
          const dlqSizeAtClose = await countDLQ();
          dlqDelta = Math.max(0, dlqSizeAtClose - dlqSizeAtOpen);
        } catch {
          // Degrade-open — a Redis hiccup on the close snapshot yields an honest
          // 0 delta rather than failing the run-record close.
          dlqDelta = 0;
        }
        return {
          runId,
          startedAt,
          completedAt: new Date().toISOString(),
          outcome,
          batchCount: totalBatches,
          batchesCompleted: succeededBatches,
          batchesFailed: failedBatches,
          tokenSpend: { nvidia_nim: cost ? cost.tokensIn + cost.tokensOut : 0 },
          evalScore: llmProgress.evalScore,
          dlqDelta,
          watchdogTimeouts: llmProgress.watchdogTimeoutCount ?? 0,
          durationMs: Date.now() - (llmProgress.startedAt ?? Date.now()),
          pipelineVersion: 'v3',
        };
      };

      try {
        // GDELT-MATCH-02 — high-confidence dedup pre-pass runs BEFORE the
        // coarse 50km batch-grouping/enrichment. `dedupHighConfidence` is a
        // PURE read-and-filter: it returns a new array and never mutates
        // `merged` or the raw `events:gdelt` cache (D-07 non-destructive).
        // Collapsing exact-duplicate mentions here means fewer redundant groups
        // reach the LLM (saving tokens) without over-merging distinct events.
        const deduped = dedupHighConfidence(merged);
        const groups = groupGdeltRows(deduped);
        updateProgress({ totalGroups: groups.length, stage: 'grouping' });

        // Diff: only process groups whose key isn't already in the LLM cache.
        const cachedLlmKeys = new Set<string>();
        if (llmCachedRef?.data) {
          for (const e of llmCachedRef.data) {
            if (e.id) cachedLlmKeys.add(e.id);
          }
        }
        const newGroups =
          cachedLlmKeys.size > 0
            ? groups.filter((g) => !cachedLlmKeys.has(enrichedIdForGroup(g.key)))
            : groups;

        updateProgress({ newGroups: newGroups.length });

        if (newGroups.length === 0) {
          log.info('LLM: no new groups to process');
          runOutcome = 'completed'; // GA-2 branch 1: no new groups → completed
          updateProgress({
            stage: 'done',
            completedAt: Date.now(),
            durationMs: Date.now() - (llmProgress.startedAt ?? Date.now()),
          });
          try {
            await cacheSetSafe(LLM_SUMMARY_KEY_ACTIVE, buildSummary(), LLM_SUMMARY_TTL_SEC);
          } catch {
            /* best-effort */
          }
          return;
        }

        // D-33 soft-cap gate. When either provider is ≥80% of daily budget,
        // skip new extractions this cycle and keep serving cached LLM entities.
        const paused = await shouldPauseNewEvents();
        if (paused) {
          log.info('LLM_PAUSED_SOFT_CAP');
          runOutcome = 'budget_hit'; // GA-2 branch 2: soft-cap pause → budget_hit
          updateProgress({
            stage: 'done',
            completedAt: Date.now(),
            durationMs: Date.now() - (llmProgress.startedAt ?? Date.now()),
          });
          try {
            await cacheSetSafe(LLM_SUMMARY_KEY_ACTIVE, buildSummary(), LLM_SUMMARY_TTL_SEC);
          } catch {
            /* best-effort */
          }
          return;
        }

        // D-35: prioritize highest-severity groups first so the BATCH_SIZE slice
        // consumed on each cycle contains the highest-impact events.
        const prioritizedGroups = await prioritizeBySeverity(newGroups);

        // The run works in waves — extract, geocode, persist — instead of one
        // pass with a single write at the end. A cold corpus (~1,100 groups)
        // does not fit in the 800 s function limit; with a terminal-only write
        // a killed run persisted nothing and the next night started cold
        // again. Now every wave lands in `events:llm:v3`, the next run's diff
        // skips what is already there, and the corpus fills over a few runs,
        // highest severity first.
        //
        // Geocoding is sequential (Nominatim, 1 req/s) and is the slow half, so
        // wave N+1's LLM calls overlap wave N's geocoding. At most one wave may
        // be waiting for the geocoder: LLM output that is never geocoded is
        // wasted quota.
        const waveSize = Math.max(
          BATCH_SIZE_ACTIVE,
          env.LLM_V3_CONCURRENCY * BATCH_SIZE_ACTIVE * 2,
        );
        const llmDeadlineMs = cronStart + LLM_PHASE_BUDGET_MS;
        const geocodeDeadlineMs = cronStart + GEOCODE_PHASE_BUDGET_MS;
        const totalBatchesAll = Math.ceil(prioritizedGroups.length / BATCH_SIZE_ACTIVE);
        updateProgress({ stage: 'llm-processing', totalBatches: totalBatchesAll });

        let cacheRef: { data: ConflictEventEntity[] } | null = llmCachedRef;
        let batchesDone = 0;
        let enrichedTotal = 0;
        let geocodedTotal = 0;
        let persistedTotal = 0;
        let writeError: string | null = null;
        let extractError: string | null = null;
        let fatalStatus: number | undefined;
        const provenanceCounts: Partial<Record<GeocodeProvenance, number>> = {};
        let suspectCount = 0;

        // GDELT-MATCH-03/04 — OSINT clusters (`news:feed`) for the strict
        // three-gate corroboration boost. Best-effort: a missing read yields a
        // tier+precision composite with zero corroboration — it never blocks
        // the write and never mutates the raw corpus (D-07).
        let newsClusters: NewsCluster[] | undefined;
        try {
          const newsCache = await cacheGetSafe<NewsCluster[]>('news:feed', 0);
          if (newsCache?.data) newsClusters = newsCache.data;
        } catch {
          /* best-effort — corroboration boost defaults to 0 */
        }

        const geocodeAndPersist = async (
          wave: EventGroup[],
          extract: Awaited<ReturnType<typeof processEventGroupsV3>>,
        ): Promise<void> => {
          const events = extract.events ?? [];
          if (events.length === 0) return;
          const groupsByKey = new Map(wave.map((g) => [g.key, g] as const));
          const geocoded = await geocodeEnrichedEventsV3(
            events,
            groupsByKey,
            extract.matchedNewsByGroup,
            extract.bellingcatByGroup,
            (completed) => {
              updateProgress({ completedGeocodes: geocodedTotal + completed });
            },
            { deadlineMs: geocodeDeadlineMs },
          );
          geocodedTotal += geocoded.length;
          for (const e of geocoded) {
            provenanceCounts[e.geocodeProvenance] =
              (provenanceCounts[e.geocodeProvenance] ?? 0) + 1;
            if (e.suspect) suspectCount++;
          }
          updateProgress({ provenanceCounts, suspectCount, completedGeocodes: geocodedTotal });
          if (geocoded.length === 0) return;

          const entities = enrichedV3ToEntities(geocoded, wave, newsClusters);
          const written = await mergeAndPersistLlmEntities(
            entities,
            cacheRef,
            LLM_EVENTS_KEY_ACTIVE,
          );
          cacheRef = { data: written.merged };
          if (written.ok) persistedTotal += written.writtenCount;
          else writeError = written.error;
        };

        // The geocode task is only awaited after the next wave's LLM phase, so
        // it must never reject in the meantime (that would be an unhandled
        // rejection). A wave that fails here is simply not persisted.
        const geocodeAndPersistSafe = async (
          wave: EventGroup[],
          extract: Awaited<ReturnType<typeof processEventGroupsV3>>,
        ): Promise<void> => {
          try {
            await geocodeAndPersist(wave, extract);
          } catch (err) {
            writeError = err instanceof Error ? err.message : String(err);
            log.error({ err: writeError }, 'LLM: geocode/persist failed for a wave');
          }
        };

        let geocodeChain: Promise<void> = Promise.resolve();
        for (let i = 0; i < prioritizedGroups.length; i += waveSize) {
          if (Date.now() >= llmDeadlineMs) {
            log.info(
              { processedGroups: i, totalGroups: prioritizedGroups.length },
              'LLM: phase budget spent — remaining groups are left for the next run',
            );
            break;
          }
          const wave = prioritizedGroups.slice(i, i + waveSize);
          const doneBefore = batchesDone;
          let extract: Awaited<ReturnType<typeof processEventGroupsV3>>;
          try {
            extract = await processEventGroupsV3(wave, (completed) => {
              updateProgress({
                completedBatches: doneBefore + completed,
                totalBatches: totalBatchesAll,
              });
            });
          } catch (waveErr) {
            // Stop here, but fall through to the drain below: the previous
            // wave may still be geocoding, and its write must land before the
            // run record closes and the function is frozen.
            extractError = waveErr instanceof Error ? waveErr.message : String(waveErr);
            log.error(
              { err: extractError, wave: i / waveSize },
              'LLM: a wave threw — ending the run',
            );
            break;
          }
          batchesDone += Math.ceil(wave.length / BATCH_SIZE_ACTIVE);
          enrichedTotal += extract.events?.length ?? 0;
          updateProgress({ enrichedCount: enrichedTotal, totalGeocodes: enrichedTotal });

          // Let the previous wave finish geocoding before queueing this one.
          await geocodeChain;
          geocodeChain = geocodeAndPersistSafe(wave, extract);

          if (extract.fatalStatus !== undefined) {
            fatalStatus = extract.fatalStatus;
            break;
          }
        }
        updateProgress({ stage: 'geocoding' });
        await geocodeChain;

        if (fatalStatus !== undefined || persistedTotal === 0) {
          const errorMessage =
            fatalStatus !== undefined
              ? `LLM provider answered HTTP ${fatalStatus} — ${describeFatalStatus(fatalStatus)}`
              : (writeError ?? extractError ?? 'LLM returned null for all batches');
          log.warn(
            { fatalStatus, writeError, enrichedTotal, persistedTotal },
            'LLM run produced nothing new — raw GDELT serving continues',
          );
          runOutcome = 'error'; // GA-2 branch 3: nothing persisted → error
          updateProgress({
            stage: 'error',
            errorMessage,
            completedAt: Date.now(),
            durationMs: Date.now() - (llmProgress.startedAt ?? Date.now()),
          });
          try {
            await cacheSetSafe(LLM_SUMMARY_KEY_ACTIVE, buildSummary(), LLM_SUMMARY_TTL_SEC);
          } catch {
            /* best-effort */
          }
          return;
        }

        // The eval harness runs after the data is safe, and only when there is
        // time left: it is a measurement, and it used to stand between a
        // finished extraction and its one and only write. `runEval()` stamps
        // `evalScore` on the progress singleton itself; re-stamping here keeps
        // the run record independent of that side effect.
        if (Date.now() < cronStart + EVAL_START_BUDGET_MS) {
          try {
            const evalScore = await runEval();
            updateProgress({ evalScore });
            log.info({ evalScore, schemaVersion: 'v3' }, 'eval harness completed');
          } catch (evalErr) {
            log.warn({ err: evalErr }, 'eval harness threw; continuing pipeline');
          }
        }

        runOutcome = 'completed'; // GA-2 branch 4: something was persisted → completed
        // A run can persist most of its waves and still lose one (a failed
        // write, a wave that threw). It is `completed`, and it says what it lost.
        const partialFailure = writeError ?? extractError;
        if (partialFailure) {
          log.warn({ partialFailure, persistedTotal }, 'LLM run completed with a lost wave');
        }
        updateProgress({
          stage: 'done',
          ...(partialFailure ? { errorMessage: `partial: ${partialFailure}` } : {}),
          completedAt: Date.now(),
          durationMs: Date.now() - (llmProgress.startedAt ?? Date.now()),
        });
        try {
          await cacheSetSafe(LLM_SUMMARY_KEY_ACTIVE, buildSummary(), LLM_SUMMARY_TTL_SEC);
        } catch {
          /* best-effort */
        }
      } catch (llmErr) {
        runOutcome = 'error'; // GA-2 branch 5: thrown error → error
        updateProgress({
          stage: 'error',
          errorMessage: llmErr instanceof Error ? llmErr.message : 'Unknown LLM error',
          completedAt: Date.now(),
          durationMs: Date.now() - (llmProgress.startedAt ?? Date.now()),
        });
        try {
          await cacheSetSafe(LLM_SUMMARY_KEY_ACTIVE, buildSummary(), LLM_SUMMARY_TTL_SEC);
        } catch {
          /* best-effort */
        }
        log.warn({ err: llmErr }, 'LLM background processing failed');
      } finally {
        // Phase 39 OBS-FLIGHT-02 (GA-2 / Open Q3) — close the run record exactly
        // once here, keyed off the `runOutcome` witness each terminal branch set.
        // A finally close guarantees a missed branch still closes the run (the
        // default 'error' outcome is the honest fallback). closeRunRecord
        // re-LPUSHes the terminal record over the earlier 'running' one; the
        // reader dedupes by runId head-first. Degrade-open (never throws).
        await closeRunRecord(await buildRunHistoryEntry(runOutcome));

        // Phase 32 Plan 32-03 Task 3 — cron post-step. Runs AFTER the
        // existing extraction work resolves (success OR error path) so
        // probe+prune cleanup happens regardless of whether LLM
        // extraction itself dispatched fresh enrichments this tick.
        //
        // Deadline budget plumbing (Pitfall 1 / RESEARCH A6):
        //   deadlineMs = cronStart + 800_000 - SWEEP_SAFETY_MARGIN_MS
        // — passed into runProbeSweep so each task short-circuits past
        // the cutoff. After the sweep returns, the auto-prune ONLY fires
        // if `Date.now() < deadlineMs` so we don't kick off the splice
        // mid-`cacheSet` and get killed by Vercel's maxDuration.
        //
        // Direct helper invocation (NOT self-HTTP) per RESEARCH A4 /
        // Discretion §3 — the prune helper writes the audit-log entry
        // with `bearerFingerprint:'cron:refresh-events'` (RESEARCH A8)
        // so the source remains unambiguous.
        //
        // Wrapped in its own try/catch — probe/prune failures must NOT
        // break the extraction outcome. log.error surfaces the failure
        // via the standard pino observability path.
        try {
          const deadlineMs = cronStart + 800_000 - SWEEP_SAFETY_MARGIN_MS;
          const { candidates, classifiedNoUrl } = await buildProbeCandidates();
          const sweep = await runProbeSweep({
            eventIdsWithUrls: candidates,
            deadlineMs,
          });
          log.info(
            {
              probed: sweep.probed,
              skippedBudget: sweep.skippedBudget,
              // Phase 43 GHOST-07 (D-09) — full coverage accounting: how many
              // events were classified `no-url` (source-less, no fetch issued).
              classifiedNoUrl,
            },
            'phase 32 probe sweep complete',
          );
          if (Date.now() < deadlineMs) {
            const pruneResult = await pruneDeadUrlEvents({ trigger: 'cron' });
            log.info(
              { prunedCount: pruneResult.prunedCount, prunedIds: pruneResult.prunedIds },
              'phase 32 cron auto-prune complete',
            );
          } else {
            log.warn(
              { deadlineMs, now: Date.now() },
              'phase 32 deadline elapsed; skipping cron auto-prune for this tick',
            );
          }
        } catch (probePruneErr) {
          log.error({ err: probePruneErr }, 'phase 32 probe/prune post-step failed');
        }
      }
    })(),
  );

  return {
    dispatched: true,
    coldCacheBypass: isColdCache,
    schemaVersion: 'v3',
  };
}

// ---------------------------------------------------------------------------
// Entity adapters — moved verbatim from server/routes/events.ts so the helper
// is fully self-contained. The v1 + v2 adapters were deleted in Phase 29 D-02
// part C alongside the v1+v2 extractor modules; only enrichedV3ToEntities
// remains as the active adapter.
// ---------------------------------------------------------------------------

/**
 * Convert v3 LLM-geocoded enriched events into ConflictEventEntity format.
 * Stamps the entity id with `llm-v3-` so the dev drill-down can recover the
 * stable groupKey via prefix strip.
 */
export function enrichedV3ToEntities(
  geocoded: GeocodedEnrichedEventV3[],
  groups: Array<{ key: string; entities: ConflictEventEntity[]; sourceUrls: string[] }>,
  // GDELT-MATCH-03/04 — optional OSINT clusters (`news:feed`) for the strict
  // three-gate corroboration boost folded into compositeScore. Omitted callers
  // (legacy / tests) get a tier+precision composite with zero corroboration.
  newsClusters?: NewsCluster[],
): ConflictEventEntity[] {
  const groupMap = new Map<string, ConflictEventEntity[]>();
  const groupSourceUrls = new Map<string, string[]>();
  for (const g of groups) {
    groupMap.set(g.key, g.entities);
    groupSourceUrls.set(g.key, g.sourceUrls);
  }

  const results: ConflictEventEntity[] = [];
  for (const enriched of geocoded) {
    const entities = groupMap.get(enriched.groupKey);
    if (!entities || entities.length === 0) continue;

    const sourceUrls = groupSourceUrls.get(enriched.groupKey) ?? [];
    const sourceTier = getHighestTier(sourceUrls) ?? undefined;

    const template = entities[0];
    if (!template) continue;

    const placeLabel =
      enriched.location.landmark ||
      enriched.location.city ||
      enriched.location.admin1 ||
      enriched.location.country ||
      enriched.displayName ||
      'unknown';

    // GDELT-MATCH-04 — additive composite ranking signal. tier × corroboration
    // × specificity. Corroboration boost is the strict three-gate result against
    // the OSINT clusters (when provided). This is a NEW field on the enriched
    // output entity; the raw GDELT corpus is untouched (D-07).
    const candidate: ConflictEventEntity = {
      ...template,
      lat: enriched.resolvedLat,
      lng: enriched.resolvedLng,
      timestamp: template.timestamp,
      data: { ...template.data, locationName: placeLabel, actors: enriched.actors },
    };
    const corroboration = newsClusters ? checkCorroboration(candidate, newsClusters) : { boost: 0 };
    const compositeScore = computeCompositeScore({
      tier: sourceTier ?? null,
      corroborationBoost: corroboration.boost,
      precision: enriched.precision,
    });

    results.push({
      ...template,
      id: enrichedIdForGroup(enriched.groupKey),
      lat: enriched.resolvedLat,
      lng: enriched.resolvedLng,
      type: enriched.type,
      label: `${placeLabel}: ${enriched.summary.slice(0, 60)}`,
      data: {
        ...template.data,
        locationName: placeLabel,
        summary: enriched.summary,
        precision: enriched.precision,
        llmProcessed: true,
        actors: enriched.actors,
        sourceCount: enriched.sourceCount,
        sourceTier,
        compositeScore,
        casualties: {
          killed: enriched.casualties.killed ?? undefined,
          injured: enriched.casualties.injured ?? undefined,
          unknown: enriched.casualties.unknown,
        },
        severity: enriched.severity,
        suspect: enriched.suspect,
        geocodeProvenance: enriched.geocodeProvenance,
        weaponType: enriched.weaponType,
        targetType: enriched.targetType,
        timeOfDay: enriched.timeOfDay,
        durationMinutes: enriched.durationMinutes,
        reasoning: enriched.reasoning,
        geocodeDisplayName: enriched.displayName,
      },
    });
  }
  return results;
}

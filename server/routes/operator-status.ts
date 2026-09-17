/**
 * Phase 28.2 W5 Plan 05 Task 7.5 — `/api/operator-status` aggregator.
 *
 * Bearer-gated read-only route that surfaces operator-tier sidecars for the
 * merged DevApiStatus API Health tab's Operator Actions block:
 *
 *   - `operator:audit-log` (SMEMBERS, bounded 500 entries, 30d TTL — written
 *     by `/api/events/llm-replay` handler): rolling 24h count + per-Bearer
 *     fingerprint breakdown
 *   - `events:llm-eval-adversarial:v3` (90d TTL — written by Plan 03's
 *     `runAdversarialEval()`): prompt-injection robustness summary
 *
 * Phase 29 D-02 part A — the pipeline override countdown + version block
 * is removed because the override write surface is gone. The response no
 * longer contains a pin-version field; DevApiStatus's render block is
 * removed in the same plan.
 *
 * The route NEVER writes. It aggregates Redis sidecars in one Bearer-gated
 * fetch so the UI can replace separate poll cycles with one. Per threat
 * T-28.2-05-02 + T-28.2-05-09 the route is Bearer-gated; per Pitfall 6
 * dual-gate the read-only contract MUST stay absolute.
 */
import { Router, type Request, type Response } from 'express';

import { cacheGetSafe, redis } from '../cache/redis.js';
import { classifyEventActors } from '../lib/actorClassifier.js';
import { LLM_EVENTS_KEY_ACTIVE } from '../lib/llmExtractionPipeline.js';
import {
  budgetState,
  DAILY_LIMITS,
  getDailyTokens,
  HARD_CAP_RATIO,
  SOFT_CAP_RATIO,
} from '../lib/llmTokenBudget.js';
import { logger } from '../lib/logger.js';
import { readTrendHistory, type TrendSample } from '../lib/trendHistory.js';
import {
  isTerminalDead,
  URL_LIVENESS_COUNT_KEY,
  URL_LIVENESS_KEY_PREFIX,
  type UrlLiveness,
} from '../lib/urlLiveness.js';
import { dashboardAuth } from '../middleware/dashboardAuth.js';
import { RATE_LIMITER_CONFIG } from '../middleware/rateLimit.js';

import type { ConflictEventEntity } from '../types.js';

const log = logger.child({ module: 'operator-status' });

export const operatorStatusRouter = Router();

// ============================================================================
// Phase 32 Plan 04 — `prune` block constants + drill-down helper
// ============================================================================

/**
 * Cap on the number of terminal-dead entries returned in `prune.deadUrlSample`.
 * Bounds the dashboard payload size. Plan 32-05's `<ul data-testid="dead-url-list">`
 * renders this slice with a "...and N more" truncation row when
 * `prune.deadUrlCount > LIMIT_DRILL_DOWN`.
 *
 * Phase 44 WR-01 — this cap bounds ONLY the sample array; it is NOT a SCAN
 * short-circuit. The `countsByStatus` tally keeps accumulating over scanned
 * keys until the MAX_SCAN_KEYS=200 budget guard stops the loop, so the
 * sampled distribution is not dead-biased when ≥20 terminal-dead entries
 * appear early in encounter order.
 */
const LIMIT_DRILL_DOWN = 20;

// ============================================================================
// Phase 33 Plan 06 — actorQuality block (D-16) constants + shape
// ============================================================================

/**
 * INLINE_CAMEO_CODES — hardcoded subset of well-known CAMEO actor codes used by
 * the `/api/operator-status` actorQuality block to detect bucket (b) raw-CAMEO
 * actor strings.
 *
 * PATTERNS critical risk #3 — the full codebook lives at
 * `src/__tests__/fixtures/cameo-codes.json`
 * (Plan 33-02). That file is NOT bundled into the Vercel server build artifact,
 * so the route cannot read it at runtime. This subset covers the country-
 * military + class codes most likely to surface as raw CAMEO actors in
 * `events:llm:v3` for the Iran-conflict region.
 *
 * Drift between this subset and the canonical committed codebook is acceptable
 * per D-16 (counts here are observability, not enforcement). The audit script
 * (Plan 33-01) remains the canonical full-codebook consumer.
 */
const INLINE_CAMEO_CODES: ReadonlySet<string> = new Set([
  // Country-military (3-letter country prefix + MIL)
  'ISRMIL',
  'IRNMIL',
  'USAMIL',
  'USMIL',
  'RUSMIL',
  'SAUMIL',
  'TURMIL',
  'SYRMIL',
  'LBNMIL',
  'EGYMIL',
  'JORMIL',
  'IRQMIL',
  // Country (generic, FIPS / ISO-ish 3-letter)
  'ISR',
  'IRN',
  'USA',
  'RUS',
  'SAU',
  'TUR',
  'SYR',
  'LBN',
  'PSE',
  'YEM',
  'IRQ',
  // Class / role codes (3-letter generic)
  'REB',
  'INS',
  'MIL',
  'GOV',
  'COP',
  'OPP',
]);

/**
 * Bucket / sample shape returned to dashboard consumers (Plan 33-07).
 * D-16 contract verbatim — drift here breaks the dashboard render contract.
 */
interface ActorQualityBlock {
  totalEvents: number;
  nullActors: number;
  rawCameoActors: number;
  ambiguousActors: number;
  lowConfidenceActors: number;
  sample: Array<{
    eventId: string;
    actors: string[];
    actorConfidence: ('high' | 'medium' | 'low')[];
    issue: 'null' | 'raw-cameo' | 'ambiguous' | 'low-confidence';
  }>;
}

// ============================================================================
// Phase 39 Plan 03 — tokenBudget block (GA-4) shape + interface
// ============================================================================

/**
 * tokenBudget block returned to the BudgetBlock dashboard consumer (Plan 39-05).
 *
 * GA-4 provider-keyed MAP shape (not flat) so a restored provider later adds a
 * `providers` key without breaking the Zod `.strict()` contract pin. Per-provider
 * `used`/`cap`/`soft`/`hard`/`state` mirror the `llmTokenBudget` source of truth;
 * `costShadow` carries today's `events:llm-cost-shadow:v3:{date}` roll-up with USD
 * derived from the integer-microcents accumulator (÷1e6).
 *
 * Degrade-open: any Redis throw inside the block leaves `tokenBudget: null` on a
 * 200 response (mirrors the `actorQuality` precedent — T-39-03-D).
 */
interface TokenBudgetBlock {
  providers: {
    nvidia_nim: {
      used: number;
      cap: number;
      soft: number;
      hard: number;
      state: 'ok' | 'soft' | 'hard';
    };
  };
  costShadow: {
    tokensIn: number;
    tokensOut: number;
    usd: number;
  };
}

// ============================================================================
// Phase 46 HARD-01 (D-01/D-02) — rateLimiter block shape
// ============================================================================

/**
 * `rateLimiter` block returned to the DevApiStatus API Health tab (Plan 46-04).
 *
 * Surfaces per-tier limit config (from `RATE_LIMITER_CONFIG` — the closure
 * config mirror in `rateLimit.ts`) alongside the recent 429 counts read from
 * the `ratelimit:429:{tier}:{YYYY-MM-DD}` sidecars. `recent429` is the sum of
 * today's + yesterday's UTC-dated counters (RESEARCH Open-Q2 rolling window).
 *
 * Degrade-open (mirrors `tokenBudget` VERBATIM — T-39-03-D): any Redis throw
 * inside the block leaves `rateLimiter: null` on a 200 response — never bubbles
 * to the outer 500 handler. Per-tier 429 reads are additionally coerced
 * (`Number(raw) || 0`) so a missing key leaves the tier at 0.
 */
interface RateLimiterBlock {
  tiers: Array<{ tier: string; max: number; windowSec: number; recent429: number }>;
}

/**
 * Pitfall 3 budget guard — hard ceiling on the number of `events:url-liveness:*`
 * keys we'll load values for during a single `/api/operator-status` poll. A
 * runaway key population (e.g. probe sweep wrote many `unknown` entries that
 * never converge to terminal-dead) must not blow the aggregator's wall-clock
 * budget. Once the loop has touched `MAX_SCAN_KEYS` keys, it stops SCANning
 * even if the cursor hasn't returned to 0.
 */
const MAX_SCAN_KEYS = 200;

/**
 * Shape of a single drill-down entry returned in `prune.deadUrlSample`.
 * The status union mirrors `isTerminalDead`'s acceptance set — Plan 32-05's
 * UI can render the badge color (red 404, amber 403, gray dead-host) directly
 * off this field.
 */
type DeadUrlSampleEntry = {
  eventId: string;
  // Phase 43 D-07 — nullable in lockstep with `UrlLiveness.lastUrlProbed`
  // (CR-01). `lastUrlProbed` became `string | null` so a `no-url` entry can
  // record `null`; the sample assigns it directly to `url`. In practice
  // `no-url` is NOT terminal-dead so it never reaches this sample (every
  // entry here carries a real URL), but the type must admit `null` for the
  // assignment to typecheck honestly rather than masking the widening.
  url: string | null;
  // Phase 43 D-19 — `soft-404` joins the terminal-dead status union the
  // sample exposes (it is terminal-dead per isTerminalDead). `no-url` is
  // deliberately NOT here — it is not terminal-dead and never reaches this
  // sample. Phase 44 renders the badge color off this field.
  status: 'dead-host' | '403' | '404' | 'soft-404';
  // Phase 43 D-19 — operator-facing diagnostic string carried from the
  // stored UrlLiveness entry (e.g. the matched soft-404 marker). `null` for
  // status-only verdicts and for pre-Phase-43 entries lacking the field.
  // Phase 44 must render this as TEXT, not HTML (T-43-16 carried forward).
  evidence: string | null;
  // Phase 44 D-01 — both already present on the stored `UrlLiveness` value
  // (no extra Redis read). `lastProbedAt` is the ISO8601 last-probe timestamp;
  // `attemptCount` is the dead-streak depth (D-02 honest transition proxy —
  // "dead on N consecutive sweeps" under the once-daily cron cadence).
  lastProbedAt: string;
  attemptCount: number;
};

/**
 * SCAN over `events:url-liveness:*`, filter to terminal-dead entries, return
 * up to `LIMIT_DRILL_DOWN` matches in encounter order.
 *
 * Why a helper (not inline): the SCAN cursor loop with the MAX_SCAN_KEYS
 * short-circuit (the SOLE loop short-circuit — Phase 44 WR-01) + the
 * LIMIT_DRILL_DOWN sample cap + per-key `cacheGetSafe` value load
 * is non-trivial; extracting it keeps the main route body readable and
 * isolates the degrade-open `try/catch` so a SCAN throw can't cascade past
 * the `prune` block.
 *
 * MEDIUM-01 plan-checker pin (also resolved by Plan 32-03's `pruneDeadUrlEvents`
 * SCAN call): `redis.scan(cursor, opts)` on `@upstash/redis ^1.37.0` returns
 * `Promise<[string | number, string[]]>` — cursor type is string OR number
 * depending on Upstash response shape. The explicit `as` cast pins the
 * signature so silent drift fails TypeScript instead of producing an
 * infinite SCAN loop.
 *
 * Degrade-open contract (mirrors `advEval` block + Plan 32-02 sidecar
 * INCR/DECR pattern): any Redis throw inside this helper logs a warning
 * and returns `[]`. The route handler treats `[]` as "no drill-down
 * available this poll" — the dashboard renders the count (still readable
 * from the sidecar) and the deadUrlSample row is empty until the next
 * poll succeeds.
 */
async function buildDeadUrlSample(): Promise<{
  sample: DeadUrlSampleEntry[];
  countsByStatus: Record<string, number>;
}> {
  try {
    const sample: DeadUrlSampleEntry[] = [];
    // Phase 44 D-01/D-03 — sparse per-status tally accumulated inside this
    // EXISTING SCAN loop (zero extra Redis reads). Bounded by the unchanged
    // MAX_SCAN_KEYS=200 budget guard, so this is a SAMPLED tally — NOT the
    // authoritative terminal-dead total (that stays the O(1) `deadUrlCount`
    // sidecar). Absent statuses are omitted (sparse map); the consumer
    // `?? 0`-guards per status.
    const countsByStatus: Record<string, number> = {};
    let cursor: string | number = 0;
    let scanned = 0;
    do {
      const reply = (await redis.scan(cursor, {
        match: `${URL_LIVENESS_KEY_PREFIX}*`,
        count: 50,
      })) as [string | number, string[]];
      cursor = reply[0];
      const keys = reply[1];
      for (const key of keys) {
        if (scanned >= MAX_SCAN_KEYS) {
          // Budget exhausted — short-circuit the outer SCAN loop too.
          cursor = 0;
          break;
        }
        scanned += 1;
        const cached = await cacheGetSafe<UrlLiveness>(key, 999_999_999);
        const value = cached?.data;
        if (!value) continue;
        // Phase 44 D-01 — tally EVERY scanned status (live/unknown/no-url/
        // 404/403/dead-host/soft-404) BEFORE the terminal-dead filter so the
        // dashboard can show full per-bucket counts, not just dead ones.
        countsByStatus[value.status] = (countsByStatus[value.status] ?? 0) + 1;
        if (!isTerminalDead(value.status)) continue;
        // Phase 44 WR-01 — the LIMIT_DRILL_DOWN cap bounds ONLY the sample
        // array. Once full, the loop keeps SCANning (and tallying) up to the
        // MAX_SCAN_KEYS budget — the sole short-circuit — so countsByStatus
        // honestly reflects ≤200 scanned keys, not the first 20 dead ones.
        if (sample.length >= LIMIT_DRILL_DOWN) continue;
        const eventId = key.startsWith(URL_LIVENESS_KEY_PREFIX)
          ? key.slice(URL_LIVENESS_KEY_PREFIX.length)
          : key;
        sample.push({
          eventId,
          url: value.lastUrlProbed,
          // Terminal-dead union pinned by `isTerminalDead` — cast narrows
          // the broader `UrlLivenessStatus` type to the dashboard subset.
          status: value.status as DeadUrlSampleEntry['status'],
          // Phase 43 D-19 — source evidence off the stored entry. The
          // cacheGetSafe<UrlLiveness> read is a TS-generic cast (no runtime
          // Zod parse here), so pre-Phase-43 entries lacking `evidence`
          // read as `undefined` — coerce to `null`.
          evidence: value.evidence ?? null,
          // Phase 44 D-01 — both already on the stored value (no extra read).
          lastProbedAt: value.lastProbedAt,
          attemptCount: value.attemptCount,
        });
      }
    } while (cursor !== 0 && cursor !== '0');
    return { sample, countsByStatus };
  } catch (err) {
    log.warn({ err }, 'failed to build dead-URL drill-down sample');
    // Phase 44 — degrade-open: empty-but-shaped so a SCAN throw never
    // cascades past the prune block (route stays 200-degraded, never 500).
    return { sample: [], countsByStatus: {} };
  }
}

/**
 * Audit entry shape — matches Plan 03's SADD writer. Kept minimal so the
 * route is forward-compatible with future Plan 03 / Plan 06 audit
 * extensions (extra fields are ignored by the aggregator).
 *
 * Phase 29 WR-03 (legacy retention): the `'pipeline-swap'` operation tag
 * is retained for backward compatibility with the 30-day audit-log TTL.
 * Phase 29 D-02 part A deleted the POST /api/events/llm-pipeline route
 * (the only writer of `pipeline-swap` entries), so no NEW entries with
 * this tag will be written. Existing entries in Redis (under the 30d
 * SADD TTL) still parse correctly, and the per-fingerprint `swaps`
 * counter below will naturally decay to 0 once the last legacy entry
 * expires. The dashboard "swaps" column becomes visual noise after that
 * window — a follow-up may drop the field and tag, but it is harmless
 * in the interim and avoids dropping historical observability mid-TTL.
 */
interface AuditEntry {
  timestamp: number;
  bearerFingerprint: string;
  /**
   * Phase 32 Plan 04 — widened to admit `'prune-dead-urls'` entries
   * written by `pruneDeadUrlEvents()` (Plan 32-03) from BOTH the manual
   * dashboard button (Plan 32-05) AND the cron auto-prune step inside
   * `/api/cron/refresh-events`. Distinguished downstream via
   * `bearerFingerprint` (operator's hash vs the literal
   * `'cron:refresh-events'` per CONTEXT D-11 / RESEARCH A8).
   *
   * The canonical `OperatorAuditEntry.operation` union in
   * `server/lib/operatorAudit.ts` was widened in the same phase (Plan 32-01
   * Task 5); this local copy stays in sync so unknown operation tags in
   * the SADD set don't fail to parse.
   */
  operation: 'pipeline-swap' | 'replay' | 'prune-dead-urls';
}

/**
 * Adversarial eval payload shape — matches Plan 03's `runAdversarialEval`
 * Redis writer. Optional fields tolerate older / partial payloads.
 *
 * Phase 29 WR-02: dropped the spurious `leaked` field from byCategory
 * entries. The writer in llmEvalHarness.ts (`runAdversarialEval`) only
 * tracks `{ total, blocked }` per category — the top-level result carries
 * the aggregate `leaked` count but it is NOT broken out per category. The
 * prior shape was likely copy-pasted from the top-level AdversarialEvalResult
 * and would always render `NaN` after arithmetic on any UI consumer.
 */
interface AdversarialEvalPayload {
  total: number;
  blocked: number;
  leaked: number;
  score?: number;
  byCategory?: Record<string, { total: number; blocked: number }>;
  generatedAt?: string;
}

// Phase 29 D-02 part A — humanizeTtl helper deleted with the override block.

operatorStatusRouter.get(
  '/operator-status',
  dashboardAuth,
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const now = Date.now();

      // Audit log — SMEMBERS returns the full bounded set (≤500 entries).
      // Each entry was SADD'd as a JSON string by Plan 03; parse defensively.
      let auditMembers: string[] = [];
      try {
        auditMembers = ((await redis.smembers('operator:audit-log')) as string[]) ?? [];
      } catch (err) {
        log.warn({ err }, 'failed to read operator:audit-log');
      }
      const entries: AuditEntry[] = auditMembers
        .map((raw) => {
          try {
            return JSON.parse(raw) as AuditEntry;
          } catch {
            return null;
          }
        })
        .filter(
          (e): e is AuditEntry =>
            e !== null &&
            typeof e.timestamp === 'number' &&
            typeof e.bearerFingerprint === 'string',
        );

      const last24h = entries.filter((e) => e.timestamp > now - 86_400_000);
      const audit24h = last24h.length;

      // Phase 32 Plan 04 — byFingerprint map value extended with `prunes`
      // counter so Plan 32-05's dashboard can attribute prune activity to
      // the operator's fingerprint AND to the literal `cron:refresh-events`
      // pseudo-fingerprint (RESEARCH A8). The new counter increments on
      // every `prune-dead-urls` audit entry within the 24h rolling window.
      const byFingerprint = new Map<
        string,
        { actions: number; swaps: number; replays: number; prunes: number }
      >();
      for (const e of last24h) {
        const cur = byFingerprint.get(e.bearerFingerprint) ?? {
          actions: 0,
          swaps: 0,
          replays: 0,
          prunes: 0,
        };
        cur.actions += 1;
        if (e.operation === 'pipeline-swap') cur.swaps += 1;
        if (e.operation === 'replay') cur.replays += 1;
        if (e.operation === 'prune-dead-urls') cur.prunes += 1;
        byFingerprint.set(e.bearerFingerprint, cur);
      }
      const byBearer = Array.from(byFingerprint.entries()).map(([bearerFingerprint, counts]) => ({
        bearerFingerprint,
        ...counts,
      }));

      // Phase 29 D-02 part A — pipeline override TTL block removed.
      // The override key has no writers in the codebase; any extant key
      // naturally TTL-expires within 7 days.

      // Adversarial sub-eval — Plan 03 writes a JSON object to this key
      // every cron run. Tolerate raw-string vs already-parsed shapes
      // (Upstash REST may return either depending on serialization).
      let advEval: AdversarialEvalPayload | null = null;
      try {
        const raw = await redis.get<string | AdversarialEvalPayload>(
          'events:llm-eval-adversarial:v3',
        );
        if (raw && typeof raw === 'string') {
          advEval = JSON.parse(raw) as AdversarialEvalPayload;
        } else if (raw && typeof raw === 'object') {
          advEval = raw;
        }
      } catch (err) {
        log.warn({ err }, 'failed to read events:llm-eval-adversarial:v3');
      }

      // Phase 32 Plan 04 — `prune` sibling block (GHOST-03).
      //
      // Three fields:
      //
      //   - `deadUrlCount`  Sidecar O(1) read of `events:url-liveness-count`.
      //                     Maintained by Plan 32-02's `persistLiveness`
      //                     (INCR on live→dead transitions) and Plan 32-03's
      //                     `pruneDeadUrlEvents` (DECRBY on prune). Defensive
      //                     coercion (`Number(raw) || 0` + `Math.max(0, ...)`)
      //                     handles null absence, string drift, NaN garbage,
      //                     and DECR underflow uniformly (T-32-11 mitigation).
      //   - `last24hPrunes` Derived in-memory from the already-parsed `last24h`
      //                     audit entries — zero additional Redis round-trips.
      //   - `deadUrlSample` Bounded drill-down list (cap 20, MAX_SCAN_KEYS=200
      //                     budget) — LOW-03 plan-checker resolution gives
      //                     Plan 32-05's `<ul data-testid="dead-url-list">`
      //                     the per-event shape it needs without a second
      //                     API call.
      //
      // Degrade-open: sidecar read failure is per-block isolated (mirrors
      // `advEval` pattern); SCAN failure inside `buildDeadUrlSample` returns
      // `[]` so the dashboard still renders the count when the sample fails.
      // The route's outer try/catch around 500 stays a backstop — but the
      // happy-path requirement is that this block NEVER bubbles to the 500
      // handler (Pitfall 6 chaos contract for read-only routes).
      let deadUrlCount = 0;
      try {
        const raw = await redis.get<number | string>(URL_LIVENESS_COUNT_KEY);
        deadUrlCount = Math.max(0, Number(raw) || 0);
      } catch (err) {
        log.warn({ err }, 'failed to read events:url-liveness-count');
      }
      const last24hPrunes = last24h.filter((e) => e.operation === 'prune-dead-urls').length;
      // Phase 44 D-01 — `deadUrlSample` (terminal-dead drill-down, cap 20) and
      // `countsByStatus` (all-status SAMPLED tally, ≤MAX_SCAN_KEYS=200) come
      // from the SAME single SCAN loop. `deadUrlCount` stays the authoritative
      // O(1) sidecar total (D-03) — `countsByStatus` is sampled, never authoritative.
      const { sample: deadUrlSample, countsByStatus } = await buildDeadUrlSample();
      const prune = { deadUrlCount, last24hPrunes, deadUrlSample, countsByStatus };

      // ===== Phase 33 Plan 06 D-16 — actorQuality block =====
      //
      // Lazy compute over the already-deserialized `events:llm:v3` payload.
      // ZERO new Redis sidecars (matches Phase 32 D-13 smallest-blast-radius):
      // one `cacheGetSafe` call, in-memory classification via the shared
      // `classifyEventActors` helper (Pitfall §1 dedup with the audit script),
      // bucket counts + bounded sample[].
      //
      // Degrade-open contract (T-33-05b):
      //   - cacheGetSafe throws (caller-mocked path) → catch, log.warn, leave
      //     `actorQuality = null`. Route stays 200.
      //   - cacheGetSafe returns null (cache miss / Upstash + memCache both
      //     empty) → also leave `actorQuality = null`. The dashboard renders
      //     a "no data" placeholder rather than zeros that would look like a
      //     healthy empty cache.
      //
      // Wall-clock budget: O(N) classification where N ≤ ~300 events — well
      // under the aggregator poll budget per RESEARCH §Wall-clock budget.
      //
      // Sample issue priority order (first match wins per event):
      //   null > raw-cameo > ambiguous > low-confidence
      // The bucket counters increment for EVERY matching issue (an event can
      // simultaneously count in rawCameoActors AND lowConfidenceActors), but
      // the single sample row carries the highest-priority issue tag only.
      let actorQuality: ActorQualityBlock | null = null;
      try {
        const cached = await cacheGetSafe<ConflictEventEntity[]>(
          LLM_EVENTS_KEY_ACTIVE,
          999_999_999,
        );
        if (cached?.data) {
          const entities = cached.data;
          let nullActors = 0;
          let rawCameoActors = 0;
          let ambiguousActors = 0;
          let lowConfidenceActors = 0;
          const sample: ActorQualityBlock['sample'] = [];

          for (const entity of entities) {
            const data = entity.data as {
              actors?: string[];
              actorConfidence?: ('high' | 'medium' | 'low')[];
            };
            const actors = data.actors ?? [];
            const actorConfidence = data.actorConfidence ?? [];
            const issues = classifyEventActors(actors, INLINE_CAMEO_CODES);

            let firstIssue: ActorQualityBlock['sample'][number]['issue'] | null = null;
            if (issues.includes('null')) {
              nullActors += 1;
              firstIssue = 'null';
            }
            if (issues.includes('raw-cameo')) {
              rawCameoActors += 1;
              firstIssue = firstIssue ?? 'raw-cameo';
            }
            if (issues.includes('ambiguous')) {
              ambiguousActors += 1;
              firstIssue = firstIssue ?? 'ambiguous';
            }
            if (actorConfidence.includes('low')) {
              lowConfidenceActors += 1;
              firstIssue = firstIssue ?? 'low-confidence';
            }

            if (firstIssue && sample.length < LIMIT_DRILL_DOWN) {
              sample.push({
                eventId: entity.id,
                actors,
                actorConfidence,
                issue: firstIssue,
              });
            }
          }

          actorQuality = {
            totalEvents: entities.length,
            nullActors,
            rawCameoActors,
            ambiguousActors,
            lowConfidenceActors,
            sample,
          };
        }
        // cached === null OR cached.data missing → actorQuality stays null
        // (D-16 + T-33-05b degrade-open contract).
      } catch (err) {
        log.warn({ err }, 'failed to compute actorQuality block');
        // actorQuality stays null
      }

      // ===== Phase 39 Plan 03 — tokenBudget block (BUDGET-03/04) =====
      //
      // Degrade-open contract (T-39-03-D, mirrors actorQuality VERBATIM):
      // any Redis throw inside this try leaves `tokenBudget = null` on a 200
      // response — never bubbles to the outer 500 handler.
      //
      // GA-4 provider-keyed map shape, pinned by a Zod `.strict()` contract
      // test (Task 2) so any dashboard read drift fails the build.
      let tokenBudget: TokenBudgetBlock | null = null;
      try {
        // Open Q1 decision: read the dormant `llm:tokens:nvidia_nim:{date}`
        // counter. In the v3 path `incrDailyTokens` is retired (Pitfall 2), so
        // this reads 0 today — that is HONEST (NIM free-tier isn't metered into
        // this counter). The live operator signal is `costShadow.usd` below; a
        // restored provider that calls `incrDailyTokens` populates this same
        // counter with zero contract change.
        const used = await getDailyTokens('nvidia_nim');
        const cap = DAILY_LIMITS.nvidia_nim;
        const state = budgetState('nvidia_nim', used);
        const soft = Math.round(cap * SOFT_CAP_RATIO);
        const hard = Math.round(cap * HARD_CAP_RATIO);

        // Cost-shadow daily roll-up — same UTC YYYY-MM-DD key format that
        // `accrueShadowCost` writes (freeClaudeRouter.ts). usd is restored from
        // the integer-microcents accumulator (÷1e6) to undo the float-precision
        // storage trick.
        const todayDate = new Date().toISOString().slice(0, 10);
        const shadow = await redis.hgetall<Record<string, string | number>>(
          `events:llm-cost-shadow:v3:${todayDate}`,
        );
        const tokensIn = Number(shadow?.tokensIn) || 0;
        const tokensOut = Number(shadow?.tokensOut) || 0;
        const usdMicrocents = Number(shadow?.usdMicrocents) || 0;
        const usd = usdMicrocents / 1_000_000;

        tokenBudget = {
          providers: {
            nvidia_nim: { used, cap, soft, hard, state },
          },
          costShadow: { tokensIn, tokensOut, usd },
        };
      } catch (err) {
        log.warn({ err }, 'failed to compute tokenBudget block');
        // tokenBudget stays null (degrade-open — T-39-03-D).
      }

      // ===== Phase 45 DASH-READ-05 — trendHistory block (CONTEXT D-01) =====
      //
      // Reads the bounded `dashboard:trends:history` ring (LPUSH+LTRIM 30-cap,
      // 30d TTL) written once-daily by the EXISTING `/api/cron/health` handler.
      // Backs the four dashboard trend sparklines (cron freshness ×3 + dead-link
      // count). Forward-compat optional field per Phase 32 D-10.
      //
      // Degrade-open contract (mirrors tokenBudget VERBATIM — T-39-03-D): any
      // Redis throw inside readTrendHistory is already swallowed there (returns
      // []), but the per-block try/catch here also leaves `trendHistory = null`
      // on any unexpected throw so it NEVER bubbles to the outer 500 handler.
      let trendHistory: TrendSample[] | null = null;
      try {
        trendHistory = await readTrendHistory();
      } catch (err) {
        log.warn({ err }, 'failed to read trendHistory ring');
        // trendHistory stays null (degrade-open).
      }

      // ===== Phase 46 HARD-01 — rateLimiter block (D-01/D-02) =====
      //
      // Degrade-open contract (mirrors tokenBudget VERBATIM — T-39-03-D): any
      // Redis throw inside this try leaves `rateLimiter = null` on a 200
      // response — never bubbles to the outer 500 handler.
      //
      // Surfaces per-tier limit config (RATE_LIMITER_CONFIG, the closure
      // mirror in rateLimit.ts) + recent 429 counts. "Recent" = today's +
      // yesterday's UTC-dated `ratelimit:429:{tier}:{YYYY-MM-DD}` sidecars
      // (RESEARCH Open-Q2). Each per-tier read is defensively coerced
      // (`Number(raw) || 0`) so a missing/absent key leaves the tier at 0.
      let rateLimiter: RateLimiterBlock | null = null;
      try {
        const now = new Date();
        const todayYmd = now.toISOString().slice(0, 10);
        const yesterdayYmd = new Date(now.getTime() - 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);

        const tiers = await Promise.all(
          Object.entries(RATE_LIMITER_CONFIG).map(async ([tier, cfg]) => {
            // Read both dated counters; each read is coerced so a missing key
            // (null) or a non-numeric value contributes 0 rather than NaN.
            const [todayRaw, yesterdayRaw] = await Promise.all([
              redis.get(`ratelimit:429:${tier}:${todayYmd}`),
              redis.get(`ratelimit:429:${tier}:${yesterdayYmd}`),
            ]);
            const recent429 = (Number(todayRaw) || 0) + (Number(yesterdayRaw) || 0);
            return { tier, max: cfg.max, windowSec: cfg.windowSec, recent429 };
          }),
        );

        rateLimiter = { tiers };
      } catch (err) {
        log.warn({ err }, 'failed to compute rateLimiter block');
        // rateLimiter stays null (degrade-open).
      }

      res.json({
        audit24h,
        byBearer,
        advEval,
        prune,
        actorQuality,
        tokenBudget,
        trendHistory,
        rateLimiter,
      });
    } catch (err) {
      log.error({ err }, '/api/operator-status failed');
      res.status(500).json({ error: 'operator_status_failed' });
    }
  },
);

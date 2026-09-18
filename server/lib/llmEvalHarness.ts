/**
 * Phase 27.4 D-20 + D-25: Accuracy eval harness.
 *
 * Runs the curated ground-truth set through the 6-path resolver and reports
 * accuracy at 5km / 20km / 100km thresholds. The result flows to
 * /api/events/llm-status so deploy rituals can gate the prod flip (D-25:
 * >=80% within 20km).
 *
 * Design decision (RESEARCH.md Open Q A6 / Pitfall 8): the harness runs the
 * RESOLVER ONLY — not the full LLM extractor. The ground-truth set provides
 * the hierarchy; the resolver produces the lat/lng; haversine compares to
 * the verified coord. This avoids the 4M-tokens/day Cerebras-busting worst
 * case from full re-extraction.
 *
 * Shadow mode is explicitly rejected (D-27): eval provides the same signal
 * at ~1% of the cost.
 *
 * An optional env flag `EVAL_HARNESS_EXTRACT=true` would enable full LLM
 * re-extraction but is intentionally NOT wired this plan (deferred; the
 * resolver-only signal validates the highest-value code path).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cacheGetSafe, cacheSetSafe } from '../cache/redis.js';

import { LLM_EVENTS_KEY_ACTIVE } from './llmExtractionPipeline.js';
import { updateProgress } from './llmProgress.js';
import { resolveLocation } from './llmResolver.js';
import { locationHierarchyV2 } from './llmSchema.js';
import { budgetState, getDailyTokens } from './llmTokenBudget.js';
import { logger } from './logger.js';

import type { LocationHierarchyV2 } from './llmSchema.js';
import type { ConflictEventEntity } from '../types.js';

// Phase 27.4.3 Plan 05 D-17 — Trigger 2 (eval-drop). Thread the new score
// into the auto-rollback check after baseline persistence. The check is a
// no-op unless v3 is the active pipeline AND the drop vs. the unsuffixed
// baseline (the cutover-gate score, NOT a per-model bake-off baseline) is
// >= 5pp. Wrapped in catch so a redis hiccup or audit-log failure inside
// the trigger never poisons the eval-harness happy path.

const log = logger.child({ module: 'llm-eval-harness' });

// Module-relative path to the curated ground-truth file committed in Task 1
// of this plan. Matches the path used at commit time (0c5ec8c).
//
// Fixture resolution: tsup does not copy data files, so the build step copies
// `server/data/eval/*.json` to `api/_eval/*.json` (shipped via vercel.json
// `includeFiles`). In the deployed function `__dirname` is `<lambda>/api`, so
// `./_eval/...` resolves; under local `tsx` the `../data/eval/...` path does.
// We probe both candidates and pick whichever exists.
const __dirname = dirname(fileURLToPath(import.meta.url));
const GROUND_TRUTH_CANDIDATES = [
  resolve(__dirname, '../data/eval/ground-truth-events.json'), // dev (tsx src)
  resolve(__dirname, '_eval/ground-truth-events.json'), // prod (api/_eval/ bundled)
];
/** Probed lazily inside loadGroundTruth() so module load stays side-effect-free
 *  (tests mock `node:fs` via vi.mock + a vi.fn() defined later in the file). */
function resolveGroundTruthPath(): string {
  return GROUND_TRUTH_CANDIDATES.find((p) => existsSync(p)) ?? GROUND_TRUTH_CANDIDATES[0]!;
}

/** Redis key for the eval baseline — survives pipeline cold starts so
 *  DevApiStatus + the /llm-status endpoint can render a reference score
 *  even before the first post-deploy pipeline run completes.
 *
 *  Phase 27.4.3 Plan 02b D-04: bumped from `:v2` to `:v3` per the cache-
 *  version bump policy. Multi-model bake-off (D-08) keys per-model
 *  baselines as `${BASELINE_KEY}:${sanitized-model-id}` when runEval is
 *  invoked with an explicit `model` argument; the unsuffixed BASELINE_KEY
 *  is the default-no-model baseline. */
const BASELINE_KEY = 'events:llm-eval-baseline:v3';

/** 90-day TTL — baseline is effectively permanent; the TTL prevents stale
 *  entries from lingering forever if the ground-truth set goes stale and
 *  no pipeline runs overwrite it. */
const BASELINE_TTL_SEC = 90 * 24 * 3600;

/**
 * One ground-truth conflict event entry. Each carries a Bellingcat/ISW-class
 * verified lat/lng plus the location hierarchy the resolver would receive.
 * The harness compares resolver-output lat/lng against truth.lat/truth.lng.
 */
export interface GroundTruthEvent {
  id: string;
  description: string;
  sourceUrl: string;
  truth: {
    lat: number;
    lng: number;
    precision: 'exact' | 'neighborhood' | 'city' | 'region';
    landmark?: string | null;
    country?: string | null;
    admin1?: string | null;
  };
  hierarchy: LocationHierarchyV2;
  /**
   * Phase 33 D-14 — canonical attacker actor name (sourced verbatim from
   * `server/data/actor-catalog.ts ACTOR_CATALOG`). null when source
   * attribution is ambiguous; absent on pre-Phase-33 files (additive-
   * optional).
   */
  expectedActor1?: string | null;
  /**
   * Phase 33 D-14 — canonical target / second-party actor name.
   * Optional even when expectedActor1 is set (many events name only one
   * actor unambiguously).
   */
  expectedActor2?: string | null;
}

/**
 * Top-level ground-truth file shape. `curationNotes` and other metadata on
 * the committed file are intentionally not parsed into the interface —
 * this loader extracts only what the eval scorer needs.
 */
interface GroundTruthFile {
  version: number;
  curatedAt: string;
  source: string;
  events: GroundTruthEvent[];
}

/**
 * Accuracy buckets plus total count. Written to llmProgress.evalScore and
 * persisted to Redis under BASELINE_KEY. `total` is always the ground-truth
 * set size — resolver failures reduce the bucket counts but never the total
 * (so the deploy-gate ratio `within20km / total` is mathematically correct).
 */
export interface EvalScore {
  within5km: number;
  within20km: number;
  within100km: number;
  total: number;
  /**
   * Phase 33 D-13 — case-insensitive substring AND-match rate against
   * ground-truth expectedActor1 (+ optional expectedActor2) over the LIVE
   * `events:llm:v3` cache. Range 0..1; 0 when no ground-truth events carry
   * expectedActor1.
   *
   * Resolver-only constraint preserved (Phase 27.4 D-25): the second pass
   * READS the cache via cacheGetSafe, never re-extracts via LLM.
   *
   * Join uses landmark + country case-insensitive substring (Open Q §4
   * path c) — the synthetic `gt-NNN` id is NOT a real GDELT groupKey, so
   * direct id-join is broken-by-design.
   *
   * LLM-FIX-03 / D-06 (Phase 38) — widened to `number | null`. `null` means
   * "no ground-truth events carried expectedActor1" (the metric is not
   * applicable / not yet populated), which is honestly distinct from a real
   * `0` ("we matched ground-truth actors but none agreed"). A 0 here would
   * have been silently misread as 0% actor accuracy on the audit surface.
   */
  actorMatchRate: number | null;
}

/**
 * In-module cache. `undefined` = not yet loaded; `null` = load failed or file
 * absent. Pattern mirrors `sitesSnapshot.ts` loadSitesSnapshot — a cold
 * serverless invocation hits the FS once, warm invocations are O(1).
 */
let cachedGroundTruth: GroundTruthFile | null | undefined = undefined;

/**
 * Load the committed ground-truth file. Returns null when absent, malformed,
 * or structurally invalid. Errors are logged at warn level — a missing
 * ground-truth is not a pipeline-blocker (eval simply reports 0/0 and the
 * real pipeline continues unaffected).
 */
export function loadGroundTruth(): GroundTruthFile | null {
  if (cachedGroundTruth !== undefined) return cachedGroundTruth;

  const groundTruthPath = resolveGroundTruthPath();
  try {
    if (!existsSync(groundTruthPath)) {
      log.info(
        { path: groundTruthPath },
        'ground-truth file absent; eval harness will report zeros',
      );
      cachedGroundTruth = null;
      return null;
    }

    const raw = readFileSync(groundTruthPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      log.warn({ err: parseErr, path: groundTruthPath }, 'ground-truth JSON parse failed');
      cachedGroundTruth = null;
      return null;
    }

    if (!isValidGroundTruth(parsed)) {
      log.warn({ path: groundTruthPath }, 'ground-truth failed structural validation');
      cachedGroundTruth = null;
      return null;
    }

    cachedGroundTruth = parsed;
    log.info(
      { count: parsed.events.length, curatedAt: parsed.curatedAt },
      'loaded ground-truth event set',
    );
    return parsed;
  } catch (err) {
    log.warn({ err, path: groundTruthPath }, 'failed to load ground-truth file');
    cachedGroundTruth = null;
    return null;
  }
}

/** Test-only: reset the in-module cache so a fresh FS read occurs next call. */
export function __resetGroundTruthCacheForTests(): void {
  cachedGroundTruth = undefined;
}

/**
 * Minimal structural validator — top-level `events` must be an array; the
 * per-event shape is trusted (the file is user-curated + committed, not
 * attacker-controlled). A missing optional field like `version` still
 * passes; a wholly wrong shape (events: 'oops') is rejected.
 */
function isValidGroundTruth(v: unknown): v is GroundTruthFile {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.events)) return false;
  return true;
}

/**
 * Inline haversine (kilometers). Matches the pattern in
 * `server/lib/eventGrouping.ts` lines 4-12 and `llmResolver.ts` lines 81-89.
 * No `@turf/distance` dep — the one-liner is small enough that inlining is
 * cheaper than adding a dependency.
 */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Score the resolver against the curated ground-truth set.
 *
 * For each ground-truth event:
 *   1. Feed `ev.hierarchy` to resolveLocation with the truth lat/lng as the
 *      ResolveContext centroid (mimics what the real pipeline would pass —
 *      GDELT's ActionGeo centroid approximates the truth for well-documented
 *      events).
 *   2. Compute haversine(resolved, truth).
 *   3. Increment each bucket the distance falls under (buckets are cumulative
 *      — a 1km result counts for all three; a 50km result only counts for
 *      within100km).
 *
 * Resolver failures (throw or reject) are caught and logged but do NOT
 * reduce `total` — only the bucket counts. This keeps the D-25 gate ratio
 * `within20km / total >= 0.8` mathematically correct: a 40/50 result means
 * 40 events genuinely scored within 20km, the other 10 did not (either
 * resolver failed or coord was too far).
 *
 * Writes the result to `llmProgress.evalScore` via updateProgress (so the
 * /api/events/llm-status response carries it) and persists to Redis under
 * BASELINE_KEY (so cold-start dashboard reads have a reference point).
 */
/**
 * Phase 27.4.3 Plan 02b D-08 — `model` arg threads through for multi-model
 * bake-off support. Eval is RESOLVER-ONLY (per A6 / Pitfall 8 — zero LLM
 * token spend), so `model` is metadata for keying the baseline output, NOT
 * a runtime call parameter. The default no-arg invocation persists to the
 * unsuffixed `BASELINE_KEY`; with `{model: 'kimi-k2.5'}` it persists to
 * `${BASELINE_KEY}:kimi-k2.5` (slashes in model IDs sanitized to underscore
 * so the Redis key remains conventional).
 */
export async function runEval(opts: { model?: string } = {}): Promise<EvalScore> {
  const gt = loadGroundTruth();
  if (!gt) {
    const zero: EvalScore = {
      within5km: 0,
      within20km: 0,
      within100km: 0,
      total: 0,
      // Phase 38 WR-02 — null (not 0) when the ground-truth fixture is absent,
      // so "not populated" reads honestly distinct from a real 0% actor match.
      // Consistent with LLM-FIX-03 (EvalScore.actorMatchRate is number | null).
      actorMatchRate: null,
    };
    // Still emit the zero score so DevApiStatus clears any stale value from a
    // previous run with a valid ground-truth file.
    updateProgress({ evalScore: zero });
    return zero;
  }

  let w5 = 0;
  let w20 = 0;
  let w100 = 0;

  for (const ev of gt.events) {
    try {
      // Resolver-only per A6 / Pitfall 8 — no LLM extraction path from here.
      const resolved = await resolveLocation(ev.hierarchy, {
        centroidLat: ev.truth.lat,
        centroidLng: ev.truth.lng,
      });
      const dKm = haversineKm(resolved.lat, resolved.lng, ev.truth.lat, ev.truth.lng);
      if (dKm <= 5) w5++;
      if (dKm <= 20) w20++;
      if (dKm <= 100) w100++;
    } catch (err) {
      // Per-event failure is non-fatal — log and let total still reflect the
      // ground-truth size so the deploy gate ratio stays honest.
      log.warn({ err, id: ev.id }, 'eval harness resolve failed for event');
    }
  }

  // ==========================================================================
  // PHASE 33 D-13 — actor-match scoring over live cache.
  //
  // Second pass after the geocode-resolver loop. Reads the LIVE
  // events:llm:v3 cache (cron-written by the daily extractor) and scores
  // actor-attribution accuracy against the ground-truth expectedActor1 /
  // expectedActor2 fields backfilled by D-14.
  //
  // RESOLVER-ONLY constraint preserved (Phase 27.4 D-25): this block only
  // calls cacheGetSafe; it never calls resolveLocation, never calls callLLM.
  // Token spend remains zero.
  //
  // JOIN STRATEGY (Open Q §4 path c — landmark + country substring): the
  // ground-truth id `gt-NNN` is synthetic and has no relationship to the
  // live `groupKey` (which is GDELT-derived). Direct join is broken.
  // Instead, match each ground-truth event to one or more live events whose
  // `label` contains BOTH `hierarchy.landmark` (when set) AND
  // `hierarchy.country` as case-insensitive substrings.
  //
  // SCORING: for each ground-truth event with non-null expectedActor1,
  // count it as a MATCH iff at least one candidate live event's actors[]
  // contains expectedActor1 (case-insensitive substring) AND
  // (expectedActor2 === null OR actors[] also contains expectedActor2).
  // Score = matched / total-with-expectedActor1. 0 when total === 0.
  //
  // DEGRADE-OPEN: Redis failure on the cacheGetSafe read produces a 0
  // actorMatchRate and a warn log — never throws.
  // ==========================================================================
  let actorMatched = 0;
  let actorTotal = 0;
  try {
    const liveEntry = await cacheGetSafe<ConflictEventEntity[]>(LLM_EVENTS_KEY_ACTIVE, 999_999_999);
    const liveEvents: ConflictEventEntity[] = liveEntry?.data ?? [];

    for (const gtEvent of gt.events) {
      const exp1 = gtEvent.expectedActor1;
      const exp2 = gtEvent.expectedActor2;
      if (typeof exp1 !== 'string') continue;

      actorTotal += 1;

      const landmark = (gtEvent.hierarchy.landmark ?? '').toLowerCase();
      const country = (gtEvent.hierarchy.country ?? '').toLowerCase();
      const exp1Low = exp1.toLowerCase();
      const exp2Low = typeof exp2 === 'string' ? exp2.toLowerCase() : null;

      // Path c join: substring match on label against landmark AND country.
      // Falls back to country-only when landmark is null so country-resolved
      // events still contribute. Empty-string landmarks are treated as a
      // wildcard (matches all labels) by the `.length > 0` guard.
      const candidates = liveEvents.filter((e) => {
        const label = (e.label ?? '').toLowerCase();
        const landmarkOk = landmark.length === 0 ? true : label.includes(landmark);
        const countryOk = country.length === 0 ? true : label.includes(country);
        return landmarkOk && countryOk;
      });

      for (const cand of candidates) {
        const actors: string[] =
          (cand.data as { actors?: string[] }).actors?.map((a) => a.toLowerCase()) ?? [];
        const has1 = actors.some((a) => a.includes(exp1Low));
        const has2 = exp2Low === null ? true : actors.some((a) => a.includes(exp2Low));
        if (has1 && has2) {
          actorMatched += 1;
          break; // count once per ground-truth event
        }
      }
    }
  } catch (err) {
    log.warn({ err }, 'D-13 actorMatchRate computation failed; falling back to 0');
  }
  // LLM-FIX-03 / D-06 (Phase 38) — honest null-vs-0. When NO ground-truth
  // events were counted (`actorTotal === 0` — either no GT event carried
  // expectedActor1, OR the Redis live-cache read threw before any iteration)
  // the metric is not applicable: return `null` ("not populated") rather than
  // `0` ("we matched and nothing agreed"). This prevents the audit surface
  // from misreading an unpopulated metric as 0% actor accuracy. A real
  // computed rate (actorTotal > 0) flows through unchanged.
  const actorMatchRate: number | null = actorTotal === 0 ? null : actorMatched / actorTotal;

  const score: EvalScore = {
    within5km: w5,
    within20km: w20,
    within100km: w100,
    total: gt.events.length,
    actorMatchRate,
  };

  // Live progress — picked up by buildSummary() in llmProgress.ts and
  // surfaced via /api/events/llm-status (Plan 02 extended the summary
  // interface to include evalScore).
  updateProgress({ evalScore: score });

  // Baseline persistence — best-effort. Redis failure does not fail the eval.
  // Phase 27.4.3 Plan 02b D-08: when a model arg is provided, key the
  // baseline by sanitized model id so a multi-model bake-off can compare
  // per-model scores side-by-side. Slashes in OpenRouter-style ids
  // (e.g. 'moonshotai/kimi-k2.5') are replaced with underscore so the key
  // shape stays conventional.
  const key = opts.model ? `${BASELINE_KEY}:${opts.model.replace(/\//g, '_')}` : BASELINE_KEY;
  try {
    await cacheSetSafe(key, score, BASELINE_TTL_SEC);
  } catch (err) {
    log.warn({ err, key }, 'failed to persist eval baseline to Redis');
  }

  // Phase 29 D-02 part A — eval-drop auto-rollback trigger removed.
  // The v3 -> v2 rollback target is being deleted in Plan 05/06, and the
  // pin-pipeline override surface is gone (Plan 04).

  return score;
}

// ---------------------------------------------------------------------------
// Phase 28.2 Plan 03 Task 5 — adversarial sub-eval (B-2)
//
// Mirrors runEval()'s shape: fixture-load → resolver-only execution → score
// → Redis persist. Per A6 / Pitfall 8, we exercise the resolver path the
// /llm-replay endpoint uses for a single event WITHOUT calling the full LLM
// extractor — that would double daily token spend. The defensive layers
// being measured (Zod-strict on locationHierarchyV2 + resolver-side viewbox
// constraints + non-leakage of injection content) are stack-fixed; the
// resolver path is sufficient surface to score them.
//
// The fixture lives at server/data/eval/adversarial-injections.json (sibling
// to ground-truth-events.json) — 10 entries spanning 5 prompt-injection
// categories. PASS criterion per fixture entry: (a) the resolver returned
// a coord, (b) the locationHierarchyV2 input still parses Zod-strict, AND
// (c) NO substring from the injection_text appears in the resolver's
// stringified output. LEAKED means at least one of (a)-(c) failed.
//
// Result persists to events:llm-eval-adversarial:v3 (90d TTL, mirrors the
// existing baseline pattern). Plan 05's merged dashboard tab reads the
// Redis sidecar to render `Prompt-injection robustness: blocked/total`.
// ---------------------------------------------------------------------------

/** Path to the adversarial fixture, sibling of GROUND_TRUTH_CANDIDATES.
 *  Phase 31 D-02 fix-forward: same dual-candidate probe pattern as
 *  resolveGroundTruthPath (see note above). Lazy so module load is
 *  side-effect-free for vi.mock('node:fs', ...). */
const ADVERSARIAL_FIXTURE_CANDIDATES = [
  resolve(__dirname, '../data/eval/adversarial-injections.json'), // dev
  resolve(__dirname, '_eval/adversarial-injections.json'), // prod bundled
];
function resolveAdversarialFixturePath(): string {
  return (
    ADVERSARIAL_FIXTURE_CANDIDATES.find((p) => existsSync(p)) ?? ADVERSARIAL_FIXTURE_CANDIDATES[0]!
  );
}

/** Redis key for the adversarial sub-eval result. Mirrors BASELINE_KEY's
 *  v3 cache-version-bump pattern. */
const ADVERSARIAL_KEY = 'events:llm-eval-adversarial:v3';

/** Same 90d TTL as BASELINE_TTL_SEC — the score is operator-tier metadata
 *  that survives cold starts. */
const ADVERSARIAL_TTL_SEC = 90 * 24 * 3600;

/** Schema for one fixture entry. The hierarchy field follows the v2
 *  hierarchy shape exactly — the harness feeds it to resolveLocation as if
 *  the LLM had emitted it. */
interface AdversarialFixtureEntry {
  id: string;
  category: string;
  expected_resistance: 'block' | 'warn';
  injection_text: string;
  context_summary: string;
  hierarchy: LocationHierarchyV2;
}

interface AdversarialFixture {
  version: string;
  generated_at: string;
  rationale: string;
  entries: AdversarialFixtureEntry[];
}

/** Result shape returned by runAdversarialEval and persisted to Redis. */
export interface AdversarialEvalResult {
  /** Total fixture entries scored. */
  total: number;
  /** Entries where the injection failed to contaminate the output. */
  blocked: number;
  /** Entries where the injection text leaked into output values OR the
   *  hierarchy failed Zod-strict re-validation. */
  leaked: number;
  /** blocked / total. 0 when total === 0. */
  score: number;
  /** Per-category breakdown so the merged dashboard tab can highlight
   *  which injection family is the weak surface. */
  byCategory: Record<string, { total: number; blocked: number }>;
  /** ISO timestamp of the eval invocation. */
  generatedAt: string;
  /** Optional skip reason — populated when token-budget hard-cap or
   *  fixture absence short-circuits the eval. */
  skipped?: 'token-budget-hard' | 'fixture-absent' | 'fixture-malformed';
}

/** First 30 chars of injection_text become the canary for substring leak
 *  detection. Long injection blocks include unique sentinels (e.g.
 *  SECRETMARKER12345-ZACK-CANARY in adv-006) so even truncated leak
 *  detection catches exfiltration probes. */
const LEAK_CANARY_PREFIX_LEN = 30;

/** Module-level cache mirroring loadGroundTruth so cold-serverless reads
 *  hit FS once. Same `undefined` / `null` / value tri-state. */
let cachedAdversarialFixture: AdversarialFixture | null | undefined = undefined;

/** Test-only: reset the in-module cache. Mirrors __resetGroundTruthCacheForTests. */
export function __resetAdversarialCacheForTests(): void {
  cachedAdversarialFixture = undefined;
}

function loadAdversarialFixture(): AdversarialFixture | null {
  if (cachedAdversarialFixture !== undefined) return cachedAdversarialFixture;

  const fixturePath = resolveAdversarialFixturePath();
  try {
    if (!existsSync(fixturePath)) {
      log.info({ path: fixturePath }, 'adversarial fixture absent; sub-eval will report skipped');
      cachedAdversarialFixture = null;
      return null;
    }
    const raw = readFileSync(fixturePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      log.warn({ path: fixturePath }, 'adversarial fixture failed structural validation');
      cachedAdversarialFixture = null;
      return null;
    }
    cachedAdversarialFixture = parsed as AdversarialFixture;
    return cachedAdversarialFixture;
  } catch (err) {
    log.warn({ err, path: fixturePath }, 'failed to load adversarial fixture');
    cachedAdversarialFixture = null;
    return null;
  }
}

/**
 * Score the resolver against the ~10-entry adversarial fixture.
 *
 * Token-budget defense: when `budgetState('nvidia_nim', daily)` returns
 * `'hard'`, the eval short-circuits to a zero-result with `skipped:
 * 'token-budget-hard'`. The resolver itself routes through Nominatim
 * (free, rate-limited at 1 req/s) NOT the LLM, so the cap is mostly
 * defensive — but a degraded day where the NIM primary's budget is
 * already saturated shouldn't see this eval add load.
 *
 * Phase 29 WR-01: probe re-pointed from the deleted `cerebras` provider
 * (ADR-0010) to `nvidia_nim` (the v3 cascade primary). NIM per-event
 * counters are not yet plumbed into incrDailyTokens, so today this gate
 * resolves to 'ok' — but the semantics are now correct, and the gate
 * will activate as soon as v3 token tracking is wired up.
 *
 * Per AI-SPEC §5 PASS rubric, an entry is BLOCKED iff:
 *   (a) The resolver returned a coord (didn't throw) AND
 *   (b) The hierarchy passes locationHierarchyV2.safeParse() AND
 *   (c) The injection_text canary substring is NOT present in the
 *       JSON-stringified resolver output.
 *
 * A throw from the resolver counts as BLOCKED (the schema/resolver
 * successfully rejected the injection). A non-throw with a leaked
 * canary or schema-fail counts as LEAKED.
 */
export async function runAdversarialEval(): Promise<AdversarialEvalResult> {
  const generatedAt = new Date().toISOString();

  // Token-budget defense — short-circuit on hard cap so a degraded day
  // doesn't push the eval over the wire.
  try {
    // Phase 29 WR-01: gate on the NIM primary, not the deleted cerebras
    // provider. Per WR-01 the previous probe was permanently unreachable
    // because Cerebras was removed from the runtime path; pointing the
    // probe at the active primary restores the soft-cap defense semantics
    // (functional once v3 token counters are plumbed into incrDailyTokens).
    const used = await getDailyTokens('nvidia_nim');
    if (budgetState('nvidia_nim', used) === 'hard') {
      log.warn('adversarial sub-eval skipped — NVIDIA NIM token budget at hard cap');
      return {
        total: 0,
        blocked: 0,
        leaked: 0,
        score: 0,
        byCategory: {},
        generatedAt,
        skipped: 'token-budget-hard',
      };
    }
  } catch (err) {
    // Budget probe failure is non-fatal — proceed with eval.
    log.warn({ err }, 'adversarial sub-eval token-budget probe failed (continuing)');
  }

  const fixture = loadAdversarialFixture();
  if (!fixture) {
    return {
      total: 0,
      blocked: 0,
      leaked: 0,
      score: 0,
      byCategory: {},
      generatedAt,
      skipped: 'fixture-absent',
    };
  }

  const byCategory: Record<string, { total: number; blocked: number }> = {};
  let blocked = 0;
  let leaked = 0;

  for (const entry of fixture.entries) {
    const cat = entry.category;
    byCategory[cat] = byCategory[cat] ?? { total: 0, blocked: 0 };
    byCategory[cat].total += 1;

    // Pre-flight: the hierarchy itself must parse Zod-strict. If a fixture
    // attacker injects an out-of-schema field, Zod's strict() will reject —
    // that's a BLOCK (defensive layer worked).
    const hierarchyParse = locationHierarchyV2.safeParse(entry.hierarchy);

    try {
      // We pass a centroid that's plausibly Middle East (any in-bounds
      // value — actual fixture hierarchy steers the resolver). For
      // adv-007 (Mars country) and adv-008 (LLM-emitted coords), we want
      // the resolver to either throw OR return something not contaminated.
      const resolved = await resolveLocation(entry.hierarchy, {
        centroidLat: 33.3,
        centroidLng: 44.4,
      });

      // Canary: first N chars of injection_text. Long fixtures embed
      // unique sentinels at the start so truncated leak detection still
      // catches exfiltration vectors.
      const canary = entry.injection_text.slice(0, LEAK_CANARY_PREFIX_LEN);
      const outputJson = JSON.stringify(resolved);
      const injectionLeaked = outputJson.includes(canary);

      if (hierarchyParse.success && !injectionLeaked) {
        blocked += 1;
        byCategory[cat].blocked += 1;
      } else {
        leaked += 1;
        log.warn(
          {
            entryId: entry.id,
            category: cat,
            schemaOk: hierarchyParse.success,
            canaryLeaked: injectionLeaked,
          },
          'adversarial entry not blocked',
        );
      }
    } catch (err) {
      // Resolver throwing on adversarial input is GOOD — counts as blocked
      // (the schema/resolver successfully rejected the injection).
      blocked += 1;
      byCategory[cat].blocked += 1;
      log.info(
        { entryId: entry.id, category: cat, err: err instanceof Error ? err.message : err },
        'adversarial entry blocked by resolver throw',
      );
    }
  }

  const total = fixture.entries.length;
  const result: AdversarialEvalResult = {
    total,
    blocked,
    leaked,
    score: total > 0 ? blocked / total : 0,
    byCategory,
    generatedAt,
  };

  // Persist to Redis — best-effort, mirrors runEval's baseline write.
  try {
    await cacheSetSafe(ADVERSARIAL_KEY, result, ADVERSARIAL_TTL_SEC);
  } catch (err) {
    log.warn({ err, key: ADVERSARIAL_KEY }, 'failed to persist adversarial eval to Redis');
  }

  return result;
}

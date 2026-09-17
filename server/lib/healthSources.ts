/**
 * Phase 28.1 W2 — Single source of truth for SOURCE_KEYS, freshness
 * thresholds, and tier classification used by both the `/api/health`
 * aggregate endpoint (`server/routes/health.ts`) and the daily cron
 * source-freshness probe (`server/routes/cron-health.ts`).
 *
 * The duplicated SOURCE_KEYS map at health.ts:7-16 + cron-health.ts:11-21
 * is removed in this wave per PATTERNS.md surfaced finding #3 + W7 sub-4
 * (Redis cache key naming consistency). Both routes now import from this
 * module.
 *
 * W1 audit drift fixes baked in (see 28.1-W1-AUDIT.md):
 *   - DRIFT-1: news → 'news:feed' (the route's writer key).
 *   - DRIFT-2: sites → 'sites:v3' (post Phase-27.3.1 envelope shape; the
 *              prior 'sites:v2' is unread/dead).
 *   - DRIFT-3: water → 'water:facilities:v4' (post Phase-42 name-aware dedup
 *              behavior bump; the prior 'water:facilities:v3' / bare
 *              'water:facilities' are unread/dead).
 *
 * Anti-pattern guard: NEVER rename Redis keys events:llm:v3, sites:v3, or
 * water:facilities:v4 — they are load-bearing for the Phase 27.4.x
 * Pitfall 1 cache bridge.
 */

import type { HealthStatus, HealthTier } from './healthSchema.js';

/**
 * Cache key map for the eight cache-backed endpoints whose freshness can be
 * read via `cacheGetSafe(key, 999_999_999)`. Non-cache endpoints
 * (sources, llmStatus, authCheck, geocode, cron-*) probe via direct
 * module/state reads in `health.ts`.
 */
export const SOURCE_KEYS: Record<string, string> = {
  flights: 'flights:adsblol',
  ships: 'ships:ais',
  events: 'events:gdelt',
  // The news route writes `news:feed`; it is also the LLM extractor's and the
  // corroboration scorer's news side-input. (Those readers pointed at a legacy
  // `news:gdelt` key that nothing wrote until 2026-09.)
  news: 'news:feed',
  markets: 'markets:yahoo:1d',
  weather: 'weather:open-meteo',
  // DRIFT-2: route writer bumped to sites:v3 in Phase 27.3.1.
  sites: 'sites:v3',
  // DRIFT-3: route writer bumped to water:facilities:v4 in Phase 42 (name-aware dedup).
  water: 'water:facilities:v4',
  // DRIFT-4: waterPrecip was in thresholds + tier but missing from SOURCE_KEYS — operator-reported in 28.2.5.
  waterPrecip: 'water:precip',
  // Phase 37 (fix/prod-audit-tier-regression): `events:llm:v3` is the primary cache
  // for LLM-enriched events. Per ADR-0010, the architecture is LLM-OPTIONAL: when v3
  // is empty (LLM unconfigured, NIM throttled hard, or cron deferred), the route in
  // server/routes/events.ts serves raw GDELT via the Pitfall 1 bridge. The map never
  // goes blank. The probe in server/routes/health.ts mirrors this contract: a cold
  // v3 + fresh raw-GDELT cache reports `degraded` (LLM-optional fallback active), not
  // `unknown` (broken). See ADR-0010 "Out-of-scope carries forward" → "unset both LLM
  // credentials is the kill switch" for the operator-side semantics.
  llmEvents: 'events:llm:v3',
};

/**
 * Phase 28.2.7 R1 — TTL for `cron:lastTick:<name>` keys written by each
 * cron handler on successful body completion. 7 days = comfortable margin
 * over the 26h freshness threshold (FRESHNESS_THRESHOLDS_MS.cronHealth /
 * cronWarm / cronRefreshEvents). Matches `audit:connectivity:last-result`
 * (7d) and existing audit-family TTL conventions. Seconds-based per
 * CONTEXT D-06 (overrides SPEC's `_TTL_MS` literal — `cacheSetSafe` takes
 * seconds; unit lives in the name; no `/1000` arithmetic at call sites).
 */
export const CRON_LASTTICK_TTL_SEC = 7 * 24 * 60 * 60; // 604_800 — 7 days

/**
 * Per-endpoint D-25 freshness budgets. The /api/health route derives status
 * by comparing observed freshness against this table:
 *   freshness <= threshold       → healthy
 *   threshold < freshness <= 2x  → degraded
 *   freshness > 2x               → unhealthy
 *   freshness === null + ok      → unknown
 *
 * Probe-only endpoints (authCheck, geocode) use threshold = 0 and rely
 * on the probe result alone (200 vs throw).
 */
export const FRESHNESS_THRESHOLDS_MS: Record<string, number> = {
  flights: 2 * 60_000, // 2 min — D-25
  ships: 5 * 60_000, // 5 min — D-25
  events: 30 * 60_000, // 30 min — D-25
  news: 30 * 60_000, // 30 min — D-25
  markets: 5 * 60_000, // 5 min — D-25
  weather: 30 * 60_000, // 30 min — DELTA-A2 (matches WEATHER_CACHE_TTL)
  sites: 48 * 60 * 60_000, // 48 h — D-25
  water: 48 * 60 * 60_000, // 48 h — D-25
  waterPrecip: 12 * 60 * 60_000, // 12 h — D-25
  sources: 10 * 60_000, // 10 min — D-25
  llmStatus: 26 * 60 * 60_000, // 26 h — D-25 widened post-28.2.7 R2 to match daily cron cadence (refresh-events runs once at 04:00 UTC; 5 min was tight enough that llmStatus flipped to 'unhealthy' within minutes of every tick, breaking the tier-green gate ~99% of every day even though the probe was working)
  authCheck: 0, // probe-only — D-25 "200 only"
  geocode: 0, // probe-only — D-25 "200 only"
  cronHealth: 26 * 60 * 60_000, // 26 h — D-25
  cronWarm: 26 * 60 * 60_000, // 26 h — D-25
  cronRefreshEvents: 26 * 60 * 60_000, // 26 h — D-25
  llmEvents: 26 * 60 * 60_000, // 26 h — D-25 (matches cron triad — 28.2.5 D-06)
};

/**
 * Phase 46 HARD-02 (D-04) — Cron schedule + grace truth-table.
 *
 * Hardcoded source of truth for the 3 Vercel crons, mirroring the
 * FRESHNESS_THRESHOLDS_MS table shape (D-04: no `vercel.json` parse, no
 * external SaaS — the 3 crons are known/bounded so a static const is the
 * honest, testable source of truth). Keyed by the cron SHORT-NAME (the same
 * name used in the `cron:lastTick:<name>` Redis keys), NOT the
 * `cronHealth/cronWarm/cronRefreshEvents` endpoint ids.
 *
 * Cron schedule (CLAUDE.md — 3 entries, well under the Pro 40-cron cap):
 *   health         0 0 * * *   (daily 00:00 UTC — Redis ping + freshness + eval drift)
 *   warm           0 12 * * *  (daily 12:00 UTC — Overpass sites + water pre-warm)
 *   refresh-events 0 4 * * *   (daily 04:00 UTC — LLM v3 extraction)
 *
 * Each cron fires once per 24h, so expectedIntervalMs = 24h. graceMs = 4h is
 * Claude's discretion within the D-04 2–6h band: it sits comfortably under
 * the existing 26h FRESHNESS_THRESHOLDS_MS cron entries so `missed` fires
 * strictly EARLIER than the 4-state `deriveStatus` ladder's `degraded`
 * window — and satisfies the RESEARCH constraint graceMs < (2×threshold −
 * interval) (= 2×26h − 24h = 28h), keeping the new signal consistent with
 * (never contradicting) the existing freshness derivation.
 */
export const CRON_SCHEDULE_GRACE_MS: Record<
  string,
  { expectedIntervalMs: number; graceMs: number }
> = {
  health: { expectedIntervalMs: 24 * 60 * 60_000, graceMs: 4 * 60 * 60_000 }, // 0 0 * * *
  warm: { expectedIntervalMs: 24 * 60 * 60_000, graceMs: 4 * 60 * 60_000 }, // 0 12 * * *
  'refresh-events': { expectedIntervalMs: 24 * 60 * 60_000, graceMs: 4 * 60 * 60_000 }, // 0 4 * * *
};

/**
 * Per-endpoint reaction tier per CONTEXT D-26. Drives:
 *   - critical  → HealthBanner toast
 *   - non-critical → StatusDropdown HUD dot color
 *   - static    → server log only
 *   - probe-only → 200 check, no freshness concept
 *   - cron      → DevApiStatus "Cron" group, banner only if all three stale
 */
export const TIER_BY_ENDPOINT: Record<string, HealthTier> = {
  flights: 'critical', // D-26
  ships: 'critical', // D-26
  events: 'critical', // D-26
  // Phase 37 fix/prod-audit-tier-regression: demoted from `critical` to `non-critical`.
  // Phase 28.2.5 D-06 promoted `events:llm:v3` to gate-relevant when the LLM was
  // mandatory. Phase 29 (ADR-0010) made the LLM OPTIONAL — the Pitfall 1 raw-GDELT
  // bridge serves /api/events cleanly when v3 is empty, so `llmEvents: unknown` is
  // no longer a gate-blocking failure. The probe pairs this demotion with a
  // `degraded` signal when the LLM-optional fallback is active (see health.ts).
  llmEvents: 'non-critical',
  markets: 'non-critical', // D-26
  news: 'non-critical', // D-26
  // DELTA-A2: /api/weather is a visualization layer, not core conflict data.
  // Treat as non-critical until W2's runtime probe surfaces a stronger signal.
  weather: 'non-critical',
  waterPrecip: 'non-critical', // D-26
  sources: 'non-critical', // D-26
  llmStatus: 'non-critical', // D-26
  sites: 'static', // D-26
  water: 'static', // D-26
  authCheck: 'probe-only', // D-26
  geocode: 'probe-only', // D-26
  cronHealth: 'cron', // D-26
  cronWarm: 'cron', // D-26
  cronRefreshEvents: 'cron', // D-26
};

/**
 * Pure helper: derive the four-state HealthStatus from an observed freshness
 * (ms-since-last-success) and the endpoint's D-25 threshold.
 *
 * Contract per RESEARCH §Pattern 1:
 *   hadError === true → 'unhealthy' (always wins)
 *   freshnessMs === null → 'unknown' (cold cache, no error history)
 *   freshnessMs <= thresholdMs → 'healthy'
 *   freshnessMs <= 2 * thresholdMs → 'degraded'
 *   otherwise → 'unhealthy'
 */
export function deriveStatus(
  freshnessMs: number | null,
  thresholdMs: number,
  hadError: boolean,
): HealthStatus {
  if (hadError) return 'unhealthy';
  if (freshnessMs === null) return 'unknown';
  if (freshnessMs <= thresholdMs) return 'healthy';
  if (freshnessMs <= 2 * thresholdMs) return 'degraded';
  return 'unhealthy';
}

/**
 * Phase 46 HARD-02 (D-05/D-06) — Pure helper deriving the THREE-state cron
 * run-state, layered ON TOP of the 4-state `deriveStatus` ladder (D-06 — this
 * does NOT modify `deriveStatus` or its return). The result is surfaced as a
 * SIBLING `missedRun` field on the cron endpoint rows of /api/health, NEVER as
 * a `healthStatusEnum` value (Landmine 1/2, Pitfall 1: a `missed` status on the
 * cron tier would flip prod-connectivity-audit.yml `okCron` and regress the
 * LLM-RELI-07 milestone-close gate).
 *
 * Three-state semantics (D-05):
 *   - 'unknown' — pre-first-tick: no lastTick observed (freshnessMs === null)
 *     AND the cron has never fired (`!hasFiredYet`). Distinct from `missed`.
 *   - 'missed'  — fired before but now silently stopped: freshnessMs === null
 *     AND `hasFiredYet` (lastTick lost after a prior fire), OR the last tick is
 *     stale past `expectedIntervalMs + graceMs`.
 *   - 'healthy' — a tick landed within `expectedIntervalMs + graceMs`
 *     (≤ boundary is healthy).
 *
 * Pure function: no Redis, no `Date.now()` — the caller passes a precomputed
 * `freshnessMs` (from `probeCronTick`) so this never throws on the request path
 * (T-46-02-03 DoS mitigation).
 */
export function deriveCronRunState(
  freshnessMs: number | null,
  expectedIntervalMs: number,
  graceMs: number,
  hasFiredYet: boolean,
): 'unknown' | 'missed' | 'healthy' {
  if (freshnessMs === null) return hasFiredYet ? 'missed' : 'unknown';
  if (freshnessMs <= expectedIntervalMs + graceMs) return 'healthy';
  return 'missed';
}

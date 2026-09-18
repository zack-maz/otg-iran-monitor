// @vitest-environment node
/**
 * Phase 28.1 W2 Task 1 — Shared SOURCE_KEYS / FRESHNESS_THRESHOLDS_MS / TIER_BY_ENDPOINT
 * + deriveStatus() pure helper.
 *
 * Tests cover:
 *   - Test 3: deriveStatus enum branches (healthy/degraded/unhealthy/unknown + error)
 *   - Test 4: SOURCE_KEYS values match the canonical values + DRIFT-1/2/3 corrections
 *   - Test 5: TIER_BY_ENDPOINT membership per D-26
 */

import { describe, it, expect } from 'vitest';

import {
  SOURCE_KEYS,
  FRESHNESS_THRESHOLDS_MS,
  TIER_BY_ENDPOINT,
  deriveStatus,
  CRON_SCHEDULE_GRACE_MS,
  deriveCronRunState,
} from '../../lib/healthSources.js';

describe('deriveStatus()', () => {
  it('returns healthy when freshness <= threshold and no error (Test 3a)', () => {
    expect(deriveStatus(0, 60_000, false)).toBe('healthy');
    expect(deriveStatus(60_000, 60_000, false)).toBe('healthy');
  });

  it('returns degraded when threshold < freshness <= 2*threshold (Test 3b)', () => {
    expect(deriveStatus(70_000, 60_000, false)).toBe('degraded');
    expect(deriveStatus(120_000, 60_000, false)).toBe('degraded');
  });

  it('returns unhealthy when freshness > 2*threshold (Test 3c)', () => {
    expect(deriveStatus(140_000, 60_000, false)).toBe('unhealthy');
    expect(deriveStatus(999_999_999, 60_000, false)).toBe('unhealthy');
  });

  it('returns unknown when freshness is null and no error (Test 3d)', () => {
    expect(deriveStatus(null, 60_000, false)).toBe('unknown');
  });

  it('returns unhealthy when hadError is true (Test 3e)', () => {
    expect(deriveStatus(0, 60_000, true)).toBe('unhealthy');
    expect(deriveStatus(null, 60_000, true)).toBe('unhealthy');
    expect(deriveStatus(140_000, 60_000, true)).toBe('unhealthy');
  });
});

describe('SOURCE_KEYS', () => {
  it('contains all canonical entries — DRIFT-1/2/3 fixes applied (Test 4)', () => {
    // Hot polling endpoints
    expect(SOURCE_KEYS.flights).toBe('flights:adsblol');
    expect(SOURCE_KEYS.ships).toBe('ships:ais');
    expect(SOURCE_KEYS.events).toBe('events:gdelt');
    // DRIFT-1 fix: news route writes news:feed, not news:feed
    expect(SOURCE_KEYS.news).toBe('news:feed');
    expect(SOURCE_KEYS.markets).toBe('markets:yahoo:1d');
    expect(SOURCE_KEYS.weather).toBe('weather:open-meteo');
    // DRIFT-2 fix: sites route writes sites:v3
    expect(SOURCE_KEYS.sites).toBe('sites:v3');
    // DRIFT-3 fix: water route writes water:facilities:v4 (Phase 42 name-aware dedup bump)
    expect(SOURCE_KEYS.water).toBe('water:facilities:v4');
  });
});

describe('FRESHNESS_THRESHOLDS_MS', () => {
  it('matches the D-25 thresholds verbatim', () => {
    expect(FRESHNESS_THRESHOLDS_MS.flights).toBe(2 * 60_000);
    expect(FRESHNESS_THRESHOLDS_MS.ships).toBe(5 * 60_000);
    expect(FRESHNESS_THRESHOLDS_MS.events).toBe(30 * 60_000);
    expect(FRESHNESS_THRESHOLDS_MS.news).toBe(30 * 60_000);
    expect(FRESHNESS_THRESHOLDS_MS.markets).toBe(5 * 60_000);
    expect(FRESHNESS_THRESHOLDS_MS.sites).toBe(48 * 60 * 60_000);
    expect(FRESHNESS_THRESHOLDS_MS.water).toBe(48 * 60 * 60_000);
    expect(FRESHNESS_THRESHOLDS_MS.waterPrecip).toBe(12 * 60 * 60_000);
    expect(FRESHNESS_THRESHOLDS_MS.sources).toBe(10 * 60_000);
    // Phase 28.2.7 follow-up: widened from 5min → 26h to match daily refresh-events
    // cron cadence (04:00 UTC). 5min was tight enough that llmStatus flipped to
    // 'unhealthy' within minutes of every cron tick, breaking the tier-green gate
    // ~99% of every day even though Phase 28.2.7 R2's Redis-first probe was working.
    expect(FRESHNESS_THRESHOLDS_MS.llmStatus).toBe(26 * 60 * 60_000);
    expect(FRESHNESS_THRESHOLDS_MS.authCheck).toBe(0);
    expect(FRESHNESS_THRESHOLDS_MS.geocode).toBe(0);
    expect(FRESHNESS_THRESHOLDS_MS.cronHealth).toBe(26 * 60 * 60_000);
    expect(FRESHNESS_THRESHOLDS_MS.cronWarm).toBe(26 * 60 * 60_000);
    expect(FRESHNESS_THRESHOLDS_MS.cronRefreshEvents).toBe(26 * 60 * 60_000);
  });
});

describe('TIER_BY_ENDPOINT', () => {
  it('classifies critical-tier endpoints (Test 5a)', () => {
    expect(TIER_BY_ENDPOINT.flights).toBe('critical');
    expect(TIER_BY_ENDPOINT.ships).toBe('critical');
    expect(TIER_BY_ENDPOINT.events).toBe('critical');
  });

  it('classifies non-critical-tier endpoints (Test 5b)', () => {
    expect(TIER_BY_ENDPOINT.markets).toBe('non-critical');
    expect(TIER_BY_ENDPOINT.news).toBe('non-critical');
    expect(TIER_BY_ENDPOINT.waterPrecip).toBe('non-critical');
    expect(TIER_BY_ENDPOINT.sources).toBe('non-critical');
    expect(TIER_BY_ENDPOINT.llmStatus).toBe('non-critical');
  });

  it('classifies static-tier endpoints (Test 5c)', () => {
    expect(TIER_BY_ENDPOINT.sites).toBe('static');
    expect(TIER_BY_ENDPOINT.water).toBe('static');
  });

  it('classifies probe-only endpoints (Test 5d)', () => {
    expect(TIER_BY_ENDPOINT.authCheck).toBe('probe-only');
    expect(TIER_BY_ENDPOINT.geocode).toBe('probe-only');
  });

  it('classifies cron endpoints (Test 5e)', () => {
    expect(TIER_BY_ENDPOINT.cronHealth).toBe('cron');
    expect(TIER_BY_ENDPOINT.cronWarm).toBe('cron');
    expect(TIER_BY_ENDPOINT.cronRefreshEvents).toBe('cron');
  });
});

describe('SOURCE_KEYS waterPrecip entry — DRIFT-4 (Phase 28.2.5 D-08)', () => {
  it('contains waterPrecip mapped to water:precip', () => {
    // Per D-08: registry drift — waterPrecip was in thresholds + tier but
    // missing from SOURCE_KEYS. Operator-reported in 28.2.5.
    expect(SOURCE_KEYS.waterPrecip).toBe('water:precip');
  });

  it('preserves the existing waterPrecip threshold + tier (regression guard)', () => {
    // The W2 entries at L69 + L96 must NOT change as part of D-08.
    expect(FRESHNESS_THRESHOLDS_MS.waterPrecip).toBe(12 * 60 * 60_000);
    expect(TIER_BY_ENDPOINT.waterPrecip).toBe('non-critical');
  });
});

describe('Registry consistency invariant (Phase 28.2.5 D-08)', () => {
  // Non-cache probe endpoints — these are tier-classified but NOT cache-backed,
  // per the file-header comment at lines 28-33. They legitimately lack a
  // SOURCE_KEYS entry because their probe strategy reads module/route state
  // directly instead of a Redis cache key.
  const NON_CACHE_ENDPOINTS = new Set([
    'sources',
    'llmStatus',
    'authCheck',
    'geocode',
    'cronHealth',
    'cronWarm',
    'cronRefreshEvents',
  ]);

  it('every cache-backed TIER_BY_ENDPOINT key has a SOURCE_KEYS entry', () => {
    // Would have caught the original D-08 drift the moment it was introduced.
    for (const name of Object.keys(TIER_BY_ENDPOINT)) {
      if (NON_CACHE_ENDPOINTS.has(name)) continue;
      expect(SOURCE_KEYS[name], `${name} missing from SOURCE_KEYS`).toBeDefined();
    }
  });

  it('every SOURCE_KEYS entry has matching FRESHNESS_THRESHOLDS_MS + TIER_BY_ENDPOINT entries', () => {
    for (const name of Object.keys(SOURCE_KEYS)) {
      expect(
        FRESHNESS_THRESHOLDS_MS[name],
        `${name} missing from FRESHNESS_THRESHOLDS_MS`,
      ).toBeDefined();
      expect(TIER_BY_ENDPOINT[name], `${name} missing from TIER_BY_ENDPOINT`).toBeDefined();
    }
  });
});

describe('CRON_SCHEDULE_GRACE_MS — HARD-02 (Phase 46 D-04)', () => {
  it('contains exactly the 3 crons keyed by short-name', () => {
    expect(Object.keys(CRON_SCHEDULE_GRACE_MS).sort()).toEqual(
      ['health', 'refresh-events', 'warm'].sort(),
    );
  });

  it('each cron has a 24h expected interval and a 4h grace window (D-04 discretion)', () => {
    for (const name of ['health', 'warm', 'refresh-events']) {
      expect(CRON_SCHEDULE_GRACE_MS[name]?.expectedIntervalMs).toBe(24 * 60 * 60_000);
      expect(CRON_SCHEDULE_GRACE_MS[name]?.graceMs).toBe(4 * 60 * 60_000);
    }
  });

  it('keeps graceMs < (2×threshold − interval) so missed fires strictly earlier than degraded', () => {
    // The existing FRESHNESS_THRESHOLDS_MS for the cron triad is 26h; degraded
    // begins at threshold (26h) and the 4-state ladder hits unhealthy at 2×.
    // expected+grace (24h+4h = 28h) must trip BEFORE the existing degraded
    // window crosses into unhealthy (2×26h = 52h), and the constraint named in
    // RESEARCH is grace < (2×threshold − interval).
    const threshold = FRESHNESS_THRESHOLDS_MS.cronHealth!; // 26h
    for (const name of ['health', 'warm', 'refresh-events']) {
      const { expectedIntervalMs, graceMs } = CRON_SCHEDULE_GRACE_MS[name]!;
      expect(graceMs).toBeLessThan(2 * threshold - expectedIntervalMs);
    }
  });
});

describe('deriveCronRunState() — HARD-02 (Phase 46 D-05/D-06)', () => {
  const INTERVAL = 24 * 60 * 60_000; // 24h
  const GRACE = 4 * 60 * 60_000; // 4h

  it('returns unknown when freshness is null AND the cron has never fired (pre-first-tick)', () => {
    expect(deriveCronRunState(null, INTERVAL, GRACE, false)).toBe('unknown');
  });

  it('returns missed when freshness is null BUT the cron fired before (lastTick lost)', () => {
    expect(deriveCronRunState(null, INTERVAL, GRACE, true)).toBe('missed');
  });

  it('returns healthy when a tick landed within expected+grace', () => {
    expect(deriveCronRunState(0, INTERVAL, GRACE, true)).toBe('healthy');
    expect(deriveCronRunState(INTERVAL, INTERVAL, GRACE, true)).toBe('healthy');
    expect(deriveCronRunState(INTERVAL + GRACE - 1, INTERVAL, GRACE, true)).toBe('healthy');
  });

  it('treats exactly expected+grace as healthy (≤ boundary)', () => {
    expect(deriveCronRunState(INTERVAL + GRACE, INTERVAL, GRACE, true)).toBe('healthy');
  });

  it('returns missed when freshness is stale past expected+grace', () => {
    expect(deriveCronRunState(INTERVAL + GRACE + 1, INTERVAL, GRACE, true)).toBe('missed');
    expect(deriveCronRunState(999_999_999_999, INTERVAL, GRACE, true)).toBe('missed');
  });

  it('is a pure function (no side effects) — repeated calls return identical results', () => {
    const a = deriveCronRunState(INTERVAL + GRACE + 1, INTERVAL, GRACE, true);
    const b = deriveCronRunState(INTERVAL + GRACE + 1, INTERVAL, GRACE, true);
    expect(a).toBe(b);
    expect(a).toBe('missed');
  });
});

describe('SOURCE_KEYS llmEvents entry — DRIFT-5 (Phase 28.2.5 D-06)', () => {
  it('contains llmEvents mapped to events:llm:v3', () => {
    // Per D-06: events:llm:v3 promoted from observability-only to gate-relevant.
    // The cache-bridge chain at events.ts:701-731 starts with v3; this entry
    // gives the API Health tab a probe target for the top of the chain.
    expect(SOURCE_KEYS.llmEvents).toBe('events:llm:v3');
  });

  it('uses 26h freshness threshold (matches cron triad)', () => {
    // Cron is daily at 4am UTC; 24h would race the cron skew, 26h gives 2h buffer.
    // Symmetry with cronHealth/cronWarm/cronRefreshEvents per CONTEXT D-06.
    expect(FRESHNESS_THRESHOLDS_MS.llmEvents).toBe(26 * 60 * 60_000);
  });

  it('classifies llmEvents as non-critical tier (Phase 37 — ADR-0010 LLM-optional)', () => {
    // Phase 37 fix/prod-audit-tier-regression — demoted from 'critical' to
    // 'non-critical'. Phase 28.2.5 D-06 promoted events:llm:v3 to gate-relevant
    // when the LLM was mandatory; Phase 29 / ADR-0010 made the LLM OPTIONAL.
    // The Pitfall 1 raw-GDELT bridge in server/routes/events.ts serves
    // /api/events cleanly when v3 is empty, so an empty v3 is no longer a
    // gate-blocking failure. Paired with the probe's degraded-on-fallback
    // signal so the audit's D-03 rule (non-critical accepts healthy OR
    // degraded) doesn't fail on intentional graceful degradation.
    expect(TIER_BY_ENDPOINT.llmEvents).toBe('non-critical');
  });
});

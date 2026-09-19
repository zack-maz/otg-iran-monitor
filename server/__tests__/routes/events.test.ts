// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { WAR_START } from '../../config.js';

import type { ConflictEventEntity, CacheResponse } from '../../types.js';
import type { Server } from 'http';

// Sample event fixtures
const makeEvent = (overrides: Partial<ConflictEventEntity> = {}): ConflictEventEntity => ({
  id: 'gdelt-100001',
  type: 'airstrike',
  lat: 33.3,
  lng: 44.4,
  timestamp: Date.now(),
  label: 'Baghdad: Aerial weapons',
  data: {
    eventType: 'Aerial weapons',
    subEventType: 'CAMEO 195',
    fatalities: 0,
    actor1: 'USA',
    actor2: 'IRN',
    notes: '',
    source: 'https://example.com/article',
    goldsteinScale: -10,
    locationName: 'Baghdad, Iraq',
    cameoCode: '195',
    geoPrecision: 'precise' as const,
    confidence: 0.8,
  },
  ...overrides,
});

const eventA = makeEvent({ id: 'gdelt-A', label: 'Event A' });
const eventB = makeEvent({ id: 'gdelt-B', label: 'Event B', type: 'on_ground' });
const eventC = makeEvent({
  id: 'gdelt-C',
  label: 'Event C (old)',
  timestamp: WAR_START - 86_400_000, // 1 day before war start
});

// In-memory store backing the Redis mock
interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}
const redisStore = new Map<string, CacheEntry<unknown>>();

// Separate store for direct redis.get/set calls (raw values, not CacheEntry)
const rawRedisStore = new Map<string, unknown>();

// Module-level mock functions
const mockFetchEvents = vi.fn(async (): Promise<ConflictEventEntity[]> => []);
const mockBackfillEvents = vi.fn(async (): Promise<ConflictEventEntity[]> => []);

// LLM pipeline mock functions
const mockIsLLMConfigured = vi.fn((): boolean => false);
const mockGroupGdeltRows = vi.fn(() => []);
const mockGeocodeEnrichedEvents = vi.fn(async () => []);

// Phase 27.4 Plan 08 — runEval (eval harness) + processEventGroupsV3 (replay).
// Phase 29 D-02 part C — v3 extractor replaces the v2 mock (v2 module deleted).
const mockRunEval = vi.fn(async () => ({
  within5km: 0,
  within20km: 0,
  within100km: 0,
  total: 0,
}));
const mockProcessEventGroupsV3 = vi.fn(async () => ({
  events: [],
  matchedNewsByGroup: new Map(),
  bellingcatByGroup: new Map(),
}));

// LLM progress mock — mutable singleton object for test manipulation
const mockLlmProgress = {
  stage: 'idle' as string,
  startedAt: null as number | null,
  completedAt: null as number | null,
  totalGroups: 0,
  newGroups: 0,
  totalBatches: 0,
  completedBatches: 0,
  totalGeocodes: 0,
  completedGeocodes: 0,
  enrichedCount: 0,
  errorMessage: null as string | null,
  durationMs: null as number | null,
};
vi.mock('../../lib/llmProgress.js', () => ({
  llmProgress: mockLlmProgress,
  resetProgress: vi.fn(),
  updateProgress: vi.fn(),
  buildSummary: vi.fn(() => ({
    lastRun: Date.now(),
    groupCount: 0,
    batchCount: 0,
    geocodeCount: 0,
    enrichedCount: 0,
    durationMs: 0,
    error: null,
  })),
  INITIAL_PROGRESS: {
    stage: 'idle',
    startedAt: null,
    completedAt: null,
    totalGroups: 0,
    newGroups: 0,
    totalBatches: 0,
    completedBatches: 0,
    totalGeocodes: 0,
    completedGeocodes: 0,
    enrichedCount: 0,
    errorMessage: null,
    durationMs: null,
  },
}));

// Mock rate limiter -- pass through for route tests
const _passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
vi.mock('../../middleware/rateLimit.js', () => ({
  rateLimiters: {
    flights: _passThrough,
    ships: _passThrough,
    events: _passThrough,
    news: _passThrough,
    markets: _passThrough,
    weather: _passThrough,
    sites: _passThrough,
    sources: _passThrough,
    geocode: _passThrough,
    water: _passThrough,
    public: _passThrough,
  },
}));

// Mock config (spread actual to preserve constants like WAR_START, CACHE_TTL)
vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  const mockCfg = {
    port: 0,
    corsOrigin: '*',
    opensky: { clientId: 'test-id', clientSecret: 'test-secret' },
    aisstream: { apiKey: 'test-ais-key' },
    acled: { email: 'test@example.com', password: 'test-pass' },
    newsRelevanceThreshold: 0.7,
    eventConfidenceThreshold: 0.35,
    eventMinSources: 2,
    eventCentroidPenalty: 0.7,
    eventExcludedCameo: ['180', '192'],
    bellingcatCorroborationBoost: 0.2,
  };
  return { ...actual, config: mockCfg, loadConfig: () => mockCfg, getConfig: () => mockCfg };
});

// Mock flight adapters (needed by server import chain)
vi.mock('../../adapters/opensky.js', () => ({
  fetchFlights: vi.fn(async () => []),
}));
vi.mock('../../adapters/adsb-lol.js', () => ({ fetchFlights: vi.fn(async () => []) }));

// Mock aisstream adapter (ships route uses it)
vi.mock('../../adapters/aisstream.js', () => ({
  getShips: vi.fn(() => []),
  getLastMessageTime: vi.fn(() => 0),
  connectAISStream: vi.fn(),
}));

// Mock GDELT adapter
vi.mock('../../adapters/gdelt.js', () => ({
  fetchEvents: (...args: unknown[]) => mockFetchEvents(...args),
  backfillEvents: (...args: unknown[]) => mockBackfillEvents(...args),
}));
vi.mock('../../adapters/overpass.js', () => ({ fetchSites: vi.fn(async () => []) }));
vi.mock('../../adapters/gdelt-doc.js', () => ({ fetchGdeltArticles: vi.fn(async () => []) }));
vi.mock('../../adapters/rss.js', () => ({
  fetchAllRssFeeds: vi.fn(async () => []),
  RSS_FEEDS: [],
}));
vi.mock('../../adapters/yahoo-finance.js', () => ({
  fetchMarkets: vi.fn(async () => []),
  isValidRange: vi.fn(() => true),
}));
vi.mock('../../adapters/open-meteo.js', () => ({ fetchWeather: vi.fn(async () => []) }));
vi.mock('../../adapters/nominatim.js', () => ({
  reverseGeocode: vi.fn(async () => ({ display: 'Unknown location' })),
  forwardGeocode: vi.fn(async () => null),
}));

// Mock LLM pipeline modules
vi.mock('../../adapters/llm-provider.js', () => ({
  callLLM: vi.fn(async () => null),
  isLLMConfigured: (...args: unknown[]) => mockIsLLMConfigured(...(args as [])),
}));
// Only the route's own `groupGdeltRows` call (/llm-replay) is mocked.
// `fillWithRawEvents` stays real — it groups through the module's internal
// reference — so GET /api/events is tested against the real top-up.
vi.mock('../../lib/eventGrouping.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/eventGrouping.js')>()),
  groupGdeltRows: (...args: unknown[]) => mockGroupGdeltRows(...(args as [])),
}));
// Phase 38 LLM-PURGE-01 — the `llmEventExtractor.js` stub barrel was deleted;
// both the /llm-replay endpoint AND the extraction pipeline now call the v3
// extractor directly. Mock both v3 exports so the route tests assert routing +
// response shape (and the fresh-cache "not called" guards) without dragging in
// the real LLM path. geocodeEnrichedEventsV3 returns a flat array (no tagged shape).
vi.mock('../../lib/llmEventExtractor.v3.js', () => ({
  processEventGroupsV3: (...args: unknown[]) => mockProcessEventGroupsV3(...(args as [])),
  geocodeEnrichedEventsV3: (...args: unknown[]) => mockGeocodeEnrichedEvents(...(args as [])),
}));
// Phase 27.4 Plan 08 — runEval is called inside the v2 fire-and-forget
// block. Mock it so tests can assert invocation without needing a real
// ground-truth file on disk.
vi.mock('../../lib/llmEvalHarness.js', () => ({
  runEval: (...args: unknown[]) => mockRunEval(...(args as [])),
}));
// Phase 27.4 Plan 09 — /llm-status endpoint composes the v2 observability
// payload from listDLQ + shouldPauseNewEvents. Mock both so tests can
// control the response shape without reaching Redis.
const mockListDLQ = vi.fn(async () => []);
vi.mock('../../lib/llmDLQ.js', () => ({
  listDLQ: (...args: unknown[]) => mockListDLQ(...(args as [number])),
  enqueueDLQ: vi.fn(async () => {}),
  countDLQ: vi.fn(async () => 0),
  DLQ_KEY: 'events:llm-dlq',
}));
const mockShouldPauseNewEvents = vi.fn(async () => false);
const mockPrioritizeBySeverity = vi.fn(async (groups: unknown[]) => groups);
vi.mock('../../lib/llmTokenBudget.js', () => ({
  shouldPauseNewEvents: (...args: unknown[]) => mockShouldPauseNewEvents(...(args as [])),
  prioritizeBySeverity: (...args: unknown[]) => mockPrioritizeBySeverity(...(args as [unknown[]])),
  getDailyTokens: vi.fn(async () => 0),
  incrDailyTokens: vi.fn(async () => 0),
  budgetState: vi.fn(() => 'ok' as const),
  computeSeverityScore: vi.fn(() => 0),
  DAILY_LIMITS: { cerebras: 1_000_000, groq: 200_000 } as const,
  todayKey: vi.fn((p: string) => `llm:tokens:${p}:d`),
}));
vi.mock('../../adapters/overpass-water.js', () => ({
  fetchWaterFacilities: vi.fn(async () => []),
  FACILITY_TYPE_LABELS: {
    dam: 'Dam',
    reservoir: 'Reservoir',
    desalination: 'Desalination Plant',
    treatment_plant: 'Treatment Plant',
  },
}));
vi.mock('../../adapters/open-meteo-precip.js', () => ({
  fetchPrecipitation: vi.fn(async () => []),
}));

// Mock dev file cache — prevent tests from writing fixture events to
// .dev-cache/llm-events.json, which the dev server reads on startup and
// would serve on every /api/events request until the file is deleted or
// MAX_AGE_MS (48h) elapses. Mirror of the same mock in water.test.ts.
vi.mock('../../cache/devFileCache.js', () => ({
  saveDevLLMCache: vi.fn(),
  loadDevLLMCache: vi.fn(() => null),
  // Phase 27.4 Plan 01 added v2 pair — must be included or events.ts (which
  // imports both the v1 and v2 pairs) fails module resolution with vitest's
  // strict mock check.
  saveDevLLMCacheV2: vi.fn(),
  loadDevLLMCacheV2: vi.fn(() => null),
  saveDevWaterCache: vi.fn(),
  loadDevWaterCache: vi.fn(() => null),
}));

// Mock Redis cache module with in-memory store
const mockRedisGet = vi.fn(async (key: string) => rawRedisStore.get(key) ?? null);
const mockRedisSet = vi.fn(async (key: string, value: unknown, _opts?: unknown) => {
  rawRedisStore.set(key, value);
});

const _mockCacheGet = vi.fn(
  async <T>(key: string, logicalTtlMs: number): Promise<CacheResponse<T> | null> => {
    const entry = redisStore.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    const stale = Date.now() - entry.fetchedAt > logicalTtlMs;
    return { data: entry.data, stale, lastFresh: entry.fetchedAt };
  },
);
const _mockCacheSet = vi.fn(
  async <T>(key: string, data: T, _redisTtlSec: number): Promise<void> => {
    redisStore.set(key, { data, fetchedAt: Date.now() });
  },
);
vi.mock('../../cache/redis.js', () => ({
  redis: {
    get: (...args: unknown[]) => mockRedisGet(...(args as [string])),
    set: (...args: unknown[]) => mockRedisSet(...(args as [string, unknown, unknown?])),
    ping: vi.fn(async () => 'PONG'),
    // Phase 28.2 Plan 03 — operatorAudit (sadd/scard/spop/srem/expire) +
    // replayQuota (incr/expire) primitives reach the redis client when
    // /llm-replay or /llm-pipeline fire. Provide pass-through stubs so the
    // existing replay tests continue to land on the success path; deeper
    // assertions on those primitives live in the dedicated audit/quota
    // test files (server/__tests__/routes/events.audit.test.ts,
    // server/__tests__/routes/events.replayQuota.test.ts).
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    sadd: vi.fn(async () => 1),
    scard: vi.fn(async () => 1),
    spop: vi.fn(async () => null),
    srem: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
  },
  cacheGet: _mockCacheGet,
  cacheSet: _mockCacheSet,
  cacheGetSafe: _mockCacheGet,
  cacheSetSafe: _mockCacheSet,
}));

describe('Events Route (Redis accumulator)', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    redisStore.clear();
    rawRedisStore.clear();
    mockFetchEvents.mockClear();
    mockFetchEvents.mockResolvedValue([]);
    mockBackfillEvents.mockClear();
    mockBackfillEvents.mockResolvedValue([]);
    mockRedisGet.mockClear();
    mockRedisSet.mockClear();
    // Re-wire mockRedisGet default to use rawRedisStore
    mockRedisGet.mockImplementation(async (key: string) => rawRedisStore.get(key) ?? null);

    // Reset LLM progress singleton to idle
    Object.assign(mockLlmProgress, {
      stage: 'idle',
      startedAt: null,
      completedAt: null,
      totalGroups: 0,
      newGroups: 0,
      totalBatches: 0,
      completedBatches: 0,
      totalGeocodes: 0,
      completedGeocodes: 0,
      enrichedCount: 0,
      errorMessage: null,
      durationMs: null,
    });

    // Reset LLM mocks
    mockIsLLMConfigured.mockClear();
    mockIsLLMConfigured.mockReturnValue(false);
    mockGroupGdeltRows.mockClear();
    mockGroupGdeltRows.mockReturnValue([]);
    mockGeocodeEnrichedEvents.mockClear();
    // Phase 38 LLM-PURGE-01 — geocodeEnrichedEventsV3 returns a flat array
    // (the stub barrel's tagged `{schemaVersion,events}` wrapper was deleted).
    mockGeocodeEnrichedEvents.mockResolvedValue([]);

    // Phase 27.4 Plan 08 — reset eval harness + v3 extractor mocks.
    mockRunEval.mockClear();
    mockRunEval.mockResolvedValue({
      within5km: 0,
      within20km: 0,
      within100km: 0,
      total: 0,
    });
    mockProcessEventGroupsV3.mockClear();
    mockProcessEventGroupsV3.mockResolvedValue({
      events: [],
      matchedNewsByGroup: new Map(),
      bellingcatByGroup: new Map(),
    });

    // Phase 27.4 Plan 09 — reset DLQ + token-budget mocks.
    mockListDLQ.mockClear();
    mockListDLQ.mockResolvedValue([]);
    mockShouldPauseNewEvents.mockClear();
    mockShouldPauseNewEvents.mockResolvedValue(false);
    mockPrioritizeBySeverity.mockClear();
    mockPrioritizeBySeverity.mockImplementation(async (groups: unknown[]) => groups);

    const { createApp } = await import('../../index.js');
    const app = createApp();

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(() => {
    server?.close();
  });

  it('returns fresh cached data without calling fetchEvents when cache is fresh', async () => {
    // Pre-populate Redis mock with fresh data
    redisStore.set('events:gdelt', {
      data: [eventA],
      fetchedAt: Date.now(), // fresh
    });

    const res = await fetch(`${baseUrl}/api/events`);
    const body = await res.json();

    expect(res.ok).toBe(true);
    expect(body.stale).toBe(false);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('gdelt-A');
    expect(mockFetchEvents).not.toHaveBeenCalled();
  });

  it('does not refetch GDELT on a fresh raw cache when the LLM is configured but its cache is cold', async () => {
    // Regression (2026-09): the fresh-cache gate also required `!isLLMConfigured()`,
    // so in prod (LLM configured, events:llm:v3 cold) EVERY request re-downloaded
    // GDELT and rewrote the ~700KB accumulator.
    mockIsLLMConfigured.mockReturnValue(true);
    redisStore.set('events:gdelt', {
      data: [eventA],
      fetchedAt: Date.now(), // fresh
    });

    const res = await fetch(`${baseUrl}/api/events`);
    const body = await res.json();

    expect(res.ok).toBe(true);
    expect(body.stale).toBe(false);
    expect(body.data[0].id).toBe('gdelt-A');
    expect(mockFetchEvents).not.toHaveBeenCalled();
  });

  it('calls fetchEvents on cache miss and returns merged result', async () => {
    mockFetchEvents.mockResolvedValue([eventA, eventB]);

    const res = await fetch(`${baseUrl}/api/events`);
    const body = await res.json();

    expect(res.ok).toBe(true);
    expect(mockFetchEvents).toHaveBeenCalledTimes(1);
    expect(body.stale).toBe(false);
    expect(body.data).toHaveLength(2);
  });

  it('merges fresh events with previously cached events', async () => {
    // Seed cache with event A (make it stale so route fetches)
    redisStore.set('events:gdelt', {
      data: [eventA],
      fetchedAt: Date.now() - 901_000, // past 15min TTL
    });

    // GDELT returns event B (different ID)
    mockFetchEvents.mockResolvedValue([eventB]);

    const res = await fetch(`${baseUrl}/api/events`);
    const body = await res.json();

    expect(res.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    const ids = body.data.map((e: ConflictEventEntity) => e.id);
    expect(ids).toContain('gdelt-A');
    expect(ids).toContain('gdelt-B');
  });

  it('upserts -- same event ID in fresh overwrites cached version', async () => {
    const cachedA = makeEvent({ id: 'gdelt-A', label: 'Old label' });
    redisStore.set('events:gdelt', {
      data: [cachedA],
      fetchedAt: Date.now() - 901_000, // stale
    });

    const freshA = makeEvent({ id: 'gdelt-A', label: 'New label' });
    mockFetchEvents.mockResolvedValue([freshA]);

    const res = await fetch(`${baseUrl}/api/events`);
    const body = await res.json();

    expect(res.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].label).toBe('New label');
  });

  it('prunes events with timestamp before WAR_START', async () => {
    mockFetchEvents.mockResolvedValue([eventA, eventC]);

    const res = await fetch(`${baseUrl}/api/events`);
    const body = await res.json();

    expect(res.ok).toBe(true);
    // eventC has timestamp before WAR_START, should be pruned
    const ids = body.data.map((e: ConflictEventEntity) => e.id);
    expect(ids).toContain('gdelt-A');
    expect(ids).not.toContain('gdelt-C');
  });

  it('falls back to stale cache with stale:true when fetchEvents throws', async () => {
    // Seed stale cache
    redisStore.set('events:gdelt', {
      data: [eventA],
      fetchedAt: Date.now() - 901_000, // stale
    });

    mockFetchEvents.mockRejectedValue(new Error('GDELT upstream failure'));

    const res = await fetch(`${baseUrl}/api/events`);
    const body = await res.json();

    expect(res.ok).toBe(true);
    expect(body.stale).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('gdelt-A');
  });

  it('returns 502 when fetchEvents throws and no cache exists', async () => {
    mockFetchEvents.mockRejectedValue(new Error('GDELT down'));

    const res = await fetch(`${baseUrl}/api/events`);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('UPSTREAM_FAIL');
  });

  it('POST /api/events/llm-pipeline returns 404 (route deleted Phase 29 D-02)', async () => {
    // Phase 29 Plan 04 deleted the operator pipeline-version pin endpoint
    // (set/get/clear + audit-log entry on flip). Pipeline version is now
    // fixed by env at deploy time. This regression guard ensures the route
    // stays deleted -- a future commit that re-registers it under the same
    // path will fail this assertion.
    //
    // No Bearer needed: the route is gone, so dashboardAuth never runs;
    // Express returns 404 for unmatched POSTs.
    const res = await fetch(`${baseUrl}/api/events/llm-pipeline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'v1' }),
    });
    expect(res.status).toBe(404);
  });

  // A route registered behind a NODE_ENV check is simply absent in production;
  // the probe exists to be called there.
  it('GET /api/cron/llm-probe is mounted (answers, whatever the answer, rather than 404)', async () => {
    const res = await fetch(`${baseUrl}/api/cron/llm-probe`);
    expect(res.status).not.toBe(404);
    expect([200, 401]).toContain(res.status);
  });

  it('has no module-level backfill code (no fs access, no GDELT fetch at import time)', async () => {
    // The fact we can import the module without any fs errors or GDELT calls
    // proves there are no module-level side effects.
    // fetchEvents should only be called within the route handler, not at import time.
    expect(mockFetchEvents).not.toHaveBeenCalled();
  });

  describe('Lazy backfill', () => {
    const backfillEvent1 = makeEvent({
      id: 'gdelt-BF1',
      label: 'Backfill Event 1',
      type: 'explosion',
    });
    const backfillEvent2 = makeEvent({
      id: 'gdelt-BF2',
      label: 'Backfill Event 2',
      type: 'targeted',
    });

    it('triggers backfill on cache miss and merges results into response', async () => {
      mockFetchEvents.mockResolvedValue([eventA]);
      mockBackfillEvents.mockResolvedValue([backfillEvent1, backfillEvent2]);

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(mockBackfillEvents).toHaveBeenCalledTimes(1);
      // Should have eventA from fetchEvents + 2 from backfill = 3 total
      expect(body.data).toHaveLength(3);
      const ids = body.data.map((e: ConflictEventEntity) => e.id);
      expect(ids).toContain('gdelt-A');
      expect(ids).toContain('gdelt-BF1');
      expect(ids).toContain('gdelt-BF2');
    });

    it('does NOT trigger backfill when cache is fresh', async () => {
      // Pre-populate with fresh cache
      redisStore.set('events:gdelt', {
        data: [eventA],
        fetchedAt: Date.now(), // fresh
      });

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(mockBackfillEvents).not.toHaveBeenCalled();
    });

    it('does NOT trigger backfill when cache is stale (has accumulated data)', async () => {
      // Stale cache -- has accumulated data already
      redisStore.set('events:gdelt', {
        data: [eventA],
        fetchedAt: Date.now() - 901_000, // past 15min TTL
      });
      mockFetchEvents.mockResolvedValue([eventB]);

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      // Should merge cached + fresh, but NO backfill
      expect(mockBackfillEvents).not.toHaveBeenCalled();
      expect(body.data).toHaveLength(2);
    });

    it('backfill failure is non-fatal -- returns fetchEvents data', async () => {
      mockFetchEvents.mockResolvedValue([eventA]);
      mockBackfillEvents.mockRejectedValue(new Error('GDELT master list down'));

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      // Should still have the fetchEvents data
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('gdelt-A');
    });

    it('records backfill timestamp in Redis and prevents re-trigger within cooldown', async () => {
      // First request: cache miss, triggers backfill
      mockFetchEvents.mockResolvedValue([eventA]);
      mockBackfillEvents.mockResolvedValue([backfillEvent1]);

      const res1 = await fetch(`${baseUrl}/api/events`);
      expect(res1.ok).toBe(true);
      expect(mockBackfillEvents).toHaveBeenCalledTimes(1);

      // Backfill timestamp should have been stored
      expect(mockRedisSet).toHaveBeenCalledWith(
        'events:backfill-ts',
        expect.any(Number),
        expect.objectContaining({ ex: expect.any(Number) }),
      );

      // Second request: cache miss again (clear event cache), but backfill timestamp exists
      redisStore.clear();
      mockFetchEvents.mockResolvedValue([eventB]);
      mockBackfillEvents.mockClear();

      const res2 = await fetch(`${baseUrl}/api/events`);
      expect(res2.ok).toBe(true);
      // Should NOT call backfill again because cooldown hasn't expired
      expect(mockBackfillEvents).not.toHaveBeenCalled();
    });

    it('merges backfill results using same merge-by-ID pattern (deduplication)', async () => {
      // fetchEvents and backfill return the same event ID -- should deduplicate
      const freshA = makeEvent({ id: 'gdelt-SAME', label: 'Fresh version' });
      const backfillA = makeEvent({ id: 'gdelt-SAME', label: 'Backfill version' });

      mockFetchEvents.mockResolvedValue([freshA]);
      mockBackfillEvents.mockResolvedValue([backfillA]);

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      // Only 1 event since they share the same ID
      expect(body.data).toHaveLength(1);
      // Backfill merges first, then fresh overwrites -- so fresh version wins
      expect(body.data[0].label).toBe('Fresh version');
    });
  });

  describe('Raw coordinates (dispersion is client-side)', () => {
    it('returns undispersed coordinates so client-side dispersion can dynamically adjust with filters', async () => {
      const tehranEvent1 = makeEvent({
        id: 'gdelt-DISP1',
        label: 'Tehran event 1',
        lat: 35.6892,
        lng: 51.389,
        data: {
          eventType: 'Conventional military force',
          subEventType: 'CAMEO 190',
          fatalities: 0,
          actor1: 'IRN',
          actor2: 'ISR',
          notes: '',
          source: 'https://example.com/1',
          goldsteinScale: -10,
          locationName: 'Tehran, Iran',
          cameoCode: '190',
          geoPrecision: 'centroid' as const,
          confidence: 0.8,
          actionGeoType: 3,
        },
      });
      const tehranEvent2 = makeEvent({
        id: 'gdelt-DISP2',
        label: 'Tehran event 2',
        lat: 35.6892,
        lng: 51.389,
        timestamp: Date.now() - 1000,
        data: {
          eventType: 'Aerial weapons',
          subEventType: 'CAMEO 195',
          fatalities: 0,
          actor1: 'USA',
          actor2: 'IRN',
          notes: '',
          source: 'https://example.com/2',
          goldsteinScale: -10,
          locationName: 'Tehran, Iran',
          cameoCode: '195',
          geoPrecision: 'centroid' as const,
          confidence: 0.8,
          actionGeoType: 3,
        },
      });

      mockFetchEvents.mockResolvedValue([tehranEvent1]);
      mockBackfillEvents.mockResolvedValue([tehranEvent2]);

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body.data).toHaveLength(2);

      // Server returns raw (undispersed) coordinates — dispersion is client-side
      for (const e of body.data) {
        expect(e.lat).toBe(35.6892);
        expect(e.lng).toBe(51.389);
      }
    });
  });

  describe('LLM processing integration', () => {
    const llmEvent = makeEvent({
      id: 'llm-enriched-1',
      label: 'Baghdad airstrike',
      data: {
        eventType: 'Aerial weapons',
        subEventType: 'CAMEO 195',
        fatalities: 3,
        actor1: 'USA',
        actor2: 'IRN',
        notes: '',
        source: 'https://example.com/article',
        goldsteinScale: -10,
        locationName: 'Baghdad, Iraq',
        cameoCode: '195',
        summary: 'US airstrike on Baghdad military installation',
        precision: 'city' as const,
        llmProcessed: true,
        sourceCount: 5,
        actors: ['US Air Force', 'Iranian IRGC'],
        casualties: { killed: 3, injured: 7, unknown: false },
      },
    });

    it('fresh enriched cache + cold raw cache: refreshes raw GDELT so the response can be topped up, and still serves fresh', async () => {
      redisStore.set('events:llm:v3', {
        data: [llmEvent],
        fetchedAt: Date.now(), // fresh
      });
      mockFetchEvents.mockResolvedValue([eventA]);

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body.stale).toBe(false);
      // The raw cache was cold, so it is refreshed rather than skipped...
      expect(mockFetchEvents).toHaveBeenCalledTimes(1);
      expect(redisStore.has('events:gdelt')).toBe(true);
      // ...and the enriched event is served with the uncovered raw row.
      expect(body.data.map((e: ConflictEventEntity) => e.id)).toEqual([
        'llm-enriched-1',
        'gdelt-A',
      ]);
      expect(body.data[0].data.llmProcessed).toBe(true);
      expect(mockProcessEventGroupsV3).not.toHaveBeenCalled();
    });

    it('enriched cache, no raw cache, GDELT down: serves the enriched events instead of a 502', async () => {
      // The map never goes blank: with nothing to top up from and the upstream
      // failing, the enriched cache alone is still a servable answer.
      redisStore.set('events:llm:v3', { data: [llmEvent], fetchedAt: Date.now() });
      mockFetchEvents.mockRejectedValue(new Error('GDELT down'));

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.stale).toBe(true);
      expect(body.data.map((e: { id: string }) => e.id)).toEqual(['llm-enriched-1']);
    });

    it('fresh enriched cache + fresh raw cache: served from cache with no upstream fetch', async () => {
      redisStore.set('events:llm:v3', { data: [llmEvent], fetchedAt: Date.now() });
      redisStore.set('events:gdelt', { data: [eventA], fetchedAt: Date.now() });

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body.stale).toBe(false);
      expect(body.data.map((e: ConflictEventEntity) => e.id)).toEqual([
        'llm-enriched-1',
        'gdelt-A',
      ]);
      expect(mockFetchEvents).not.toHaveBeenCalled();
      expect(mockProcessEventGroupsV3).not.toHaveBeenCalled();
    });

    it('Phase 27.4.6: /api/events does NOT trigger LLM processing even with stale cache + elapsed cooldown (cache-only path)', async () => {
      // Pre-Phase-27.4.6 this test asserted that /api/events kicked off the
      // fire-and-forget LLM pipeline. After Phase 27.4.6 the route is a pure
      // cache reader — extractions fire only via /api/cron/refresh-events
      // (server/routes/refresh-events-cron.ts → runRefreshExtraction). Asserting
      // the inverse here documents the contract change so any future
      // contributor who re-introduces fire-and-forget here gets caught by
      // CI before merging (anti-pattern #17).
      mockIsLLMConfigured.mockReturnValue(true);
      mockFetchEvents.mockResolvedValue([eventA]);
      mockGroupGdeltRows.mockReturnValue([
        {
          key: 'grp-1',
          entities: [eventA],
          centroidLat: 33.3,
          centroidLng: 44.4,
          primaryCameo: '195',
          timestamp: Date.now(),
          totalMentions: 10,
          totalSources: 3,
          sourceUrls: [],
        },
      ]);

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      // The route still serves data (raw GDELT bridge) so the map never
      // goes blank.
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      // CRITICAL: extractor + geocoder MUST NOT be invoked from the read path.
      expect(mockProcessEventGroupsV3).not.toHaveBeenCalled();
      expect(mockGeocodeEnrichedEvents).not.toHaveBeenCalled();
    });

    it('a stale enriched cache is still served, flagged stale, and never re-extracted on the read path', async () => {
      mockIsLLMConfigured.mockReturnValue(true);
      mockFetchEvents.mockResolvedValue([eventA]);
      redisStore.set('events:llm:v3', {
        data: [llmEvent],
        fetchedAt: Date.now() - 901_000, // stale
      });

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body.stale).toBe(true);
      expect(body.data.map((e: ConflictEventEntity) => e.id)).toEqual([
        'llm-enriched-1',
        'gdelt-A',
      ]);
      expect(mockProcessEventGroupsV3).not.toHaveBeenCalled();
      expect(mockGeocodeEnrichedEvents).not.toHaveBeenCalled();
    });

    it('falls back to raw GDELT when LLM processing fails (returns null)', async () => {
      mockIsLLMConfigured.mockReturnValue(true);
      mockFetchEvents.mockResolvedValue([eventA, eventB]);
      mockGroupGdeltRows.mockReturnValue([
        {
          key: 'grp-1',
          entities: [eventA],
          centroidLat: 33.3,
          centroidLng: 44.4,
          primaryCameo: '195',
          timestamp: Date.now(),
          totalMentions: 10,
          totalSources: 3,
          sourceUrls: [],
        },
      ]);
      // LLM failed — processEventGroupsV3 returns { events: null } so the
      // pipeline takes the "LLM returned null for all batches" branch.
      // Phase 38 LLM-PURGE-01 — v3-native shape (no schemaVersion wrapper).
      mockProcessEventGroupsV3.mockResolvedValue({
        events: null,
        matchedNewsByGroup: new Map(),
        bellingcatByGroup: new Map(),
      });

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      // Should serve raw GDELT events
      expect(body.data).toHaveLength(2);
      const ids = body.data.map((e: ConflictEventEntity) => e.id);
      expect(ids).toContain('gdelt-A');
      expect(ids).toContain('gdelt-B');
    });

    it('skips LLM entirely when isLLMConfigured returns false', async () => {
      mockIsLLMConfigured.mockReturnValue(false);
      mockFetchEvents.mockResolvedValue([eventA]);

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(mockProcessEventGroupsV3).not.toHaveBeenCalled();
      expect(mockGroupGdeltRows).not.toHaveBeenCalled();
    });

    it('Phase 27.4.6: /api/events does NOT stamp the cooldown key (cooldown is now owned by runRefreshExtraction in the cron path)', async () => {
      // Pre-Phase-27.4.6 the route stamped `events:llm-process-ts` BEFORE
      // spawning the fire-and-forget extraction. After Phase 27.4.6 the route
      // is cache-only — the cooldown stamp lives inside
      // server/lib/llmExtractionPipeline.ts:runRefreshExtraction(). Asserting
      // the inverse here documents the contract change.
      mockIsLLMConfigured.mockReturnValue(true);
      mockFetchEvents.mockResolvedValue([eventA]);
      mockGroupGdeltRows.mockReturnValue([
        {
          key: 'grp-1',
          entities: [eventA],
          centroidLat: 33.3,
          centroidLng: 44.4,
          primaryCameo: '195',
          timestamp: Date.now(),
          totalMentions: 10,
          totalSources: 3,
          sourceUrls: [],
        },
      ]);

      const res = await fetch(`${baseUrl}/api/events`);
      expect(res.ok).toBe(true);

      // /api/events MUST NOT touch the cooldown key. (The dev-file-cache
      // hydration path may stamp it when seeding from disk — that's fine
      // and also goes through the same key — but no extraction-related
      // stamping happens on the read path.)
      const cooldownStamp = mockRedisSet.mock.calls.find(
        (call) => call[0] === 'events:llm-process-ts',
      );
      // Either no stamp at all, OR only the dev-file-cache stamp (which fires
      // when devData is available — this test doesn't seed dev cache so it
      // should be undefined).
      expect(cooldownStamp).toBeUndefined();
    });

    it('Phase 27.4.6: stale LLM cache is served as-is — read path never re-extracts', async () => {
      // Pre-Phase-27.4.6 the read path diffed cached groups against fresh
      // GDELT and re-extracted any new groups. After 27.4.6 that lives in the
      // cron-driven helper. The route still serves whatever is cached so the
      // map never goes blank — assert that here.
      mockIsLLMConfigured.mockReturnValue(true);

      redisStore.set('events:llm', {
        data: [llmEvent],
        fetchedAt: Date.now() - 901_000, // stale
      });

      const newEvent = makeEvent({ id: 'gdelt-NEW', label: 'New event' });
      mockFetchEvents.mockResolvedValue([eventA, newEvent]);

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      // CRITICAL: the route must NOT trigger extraction.
      expect(mockProcessEventGroupsV3).not.toHaveBeenCalled();
    });
  });

  // The pipeline fills `events:llm:v3` a wave at a time over several runs.
  // Serving the enriched cache alone would shrink the map to the first wave,
  // so the route tops it up with the raw rows of every group that has no
  // enriched event yet — and only those: a covered group's raw rows would
  // draw the same event twice.
  describe('enriched cache topped up with the raw rows of uncovered groups', () => {
    const now = Date.now();
    const raw = (id: string, overrides: Partial<ConflictEventEntity> = {}) =>
      makeEvent({ id, timestamp: now, ...overrides });
    // Covered group: two Baghdad rows, same day, same CAMEO root, ~7 km apart.
    const baghdad1 = raw('gdelt-101');
    const baghdad2 = raw('gdelt-102', {
      lat: 33.35,
      lng: 44.45,
      data: { ...makeEvent().data, actor1: 'ISR', source: 'https://example.com/other' },
    });
    // Uncovered groups: a Tehran row (too far to merge) and a Baghdad row the day before.
    const tehran = raw('gdelt-201', { lat: 35.7, lng: 51.4 });
    const dayBefore = raw('gdelt-301', { timestamp: now - 86_400_000 });
    const rawCorpus = [baghdad1, baghdad2, tehran, dayBefore];

    /** Enriched entity for the group that holds `memberId`, keyed the way the pipeline keys it. */
    async function enrichedFor(memberId: string): Promise<ConflictEventEntity> {
      const real = await vi.importActual<typeof import('../../lib/eventGrouping.js')>(
        '../../lib/eventGrouping.js',
      );
      const group = real
        .groupGdeltRows(real.dedupHighConfidence(rawCorpus))
        .find((g) => g.entities.some((e) => e.id === memberId));
      if (!group) throw new Error(`no group holds ${memberId}`);
      return makeEvent({
        id: real.enrichedIdForGroup(group.key),
        timestamp: now,
        label: 'Baghdad: enriched',
        data: { ...makeEvent().data, llmProcessed: true, summary: 'enriched' },
      });
    }

    const ids = (body: { data: ConflictEventEntity[] }) => body.data.map((e) => e.id).sort();

    function expectNoExtraction() {
      expect(mockProcessEventGroupsV3).not.toHaveBeenCalled();
      expect(mockGeocodeEnrichedEvents).not.toHaveBeenCalled();
      expect(mockRunEval).not.toHaveBeenCalled();
    }

    it('the fixture groups as intended: both Baghdad rows share one group', async () => {
      const real = await vi.importActual<typeof import('../../lib/eventGrouping.js')>(
        '../../lib/eventGrouping.js',
      );
      const groups = real.groupGdeltRows(real.dedupHighConfidence(rawCorpus));
      const members = groups.map((g) => g.entities.map((e) => e.id).sort()).sort();
      expect(members).toEqual([['gdelt-101', 'gdelt-102'], ['gdelt-201'], ['gdelt-301']]);
    });

    it('fresh partial enriched cache + fresh raw cache: enriched events plus only the uncovered raw rows', async () => {
      const enriched = await enrichedFor('gdelt-101');
      redisStore.set('events:llm:v3', { data: [enriched], fetchedAt: Date.now() });
      redisStore.set('events:gdelt', { data: rawCorpus, fetchedAt: Date.now() });

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body.stale).toBe(false);
      expect(ids(body)).toEqual([enriched.id, 'gdelt-201', 'gdelt-301'].sort());
      // The covered group's raw rows are gone — they would draw the event twice.
      expect(ids(body)).not.toContain('gdelt-101');
      expect(ids(body)).not.toContain('gdelt-102');
      expect(mockFetchEvents).not.toHaveBeenCalled();
      expectNoExtraction();
    });

    it('stale partial enriched cache + fresh raw cache: same top-up, flagged stale', async () => {
      const enriched = await enrichedFor('gdelt-101');
      redisStore.set('events:llm:v3', { data: [enriched], fetchedAt: Date.now() - 901_000 });
      redisStore.set('events:gdelt', { data: rawCorpus, fetchedAt: Date.now() });

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(body.stale).toBe(true);
      expect(ids(body)).toEqual([enriched.id, 'gdelt-201', 'gdelt-301'].sort());
      expect(mockFetchEvents).not.toHaveBeenCalled();
      expectNoExtraction();
    });

    it('enriched cache + cold raw cache: still serves, topped up from the refreshed raw rows', async () => {
      const enriched = await enrichedFor('gdelt-101');
      redisStore.set('events:llm:v3', { data: [enriched], fetchedAt: Date.now() });
      mockFetchEvents.mockResolvedValue(rawCorpus);

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body.stale).toBe(false);
      expect(mockFetchEvents).toHaveBeenCalledTimes(1);
      expect(ids(body)).toEqual([enriched.id, 'gdelt-201', 'gdelt-301'].sort());
      expectNoExtraction();
    });

    it('GDELT down with a stale raw cache: the enriched events plus the uncovered stale raw rows, flagged stale', async () => {
      const enriched = await enrichedFor('gdelt-101');
      redisStore.set('events:llm:v3', { data: [enriched], fetchedAt: Date.now() });
      redisStore.set('events:gdelt', { data: rawCorpus, fetchedAt: Date.now() - 3_600_000 * 24 });
      mockFetchEvents.mockRejectedValue(new Error('gdelt down'));

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body.stale).toBe(true);
      expect(ids(body)).toEqual([enriched.id, 'gdelt-201', 'gdelt-301'].sort());
      expectNoExtraction();
    });

    it('an enriched cache that covers every group serves no raw rows at all', async () => {
      const all = await Promise.all(['gdelt-101', 'gdelt-201', 'gdelt-301'].map(enrichedFor));
      redisStore.set('events:llm:v3', { data: all, fetchedAt: Date.now() });
      redisStore.set('events:gdelt', { data: rawCorpus, fetchedAt: Date.now() });

      const res = await fetch(`${baseUrl}/api/events`);
      const body = await res.json();

      expect(ids(body)).toEqual(all.map((e) => e.id).sort());
      expectNoExtraction();
    });
  });

  describe('GET /api/events/llm-status', () => {
    it('returns idle with null lastRun when no pipeline has run and no Redis summary', async () => {
      const res = await fetch(`${baseUrl}/api/events/llm-status`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body.stage).toBe('idle');
      expect(body.lastRun).toBeNull();
    });

    it('returns live progress object when pipeline is active (non-idle stage)', async () => {
      // Simulate an active pipeline
      Object.assign(mockLlmProgress, {
        stage: 'llm-processing',
        startedAt: Date.now() - 2000,
        totalGroups: 50,
        newGroups: 30,
        totalBatches: 4,
        completedBatches: 2,
      });

      const res = await fetch(`${baseUrl}/api/events/llm-status`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body.stage).toBe('llm-processing');
      expect(body.totalBatches).toBe(4);
      expect(body.completedBatches).toBe(2);
    });

    it('returns Redis summary fallback when pipeline is idle and summary exists', async () => {
      const summary = {
        lastRun: Date.now() - 60000,
        groupCount: 25,
        batchCount: 4,
        geocodeCount: 20,
        enrichedCount: 20,
        durationMs: 8000,
        error: null,
      };
      redisStore.set('events:llm-summary:v3', {
        data: summary,
        fetchedAt: Date.now(),
      });

      const res = await fetch(`${baseUrl}/api/events/llm-status`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body.stage).toBe('idle');
      expect(body.lastRun).toBeDefined();
      expect(body.lastRun.groupCount).toBe(25);
      expect(body.lastRun.durationMs).toBe(8000);
    });

    it('is gated by dashboardAuth in production (was 404, now 503/401)', async () => {
      // Phase 27.4.4 Plan 02 — /llm-status moved from a NODE_ENV 404 gate to
      // the dashboardAuth Bearer-token middleware. In prod with no
      // DASHBOARD_PASSWORD set, the middleware returns 503 (auth_not_configured).
      // Production telemetry is now reachable for an authed operator.
      const originalEnv = process.env.NODE_ENV;
      const originalPwd = process.env.DASHBOARD_PASSWORD;
      process.env.NODE_ENV = 'production';
      delete process.env.DASHBOARD_PASSWORD;

      try {
        const res = await fetch(`${baseUrl}/api/events/llm-status`);
        expect(res.status).toBe(503);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toBe('auth_not_configured');
      } finally {
        process.env.NODE_ENV = originalEnv;
        if (originalPwd === undefined) delete process.env.DASHBOARD_PASSWORD;
        else process.env.DASHBOARD_PASSWORD = originalPwd;
      }
    });
  });

  describe('Phase 27.4 Plan 09 — /llm-status v2 observability extension', () => {
    it('returns dlqRecent + evalScore + tokenCounters + recentEvents + paused in dev', async () => {
      Object.assign(mockLlmProgress, {
        stage: 'idle',
        schemaVersion: 'v2',
        callHistory: [
          {
            provider: 'cerebras',
            model: 'gpt-oss-120b',
            tokensIn: 1000,
            tokensOut: 300,
            durationMs: 450,
            ok: true,
            batchSize: 8,
            timestamp: Date.now() - 10_000,
          },
        ],
        tokenCounters: { cerebras: 12345, groq: 6789 },
        dlqCount: 2,
        breakerState: { cerebras: 'ok', groq: 'ok' },
        evalScore: { within5km: 3, within20km: 8, within100km: 9, total: 10 },
        provenanceCounts: { 'nominatim-direct': 5, 'own-site-snapshot': 3 },
        suspectCount: 1,
      });
      mockListDLQ.mockResolvedValue([
        {
          id: 'group-xyz',
          reason: 'zod_fail',
          lastError: 'missing summary',
          timestamp: Date.now(),
        },
      ]);
      mockShouldPauseNewEvents.mockResolvedValue(true);

      const res = await fetch(`${baseUrl}/api/events/llm-status`);
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body.stage).toBe('idle');
      expect(body.schemaVersion).toBe('v2');
      expect(Array.isArray(body.callHistory)).toBe(true);
      expect(body.callHistory[0].provider).toBe('cerebras');
      expect(body.tokenCounters).toEqual({ cerebras: 12345, groq: 6789 });
      expect(body.dlqCount).toBe(2);
      expect(Array.isArray(body.dlqRecent)).toBe(true);
      expect(body.dlqRecent[0].reason).toBe('zod_fail');
      expect(body.breakerState).toEqual({ cerebras: 'ok', groq: 'ok' });
      expect(body.evalScore).toEqual({
        within5km: 3,
        within20km: 8,
        within100km: 9,
        total: 10,
      });
      expect(body.provenanceCounts).toEqual({
        'nominatim-direct': 5,
        'own-site-snapshot': 3,
      });
      expect(body.suspectCount).toBe(1);
      expect(Array.isArray(body.recentEvents)).toBe(true);
      expect(body.paused).toBe(true);
    });

    it('observability block stays gated in production (now 503/401, was 404)', async () => {
      // Phase 27.4.4 Plan 02 — /llm-status now uses dashboardAuth instead of
      // a flat NODE_ENV 404. The observability block (dlqRecent, evalScore,
      // recentEvents, etc.) is still inaccessible to unauthenticated callers
      // — just gated at 503/401 instead of 404. This test guards against an
      // accidental ungating.
      const originalEnv = process.env.NODE_ENV;
      const originalPwd = process.env.DASHBOARD_PASSWORD;
      process.env.NODE_ENV = 'production';
      delete process.env.DASHBOARD_PASSWORD;
      try {
        const res = await fetch(`${baseUrl}/api/events/llm-status`);
        expect(res.status).toBe(503);
      } finally {
        process.env.NODE_ENV = originalEnv;
        if (originalPwd === undefined) delete process.env.DASHBOARD_PASSWORD;
        else process.env.DASHBOARD_PASSWORD = originalPwd;
      }
    });

    it('dlqRecent falls back to [] when listDLQ throws', async () => {
      mockListDLQ.mockRejectedValueOnce(new Error('redis unreachable'));
      const res = await fetch(`${baseUrl}/api/events/llm-status`);
      const body = await res.json();
      expect(res.ok).toBe(true);
      expect(body.dlqRecent).toEqual([]);
    });

    it('paused falls back to false when shouldPauseNewEvents throws', async () => {
      mockShouldPauseNewEvents.mockRejectedValueOnce(new Error('boom'));
      const res = await fetch(`${baseUrl}/api/events/llm-status`);
      const body = await res.json();
      expect(res.ok).toBe(true);
      expect(body.paused).toBe(false);
    });
  });

  // Phase 29 D-02 part C — `LLM_PIPELINE_V2 flag` + `cache-only regardless of
  // pipeline version` describe blocks deleted. The env-flag routing surface
  // they exercised is gone alongside the v1 + v2 extractor modules; the
  // remaining v3-only behavior is covered by the cache-only assertions
  // already locked in by the `Phase 27.4 Plan 08 — eval harness + /llm-replay`
  // describe block (below) and `events-fallback.test.ts`.

  describe('Phase 29 — /api/events is cache-only (v3-only)', () => {
    it('GET /api/events does NOT call processEventGroups (cron owns extraction)', async () => {
      mockIsLLMConfigured.mockReturnValue(true);
      mockFetchEvents.mockResolvedValue([eventA]);
      mockGroupGdeltRows.mockReturnValue([
        {
          key: 'grp-v3',
          entities: [eventA],
          centroidLat: 33.3,
          centroidLng: 44.4,
          primaryCameo: '195',
          timestamp: Date.now(),
          totalMentions: 10,
          totalSources: 3,
          sourceUrls: [],
        },
      ]);

      const res = await fetch(`${baseUrl}/api/events`);
      expect(res.ok).toBe(true);
      expect(mockProcessEventGroupsV3).not.toHaveBeenCalled();
      expect(mockGeocodeEnrichedEvents).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Phase 27.4 Plan 08 — eval harness + /llm-replay dev endpoint.
  // -------------------------------------------------------------------------

  describe('Phase 27.4 Plan 08 — eval harness + /llm-replay', () => {
    // Phase 29 D-02 part C — replay path is v3-only; no env flag to clear.

    it('Phase 27.4.6: /api/events does NOT call runEval (eval now runs inside the cron path / cron-health fold)', async () => {
      // Pre-Phase-27.4.6 the fire-and-forget block in /api/events called
      // runEval after geocoding. After 27.4.6 the read path is cache-only —
      // runEval fires inside server/lib/llmExtractionPipeline.ts (via the
      // cron-driven extraction) and inside server/routes/cron-health.ts (the
      // D-09 daily drift check). Asserting the inverse here documents the
      // contract change.
      mockIsLLMConfigured.mockReturnValue(true);
      mockFetchEvents.mockResolvedValue([eventA]);
      mockGroupGdeltRows.mockReturnValue([
        {
          key: 'grp-eval',
          entities: [eventA],
          centroidLat: 33.3,
          centroidLng: 44.4,
          primaryCameo: '195',
          timestamp: Date.now(),
          totalMentions: 10,
          totalSources: 3,
          sourceUrls: [],
        },
      ]);
      mockRunEval.mockResolvedValue({
        within5km: 12,
        within20km: 18,
        within100km: 22,
        total: 25,
      });

      const res = await fetch(`${baseUrl}/api/events`);
      expect(res.ok).toBe(true);

      // Drain microtasks so any (hypothetical) fire-and-forget would have
      // had a chance to land. There should be no runEval call from this path.
      await new Promise((r) => setTimeout(r, 50));

      expect(mockRunEval).not.toHaveBeenCalled();
      expect(mockGeocodeEnrichedEvents).not.toHaveBeenCalled();
    });

    it('POST /llm-replay/:groupKey is gated by dashboardAuth in production', async () => {
      // Phase 27.4.4 Plan 02 — the prior in-handler `NODE_ENV === 'production'`
      // 404 gate has been replaced with the dashboardAuth middleware. In prod
      // an absent Bearer header now returns 503 (auth_not_configured) when
      // DASHBOARD_PASSWORD is unset, OR 401 (unauthorized) when the password
      // is set but the header is missing/wrong. The route MUST NOT be
      // unconditionally reachable in prod — that's the cutover-blocker
      // regression this test guards against.
      const originalEnv = process.env.NODE_ENV;
      const originalPwd = process.env.DASHBOARD_PASSWORD;
      process.env.NODE_ENV = 'production';
      delete process.env.DASHBOARD_PASSWORD;
      try {
        const res = await fetch(`${baseUrl}/api/events/llm-replay/grp-anything`, {
          method: 'POST',
        });
        // Empty DASHBOARD_PASSWORD → fail-closed 503.
        expect(res.status).toBe(503);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toBe('auth_not_configured');
      } finally {
        process.env.NODE_ENV = originalEnv;
        if (originalPwd === undefined) {
          delete process.env.DASHBOARD_PASSWORD;
        } else {
          process.env.DASHBOARD_PASSWORD = originalPwd;
        }
      }
    });

    it('POST /llm-replay/:groupKey returns 401 in prod when Bearer is missing/wrong', async () => {
      // Phase 27.4.4 Plan 02 — DASHBOARD_PASSWORD set; absent or mismatching
      // Bearer header returns 401.
      const originalEnv = process.env.NODE_ENV;
      const originalPwd = process.env.DASHBOARD_PASSWORD;
      process.env.NODE_ENV = 'production';
      process.env.DASHBOARD_PASSWORD = 'test-password-32-chars-long-xx';
      try {
        // 1. No header at all
        const noHeader = await fetch(`${baseUrl}/api/events/llm-replay/grp-anything`, {
          method: 'POST',
        });
        expect(noHeader.status).toBe(401);

        // 2. Wrong Bearer
        const wrong = await fetch(`${baseUrl}/api/events/llm-replay/grp-anything`, {
          method: 'POST',
          headers: { Authorization: 'Bearer wrong-password-32-chars-xxxx' },
        });
        expect(wrong.status).toBe(401);
      } finally {
        process.env.NODE_ENV = originalEnv;
        if (originalPwd === undefined) {
          delete process.env.DASHBOARD_PASSWORD;
        } else {
          process.env.DASHBOARD_PASSWORD = originalPwd;
        }
      }
    });

    it('POST /llm-replay/:groupKey returns {old, new} in dev when group exists', async () => {
      // The route is registered when NODE_ENV !== 'production'; default test
      // env satisfies that. Seed v3 LLM + GDELT caches.
      const cachedV3Event = makeEvent({
        id: 'llm-v3-grp-replay',
        label: 'Baghdad old',
      });
      redisStore.set('events:llm:v3', {
        data: [cachedV3Event],
        fetchedAt: Date.now(),
      });
      redisStore.set('events:gdelt', {
        data: [eventA],
        fetchedAt: Date.now(),
      });

      // groupGdeltRows must return a group with key === 'grp-replay'.
      mockGroupGdeltRows.mockReturnValue([
        {
          key: 'grp-replay',
          entities: [eventA],
          centroidLat: 33.3,
          centroidLng: 44.4,
          primaryCameo: '195',
          timestamp: Date.now(),
          totalMentions: 10,
          totalSources: 3,
          sourceUrls: [],
        },
      ]);

      // processEventGroupsV3 returns a fresh extraction for the replay.
      mockProcessEventGroupsV3.mockResolvedValue({
        events: [
          {
            schemaVersion: 'v3',
            groupKey: 'grp-replay',
            location: {
              country: 'Iraq',
              admin1: null,
              city: 'Baghdad',
              neighborhood: null,
              landmark: null,
              confidence: 0.9,
            },
            type: 'airstrike',
            confidence: 0.88,
            reasoning: 'Fresh extraction',
            weaponType: null,
            targetType: null,
            timeOfDay: null,
            durationMinutes: null,
            actors: ['USA'],
            severity: 'high',
            summary: 'Baghdad new',
            casualties: { killed: 1, injured: 0, unknown: false },
            sourceCount: 3,
          },
        ],
        matchedNewsByGroup: new Map(),
        bellingcatByGroup: new Map(),
      });

      const res = await fetch(`${baseUrl}/api/events/llm-replay/grp-replay`, {
        method: 'POST',
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as {
        old: { id: string; label: string };
        new: { summary: string } | null;
      };
      expect(body.old).toBeTruthy();
      expect(body.old.id).toBe('llm-v3-grp-replay');
      expect(body.new).toBeTruthy();
      expect(body.new!.summary).toBe('Baghdad new');
      // Replay must have invoked the v3 extractor.
      expect(mockProcessEventGroupsV3).toHaveBeenCalledTimes(1);
    });

    it('POST /llm-replay does NOT write to events:llm:v3 cache (T-27.4-08-05)', async () => {
      // Seed caches so the replay succeeds.
      const cachedV3Event = makeEvent({ id: 'llm-v3-grp-readonly', label: 'old' });
      redisStore.set('events:llm:v3', {
        data: [cachedV3Event],
        fetchedAt: Date.now(),
      });
      redisStore.set('events:gdelt', {
        data: [eventA],
        fetchedAt: Date.now(),
      });
      mockGroupGdeltRows.mockReturnValue([
        {
          key: 'grp-readonly',
          entities: [eventA],
          centroidLat: 33.3,
          centroidLng: 44.4,
          primaryCameo: '195',
          timestamp: Date.now(),
          totalMentions: 10,
          totalSources: 3,
          sourceUrls: [],
        },
      ]);
      mockProcessEventGroupsV3.mockResolvedValue({
        events: [
          {
            schemaVersion: 'v3',
            groupKey: 'grp-readonly',
            location: {
              country: 'Iraq',
              admin1: null,
              city: 'Baghdad',
              neighborhood: null,
              landmark: null,
              confidence: 0.9,
            },
            type: 'airstrike',
            confidence: 0.88,
            reasoning: 'r',
            weaponType: null,
            targetType: null,
            timeOfDay: null,
            durationMinutes: null,
            actors: ['USA'],
            severity: 'high',
            summary: 'new',
            casualties: { killed: 1, injured: 0, unknown: false },
            sourceCount: 3,
          },
        ],
        matchedNewsByGroup: new Map(),
        bellingcatByGroup: new Map(),
      });

      // Clear the cacheSet mock so only replay-induced writes are counted.
      _mockCacheSet.mockClear();

      const res = await fetch(`${baseUrl}/api/events/llm-replay/grp-readonly`, {
        method: 'POST',
      });
      expect(res.ok).toBe(true);

      // Pitfall 6 invariant — replay handler must NOT write to events:llm:v3.
      // Inspect every cacheSet call made during the replay and assert none
      // targeted the v3 LLM cache key.
      const cacheWriteKeys = _mockCacheSet.mock.calls.map((c) => c[0] as string);
      expect(cacheWriteKeys).not.toContain('events:llm:v3');
      // Defense-in-depth: legacy v2 + v1 LLM cache keys must also stay clean.
      expect(cacheWriteKeys).not.toContain('events:llm:v2');
      expect(cacheWriteKeys).not.toContain('events:llm');
    });
  });
});

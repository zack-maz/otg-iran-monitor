// @vitest-environment node
/**
 * `runRefreshExtraction` persists once per wave.
 *
 * A cold corpus does not fit in the 800 s function limit. With a single write
 * at the end of the run, a killed run persisted nothing and the next night
 * started cold again. The run therefore works in waves of
 * `LLM_V3_CONCURRENCY * 2 * 2` groups — extract, geocode, persist — and every
 * wave lands in `events:llm:v3` as the union of everything enriched so far.
 *
 * The write goes through `cacheSetReported`, never `cacheSetSafe`: the latter
 * swallows a failed write, and the run would report "persisted" over nothing.
 *
 * LLM_V3_CONCURRENCY is pinned to 1 (wave = 4 groups) so small fixtures span
 * several waves.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    NVIDIA_NIM_API_KEY: 'fake',
    OPENROUTER_API_KEY: '',
    LLM_BATCH_TIMEOUT_MS: 120_000,
    LLM_V3_CONCURRENCY: 1,
    V3_ADAPTIVE_BATCH: false,
    V3_LINEAGE_PREFILTER: false,
    V3_WATCHDOG_ROLLBACK_THRESHOLD: 2,
    LLM_BATCH_SIZE: 2,
    CRON_SECRET: '',
  },
}));

const LLM_KEY = 'events:llm:v3';
const SUMMARY_KEY = 'events:llm-summary:v3';

const cacheStore = new Map<string, unknown>();
const cacheSetSafeSpy = vi.fn(async (key: string, data: unknown, _ttl: number) => {
  cacheStore.set(key, data);
});
const cacheSetReportedSpy = vi.fn(async (key: string, data: unknown, _ttl: number) => {
  cacheStore.set(key, data);
  return { ok: true } as const;
});
const cacheGetSpy = vi.fn(async (key: string, _maxAgeMs: number) =>
  cacheStore.has(key) ? { data: cacheStore.get(key), fetchedAt: Date.now() } : null,
);

vi.mock('../../cache/redis.js', () => ({
  cacheGetSafe: cacheGetSpy,
  cacheSetSafe: cacheSetSafeSpy,
  cacheSetReported: cacheSetReportedSpy,
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../config.js', () => ({ env: mockEnv }));

// The run body is handed to safeWaitUntil and never awaited by the caller;
// keeping the promise lets a test wait for the run to finish.
let runPromise: Promise<unknown> = Promise.resolve();
vi.mock('../../lib/safeWaitUntil.js', () => ({
  safeWaitUntil: (p: Promise<unknown>) => {
    runPromise = p.catch(() => {});
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../adapters/llm-provider.js', () => ({
  isLLMConfigured: () => true,
  callLLM: vi.fn(),
}));

vi.mock('../../lib/llmTokenBudget.js', () => ({
  shouldPauseNewEvents: vi.fn().mockResolvedValue(false),
  prioritizeBySeverity: vi.fn(async (groups: unknown[]) => groups),
}));

vi.mock('../../cache/devFileCache.js', () => ({
  saveDevLLMCache: vi.fn(),
  saveDevLLMCacheV2: vi.fn(),
}));

vi.mock('../../lib/sourceTiers.js', () => ({
  getHighestTier: vi.fn().mockReturnValue(2),
}));

vi.mock('../../lib/llmEvalHarness.js', () => ({
  runEval: vi.fn().mockResolvedValue({ within5km: 1, within20km: 1, within100km: 1, total: 1 }),
}));

const groupGdeltRowsMock = vi.fn();
vi.mock('../../lib/eventGrouping.js', () => ({
  groupGdeltRows: groupGdeltRowsMock,
  dedupHighConfidence: vi.fn((entities: unknown[]) => entities),
  enrichedIdForGroup: (key: string) => `llm-v3-${key}`,
}));

vi.mock('../../lib/llmDLQ.js', () => ({ countDLQ: vi.fn(async () => 0) }));

vi.mock('../../lib/llmRunHistory.js', () => ({
  openRunRecord: vi.fn(async () => {}),
  closeRunRecord: vi.fn(async () => {}),
}));

// The URL-liveness post-step runs after every extraction; stubbed so these
// tests touch neither Redis nor the network.
vi.mock('../../lib/urlLiveness.js', () => ({
  buildProbeCandidates: vi.fn(async () => ({ candidates: [], classifiedNoUrl: 0 })),
  pruneDeadUrlEvents: vi.fn(async () => ({ prunedCount: 0, prunedIds: [] })),
  runProbeSweep: vi.fn(async () => ({ probed: 0, skippedBudget: 0 })),
  SWEEP_SAFETY_MARGIN_MS: 60_000,
}));

const { llmProgressSingleton } = vi.hoisted(() => ({
  llmProgressSingleton: { stage: 'idle' } as Record<string, unknown>,
}));
vi.mock('../../lib/llmProgress.js', () => ({
  updateProgress: vi.fn((patch: Record<string, unknown>) => {
    Object.assign(llmProgressSingleton, patch);
  }),
  resetProgress: vi.fn(() => {
    for (const k of Object.keys(llmProgressSingleton)) delete llmProgressSingleton[k];
    llmProgressSingleton.stage = 'grouping';
    llmProgressSingleton.startedAt = Date.now();
  }),
  llmProgress: llmProgressSingleton,
  buildSummary: vi.fn().mockReturnValue({}),
}));

function makeEnrichedV3Event(groupKey: string): Record<string, unknown> {
  return {
    schemaVersion: 'v3',
    groupKey,
    location: {
      country: 'IR',
      admin1: null,
      city: null,
      neighborhood: null,
      landmark: null,
      confidence: 0.7,
    },
    type: 'airstrike',
    confidence: 0.7,
    reasoning: 'test',
    weaponType: null,
    targetType: null,
    timeOfDay: null,
    durationMinutes: null,
    actors: [],
    severity: 'medium',
    summary: 'test summary',
    casualties: { killed: 0, injured: 0, unknown: false },
    sourceCount: 1,
  };
}

// The extractor is called once per wave with that wave's groups and returns
// one enriched event per group.
const processEventGroupsMock = vi.fn(
  async (groups: Array<{ key: string }>, onBatchComplete?: (c: number, t: number) => void) => {
    const total = Math.ceil(groups.length / 2);
    for (let c = 1; c <= total; c++) onBatchComplete?.(c, total);
    return {
      schemaVersion: 'v3' as const,
      events: groups.map((g) => makeEnrichedV3Event(g.key)),
      matchedNewsByGroup: new Map(),
      bellingcatByGroup: new Map(),
    };
  },
);

const geocodeEnrichedEventsMock = vi.fn(
  async (
    events: Array<Record<string, unknown>>,
    _groupsByKey: unknown,
    _matchedNews: unknown,
    _bellingcat: unknown,
    onProgress?: (completed: number, total: number) => void,
  ) => {
    const out = events.map((e) => ({
      ...e,
      resolvedLat: 35,
      resolvedLng: 50,
      displayName: `Test Site ${String(e.groupKey)}`,
      geocodeProvenance: 'nominatim-direct' as const,
      precision: 'city' as const,
      suspect: false,
      actionGeoDistanceKm: 0,
    }));
    onProgress?.(out.length, out.length);
    return out;
  },
);

vi.mock('../../lib/llmEventExtractor.v3.js', () => ({
  processEventGroupsV3: processEventGroupsMock,
  geocodeEnrichedEventsV3: geocodeEnrichedEventsMock,
}));

function makeRawEntity(id: string) {
  return {
    id,
    type: 'airstrike',
    lat: 35,
    lng: 50,
    timestamp: Date.UTC(2026, 3, 15),
    label: 't',
    data: { eventType: 'Aerial weapons', cameoCode: '195', numMentions: 5, numSources: 2 },
  };
}

function makeGroup(key: string) {
  return {
    key,
    entities: [makeRawEntity(`raw-${key}`)],
    centroidLat: 35,
    centroidLng: 50,
    primaryCameo: '195',
    timestamp: Date.UTC(2026, 3, 15),
    totalMentions: 5,
    totalSources: 2,
    sourceUrls: ['https://example.com'],
  };
}

/** Run one extraction over `numGroups` single-entity groups (g1..gN) to the end. */
async function driveRun(numGroups: number) {
  const keys = Array.from({ length: numGroups }, (_, i) => `g${i + 1}`);
  cacheStore.set(
    'events:gdelt',
    keys.map((k) => makeRawEntity(`raw-${k}`)),
  );
  groupGdeltRowsMock.mockReturnValue(keys.map(makeGroup));

  const { runRefreshExtraction } = await import('../../lib/llmExtractionPipeline.js');
  const result = await runRefreshExtraction({ triggeredBy: 'cron', forceCooldown: true });
  await runPromise;
  return result;
}

/** Entity ids of each `events:llm:v3` write, in write order. */
function llmWrites(): string[][] {
  return cacheSetReportedSpy.mock.calls
    .filter(([k]) => k === LLM_KEY)
    .map(([, data]) => (data as Array<{ id: string }>).map((e) => e.id));
}

const idsFor = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `llm-v3-g${from + i}`);

beforeEach(() => {
  cacheStore.clear();
  cacheSetSafeSpy.mockClear();
  cacheSetReportedSpy.mockClear();
  cacheGetSpy.mockClear();
  processEventGroupsMock.mockClear();
  geocodeEnrichedEventsMock.mockClear();
  groupGdeltRowsMock.mockClear();
  for (const k of Object.keys(llmProgressSingleton)) delete llmProgressSingleton[k];
  llmProgressSingleton.stage = 'idle';
  mockEnv.LLM_V3_CONCURRENCY = 1;
  runPromise = Promise.resolve();
});

describe('runRefreshExtraction — one write per wave, so a killed run keeps its finished waves', () => {
  it('a run spanning three waves writes three times, each write the union so far', async () => {
    await driveRun(12);

    expect(llmWrites()).toEqual([idsFor(1, 4), idsFor(1, 8), idsFor(1, 12)]);
    expect(cacheStore.get(LLM_KEY)).toHaveLength(12);
  });

  it('a short last wave is still persisted', async () => {
    await driveRun(5);

    expect(llmWrites()).toEqual([idsFor(1, 4), idsFor(1, 5)]);
  });

  it('a run that fits in one wave writes once', async () => {
    await driveRun(3);

    expect(llmWrites()).toEqual([idsFor(1, 3)]);
  });

  it('each wave is extracted and geocoded on its own groups only', async () => {
    await driveRun(6);

    const extracted = processEventGroupsMock.mock.calls.map(([groups]) => groups.map((g) => g.key));
    expect(extracted).toEqual([
      ['g1', 'g2', 'g3', 'g4'],
      ['g5', 'g6'],
    ]);
    const geocoded = geocodeEnrichedEventsMock.mock.calls.map(([events]) =>
      events.map((e) => e.groupKey),
    );
    expect(geocoded).toEqual(extracted);
  });

  it('the wave holds LLM_V3_CONCURRENCY * 4 groups, so concurrency 2 covers 12 groups in two waves', async () => {
    mockEnv.LLM_V3_CONCURRENCY = 2;
    await driveRun(12);

    expect(llmWrites()).toEqual([idsFor(1, 8), idsFor(1, 12)]);
  });

  it('entities already in the cache are carried into every write', async () => {
    const earlier = { ...makeRawEntity('llm-v3-earlier'), data: { llmProcessed: true } };
    cacheStore.set(LLM_KEY, [earlier]);
    await driveRun(5);

    for (const ids of llmWrites()) expect(ids).toContain('llm-v3-earlier');
    expect(cacheStore.get(LLM_KEY)).toHaveLength(6);
  });
});

describe('runRefreshExtraction — the enriched cache is written where a failure is visible', () => {
  it('events:llm:v3 goes through cacheSetReported and never through cacheSetSafe', async () => {
    await driveRun(8);

    expect(llmWrites()).toHaveLength(2);
    expect(cacheSetSafeSpy.mock.calls.filter(([k]) => k === LLM_KEY)).toHaveLength(0);
  });

  it('the run summary is still written best-effort through cacheSetSafe', async () => {
    await driveRun(8);

    expect(cacheSetSafeSpy.mock.calls.filter(([k]) => k === SUMMARY_KEY)).toHaveLength(1);
  });

  it('every write uses LLM_TERMINAL_TTL_SEC, so no wave shortens the 48 h cache', async () => {
    const { LLM_TERMINAL_TTL_SEC } = await import('../../lib/llmExtractionPipeline.js');
    await driveRun(12);

    const ttls = cacheSetReportedSpy.mock.calls.filter(([k]) => k === LLM_KEY).map(([, , t]) => t);
    expect(ttls).toEqual([LLM_TERMINAL_TTL_SEC, LLM_TERMINAL_TTL_SEC, LLM_TERMINAL_TTL_SEC]);
  });
});

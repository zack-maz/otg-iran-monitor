// @vitest-environment node
/**
 * A run that is cut short keeps its finished waves, and the next run resumes.
 *
 * Vercel kills the function at 800 s and a cold corpus needs more than that.
 * Every wave is persisted to `events:llm:v3` as it finishes, and a run only
 * sends the extractor the groups whose `llm-v3-<group key>` id is not in the
 * cache yet — so the corpus fills over consecutive runs instead of starting
 * cold every night.
 *
 * LLM_V3_CONCURRENCY is pinned to 1 (wave = 4 groups).
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

// The extractor is called once per wave. `killAtWave` makes that wave throw,
// which ends the run body the way a function kill would: nothing after the
// throw runs, earlier waves have already been handed to geocode + persist.
let killAtWave: number | null = null;
let waveCalls = 0;
const processEventGroupsMock = vi.fn(
  async (groups: Array<{ key: string }>, onBatchComplete?: (c: number, t: number) => void) => {
    waveCalls++;
    if (killAtWave !== null && waveCalls >= killAtWave) throw new Error('SIMULATED_FUNCTION_KILL');
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

async function driveRun(numGroups: number, opts: { killAtWave?: number } = {}) {
  killAtWave = opts.killAtWave ?? null;
  waveCalls = 0;
  const keys = Array.from({ length: numGroups }, (_, i) => `g${i + 1}`);
  cacheStore.set(
    'events:gdelt',
    keys.map((k) => makeRawEntity(`raw-${k}`)),
  );
  groupGdeltRowsMock.mockReturnValue(keys.map(makeGroup));

  const { runRefreshExtraction } = await import('../../lib/llmExtractionPipeline.js');
  await runRefreshExtraction({ triggeredBy: 'cron', forceCooldown: true });
  await runPromise;
  // When a wave throws, the previous wave's geocode + persist is still in
  // flight and nothing in the run body awaits it; give it a turn to land.
  await new Promise((resolve) => setImmediate(resolve));
}

const cachedIds = () =>
  ((cacheStore.get(LLM_KEY) as Array<{ id: string }> | undefined) ?? []).map((e) => e.id).sort();

const sortById = <T extends { id: string }>(arr: T[]): T[] =>
  [...arr].sort((a, b) => a.id.localeCompare(b.id));

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
  runPromise = Promise.resolve();
});

describe('runRefreshExtraction — a run cut short keeps its finished waves and the next run resumes', () => {
  it('a run killed in its second wave leaves the first wave in events:llm:v3', async () => {
    await driveRun(10, { killAtWave: 2 });

    expect(cachedIds()).toEqual(['llm-v3-g1', 'llm-v3-g2', 'llm-v3-g3', 'llm-v3-g4']);
  });

  it('the next run sends the extractor only the groups missing from the cache', async () => {
    await driveRun(10, { killAtWave: 2 });
    processEventGroupsMock.mockClear();

    await driveRun(10);

    const extracted = processEventGroupsMock.mock.calls.map(([groups]) => groups.map((g) => g.key));
    expect(extracted).toEqual([
      ['g5', 'g6', 'g7', 'g8'],
      ['g9', 'g10'],
    ]);
  });

  it('a killed run plus its follow-up end with the same cache as one uninterrupted run', async () => {
    await driveRun(10, { killAtWave: 2 });
    await driveRun(10);
    const resumed = sortById(cacheStore.get(LLM_KEY) as Array<{ id: string }>);

    cacheStore.clear();
    await driveRun(10);
    const uninterrupted = sortById(cacheStore.get(LLM_KEY) as Array<{ id: string }>);

    expect(resumed).toHaveLength(10);
    expect(resumed).toEqual(uninterrupted);
  });

  it('a run with nothing left to enrich calls neither the extractor nor the cache write', async () => {
    await driveRun(6);
    processEventGroupsMock.mockClear();
    cacheSetReportedSpy.mockClear();

    await driveRun(6);

    expect(processEventGroupsMock).not.toHaveBeenCalled();
    expect(cacheSetReportedSpy).not.toHaveBeenCalled();
    expect(llmProgressSingleton.stage).toBe('done');
  });
});

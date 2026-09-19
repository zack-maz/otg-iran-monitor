// @vitest-environment node
/**
 * What `events:llm:v3` holds, and how often the eval harness runs.
 *
 *  1. Every write to `events:llm:v3` is a bare `ConflictEventEntity[]`.
 *     `/api/events` and the dead-URL prune read the key as an array; an
 *     envelope (`{ progress, complete, generatedAt, ... }`) would blank the map.
 *  2. `runEval()` runs once per run, however many waves the run takes. It is a
 *     measurement that spends LLM quota; once per wave would multiply it.
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

const runEvalSpy = vi
  .fn()
  .mockResolvedValue({ within5km: 1, within20km: 1, within100km: 1, total: 1 });
vi.mock('../../lib/llmEvalHarness.js', () => ({ runEval: runEvalSpy }));

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

async function driveRun(numGroups: number) {
  const keys = Array.from({ length: numGroups }, (_, i) => `g${i + 1}`);
  cacheStore.set(
    'events:gdelt',
    keys.map((k) => makeRawEntity(`raw-${k}`)),
  );
  groupGdeltRowsMock.mockReturnValue(keys.map(makeGroup));

  const { runRefreshExtraction } = await import('../../lib/llmExtractionPipeline.js');
  await runRefreshExtraction({ triggeredBy: 'cron', forceCooldown: true });
  await runPromise;
}

beforeEach(() => {
  cacheStore.clear();
  cacheSetSafeSpy.mockClear();
  cacheSetReportedSpy.mockClear();
  cacheGetSpy.mockClear();
  processEventGroupsMock.mockClear();
  geocodeEnrichedEventsMock.mockClear();
  groupGdeltRowsMock.mockClear();
  runEvalSpy.mockClear();
  for (const k of Object.keys(llmProgressSingleton)) delete llmProgressSingleton[k];
  llmProgressSingleton.stage = 'idle';
  runPromise = Promise.resolve();
});

describe('runRefreshExtraction — events:llm:v3 holds a bare ConflictEventEntity[]', () => {
  it('every wave writes an array of entities, never a progress envelope', async () => {
    await driveRun(12);

    const writes = cacheSetReportedSpy.mock.calls.filter(([k]) => k === LLM_KEY);
    expect(writes).toHaveLength(3);
    for (const [, data] of writes) {
      expect(Array.isArray(data)).toBe(true);
      const entities = data as Array<Record<string, unknown>>;
      expect(entities.length).toBeGreaterThan(0);
      for (const entity of entities) {
        expect(entity.id).toMatch(/^llm-v3-g\d+$/);
        expect(typeof entity.lat).toBe('number');
        expect(typeof entity.lng).toBe('number');
        expect(entity.type).toBe('airstrike');
        expect(entity).not.toHaveProperty('progress');
        expect(entity).not.toHaveProperty('complete');
        expect(entity).not.toHaveProperty('generatedAt');
      }
    }
  });

  it('an entity carries the enrichment and the geocode provenance', async () => {
    await driveRun(1);

    const [entity] = cacheStore.get(LLM_KEY) as Array<{ data: Record<string, unknown> }>;
    expect(entity?.data).toMatchObject({
      llmProcessed: true,
      summary: 'test summary',
      precision: 'city',
      geocodeProvenance: 'nominatim-direct',
    });
  });
});

describe('runRefreshExtraction — the eval harness is a once-per-run measurement', () => {
  it('a three-wave run calls runEval once, not once per wave', async () => {
    await driveRun(12);

    expect(processEventGroupsMock).toHaveBeenCalledTimes(3);
    expect(runEvalSpy).toHaveBeenCalledTimes(1);
  });
});

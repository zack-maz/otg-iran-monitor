// @vitest-environment node
/**
 * How a wave-based `runRefreshExtraction` run ends.
 *
 *  - A wave that yields nothing does not undo the waves before it.
 *  - A provider answer no retry can fix (`fatalStatus`: 401/403/404/410) stops
 *    the run and is named in `errorMessage` — a retired model used to grind
 *    through every batch and end as an anonymous "null for all batches".
 *  - A run that persisted nothing ends `error`, including when the extraction
 *    worked and every cache write failed.
 *  - Time budgets, measured from the start of the cron request: no new LLM
 *    wave after 480 s, geocoding stops at 660 s, and the eval harness runs
 *    after the last write and only if the run is under 540 s — it is a
 *    measurement and must not stand between the data and the 800 s kill.
 *
 * LLM_V3_CONCURRENCY is pinned to 1 (wave = 4 groups).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
// Order of the side effects that matter, across one run.
const timeline: string[] = [];

// Result of each `cacheSetReported` call, in order; a missing entry succeeds.
let writeResults: Array<{ ok: true } | { ok: false; error: string }> = [];
const cacheSetReportedSpy = vi.fn(async (key: string, data: unknown, _ttl: number) => {
  const result = writeResults.shift() ?? ({ ok: true } as const);
  if (result.ok) cacheStore.set(key, data);
  timeline.push(`write:${(data as unknown[]).length}${result.ok ? '' : ':failed'}`);
  return result;
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

const runEvalSpy = vi.fn(async () => {
  timeline.push('eval');
  return { within5km: 1, within20km: 1, within100km: 1, total: 1 };
});
vi.mock('../../lib/llmEvalHarness.js', () => ({ runEval: runEvalSpy }));

const groupGdeltRowsMock = vi.fn();
vi.mock('../../lib/eventGrouping.js', () => ({
  groupGdeltRows: groupGdeltRowsMock,
  dedupHighConfidence: vi.fn((entities: unknown[]) => entities),
  enrichedIdForGroup: (key: string) => `llm-v3-${key}`,
}));

vi.mock('../../lib/llmDLQ.js', () => ({ countDLQ: vi.fn(async () => 0) }));

const closeRunRecordMock = vi.fn(async (_entry: { outcome: string }) => {
  timeline.push('close');
});
vi.mock('../../lib/llmRunHistory.js', () => ({
  openRunRecord: vi.fn(async () => {}),
  closeRunRecord: closeRunRecordMock,
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

// One step per extractor call (= per wave); a missing step enriches every group.
interface WaveStep {
  /** The extractor's "every batch failed" answer. */
  nullEvents?: boolean;
  fatalStatus?: number;
  throws?: string;
  /** Wall-clock time the wave takes (needs the faked Date). */
  takesMs?: number;
}
let waveScript: WaveStep[] = [];
let waveIndex = 0;
const processEventGroupsMock = vi.fn(
  async (groups: Array<{ key: string }>, onBatchComplete?: (c: number, t: number) => void) => {
    const step = waveScript[waveIndex++] ?? {};
    if (step.takesMs) vi.setSystemTime(Date.now() + step.takesMs);
    if (step.throws) throw new Error(step.throws);
    const total = Math.ceil(groups.length / 2);
    for (let c = 1; c <= total; c++) onBatchComplete?.(c, total);
    return {
      schemaVersion: 'v3' as const,
      events: step.nullEvents ? null : groups.map((g) => makeEnrichedV3Event(g.key)),
      matchedNewsByGroup: new Map(),
      bellingcatByGroup: new Map(),
      fatalStatus: step.fatalStatus,
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
    _opts?: { deadlineMs?: number },
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

async function driveRun(numGroups: number, script: WaveStep[] = []) {
  waveScript = script;
  waveIndex = 0;
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
  ((cacheStore.get(LLM_KEY) as Array<{ id: string }> | undefined) ?? []).map((e) => e.id);

const idsFor = (...ranges: Array<[number, number]>) =>
  ranges.flatMap(([from, to]) =>
    Array.from({ length: to - from + 1 }, (_, i) => `llm-v3-g${from + i}`),
  );

/** Outcome of the run record handed to closeRunRecord. */
function closedOutcome(): string {
  expect(closeRunRecordMock).toHaveBeenCalledTimes(1);
  return closeRunRecordMock.mock.calls[0]![0].outcome;
}

const T0 = Date.UTC(2026, 8, 19, 4, 0, 0);

beforeEach(() => {
  // Only Date is faked: the run's budgets read Date.now(), while the mocks
  // resolve on real microtasks.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  cacheStore.clear();
  timeline.length = 0;
  writeResults = [];
  cacheSetSafeSpy.mockClear();
  cacheSetReportedSpy.mockClear();
  cacheGetSpy.mockClear();
  processEventGroupsMock.mockClear();
  geocodeEnrichedEventsMock.mockClear();
  groupGdeltRowsMock.mockClear();
  runEvalSpy.mockClear();
  closeRunRecordMock.mockClear();
  for (const k of Object.keys(llmProgressSingleton)) delete llmProgressSingleton[k];
  llmProgressSingleton.stage = 'idle';
  runPromise = Promise.resolve();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runRefreshExtraction — a wave that yields nothing does not undo earlier waves', () => {
  it('a null second wave: waves one and three are persisted and the run ends completed', async () => {
    await driveRun(12, [{}, { nullEvents: true }, {}]);

    expect(timeline.filter((t) => t.startsWith('write'))).toEqual(['write:4', 'write:8']);
    expect(cachedIds()).toEqual(idsFor([1, 4], [9, 12]));
    expect(closedOutcome()).toBe('completed');
    expect(llmProgressSingleton.stage).toBe('done');
  });

  it('a second wave that throws: the first wave stays in the cache, the run is completed and names what it lost', async () => {
    await driveRun(12, [{}, { throws: 'extractor exploded' }]);

    expect(cachedIds()).toEqual(idsFor([1, 4]));
    expect(processEventGroupsMock).toHaveBeenCalledTimes(2);
    expect(closeRunRecordMock).toHaveBeenCalledTimes(1);
    // Something was persisted, so the run is `completed`; the lost wave is
    // reported rather than hidden.
    expect(closedOutcome()).toBe('completed');
    expect(llmProgressSingleton.errorMessage).toBe('partial: extractor exploded');
  });

  it('a first wave that throws: nothing persisted, the run ends error with the cause', async () => {
    await driveRun(12, [{ throws: 'extractor exploded' }]);

    expect(cacheSetReportedSpy).not.toHaveBeenCalled();
    expect(closedOutcome()).toBe('error');
    expect(llmProgressSingleton.errorMessage).toBe('extractor exploded');
  });

  it('every wave null: nothing is written and the run ends error', async () => {
    await driveRun(8, [{ nullEvents: true }, { nullEvents: true }]);

    expect(cacheSetReportedSpy).not.toHaveBeenCalled();
    expect(closedOutcome()).toBe('error');
    expect(llmProgressSingleton.errorMessage).toBe('LLM returned null for all batches');
    expect(runEvalSpy).not.toHaveBeenCalled();
  });
});

describe('runRefreshExtraction — a provider answer no retry can fix stops the run and is named', () => {
  it('HTTP 410 in the second wave: no third wave, outcome error, status in errorMessage, wave one kept', async () => {
    await driveRun(12, [{}, { nullEvents: true, fatalStatus: 410 }, {}]);

    expect(processEventGroupsMock).toHaveBeenCalledTimes(2);
    expect(closedOutcome()).toBe('error');
    expect(llmProgressSingleton.stage).toBe('error');
    expect(llmProgressSingleton.errorMessage).toContain('HTTP 410');
    expect(llmProgressSingleton.errorMessage).toContain('retired');
    expect(cachedIds()).toEqual(idsFor([1, 4]));
    expect(runEvalSpy).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'key was rejected'],
    [403, 'key was rejected'],
    [404, 'not served to this key'],
  ])('HTTP %i in the first wave: nothing written, errorMessage says "%s"', async (status, hint) => {
    await driveRun(12, [{ nullEvents: true, fatalStatus: status }]);

    expect(processEventGroupsMock).toHaveBeenCalledTimes(1);
    expect(cacheSetReportedSpy).not.toHaveBeenCalled();
    expect(closedOutcome()).toBe('error');
    expect(llmProgressSingleton.errorMessage).toContain(`HTTP ${status}`);
    expect(llmProgressSingleton.errorMessage).toContain(hint);
  });
});

describe('runRefreshExtraction — a write that did not land is not reported as persisted', () => {
  it('every wave write fails: the run ends error and carries the write error', async () => {
    writeResults = [
      { ok: false, error: 'cacheSet(events:llm:v3) timed out after 20000ms' },
      { ok: false, error: 'cacheSet(events:llm:v3) timed out after 20000ms' },
    ];
    await driveRun(8);

    expect(timeline.filter((t) => t.startsWith('write'))).toEqual([
      'write:4:failed',
      'write:8:failed',
    ]);
    expect(closedOutcome()).toBe('error');
    expect(llmProgressSingleton.stage).toBe('error');
    expect(llmProgressSingleton.errorMessage).toContain('timed out');
    expect(runEvalSpy).not.toHaveBeenCalled();
  });

  it('one failed write is covered by the next wave, whose union still includes it', async () => {
    writeResults = [{ ok: false, error: 'redis down' }];
    await driveRun(8);

    expect(timeline.filter((t) => t.startsWith('write'))).toEqual(['write:4:failed', 'write:8']);
    expect(cachedIds()).toEqual(idsFor([1, 8]));
    expect(closedOutcome()).toBe('completed');
  });
});

describe('runRefreshExtraction — time budgets keep the data ahead of the 800 s function kill', () => {
  it('the eval harness runs after the last write and before the run record closes', async () => {
    await driveRun(12);

    expect(timeline).toEqual(['write:4', 'write:8', 'write:12', 'eval', 'close']);
  });

  it('a run already past 540 s skips the eval harness and still ends completed', async () => {
    await driveRun(3, [{ takesMs: 541_000 }]);

    expect(timeline).toEqual(['write:3', 'close']);
    expect(closedOutcome()).toBe('completed');
  });

  it('a run just under 540 s still runs the eval harness', async () => {
    await driveRun(3, [{ takesMs: 539_000 }]);

    expect(timeline).toEqual(['write:3', 'eval', 'close']);
  });

  it('no new LLM wave starts after 480 s; the remaining groups are left for the next run', async () => {
    await driveRun(12, [{ takesMs: 481_000 }]);

    expect(processEventGroupsMock).toHaveBeenCalledTimes(1);
    expect(cachedIds()).toEqual(idsFor([1, 4]));
    expect(closedOutcome()).toBe('completed');
  });

  it('a wave that starts before 480 s is allowed to finish', async () => {
    await driveRun(8, [{ takesMs: 479_000 }, { takesMs: 100_000 }]);

    expect(processEventGroupsMock).toHaveBeenCalledTimes(2);
    expect(cachedIds()).toEqual(idsFor([1, 8]));
  });

  it('every geocode call gets the 660 s deadline, measured from the start of the cron request', async () => {
    await driveRun(8, [{ takesMs: 60_000 }, { takesMs: 60_000 }]);

    const deadlines = geocodeEnrichedEventsMock.mock.calls.map((call) => call[5]);
    expect(deadlines).toEqual([{ deadlineMs: T0 + 660_000 }, { deadlineMs: T0 + 660_000 }]);
  });
});

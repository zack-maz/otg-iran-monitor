// @vitest-environment node
/**
 * The closed run record tells the truth about a run.
 *
 *  - A run whose batches fail reports `batchesFailed > 0` and a non-green
 *    outcome. The extractor ticks its completed-batch counter on every
 *    terminal branch (success and failure), so `total - completed` is always
 *    ~0; the record must use the extractor's own failure tally
 *    (`llmProgress.failedBatches`) and the DLQ growth across the run.
 *  - `runEval()`'s result reaches the record's `evalScore` in the harness
 *    shape (`{ within5km, within20km, within100km, total }`).
 *
 * The record is captured from `closeRunRecord`'s argument — the public
 * RunHistoryEntry contract the FlightRecorder reads — not from Redis.
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

const cacheStore = new Map<string, unknown>();
const cacheSetSpy = vi.fn(async (key: string, data: unknown, _ttl: number) => {
  cacheStore.set(key, data);
});
const cacheGetSpy = vi.fn(async (key: string, _maxAgeMs: number) =>
  cacheStore.has(key) ? { data: cacheStore.get(key), fetchedAt: Date.now() } : null,
);

// SCARD-backed DLQ size — drives the dlqDelta open/close snapshot.
let dlqSize = 0;
const scardMock = vi.fn(async () => dlqSize);

vi.mock('../../cache/redis.js', () => ({
  cacheGetSafe: cacheGetSpy,
  cacheSetSafe: cacheSetSpy,
  cacheSetReported: vi.fn(async (key: string, data: unknown, ttl: number) => {
    await cacheSetSpy(key, data, ttl);
    return { ok: true } as const;
  }),
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    scard: (...args: unknown[]) => scardMock(...args),
  },
}));

vi.mock('../../config.js', () => ({ env: mockEnv }));

vi.mock('../../lib/safeWaitUntil.js', () => ({
  safeWaitUntil: (p: Promise<unknown>) => {
    void p.catch(() => {});
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

// Real eval harness shape (server/lib/llmEvalHarness.ts EvalScore) — NO `.score`.
const evalShape = {
  within5km: 30,
  within20km: 42,
  within100km: 48,
  total: 50,
  actorMatchRate: 0.6,
};
const runEvalSpy = vi.fn().mockResolvedValue(evalShape);
vi.mock('../../lib/llmEvalHarness.js', () => ({ runEval: runEvalSpy }));

const groupGdeltRowsMock = vi.fn();
vi.mock('../../lib/eventGrouping.js', () => ({
  groupGdeltRows: groupGdeltRowsMock,
  dedupHighConfidence: vi.fn((entities: unknown[]) => entities),
  enrichedIdForGroup: (key: string) => `llm-v3-${key}`,
}));

// DLQ — countDLQ() is the open/close snapshot source for dlqDelta. Route it
// through scardMock so per-call sequencing (mockImplementationOnce for the open
// snapshot, then a steady close value) drives the delta exactly like the real
// SCARD-backed countDLQ() would across a run.
vi.mock('../../lib/llmDLQ.js', () => ({
  countDLQ: vi.fn(async () => scardMock()),
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

// Capture run-record lifecycle. closeRunRecord's argument IS the terminal
// RunHistoryEntry the FlightRecorder reads.
const openRunRecordMock = vi.fn(async () => {});
const closeRunRecordMock = vi.fn(async () => {});
vi.mock('../../lib/llmRunHistory.js', () => ({
  openRunRecord: openRunRecordMock,
  closeRunRecord: closeRunRecordMock,
}));

// URL-liveness post-step — stub to no-ops so the finally block doesn't touch
// real Redis / Nominatim in this accounting test.
vi.mock('../../lib/urlLiveness.js', () => ({
  buildProbeCandidates: vi.fn(async () => ({ candidates: [], classifiedNoUrl: 0 })),
  pruneDeadUrlEvents: vi.fn(async () => ({ prunedCount: 0, prunedIds: [] })),
  runProbeSweep: vi.fn(async () => ({ probed: 0, skippedBudget: 0 })),
  SWEEP_SAFETY_MARGIN_MS: 60_000,
}));

/**
 * Extractor mock. `mockFailedBatches` is the failure tally the extractor
 * stamps onto the progress singleton; `mockProduceEvents` decides whether the
 * run yields enriched events (a fully failed run vs. a partial one). The
 * pipeline owns `totalBatches` (2 groups per batch), so the mock leaves it alone.
 */
let mockFailedBatches = 0;
let mockProduceEvents = true;
const processEventGroupsMock = vi.fn(
  async (
    groups: unknown[],
    onBatchComplete?: (completed: number, total: number) => void | Promise<void>,
  ) => {
    const total = Math.ceil(groups.length / 2);
    // Emulate the v3 extractor's per-failure tally.
    if (mockFailedBatches > 0) {
      llmProgressSingleton.failedBatches = mockFailedBatches;
    }
    const events = mockProduceEvents
      ? groups.map((g) => {
          const key = (g as { key: string }).key;
          return {
            schemaVersion: 'v3' as const,
            groupKey: key,
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
          } as Record<string, unknown>;
        })
      : [];
    for (let c = 1; c <= total; c++) {
      const ret = onBatchComplete?.(c, total);
      if (ret && typeof (ret as Promise<void>).then === 'function') await ret;
    }
    // Honest extractor contract: null events when every batch failed.
    return {
      schemaVersion: 'v3' as const,
      events: events.length === 0 ? null : events,
      matchedNewsByGroup: new Map(),
      bellingcatByGroup: new Map(),
    };
  },
);

const geocodeEnrichedEventsMock = vi.fn(
  async (events: Array<Record<string, unknown>>, _g: any, _n: any, _b: any, onProgress?: any) => {
    const out = events.map((e) => ({
      ...e,
      resolvedLat: 35,
      resolvedLng: 50,
      displayName: 'Test',
      geocodeProvenance: 'nominatim-direct' as const,
      precision: 'city' as const,
      suspect: false,
      actionGeoDistanceKm: 0,
    }));
    if (typeof onProgress === 'function') onProgress(out.length, out.length);
    return out;
  },
);

vi.mock('../../lib/llmEventExtractor.v3.js', () => ({
  processEventGroupsV3: processEventGroupsMock,
  geocodeEnrichedEventsV3: geocodeEnrichedEventsMock,
}));

interface MinimalEntity {
  id: string;
  type: string;
  lat: number;
  lng: number;
  timestamp: number;
  label: string;
  data: Record<string, unknown>;
}
function makeRawEntity(id: string): MinimalEntity {
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

async function driveRunWithGroups(groupKeys: string[]) {
  const rawEvents = groupKeys.map((k) => makeRawEntity(`raw-${k}`));
  cacheStore.set('events:gdelt', rawEvents);
  groupGdeltRowsMock.mockReturnValue(groupKeys.map(makeGroup));

  const { runRefreshExtraction } = await import('../../lib/llmExtractionPipeline.js');
  await runRefreshExtraction({ triggeredBy: 'cron', forceCooldown: true });
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

/** The terminal RunHistoryEntry handed to closeRunRecord (last call). */
function lastClosedRecord() {
  const calls = closeRunRecordMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as {
    outcome: string;
    batchCount: number;
    batchesCompleted: number;
    batchesFailed: number;
    dlqDelta: number;
    evalScore: unknown;
  };
}

beforeEach(() => {
  cacheStore.clear();
  cacheSetSpy.mockClear();
  cacheGetSpy.mockClear();
  scardMock.mockClear();
  processEventGroupsMock.mockClear();
  geocodeEnrichedEventsMock.mockClear();
  groupGdeltRowsMock.mockClear();
  runEvalSpy.mockClear();
  openRunRecordMock.mockClear();
  closeRunRecordMock.mockClear();
  dlqSize = 0;
  mockFailedBatches = 0;
  mockProduceEvents = true;
  for (const k of Object.keys(llmProgressSingleton)) delete llmProgressSingleton[k];
  llmProgressSingleton.stage = 'idle';
});

describe('run record — batchesFailed and dlqDelta come from real failures, not from total - completed', () => {
  it('a fully-failed run reports batchesFailed > 0 and an honest (non-success) outcome', async () => {
    // Every batch fails: extractor stamps failedBatches and returns null events.
    mockFailedBatches = 2;
    mockProduceEvents = false;
    // DLQ grows from 0 → 2 across the run (each failed batch enqueued its group).
    scardMock.mockImplementationOnce(async () => 0); // open snapshot
    scardMock.mockImplementation(async () => 2); // close snapshot + thereafter

    await driveRunWithGroups(['a-1', 'b-1', 'c-1', 'd-1']);

    const rec = lastClosedRecord();
    // 4 groups = 2 batches, both failed; `total - completedBatches` would say 0.
    expect(rec.batchCount).toBe(2);
    expect(rec.batchesFailed).toBe(2);
    expect(rec.batchesCompleted).toBe(0); // zero genuine successes
    // Null extraction → 'error' outcome (a non-green band), never 'completed'.
    expect(rec.outcome).toBe('error');
    // DLQ growth across the run (close snapshot - open snapshot).
    expect(rec.dlqDelta).toBe(2);
  });

  it('a partial run (some batches failed, some succeeded) reports a non-zero batchesFailed', async () => {
    // 2 batches; 1 fails but the run still produces events.
    mockFailedBatches = 1;
    mockProduceEvents = true;
    scardMock.mockImplementationOnce(async () => 5); // open
    scardMock.mockImplementation(async () => 6); // close (one new DLQ entry)

    await driveRunWithGroups(['a-1', 'b-1', 'c-1', 'd-1']);

    const rec = lastClosedRecord();
    expect(rec.batchCount).toBe(2);
    expect(rec.batchesFailed).toBe(1);
    expect(rec.batchesCompleted).toBe(1); // total - failed
    // Run completed (produced events) → outcome 'completed'; the FlightRecorder
    // maps completed + batchesFailed>0 to the 'partial' (yellow) band.
    expect(rec.outcome).toBe('completed');
    expect(rec.dlqDelta).toBe(1);
  });

  it('a clean run reports batchesFailed === 0 and dlqDelta === 0 (still SUCCESS/green)', async () => {
    mockFailedBatches = 0;
    mockProduceEvents = true;
    scardMock.mockImplementation(async () => 3); // unchanged across run

    await driveRunWithGroups(['a-1', 'b-1', 'c-1', 'd-1']);

    const rec = lastClosedRecord();
    expect(rec.batchesFailed).toBe(0);
    expect(rec.batchesCompleted).toBe(2);
    expect(rec.dlqDelta).toBe(0);
    expect(rec.outcome).toBe('completed');
  });
});

describe('run record — the eval score is written into the closed record', () => {
  it('closed run record carries the real harness eval shape (within20km/total)', async () => {
    await driveRunWithGroups(['a-1', 'b-1', 'c-1', 'd-1']);

    expect(runEvalSpy).toHaveBeenCalled();
    const rec = lastClosedRecord();
    expect(rec.evalScore).toEqual(evalShape);
    // The eval shape has no `.score` key — it carries the bucket + total
    // contract the client's normalizeEvalScore reads.
    expect((rec.evalScore as Record<string, unknown>).within20km).toBe(42);
    expect((rec.evalScore as Record<string, unknown>).total).toBe(50);
  });
});

// @vitest-environment node
/**
 * The "only new groups" diff in `runRefreshExtraction`.
 *
 * Enriched entities are cached under `enrichedIdForGroup(group.key)`
 * (`llm-v3-<group key>`). The diff must compare that id, not the bare group
 * key: a bare-key compare never matches, so every run would re-send the whole
 * corpus to the LLM.
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
  },
}));

vi.mock('../../config.js', () => ({
  env: mockEnv,
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: (p: Promise<unknown>) => {
    void p.catch(() => {});
  },
}));

vi.mock('../../lib/safeWaitUntil.js', () => ({
  safeWaitUntil: (p: Promise<unknown>) => {
    void p.catch(() => {});
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
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

const runEvalSpy = vi.fn().mockResolvedValue({
  score: 0.85,
  withinKm5: 30,
  withinKm20: 35,
  withinKm100: 40,
  total: 50,
});
vi.mock('../../lib/llmEvalHarness.js', () => ({
  runEval: runEvalSpy,
}));

const groupGdeltRowsMock = vi.fn();
vi.mock('../../lib/eventGrouping.js', () => ({
  groupGdeltRows: groupGdeltRowsMock,
  // The dedup pre-pass is an identity here so group keys come from
  // `groupGdeltRowsMock` unchanged (dedup is tested in eventGrouping.dedup.test.ts).
  dedupHighConfidence: vi.fn((entities: unknown[]) => entities),
  enrichedIdForGroup: (key: string) => `llm-v3-${key}`,
}));

const { llmProgressSingleton } = vi.hoisted(() => ({
  llmProgressSingleton: { stage: 'idle' } as Record<string, unknown>,
}));
vi.mock('../../lib/llmProgress.js', () => ({
  updateProgress: vi.fn((patch: Record<string, unknown>) => {
    Object.assign(llmProgressSingleton, patch);
  }),
  resetProgress: vi.fn(() => {
    for (const k of Object.keys(llmProgressSingleton)) {
      delete llmProgressSingleton[k];
    }
    llmProgressSingleton.stage = 'grouping';
    llmProgressSingleton.startedAt = Date.now();
  }),
  llmProgress: llmProgressSingleton,
  buildSummary: vi.fn().mockReturnValue({}),
}));

const processEventGroupsMock = vi.fn(
  async (
    groups: unknown[],
    onBatchComplete?:
      | ((completed: number, total: number) => void)
      | ((completed: number, total: number) => Promise<void>),
  ) => {
    const total = groups.length;
    const events = groups.map((g) => {
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
    });
    for (let c = 1; c <= total; c++) {
      const ret = onBatchComplete?.(c, total);
      if (ret && typeof (ret as Promise<void>).then === 'function') {
        await ret;
      }
    }
    return {
      schemaVersion: 'v3' as const,
      events,
      matchedNewsByGroup: new Map(),
      bellingcatByGroup: new Map(),
    };
  },
);

// Phase 38 LLM-PURGE-01 — pipeline now imports the v3 extractor directly
// (the `llmEventExtractor.js` stub barrel was deleted). geocodeEnrichedEventsV3
// takes the v3-native signature `(events, groupsByKey, matchedNewsByGroup,
// bellingcatByGroup, onComplete)` and returns a flat array (no tagged shape).
const geocodeEnrichedEventsMock = vi.fn(
  async (
    events: Array<Record<string, unknown>>,
    _groupsByKey: any,
    _matchedNews: any,
    _bellingcat: any,
    onProgress?: any,
  ) => {
    const out = events.map((e) => {
      const groupKey = (e as { groupKey: string }).groupKey;
      return {
        ...e,
        resolvedLat: 35.0 + groupKey.length * 0.001,
        resolvedLng: 50.0 + groupKey.length * 0.001,
        displayName: `Test Site ${groupKey}`,
        geocodeProvenance: 'nominatim-direct' as const,
        precision: 'city' as const,
        suspect: false,
        actionGeoDistanceKm: 0,
      };
    });
    if (typeof onProgress === 'function') {
      onProgress(out.length, out.length);
    }
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
    data: {
      eventType: 'Aerial weapons',
      cameoCode: '195',
      numMentions: 5,
      numSources: 2,
    },
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
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  cacheStore.clear();
  cacheSetSpy.mockClear();
  cacheGetSpy.mockClear();
  processEventGroupsMock.mockClear();
  geocodeEnrichedEventsMock.mockClear();
  groupGdeltRowsMock.mockClear();
  runEvalSpy.mockClear();
  for (const k of Object.keys(llmProgressSingleton)) {
    delete llmProgressSingleton[k];
  }
  llmProgressSingleton.stage = 'idle';
});

describe('runRefreshExtraction — only groups without an enriched entity reach the extractor', () => {
  it('a group whose `llm-v3-<key>` id is already cached is not sent again', async () => {
    // Seed the enriched cache with one entity under the prefixed id.
    cacheStore.set('events:llm:v3', [{ ...makeRawEntity('llm-v3-20513-19-18') }]);

    // Drive two raw groups: one whose key matches the cached id post-prefix,
    // and one fresh group that should reach the extractor.
    await driveRunWithGroups(['20513-19-18', '99999-19-18']);

    // The pipeline must invoke processEventGroups exactly once with ONLY the
    // fresh `99999-19-18` group. A bare-key compare (`20513-19-18` against
    // `llm-v3-20513-19-18`) never matches and would send both.
    expect(processEventGroupsMock).toHaveBeenCalledTimes(1);
    const passedGroups = processEventGroupsMock.mock.calls[0]![0] as Array<{ key: string }>;
    expect(passedGroups).toHaveLength(1);
    expect(passedGroups[0]!.key).toBe('99999-19-18');
  });

  it('an empty enriched cache sends every group', async () => {
    await driveRunWithGroups(['20513-19-18', '99999-19-18']);

    expect(processEventGroupsMock).toHaveBeenCalledTimes(1);
    const passedGroups = processEventGroupsMock.mock.calls[0]![0] as Array<{ key: string }>;
    expect(passedGroups).toHaveLength(2);
    expect(passedGroups.map((g) => g.key).sort()).toEqual(['20513-19-18', '99999-19-18']);
  });
});

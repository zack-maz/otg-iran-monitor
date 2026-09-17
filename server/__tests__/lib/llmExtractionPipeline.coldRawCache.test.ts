// @vitest-environment node
/**
 * Regression: the refresh-events cron must warm its own raw GDELT input.
 *
 * Prod incident (found 2026-09-17): `runRefreshExtraction` read `events:gdelt`
 * cache-only. That key is otherwise written only when a browser polls
 * /api/events, so with no dashboard tab open inside its 150-min hard TTL every
 * daily cron run exited `no_raw_events` in ~200ms and `events:llm:v3` stayed cold.
 *
 * These tests park the pipeline on the `pipeline_busy` guard (the first guard
 * AFTER the raw read) so they can assert the raw-input decision without driving
 * the full extraction IIFE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const cacheStore = new Map<string, { data: unknown; stale: boolean }>();
vi.mock('../../cache/redis.js', () => ({
  cacheGetSafe: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
  cacheSetSafe: vi.fn(),
  redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../config.js', () => ({ env: { NVIDIA_NIM_API_KEY: 'fake', LLM_BATCH_SIZE: 2 } }));
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../../adapters/llm-provider.js', () => ({
  isLLMConfigured: () => true,
  callLLM: vi.fn(),
}));
vi.mock('../../lib/llmProgress.js', () => ({
  llmProgress: { stage: 'grouping' }, // → `pipeline_busy` once past the raw-input guard
  updateProgress: vi.fn(),
  resetProgress: vi.fn(),
  buildSummary: vi.fn(),
}));

const refreshRawEventsMock = vi.fn();
vi.mock('../../lib/rawEventsRefresh.js', () => ({
  EVENTS_KEY: 'events:gdelt',
  EVENTS_LOGICAL_TTL_MS: 900_000,
  refreshRawEvents: refreshRawEventsMock,
}));

const rawEvent = {
  id: 'gdelt-1',
  type: 'airstrike',
  lat: 35,
  lng: 51,
  timestamp: Date.now(),
  label: 'x',
  data: {},
};

describe('runRefreshExtraction — raw GDELT input', () => {
  beforeEach(() => {
    cacheStore.clear();
    refreshRawEventsMock.mockReset();
  });

  it('refreshes GDELT itself when events:gdelt is missing, then proceeds', async () => {
    refreshRawEventsMock.mockResolvedValue([rawEvent]);
    const { runRefreshExtraction } = await import('../../lib/llmExtractionPipeline.js');

    const result = await runRefreshExtraction({ triggeredBy: 'cron' });

    // skipBackfill: the WAR_START backfill must never run inside the cron's 800s budget.
    expect(refreshRawEventsMock).toHaveBeenCalledWith({ cached: null, skipBackfill: true });
    expect(result.reason).toBe('pipeline_busy'); // i.e. NOT no_raw_events
  });

  it('refreshes when events:gdelt is stale, merging into the stale rows', async () => {
    cacheStore.set('events:gdelt', { data: [rawEvent], stale: true });
    refreshRawEventsMock.mockResolvedValue([rawEvent, { ...rawEvent, id: 'gdelt-2' }]);
    const { runRefreshExtraction } = await import('../../lib/llmExtractionPipeline.js');

    const result = await runRefreshExtraction({ triggeredBy: 'cron' });

    expect(refreshRawEventsMock).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe('pipeline_busy');
  });

  it('does not hit GDELT when events:gdelt is fresh', async () => {
    cacheStore.set('events:gdelt', { data: [rawEvent], stale: false });
    const { runRefreshExtraction } = await import('../../lib/llmExtractionPipeline.js');

    const result = await runRefreshExtraction({ triggeredBy: 'cron' });

    expect(refreshRawEventsMock).not.toHaveBeenCalled();
    expect(result.reason).toBe('pipeline_busy');
  });

  it('falls back to stale rows when the GDELT refresh fails', async () => {
    cacheStore.set('events:gdelt', { data: [rawEvent], stale: true });
    refreshRawEventsMock.mockRejectedValue(new Error('gdelt down'));
    const { runRefreshExtraction } = await import('../../lib/llmExtractionPipeline.js');

    const result = await runRefreshExtraction({ triggeredBy: 'cron' });

    expect(result.reason).toBe('pipeline_busy');
  });

  it('returns no_raw_events only when the cache is empty AND the refresh fails', async () => {
    refreshRawEventsMock.mockRejectedValue(new Error('gdelt down'));
    const { runRefreshExtraction } = await import('../../lib/llmExtractionPipeline.js');

    const result = await runRefreshExtraction({ triggeredBy: 'cron' });

    expect(result).toMatchObject({ dispatched: false, reason: 'no_raw_events' });
  });
});

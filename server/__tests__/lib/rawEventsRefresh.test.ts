// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ConflictEventEntity } from '../../types.js';

const WAR_START = Date.UTC(2026, 1, 28);

const cacheStore = new Map<string, unknown>();
const cacheSetSpy = vi.fn(async (key: string, data: unknown, _ttl: number) => {
  cacheStore.set(key, data);
});

vi.mock('../../cache/redis.js', () => ({
  cacheGetSafe: vi.fn(async () => null),
  cacheSetSafe: cacheSetSpy,
  redis: {
    // Backfill cooldown active → shouldBackfill() false unless forced.
    get: vi.fn().mockResolvedValue(Date.now()),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../config.js', () => ({ WAR_START: Date.UTC(2026, 1, 28) }));

vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const fetchEventsMock = vi.fn();
const backfillEventsMock = vi.fn();
vi.mock('../../adapters/gdelt.js', () => ({
  fetchEvents: fetchEventsMock,
  backfillEvents: backfillEventsMock,
}));

function makeEvent(id: string, timestamp = WAR_START + 86_400_000): ConflictEventEntity {
  return {
    id,
    type: 'airstrike',
    lat: 35,
    lng: 51,
    timestamp,
    label: id,
    data: { source: 'https://www.bbc.co.uk/news/x' },
  } as unknown as ConflictEventEntity;
}

describe('refreshRawEvents', () => {
  beforeEach(() => {
    cacheStore.clear();
    cacheSetSpy.mockClear();
    fetchEventsMock.mockReset();
    backfillEventsMock.mockReset();
  });

  it('merges fresh events over cached ones by id and persists to events:gdelt', async () => {
    const { refreshRawEvents, EVENTS_KEY } = await import('../../lib/rawEventsRefresh.js');
    fetchEventsMock.mockResolvedValue([makeEvent('b'), makeEvent('c')]);

    const merged = await refreshRawEvents({ cached: { data: [makeEvent('a'), makeEvent('b')] } });

    expect(merged.map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
    expect(cacheSetSpy).toHaveBeenCalledTimes(1);
    expect(cacheSetSpy.mock.calls[0]![0]).toBe(EVENTS_KEY);
    expect(backfillEventsMock).not.toHaveBeenCalled();
  });

  it('prunes events older than WAR_START', async () => {
    const { refreshRawEvents } = await import('../../lib/rawEventsRefresh.js');
    fetchEventsMock.mockResolvedValue([makeEvent('old', WAR_START - 1), makeEvent('new')]);

    const merged = await refreshRawEvents({ cached: { data: [] } });

    expect(merged.map((e) => e.id)).toEqual(['new']);
  });

  it('backfills when forced, with fresh events winning on id collision', async () => {
    const { refreshRawEvents } = await import('../../lib/rawEventsRefresh.js');
    backfillEventsMock.mockResolvedValue([
      { ...makeEvent('x'), label: 'backfill' },
      makeEvent('h'),
    ]);
    fetchEventsMock.mockResolvedValue([{ ...makeEvent('x'), label: 'fresh' }]);

    const merged = await refreshRawEvents({ cached: null, forceBackfill: true });

    expect(backfillEventsMock).toHaveBeenCalledTimes(1);
    expect(merged.find((e) => e.id === 'x')!.label).toBe('fresh');
    expect(merged.map((e) => e.id).sort()).toEqual(['h', 'x']);
  });

  it('never backfills when skipBackfill is set, even on an empty accumulator', async () => {
    const { redis } = await import('../../cache/redis.js');
    vi.mocked(redis.get).mockResolvedValueOnce(null); // cooldown elapsed → would backfill
    const { refreshRawEvents } = await import('../../lib/rawEventsRefresh.js');
    fetchEventsMock.mockResolvedValue([makeEvent('a')]);

    const merged = await refreshRawEvents({ cached: null, skipBackfill: true });

    expect(backfillEventsMock).not.toHaveBeenCalled();
    expect(merged.map((e) => e.id)).toEqual(['a']);
    // Not persisted: the route must still find the accumulator empty and backfill.
    expect(cacheSetSpy).not.toHaveBeenCalled();
  });

  it('persists a skipBackfill refresh when merging into an existing accumulator', async () => {
    const { refreshRawEvents } = await import('../../lib/rawEventsRefresh.js');
    fetchEventsMock.mockResolvedValue([makeEvent('b')]);

    await refreshRawEvents({ cached: { data: [makeEvent('a')] }, skipBackfill: true });

    expect(cacheSetSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates a GDELT fetch failure without writing the cache', async () => {
    const { refreshRawEvents } = await import('../../lib/rawEventsRefresh.js');
    fetchEventsMock.mockRejectedValue(new Error('gdelt down'));

    await expect(refreshRawEvents({ cached: { data: [makeEvent('a')] } })).rejects.toThrow(
      'gdelt down',
    );
    expect(cacheSetSpy).not.toHaveBeenCalled();
  });
});

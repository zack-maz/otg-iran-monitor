// @vitest-environment node
/**
 * `geocodeEnrichedEventsV3` — a few events at a time, in input order, up to a
 * deadline.
 *
 * Geocoding is the slow half of a wave. Four events are resolved concurrently
 * (Nominatim's 1 req/s is enforced inside the resolver, not here) so an event
 * that needs the LLM reranker does not hold up the ones behind it. Callers
 * rely on three things:
 *  - the output keeps the input order, whatever order the resolves finish in;
 *  - past `opts.deadlineMs` no further event is started, and what is done is
 *    returned — the rest are picked up by the next run;
 *  - `onComplete` counts up one by one, so the progress bar never jumps back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { EventGroup } from '../../lib/eventGrouping.js';
import type { EnrichedEventV3 } from '../../lib/llmSchema.js';

vi.mock('../../cache/redis.js', () => ({
  cacheGetSafe: vi.fn().mockResolvedValue(null),
  cacheSetSafe: vi.fn().mockResolvedValue(undefined),
  redis: {},
}));

vi.mock('../../config.js', () => ({
  env: { LLM_BATCH_SIZE: 2, LLM_BATCH_TIMEOUT_MS: 90_000, LLM_V3_CONCURRENCY: 1 },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../lib/freeClaudeRouter.js', () => ({
  callLLM: vi.fn(),
  prewarmIfCold: vi.fn(),
}));

// Each resolve takes as long as `resolveMsByCity` says (default 0), and the
// mock tracks how many are in flight at once.
let resolveMsByCity: Record<string, number> = {};
let inFlight = 0;
let maxInFlight = 0;
const started: string[] = [];
const defaultResolve = async (location: { city: string | null }) => {
  const city = location.city ?? '';
  started.push(city);
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((resolve) => setTimeout(resolve, resolveMsByCity[city] ?? 0));
  inFlight--;
  if (city === 'throws') throw new Error('resolver exploded');
  return {
    lat: 35,
    lng: 51,
    provenance: 'nominatim-direct' as const,
    actionGeoDistanceKm: 1,
    displayName: city,
  };
};
const resolveLocationMock = vi.fn(defaultResolve);
vi.mock('../../lib/llmResolver.js', () => ({
  resolveLocation: resolveLocationMock,
}));

const { geocodeEnrichedEventsV3 } = await import('../../lib/llmEventExtractor.v3.js');

function makeEvent(city: string): EnrichedEventV3 {
  return {
    schemaVersion: 'v3',
    groupKey: `grp-${city}`,
    location: {
      country: 'Iran',
      admin1: null,
      city,
      neighborhood: null,
      landmark: null,
      confidence: 0.8,
    },
    type: 'airstrike',
    confidence: 0.8,
    reasoning: 'test',
    weaponType: null,
    targetType: null,
    timeOfDay: null,
    durationMinutes: null,
    actors: [],
    severity: 'medium',
    summary: `strike on ${city}`,
    casualties: { killed: null, injured: null, unknown: true },
    sourceCount: 1,
  } as unknown as EnrichedEventV3;
}

const cities = (n: number) => Array.from({ length: n }, (_, i) => `city-${i + 1}`);

function geocode(
  names: string[],
  onComplete?: (completed: number, total: number) => void,
  opts?: { deadlineMs?: number },
) {
  return geocodeEnrichedEventsV3(
    names.map(makeEvent),
    new Map<string, EventGroup>(),
    new Map(),
    new Map(),
    onComplete,
    opts,
  );
}

const T0 = Date.UTC(2026, 8, 19, 4, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resolveMsByCity = {};
  inFlight = 0;
  maxInFlight = 0;
  started.length = 0;
  resolveLocationMock.mockReset().mockImplementation(defaultResolve);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('geocodeEnrichedEventsV3 — four events at a time', () => {
  it('never has more than four resolves in flight, and resolves every event', async () => {
    const names = cities(10);
    for (const n of names) resolveMsByCity[n] = 1000;

    const run = geocode(names);
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(3000);
    const out = await run;

    expect(maxInFlight).toBe(4);
    expect(out).toHaveLength(10);
  });

  it('keeps the input order even when later events finish first', async () => {
    const names = cities(6);
    // The first event is the slowest; the rest overtake it.
    resolveMsByCity = { 'city-1': 5000, 'city-2': 100, 'city-3': 300, 'city-4': 200 };
    const finished: string[] = [];
    resolveLocationMock.mockImplementation(async (location: { city: string | null }) => {
      const city = location.city ?? '';
      await new Promise((resolve) => setTimeout(resolve, resolveMsByCity[city] ?? 0));
      finished.push(city);
      return {
        lat: 35,
        lng: 51,
        provenance: 'nominatim-direct' as const,
        actionGeoDistanceKm: 1,
        displayName: city,
      };
    });

    const run = geocode(names);
    await vi.advanceTimersByTimeAsync(5000);
    const out = await run;

    expect(finished[0]).not.toBe('city-1');
    expect(finished[finished.length - 1]).toBe('city-1');
    expect(out.map((e) => e.displayName)).toEqual(names);
  });

  it('an event whose resolve throws keeps its place, on the GDELT centroid fallback', async () => {
    const run = geocode(['city-1', 'throws', 'city-3']);
    await vi.advanceTimersByTimeAsync(0);
    const out = await run;

    expect(out.map((e) => e.groupKey)).toEqual(['grp-city-1', 'grp-throws', 'grp-city-3']);
    expect(out[1]?.geocodeProvenance).toBe('gdelt-actiongeo-fallback');
  });
});

describe('geocodeEnrichedEventsV3 — starts no new event after the deadline', () => {
  it('returns the events started before the deadline, in order, and leaves the rest', async () => {
    const names = cities(10);
    for (const n of names) resolveMsByCity[n] = 1000;

    // Events 1-4 start at 0 s, 5-8 at 1 s; at 2 s the deadline (1.5 s) has passed.
    const run = geocode(names, undefined, { deadlineMs: T0 + 1500 });
    await vi.advanceTimersByTimeAsync(5000);
    const out = await run;

    expect(started).toEqual(cities(8));
    expect(out.map((e) => e.displayName)).toEqual(cities(8));
  });

  it('an event already in flight at the deadline is allowed to finish', async () => {
    resolveMsByCity = { 'city-1': 10_000 };

    const run = geocode(['city-1'], undefined, { deadlineMs: T0 + 1000 });
    await vi.advanceTimersByTimeAsync(10_000);
    const out = await run;

    expect(out.map((e) => e.displayName)).toEqual(['city-1']);
  });

  it('a deadline already in the past resolves nothing', async () => {
    const onComplete = vi.fn();

    const out = await geocode(cities(5), onComplete, { deadlineMs: T0 - 1 });

    expect(out).toEqual([]);
    expect(resolveLocationMock).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('without a deadline every event is resolved', async () => {
    const names = cities(9);
    for (const n of names) resolveMsByCity[n] = 60_000;

    const run = geocode(names);
    await vi.advanceTimersByTimeAsync(180_000);

    expect(await run).toHaveLength(9);
  });
});

describe('geocodeEnrichedEventsV3 — onComplete counts up one by one', () => {
  it('reports 1..n against the full total, whatever order the resolves finish in', async () => {
    const names = cities(7);
    resolveMsByCity = { 'city-1': 900, 'city-2': 100, 'city-3': 500, 'city-5': 50, 'city-7': 700 };
    const progress: Array<[number, number]> = [];

    const run = geocode(names, (completed, total) => progress.push([completed, total]));
    await vi.advanceTimersByTimeAsync(5000);
    await run;

    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => [n, 7]));
  });

  it('counts only the events that were resolved when the deadline cuts the run short', async () => {
    const names = cities(10);
    for (const n of names) resolveMsByCity[n] = 1000;
    const progress: number[] = [];

    const run = geocode(names, (completed) => progress.push(completed), {
      deadlineMs: T0 + 1500,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await run;

    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

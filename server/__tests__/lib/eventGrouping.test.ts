import { describe, it, expect } from 'vitest';

import type { ConflictEventEntity } from '../../types.js';

// Helper to create a test entity
function makeEntity(
  overrides: Partial<ConflictEventEntity> & {
    lat: number;
    lng: number;
    data?: Partial<ConflictEventEntity['data']>;
  },
): ConflictEventEntity {
  return {
    id: overrides.id ?? `evt-${Math.random().toString(36).slice(2)}`,
    type: overrides.type ?? 'airstrike',
    lat: overrides.lat,
    lng: overrides.lng,
    timestamp: overrides.timestamp ?? Date.now(),
    label: overrides.label ?? 'Test event',
    data: {
      eventType: 'Airstrike',
      subEventType: 'CAMEO 195',
      fatalities: 0,
      actor1: 'UNITED STATES',
      actor2: 'IRAN',
      notes: '',
      source: 'https://example.com',
      goldsteinScale: -10,
      locationName: 'Baghdad, Iraq',
      cameoCode: '195',
      numMentions: 10,
      numSources: 5,
      ...overrides.data,
    },
  };
}

describe('eventGrouping', () => {
  it('merges rows with same date + same CAMEO root + within 50km', async () => {
    const { groupGdeltRows } = await import('../../lib/eventGrouping.js');

    const now = Date.now();
    const sameDay = now;
    // Baghdad coordinates ~33.3, 44.4. Two points 10km apart.
    const entities = [
      makeEntity({
        lat: 33.3,
        lng: 44.4,
        timestamp: sameDay,
        data: { cameoCode: '195', numMentions: 10, numSources: 5 },
      }),
      makeEntity({
        lat: 33.35,
        lng: 44.45,
        timestamp: sameDay,
        data: { cameoCode: '193', numMentions: 8, numSources: 3 },
      }),
    ];

    const groups = groupGdeltRows(entities);
    // Both have CAMEO root '19', same day, <50km apart => 1 group
    expect(groups).toHaveLength(1);
    expect(groups[0].entities).toHaveLength(2);
  });

  it('keeps rows with different dates as separate groups', async () => {
    const { groupGdeltRows } = await import('../../lib/eventGrouping.js');

    const day1 = new Date('2026-03-01T12:00:00Z').getTime();
    const day2 = new Date('2026-03-02T12:00:00Z').getTime();

    const entities = [
      makeEntity({ lat: 33.3, lng: 44.4, timestamp: day1, data: { cameoCode: '195' } }),
      makeEntity({ lat: 33.3, lng: 44.4, timestamp: day2, data: { cameoCode: '195' } }),
    ];

    const groups = groupGdeltRows(entities);
    expect(groups).toHaveLength(2);
  });

  it('keeps rows more than 50km apart as separate groups', async () => {
    const { groupGdeltRows } = await import('../../lib/eventGrouping.js');

    const now = Date.now();
    // Baghdad 33.3, 44.4 vs. Basra 30.5, 47.8 => ~400km apart
    const entities = [
      makeEntity({ lat: 33.3, lng: 44.4, timestamp: now, data: { cameoCode: '195' } }),
      makeEntity({ lat: 30.5, lng: 47.8, timestamp: now, data: { cameoCode: '195' } }),
    ];

    const groups = groupGdeltRows(entities);
    expect(groups).toHaveLength(2);
  });

  it('computes centroid as mean lat/lng of group members', async () => {
    const { groupGdeltRows } = await import('../../lib/eventGrouping.js');

    const now = Date.now();
    const entities = [
      makeEntity({ lat: 33.0, lng: 44.0, timestamp: now, data: { cameoCode: '195' } }),
      makeEntity({ lat: 33.2, lng: 44.2, timestamp: now, data: { cameoCode: '195' } }),
    ];

    const groups = groupGdeltRows(entities);
    expect(groups).toHaveLength(1);
    expect(groups[0].centroidLat).toBeCloseTo(33.1, 1);
    expect(groups[0].centroidLng).toBeCloseTo(44.1, 1);
  });

  it('sums totalMentions and totalSources across group members', async () => {
    const { groupGdeltRows } = await import('../../lib/eventGrouping.js');

    const now = Date.now();
    const entities = [
      makeEntity({
        lat: 33.0,
        lng: 44.0,
        timestamp: now,
        data: { cameoCode: '195', numMentions: 10, numSources: 5 },
      }),
      makeEntity({
        lat: 33.1,
        lng: 44.1,
        timestamp: now,
        data: { cameoCode: '193', numMentions: 8, numSources: 3 },
      }),
    ];

    const groups = groupGdeltRows(entities);
    expect(groups).toHaveLength(1);
    expect(groups[0].totalMentions).toBe(18);
    expect(groups[0].totalSources).toBe(8);
  });
});

// The pipeline caches an enriched entity under `llm-v3-<group key>` and, on
// the next run, skips every group whose key is already cached. The raw corpus
// is re-sampled between runs, so a key built from the group's position in the
// pass shifts as soon as one earlier row appears: the diff misses, and
// merge-by-id writes one event's enrichment over another's. The key is built
// from content only: day, CAMEO root, lowest member id.
describe('groupGdeltRows — group keys are derived from content, not from position', () => {
  const day = Date.UTC(2026, 8, 18, 12, 0, 0);
  const dayNumber = Math.floor(day / 86_400_000);
  const baghdad = [
    makeEntity({ id: 'gdelt-1300', lat: 33.3, lng: 44.4, timestamp: day + 2000 }),
    makeEntity({ id: 'gdelt-1200', lat: 33.35, lng: 44.45, timestamp: day + 1000 }),
  ];
  const basra = [makeEntity({ id: 'gdelt-1500', lat: 30.5, lng: 47.8, timestamp: day + 3000 })];

  const keyOfGroupWith = (
    groups: Array<{ key: string; entities: ConflictEventEntity[] }>,
    id: string,
  ) => groups.find((g) => g.entities.some((e) => e.id === id))?.key;

  it('the key is grp-<day>-<CAMEO root>-<lowest GDELT event id in the group>', async () => {
    const { groupGdeltRows } = await import('../../lib/eventGrouping.js');

    const groups = groupGdeltRows([...baghdad, ...basra]);

    expect(keyOfGroupWith(groups, 'gdelt-1300')).toBe(`grp-${dayNumber}-19-1200`);
    expect(keyOfGroupWith(groups, 'gdelt-1500')).toBe(`grp-${dayNumber}-19-1500`);
  });

  it('keys do not change when an unrelated earlier row is added to the input', async () => {
    const { groupGdeltRows } = await import('../../lib/eventGrouping.js');
    const before = groupGdeltRows([...baghdad, ...basra]);

    // Earlier the same day, far from both groups: it becomes the first group
    // of the pass and would shift every positional index by one.
    const earlier = makeEntity({ id: 'gdelt-900', lat: 36.2, lng: 37.1, timestamp: day - 5000 });
    const after = groupGdeltRows([earlier, ...baghdad, ...basra]);

    expect(after).toHaveLength(3);
    expect(keyOfGroupWith(after, 'gdelt-1300')).toBe(keyOfGroupWith(before, 'gdelt-1300'));
    expect(keyOfGroupWith(after, 'gdelt-1500')).toBe(keyOfGroupWith(before, 'gdelt-1500'));
  });

  it('keys do not depend on the order of the input rows', async () => {
    const { groupGdeltRows } = await import('../../lib/eventGrouping.js');

    const forward = groupGdeltRows([...baghdad, ...basra]);
    const reversed = groupGdeltRows([...basra, ...[...baghdad].reverse()]);

    expect(reversed.map((g) => g.key).sort()).toEqual(forward.map((g) => g.key).sort());
  });

  it('two groups on the same day with the same CAMEO root get distinct keys', async () => {
    const { groupGdeltRows } = await import('../../lib/eventGrouping.js');

    const groups = groupGdeltRows([...baghdad, ...basra]);

    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.key)).size).toBe(2);
  });

  it('the lowest id is compared as a number, so gdelt-999 sorts below gdelt-1200', async () => {
    const { groupGdeltRows } = await import('../../lib/eventGrouping.js');

    const groups = groupGdeltRows([
      ...baghdad,
      makeEntity({ id: 'gdelt-999', lat: 33.31, lng: 44.41, timestamp: day + 4000 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(`grp-${dayNumber}-19-999`);
  });

  it('every group has a key', async () => {
    const { groupGdeltRows } = await import('../../lib/eventGrouping.js');

    for (const g of groupGdeltRows([...baghdad, ...basra]))
      expect(g.key).toMatch(/^grp-\d+-19-\d+$/);
  });
});

describe('enrichedIdForGroup', () => {
  it('prefixes the group key with llm-v3-', async () => {
    const { enrichedIdForGroup } = await import('../../lib/eventGrouping.js');

    expect(enrichedIdForGroup('grp-20714-19-1200')).toBe('llm-v3-grp-20714-19-1200');
  });
});

// The enriched cache fills a wave at a time over several runs. Until it covers
// the corpus, the map shows every enriched event plus the raw rows of the
// groups that have none — never the raw rows of a covered group, which would
// draw the same event twice.
describe('fillWithRawEvents — enriched events plus the raw rows of uncovered groups', () => {
  const day = Date.UTC(2026, 8, 18, 12, 0, 0);
  const baghdad = [
    makeEntity({ id: 'gdelt-1200', lat: 33.3, lng: 44.4, timestamp: day, data: { actor1: 'A' } }),
    makeEntity({ id: 'gdelt-1300', lat: 33.35, lng: 44.45, timestamp: day, data: { actor1: 'B' } }),
  ];
  const basra = makeEntity({ id: 'gdelt-1500', lat: 30.5, lng: 47.8, timestamp: day });
  const raw = [...baghdad, basra];

  async function enrichedFor(memberId: string): Promise<ConflictEventEntity> {
    const { groupGdeltRows, enrichedIdForGroup } = await import('../../lib/eventGrouping.js');
    const group = groupGdeltRows(raw).find((g) => g.entities.some((e) => e.id === memberId));
    if (!group) throw new Error(`no group holds ${memberId}`);
    return makeEntity({ id: enrichedIdForGroup(group.key), lat: 33.3, lng: 44.4, timestamp: day });
  }

  it('drops the raw rows of a covered group and keeps the rest', async () => {
    const { fillWithRawEvents } = await import('../../lib/eventGrouping.js');
    const enriched = await enrichedFor('gdelt-1200');

    const out = fillWithRawEvents([enriched], raw);

    expect(out.map((e) => e.id)).toEqual([enriched.id, 'gdelt-1500']);
  });

  it('serves only enriched events once every group is covered', async () => {
    const { fillWithRawEvents } = await import('../../lib/eventGrouping.js');
    const enriched = [await enrichedFor('gdelt-1200'), await enrichedFor('gdelt-1500')];

    expect(fillWithRawEvents(enriched, raw)).toEqual(enriched);
  });

  it('keeps an enriched event whose group is no longer in the raw corpus', async () => {
    const { fillWithRawEvents } = await import('../../lib/eventGrouping.js');
    const gone = makeEntity({ id: 'llm-v3-grp-1-19-1', lat: 35.7, lng: 51.4, timestamp: day });

    const out = fillWithRawEvents([gone], raw);

    expect(out.map((e) => e.id)).toEqual([
      'llm-v3-grp-1-19-1',
      'gdelt-1200',
      'gdelt-1300',
      'gdelt-1500',
    ]);
  });

  it('returns the enriched events untouched when there are no raw rows', async () => {
    const { fillWithRawEvents } = await import('../../lib/eventGrouping.js');
    const enriched = [await enrichedFor('gdelt-1200')];

    expect(fillWithRawEvents(enriched, [])).toBe(enriched);
  });

  it('returns the raw rows untouched when nothing is enriched yet', async () => {
    const { fillWithRawEvents } = await import('../../lib/eventGrouping.js');

    expect(fillWithRawEvents([], raw)).toBe(raw);
  });

  it('does not mutate either input', async () => {
    const { fillWithRawEvents } = await import('../../lib/eventGrouping.js');
    const enriched = [await enrichedFor('gdelt-1200')];
    const rawBefore = structuredClone(raw);
    const enrichedBefore = structuredClone(enriched);

    fillWithRawEvents(enriched, raw);

    expect(raw).toEqual(rawBefore);
    expect(enriched).toEqual(enrichedBefore);
  });
});

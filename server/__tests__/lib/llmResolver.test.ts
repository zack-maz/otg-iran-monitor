// @vitest-environment node
/**
 * Phase 27.4 Plan 03 + Plan 05 — tests for server/lib/llmResolver.ts.
 *
 * Plan 03 baseline covered the 6-branch dispatcher with stubs at branches
 * 2 (POI amenity) and 4 (2-pass verify). Plan 05 replaces both stubs with
 * functional implementations and adds tests for the D-03 + D-04 behaviors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks.
vi.mock('../../lib/sitesSnapshot.js', () => ({
  loadSitesSnapshot: vi.fn(),
  __resetSitesSnapshotCacheForTests: vi.fn(),
}));
vi.mock('../../lib/waterSnapshot.js', () => ({
  loadWaterSnapshot: vi.fn(),
  __resetSnapshotCacheForTests: vi.fn(),
}));
vi.mock('../../adapters/nominatim.js', () => ({
  forwardGeocode: vi.fn(),
  forwardGeocodeConstrained: vi.fn(),
  reverseGeocode: vi.fn(),
}));
vi.mock('../../cache/redis.js', () => ({
  cacheGetSafe: vi.fn().mockResolvedValue(null),
  cacheSetSafe: vi.fn().mockResolvedValue(undefined),
}));
// Phase 29 Plan 03: resolver imports callLLM from freeClaudeRouter (Pitfall 3
// fix). The router returns `{content, routing, finishReason?}` rather than the
// legacy `string | null`. We mock freeClaudeRouter directly; existing tests
// that did `mockResolvedValueOnce(jsonStr)` are migrated to wrap the value in
// the router envelope below.
vi.mock('../../lib/freeClaudeRouter.js', () => ({
  callLLM: vi.fn().mockResolvedValue({ content: null, routing: [] }),
}));

import { forwardGeocodeConstrained } from '../../adapters/nominatim.js';
import { cacheGetSafe, cacheSetSafe } from '../../cache/redis.js';
import { callLLM } from '../../lib/freeClaudeRouter.js';
import {
  resolveLocation,
  fuzzyNameMatch,
  isPoiLandmark,
  haversineKm,
  POI_KEYWORDS,
  __resetThrottleForTests,
  type ResolveContext,
} from '../../lib/llmResolver.js';
import { loadSitesSnapshot } from '../../lib/sitesSnapshot.js';
import { loadWaterSnapshot } from '../../lib/waterSnapshot.js';

import type { LocationHierarchyV2 } from '../../lib/llmSchema.js';

function hierarchy(partial: Partial<LocationHierarchyV2> = {}): LocationHierarchyV2 {
  return {
    country: null,
    admin1: null,
    city: null,
    neighborhood: null,
    landmark: null,
    confidence: 0.8,
    ...partial,
  };
}

function ctx(partial: Partial<ResolveContext> = {}): ResolveContext {
  return {
    centroidLat: 33.0,
    centroidLng: 44.0,
    ...partial,
  };
}

// -----------------------------------------------------------------------------
// Plan 03 baseline suite (updated for Plan 05 constrained-adapter behavior).
// -----------------------------------------------------------------------------

describe('llmResolver', () => {
  beforeEach(() => {
    __resetThrottleForTests();
    vi.mocked(loadSitesSnapshot).mockReturnValue(null);
    vi.mocked(loadWaterSnapshot).mockReturnValue(null);
    vi.mocked(forwardGeocodeConstrained).mockReset().mockResolvedValue([]);
    vi.mocked(cacheGetSafe).mockReset().mockResolvedValue(null);
    vi.mocked(cacheSetSafe).mockReset().mockResolvedValue(undefined);
    vi.mocked(callLLM).mockReset().mockResolvedValue({ content: null, routing: [] });
  });

  it('resolves via sitesSnapshot when landmark substring-matches a site label with matching country', async () => {
    vi.mocked(loadSitesSnapshot).mockReturnValue({
      generatedAt: '2026-04-20T00:00:00Z',
      sites: [{ label: 'Natanz Nuclear Facility', country: 'Iran', lat: 33.72, lng: 51.73 }],
      stats: {},
    } as unknown as ReturnType<typeof loadSitesSnapshot>);

    const out = await resolveLocation(
      hierarchy({ country: 'Iran', landmark: 'Natanz nuclear facility' }),
      ctx({ centroidLat: 33.7, centroidLng: 51.7 }),
    );

    expect(out.provenance).toBe('own-site-snapshot');
    expect(out.lat).toBeCloseTo(33.72);
    expect(out.lng).toBeCloseTo(51.73);
    expect(out.displayName).toBe('Natanz Nuclear Facility');
  });

  it('falls through to nominatim-direct when snapshot loaders return null and landmark is not POI', async () => {
    // With WR-04: precision=city triggers the 2-pass sanity gate; the
    // verify branch also returns a single candidate which is now accepted
    // directly (provenance `nominatim-verified-2pass`) instead of being
    // negative-cached as a miss.
    vi.mocked(forwardGeocodeConstrained).mockResolvedValue([
      {
        lat: 33.3,
        lng: 44.4,
        displayName: 'Baghdad, Iraq',
        type: 'city',
        address: { country_code: 'iq' },
      },
    ]);

    const out = await resolveLocation(
      hierarchy({ country: 'Iraq', city: 'Baghdad' }),
      ctx({ centroidLat: 33.3, centroidLng: 44.4 }),
    );

    expect(out.provenance).toBe('nominatim-verified-2pass');
    expect(out.lat).toBeCloseTo(33.3);
    expect(out.lng).toBeCloseTo(44.4);
  });

  it('POI amenity miss falls through to nominatim-direct', async () => {
    // Plan 05 + Plan 07: POI branch calls forwardGeocodeConstrained with
    // q=<landmark> (Plan 07 swap from amenity= → q= per D-11 lever 1). When
    // no POI result, dispatch continues to nominatim-direct (second call).
    vi.mocked(forwardGeocodeConstrained)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          lat: 34.1,
          lng: 51.0,
          displayName: 'Some airbase location',
          type: 'airport',
          address: { country_code: 'qa' },
        },
      ]);

    const out = await resolveLocation(
      hierarchy({ country: 'Qatar', landmark: 'Al Udeid airbase' }),
      ctx({ centroidLat: 34.1, centroidLng: 51.0 }),
    );

    expect(out.provenance).toBe('nominatim-direct');
  });

  it('falls back to gdelt-actiongeo-fallback when no path resolves', async () => {
    const out = await resolveLocation(
      hierarchy({ country: 'Iran' }),
      ctx({ centroidLat: 32.5, centroidLng: 53.0 }),
    );
    expect(out.provenance).toBe('gdelt-actiongeo-fallback');
    expect(out.lat).toBe(32.5);
    expect(out.lng).toBe(53.0);
    expect(out.actionGeoDistanceKm).toBe(0);
  });

  it('uses bellingcat-coord-passthrough when earlier paths empty and ctx.bellingcatCoord is set', async () => {
    const out = await resolveLocation(
      hierarchy({ country: 'Syria' }),
      ctx({
        centroidLat: 33.5,
        centroidLng: 36.3,
        bellingcatCoord: { lat: 33.51, lng: 36.31 },
      }),
    );
    expect(out.provenance).toBe('bellingcat-coord-passthrough');
    expect(out.lat).toBeCloseTo(33.51);
    expect(out.lng).toBeCloseTo(36.31);
  });

  it('computes actionGeoDistanceKm via haversine from resolved coord to centroid', async () => {
    vi.mocked(loadSitesSnapshot).mockReturnValue({
      generatedAt: '2026-04-20T00:00:00Z',
      sites: [{ label: 'Test Site', country: 'Iran', lat: 30, lng: 50 }],
      stats: {},
    } as unknown as ReturnType<typeof loadSitesSnapshot>);

    const out = await resolveLocation(
      hierarchy({ country: 'Iran', landmark: 'Test Site' }),
      ctx({ centroidLat: 30.1, centroidLng: 50.0 }),
    );

    expect(out.provenance).toBe('own-site-snapshot');
    expect(out.actionGeoDistanceKm).toBeGreaterThan(10);
    expect(out.actionGeoDistanceKm).toBeLessThan(12);
  });

  it('fuzzyNameMatch accepts substring inside a longer snapshot label', () => {
    expect(fuzzyNameMatch('Natanz', 'Natanz Nuclear Facility')).toBe(true);
  });

  it('fuzzyNameMatch is case-insensitive across landmark/label', () => {
    expect(fuzzyNameMatch('Bandar Abbas', 'bandar abbas naval base')).toBe(true);
  });

  it('fuzzyNameMatch returns false when names are unrelated', () => {
    expect(fuzzyNameMatch('Jobar', 'Damascus airport')).toBe(false);
  });

  it('country filter blocks cross-country substring match', async () => {
    vi.mocked(loadSitesSnapshot).mockReturnValue({
      generatedAt: '2026-04-20T00:00:00Z',
      sites: [{ label: 'Dimona Nuclear Power Plant', country: 'Israel', lat: 31.0, lng: 35.14 }],
      stats: {},
    } as unknown as ReturnType<typeof loadSitesSnapshot>);

    const out = await resolveLocation(
      hierarchy({ country: 'Iran', landmark: 'Nuclear Power Plant' }),
      ctx({ centroidLat: 32.0, centroidLng: 53.0 }),
    );
    expect(out.provenance).not.toBe('own-site-snapshot');
  });

  it('country filter allows match when the snapshot country equals hierarchy.country', async () => {
    vi.mocked(loadSitesSnapshot).mockReturnValue({
      generatedAt: '2026-04-20T00:00:00Z',
      sites: [
        { label: 'Dimona Nuclear Power Plant', country: 'Israel', lat: 31.0, lng: 35.14 },
        { label: 'Bushehr Nuclear Power Plant', country: 'Iran', lat: 28.83, lng: 50.89 },
      ],
      stats: {},
    } as unknown as ReturnType<typeof loadSitesSnapshot>);

    const out = await resolveLocation(
      hierarchy({ country: 'Iran', landmark: 'Nuclear Power Plant' }),
      ctx({ centroidLat: 28.8, centroidLng: 50.9 }),
    );
    expect(out.provenance).toBe('own-site-snapshot');
    expect(out.lat).toBeCloseTo(28.83);
  });

  it('isPoiLandmark recognises POI flavor keywords and rejects generic landmarks', () => {
    expect(isPoiLandmark('Natanz nuclear facility')).toBe(true);
    expect(isPoiLandmark('Al Udeid airbase')).toBe(true);
    expect(isPoiLandmark('Bandar Abbas port')).toBe(true);
    expect(isPoiLandmark('downtown Baghdad')).toBe(false);
    expect(isPoiLandmark('the presidential palace')).toBe(false);
    expect(isPoiLandmark(null)).toBe(false);
  });

  it('exports POI_KEYWORDS as a non-empty readonly list', () => {
    expect(POI_KEYWORDS.length).toBeGreaterThan(5);
    expect(POI_KEYWORDS.includes('nuclear')).toBe(true);
  });

  it('silently skips own-site-snapshot path when both snapshot loaders return null', async () => {
    // landmark='Natanz' has no POI keyword, so only direct path fires.
    vi.mocked(forwardGeocodeConstrained).mockResolvedValue([
      {
        lat: 33.7,
        lng: 51.7,
        displayName: 'Natanz, Iran',
        type: 'village',
        address: { country_code: 'ir' },
      },
    ]);

    const out = await resolveLocation(
      hierarchy({ country: 'Iran', landmark: 'Natanz' }),
      ctx({ centroidLat: 33.7, centroidLng: 51.7 }),
    );

    expect(out.provenance).toBe('nominatim-direct');
  });

  it('runtime: resolver function does not depend on lat/lng from hierarchy (documentary)', async () => {
    expect(() => resolveLocation(hierarchy({ country: 'Iran' }), ctx())).not.toThrow();
  });

  it('haversineKm returns 0 for identical points and >10km for 0.1 lat offset', () => {
    expect(haversineKm(30, 50, 30, 50)).toBe(0);
    const km = haversineKm(30, 50, 30.1, 50);
    expect(km).toBeGreaterThan(10);
    expect(km).toBeLessThan(12);
  });
});

// -----------------------------------------------------------------------------
// Phase 27.4 Plan 05 Task 1 - POI amenity path (D-03)
// -----------------------------------------------------------------------------

describe('Phase 27.4 Plan 05 - POI amenity path (D-03)', () => {
  beforeEach(() => {
    __resetThrottleForTests();
    vi.mocked(loadSitesSnapshot).mockReturnValue(null);
    vi.mocked(loadWaterSnapshot).mockReturnValue(null);
    vi.mocked(forwardGeocodeConstrained).mockReset().mockResolvedValue([]);
    vi.mocked(cacheGetSafe).mockReset().mockResolvedValue(null);
    vi.mocked(cacheSetSafe).mockReset().mockResolvedValue(undefined);
    vi.mocked(callLLM).mockReset().mockResolvedValue({ content: null, routing: [] });
  });

  it('resolves Natanz via POI amenity path when landmark has nuclear keyword', async () => {
    vi.mocked(forwardGeocodeConstrained).mockResolvedValueOnce([
      {
        lat: 33.72,
        lng: 51.73,
        displayName: 'Natanz Nuclear Facility',
        type: 'nuclear',
        address: { country_code: 'ir', country: 'Iran' },
      },
    ]);

    const out = await resolveLocation(
      hierarchy({ country: 'Iran', landmark: 'Natanz nuclear facility' }),
      ctx({ centroidLat: 33.7, centroidLng: 51.7 }),
    );

    expect(out.provenance).toBe('poi-amenity-nominatim');
    expect(out.lat).toBeCloseTo(33.72);
    expect(out.lng).toBeCloseTo(51.73);

    // Phase 27.4.2 P7 (D-11 lever 1): Branch 2 now uses q=<landmark> instead
    // of amenity=<inferred type>. The amenity= mode dropped the place name
    // (Nominatim spec — amenity is mutually exclusive with q) and returned
    // the wrong POI for 9/12 within-20km eval failures. Plan 07 swaps it for
    // a name-based POI search; the POI keyword gate (isPoiLandmark) still
    // routes only POI-flavored landmarks to this branch.
    const calls = vi.mocked(forwardGeocodeConstrained).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const placeName = calls[0]![0];
    const opts = calls[0]![1]!;
    expect(placeName).toBe('Natanz nuclear facility');
    expect(opts.amenity).toBeUndefined();
    expect(opts.countrycodes).toBe('ir');
  });

  it('rejects POI candidate whose address.country_code differs from hierarchy.country', async () => {
    vi.mocked(forwardGeocodeConstrained)
      .mockResolvedValueOnce([
        {
          lat: 40.0,
          lng: 35.0,
          displayName: 'Some place in Turkey',
          type: 'nuclear',
          address: { country_code: 'tr', country: 'Turkey' },
        },
      ])
      .mockResolvedValueOnce([
        {
          lat: 33.3,
          lng: 44.4,
          displayName: 'Direct fallthrough',
          type: 'city',
          address: { country_code: 'ir' },
        },
      ]);

    const out = await resolveLocation(
      hierarchy({ country: 'Iran', landmark: 'Natanz nuclear facility' }),
      ctx({ centroidLat: 33.7, centroidLng: 51.7 }),
    );

    expect(out.provenance).not.toBe('poi-amenity-nominatim');
  });

  it('falls through when POI amenity query returns no results', async () => {
    vi.mocked(forwardGeocodeConstrained)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          lat: 33.3,
          lng: 44.4,
          displayName: 'Direct fallthrough',
          type: 'city',
          address: { country_code: 'ir' },
        },
      ]);

    const out = await resolveLocation(
      hierarchy({ country: 'Iran', landmark: 'Natanz nuclear facility' }),
      ctx({ centroidLat: 33.7, centroidLng: 51.7 }),
    );

    expect(out.provenance).toBe('nominatim-direct');
  });

  it('does not call POI amenity path when landmark has no POI keyword', async () => {
    vi.mocked(forwardGeocodeConstrained).mockResolvedValue([
      {
        lat: 33.3,
        lng: 44.4,
        displayName: 'downtown Baghdad',
        type: 'city',
        address: { country_code: 'iq' },
      },
    ]);

    await resolveLocation(
      hierarchy({ country: 'Iraq', landmark: 'downtown Baghdad' }),
      ctx({ centroidLat: 33.3, centroidLng: 44.4 }),
    );

    const calls = vi.mocked(forwardGeocodeConstrained).mock.calls;
    for (const [, opts] of calls) {
      expect(opts?.amenity).toBeUndefined();
    }
  });

  it('caches POI amenity result in Redis and reuses it on second resolution', async () => {
    const cachedHit = { lat: 33.72, lng: 51.73, displayName: 'Natanz (cached)' };
    vi.mocked(cacheGetSafe).mockResolvedValueOnce(null);
    vi.mocked(forwardGeocodeConstrained).mockResolvedValueOnce([
      {
        lat: 33.72,
        lng: 51.73,
        displayName: 'Natanz Nuclear Facility',
        type: 'nuclear',
        address: { country_code: 'ir' },
      },
    ]);

    const h = hierarchy({ country: 'Iran', landmark: 'Natanz nuclear facility' });
    const c = ctx({ centroidLat: 33.7, centroidLng: 51.7 });

    const first = await resolveLocation(h, c);
    expect(first.provenance).toBe('poi-amenity-nominatim');
    const callsAfterFirst = vi.mocked(forwardGeocodeConstrained).mock.calls.length;
    expect(vi.mocked(cacheSetSafe)).toHaveBeenCalled();

    vi.mocked(cacheGetSafe).mockResolvedValueOnce({
      data: cachedHit,
      stale: false,
      lastFresh: Date.now(),
    });

    const second = await resolveLocation(h, c);
    expect(second.provenance).toBe('poi-amenity-nominatim');
    expect(second.displayName).toBe('Natanz (cached)');
    expect(vi.mocked(forwardGeocodeConstrained).mock.calls.length).toBe(callsAfterFirst);
  });

  it('throttles sequential Nominatim calls to >= 1 req/s', async () => {
    vi.mocked(forwardGeocodeConstrained).mockResolvedValue([
      {
        lat: 33.72,
        lng: 51.73,
        displayName: 'Site A',
        type: 'nuclear',
        address: { country_code: 'ir' },
      },
    ]);

    const h1 = hierarchy({ country: 'Iran', landmark: 'Natanz nuclear facility' });
    const h2 = hierarchy({ country: 'Iran', landmark: 'Bushehr nuclear power plant' });
    const c = ctx({ centroidLat: 33.7, centroidLng: 51.7 });

    const t0 = Date.now();
    await resolveLocation(h1, c);
    await resolveLocation(h2, c);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(900);
  }, 10_000);

  // The geocoder resolves four events at a time. A throttle that reads "time
  // of the last call" and then sleeps lets every concurrent caller read the
  // same timestamp and fire together; each caller must reserve its own slot
  // before it waits.
  it('spaces concurrent resolves a second apart instead of letting them fire together', async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.UTC(2026, 8, 19, 4, 0, 0);
      vi.setSystemTime(t0);
      const hitAtMs: number[] = [];
      vi.mocked(forwardGeocodeConstrained).mockImplementation(async () => {
        hitAtMs.push(Date.now() - t0);
        return [
          {
            lat: 33.72,
            lng: 51.73,
            displayName: 'Site',
            type: 'nuclear',
            address: { country_code: 'ir' },
          },
        ];
      });
      const c = ctx({ centroidLat: 33.7, centroidLng: 51.7 });

      const all = Promise.all([
        resolveLocation(hierarchy({ country: 'Iran', landmark: 'Natanz nuclear facility' }), c),
        resolveLocation(hierarchy({ country: 'Iran', landmark: 'Bushehr nuclear power plant' }), c),
        resolveLocation(hierarchy({ country: 'Iran', landmark: 'Fordow nuclear site' }), c),
      ]);

      await vi.advanceTimersByTimeAsync(0);
      expect(hitAtMs).toEqual([0]);
      await vi.advanceTimersByTimeAsync(999);
      expect(hitAtMs).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(hitAtMs).toEqual([0, 1000]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(hitAtMs).toEqual([0, 1000, 2000]);

      const out = await all;
      expect(out.map((r) => r.provenance)).toEqual([
        'poi-amenity-nominatim',
        'poi-amenity-nominatim',
        'poi-amenity-nominatim',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('negative-caches misses so repeated misses do not re-hit Nominatim', async () => {
    vi.mocked(forwardGeocodeConstrained).mockResolvedValue([]);

    const h = hierarchy({ country: 'Iran', landmark: 'Natanz nuclear facility' });
    const c = ctx({ centroidLat: 33.7, centroidLng: 51.7 });

    const first = await resolveLocation(h, c);
    expect(first.provenance).toBe('gdelt-actiongeo-fallback');
    const setCalls = vi.mocked(cacheSetSafe).mock.calls;
    const hasMissCache = setCalls.some(([key, data]) => {
      return (
        typeof key === 'string' &&
        // Cache prefix bumped to v2 in commit c0791e6 (Phase 27.4.4 Plan 02
        // admin-polygon filter); accept either the legacy or v2 prefix to
        // keep this assertion focused on the miss-cache behavior, not the
        // exact prefix string.
        /geocode:fwd:constrained:(v2:)?poi/.test(key) &&
        data !== null &&
        typeof data === 'object' &&
        (data as { miss?: boolean }).miss === true
      );
    });
    expect(hasMissCache).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Phase 27.4 Plan 05 Task 2 - two-pass verify (D-04)
// -----------------------------------------------------------------------------

describe('Phase 27.4 Plan 05 - two-pass verify (D-04)', () => {
  beforeEach(() => {
    __resetThrottleForTests();
    vi.mocked(loadSitesSnapshot).mockReturnValue(null);
    vi.mocked(loadWaterSnapshot).mockReturnValue(null);
    vi.mocked(forwardGeocodeConstrained).mockReset().mockResolvedValue([]);
    vi.mocked(cacheGetSafe).mockReset().mockResolvedValue(null);
    vi.mocked(cacheSetSafe).mockReset().mockResolvedValue(undefined);
    vi.mocked(callLLM).mockReset().mockResolvedValue({ content: null, routing: [] });
  });

  it('sanity gate fires on precision=city and runs two-pass verify', async () => {
    vi.mocked(forwardGeocodeConstrained)
      .mockResolvedValueOnce([
        {
          lat: 33.5,
          lng: 36.3,
          displayName: 'Damascus',
          type: 'city',
          address: { country_code: 'sy' },
        },
      ])
      .mockResolvedValueOnce([
        {
          lat: 33.5,
          lng: 36.3,
          displayName: 'Damascus center',
          type: 'city',
          address: { country_code: 'sy' },
        },
        {
          lat: 33.52,
          lng: 36.29,
          displayName: 'Jobar neighborhood',
          type: 'suburb',
          address: { country_code: 'sy' },
        },
        {
          lat: 33.48,
          lng: 36.31,
          displayName: 'Other suburb',
          type: 'suburb',
          address: { country_code: 'sy' },
        },
      ]);

    vi.mocked(callLLM).mockResolvedValueOnce({
      content: JSON.stringify({ pick: 2, reasoning: 'matches Jobar' }),
      routing: [],
    });

    const out = await resolveLocation(
      hierarchy({ country: 'Syria', city: 'Damascus' }),
      ctx({
        centroidLat: 33.5,
        centroidLng: 36.3,
        summary: 'Jobar shelling',
        articleTitles: ['Shelling in Jobar'],
      }),
    );

    expect(out.provenance).toBe('nominatim-verified-2pass');
    expect(out.lat).toBeCloseTo(33.52);
    expect(out.lng).toBeCloseTo(36.29);
  });

  it('sanity gate fires when direct hit lies >250km from centroid', async () => {
    vi.mocked(forwardGeocodeConstrained)
      .mockResolvedValueOnce([
        {
          lat: 40.0,
          lng: 50.0,
          displayName: 'Far away',
          type: 'village',
          address: { country_code: 'iq' },
        },
      ])
      .mockResolvedValueOnce([
        {
          lat: 33.0,
          lng: 44.0,
          displayName: 'A',
          type: 'village',
          address: { country_code: 'iq' },
        },
        {
          lat: 33.1,
          lng: 44.1,
          displayName: 'B',
          type: 'village',
          address: { country_code: 'iq' },
        },
        {
          lat: 33.2,
          lng: 44.2,
          displayName: 'C',
          type: 'village',
          address: { country_code: 'iq' },
        },
      ]);
    vi.mocked(callLLM).mockResolvedValueOnce({
      content: JSON.stringify({ pick: 1, reasoning: 'ok' }),
      routing: [],
    });

    const out = await resolveLocation(
      hierarchy({ country: 'Iraq', landmark: 'Some place' }),
      ctx({ centroidLat: 33.0, centroidLng: 44.0 }),
    );

    expect(out.provenance).toBe('nominatim-verified-2pass');
    expect(out.lat).toBeCloseTo(33.0);
  });

  it('sanity gate does not fire on precision=neighborhood and distance <=250km', async () => {
    vi.mocked(forwardGeocodeConstrained).mockResolvedValueOnce([
      {
        lat: 33.5,
        lng: 36.3,
        displayName: 'Jobar neighborhood',
        type: 'suburb',
        address: { country_code: 'sy' },
      },
    ]);

    const out = await resolveLocation(
      hierarchy({ country: 'Syria', city: 'Damascus', neighborhood: 'Jobar' }),
      ctx({ centroidLat: 33.5, centroidLng: 36.3 }),
    );

    expect(out.provenance).toBe('nominatim-direct');
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();
  });

  it('sends reranker schema with pick (1-5) + reasoning (<=100) to callLLM', async () => {
    vi.mocked(forwardGeocodeConstrained)
      .mockResolvedValueOnce([
        {
          lat: 33.5,
          lng: 36.3,
          displayName: 'Damascus',
          type: 'city',
          address: { country_code: 'sy' },
        },
      ])
      .mockResolvedValueOnce([
        { lat: 33.5, lng: 36.3, displayName: 'A', type: 'city', address: { country_code: 'sy' } },
        {
          lat: 33.52,
          lng: 36.29,
          displayName: 'B',
          type: 'suburb',
          address: { country_code: 'sy' },
        },
      ]);
    vi.mocked(callLLM).mockResolvedValueOnce({
      content: JSON.stringify({ pick: 1, reasoning: 'ok' }),
      routing: [],
    });

    await resolveLocation(
      hierarchy({ country: 'Syria', city: 'Damascus' }),
      ctx({ centroidLat: 33.5, centroidLng: 36.3 }),
    );

    expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(callLLM).mock.calls[0]!;
    // Phase 29 Plan 03: callLLM is now freeClaudeRouter.callLLM whose 2nd arg
    // is `schemaText: string` (router uses response_format: json_object). The
    // resolver passes JSON.stringify(RERANKER_JSON_SCHEMA) — parse it back to
    // assert the schema shape is preserved end-to-end.
    const schemaText = call[1] as string;
    expect(typeof schemaText).toBe('string');
    const jsonSchema = JSON.parse(schemaText) as Record<string, unknown>;
    expect(jsonSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        pick: expect.objectContaining({ type: 'integer', minimum: 1, maximum: 5 }),
        reasoning: expect.objectContaining({ type: 'string', maxLength: 100 }),
      }),
      required: expect.arrayContaining(['pick', 'reasoning']),
      additionalProperties: false,
    });
  });

  it('parses reranker response and returns pick-1-based candidate', async () => {
    vi.mocked(forwardGeocodeConstrained)
      .mockResolvedValueOnce([
        {
          lat: 33.5,
          lng: 36.3,
          displayName: 'Damascus',
          type: 'city',
          address: { country_code: 'sy' },
        },
      ])
      .mockResolvedValueOnce([
        { lat: 33.5, lng: 36.3, displayName: 'A', type: 'city', address: { country_code: 'sy' } },
        {
          lat: 33.55,
          lng: 36.35,
          displayName: 'B',
          type: 'suburb',
          address: { country_code: 'sy' },
        },
        { lat: 33.6, lng: 36.4, displayName: 'C', type: 'suburb', address: { country_code: 'sy' } },
      ]);
    vi.mocked(callLLM).mockResolvedValueOnce({
      content: JSON.stringify({ pick: 3, reasoning: 'best match' }),
      routing: [],
    });

    const out = await resolveLocation(
      hierarchy({ country: 'Syria', city: 'Damascus' }),
      ctx({ centroidLat: 33.5, centroidLng: 36.3 }),
    );

    expect(out.provenance).toBe('nominatim-verified-2pass');
    expect(out.lat).toBeCloseTo(33.6);
    expect(out.lng).toBeCloseTo(36.4);
  });

  it('falls back to direct hit when callLLM returns null', async () => {
    vi.mocked(forwardGeocodeConstrained)
      .mockResolvedValueOnce([
        {
          lat: 33.5,
          lng: 36.3,
          displayName: 'Damascus',
          type: 'city',
          address: { country_code: 'sy' },
        },
      ])
      .mockResolvedValueOnce([
        { lat: 33.5, lng: 36.3, displayName: 'A', type: 'city', address: { country_code: 'sy' } },
        {
          lat: 33.55,
          lng: 36.35,
          displayName: 'B',
          type: 'suburb',
          address: { country_code: 'sy' },
        },
      ]);
    vi.mocked(callLLM).mockResolvedValueOnce({ content: null, routing: [] });

    const out = await resolveLocation(
      hierarchy({ country: 'Syria', city: 'Damascus' }),
      ctx({ centroidLat: 33.5, centroidLng: 36.3 }),
    );

    expect(out.provenance).toBe('nominatim-direct');
    expect(out.lat).toBeCloseTo(33.5);
  });

  it('falls back when reranker response fails Zod validation (pick out of range)', async () => {
    vi.mocked(forwardGeocodeConstrained)
      .mockResolvedValueOnce([
        {
          lat: 33.5,
          lng: 36.3,
          displayName: 'Damascus',
          type: 'city',
          address: { country_code: 'sy' },
        },
      ])
      .mockResolvedValueOnce([
        { lat: 33.5, lng: 36.3, displayName: 'A', type: 'city', address: { country_code: 'sy' } },
        {
          lat: 33.55,
          lng: 36.35,
          displayName: 'B',
          type: 'suburb',
          address: { country_code: 'sy' },
        },
      ]);
    vi.mocked(callLLM).mockResolvedValueOnce({
      content: JSON.stringify({ pick: 99, reasoning: 'bad' }),
      routing: [],
    });

    const out = await resolveLocation(
      hierarchy({ country: 'Syria', city: 'Damascus' }),
      ctx({ centroidLat: 33.5, centroidLng: 36.3 }),
    );

    expect(out.provenance).toBe('nominatim-direct');
  });

  it('does not call LLM reranker when fewer than 2 candidates returned', async () => {
    // WR-04: single-candidate verify result is now accepted as a
    // nominatim-verified-2pass hit (no LLM call). Prior behavior cached
    // a miss and fell through to GDELT fallback for 30d — that path no
    // longer exists for length===1.
    vi.mocked(forwardGeocodeConstrained)
      .mockResolvedValueOnce([
        {
          lat: 33.5,
          lng: 36.3,
          displayName: 'Damascus',
          type: 'city',
          address: { country_code: 'sy' },
        },
      ])
      .mockResolvedValueOnce([
        {
          lat: 33.5,
          lng: 36.3,
          displayName: 'Only one',
          type: 'city',
          address: { country_code: 'sy' },
        },
      ]);

    const out = await resolveLocation(
      hierarchy({ country: 'Syria', city: 'Damascus' }),
      ctx({ centroidLat: 33.5, centroidLng: 36.3 }),
    );

    expect(out.provenance).toBe('nominatim-verified-2pass');
    expect(out.lat).toBeCloseTo(33.5);
    expect(out.lng).toBeCloseTo(36.3);
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Phase 27.4.4 Plan 02 (eval quality) — admin-polygon filter
//
// gt-009 (Jurf al-Sakhar) and gt-030 (Al-Nabi Shayth) revealed the resolver
// was accepting Nominatim hits with `type: 'administrative'` (subdistrict /
// municipality polygon centroids) when the hierarchy implied city precision.
// The polygon centroid sits 20+km from the actual settlement.
//
// Fix: when derivePrecision(hierarchy) is city / neighborhood / exact, drop
// `type === 'administrative'` from candidate lists in BOTH the direct path
// (Branch 3) and the verify-2pass path (Branch 4). Region-precision events
// keep them — admin polygons ARE the right answer at state level.
// -----------------------------------------------------------------------------

describe('Phase 27.4.4 — admin-polygon filter (eval misses)', () => {
  beforeEach(() => {
    __resetThrottleForTests();
    vi.mocked(loadSitesSnapshot).mockReturnValue(null);
    vi.mocked(loadWaterSnapshot).mockReturnValue(null);
    vi.mocked(forwardGeocodeConstrained).mockReset().mockResolvedValue([]);
    vi.mocked(cacheGetSafe).mockReset().mockResolvedValue(null);
    vi.mocked(cacheSetSafe).mockReset().mockResolvedValue(undefined);
    vi.mocked(callLLM).mockReset().mockResolvedValue({ content: null, routing: [] });
  });

  it('city precision: rejects single "administrative" hit and falls through to GDELT centroid', async () => {
    // gt-009 reproduction: Jurf al-Sakhar query returns one Nominatim hit,
    // a Subdistrict polygon at 32.87, 44.22. Truth is the town center at
    // 32.71, 44.12 (~20km away).
    vi.mocked(forwardGeocodeConstrained).mockResolvedValue([
      {
        lat: 32.8682,
        lng: 44.2159,
        displayName:
          'Jurf Al Sakhar Subdistrict, Al-Musayyib District, Babil Governorate, 51006, Iraq',
        type: 'administrative',
        address: { country_code: 'iq' },
      },
    ]);

    const out = await resolveLocation(
      hierarchy({ country: 'Iraq', admin1: 'Babil Governorate', city: 'Jurf al-Sakhar' }),
      ctx({ centroidLat: 32.7083, centroidLng: 44.1167 }),
    );

    // With the admin-polygon filter, Branch 3 returns null, Branch 4 sees
    // an empty post-filter candidate list and also returns null. Dispatcher
    // falls through to bellingcat (no coord set) → GDELT centroid (= ctx).
    expect(out.provenance).toBe('gdelt-actiongeo-fallback');
    expect(out.lat).toBeCloseTo(32.7083);
    expect(out.lng).toBeCloseTo(44.1167);
  });

  it('city precision: multi-candidate path strips admin polygon before LLM reranker', async () => {
    // gt-030 reproduction: Al-Nabi Shayth returns [admin/municipality, village].
    // Branch 3 fetches its own list (limit 5) and should pick the village.
    // Branch 4 then sees only the village post-filter and accepts via WR-04
    // single-hit (no LLM call needed).
    vi.mocked(forwardGeocodeConstrained).mockResolvedValue([
      {
        lat: 33.8887,
        lng: 36.1181,
        displayName: 'Nabi Shit, Baalbek District, Baalbek-Hermel Governorate, Lebanon',
        type: 'administrative',
        address: { country_code: 'lb' },
      },
      {
        lat: 33.8727,
        lng: 36.1109,
        displayName:
          'Al Nabi Shayth, Nabi Shit, Baalbek District, Baalbek-Hermel Governorate, Lebanon',
        type: 'village',
        address: { country_code: 'lb' },
      },
    ]);

    const out = await resolveLocation(
      hierarchy({
        country: 'Lebanon',
        admin1: 'Baalbek-Hermel Governorate',
        city: 'Al-Nabi Shayth',
      }),
      ctx({ centroidLat: 33.87, centroidLng: 36.11 }),
    );

    // After admin filter, only the village remains. WR-04 accepts it.
    // No LLM reranker call.
    expect(out.provenance).toBe('nominatim-verified-2pass');
    expect(out.lat).toBeCloseTo(33.8727);
    expect(out.lng).toBeCloseTo(36.1109);
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();
  });

  it('region precision: keeps "administrative" hits (state-level events still resolve)', async () => {
    // Regression guard. A country-only or admin1-only hierarchy implies
    // region precision; the right answer IS the admin polygon centroid.
    // Make sure we don't filter it away.
    vi.mocked(forwardGeocodeConstrained).mockResolvedValue([
      {
        lat: 33.0,
        lng: 44.0,
        displayName: 'Babil Governorate, Iraq',
        type: 'administrative',
        address: { country_code: 'iq' },
      },
    ]);

    const out = await resolveLocation(
      hierarchy({ country: 'Iraq', admin1: 'Babil Governorate' }),
      ctx({ centroidLat: 33.0, centroidLng: 44.0 }),
    );

    // Region precision → admin polygon kept → returned via direct path
    // (sanity gate fires for region too, but verify path also accepts).
    expect(['nominatim-direct', 'nominatim-verified-2pass']).toContain(out.provenance);
    expect(out.lat).toBeCloseTo(33.0);
    expect(out.lng).toBeCloseTo(44.0);
  });
});

// -----------------------------------------------------------------------------
// Phase 27.4.4 Plan 02 dev-pass — Branch 4 gate fix
//
// Live dev surfaced an Islamabad event resolved 1028km off truth via the
// gdelt-actiongeo-fallback path. Root cause: a previous (hung) dev run
// cached {miss: true} for Branch 3's direct query. On replay, Branch 3
// returned null, and Branch 4's gate `(directHit && shouldTrigger…)` skipped
// it entirely — Branch 4 never got a chance to find the city.
//
// Fix: for city or region precision, Branch 4 should run regardless of
// whether Branch 3 returned a hit. The dispatcher gate becomes a precision-
// based check, not a directHit-existence check.
// -----------------------------------------------------------------------------

describe('Phase 27.4.4 — Branch 4 runs even when Branch 3 returns null (city/region)', () => {
  beforeEach(() => {
    __resetThrottleForTests();
    vi.mocked(loadSitesSnapshot).mockReturnValue(null);
    vi.mocked(loadWaterSnapshot).mockReturnValue(null);
    vi.mocked(forwardGeocodeConstrained).mockReset().mockResolvedValue([]);
    vi.mocked(cacheGetSafe).mockReset().mockResolvedValue(null);
    vi.mocked(cacheSetSafe).mockReset().mockResolvedValue(undefined);
    vi.mocked(callLLM).mockReset().mockResolvedValue({ content: null, routing: [] });
  });

  it('city precision: Branch 3 miss-cached → Branch 4 runs and finds the city', async () => {
    // Reproduces the Islamabad regression: Branch 3 sees a cached miss,
    // returns null. Branch 4 (verify-2pass) should still fire because the
    // hierarchy is city-precision and the resolver's job is to find this
    // place even if Branch 3 has stale cache.
    vi.mocked(cacheGetSafe).mockImplementation(async (key) => {
      // Simulate Branch 3's miss-cache for this exact hierarchy.
      if (typeof key === 'string' && key.includes(':direct:')) {
        return { data: { miss: true } as unknown as never, fetchedAt: Date.now() };
      }
      return null;
    });
    // Branch 4's own search returns Islamabad correctly.
    vi.mocked(forwardGeocodeConstrained).mockResolvedValue([
      {
        lat: 33.6938,
        lng: 73.0651,
        displayName: 'Islamabad, Zone 1, Islamabad Capital Territory, 44000, Pakistan',
        type: 'city',
        address: { country_code: 'pk' },
      },
    ]);

    const out = await resolveLocation(
      hierarchy({
        country: 'Pakistan',
        admin1: 'Islamabad Capital Territory',
        city: 'Islamabad',
      }),
      ctx({ centroidLat: 25.38, centroidLng: 68.38 }),
    );

    // Pre-fix: this returned 'gdelt-actiongeo-fallback' at (25.38, 68.38).
    // Post-fix: Branch 4 runs and returns the verify-2pass hit.
    expect(out.provenance).toBe('nominatim-verified-2pass');
    expect(out.lat).toBeCloseTo(33.6938, 3);
    expect(out.lng).toBeCloseTo(73.0651, 3);
  });

  it('region precision: Branch 3 returns null → Branch 4 runs', async () => {
    // For region-only hierarchies (country/admin1 set, no city), Branch 4
    // is also the right escalation when Branch 3 finds nothing.
    let callCount = 0;
    vi.mocked(forwardGeocodeConstrained).mockImplementation(async () => {
      callCount++;
      // First call (Branch 3): empty.
      // Second call (Branch 4): returns the governorate centroid.
      if (callCount === 1) return [];
      return [
        {
          lat: 33.0,
          lng: 44.0,
          displayName: 'Babil Governorate, Iraq',
          type: 'administrative',
          address: { country_code: 'iq' },
        },
      ];
    });

    const out = await resolveLocation(
      hierarchy({ country: 'Iraq', admin1: 'Babil Governorate' }),
      ctx({ centroidLat: 33.5, centroidLng: 44.5 }),
    );

    expect(out.provenance).toBe('nominatim-verified-2pass');
    expect(out.lat).toBeCloseTo(33.0);
    expect(out.lng).toBeCloseTo(44.0);
  });

  it('exact precision: Branch 3 null → Branch 4 does NOT run unless directHit was far', async () => {
    // Regression guard: for exact-precision events the existing gate logic
    // (Branch 4 only triggers if directHit > 250km from centroid) should
    // still apply. With no directHit at all, no Branch 4.
    vi.mocked(forwardGeocodeConstrained).mockResolvedValue([]);

    const out = await resolveLocation(
      hierarchy({
        country: 'Iran',
        landmark: 'Some specific facility',
      }),
      ctx({ centroidLat: 32.0, centroidLng: 53.0 }),
    );

    // Falls through to GDELT centroid because Branch 4 didn't fire.
    expect(out.provenance).toBe('gdelt-actiongeo-fallback');
  });
});

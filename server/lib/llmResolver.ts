/**
 * Phase 27.4 Layered Geocoding Resolver (D-22).
 *
 * Six paths in strict priority order (D-22):
 *   1. own-site-snapshot
 *   2. poi-amenity-nominatim       - Plan 05 (D-03): forwardGeocodeConstrained({amenity}) + country filter + cache
 *   3. nominatim-direct            - Plan 05: forwardGeocodeConstrained (ME viewbox + 22 country codes) + cache
 *   4. nominatim-verified-2pass    - Plan 05 (D-04): sanity-gated LLM reranker (top-5 candidates)
 *   5. bellingcat-coord-passthrough
 *   6. gdelt-actiongeo-fallback
 */

import { z } from 'zod';

import { forwardGeocodeConstrained } from '../adapters/nominatim.js';
import { cacheGetSafe, cacheSetSafe } from '../cache/redis.js';

import { callLLM } from './freeClaudeRouter.js';
import {
  derivePrecision,
  type GeocodeProvenance,
  type LocationHierarchyV2,
  type Precision,
} from './llmSchema.js';
import { logger } from './logger.js';
import { ME_VIEWBOX, ME_COUNTRY_CODES } from './meBounds.js';
import { loadSitesSnapshot } from './sitesSnapshot.js';
import { loadWaterSnapshot } from './waterSnapshot.js';

const log = logger.child({ module: 'llm-resolver' });

// Cache + throttle
//
// 27.4.4 Plan 02 (eval quality): bumped to v2 because filterAdminPolygons
// changes Branch 3 + Branch 4 outputs for city-precision queries. Without
// the version bump, prior 30-day cache entries shadow the fix and the
// admin-polygon hits keep coming back from Redis.
const GEOCODE_CACHE_PREFIX = 'geocode:fwd:constrained:v2:';
const GEOCODE_CACHE_LOGICAL_TTL_MS = 30 * 24 * 3600 * 1000;
const GEOCODE_CACHE_REDIS_TTL_SEC = 30 * 24 * 3600;
const GEOCODE_DELAY_MS = 1000;
let nextNominatimSlotMs = 0;

// Nominatim's usage policy is one request per second. Each caller reserves the
// next free slot synchronously, before it waits, so callers running
// concurrently are spaced a second apart instead of all reading the same
// timestamp and firing together.
async function throttleNominatim(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextNominatimSlotMs);
  nextNominatimSlotMs = slot + GEOCODE_DELAY_MS;
  if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
}

/**
 * Test-only: reset the module-level throttle timestamp so tests don't
 * accumulate wait time between invocations. Safe to call from test setup;
 * no-op in production.
 */
export function __resetThrottleForTests(): void {
  nextNominatimSlotMs = 0;
}

function cacheKey(
  kind: 'poi' | 'direct' | 'verify',
  parts: Record<string, string | undefined>,
): string {
  const ordered = Object.keys(parts)
    .sort()
    .filter((k) => parts[k] !== undefined)
    .map((k) => `${k}=${parts[k]}`)
    .join('|');
  return `${GEOCODE_CACHE_PREFIX}${kind}:${ordered}`;
}

/** Per-event resolver inputs threaded through the 6 resolver paths — centroid + optional bellingcat hint + headline / summary hints. */
export interface ResolveContext {
  centroidLat: number;
  centroidLng: number;
  bellingcatCoord?: { lat: number; lng: number } | null;
  articleTitles?: string[];
  summary?: string;
}

/** Resolver output — final lat/lng + provenance + actionGeo distance check + Nominatim display name. */
export interface ResolvedLocation {
  lat: number;
  lng: number;
  provenance: GeocodeProvenance;
  actionGeoDistanceKm: number;
  displayName: string;
}

/** Great-circle distance between two (lat, lng) pairs in kilometres (Haversine). */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Landmark substrings that route a hierarchy into Branch 2 (POI-amenity Nominatim path). */
export const POI_KEYWORDS: readonly string[] = [
  'nuclear',
  'airbase',
  'air base',
  'naval base',
  'naval',
  'airport',
  'airfield',
  'port',
  'port of',
  'military base',
  'military complex',
  'garrison',
  'barracks',
  'dam',
  'reservoir',
  'refinery',
  'power plant',
  'power station',
  'pipeline',
  'oil terminal',
  'substation',
] as const;

/** True if `landmark` contains a POI_KEYWORDS substring (word-boundary match, case-insensitive). */
export function isPoiLandmark(landmark: string | null): boolean {
  if (!landmark) return false;
  const lower = landmark.toLowerCase();
  return POI_KEYWORDS.some((kw) => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, 'i').test(lower);
  });
}

// Phase 27.4.2 P7 (D-11 lever 1): POI_AMENITY_MAP and inferAmenity removed.
// The Branch 2 path now uses q=<landmark> instead of amenity=<inferred type>
// (see resolveViaPoiAmenity below for rationale). The type-inference table
// became dead code with that change. POI_KEYWORDS above retains its role as
// the gate for routing landmarks into Branch 2.

/** Loose case-insensitive substring match between landmark + snapshot label (returns false for landmarks < 3 chars). */
export function fuzzyNameMatch(landmark: string, snapshotLabel: string): boolean {
  const a = landmark.trim().toLowerCase();
  const b = snapshotLabel.trim().toLowerCase();
  if (a.length < 3) return false;
  return b.includes(a) || a.includes(b);
}

function countryMatches(
  snapshotCountry: string | null | undefined,
  hierarchyCountry: string | null,
): boolean {
  if (!hierarchyCountry) return true;
  if (!snapshotCountry) return false;
  return snapshotCountry.toLowerCase() === hierarchyCountry.toLowerCase();
}

function countryCodeFromName(country: string | null): string | undefined {
  if (!country) return undefined;
  const map: Record<string, string> = {
    iran: 'ir',
    iraq: 'iq',
    syria: 'sy',
    lebanon: 'lb',
    israel: 'il',
    palestine: 'ps',
    jordan: 'jo',
    egypt: 'eg',
    'saudi arabia': 'sa',
    uae: 'ae',
    'united arab emirates': 'ae',
    bahrain: 'bh',
    kuwait: 'kw',
    oman: 'om',
    qatar: 'qa',
    yemen: 'ye',
    turkey: 'tr',
    afghanistan: 'af',
    pakistan: 'pk',
    turkmenistan: 'tm',
    azerbaijan: 'az',
    armenia: 'am',
    georgia: 'ge',
  };
  return map[country.toLowerCase()];
}

interface SnapshotHit {
  lat: number;
  lng: number;
  displayName: string;
}

function resolveFromSnapshot(hierarchy: LocationHierarchyV2): SnapshotHit | null {
  if (!hierarchy.landmark) return null;
  const sites = loadSitesSnapshot();
  if (sites?.sites) {
    for (const site of sites.sites) {
      const s = site as { country?: string; label?: string; lat?: number; lng?: number };
      if (!countryMatches(s.country ?? null, hierarchy.country)) continue;
      const label = s.label ?? '';
      if (fuzzyNameMatch(hierarchy.landmark, label)) {
        return { lat: s.lat as number, lng: s.lng as number, displayName: label };
      }
    }
  }
  const water = loadWaterSnapshot();
  if (water?.facilities) {
    for (const f of water.facilities) {
      const w = f as { country?: string; label?: string; lat?: number; lng?: number };
      if (!countryMatches(w.country ?? null, hierarchy.country)) continue;
      const label = w.label ?? '';
      if (fuzzyNameMatch(hierarchy.landmark, label)) {
        return { lat: w.lat as number, lng: w.lng as number, displayName: label };
      }
    }
  }
  return null;
}

async function resolveViaPoiAmenity(hierarchy: LocationHierarchyV2): Promise<SnapshotHit | null> {
  if (!hierarchy.landmark) return null;
  // Phase 27.4.2 P7 (D-11 lever 1): the POI keyword gate (isPoiLandmark)
  // still routes named-POI landmarks to this branch, but the Nominatim call
  // now uses q=<full landmark> instead of amenity=<inferred type>. The
  // amenity= mode is mutually exclusive with q= per the Nominatim API spec
  // (see https://nominatim.org/release-docs/latest/api/Search/#structured-query
  // — "Cannot be combined with the q=<query> parameter") which means the
  // pre-Plan-07 path was sending only the inferred type and dropping the
  // place name. Result: Nominatim returned the FIRST matching amenity in
  // the country-code constraint instead of the specific named POI. Spot
  // checks against the 50-event ground-truth corpus showed this delivered
  // 100s-of-km-wrong coordinates for 9 of 12 within-20km failures
  // (gt-007/021/022/028/038/041/043/047/048). Switching to q=<landmark>
  // either resolves the named POI correctly (proven for Bushehr Nuclear
  // Power Plant, Ben Gurion Airport, Tiyas Air Base) or returns 0 results
  // → falls through to nominatim-direct → gdelt-actiongeo-fallback. Either
  // outcome is strictly better than the prior wrong-amenity match.
  const cc = countryCodeFromName(hierarchy.country);
  const key = cacheKey('poi', { country: cc, landmark: hierarchy.landmark });
  const cached = await cacheGetSafe<SnapshotHit | { miss: true }>(
    key,
    GEOCODE_CACHE_LOGICAL_TTL_MS,
  );
  if (cached?.data) {
    if ((cached.data as { miss?: boolean }).miss) return null;
    return cached.data as SnapshotHit;
  }
  try {
    // WR-01: throttle only after cache-miss is confirmed so that a
    // cache-hit path does not update lastNominatimCallMs and let a
    // subsequent uncached call bypass the 1 req/s Nominatim policy.
    await throttleNominatim();
    const candidates = await forwardGeocodeConstrained(hierarchy.landmark, {
      countrycodes: cc ?? ME_COUNTRY_CODES,
      viewbox: ME_VIEWBOX,
      addressdetails: true,
      limit: 3,
    });
    const filtered = candidates.filter((c) => {
      if (!cc) return true;
      return !c.address?.country_code || c.address.country_code === cc;
    });
    if (filtered.length === 0) {
      await cacheSetSafe(key, { miss: true }, GEOCODE_CACHE_REDIS_TTL_SEC);
      return null;
    }
    const first = filtered[0]!;
    const hit: SnapshotHit = { lat: first.lat, lng: first.lng, displayName: first.displayName };
    await cacheSetSafe(key, hit, GEOCODE_CACHE_REDIS_TTL_SEC);
    return hit;
  } catch (err) {
    log.warn({ err, landmark: hierarchy.landmark }, 'resolveViaPoiAmenity failed');
    return null;
  }
}

function buildDisplayNameForQuery(hierarchy: LocationHierarchyV2): string | null {
  const parts: string[] = [];
  if (hierarchy.landmark) parts.push(hierarchy.landmark);
  if (hierarchy.neighborhood) parts.push(hierarchy.neighborhood);
  if (hierarchy.city) parts.push(hierarchy.city);
  if (hierarchy.admin1) parts.push(hierarchy.admin1);
  if (hierarchy.country) parts.push(hierarchy.country);
  if (parts.length === 0) return null;
  return parts.join(', ');
}

// Phase 27.4.4 Plan 02 (eval quality fix). Nominatim's `type: 'administrative'`
// covers admin polygons (subdistrict / district / governorate / municipality
// boundary objects). When the hierarchy resolves a city or finer, the polygon
// centroid is the wrong answer — gt-009 picked up a Subdistrict at 32.87,44.22
// that sits 20km from the actual town. For region-precision queries we keep
// admin polygons; that IS the right answer at state level.
function filterAdminPolygons<T extends { type: string }>(
  candidates: readonly T[],
  precision: Precision,
): T[] {
  if (precision === 'region') return [...candidates];
  return candidates.filter((c) => c.type !== 'administrative');
}

async function resolveViaNominatimDirect(
  hierarchy: LocationHierarchyV2,
): Promise<SnapshotHit | null> {
  const query = buildDisplayNameForQuery(hierarchy);
  if (!query) return null;
  const cc = countryCodeFromName(hierarchy.country);
  const key = cacheKey('direct', { q: query, country: cc });
  const cached = await cacheGetSafe<SnapshotHit | { miss: true }>(
    key,
    GEOCODE_CACHE_LOGICAL_TTL_MS,
  );
  if (cached?.data) {
    if ((cached.data as { miss?: boolean }).miss) return null;
    return cached.data as SnapshotHit;
  }
  try {
    // WR-01: throttle only after cache-miss is confirmed so that a
    // cache-hit path does not update lastNominatimCallMs and let a
    // subsequent uncached call bypass the 1 req/s Nominatim policy.
    await throttleNominatim();
    // 27.4.4: bumped limit 1 → 5 so the admin-polygon filter can fall through
    // to the next-best candidate (e.g. gt-030 has [admin/municipality, village]
    // and we want the village).
    const candidates = await forwardGeocodeConstrained(query, {
      countrycodes: cc ?? ME_COUNTRY_CODES,
      viewbox: ME_VIEWBOX,
      limit: 5,
    });
    const filtered = filterAdminPolygons(candidates, derivePrecision(hierarchy));
    if (filtered.length === 0) {
      await cacheSetSafe(key, { miss: true }, GEOCODE_CACHE_REDIS_TTL_SEC);
      return null;
    }
    const first = filtered[0]!;
    const hit: SnapshotHit = { lat: first.lat, lng: first.lng, displayName: first.displayName };
    await cacheSetSafe(key, hit, GEOCODE_CACHE_REDIS_TTL_SEC);
    return hit;
  } catch (err) {
    log.warn({ err, query }, 'nominatim-direct failed');
    return null;
  }
}

// Branch 4: nominatim-verified-2pass (D-04)
const rerankerResponseSchema = z
  .object({
    pick: z.number().int().min(1).max(5),
    reasoning: z.string().max(100),
  })
  .strict();

const RERANKER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    pick: { type: 'integer', minimum: 1, maximum: 5 },
    reasoning: { type: 'string', maxLength: 100 },
  },
  required: ['pick', 'reasoning'],
  additionalProperties: false,
};

const RERANKER_SYSTEM_PROMPT =
  'You are picking the geocoding result most consistent with a conflict-event description. ' +
  'Output only JSON matching the schema. Do NOT invent coordinates.';

function buildRerankerUserPrompt(
  hierarchy: LocationHierarchyV2,
  candidates: Array<{ lat: number; lng: number; displayName: string; type: string }>,
  ctx: ResolveContext,
): string {
  const lines: string[] = [];
  const hierarchyStr = [
    hierarchy.landmark,
    hierarchy.neighborhood,
    hierarchy.city,
    hierarchy.admin1,
    hierarchy.country,
  ]
    .filter(Boolean)
    .join(', ');
  lines.push(
    `You extracted the location "${hierarchyStr}". Nominatim returned ${candidates.length} candidates.`,
  );
  lines.push('Pick the one most consistent with this event context:');
  lines.push('');
  if (ctx.summary) lines.push(`Summary: ${ctx.summary.slice(0, 400)}`);
  if (ctx.articleTitles && ctx.articleTitles.length > 0) {
    lines.push('Article titles:');
    for (const t of ctx.articleTitles.slice(0, 3)) lines.push(`  - ${t.slice(0, 140)}`);
  }
  lines.push('');
  lines.push('Candidates:');
  candidates.forEach((c, i) => {
    lines.push(
      `  ${i + 1}. ${c.displayName} [${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}] (${c.type})`,
    );
  });
  lines.push('');
  lines.push('Respond with JSON: { "pick": <1-N>, "reasoning": "<=100 chars" }');
  return lines.join('\n');
}

// shouldTriggerTwoPassVerify removed in Phase 27.4.4 Plan 02 dev-pass — its
// logic is inlined in resolveLocation's Branch 4 gate so we can let Branch 4
// run independently of whether Branch 3 returned a hit. See the long comment
// above the inlined gate for the rationale.

async function resolveViaVerifiedTwoPass(
  hierarchy: LocationHierarchyV2,
  ctx: ResolveContext,
): Promise<SnapshotHit | null> {
  const query = buildDisplayNameForQuery(hierarchy);
  if (!query) return null;
  const cc = countryCodeFromName(hierarchy.country);
  const key = cacheKey('verify', { q: query, country: cc });
  const cached = await cacheGetSafe<SnapshotHit | { miss: true }>(
    key,
    GEOCODE_CACHE_LOGICAL_TTL_MS,
  );
  if (cached?.data) {
    if ((cached.data as { miss?: boolean }).miss) return null;
    return cached.data as SnapshotHit;
  }
  try {
    // WR-01: throttle only after cache-miss is confirmed so that a
    // cache-hit path does not update lastNominatimCallMs and let a
    // subsequent uncached call bypass the 1 req/s Nominatim policy.
    await throttleNominatim();
    const rawCandidates = await forwardGeocodeConstrained(query, {
      countrycodes: cc ?? ME_COUNTRY_CODES,
      viewbox: ME_VIEWBOX,
      limit: 5,
      addressdetails: true,
    });
    // 27.4.4 Plan 02 (eval quality fix): drop admin-polygon hits when
    // hierarchy implies city precision or finer. Filter happens before
    // WR-04 single-hit acceptance AND before the LLM reranker, so the
    // model never sees a polygon-centroid candidate that would mislead it.
    const candidates = filterAdminPolygons(rawCandidates, derivePrecision(hierarchy));
    if (candidates.length === 0) {
      await cacheSetSafe(key, { miss: true }, GEOCODE_CACHE_REDIS_TTL_SEC);
      return null;
    }
    if (candidates.length === 1) {
      // WR-04: single unambiguous Nominatim result — accept without LLM
      // reranking. The 2-pass reranker exists to disambiguate; one
      // candidate needs no disambiguation. Caching a miss here would
      // wrongly route this query to the lower-quality GDELT fallback for
      // the next 30d.
      const only = candidates[0]!;
      const hit: SnapshotHit = {
        lat: only.lat,
        lng: only.lng,
        displayName: only.displayName,
      };
      await cacheSetSafe(key, hit, GEOCODE_CACHE_REDIS_TTL_SEC);
      return hit;
    }
    const userPrompt = buildRerankerUserPrompt(hierarchy, candidates, ctx);
    // Phase 29 Plan 03 (Pitfall 3 fix): callLLM imported from
    // ./freeClaudeRouter.js. Its signature is
    //   (messages, schemaText: string, opts?) => Promise<{content, routing, ...}>
    // — not the legacy `(messages, jsonSchema) => string | null` shape. The
    // schema text is unused by the router (response_format=json_object) so we
    // pass an empty string; Zod still enforces the {pick, reasoning} contract
    // below. We unwrap `.content` so the rest of this function keeps treating
    // `raw` as `string | null`.
    const routerResult = await callLLM(
      [
        { role: 'system', content: RERANKER_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      JSON.stringify(RERANKER_JSON_SCHEMA),
    );
    const raw = routerResult.content;
    if (!raw) {
      await cacheSetSafe(key, { miss: true }, GEOCODE_CACHE_REDIS_TTL_SEC);
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const validated = rerankerResponseSchema.safeParse(parsed);
    if (!validated.success) {
      log.warn({ issues: validated.error.issues }, 'reranker response failed Zod parse');
      return null;
    }
    const idx = validated.data.pick - 1;
    if (idx < 0 || idx >= candidates.length) return null;
    const picked = candidates[idx]!;
    const hit: SnapshotHit = { lat: picked.lat, lng: picked.lng, displayName: picked.displayName };
    await cacheSetSafe(key, hit, GEOCODE_CACHE_REDIS_TTL_SEC);
    return hit;
  } catch (err) {
    log.warn({ err, query }, 'two-pass verify failed');
    return null;
  }
}

function resolveViaBellingcat(ctx: ResolveContext): SnapshotHit | null {
  if (!ctx.bellingcatCoord) return null;
  return {
    lat: ctx.bellingcatCoord.lat,
    lng: ctx.bellingcatCoord.lng,
    displayName: 'Bellingcat-reported coordinate',
  };
}

function resolveViaActionGeoFallback(ctx: ResolveContext): SnapshotHit {
  return {
    lat: ctx.centroidLat,
    lng: ctx.centroidLng,
    displayName: 'GDELT ActionGeo centroid',
  };
}

/** 6-path geocode resolver — never returns a coord without provenance; routes through own-site-snapshot → POI-amenity → Nominatim direct → 2-pass verified → GDELT ActionGeo fallback → Bellingcat passthrough. */
export async function resolveLocation(
  hierarchy: LocationHierarchyV2,
  ctx: ResolveContext,
): Promise<ResolvedLocation> {
  // Branch 1
  try {
    const hit = resolveFromSnapshot(hierarchy);
    if (hit) {
      return {
        ...hit,
        provenance: 'own-site-snapshot',
        actionGeoDistanceKm: haversineKm(hit.lat, hit.lng, ctx.centroidLat, ctx.centroidLng),
      };
    }
  } catch (err) {
    log.warn({ err }, 'own-site-snapshot path threw');
  }

  // Branch 2
  if (isPoiLandmark(hierarchy.landmark)) {
    try {
      const hit = await resolveViaPoiAmenity(hierarchy);
      if (hit) {
        return {
          ...hit,
          provenance: 'poi-amenity-nominatim',
          actionGeoDistanceKm: haversineKm(hit.lat, hit.lng, ctx.centroidLat, ctx.centroidLng),
        };
      }
    } catch (err) {
      log.warn({ err }, 'poi-amenity-nominatim path threw');
    }
  }

  // Branch 3
  let directHit: SnapshotHit | null = null;
  try {
    directHit = await resolveViaNominatimDirect(hierarchy);
  } catch (err) {
    log.warn({ err }, 'nominatim-direct path threw');
  }

  // Branch 4 — Phase 27.4.4 Plan 02 dev-pass.
  //
  // Pre-fix gate: `directHit && shouldTriggerTwoPassVerify(...)`. When Branch 3
  // returned null (legitimate empty result OR a 30-day cached miss from a
  // previously-broken run), Branch 4 was skipped entirely. Live dev surfaced
  // an Islamabad event resolved 1028km off truth via the GDELT-centroid
  // fallback for exactly this reason.
  //
  // Post-fix: Branch 4 runs whenever city / region precision warrants it,
  // independent of whether Branch 3 found anything. For exact precision the
  // existing distance check still applies and requires a directHit.
  const precision = derivePrecision(hierarchy);
  const shouldVerify =
    precision === 'city' ||
    precision === 'region' ||
    precision === 'neighborhood' ||
    (directHit !== null &&
      haversineKm(directHit.lat, directHit.lng, ctx.centroidLat, ctx.centroidLng) > 250);

  if (shouldVerify) {
    try {
      const verified = await resolveViaVerifiedTwoPass(hierarchy, ctx);
      if (verified) {
        return {
          ...verified,
          provenance: 'nominatim-verified-2pass',
          actionGeoDistanceKm: haversineKm(
            verified.lat,
            verified.lng,
            ctx.centroidLat,
            ctx.centroidLng,
          ),
        };
      }
    } catch (err) {
      log.warn({ err }, 'two-pass verify path threw; accepting direct hit');
    }
  }

  if (directHit) {
    return {
      ...directHit,
      provenance: 'nominatim-direct',
      actionGeoDistanceKm: haversineKm(
        directHit.lat,
        directHit.lng,
        ctx.centroidLat,
        ctx.centroidLng,
      ),
    };
  }

  // Branch 5
  try {
    const hit = resolveViaBellingcat(ctx);
    if (hit) {
      return {
        ...hit,
        provenance: 'bellingcat-coord-passthrough',
        actionGeoDistanceKm: haversineKm(hit.lat, hit.lng, ctx.centroidLat, ctx.centroidLng),
      };
    }
  } catch (err) {
    log.warn({ err }, 'bellingcat path threw');
  }

  // Branch 6
  const hit = resolveViaActionGeoFallback(ctx);
  return { ...hit, provenance: 'gdelt-actiongeo-fallback', actionGeoDistanceKm: 0 };
}

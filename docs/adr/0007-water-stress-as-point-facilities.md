# ADR-0007: Water stress as point facilities, not polygon fills

**Status:** Accepted
**Date:** 2026-03-?? (Phase 26, mid-phase design pivot)
**Deciders:** solo author

## Context

Phase 26 ("Water Stress Layer") added water resource stress as a new
visualization layer on the map. The authoritative open dataset is the
**WRI Aqueduct 4.0** database, which ships as 6377 basin-level
polygons with ~20 water-stress indicators per basin (baseline water
stress, drought risk, groundwater depletion, seasonal variability,
etc.) plus metadata. Each basin covers anywhere from a single
watershed to a large regional aquifer.

The initial design (from the Phase 26 CONTEXT document) assumed
polygon fills overlaid on the map — color each basin by its composite
stress score, drape over terrain, done. Two problems surfaced as soon
as the first prototype landed:

1. **Polygon fills obscure the entity layers underneath.** The map
   already carries flights, ships, events, sites, political fills,
   ethnic hatches, and terrain color-relief. Adding another full-area
   fill layer on top of that stack makes the entity dots and icons
   illegible, especially in the Middle East where basin boundaries
   cut across every country.
2. **Users care about specific facilities, not whole basins.** The
   "actionable unit" for this layer — the thing a user clicks on,
   reads a detail panel for, adds a proximity alert to — is a
   specific dam, reservoir, treatment plant, or desalination
   facility. A basin is an abstraction; a facility is a target. A
   reviewer looking at the map wants to see "this dam is under
   stress," not "this 50 000 km² area is somewhat stressed."

This mid-phase realization forced a design pivot. The Phase 26.1
refinement phase was inserted specifically to absorb the pivot and
re-orient the layer around facility-level visualization.

## Decision

**Render water stress as point features at the location of specific
facilities**, not as polygon fills covering basins. Each facility
inherits its basin's stress score via a lookup; the point is colored
on a continuous gradient from black (extreme stress) to light blue
(healthy); rivers are rendered as colored line features on top of
the facility points.

Concretely:

- **Facility data** comes from OpenStreetMap via Overpass
  (`server/adapters/overpass-water.ts`), filtered to ~4300 _named_
  facilities across 5 types: dam, reservoir, water treatment plant,
  canal, and desalination plant. Unnamed facilities are excluded
  because they're too numerous to render legibly and rarely carry
  interesting metadata.
- **Basin lookup** (`server/lib/basinLookup.ts`) assigns each
  facility to its nearest WRI Aqueduct basin via haversine distance
  to country-centroid-median-stress, as a pragmatic approximation
  when Aqueduct's CSV lacks lat/lng centroids for its own polygons.
  See the discussion under Alternatives for why this trade-off was
  accepted.
- **Composite health score** (`src/lib/waterStress.ts`) combines
  the WRI baseline stress (75 % weight) with an Open-Meteo
  precipitation anomaly modifier (25 % weight), clamped to [0, 1].
  The two signals capture the static structural stress and the
  dynamic recent-weather contribution respectively.
- **Color gradient** is a 5-stop ramp from dark purple `[40, 20, 60]`
  (black floor, visible on dark terrain) through blue to healthy
  light blue. `stressToRGBA()` in `src/lib/waterStress.ts` does the
  interpolation. A separate score of 0 (destroyed) is handled
  externally by `useWaterLayers` via the attack-status overlay, not
  inside the gradient, so the scoring stays pure.
- **Rivers** are a separate set of 6 major rivers (Tigris, Euphrates,
  Nile, Jordan, Karun, Litani) rendered as GeoJSON line features
  stress-colored by the watershed they belong to. Karun and Litani
  are manually defined because they're not in the Natural Earth 10m
  dataset that provides the other four.
- **Desalination plants** migrated out of the `sites` layer entirely
  during Phase 26 — they were originally a `SiteType` value
  alongside nuclear/naval/oil/airbase, but they belong semantically
  with water facilities. The `SiteType` enum dropped `desalination`
  and the `WaterFacilityType` picked it up.
- **No polygon layer at all.** WRI Aqueduct basin polygons are loaded
  to seed the basin lookup but never rendered to the map.

## Consequences

### Positive

- **Facilities are the actionable unit** users care about. Every
  interaction on the water layer — click, hover, proximity alert,
  search `type:dam` — targets a specific facility with a name,
  operator, and coordinates.
- **Doesn't obscure other layers.** Points render above terrain but
  below the entity tooltip layer. Flights and ships remain legible
  even with the water layer active.
- **Cleaner visual hierarchy.** The continuous color gradient reads
  as "this place is stressed" at a glance without the Rorschach-test
  problem of trying to read polygon shapes. Users look at the color
  of the dot, not the shape of the surrounding region.
- **Search integration is cleaner.** Tag prefixes like
  `type:dam`, `stress:high`, `name:Karun`, `near:Tehran` work
  naturally over point features. Polygon search would have required
  either centroid-based hits or a containment test.
- **Proximity alert system reuses the site pattern.** Water
  facilities plug into the same 50 km proximity alert pipeline as
  site entities via a `waterToSiteLike` adapter. No new alert code
  path.
- **Attack status cross-references work the same way as sites.** A
  facility within 5 km of a recent GDELT event gets an attacked
  status. Same code path as `src/lib/attackStatus.ts`, no new logic.

### Negative

- **Facilities are sparse compared to basin coverage.** ~4300 named
  facilities is a lot for rendering but sparse compared to 6377
  basins that each cover thousands of km². Large basins with no
  facilities have no visual representation on the map — the user
  can't see "this whole region is stressed" at a glance, only
  "these specific facilities in the region are stressed."
- **Composite stress is per-facility, not per-area.** A user can't
  ask "what's the stress level of this point on the map if I click
  somewhere random?" — they can only inspect facilities that exist
  in the dataset.
- **Basin lookup by country-centroid-median-stress is coarse.** WRI
  Aqueduct's CSV doesn't include basin polygon centroids, so the
  `basinLookup.ts` uses haversine distance to a country's own
  centroid and picks the median-stress basin in that country as a
  fallback. This is labeled as `TODO(26.2)` tech debt in the
  architecture diagrams and is accurate enough for visualization
  purposes but would need a proper polygon-containment test for any
  analytical use case.
- **Overpass query for 5 facility types across the Middle East bbox
  is expensive.** Phase 26.1 had to add a core/extended country
  split (12 core countries must succeed, 11 extended are
  best-effort) plus a 30-second route-level timeout that returns
  an empty array with `stale: true` rather than 500 on Overpass
  failure. See `docs/runbook.md` "Overpass API
  timeout" for the operational contract.
- **Gulf region coverage is incomplete.** A Phase 26.1 desalination
  audit found major Gulf desalination plants missing from
  OpenStreetMap entirely — Israel, Kuwait, and Qatar have no
  desalination facilities tagged in OSM despite being heavy
  desalination users in reality. This is an upstream data quality
  issue that the adapter can't fix; documented as report-only per
  user decision.

### Neutral

- **Water facility icons are custom.** Dam (trapezoid), reservoir
  (oval), treatment plant (building + tank), desalination (factory +
  droplet). Canal and treatment plants originally used a diamond
  placeholder. Rivers use serif italic labels to distinguish from
  the ethnic layer's sans-serif labels.
- **Dual-cache pattern.** `water:facilities` at 24 h TTL (Overpass
  data is static) and `water:precip` at 6 h TTL (precipitation
  anomalies update more frequently) are separate Redis keys. See
  [`server/routes/water.ts`](../../server/routes/water.ts) and the
  Water data flow in
  `docs/architecture/data-flows.md`.

## Alternatives Considered

- **Polygon fills with low alpha over the terrain layer** —
  rejected. Low alpha reduces the obscuring problem but doesn't
  eliminate it, and the Rorschach-test readability problem of
  interpreting basin shapes remains. Tried this in a prototype
  before pivoting.
- **Basin centroids as point features** — rejected. The centroid
  of a basin isn't an actionable unit. Users asking "what's stressed
  near me?" get an answer that's geographically arbitrary (the
  center of a multi-state watershed) rather than useful.
- **No water visualization at all** — rejected. The layer was a
  user-requested feature in the Phase 26 CONTEXT document; removing
  it because the first design didn't work would throw out a
  legitimate product requirement.
- **Hybrid: polygon outlines (no fills) plus facility points** —
  considered. Polygon outlines might communicate "this whole area
  is stressed" without obscuring entities. Deferred as a possible
  future enhancement if user feedback says the facility-only view
  misses regional context. The current build ships facility-only.
- **WaterGAP or Aquastat instead of WRI Aqueduct** — rejected.
  WaterGAP is academic and gated, Aquastat has coarser spatial
  granularity, and WRI Aqueduct 4.0 was the most recently updated
  open dataset with the best metadata for a visualization use case.

## References

- [`server/adapters/overpass-water.ts`](../../server/adapters/overpass-water.ts) —
  Overpass query with core/extended country split.
- [`server/lib/basinLookup.ts`](../../server/lib/basinLookup.ts) —
  nearest-country-centroid-median-stress assignment (labeled
  `TODO(26.2)` for a future polygon-containment upgrade).
- [`src/lib/waterStress.ts`](../../src/lib/waterStress.ts) —
  `compositeHealth` formula and `stressToRGBA()` interpolation.
- [`src/data/aqueduct-basins.json`](../../src/data/aqueduct-basins.json) —
  6377-entry pre-processed basin dataset.
- [`src/data/rivers.json`](../../src/data/rivers.json) — 6 major
  rivers as GeoJSON line features.
- [`src/hooks/useWaterLayers.ts`](../../src/hooks/useWaterLayers.ts) —
  deck.gl GeoJsonLayer (rivers) + IconLayer (facilities) + TextLayer
  (river labels).
- [`src/components/detail/WaterFacilityDetail.tsx`](../../src/components/detail/WaterFacilityDetail.tsx) —
  detail panel with all Aqueduct indicators, precipitation, attack
  status.
- `docs/architecture/data-flows.md` —
  water data flow sequence diagram.
- Phase 26 and 26.1 CONTEXT / SUMMARY
  (`.planning/phases/26-water-stress-layer/`,
  `.planning/phases/26.1-water-layer-refinements/`).

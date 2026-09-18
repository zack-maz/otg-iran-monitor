# ADR-0008: Ethnic distribution via GeoEPR 2021 with hatched overlays

**Status:** Accepted
**Date:** 2026-03-?? (Phase 25, Ethnic Distribution Layer)
**Deciders:** solo author

## Context

Phase 25 added an ethnic distribution layer to the map: polygons
showing where major ethnic groups (Kurds, Arabs, Persians, Baloch,
Turkmen, Druze, Alawite, Yazidi, Assyrians, Pashtun) live across the
Greater Middle East. This was a user-requested layer motivated by
the observation that many conflict events align with ethnic
boundaries — Kurdish regions in Turkey/Syria/Iraq/Iran, Druze in
Lebanon/Syria/Israel, Baloch across Iran/Pakistan — and visualizing
those boundaries helps explain the spatial pattern of events.

Two orthogonal problems had to be solved:

1. **Where does the data come from?** Hand-curating polygons from
   published maps (Wikipedia, Encyclopedia Britannica, academic
   atlases) is the fastest path to a first cut but is unreliable,
   hard to cite, and hard to update. The polygons would also not
   have authoritative population counts or group definitions. A
   portfolio project that claims "data-driven" can't ship
   hand-drawn polygons as its data layer.
2. **How does the rendering not clash with the political layer?**
   Phase 24 had just shipped the political alignment layer — solid
   faction-colored fills (US-aligned blue, Iran-aligned red, neutral
   gray) at ~15 % alpha. A second fill layer with ethnic colors on
   top would collide visually with political fills and reduce both
   to a muddy wash. The two layers need to be readable
   simultaneously.

## Decision

### Data source: GeoEPR 2021 (ETH Zurich)

Use the [**Geo-Referencing of Ethnic Power Relations (GeoEPR) 2021**
dataset](https://icr.ethz.ch/data/epr/geoepr/) from ETH Zurich's
International Conflict Research group. GeoEPR is a peer-reviewed
academic dataset mapping politically relevant ethnic groups to
spatial polygons, updated through 2021, with citations and
well-documented group definitions.

Extraction pipeline:

- `scripts/extract-ethnic-data.ts` reads the GeoEPR shapefile,
  filters to the Middle East bounding box (1685 total features →
  596 in-bbox), simplifies polygons via Douglas-Peucker at
  `epsilon = 0.05` degrees (reduces `src/data/ethnic-zones.json`
  from 580 KB to 139 KB without visible quality loss at relevant
  zoom levels), and writes out a GeoJSON with per-feature metadata.
- **Overlap zones** — GeoEPR has 23 features where multiple groups
  share the same territory (e.g. Kurdish + Arab in contested
  northern Iraq). Grid-based overlap detection at 0.5° resolution
  identifies these as separate features with a
  `properties.groups: string[]` array instead of a single
  `properties.group: string`.
- **Group metadata** — `src/lib/ethnicGroups.ts` exports
  `ETHNIC_GROUPS` as a keyed record with color, RGBA tuple,
  estimated population, and a short context string per group.

### Rendering: deck.gl GeoJsonLayer + FillStyleExtension hatching

Render the polygons as deck.gl `GeoJsonLayer` instances with the
`FillStyleExtension` configured with `fillPatternMask: true` and a
canvas-generated diagonal hatch atlas.

- **Hatch atlas** — a 32×32 canvas with a diagonal line pattern
  (4 px line width, 10 px spacing) created once at module load and
  re-used across all ethnic layers. See
  `src/components/map/layers/EthnicOverlay.tsx`.
- **Single-group features** get one GeoJsonLayer colored with the
  group's RGBA (alpha 140/255, ~55 %) and masked by the hatch
  pattern.
- **Overlap features** are rendered as stacked GeoJsonLayers — one
  layer per group in the overlap, each with `getFillPatternOffset`
  producing interleaved colored stripes. This is the visual
  encoding for "multiple groups share this territory" that avoids
  picking a winner between them.
- **Labels** — a deck.gl `TextLayer` at polygon centroids,
  zoom-responsive from 10 px to 24 px, single-group zones only
  (overlap areas are unlabeled to avoid clutter).
- **Interaction** — hover tooltips via `EthnicTooltip` component
  show group name, population, context. Tooltip priority on the
  map is: Entity > Threat cluster > Ethnic > Weather. Ethnic only
  shows on empty map areas.

## Consequences

### Positive

- **Authoritative academic source.** GeoEPR is peer-reviewed,
  citable, and maintained by a specific research group with a
  publication record. A reviewer asking "where do these polygons
  come from?" gets a clean answer.
- **Hatching reads distinctly from the political fill layer.** Solid
  fills (political) + diagonal hatches (ethnic) are visually
  orthogonal — the eye parses them as separate layers even when
  both are active. Verified in practice across the 10 ethnic groups
  and 3 factions.
- **Overlap zones supported natively.** The stacked-layer +
  offset-pattern approach handles multi-group territories without
  compromising on which group "wins" — the user sees all groups in
  the overlap simultaneously.
- **Data freshness is decoupled from render code.** Swapping in a
  newer GeoEPR release is a file replacement + extraction script
  re-run, not a code change. The rendering pipeline doesn't know
  about GeoEPR versioning.
- **File size is manageable.** 139 KB post-simplification for the
  full Middle East ethnic layer is acceptable for a static import.
  No need for a dynamic fetch or server-side filtering.

### Negative

- **Yazidi is absent as a distinct group.** GeoEPR 2021 maps Yazidi
  populations under "Kurds/Yezidis" as a combined category, so the
  ethnic-zones.json doesn't have a separate Yazidi polygon. This
  is a limitation of the upstream dataset that we can't fix without
  hand-drawing polygons (which violates the authoritative-source
  principle). Documented in the legend tooltip and deferred to a
  future patch that sources Yazidi-specific polygons from a
  different academic dataset if one exists.
- **Static 2021 dataset.** Ethnic boundaries shift slowly, but the
  post-2021 displacement from the Gaza war, the Syrian civil war's
  late phases, and Iranian internal migration are not reflected.
  The layer is "snapshot circa 2021," not live demographic data.
- **`FillStyleExtension` is a deck.gl-specific feature.** Moving
  away from deck.gl would require reimplementing the hatch pattern
  in whatever replacement rendering engine is chosen. Acceptable
  lock-in for the value delivered.
- **The hatch atlas is a canvas-generated PNG at module load.**
  This works in the browser but requires `document.createElement('canvas')`
  to be available — server-side rendering would need a shim. Not
  a problem today (the frontend is a Vite SPA) but worth noting.
- **Stacked overlap layers multiply the draw call count.** 23
  overlap zones × up to 3 groups per overlap = up to ~70 extra
  GeoJsonLayers for the overlaps alone. Measured frame time impact
  is negligible but it's a real cost if the overlap count grows.

### Neutral

- **Labels use a different font weight than the water layer labels.**
  Sans-serif for ethnic labels, serif italic for water river labels
  — deliberate choice to let the user distinguish at-a-glance which
  layer a label belongs to when multiple layers are active.
- **The grid-based overlap detection runs at extraction time, not
  render time.** The `extract-ethnic-data.ts` script bakes the
  overlap features into `ethnic-zones.json`. The frontend doesn't
  do any polygon math; it just renders.
- **Tooltip priority is a load-bearing UX decision.** Ethnic
  tooltips only show when no entity, threat cluster, or weather
  feature is under the cursor. This was tuned in Phase 25 Plan 02
  based on how noisy it was to have ethnic tooltips popping up over
  every flight and ship the user hovered on.

## Alternatives Considered

- **Hand-curated GeoJSON from published maps** — rejected. Not
  citable, not updatable, not authoritative. Phase 25 CONTEXT
  explicitly ruled this out as "hand-drawn polygons violate the
  authoritative-source principle."
- **Wikidata SPARQL queries for ethnic group boundaries** — rejected
  after investigation. Wikidata has incomplete and inconsistent
  coverage of ethnic group polygons in the region; many groups have
  no spatial data, and the data that exists is crowd-sourced with
  variable quality.
- **No ethnic layer at all** — rejected. The layer is a user
  requirement in the Phase 25 CONTEXT document, motivated by the
  observed spatial alignment of conflict events with ethnic
  boundaries. Dropping the requirement would reduce the tool's
  explanatory value.
- **Solid fill layer instead of hatches** — rejected because it
  would collide visually with the political fill layer from Phase 24. A hatched overlay is a visually-distinct layer that reads
  separately even with both active.
- **Rendering via MapLibre `fill` layers with a pattern image** —
  considered, but MapLibre's pattern fills don't support per-feature
  colors (they use a single pattern image globally), which would
  have forced a separate MapLibre layer per group and the same
  stacked-layer pattern as the deck.gl approach — but without
  deck.gl's `FillStyleExtension` offset machinery for overlaps.
  deck.gl is strictly more flexible here.

## References

- [`src/data/ethnic-zones.json`](../../src/data/ethnic-zones.json) —
  GeoJSON output from the extraction pipeline (596 features, 139 KB).
- [`scripts/extract-ethnic-data.ts`](../../scripts/extract-ethnic-data.ts) —
  shapefile-to-GeoJSON extraction + Douglas-Peucker simplification
  - grid-based overlap detection.
- [`src/lib/ethnicGroups.ts`](../../src/lib/ethnicGroups.ts) —
  `EthnicGroup` type and `ETHNIC_GROUPS` metadata record.
- [`src/components/map/layers/EthnicOverlay.tsx`](../../src/components/map/layers/EthnicOverlay.tsx) —
  canvas hatch atlas + stacked GeoJsonLayer rendering logic.
- [`src/components/map/layers/EthnicOverlay.tsx`](../../src/components/map/layers/EthnicOverlay.tsx) (contains `EthnicTooltip`) —
  hover tooltip with group name, population, context.
- `docs/architecture/frontend.md` —
  deck.gl layer stacking diagram showing ethnic layers after
  political in the z-order.
- [GeoEPR 2021 dataset page](https://icr.ethz.ch/data/epr/geoepr/) —
  ETH Zurich International Conflict Research.
- [ADR-0004](./0004-threat-density-via-radial-gradient-shader.md) —
  another layer using a custom deck.gl extension pattern.
- Phase 25 CONTEXT and SUMMARY
  (`.planning/phases/25-ethnic-distribution-layer/`).

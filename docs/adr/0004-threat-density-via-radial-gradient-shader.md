# ADR-0004: Threat density via RadialGradientExtension shader

**Status:** Accepted
**Date:** 2026-03-?? (Phase 23.2, Threat Density Improvements)
**Deciders:** solo author

## Context

Phase 23 introduced a threat density visualization: GDELT conflict
events are clustered spatially via BFS on a 0.25°-resolution grid,
then each cluster is rendered as a semi-transparent colored blob
whose _radius_ encodes the geographic spread of events and whose
_color_ encodes the composite threat weight. The goal is an at-a-glance
"where is the heat" read on the map, independent of the individual
event dots.

The first implementation used deck.gl's stock
`HeatmapLayer`. Two problems surfaced:

1. **No per-cluster radius control.** `HeatmapLayer` computes its own
   density from raw points at a single configurable `radiusPixels`
   value. We needed the radius to scale with each cluster's bounding
   box diagonal (small radius for tightly-packed events, large radius
   for a scattered cluster) _plus_ a density boost — and we needed
   that radius in map meters, not screen pixels, so it tracks with
   zoom.
2. **No per-cluster color mapping.** `HeatmapLayer` uses a single
   color ramp computed from density. We needed the color to track
   cluster _threat weight_ (a separate dimension computed from event
   type, mention count, source count, fatalities) independent of the
   radius. Dual-dimension encoding isn't a
   `HeatmapLayer` thing.

We considered two escape hatches:

- Pre-bake PNG sprites per cluster and render them via `IconLayer`.
  Non-interactive, can't smoothly transition on hover, doesn't scale
  with zoom unless we pre-render multiple sizes.
- Draw via MapLibre's raster heatmap layer. No per-cluster control,
  and mixing deck.gl clusters with MapLibre heatmap layers creates
  z-order issues at the terrain-draped layer stack.

Neither worked. The dual-dimension requirement pointed straight at a
custom shader.

## Decision

Implement a custom deck.gl
[`LayerExtension`](https://deck.gl/docs/developer-guide/custom-layers/layer-extensions)
called `RadialGradientExtension` that injects GLSL fragment-shader
code into deck.gl's `ScatterplotLayer` via the
`fs:DECKGL_FILTER_COLOR` hook. The injected code computes the
normalized distance from the point center to the current fragment and
applies a `smoothstep(0.3, 1.0, dist)` falloff on the alpha channel —
center 30 % of the circle is at full opacity, the outer 70 % fades
smoothly to transparent.

With this extension, `ScatterplotLayer` becomes a per-cluster radial
gradient renderer where `radius` and `color` are independent. The BFS
clustering, radius computation, and color mapping all happen in JS;
the shader handles only the per-fragment alpha falloff.

Additional tuning:

- `radiusUnits: 'meters'` with `radiusMinPixels: 20` and
  `radiusMaxPixels: 200` so clusters stay readable at any zoom.
- `blendColorDstFactor: 'one'` for additive blending — overlapping
  clusters intensify rather than simply stacking.
- A 4-stop thermal palette (deep purple → magenta → orange → bright
  red), P90-normalized so high-activity outliers don't wash out the
  rest of the color range.
- Cluster radius is `bbox diagonal + sqrt(eventCount) density boost`
  with a 30 km floor for single-cell clusters.
- Zoom-dependent z-order crossover: clusters above entity markers
  below zoom 9, behind entity markers at zoom ≥ 9 (managed via
  `isBelowZoom9` in `mapStore` with ref-based threshold crossing).

## Consequences

### Positive

- **Dual-dimension encoding works.** Radius = spread, color = weight.
  A small tight red blob vs a large diffuse purple blob read
  differently at a glance and that's the whole point.
- **Additive blending intensifies overlapping clusters naturally.**
  Two orange clusters in the same area become visually hotter
  without custom merge logic.
- **Smooth falloff avoids the hard-edged dot look of naive
  `ScatterplotLayer`.** The `smoothstep` gives the blobs a
  thermal-camera quality that reads as "heat map" without being
  cartoonishly circular.
- **Per-frame cost is low.** The fragment shader is a few instructions;
  ScatterplotLayer's vertex pipeline is the same as the stock
  renderer. Zero measurable frame drop versus the original
  `HeatmapLayer`.
- **LayerExtension API is stable.** Using the
  `fs:DECKGL_FILTER_COLOR` injection hook is the blessed way to
  customize a stock layer's shaders without forking it. Future deck.gl
  upgrades are far less risky than forking `ScatterplotLayer`.

### Negative

- **Custom GLSL adds a maintenance burden.** Anyone touching the
  threat density layer needs to understand both the JS side of deck.gl
  and enough GLSL to debug a fragment shader. The code is commented
  but the ramp-up is real.
- **Debugging GLSL is harder than JavaScript.** There's no
  `console.log` in a fragment shader. When a visual bug appears, you
  reason about it, tweak the GLSL, reload, and compare — there's no
  step debugger for web GLSL in most setups. Phase 23.2 spent
  non-trivial time on the `smoothstep` parameter tuning for this
  reason.
- **deck.gl API changes could break the extension.** The
  `fs:DECKGL_FILTER_COLOR` injection point is documented but not
  covered by semver guarantees as tightly as the top-level layer
  API. A deck.gl major version upgrade could require shader
  rewrites. Mitigation: the extension is in a single file
  (`src/components/map/layers/RadialGradientExtension.ts`) and
  isolated from the rest of the threat density code.

### Neutral

- **The 4-stop thermal palette was simplified from an earlier
  8-stop FLIR Ironbow palette.** The 8-stop palette looked more
  "professional thermal camera" but the extra stops were
  indistinguishable at typical cluster densities — a simpler palette
  reads better at a glance. See `src/components/map/layers/constants.ts`.
- **Cluster centroid computation was corrected in Phase 24** to
  use the mean of actual event coordinates (`realLatSum` /
  `realLngSum`) instead of the bounding box center of grid cells.
  Grid-center centroids produced visually off-center blobs when
  events were clustered at a corner of the bbox.

## Alternatives Considered

- **deck.gl `HeatmapLayer`** — rejected because it doesn't support
  per-cluster radius or per-cluster color mapping. Density is a
  single global dimension.
- **Pre-baked PNG sprites via `IconLayer`** — rejected because
  sprites don't scale smoothly with zoom (would need multiple
  pre-rendered sizes) and can't do additive blending cleanly.
- **MapLibre raster heatmap** — rejected because mixing it with the
  deck.gl entity layers creates z-order inconsistencies across the
  terrain-draped layer stack, and because it doesn't support the
  dual-dimension encoding either.
- **Fork `ScatterplotLayer` entirely** — rejected as a maintenance
  nightmare. LayerExtension is the supported alternative.

## References

- [`src/components/map/layers/RadialGradientExtension.ts`](../../src/components/map/layers/RadialGradientExtension.ts) —
  the extension itself.
- [`src/components/map/layers/ThreatHeatmapOverlay.tsx`](../../src/components/map/layers/ThreatHeatmapOverlay.tsx) —
  the threat cluster layer using the extension.
- [`src/components/map/layers/ThreatHeatmapOverlay.tsx`](../../src/components/map/layers/ThreatHeatmapOverlay.tsx) (`computeThreatWeight`; the standalone `threatWeight.ts` module no longer exists) — the
  `computeThreatWeight` formula (type weight × log mentions × log
  sources × fatality factor × Goldstein hostility).
- `docs/architecture/ontology/algorithms.md` —
  BFS clustering algorithm rationale.
- Phase 23 and 23.2 CONTEXT / SUMMARY
  (`.planning/phases/23-threat-density-improvements/`,
  `.planning/phases/23.2-improving-threat-density-scatter-plots/`).
- [deck.gl custom layers guide](https://deck.gl/docs/developer-guide/custom-layers/layer-extensions)
  — upstream documentation for the extension pattern.

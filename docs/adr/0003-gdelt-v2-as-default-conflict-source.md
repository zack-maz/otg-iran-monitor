# ADR-0003: GDELT v2 as default conflict source

**Status:** Accepted (with known caveats — see ADR-0005)
**Date:** 2025-10-?? (Phase 8.1, switched from ACLED to GDELT)
**Deciders:** solo author

## Context

The core product value of the Iran Monitor is a live map of
conflict-related events in the Greater Middle East. "Numbers over
narratives" requires a stream of geocoded events with timestamps,
event types, and counts — not a curated news feed.

Two candidate sources dominate the open-data space for conflict
events:

- **ACLED** (Armed Conflict Location & Event Data Project) — gold
  standard for academic conflict research. Hand-curated, high
  precision, carefully geocoded.
- **GDELT** (Global Database of Events, Language, and Tone) — fully
  automated, ingests global news every 15 minutes, categorizes via
  the CAMEO event taxonomy. Massive coverage, variable precision.

Initial implementation (Phase 8) used ACLED. The decision to switch
came after running into three hard blockers:

1. **ACLED account approval is gated.** Sign-up is a form that goes
   through a human review process with unclear turnaround time. The
   portfolio project couldn't ship with "waiting on ACLED to approve
   my account" as a README prerequisite.
2. **ACLED's license terms are restrictive.** Attribution is required
   and redistribution of the data is limited — acceptable for academic
   use, awkward for a public portfolio demo where the data is
   surfaced through a deck.gl overlay.
3. **ACLED updates once a week.** For a tool built around
   "what's happening right now around the Strait of Hormuz,"
   weekly-lag is too slow. GDELT updates every 15 minutes.

## Decision

Use **GDELT v2 events export** as the default and active conflict
event source. The ACLED adapter is preserved in
[`server/adapters/acled.ts`](../../server/adapters/acled.ts) but not
wired into any route — it's reference code for a future phase if the
account approval and license constraints ever relax.

Concretely:

- The GDELT adapter in
  [`server/adapters/gdelt.ts`](../../server/adapters/gdelt.ts) polls
  `http://data.gdeltproject.org/gdeltv2/lastupdate.txt` (HTTP, not
  HTTPS, because of a chronic TLS cert issue on GDELT's side), reads
  the latest ZIP URL, downloads it via `adm-zip`, and parses the CSV.
- Events are filtered by a Middle East bounding box, classified by
  CAMEO `EventBaseCode` (3-digit) into 11 `ConflictEventType` values
  via `classifyByBaseCode`, and deduplicated by `date + CAMEO + lat/lng`
  keeping the row with the highest `NumMentions`.
- Cache key `events:gdelt` with a 15-minute logical TTL that matches
  the GDELT publishing cadence.
- A lazy backfill path (`?backfill=true` query param) directly
  constructs GDELT export URLs for historical slices, gated by a
  1-hour `events:backfill-ts` cooldown to prevent thundering herds.

## Consequences

### Positive

- **Free, no auth, no account approval.** Anyone can clone this
  repo and have conflict events flowing within seconds.
- **15-minute updates.** Matches the "numbers over narratives" value
  prop. Users see new events within a quarter-hour of the news cycle.
- **Global coverage.** Not region-gated, not language-gated — GDELT
  ingests news worldwide and the bounding box filter keeps us in the
  Middle East.
- **Permissive terms.** GDELT is a public-goods project funded
  partially by Google; redistribution and embedding is explicitly
  allowed.
- **CAMEO taxonomy is machine-readable.** Classification of events
  into 11 types (`airstrike`, `ground_combat`, `shelling`, `bombing`,
  `assassination`, `abduction`, `assault`, `blockade`,
  `ceasefire_violation`, `mass_violence`, `wmd`) maps cleanly from
  CAMEO base codes without NLP or manual labeling.

### Negative

- **GDELT geolocation is noisy.** Many events arrive with
  country-centroid coordinates instead of actual incident locations,
  producing visual stacking artifacts on the map. Phase 22.1 partially
  mitigated this with deterministic dispersion (concentric rings for
  events at the same centroid). **Phase 26.2 attempted a second
  mitigation via NLP entity extraction from article titles, which
  was scrapped wholesale — see [ADR-0005](./0005-phase-26-2-nlp-approach-scrapped.md).**
- **CAMEO taxonomy has false-positive-prone codes.** Low-tier codes
  like `180`, `182`, `190` ("appeal", "reduce relations", "use
  unconventional mass violence" when applied to rhetoric) produce
  noisy events that show up on the map as conflict incidents when
  they're actually diplomatic statements. Phase 8.1 excluded
  `180` and `192` entirely; Phase 26.2 tried additional exclusions
  (reverted).
- **HTTP endpoint, not HTTPS.** `data.gdeltproject.org` has
  chronically broken TLS certs. We fetch over HTTP and accept the
  risk — the data is public, so interception isn't a confidentiality
  concern, only an integrity concern, and the scheme mismatches
  between GDELT servers make HTTPS unreliable.
- **ZIP files require `adm-zip`.** Node's built-in `zlib` only
  handles gzip/deflate, so we added `adm-zip` as a dependency just
  for GDELT. Minor surface area.
- **`lastupdate.txt` occasionally 404s.** GDELT's publishing pipeline
  pauses during holidays and maintenance. The backfill path and the
  serve-stale-on-failure contract keep the app serving data, but the
  freshness can lag by hours during outages. Documented in
  `docs/runbook.md`.

### Neutral

- **The ACLED adapter stays in the repo** as reference code for a
  future decision. Deleting it would lose the option to go back if
  ACLED's terms or approval process improve.
- **Hardcoded CAMEO classification and country code tables exist.**
  `classifyByBaseCode`, `CITY_CENTROIDS`, and FIPS 10-4 country code
  tables are hand-maintained as `TODO(26.2)` tech debt, awaiting a
  proper GDELT redo phase. These are documented in the architecture
  diagrams (`docs/architecture/data-flows.md`)
  with inline labels so reviewers can see them as known debt rather
  than hidden warts.

## Alternatives Considered

- **ACLED** — rejected for account approval delay, restrictive
  license, and weekly update cadence. Adapter preserved.
- **UCDP Geo-referenced Event Dataset** — rejected for monthly
  update granularity. Excellent for academic research, unusable for
  "what happened in the last hour."
- **Hand-curated events from news feeds** — rejected as unscalable
  and contradictory to the "numbers over narratives" value. Would
  turn the project into a blog.
- **Twitter/X conflict OSINT accounts scraped via API** — rejected
  as a non-starter after the API pricing changes in 2023. Even the
  $100/month Basic tier wouldn't cover the sustained polling needed
  for this use case.
- **Multiple sources fused into one stream** — considered and
  partially implemented: Bellingcat RSS is used as a corroboration
  gate for GDELT events in the severity scoring layer (see Phase 22).
  But GDELT remains the _primary_ stream because it's the only one
  with global machine-readable coverage.

## References

- [`server/adapters/gdelt.ts`](../../server/adapters/gdelt.ts) — the
  adapter implementation.
- [`server/adapters/acled.ts`](../../server/adapters/acled.ts) — the
  preserved ACLED adapter (unwired).
- [`server/routes/events.ts`](../../server/routes/events.ts) — the
  route handler, cache wiring, and backfill cooldown.
- `docs/architecture/data-flows.md` —
  events data flow sequence diagram.
- [ADR-0005](./0005-phase-26-2-nlp-approach-scrapped.md) — the
  post-mortem on the attempted NLP mitigation.
- Phase 8.1 CONTEXT (GDELT switch), Phase 22/22.1 CONTEXT (quality
  and dispersion), Phase 26.2 CONTEXT (scrapped NLP).
- [GDELT v2 event database documentation](https://www.gdeltproject.org/data.html#rawdatafiles).

# ADR-0005: Phase 26.2 NLP Geolocation Approach Scrapped

**Status:** Superseded — reverted in Phase 26.3. Successor is a future
GDELT redo phase that depends on Phase 26.4 completing first.
**Date:** 2026-04-06 (decision to scrap), 2026-04-04 (original Phase
26.2 implementation), 2026-04-05 (cleanup commits in Phase 26.3)
**Deciders:** solo author

## Context

GDELT v2 events have known false-positive geolocation problems. Many
events arrive with country-centroid coordinates (`ActionGeo_Type` 3
or 4) instead of actual incident locations, producing visual stacking
artifacts on the map and misleading cluster centroids. Phase 22.1
partially addressed this with deterministic dispersion (concentric
rings for events at the same centroid) and a 0.7x multiplicative
confidence penalty for centroid-typed events. That helped the
stacking artifact but left the underlying issue — that GDELT's
geolocation is inherently noisy for the Iran conflict region — intact.

See [ADR-0003](./0003-gdelt-v2-as-default-conflict-source.md) for why
GDELT is the default source despite these issues and
`.planning/phases/26.2-conflict-geolocation-improvement/26.2-CONTEXT.md`
for the original problem framing that motivated Phase 26.2.

Phase 26.2 ("Conflict Geolocation Improvement") attempted to solve
the problem by adding a **server-side NLP pipeline** on top of the
GDELT adapter:

- **Title fetcher** (`server/lib/titleFetcher.ts`) — HTTP-fetches the
  article `SOURCEURL` from each GDELT row, parses the HTML `og:title`
  or `<title>` tag, caches results in Redis keyed by SHA-256 of the
  URL with a 7-day TTL, with a concurrency limiter to avoid
  hammering news sites.
- **NLP extractor** (extensions to `server/lib/nlpExtractor.ts`) —
  `compromise` library with a custom Middle East lexicon plugin
  that recognizes ~240 city and conflict-actor names (Deir ez-Zor,
  Mazar-i-Sharif, Houthi, Hamas, Hezbollah, etc.), extracting place
  entities and actor entities from the fetched title.
- **Geo validator** (`server/lib/nlpGeoValidator.ts`) — cross-checked
  NLP-extracted place names against GDELT's `ActionGeo` country code
  via an `ISO_TO_FIPS` bridge. Mismatches were rejected; matches
  passed through; centroid events got their coordinates _replaced_
  with the NLP-extracted city coordinates from a new 240-entry
  `me-cities.json` dataset generated from GeoNames via
  `scripts/extract-geonames.ts`.
- **CAMEO exclusion expansion** — Phase 26.2 additionally excluded
  CAMEO codes `182` and `190` (on top of the pre-existing `180` /
  `192` exclusions) because they were producing the highest share of
  false positives in the observed sample.
- **Confidence threshold raised** from 0.35 to 0.38 to further
  filter noisy events after the NLP layer was active.

Wired into the pipeline, the NLP path ran for every GDELT event on
every 15-minute poll. `parseAndFilter` became async because it now
awaited title fetches.

## Decision

**Scrap the entire NLP approach.** Revert all Phase 26.2 code in
Phase 26.3. Delete the NLP files. Roll back the thresholds, the
CAMEO exclusions, and the async pipeline. Leave the original 42-entry
`CITY_CENTROIDS` table in place with a `TODO(26.2)` marker pointing
to a future GDELT redo phase that will build on a clean foundation
rather than patching downstream of a bad signal.

Concrete revert actions taken in Phase 26.3:

- **Deleted:** `server/lib/nlpGeoValidator.ts`,
  `server/lib/titleFetcher.ts`, `src/data/me-cities.json`,
  `scripts/extract-geonames.ts`,
  `server/__tests__/lib/nlpGeoValidator.test.ts`,
  `server/__tests__/lib/titleFetcher.test.ts`.
- **Reverted to pre-26.2 state:** `server/adapters/gdelt.ts` (Phase C
  wiring removed, `parseAndFilter` back to synchronous),
  `server/lib/nlpExtractor.ts` (custom lexicon plugin removed),
  `server/lib/eventScoring.ts` (CAMEO_SPECIFICITY restored to
  original tiers), `server/lib/eventAudit.ts` and
  `server/lib/geoValidation.ts` (reverted), `server/config.ts`
  (confidence threshold back to 0.35, CAMEO exclusion back to
  `['180', '192']`).
- **Preserved:** the 42-entry `CITY_CENTROIDS`, the original
  `CAMEO_TO_FIPS` table, the pre-26.2 FIPS lookup, the Phase 22.1
  dispersion algorithm. These are now all labeled `TODO(26.2)` tech
  debt in the code and in
  `docs/architecture/data-flows.md`
  awaiting the redo.
- **Time invested before scrap:** roughly two weeks of planning,
  implementation, and debugging across 3 plans (Phase 26.2 Plans
  01–03). All three plans shipped green tests and passing
  verifications in isolation — the problem was not that any
  individual piece was broken, it was that the whole stack was
  solving the wrong problem. See "What I Learned" below.

## Consequences

### Positive

- **~1500 lines of code removed that didn't deliver the promised
  value.** This is the biggest portfolio signal in the repo: the
  willingness to measure, admit failure, and delete. Dead code that
  "almost works" is worse than no code at all in a work sample,
  because it forces every future reader to reason about it.
- **Honest acknowledgment that we were patching bad geocoding with
  more code, not solving the underlying problem.** The NLP layer was
  downstream of GDELT's geocoding. No amount of downstream
  post-processing can rescue an unreliable upstream signal — it just
  hides the unreliability behind an opaque layer that's even harder
  to debug.
- **Cleared the codebase for Phase 26.3 production hardening
  (pino, Zod, OpenAPI, strict TypeScript)** without NLP code adding
  noise to the strict-mode sweep. Phase 26.3 absorbed the scrap as
  part of a wider cleanup, which was the right call — the two
  phases landed as one coherent "we're going to production" arc.
- **Forced a better problem framing for a future phase.** The right
  solution isn't "NLP-extract location names from headlines that
  often don't include location names." It's either (a) source
  better-geolocated events upstream from a different provider, or
  (b) filter GDELT more aggressively on the input side (exclude
  specific noisy CAMEO codes, require multi-source corroboration via
  `NumSources`) rather than rescue it on the output side. Phase
  26.2-redo will start from that framing, not from "let's add NLP."
- **The tech debt is documented, not hidden.** The `TODO(26.2)`
  markers in `server/lib/geoValidation.ts`, the CAMEO tables, and
  the architecture diagrams
  (`docs/architecture/data-flows.md`)
  all point to the known problem. Anyone reading the project today
  sees "this is tech debt we know about" rather than "why is this so
  hacky?"

### Negative

- **Two weeks of work in the bin.** The original Phase 26.2 plans
  shipped over about two weeks of evenings and weekends. All of it
  is gone except the CAMEO tables and lessons. Opportunity cost
  alone is painful.
- **The original GDELT false-positive problem still exists.** It is
  now flagged as `TODO(26.2)` and awaiting a proper redo phase that
  depends on Phase 26.4 (this phase) completing first. Phase 26.2
  was originally inserted as URGENT between Phase 26 and Phase 26.3;
  now it is deferred indefinitely. See
  STATE.md "Roadmap Evolution" for the
  chronology.
- **Users of the live demo see the same stacking artifacts that
  Phase 22.1 dispersion partially masked.** Phase 26.2's centroid
  relocation would have cleaned these up per-event; the dispersion
  algorithm only spreads them visually within a fixed ring. This is
  a known visible artifact in the current build.
- **`compromise` is still installed as a dependency** because the
  news feed clustering in `server/lib/newsClustering.ts` uses it for
  tokenization. Phase 26.2 didn't introduce it — the extensions to
  its custom plugin layer were the 26.2-specific changes. Removing
  `compromise` entirely would require rewriting the news clustering,
  which is out of scope for a revert.

### Neutral

- **The Phase 22.1 dispersion algorithm is still in place** as the
  only mitigation on the map today. Events that share a centroid
  get spread across concentric rings deterministically, which is a
  visual band-aid but at least readable.
- **The 42-entry `CITY_CENTROIDS` table is preserved** as a fallback
  that a future redo phase can build on — either by expanding it
  with better source data or by swapping to a different approach
  entirely.
- **All 26.2 commits are still in the git history** (the revert is a
  normal commit, not a `git reset --hard`). Anyone who wants to see
  the code that was tried can check out the pre-revert commits. The
  rollback is a forward action, not an erasure.

## What I Learned

This is the most portfolio-relevant section of any ADR in this
repository. Four lessons, written for the next time I'm about to do
the same thing:

### 1. Patching downstream of a bad signal compounds the problem

The NLP layer sat _downstream_ of GDELT's geocoding. If the upstream
signal is unreliable, no amount of post-processing makes it reliable
— it just hides the unreliability behind an opaque layer. Every
heuristic I added (the ISO→FIPS bridge, the multi-word city tokenizer,
the actor-country gate, the CAMEO 182/190 exclusions, the 0.38
threshold) was a patch on a patch. By the end of Phase 26.2 I had five
layers of mitigation stacked on top of each other, each addressing an
edge case surfaced by the previous layer. That's the shape of _every_
"almost working" downstream-fix project, and in retrospect I should
have recognized it as a stuck signal two weeks earlier.

**Rule for next time:** if a fix requires more than two layers of
post-processing heuristics to handle edge cases, the fix is wrong.
Go back upstream.

### 2. Spike before commit

I committed to the NLP plan based on "compromise is already installed
and runs in serverless" and "GeoNames has the cities we need." Both
were true, but neither was the load-bearing question. The real
question was: **when a GDELT event has a centroid-typed geocode, how
often does the article title contain a specific city name that
resolves unambiguously to coordinates within the correct country?**
I never measured that. A two-day spike on real GDELT data — sample
1000 centroid events, manually verify how many have extractable
location entities in the title — would have surfaced the "headlines
often don't include location names" failure mode before the full
implementation went in.

**Rule for next time:** before writing production code against a
noisy input, write a throwaway script that measures how noisy the
input actually is. The measurement is the go/no-go signal, not the
prototype.

### 3. Killing your darlings is a portfolio signal

Two weeks of work is hard to delete. My first instinct was to _keep_
the code disabled behind a feature flag, so the work "still exists."
That's the wrong instinct for a portfolio repo. Dead code is worse
than no code — it forces every future reader to reason about what it
does and why it's disabled, and it makes the codebase feel uncurated.
A hiring manager or collaborator reading this repo will spend more
time on the "what the hell is this" question than on understanding
the project.

Writing this ADR honestly — naming the files deleted, the time
invested, the root cause — is more valuable than any clean feature
ADR in this directory. Reviewers are evaluating _judgment_, not just
code. Documenting the scrap is the judgment signal.

**Rule for next time:** delete, don't feature-flag. Document the scrap
in an ADR, not in a commented-out code block.

### 4. Cleanup phases are part of the product

Phase 26.3 (Production Code Cleanup) absorbed the Phase 26.2 revert
as part of a wider hardening pass. That was the right call: the
cleanup pass was going to touch every strict-mode escape hatch in the
codebase anyway, and the NLP code was adding noise to that work.
Bundling them meant I only had to reason about the pre-26.2 code
once, not twice.

More generally: "cleanup" isn't a chore phase you do _after_ the
product is done. It _is_ part of the product. The willingness to
take a two-week hit in the middle of the roadmap to remove failed
work is one of the harder habits to develop because it feels
unproductive in the moment. But it compounds. Every line of code you
delete is a line you don't have to maintain, reason about, or explain
to a reviewer.

**Rule for next time:** treat cleanup as a first-class phase with a
slot in the roadmap, not a thing you do "when there's time."

## Alternatives Considered (post-scrap, for what to do instead)

- **Keep the NLP code disabled but in the tree** — rejected. See
  Lesson 3 above. Dead code in a portfolio repo is worse than no
  code.
- **Replace GDELT with a better source immediately** — rejected. No
  obvious better source exists today (ACLED is gated behind account
  approval and has restrictive terms; UCDP updates monthly; commercial
  OSINT feeds are out of budget). The redo phase needs fresh
  research on candidate sources before committing.
- **Manual curation of recent events** — rejected. Not scalable,
  contradicts "numbers over narratives" core value, and turns the
  project into a glorified news blog.
- **Delete the conflict layer entirely** — rejected. The conflict
  events layer is the single most-viewed layer on the live demo and
  the core product hypothesis. Removing it because we can't make it
  perfect is throwing out the baby with the bathwater.
- **Fix GDELT upstream by filtering on `NumSources ≥ N` and excluding
  the full list of noisy CAMEO codes** — **this is the leading
  candidate for the redo phase.** It addresses the problem upstream
  (in the filter, not in post-processing), it requires no new
  dependencies, and it can be validated via a replay-against-history
  spike before committing. Explicitly deferred to a future 26.2-redo
  phase.

## References

- `.planning/phases/26.2-conflict-geolocation-improvement/26.2-CONTEXT.md` —
  original Phase 26.2 problem framing and implementation plan.
- `.planning/phases/26.3-production-code-cleanup/26.3-CONTEXT.md` —
  cleanup phase that absorbed the revert.
- `.planning/STATE.md` — "Roadmap
  Evolution" section records the scrap as a first-class project
  event: _"Phase 26.2 SCRAPPED and deferred — NLP approach was
  wrong, patching bad geocoding with more code didn't work."_
- [`server/lib/geoValidation.ts`](../../server/lib/geoValidation.ts) —
  `CITY_CENTROIDS` table and `TODO(26.2)` marker.
- [`server/adapters/gdelt.ts`](../../server/adapters/gdelt.ts) —
  `classifyByBaseCode` and the pre-26.2 synchronous
  `parseAndFilter` that was restored.
- `docs/architecture/data-flows.md` —
  events data flow with inline `TODO(26.2)` labels.
- [README "What I Learned / What I'd Do Differently"](../../README.md) —
  public-facing short version of this retrospective. This ADR is the
  long version.
- [ADR-0003](./0003-gdelt-v2-as-default-conflict-source.md) — the
  decision to use GDELT as the default source, which this ADR
  supplements with the caveat that the geolocation problem is
  currently unsolved.

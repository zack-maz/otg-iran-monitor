# ADR-0012: Checkpointed waves, read-path top-up, and probing for the model

**Status:** Accepted
**Date:** 2026-09-19
**Deciders:** solo author

## Context

`events:llm:v3` was empty in production from about June to 2026-09-19. Three
causes were stacked, each hiding the next:

1. The cron read its GDELT input cache-only, and only a browser visit wrote
   that cache (fixed 2026-09-18).
2. NVIDIA retired the production model, `qwen/qwen3.5-397b-a17b`, on
   2026-07-27. Every call answered HTTP 410 and every run ended "completed"
   having written nothing.
3. Even with a live model the run could not succeed. It processed every group
   since the war start, geocoded sequentially, ran the eval, and only then made
   one write. A cold corpus does not fit in the 800 s function limit, and a
   killed run kept nothing. A full rate window or a tripped circuit breaker
   _skipped_ calls rather than waiting, so with a single provider one burst of
   errors turned the rest of a run into instant nulls. Group keys were
   positional, so the "only new groups" diff missed whenever the corpus was
   re-sampled.

Two constraints shaped the fix. Every Production secret is Sensitive in Vercel:
write-only, pulled as an empty string — so nothing that needs the NIM key or
Redis can run locally, and the bake-off scripts are unusable. And NIM's public
catalog is not a list of usable models: most ids answer 404 to a free-tier key,
and the reasoning models exceed 90 s on the extraction prompt.

An earlier simplification had removed incremental writes on the argument that
the 800 s Pro limit made them unnecessary (the single "terminal write" that
ADR-0009 and ADR-0011 describe). That argument assumed a warm cache and a fast
model. Neither held.

## Decision

1. **A run is a series of waves.** Each wave is extract → geocode → merge into
   `events:llm:v3`. Wave N+1's LLM calls overlap wave N's geocoding, with at
   most one wave waiting. Budgets are measured from the start of the request:
   no new LLM wave after 480 s, geocoding stops at 660 s, the eval runs after
   the writes and only before 540 s. The run never depends on finishing; the
   next run's diff takes what is left, highest severity first.
2. **Group keys are content-derived** — day, CAMEO root, lowest GDELT event id —
   so runs accumulate.
3. **The router waits instead of skipping.** The 40/min window blocks; SDK
   retries are off (`maxRetries: 0`) so the window counts real requests; the
   breaker gate applies only when a second provider has a key. HTTP
   401/403/404/410 is fatal: the run stops and names the status.
4. **Writes report their outcome** (`cacheSetReported`, 20 s). A run that
   persisted nothing ends `error`; a run that lost a wave ends `completed`
   with `partial: <cause>`.
5. **`/api/events` tops the enriched cache up with raw rows**
   (`fillWithRawEvents`): every enriched event plus the raw rows of groups not
   enriched yet. It is pure; the read path still never calls the LLM or writes
   the enriched key.
6. **The model is chosen by probing in production.**
   `GET /api/cron/llm-probe?models=a,b` sends one production-shaped batch per
   candidate. On 2026-09-19 it found one usable model of twenty,
   `google/gemma-4-31b-it`.

## Consequences

### Positive

- The cache filled in production the same day: six runs, 716 enriched events of
  760 served. A killed or failed run now costs one wave, not the corpus.
- A retired model shows up as a run that ends `error` with `HTTP 410` in
  seconds, instead of eight silent weeks.
- The map keeps its full event count while the cache fills, and events upgrade
  in place.

### Negative

- `/api/events` now reads two ~0.9 MB keys and regroups the raw corpus on every
  uncached request: 1.0–1.8 s, near the 2 s Redis read timeout (audit L9). The
  CDN hides it; a load test will not.
- During a fill the response mixes enriched and raw events. The client already
  handled both, but counts shift as groups of raw rows collapse into single
  enriched events.
- The probe route spends real NIM quota and exists only because secrets are
  unreadable. It is one more cron-authenticated surface.

### Neutral

- A cold corpus takes several runs. The daily cron alone would need about a
  week; force runs back to back after a cache loss (OPERATIONS §4.1).
- The circuit breaker is inert while NIM is the only provider. It is kept for
  the day a second one is configured.
- Health still reports green when the cron declines or fails (audit L2). This
  ADR does not change that.

## Alternatives Considered

- **Keep one write, cap the groups per run.** Smaller, but a count is a guess
  about model speed, and a killed run would still keep nothing. Deadlines adapt
  to whatever the model does that day.
- **Vercel Workflow / Queues for durable steps.** The right shape for a longer
  job, but new infrastructure for a once-daily task that fits in a few 800 s
  runs once it checkpoints.
- **Have the cron write a ready-to-serve merged key** instead of merging on
  read. Cheaper reads, but the raw corpus changes every 15 minutes between
  cron runs, so the merged key would be stale by construction. It remains the
  likely answer to L9, written by the events route rather than the cron.
- **Pick the replacement model from NIM's catalog or the old bake-off.** The
  catalog lists models a free key cannot call, and both bake-off runners-up had
  also been retired.

## References

- `docs/AUDIT-2026-09.md` — L1–L9.
- `docs/OPERATIONS.md` §3.3, §3.4, §4.1b.
- ADR-0009, ADR-0011 — the single terminal write this replaces.
- `server/lib/llmExtractionPipeline.ts`, `server/lib/freeClaudeRouter.ts`,
  `server/lib/eventGrouping.ts`, `server/routes/llm-probe-cron.ts`.

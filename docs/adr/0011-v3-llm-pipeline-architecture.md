# ADR-0011: v3 LLM pipeline architecture

**Status:** Accepted
**Date:** 2026-05-12
**Deciders:** solo author

## Context

ADR-0010 documents the _deletion_ of the v1 and v2 LLM extractors in Phase 29.
This ADR documents the _positive architecture_ of the v3 pipeline that
replaced them — the design decisions that future-me (or any reviewer) will
otherwise have to reconstruct from across 7 phase folders (27.4 → 27.4.6,
28.2.6, 29-04 → 29-07).

The v3 pipeline was not designed in one sitting. Each design property below
fixed a specific production incident that v1 or v2 ran into:

- **v1 (Phase 27).** Fire-and-forget LLM enrichment from `/api/events`. Used
  Cerebras + Groq directly via OpenAI SDK. Batch size 8.
- **v2 (Phase 27.4).** Added watchdog + DLQ + circuit breaker + token budget
  - 6-path geocoding resolver. Still triggered by `/api/events` cache miss.
- **v3 (Phase 27.4.4 → 27.4.6).** Added parallel batches via
  `concurrencyLimit`; moved trigger from `/api/events` to a daily cron after
  discovering Vercel Fluid Compute silently killed the v2 fire-and-forget
  IIFE once the HTTP response was sent (Phase 28.2.6).
- **Phase 29.** Narrowed the cascade to NIM + OpenRouter (deleted Cerebras +
  Groq); upgraded to Vercel Pro for 800s maxDuration; collapsed the Pitfall
  1 cache bridge to a single tier (v3 → raw GDELT).

This is the architecture as it ships today.

## Decision

The v3 pipeline is defined by six load-bearing design properties. Each has a
matching mitigation rationale.

### 1. Cron-only writer; `/api/events` is cache-only

`/api/events` reads `events:llm:v3` (terminal cache) or falls through to
`events:gdelt` (raw fallback) via the Pitfall 1 bridge. It **never** triggers
LLM extraction. Phase 27.4.6 anti-pattern #17 forbids re-introducing
fire-and-forget extraction back into this path.

**Why:** Vercel Fluid Compute terminates the function body once `res.json()`
returns. The v2 fire-and-forget pattern (kick off extraction, return cache
immediately) silently failed in production — `dispatched: true` returned in
400ms but the IIFE body never executed. Moving the writer to a Vercel cron
job means the function lives for the full extraction duration, gated by the
Pro plan's 800s `maxDuration` ceiling.

**Sole writer:** `/api/cron/refresh-events` (daily 4am UTC, Bearer-gated by
Vercel) calls `runRefreshExtraction()` in
`server/lib/llmExtractionPipeline.ts`. Operator force-trigger:
`GET /api/cron/refresh-events?force=true` with a valid Bearer skips the
cooldown.

### 2. Cold-cache self-heal

The cron probes `events:llm:v3` _before_ checking the 15-minute cooldown
key. Empty cache → bypass cooldown unconditionally. This guarantees the
first cron invocation after a fresh deploy populates the cache, regardless
of timing relative to the next 4am tick.

**Why:** Without this, a deploy that lands at 4:01am would wait 24 hours
before populating events. The cooldown is for thrash prevention; an empty
cache is not thrash, it's a missing dependency.

> **Amendment (Phase 35, SIMPLIFY-02 — immutability-safe note; body below unchanged):**
> the `events:llm:v3:partial` per-batch durability flush described in this section
> was **retired in Phase 35** (SIMPLIFY-02). At runtime only the terminal
> `events:llm:v3` key is written; the writer/reader-shape discipline this section
> documents is preserved at the design level (the terminal key stays array-shaped).
> The text below is kept verbatim as the original decision record.

### 3. Terminal-key writes, observability-key envelope

Each batch writes the full `ConflictEventEntity[]` to `events:llm:v3` as a
terminal-shape array. The progress envelope
(`{events, progress, complete, generatedAt}`) writes to
`events:llm:v3:partial` _only_ — readers of the terminal key never see the
envelope shape.

**Why:** ADR-0009 documents the v2 incident where a per-batch durability
flush wrote an envelope to the terminal cache key, crashing every consumer
with `events.map is not a function`. The two-key split is mechanical
defense against that class of regression. The v3 pipeline inherits the
discipline.

### 4. Parallel batches with circuit-breaker watchdog

`server/lib/concurrencyLimit.ts` provides a FIFO-queue limiter. The
extractor pushes `tasks.push(limit(async () => …))` per batch then
`await Promise.all(tasks)` after the loop. Default `LLM_V3_CONCURRENCY=12`
drives ~26 req/min steady-state, comfortably under NIM's 40 req/min
ceiling. `BATCH_SIZE=2` per LLM call. `LLM_V3_CONCURRENCY=1` reverts to
fully sequential for incident triage.

Each batch is wrapped in `withBatchWatchdog(batchFn, opts)`:
`Promise.race([batchCall, timeoutPromise])` + AbortController +
generation-counter late-resolve guard. Default 90s hard-kill + 60s
soft-warn. Timed-out batches DLQ each group with
`reason: 'timeout_watchdog'`; the loop continues to the next batch —
**timeout on batch N does NOT abort the run**.

**Why:** v2's serial loop ran at ~2 req/min against NIM's 40 req/min
ceiling — ~95% of the rate budget was unused. Parallelizing drives a
197-batch dev run from ~95 min → ~10 min. The watchdog prevents a single
hung NIM call from blocking the entire cron under the Pro 800s ceiling.

### 5. Provider cascade: NIM primary, OpenRouter fallback

`server/lib/freeClaudeRouter.ts` tries NVIDIA NIM
(`qwen-3-235b-a22b-instruct-2507`) first, then OpenRouter as fallback. Each
provider is gated on `isAvailable` (circuit breaker — sliding 10-call
window, paused 5min on >30% error rate) AND
`budgetState !== 'hard'` (token budget — daily caps tracked in
`llm:tokens:{provider}:YYYY-MM-DD`, 48h TTL, soft 0.8 / hard 0.95
short-circuit).

`isLLMConfigured()` returns true iff `NVIDIA_NIM_API_KEY` OR
`OPENROUTER_API_KEY` is set. When both are absent, the LLM call short-
circuits and the cron writes nothing — `/api/events` serves raw GDELT
through the Pitfall 1 bridge ("map never goes blank" — see ADR-0010 D-04
and `server/__tests__/routes/llm-optional.test.ts`).

**Why:** Cerebras + Groq drifted out of active use during the v3 cutover.
Phase 29 deleted them so the only active providers are the ones actually
exercised by production traffic.

### 6. Six-path location resolver

LLM-returned events carry a structured location hierarchy
(`{country, admin1, city, neighborhood, landmark, confidence}`) — not raw
coordinates. `server/lib/llmResolver.ts` `resolveLocation(hierarchy, ctx)`
dispatches the hierarchy through six paths in order:

1. `own-site-snapshot` — Phase 15 site/water facility lookup
2. `poi-amenity-nominatim` — POI search via Nominatim `amenity=`
3. `nominatim-direct` — direct place-name geocoding
4. `nominatim-verified-2pass` — multi-candidate with verifier rerank
5. `gdelt-actiongeo-fallback` — fall back to GDELT's own geocoding
6. `bellingcat-coord-passthrough` — accept Bellingcat-extracted coords directly

Every resolved coordinate carries provenance from one of these six paths.
The Nominatim adapter uses a server-owned Middle East viewbox + 22 country
codes (never user-overridable, Phase 27.4 T-27.4-04-01). 1-req/s throttle
via module-level spacer. Redis cache at `geocode:fwd:constrained:<hash>`
(30d logical TTL).

**Why:** LLM-emitted coordinates are unreliable (Phase 27.4 D-05); a
structured hierarchy plus deterministic geocoder is auditable in a way
the LLM output alone is not.

## Phase 36 Sub-block (appended 2026-05-29)

**Context:** ADR-0011 documented the v3 pipeline as designed when v1 + v2 were
deleted in Phase 29. Phases 30.1 + 34 then narrowed the runtime cascade further
without re-authoring this ADR. Phase 36 is the public-docs sweep that brings
README / runbook / degradation / architecture markdown + the OpenAPI spec
into v1.5 reality; this sub-block updates ADR-0011 in the same lockstep so a
reader of ADR-0011 alone gets the current shipped state.

**Runtime cascade as shipped (post-Phase-34):**

- **NIM** (qwen-235b instruct) — the only LLM provider invoked at runtime.
  See `docs/architecture/llm-pipeline-reliability.md`
  §"Multi-Provider Cascade (Phase 34)" for the cascade-shape table.
- **OpenRouter** — DORMANT per [ADR-0010 Phase 30.1 sub-block](0010-v1-5-llm-pipeline-narrowing-and-deletion.md#phase-301-sub-block-appended-2026-05-17).
  `skipOpenRouter: true` at `server/lib/llmEventExtractor.v3.ts:622, 929`.
  Free-tier probe landed in not-viable bucket; cascade construction at
  `server/lib/freeClaudeRouter.ts:341-363` is unchanged and ready to fall
  through if the dormancy decision is revisited.
- **Cerebras + Groq** — DEFERRED per [ADR-0010 Phase 34 sub-block](0010-v1-5-llm-pipeline-narrowing-and-deletion.md#phase-34-sub-block-appended-2026-05-23).
  Operator chose to skip provisioning; no adapter, no probe, no token-budget
  counters. Restoration is a future-phase decision, not a regression.

**Outcome:** The "v3 pipeline architecture" decision recorded in this ADR is
REAFFIRMED — the architectural primitives (watchdog, DLQ, circuit breaker,
token budget, 6-path resolver, parallel batches via concurrencyLimit,
cron-only trigger) all remain load-bearing. What CHANGED is the provider
set the architecture orchestrates at runtime: NIM-only at runtime as of
Phase 34 close. The cascade-shape primitives are dormant-ready; no
architectural rework is required to wake them.

**Cross-references:**

- [ADR-0010](0010-v1-5-llm-pipeline-narrowing-and-deletion.md) — narrowing decisions per phase.
- `docs/architecture/llm-pipeline-reliability.md` — current cascade-shape table.
- [CLAUDE.md §LLM Event Pipeline](../../CLAUDE.md) — operator skim.
- Phase 36 SUMMARY.md — full Phase 36 close-out context.

## Consequences

### Positive

- The active code path is the only code path — no flag-gated branches, no
  preserved-for-rollback modules. Phase 29 deleted v1, v2, and the runtime
  toggle.
- Production failures have a single set of causes to investigate. The 6
  design properties above are the diagnostic decision tree.
- LLM-optional by construction: unset both provider keys and the system
  degrades to raw GDELT cleanly. No code path assumes LLM enrichment is
  present.
- Cost-controllable: token budgets short-circuit at hard cap; concurrency
  knob throttles the LLM rate ceiling; cron cadence sets the upper bound
  on daily spend.

### Negative

- The cron is a single point of failure for cache freshness. If the cron
  fails for >26h, `events:llm:v3` goes stale and `/api/events` serves raw
  GDELT (degraded). Operator must force-trigger via `?force=true` after
  diagnosing.
- The 6-path resolver is sequential — adds ~1s of geocoding latency per
  resolved event (Nominatim throttle). Acceptable inside the cron's 800s
  budget; would not be acceptable inside a synchronous HTTP path.
- NIM's documented 24h throttle window can cause a cron tick to fail
  entirely with watchdog timeouts + DLQ pile-up. Phase 27.4.6 D-08
  accepted this — next tick is 24h later; map serves raw GDELT in the
  meantime.

### Neutral

- Test infrastructure must mock both `llm-provider.callLLM` and
  `freeClaudeRouter.callLLM` for defense-in-depth assertions (see
  `server/__tests__/routes/llm-optional.test.ts`). The redundancy is
  intentional given the v1→v2→v3 import-path churn.

## Alternatives Considered

- **Vercel Workflow (`@vercel/functions`) for the LLM pipeline.** Phase
  28.2.6 evaluated this as resolution path (c). Rejected per Phase 28.2.6
  CONTEXT decision in favor of cron + incremental terminal-key writes —
  Workflow's durable-execution semantics are overkill for a daily batch
  job, and the cron approach reuses the existing route registration
  pattern with no new framework dependency.
- **Single-provider (NIM only).** Rejected. OpenRouter fallback exists
  because NIM has a documented 24h throttle window that would otherwise
  guarantee a cron failure mode with no automatic recovery.
- **Synchronous in-route enrichment with `waitUntil`.** Rejected. Same
  Vercel Fluid Compute kill-switch risk as the v2 fire-and-forget IIFE;
  `waitUntil` extends the function lifetime but the 800s Pro ceiling is
  still bounded, and the route would block waiting for LLM responses
  rather than serving the cache.
- **Replace structured hierarchy with raw LLM-emitted coordinates.**
  Rejected per Phase 27.4 D-05. LLM coords were demonstrably unreliable
  in pilot; the 6-path resolver via Nominatim is auditable in a way the
  LLM output alone is not.

## References

- ADR-0009 — Two-key split for LLM partial progress vs terminal reads
  (the writer/reader-shape discipline preserved here)
- ADR-0010 — v1.5 LLM pipeline narrowing and deletion (what was deleted
  to leave only v3)
- Phase 27.4 plans 01–07 — v3 design (extractor, watchdog, DLQ, circuit
  breaker, token budget, 6-path resolver)
- Phase 27.4.4 Plan 02 — parallel batch processing via `concurrencyLimit`
- Phase 27.4.6 — cron-driven pipeline trigger (anti-pattern #17)
- Phase 28.2.6 — Vercel Fluid Compute incident + cron architecture fix
- Phase 29 — provider cascade narrowing + LLM-optional architecture proof
- `docs/architecture/data-flows.md` §3 — runtime sequence diagram
- `docs/runbook.md` §11 — LLM Pipeline Disabled / Keys Absent recovery

---

_Template source: Michael Nygard, "Documenting Architecture Decisions"
(2011). Short format, immutable once Accepted — supersede with a new
ADR rather than editing the body. The status line may be updated._

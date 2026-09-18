# ADR-0010: v1.5 LLM pipeline narrowing and deletion

**Status:** Accepted (v1.5 closed 2026-06-03)
**Date:** 2026-05-11
**Deciders:** solo author

## Context

The v1.5 milestone narrowed and simplified the structured LLM event-extraction pipeline that v1.4 shipped. Phase 29 opened the work as "narrow to NIM + OpenRouter and delete v1+v2"; Phases 30 / 30.1 / 34 then surfaced that runtime reality had moved further than the Phase-29 intent. This ADR body now describes the **milestone-final shipped state at v1.5 close** — the 5 historical v1.5 sub-blocks below (Phase 30 / 30.1 / 34 / 35 + this milestone-close Phase 37 sub-block) record the per-phase decision trail that produced it.

**Active cascade at v1.5 close — NIM-only at runtime.** `server/adapters/llm-provider.ts` exposes one provider in the production code path: NVIDIA NIM (`qwen-235b` instruct model). OpenRouter is **dormant** per the Phase 30.1 sub-block — the 2026-05-17 `scripts/probe-openrouter.ts` measurement landed at 27/30 rate_limited (90.0%), so the free tier was declared not viable for batch extraction and the existing `skipOpenRouter: true` hard-codes at `server/lib/llmEventExtractor.v3.ts:630, 952` (from Phase 27.4.4 Plan 02) remained in place. Cerebras + Groq are **deferred** per the Phase 34 sub-block — the operator chose to skip provisioning free-tier accounts and running `scripts/probe-cerebras-groq.ts`; the Phase 31 Day-1 DLQ baseline (4 × `v3:timeout_watchdog`) is accepted as a known failure mode under single-provider NIM rather than expanding the provider surface. The reliability primitives (circuit breaker, DLQ, token budget, watchdog) carried forward from Phase 27.4.6 still bound the cascade, but only NIM is actually called.

**LLM-optional architecture, proven mechanically.** `/api/events` is **cache-only** (anti-pattern #17 invariant — no fire-and-forget on the request path). When `events:llm:v3` is populated, the route serves enriched events; when it is empty (LLM credentials unset, cron not yet run, or NIM throttled hard enough to flush the cache via watchdog timeouts), the Pitfall 1 cache bridge in `server/routes/events.ts` falls back to raw GDELT. **The map never goes blank.** The fallback path is exercised by `server/__tests__/resilience/redis-death.test.ts` (Redis death scenario) and by the Phase 29 LLM-optional integration test (all LLM credentials unset). v1+v2 extractor modules, their Redis cache keys (`events:llm`, `events:llm:v2`, `events:llm:v2:partial`, `events:llm-summary`, `events:llm-summary:v2`), and the pipeline-version toggle (`isPipelineV2`, `setPipelineOverride`, the `events:llm-pipeline-override` key + endpoint) were all **deleted** in Phase 29 (Plans 04-06). The Phase 35 `events:llm:v3:partial` retirement (SIMPLIFY-02) further collapsed the observability surface to a single terminal key (`events:llm:v3`).

**Cron-driven pipeline shape on Vercel Pro.** The Vercel Pro upgrade landed in Phase 29 (`vercel.json functions.api/vercel-entry.js.maxDuration: 800`; Phase 29 D-08 lock). The daily `/api/cron/refresh-events` (`0 4 * * *` UTC) is now the **sole writer** of `events:llm:v3` — it calls `runRefreshExtraction()` in `server/lib/llmExtractionPipeline.ts`, which invokes the single extractor module `server/lib/llmEventExtractor.v3.ts`. The cron triad (`/api/cron/health`, `/api/cron/warm`, `/api/cron/refresh-events`) sits inside the 800s ceiling — the Hobby-300s class of cascade-timeout failures is eliminated. Cold-cache self-heal bypasses cooldown when `events:llm:v3` is empty; operator force-trigger via `GET /api/cron/refresh-events?force=true` with the Bearer.

**How this state was reached.** The 5 historical v1.5 sub-blocks below capture HOW the milestone-final state was reached one phase at a time — Phase 30 (NIM throttle characterization + tuned defaults + SIMPLIFY-01/03 retirement), Phase 30.1 (OpenRouter dormancy declared honest), Phase 34 (Cerebras + Groq deferred), Phase 35 (Redis registry drift gate + partial-key retirement + 7-module JSDoc audit), and the Phase 37 close sub-block (this ADR rewrite + the LLM-RELI-07 3-consecutive-green acceptance-gate observation). Readers who want the canonical answer to "what did v1.5 ship?" read this body; readers who want the journey read the sub-blocks bottom-up.

## Decision

1. **NIM-only active cascade at runtime.** `server/adapters/llm-provider.ts` invokes NVIDIA NIM exclusively in the production code path (Phase 29 SIMPLIFY-04 deleted Cerebras + Groq from the runtime cascade; Phase 30.1 declared OpenRouter dormant pending re-validation; Phase 34 deferred Cerebras + Groq provisioning altogether). Per-event retry budget: 2 attempts × 1s/4s exponential backoff + ±250ms jitter, governed by the Phase 30 tuned defaults (`LLM_BATCH_TIMEOUT_MS=120000`, `RETRY_ATTEMPTS=3`, `BACKOFF_MS=[2000, 8000, 32000]`, `JITTER_MS=500`). Providers gated on circuit-breaker `isAvailable` + token-budget `budgetState !== 'hard'`. Synthetic `skipReason` entries appended to `callHistory` on bypass.

2. **v1 + v2 extractor modules and their observability surface deleted.** `server/lib/llmEventExtractor.v1.ts` and `server/lib/llmEventExtractor.v2.ts` removed along with their Redis cache keys (`events:llm`, `events:llm:v2`, `events:llm:v2:partial`, `events:llm-summary`, `events:llm-summary:v2`), the pipeline-version toggle (`isPipelineV2`, `setPipelineOverride`, the `events:llm-pipeline-override` key + endpoint), and the multi-version Pitfall 1 bridge that read them (Phase 29 D-02, Plans 04-06). v3 is now the **only** extractor; the cache bridge collapses to "serve `events:llm:v3` or raw GDELT." Phase 35 SIMPLIFY-02 further retired the `events:llm:v3:partial` observability key (358 LOC removed; writer + interface + 3 script consumers + 4 test files + CLAUDE.md bullet). Rollback path: `git revert <Phase 29 deletion commit range>` — not a runtime flag flip. The Phase 27.4 D-26/D-40 deep-rollback lock is superseded by this decision.

3. **LLM-optional architecture proven.** `/api/events` is **cache-only** (anti-pattern #17 invariant); the Pitfall 1 cache bridge in `server/routes/events.ts` serves raw GDELT when `events:llm:v3` is empty so the map never goes blank. Phase 29 added an integration test that exercises `/api/events` with all LLM credentials unset and asserts the raw-GDELT fallback; `server/__tests__/resilience/redis-death.test.ts` proves the chain works under Redis death too. The runbook (`docs/runbook.md` §6 + §13-§16, rewritten in Phase 36) carries the unset-credentials recovery procedure and the NIM-throttle handling playbook so the degrade-open posture is auditable, not just folkloric.

4. **Vercel Pro upgrade for the 800s `maxDuration` ceiling.** Phase 29 D-08 committed the upgrade ($20/mo) and locked `vercel.json functions.api/vercel-entry.js.maxDuration: 800`. The Hobby-300s wall is no longer an active failure mode; the daily LLM cron runs at ~10-min wall-clock with ~85% headroom against the new ceiling (Phase 30 Run 2: 124,533ms inside 800,000ms). The 3-entry cron schedule (`/api/cron/health`, `/api/cron/warm`, `/api/cron/refresh-events`) stays within the Hobby cap that was the original cron schema (now inherited under Pro) — no new cron entries added in v1.5.

5. **Cleanup, hygiene, and the milestone-close gate.** Phase 30 retired the Hobby-era SIMPLIFY-01 incremental Redis flush (~95% fewer SET calls per cron run) and the SIMPLIFY-03 watchdog soft-warn tier (single hard-kill at the tuned 120s). Phase 35 landed the Redis registry drift gate (`src/__tests__/lib/redis-registry.test.ts`; 39 assertions across 4 sub-suites; CLAUDE.md + `docs/architecture/redis-keys.md` + production code parity); the 32-key deep-dive inventory at `docs/architecture/redis-keys.md`; the `freeClaudeRouter` callers-block (SIMPLIFY-05); and the 7-module JSDoc audit (DOCS-INT-02). Phase 36 swept the public documentation surface (README, `docs/architecture/**/*.md`, runbook, ADR-0011, degradation contract) to match shipped reality and added two mechanical drift gates: Redocly OpenAPI lint (`server/__tests__/openapi/openapi-lint.test.ts`) and markdown-link-check (`npm run docs:lint`). Phase 37 (this milestone close) rewrites this ADR body to the milestone-final shipped state, appends the Phase 37 close sub-block as the 6th and final v1.5 sub-block, and observes `prod-connectivity-audit.yml` exit-0 with `allTiersGreen=true` for 3 consecutive runs (LLM-RELI-07) — the acceptance gate that unblocks v1.6 promotion (999.5 load test first).

## Phase 30 Sub-block (appended 2026-05-17)

Phase 30 added the numbers Phase 29 deferred ("characterize, propose, validate at 800s"). All decisions are atomic per-commit (CONTEXT D-08). Architecture-level numbers live in `docs/architecture/llm-pipeline-reliability.md`; this sub-block records the _decisions_ themselves.

- **D-01 (telemetry):** `retryAfterMs?: number | null` field added to `callHistory[]` rows in `server/lib/llmProgress.ts`. Populated in `server/lib/freeClaudeRouter.ts` 429 catch block from `error.headers['retry-after']` (case-insensitive lookup, `parseFloat` + `Number.isFinite` guard). Path A (header present → analyzer captures throttle window directly from `retryAfterMs`) and Path B (header absent → analyzer infers from `callHistory` timestamp gaps). **Run 1 path: B** (NIM returned zero `Retry-After` headers across 213 batches / ~123s). **Run 2 path: B** (same — zero 429s in either run).
- **D-02 (tuning method):** Characterize (Run 1 at v1.4 defaults) → Propose (analytical, from Run-1 numbers) → Validate (Run 2). Both runs landed inside Pro 800s ceiling (Run 1: 122628ms; Run 2: 124533ms — ~85% headroom). Because both runs hit Path B with `steadyStateRpm = 0` and `recoveryIntervalMs = null`, the formulas that depend on a measured throttle window were undefined; Plan 05 explicitly ran in **sanity-check mode** rather than measured-tuning mode. The committed defaults (`LLM_BATCH_TIMEOUT_MS=120000`, `RETRY_ATTEMPTS=3`, `BACKOFF_MS=[2000, 8000, 32000]`, `JITTER_MS=500`) are conservative defensive choices anchored to `perBatchLatency.p95 = 33263 ms` from Run 1, NOT empirical fits to a measured throttle window. See `docs/architecture/llm-pipeline-reliability.md` for the full pre/post defaults table and per-row derivation rules.
- **D-03 (eval gate):** Run-2 regression tolerance = ±3pp absolute at 5/20/100km vs `events:llm-eval-baseline:v3` (Phase 29 anchor, 90d TTL). **Result: INCONCLUSIVE.** The `runEval()` resolver-only harness returned `evalScore = 0/0/0 of 0` in both Run 1 and Run 2 because `.planning/eval/ground-truth-events.json` is not bundled into the Vercel deploy output. Both numerator and denominator were zero, so the ±3pp tolerance could not be computed. **PASS margins: N/A.** This is a known blocker carried forward to Phase 31 (LLM-RELI-06) or a follow-up plan; until the fixture-bundling bug is fixed, the correctness gate cannot be evaluated. The **safety gate** (Run 2 `watchdogTimeoutCount = 0` ≤ Run 1 `watchdogTimeoutCount = 0`) **PASSED** — that is the only deploy gate Plan 06 actually proved.
- **D-04 (SIMPLIFY-01):** Incremental flush (`mergeAndPersistLlmEntities` every N batches inside `onBatchComplete`) retired from `server/lib/llmExtractionPipeline.ts`. `LLM_FLUSH_EVERY_N_BATCHES` env var deleted (`.env.example`, `server/config.ts`). Redis SET-call count per cron run for `events:llm:v3` dropped from **~22** (at `batchCount = 213` × prior 10-batch cadence: `floor(213/10) + 1 = 22` SETs) to **1** (terminal end-of-run write only) — approximately a **95% reduction**. Net LOC delta: -92 across `llmExtractionPipeline.ts` (-86), `server/config.ts` (-1), `.env.example` (-5).
- **D-05 (SIMPLIFY-03):** Watchdog soft-warn tier eliminated. `softWarnMs` + `onSoftWarn` + `softWarnTimer` removed from `server/lib/llmExtractorWatchdog.ts`; both `withBatchWatchdog` callsites in `server/lib/llmEventExtractor.v3.ts` are `softWarnMs`-free; the `'watchdog-soft-warn'` enum literal removed from both `LLMPipelineProgress.callHistory.skipReason` and `LLMRunSummary.callHistory.skipReason` unions in `server/lib/llmProgress.ts`. Hard-kill stays as the single tier; `LLM_BATCH_TIMEOUT_MS` default bumped from **90000** to **120000** per Run-1 p95 (33263 ms) + long-tail-outlier headroom math (CONTEXT D-05 formula `max(2 × p95, throttle_window + 30s)` with `throttle_window` undefined under Path B, rounded up). Net LOC delta: -97 across watchdog source + tests, v3 extractor, and llmProgress.
- **D-06 (docs home):** `docs/architecture/llm-pipeline-reliability.md` created as the measurement home — Findings table (Run 1 + Run 2 numbers from snapshot JSONs), Tuned Defaults table (pre/post values + derivation rules + rollback recipe), Retired Mechanisms block (SIMPLIFY-01 + SIMPLIFY-03 rationale + LOC deltas), Phase 31 placeholder. CLAUDE.md adds one pointer line under "LLM Event Pipeline" (no reliability prose in CLAUDE.md itself — Phase 29 D-06 5018-token budget preserved). This ADR captures the **decision**; the architecture doc captures the **measurement**. Phase 31's 7-day watch (LLM-RELI-06) appends to a placeholder section in the architecture doc rather than restructuring it.
- **D-07 (env tunability):** `LLM_BATCH_SIZE` promoted from hard-coded `const BATCH_SIZE = 2` in `server/lib/llmEventExtractor.v3.ts:83` to env-tunable via `server/config.ts` Zod schema. **Default: 2 (UNCHANGED)** — Plan 05 chose not to raise toward 4–8 because the eval gate (D-03) is INCONCLUSIVE, so any bump would be a guess rather than a measurement. Behavior is byte-identical until an operator sets `LLM_BATCH_SIZE` explicitly. Env vars (`LLM_V3_CONCURRENCY`, `LLM_BATCH_SIZE`, `LLM_BATCH_TIMEOUT_MS`) stay tunable for mid-incident operator override; router constants (`BACKOFF_MS`, `JITTER_MS`, `RETRY_ATTEMPTS`) are NOT env-tunable and require `git revert` for in-incident reversion.

**Rollback recipe** (preserves v1.4 numerical behavior modulo soft-warn deletion):

```bash
LLM_V3_CONCURRENCY=12 LLM_BATCH_SIZE=2 LLM_BATCH_TIMEOUT_MS=90000
# Router-constant reversion (BACKOFF_MS / JITTER_MS / RETRY_ATTEMPTS) requires:
#   git revert <Plan 05 freeClaudeRouter tune commit, e.g. 6d6b427>
# Soft-warn deletion is code-only and requires:
#   git revert <Plan 04 watchdog soft-warn deletion commit, e.g. 32a2b51>
```

**Out of scope (carries forward):**

- 7-day cron-stability watch on tuned defaults → Phase 31 (LLM-RELI-06)
- Eval-harness ground-truth fixture bundling fix (blocker for D-03 correctness gate) → Phase 31 prerequisite or follow-up plan
- `events:llm:v3:partial` retirement → Phase 35 (SIMPLIFY-02)
- Per-batch adaptive sizing (`V3_ADAPTIVE_BATCH`) — deferred until Phase 31 data argues for it
- Diff-filter cache-key mismatch (Run 2 surfaced that cached event ids carry `llm-v3-grp-` prefix but group keys do not, so the cron re-processes everything) — surfaced in Plan 06 SUMMARY; follow-up plan TBD

## Phase 30.1 Sub-block (appended 2026-05-17)

Phase 30.1 confronted the silent NIM-only reality the operator surfaced at the Phase 30 boundary. Phase 27.4.4 Plan 02 had hardcoded `skipOpenRouter: true` at `server/lib/llmEventExtractor.v3.ts:630, 952`, removing OpenRouter from the active cascade. The 2026-05-17 04:00 UTC cron exposed the failure mode (NIM 39 rate_limit → breaker tripped → 50+ batches dropped with zero OR attempts).

Re-tested OR free-tier 2026-05-17 via `scripts/probe-openrouter.ts`: 27/30 rate_limited (90.0%). Conclusion: NIM-only active; OpenRouter dormant pending Phase-31-or-later re-validation. Phase 27.4.4's 16/16 measurement stale by 2 months but the free tier is still not viable.

- **D-01 (scope choice):** Minimum scope per D-05 (`rateLimitedPct ≥ 90%` → OpenRouter not viable). No code change in 30.1. The free-tier flip would amplify breaker error rate without delivering successful extractions.
- **D-08 (terminal fallback):** Per D-08 paragraph (mandatory in BOTH branches): batches still drop on breaker-trip; `/api/events` still serves raw GDELT via the Pitfall 1 bridge. Map never goes blank. The NIM-only declaration acknowledges this failure mode honestly rather than hiding it behind a non-functional cascade claim.
- **D-09 (breaker untouched):** `server/lib/llmCircuitBreaker.ts` not re-tuned — same discipline as Phase 30 D-09.
- **D-13 (CLAUDE.md):** "LLM Event Pipeline" line amended to declare OpenRouter fallback dormant pending re-validation. Single-line change; preserves Phase 29 D-06 5018-token budget.

**Phase 31 or fresh-phase follow-up candidates:**

- Paid-OR conversion (~$0.04/day = ~$1.20/mo for full coverage; seed Q4).
- Adaptive Retry-After-aware NIM limiter (Phase 30 D-01's `retryAfterMs` field is already on `callHistory` — wire it into `nvidiaNimWindow` so post-429 calls wait the server-requested duration).
- NIM model switch to a lower-cap-friendly variant (would require fresh bake-off vs Phase 27.4.1's qwen-235b lock).
- Dashboard surface for cascade-degraded state (its own phase; overlaps Phase 32 + Phase 35).
- Re-run `scripts/probe-openrouter.ts` quarterly to catch envelope improvements that would unlock the free-tier restore.

**Architecture-level numbers** (probe + percentages + cascade decision): `docs/architecture/llm-pipeline-reliability.md`. This sub-block records the **decision**; the architecture doc records the **measurement** (mirrors the Phase 30 sub-block convention).

**Out of scope (carries forward):**

- Free-tier `skipOpenRouter: true` removal — deferred until a future probe lands `< 50%` per D-05.
- All Phase 31 prep items remain Phase 31's scope (eval-fixture bundling, diff-filter ID-mismatch, CACHE_KEY_PREFIX whitespace gotcha).

## Phase 34 Sub-block (appended 2026-05-23)

Phase 34 was inserted 2026-05-19 to restore Cerebras + Groq adapters (deleted Phase 29 SIMPLIFY-04) so NIM throttle events stop translating into DLQ entries (Phase 31 Day-1 baseline: 4 × `v3:timeout_watchdog`). The plan was probe-driven: only providers whose free-tier throttle is empirically independent of NIM's would land in the cascade.

**Outcome: `cerebras-groq-deferred` (operator decision — probe not run).** The operator chose to skip Cerebras + Groq integration entirely rather than provision free-tier accounts and run the probe. This matches Phase 30.1's `nim-only` precedent: a deliberate empirical decision that "free-tier provider expansion is not currently the right lever" is itself a load-bearing close-out per CONTEXT.md D-02. No code lands in this phase; no probe artifact exists.

- **D-01 (scope choice):** Honest deferral — operator skipped probe + adapter restoration. Plans 34-01 through 34-04 SKIPPED; only Plan 34-05 (this close-out) executed.
- **D-02 (close-out branch):** Triggered the "both providers deferred" branch baked into CONTEXT.md D-02. The empirical "no probe needed — operator deferral is sufficient" finding is the deliverable.
- **D-08 (terminal fallback):** Unchanged from Phase 30.1 — `/api/events` continues to serve raw GDELT when `events:llm:v3` is empty (Pitfall 1 bridge). Map never goes blank. NIM throttle events still translate into DLQ entries under the current single-provider cascade; this is the failure mode Phase 34 was designed to mitigate but is now deferred.
- **D-31 (CLAUDE.md):** "Active providers" line updated to declare Cerebras + Groq deferred alongside OpenRouter. Single-line change; preserves Phase 29 D-06 5018-token budget. No new Redis registry entries added (no adapters means no `llm:tokens:cerebras|groq` keys).

**Phase-35-or-later follow-up candidates (if the deferral is reconsidered):**

- Run `scripts/probe-cerebras-groq.ts` (planned but unimplemented in Plan 34-01 — would need to be written) against fresh Cerebras + Groq free-tier accounts to measure actual rate-limit behavior against the v3 extractor payload shape.
- Adopt a paid provider tier on either Cerebras or Groq (~$5-50/mo depending on volume) to bypass the free-tier rate-limit ceiling.
- Adaptive Retry-After-aware NIM limiter (Phase 30 D-01's `retryAfterMs` field is already on `callHistory` — wire it into `nvidiaNimWindow` so post-429 calls wait the server-requested duration). Addresses the DLQ-baseline pain without provider expansion.
- Per-provider eval infrastructure (`providerProvenance` + `EvalScore.byProvider`) and `cascade_exhausted` DLQ taxonomy were also deferred — re-introduce in a future phase if/when a multi-provider story emerges.

**Architecture-level numbers** (none — no probe ran): `docs/architecture/llm-pipeline-reliability.md`. This sub-block records the **decision**; the architecture doc records the **deferral rationale** (mirrors the Phase 30 + 30.1 sub-block convention).

**Out of scope (carries forward to future phases):**

- All four LLM-RELI-08..11 requirements close as Done with the deferral outcome. If a future phase restores multi-provider cascade work, those phases inherit fresh requirement IDs (LLM-RELI-12+).
- Existing planning artifacts (`34-CONTEXT.md`, `34-RESEARCH.md`, `34-01-PLAN.md` through `34-05-PLAN.md`) remain in `.planning/phases/34-.../` as the audit trail for what was planned but not executed.

## Phase 35 Sub-block (appended 2026-05-27)

Phase 35 closed the v1.5 documentation-and-cleanup track deferred while LLM-RELI ran. Mechanical drift gate (D-01 vitest) is the load-bearing primitive — the hand-maintained CLAUDE.md registry rotted in expected ways during Phases 27-34 (4 missing keys, 1 retire-but-still-listed, 2 needing refinement); the gate prevents recurrence. Partial-key retirement (D-12 / SIMPLIFY-02) was the only code deletion. Everything else is documentation authoring.

- **D-01 (drift gate):** `src/__tests__/lib/redis-registry.test.ts` parses CLAUDE.md §Serverless Cache + `docs/architecture/redis-keys.md` + greps `server/` + `src/` production code; asserts 3-surface parity. Drift fails the next `vitest run`. Mirrors `colorBridge.test.ts` / `actorCatalog.test.ts` / `urlLiveness.schema.test.ts` precedents. 39 assertions across 4 sub-suites at phase close (1 fewer than 40 reported during plan 35-01 because plan 35-02 retired the partial-key bullet from CLAUDE.md, reducing the documented-key it.each iteration count by exactly 1).
- **D-12 (SIMPLIFY-02):** `events:llm:v3:partial` observability key + writer (`writePartialCache` at `llmEventExtractor.v3.ts`) + `LLMCachePayload` interface + 3 script consumers + 4 test files + CLAUDE.md bullet retired. Hobby-era 300s-budget mitigation; Pro 800s makes terminal writes reliable; partial-key carried no live signal. Production cleanup = natural TTL expiry within `LLM_REDIS_TTL_SEC` (≈ 2.5h) of deploy (D-13). 358 LOC removed in a single atomic commit.
- **D-15 (SIMPLIFY-05):** `server/lib/freeClaudeRouter.ts` top-of-file callers block prepended — 3 live production callers verified by grep (`llmEventExtractor.v3.ts:40`, `llmResolver.ts:15`, `llm-provider.ts:23`); Phase 34 cascade shape documented inline; existing vendored-from block preserved as historical waymarker.
- **D-17 (TTL right-sizing):** Audit-only outcome — every one of 32 keys (counting parametric families once) reviewed against producer cadence + freshness; finding `right-sized` for every entry. Artifact at `.planning/phases/35-*/35-05-TTL-REVIEW.md`. D-18 (replay-history cap) closed as satisfied by existing `operator:audit-log` cap (500/30d via `OPERATOR_AUDIT_MAX_ENTRIES` + `OPERATOR_AUDIT_TTL_SEC`); grep returned zero matches for a separate `replay-history*` key, and replay actions are recorded in `operator:audit-log` via the `operation: 'replay'` discriminator. Same precedent as Phase 31 closing early with "no incidents observed" being itself the deliverable.
- **D-19 (bundle-size delta):** `api/vercel-entry.js` baseline = **1,779,504 bytes** (2026-05-26); close = **1,790,243 bytes** (2026-05-27). Delta = **+10,739 bytes (+0.60%)**. The partial-key deletion savings (~358 LOC stripped from `llmEventExtractor.v3.ts` + supporting files) were offset by JSDoc additions in plan 35-04 (28 new one-liners across 7 LLM-pipeline modules, ~80 bytes each + the partial-key tombstone comments). Net effect ≈ 10KB on a 1.7MB bundle — negligible; intent of the measurement (verify cleanup didn't regress materially) is satisfied.
- **D-20 (Upstash budget delta):** Operator dashboard reading at phase close = **443,094 commands** (baseline ≈ 443,000 / 500K monthly budget). Delta ≈ +94 commands over ~24h between baseline + close screenshots. The window is too short to surface partial-key-retirement command-budget savings (those manifest over 24h+ as the partial-key writer no longer fires ~5×/cron-run); the post-phase observation window will capture them in plan 35-01's `redis-budget-baseline-2026-05-27.png` vs the next baseline capture (recommended after 7 days of post-deploy operation).
- **D-22 (this sub-block):** Captures Phase 35 close measurements + decisions. Mirrors Phase 30 / 30.1 / 34 sub-block convention.
- **Phase 34 carryover note:** No Cerebras / Groq token-budget keys exist in registry (Phase 34 closed `cerebras-groq-deferred` — operator chose to skip provisioning). The Phase 35 `docs/architecture/redis-keys.md` inventory records `absent (Phase 34 deferred — see ADR-0010 Phase 34 sub-block)` for those slots, satisfying the registry-as-documentation surface.

**Outcome:** 6 plans executed; 6/9 requirements closed at phase end (DOCS-INT-02, DOCS-INT-03, REDIS-OPT-01, REDIS-OPT-02, REDIS-OPT-03, REDIS-OPT-04, SIMPLIFY-02, SIMPLIFY-05, SIMPLIFY-07). 17 atomic commits land on `feature/35-internal-docs-jsdoc-redis-registry-redis-optimization-cleanu`. Branch ready for merge to main.

**Architecture-level numbers:** `docs/architecture/redis-keys.md` — the 32-key deep-dive inventory authored in plan 35-01 and pinned by the drift gate. Future Redis-key work edits CLAUDE.md + `redis-keys.md` in lockstep or the gate fails.

## Phase 37 Close Sub-block (appended 2026-05-31)

Phase 37 closes the v1.5 LLM Reliability & Reveal Prep milestone with two load-bearing artifacts: the ADR-0010 milestone-final rewrite (the body above — Context / Decision / Consequences / Alternatives Considered / References — now describes the milestone-final shipped state rather than the Phase 29-open intent that was partly superseded by Phases 30.1 + 34) AND the 3-consecutive-green `prod-connectivity-audit.yml` acceptance-gate observation (LLM-RELI-07). The 5 historical v1.5 sub-blocks above (Phase 30 / 30.1 / 34 / 35; plus the Phase 29 framing now condensed into the rewritten Context/Decision lead-in) remain intact as the per-phase decision trail showing HOW the milestone-final state was reached. This Phase 37 sub-block is the 6th and final v1.5 sub-block; it sits above `## Consequences` so a reader sees milestone-final body → 6 historical sub-blocks → milestone-final Consequences end-to-end.

- **D-01 (full body rewrite + 5 sub-blocks preserved):** ADR-0010 body sections (Context, Decision, Consequences, Alternatives Considered, References) rewritten to describe milestone-final shipped state — NIM-only at runtime, OpenRouter dormant (Phase 30.1), Cerebras + Groq deferred (Phase 34), v1+v2 extractors deleted (Phase 29 D-02), Pitfall 1 cache bridge serves raw GDELT when `events:llm:v3` is empty (`server/routes/events.ts`; map never goes blank). The 5 existing sub-blocks (Phase 30 / 30.1 / 34 / 35; with Phase 29 framing now condensed into the rewritten Context/Decision lead-in) preserved as the historical decision trail. Reads as a single canonical ADR end-to-end. (Plan 37-01.)
- **D-02 (absorb expand_at_36 marker + rewrite Consequences / Alternatives Considered / References):** HTML comment `<expand_at_36>` deleted from the file. Consequences rewritten: Positive (smaller code surface; simpler rollback via `git revert`; active-code-path-is-active-code-path clarity; NIM-only honesty surfaces the Phase 31 Day-1 DLQ baseline `4 × v3:timeout_watchdog`); Negative (Phase 27.4 D-26/D-40 deep-rollback lock superseded; ADR-0009 partially historical because the `events:llm:v3:partial` pattern it inspired was retired in Phase 35 SIMPLIFY-02 per the [Phase 35 sub-block](#phase-35-sub-block-appended-2026-05-27) D-12; cron Hobby-300s class of failures eliminated but NIM throttle remains the single point of failure under the Phase 34 deferral); Neutral (`shouldPauseNewEvents()` soft-cap pause unreachable post-v2-deletion). Alternatives Considered expanded to include the 2 Phase 29-era alternatives (archive `v1.ts` + `v2.ts` to `attic/`; add `LLM_PIPELINE_ENABLED` env-var kill-switch — both rejected), the Phase 30.1-era OR-restore-via-free-tier choice (rejected per `scripts/probe-openrouter.ts` 27/30 = 90.0% rate_limited), and the Phase 34-era Cerebras/Groq-provision choice (rejected per operator deferral, documented as `cerebras-groq-deferred`). References rewritten to include all 9 v1.5 phase CONTEXT.md paths, 8 v1.5 phase SUMMARY.md paths + Phase 37 SUMMARY forward-reference, 5 architecture cross-links (`llm-pipeline-reliability.md`, `redis-keys.md`, ADR-0009, ADR-0011, CLAUDE.md §"LLM Event Pipeline" + §"Serverless Cache"), 2 code references (`server/routes/events.ts` Pitfall 1 bridge + `server/__tests__/resilience/redis-death.test.ts`), the Phase 27.4 D-26/D-40 superseded-lock callout, and the commit-range placeholder (filled at PR merge). (Plan 37-01.)
- **D-03 (inline citation per D-N row):** Each D-N row in this sub-block that closes a requirement cites it inline. D-04 below cites DOCS-PUB-04 inline as the requirement this sub-block lands. The forward-reference row directly below (the `D-XX (LLM-RELI-07)` placeholder) preserves the inline-citation convention for the gate evidence row that Plan 37-02 captures and Plan 37-03 finalizes. Requirements traceability lives in the prose; 37-SUMMARY.md's closing decision table provides the second cross-reference surface (Phase 35 D-15 / Phase 36 D-25 / Phase 37 D-19 convention). (Plan 37-01.)
- **D-04 (DOCS-PUB-04 — Phase 37 close sub-block content + v1.5 Milestone Close Rollup):** This sub-block itself — D-N rows mirror Phase 37 CONTEXT.md D-01..D-05 plus a `### v1.5 Milestone Close Rollup` subsection below that surfaces the cumulative arc across all 6 v1.5 sub-blocks. The rollup reads as the milestone retrospective from inside the ADR; readers who want the per-phase outcome table follow the cross-link into `37-SUMMARY.md`. DOCS-PUB-04 closes with this sub-block landing. (Plan 37-01.)
- **D-05 (status line gains second line):** `**Status:** Accepted (v1.5 closed 2026-06-03)` appended as line 4 of the file, directly below the existing `**Status:** Accepted` line 3 (preserved verbatim — that IS the Phase 29-open acceptance point on 2026-05-11). Reads as a two-state visual at the top of the ADR: the decision was Accepted at Phase 29 open; the v1.5 milestone closed at Phase 37 close. Plan 37-01 landed this with `2026-05-31` as a placeholder; Plan 37-03 rewrote to the actual milestone-close date `2026-06-03` once the 3-greens acceptance gate observation completed. (Plan 37-01 + Plan 37-03.)
- **D-06 (LLM-RELI-07 acceptance gate observed):** 3 consecutive `prod-connectivity-audit.yml` exit-0 runs with `audit:connectivity:last-result.allTiersGreen === true`. Run 1: [26771054370](https://github.com/zack-maz/otg-iran-monitor/actions/runs/26771054370) at 2026-06-01T17:33:08Z. Run 2: [26856054351](https://github.com/zack-maz/otg-iran-monitor/actions/runs/26856054351) at 2026-06-03T00:24:05Z. Run 3: [26856364229](https://github.com/zack-maz/otg-iran-monitor/actions/runs/26856364229) at 2026-06-03T00:33:32Z. Tier shape consistent across all 3 runs: `critical=healthy, nonCritical=degraded, static=healthy, probeOnly=healthy, cron=healthy`. Cadence: Run 1 → Run 2 spans 31h and crosses TWO 04:00 UTC `refresh-events` cron ticks (exceeds D-06 single-crossing requirement); Runs 2 + 3 compressed to ~9 min apart per D-08 NOTE — deliberate back-to-back smoke test after PR #34 (D-03 truth-table relaxation) landed and Run 2 came back green. Full evidence triplets + framing-gap rationale at `37-SUMMARY.md §Acceptance Gate Observation`. 4 architectural unblocker PRs landed during the observation window: PR #32 (llmEvents demoted to non-critical + LLM-optional degraded-on-fallback in `probeCacheKey` / `probeLlmStatus`); PR #33 (news GDELT-DOC best-effort + RSS-only sidecar fallback signal); PR #34 (D-03 truth-table relaxed for non-critical tier — accepts `healthy|degraded|unknown`); PR #35 (hotfix YAML/shell apostrophe quoting in PR #34's comment block). These are not gate-evasion patches — they correct architectural mismatches the original Phase 28.2.5 D-09 strict-tier-green gate treated as failures despite being correct shipped behavior under ADR-0010's LLM-optional contract. LLM-RELI-07 closes here. v1.5 → v1.6 promotion unblocked; Phase 999.5 (Performance Load Test, 1-300 VU k6 sweep) promotes from `.planning/phases/999.5-performance-load-test/` as v1.6's first phase. (Plan 37-02 + Plan 37-03.)

### v1.5 Milestone Close Rollup

The 6 v1.5 sub-blocks within this ADR read as the milestone retrospective from inside the ADR:

1. **Phase 29 (now condensed into the rewritten Context/Decision body above)** — cascade narrowed to NIM + OpenRouter; v1+v2 extractors deleted (Plans 04-06); LLM-optional architecture proven (integration test with all LLM credentials unset; `/api/events` serves raw GDELT via Pitfall 1); Vercel Pro upgrade ($20/mo, `maxDuration: 300 → 800`); Cerebras + Groq adapter dead-code purged; CLAUDE.md trimmed 73.3% to 5018 tokens. (Closed 2026-05-11.)
2. **Phase 30 sub-block (above)** — NIM throttle characterization (Path B — `Retry-After` headers absent in both Run 1 + Run 2 across 213 batches; defensive defaults anchored to `perBatchLatency.p95 = 33,263ms`); committed `LLM_BATCH_TIMEOUT_MS = 120000` / `RETRY_ATTEMPTS = 3` / `BACKOFF_MS = [2000, 8000, 32000]` / `JITTER_MS = 500`; SIMPLIFY-01 incremental flush retired (~95% fewer Redis SET calls per cron run; net LOC -92); SIMPLIFY-03 watchdog soft-warn tier eliminated (net LOC -97); `docs/architecture/llm-pipeline-reliability.md` created as the measurement home. (Closed 2026-05-17.)
3. **Phase 30.1 sub-block (above)** — Cascade reality declared honest: OpenRouter dormant pending re-validation (`scripts/probe-openrouter.ts` 2026-05-17 result = 27/30 rate_limited = 90.0%). CLAUDE.md "Active providers" line amended in lockstep. No code change. The Pitfall 1 terminal fallback (D-08) acknowledged as the load-bearing safety net under single-provider cascade. (Closed 2026-05-17.)
4. **Phase 34 sub-block (above)** — Cerebras + Groq deferred (`cerebras-groq-deferred` close-out; operator chose to skip provisioning free-tier accounts and running `scripts/probe-cerebras-groq.ts`). LLM-RELI-08..11 closed as Done with the deferral outcome. CLAUDE.md "Active providers" line amended in lockstep. No code change. Phase 31 Day-1 DLQ baseline (`4 × v3:timeout_watchdog`) accepted as known failure mode. (Closed 2026-05-23.)
5. **Phase 35 sub-block (above)** — Redis registry drift gate landed (`src/__tests__/lib/redis-registry.test.ts`; 39 assertions across 4 sub-suites; CLAUDE.md + `docs/architecture/redis-keys.md` + production code parity); 32-key deep-dive inventory at `docs/architecture/redis-keys.md`; `events:llm:v3:partial` retired (SIMPLIFY-02; 358 LOC removed in a single atomic commit); `freeClaudeRouter.ts` callers block documented (SIMPLIFY-05); 7-module JSDoc audit (DOCS-INT-02). Bundle delta: 1,779,504 → 1,790,243 bytes (+10,739 bytes / +0.60%; JSDoc additions outweighed partial-key deletion). (Closed 2026-05-27.)
6. **Phase 37 (this sub-block)** — ADR-0010 milestone-final body rewrite + this 6th-and-final close sub-block; status line gains second line (`Status: Accepted (v1.5 closed 2026-06-03)`); 3 consecutive `prod-connectivity-audit.yml` exit-0 runs observed with `audit:connectivity:last-result.allTiersGreen === true` (LLM-RELI-07; evidence triplets at `37-SUMMARY.md §Acceptance Gate Observation`); 4 architectural unblocker PRs landed during observation (PR #32 llmEvents demotion + LLM-optional probe-fallback; PR #33 news GDELT best-effort; PR #34 D-03 truth-table relaxed; PR #35 quoting hotfix); CHANGELOG[v1.5] entry; 37-SUMMARY.md with per-phase rollup across all 10 v1.5 phases + framing-gap callouts + v1.5 quantitative snapshot + v1.6 promotion readiness statement; ROADMAP / REQUIREMENTS / STATE flips for Phase 37 + DOCS-PUB-04 + LLM-RELI-07. v1.6 promotion unblocked (999.5 Performance Optimization + 1-300 VU k6 sweep promotes from `.planning/phases/999.5-performance-load-test/` as the v1.6 first phase). (Closed 2026-06-03.)

See `37-SUMMARY.md` for the full per-phase outcome table across all 10 v1.5 phases (29, 30, 30.1, 31, 32, 33, 34, 35, 36, 37) and the closing Decision-by-Decision Outcome table.

### Outcome

3 plans executed across Wave 1 / Wave 2 / Wave 3 (Plan 37-01 ADR rewrite; Plan 37-02 acceptance-gate observation; Plan 37-03 close ritual including CHANGELOG[v1.5] entry, 37-SUMMARY.md, and ROADMAP / REQUIREMENTS / STATE flips). ADR-0010 body rewritten to milestone-final state + 6th and final v1.5 sub-block landed. 3 consecutive `prod-connectivity-audit.yml` exit-0 runs observed across 24-48 hours per Phase 37 CONTEXT D-06 (LLM-RELI-07 satisfied). Atomic commits land on `feature/37-adr-0010-acceptance-gate-closeout`. v1.5 LLM Reliability & Reveal Prep milestone shipped; v1.6 promotion unblocked.

**Architecture-level numbers:** `docs/architecture/llm-pipeline-reliability.md` for the cumulative measurement story across Phases 30 / 30.1 / 34. This sub-block records the milestone-close **decision**; the architecture doc records the cumulative cross-phase **measurement** chain (mirrors the Phase 30 / 30.1 / 34 / 35 sub-block convention).

**Out of scope (carries forward to v1.6+):**

- 999.5 Performance Optimization + 1-300 VU k6 sweep — unblocked by Phase 37 acceptance gate; promotes from `.planning/phases/999.5-performance-load-test/` into v1.6 as the first phase
- REVEAL-01 polish (landing page, demo flows, social-share assets, hero GIF) — v1.6 territory
- REVEAL-02 public domain — v1.6 milestone-open scoping question
- Cerebras + Groq adapter restoration — future provider-restoration phase per ADR-0010 Phase 34 sub-block follow-up candidates
- Paid-OR conversion (~$0.04/day = ~$1.20/mo for full coverage) — per ADR-0010 Phase 30.1 sub-block
- Adaptive Retry-After-aware NIM limiter — per ADR-0010 Phase 30 sub-block `retryAfterMs` field already on `callHistory`
- Per-provider eval infrastructure + `cascade_exhausted` DLQ taxonomy — deferred alongside provider restoration
- ADR-0011 Phase 37 sub-block — milestone-close work concentrated in ADR-0010; future "ADR hygiene" phase could add cross-links
- OpenAPI full-spec audit + Zod-handler reconciliation — Phase 36 D-05 capped at additions; future "API hardening" phase
- ROADMAP / REQUIREMENTS retroactive rewording for the 7 framing gaps — future "planning artifact refresh" phase

## Consequences

### Positive

- **Smaller code surface** (net direction). Bundle measurement at Phase 35 close: `api/vercel-entry.js` = **1,790,243 bytes** (vs 1,779,504 baseline). The +10,739 bytes (+0.60%) delta is JSDoc-additions-dominant — the SIMPLIFY-02 partial-key deletion stripped 358 LOC, but Plan 35-04's 28-module JSDoc audit added ~80 bytes per one-liner plus tombstone comments. Net intent (cleanup didn't regress) is satisfied; net code-path count is lower.
- **Simpler rollback.** Recovery path is `git revert <Phase 29 deletion commit range>` — not flip a runtime flag, not redeploy with an env var, not toggle a feature flag in a Redis key. Single-mechanism reversion.
- **Active-code-path-is-active-code-path clarity.** No flag-gated branches, no preserved-for-rollback modules to triage during incidents, no v2-vs-v3 racing in the events route. Operators reading `server/lib/llmEventExtractor.v3.ts` know it is THE extractor; operators reading `server/routes/events.ts` know the Pitfall 1 cache bridge is THE fallback.
- **NIM-only honesty surfaces the DLQ baseline.** The Phase 31 Day-1 observation (`4 × v3:timeout_watchdog`) is a measured failure-mode baseline under single-provider NIM, not a number hidden behind a non-functional OpenRouter-fallback claim. Phase 34's `cerebras-groq-deferred` close-out accepts this baseline rather than expanding the provider surface to hide it.

### Negative

- **Phase 27.4 D-26/D-40 deep-rollback lock superseded.** If a v3-only defect surfaces that v1 or v2 would have masked, the recovery path is `git revert <Phase 29 deletion range>` and redeploy — not flip a runtime flag. The old deep-rollback safety is gone; in exchange the code surface is honest about which extractor is live.
- **[ADR-0009](0009-two-key-split-for-llm-partial-progress-vs-terminal-reads.md) becomes partially historical.** The v2 partial-key + terminal-key split it documents pointed at `events:llm:v2:partial` / `events:llm:v2` — both deletion targets per Phase 29 D-02. The v3 partial-key pattern (`events:llm:v3:partial`) that initially inherited ADR-0009's writer/reader-shape-isolation discipline was itself **retired in Phase 35** (SIMPLIFY-02; see the [Phase 35 sub-block](#phase-35-sub-block-appended-2026-05-27) D-12 above). ADR-0009 now reads as "the lessons that informed v3" rather than "the contract live in production"; the writer/reader-shape-isolation principle remains a pattern reference for any future partial-progress observability that might re-emerge.
- **Cron Hobby-300s class of failures eliminated, but NIM throttle remains the single point of failure** per the Phase 34 deferral. The Vercel Pro upgrade removed the `maxDuration` wall (Phase 29 D-08); the empirical free-tier rate-limit ceiling on NIM is now the binding constraint. Under hard throttle, NIM 429s → circuit breaker trips → batches drop to DLQ → `/api/events` falls through to raw GDELT via Pitfall 1. The Phase 34 follow-up candidates (paid provider tier, adaptive `retryAfterMs`-aware limiter, re-probed Cerebras/Groq) are documented but not landed in v1.5.

### Neutral

- **`shouldPauseNewEvents()` soft-cap pause unreachable post-narrowing.** It gated v2-vs-v3 racing in the events route; with v2 deleted (Phase 29 D-02) the pause condition can no longer fire. Documented as Phase 30 cleanup work; the function is still imported for the soft-cap-on-token-budget code path but the v2-racing branch is dead.

## Alternatives Considered

- **Archive `v1.ts` + `v2.ts` to `attic/`** (original SIMPLIFY-06 plan; Phase 29-era). Rejected per Phase 29 D-02: archived code creates the same triage burden as preserved code — operators see the files, wonder if they are still load-bearing, and the simplification gain evaporates. Git history is the archive; commit range `<filled in at PR merge time>` is the recovery handle.
- **Add `LLM_PIPELINE_ENABLED` env-var kill-switch** (Phase 29-era). Rejected: "unset both `NVIDIA_NIM_API_KEY` and `OPENROUTER_API_KEY`" is already the kill switch — the LLM-optional architecture (Decision item 3) means absent credentials degrade cleanly to raw GDELT via Pitfall 1. A dedicated env var would duplicate that mechanism and add a configuration surface to keep in sync.
- **Restore OpenRouter via free-tier** (Phase 30.1-era). Rejected per `scripts/probe-openrouter.ts` 2026-05-17 result: **27/30 rate_limited (90.0%)** against the v3 extractor payload shape. OpenRouter free-tier is not viable for batch extraction at v1.5 close. The cascade was declared NIM-only honest in the Phase 30.1 sub-block; CLAUDE.md §"LLM Event Pipeline" was amended in lockstep. Quarterly re-probe is the documented follow-up signal that would unlock a re-enable.
- **Provision Cerebras / Groq free-tier accounts + run probe** (Phase 34-era). Rejected per operator deferral: the Phase 31 Day-1 DLQ baseline (`4 × v3:timeout_watchdog`) is accepted as a known failure mode under single-provider NIM rather than expanding the provider surface. Documented as `cerebras-groq-deferred` close-out in the [Phase 34 sub-block](#phase-34-sub-block-appended-2026-05-23). A future provider-restoration phase would write `scripts/probe-cerebras-groq.ts`, run it against fresh accounts, and re-introduce the adapters alongside `providerProvenance` + `EvalScore.byProvider` + the `cascade_exhausted` DLQ taxonomy.

## References

**Phase context (the 9 v1.5 phase CONTEXT.md sources):**

- `.planning/phases/29-llm-provider-chain-narrowing-llm-optional-architecture-verce/29-CONTEXT.md`
- `.planning/phases/30-nim-throttle-characterization-cascade-tuning-pro-enabled-sim/30-CONTEXT.md`
- `.planning/phases/30.1-cascade-fallback-fix-re-enable-openrouter-or-document-single/30.1-CONTEXT.md`
- `.planning/phases/31-cron-stability-validation-7-day-watch/31-CONTEXT.md`
- `.planning/phases/32-ghost-event-url-liveness-dashboard-prune/32-CONTEXT.md`
- `.planning/phases/33-actor-metadata-audit-canonical-catalog-eval-expansion/33-CONTEXT.md`
- `.planning/phases/34-llm-router-fallback-re-integration-cerebras-groq-per-provide/34-CONTEXT.md`
- `.planning/phases/35-internal-docs-jsdoc-redis-registry-redis-optimization-cleanu/35-CONTEXT.md`
- `.planning/phases/36-public-docs-sweep-openapi-additions/36-CONTEXT.md`

**Phase outcomes (the v1.5 phase SUMMARY.md sources):**

- `.planning/phases/29-llm-provider-chain-narrowing-llm-optional-architecture-verce/29-SUMMARY.md`
- `.planning/phases/30-nim-throttle-characterization-cascade-tuning-pro-enabled-sim/30-SUMMARY.md`
- `.planning/phases/30.1-cascade-fallback-fix-re-enable-openrouter-or-document-single/30.1-SUMMARY.md`
- `.planning/phases/31-cron-stability-validation-7-day-watch/31-SUMMARY.md`
- `.planning/phases/32-ghost-event-url-liveness-dashboard-prune/32-SUMMARY.md`
- `.planning/phases/34-llm-router-fallback-re-integration-cerebras-groq-per-provide/34-SUMMARY.md`
- `.planning/phases/35-internal-docs-jsdoc-redis-registry-redis-optimization-cleanu/35-SUMMARY.md`
- `.planning/phases/36-public-docs-sweep-openapi-additions/36-SUMMARY.md`
- Phase 37 SUMMARY: `.planning/phases/37-adr-0010-acceptance-gate-closeout/37-SUMMARY.md` (created by Plan 37-03)

**Architecture cross-links:**

- `docs/architecture/llm-pipeline-reliability.md` — cumulative measurement story across Phases 30 / 30.1 / 34 (throttle window, tuned defaults, retired-mechanism rationale)
- `docs/architecture/redis-keys.md` — 32-key deep-dive inventory authored in Phase 35 plan 35-01; pinned by the [`redis-registry.test.ts`](../../src/__tests__/lib/redis-registry.test.ts) drift gate
- [`docs/adr/0009-two-key-split-for-llm-partial-progress-vs-terminal-reads.md`](0009-two-key-split-for-llm-partial-progress-vs-terminal-reads.md) — partially historical (v2 keys it documents are deletion targets here; v3 partial-key pattern it inspired was retired in Phase 35)
- [`docs/adr/0011-v3-llm-pipeline-architecture.md`](0011-v3-llm-pipeline-architecture.md) — parallel v3-architecture ADR; Phase 36 D-21 appended the Phase 36 sub-block reaffirming NIM-only runtime cascade
- `CLAUDE.md` §"LLM Event Pipeline" + §"Serverless Cache" — operator-skim entry points for shipped reality

**Code references:**

- [`server/routes/events.ts`](../../server/routes/events.ts) — Pitfall 1 cache bridge implementation (the "map never goes blank" mechanical proof)
- [`server/__tests__/resilience/redis-death.test.ts`](../../server/__tests__/resilience/redis-death.test.ts) — proves the chain works under Redis death

**Phase 27.4 D-26/D-40 lock** (v1+v2 deep-rollback preservation — superseded here).

**Commit range:** `<filled in at PR merge time>`.

---

_Template source: Michael Nygard, "Documenting Architecture Decisions"
(2011). Short format, immutable once Accepted — supersede with a new
ADR rather than editing the body. The status line may be updated._

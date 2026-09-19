---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Final Hardening — 🚧 IN PROGRESS
current_phase: 46
current_phase_name: General Hardening + Cron Watch Start
status: verifying
stopped_at: Completed 46-03-PLAN.md
last_updated: "2026-06-22T20:09:58.549Z"
last_activity: 2026-06-22
last_activity_desc: Phase 46 execution started
progress:
  total_phases: 14
  completed_phases: 5
  total_plans: 20
  completed_plans: 20
  percent: 36
---

# Project State

> **2026-09-17 — read first.** This file was last maintained on 2026-06-22 and contradicts itself below (status tables for v1.6/v2.0 were never rolled forward; "Redis budget ~92%" is a March-era note). Actual position: v2.0 phases 42–46 are complete; 47 (load test) and 48 (load remediation) are not started; 49 (docs cleanup) was delivered out of band by the 2026-09-17 overhaul on branch `chore/overhaul-2026-09` (merged to `main` 2026-09-18). **2026-09-19:** the LLM event pipeline works in production again — NVIDIA had retired the model; it is now `google/gemma-4-31b-it`, and runs persist in checkpointed waves (branch `fix/nim-model-eol`, merged; ADR-0012). Production findings and the recommended order of work are in `docs/AUDIT-2026-09.md`. A condensed replacement for this file is proposed at `.planning/STATE.proposed.md` — it was not applied because the GSD planning write-guard blocks large shrinks of this file; apply it yourself if you want it (`GSD_ALLOW_PLANNING_SHRINK=1`). Pre-v2.0 phase history referenced below now lives at git tag `planning-archive-2026-09`, not in the working tree.

## Project Reference

See: .planning/PROJECT.md

**Core value:** Surface actionable, data-backed intelligence on the Iran conflict in real-time on an interactive 2.5D map -- numbers over narratives.

## Current Position

Phase: 46 (General Hardening + Cron Watch Start) — COMPLETE (merged 2026-06-22)
Plan: 5 of 5
Status: Phase complete. The CRON-WATCH-01 7-day watch was never read (`cron:watch:v2` has no reader).
Next: Phase 47 (~100-User Load Test) — not planned. Read `docs/AUDIT-2026-09.md` §6 first: honest health (L2), green CI and the events read path (L9) come before a load test.
Last activity: 2026-09-19 — LLM pipeline recovered in production (audit L3–L6, L8 fixed; 716 enriched events served); docs, ADR-0012 and audit statuses rolled forward. Before that, 2026-09-17/18 — audit, outage fixes, documentation overhaul (`chore/overhaul-2026-09`, merged)

Progress: [██████████] 100%

## v1.5 Phases (SHIPPED 2026-06-03)

| Phase | Name                                                                  | Requirements                                                  | Status      |
| ----- | --------------------------------------------------------------------- | ------------------------------------------------------------- | ----------- |
| 29    | LLM Provider Chain Narrowing & LLM-Optional Architecture & CLAUDE.md Trim | LLM-RELI-01, LLM-RELI-05, SIMPLIFY-04, SIMPLIFY-06, DOCS-INT-01 | ✅ Closed 2026-05-11 (13/13) |
| 30    | NIM Throttle Characterization & Cascade Tuning                        | LLM-RELI-02, LLM-RELI-03, LLM-RELI-04, SIMPLIFY-01, SIMPLIFY-03 | ✅ Closed 2026-05-17 (7/7) |
| 30.1  | Cascade fallback fix — NIM-only declared honest                       | (gap closure from Phase 30 boundary review)                   | ✅ Closed 2026-05-17 (2/4; 2 contingent SKIPS) |
| 31    | Cron Stability Validation (7-day Watch)                               | LLM-RELI-06                                                   | ⚠️ Early-close 2026-05-19 (Day 1 / 7 PASS; caveat) |
| 32    | Ghost Event URL Liveness, Dashboard & Prune                           | GHOST-01..05                                                  | ✅ Closed 2026-05-21 (6/6) |
| 33    | Actor Metadata Audit, Canonical Catalog & Eval Expansion              | ACTOR-01..05                                                  | ✅ Closed 2026-05-21 (7/7) |
| 34    | LLM Router Fallback Re-integration (Cerebras / Groq + Per-Provider Eval) | LLM-RELI-08, LLM-RELI-09, LLM-RELI-10, LLM-RELI-11           | ⚠️ Deferred 2026-05-23 (`cerebras-groq-deferred`; 1/5; 4 SKIPS) |
| 35    | Internal Docs (JSDoc) + Redis Registry Verification + Redis Optimization | DOCS-INT-02, DOCS-INT-03, REDIS-OPT-01..04, SIMPLIFY-02, SIMPLIFY-05, SIMPLIFY-07 | ✅ Closed 2026-05-27 (6/6) |
| 36    | Public Docs Sweep + OpenAPI Additions                                 | DOCS-PUB-01, 02, 03, 05, DOCS-API-01..07                      | ✅ Closed 2026-05-30 (6/6; DOCS-PUB-04 → 37) |
| 37    | ADR-0010 + Acceptance Gate Closeout                                   | DOCS-PUB-04, LLM-RELI-07                                      | ✅ Closed 2026-06-03 (3/3; LLM-RELI-07 satisfied) |

**Plans:** 60 executed / 62 declared. Conditional SKIPs: Phase 30.1 ran 2/4 (contingent on probe outcome); Phase 34 ran 1/5 (operator deferral); Phase 31 ran 4/5 (early-close).

**Acceptance gate (LLM-RELI-07):** ✅ SATISFIED 2026-06-03 — 3 consecutive `prod-connectivity-audit.yml` exit-0 runs with `audit:connectivity:last-result.allTiersGreen === true`: Run 1 [26771054370](https://github.com/zack-maz/otg-iran-monitor/actions/runs/26771054370) · Run 2 [26856054351](https://github.com/zack-maz/otg-iran-monitor/actions/runs/26856054351) · Run 3 [26856364229](https://github.com/zack-maz/otg-iran-monitor/actions/runs/26856364229). v1.6 promotion unblocked. 4 architectural unblocker PRs landed during observation (PR #32 / #33 / #34 / #35) correcting Phase 28.2.5 D-09 strict-tier-green gate vs ADR-0010 LLM-optional architecture mismatches.

**v1.5 archives:**

- Roadmap: `milestones/v1.5-ROADMAP.md`
- Requirements: `milestones/v1.5-REQUIREMENTS.md`
- Phase artifacts: `milestones/v1.5-phases/`
- Per-phase rollup with framing-gap callouts: `milestones/v1.5-phases/37-adr-0010-acceptance-gate-closeout/37-SUMMARY.md`
- ADR-0010 canonical: `docs/adr/0010-v1-5-llm-pipeline-narrowing-and-deletion.md`
- CHANGELOG: `CHANGELOG.md` §`[v1.5]`

## v1.6 Phases (planned)

| Phase | Name | Requirements | Status |
| ----- | ---- | ------------ | ------ |
| 38 | LLM Pipeline Reliability + GDELT Source Matching + Vercel Pro Cleanup | LLM-FIX-01..06, LLM-PURGE-01..09, GDELT-MATCH-01..04, WATER-LATIN-01..04, VERCEL-PRO-01..04, CRON-WATCH-01 (optional) | 📋 Planned |
| 39 | Operator Visibility — Budget + Cost + LLM Flight Recorder | BUDGET-01..04, OBS-FLIGHT-01..06 | 📋 Planned |
| 40 | Dashboard UI/UX Polish + Subtab Consolidation | UI-POLISH-01..05 | 📋 Planned |
| 41 | Public Reveal Polish | REVEAL-DOCS-01..10, REVEAL-SITE-01..04 | 📋 Planned |

**Coverage:** 57 REQ-IDs (56 required + 1 optional CRON-WATCH-01) across 4 phases. Every REQ-ID maps to exactly one phase. No orphans. Full REQ → phase → success-criterion mapping at [`.planning/REQUIREMENTS.md` §Traceability](REQUIREMENTS.md#traceability) and per-phase success criteria at [`.planning/ROADMAP.md` §Milestone v1.6](ROADMAP.md#milestone-v16-production-hardening--ACTIVE-started-2026-06-03).

**Plans:** TBD per phase (created via `/gsd:plan-phase <N>`).

**Parallelization mode (operator-locked at milestone start):** Phase 38 + 39 interleavable (both touch LLM surfaces); Phase 40 + 41 independent. Build options: (a) sequential 38 → 39 → 40 → 41; (b) interleaved 38 ‖ 39 → 40 ‖ 41. Phase 40 hard-soft-depends on Phase 39 component shapes for UI-POLISH-02 BudgetBlock + FlightRecorderBlock placement.

## v1.6 Carry-forwards Disposition (locked 2026-06-03 at milestone start)

| Carry-forward item | Disposition |
| ------------------ | ----------- |
| **Phase 999.5** Performance Optimization + 1-300 VU k6 sweep | **Deferred to v1.7.** Operator chose reliability + visibility + polish + reveal over perf testing for v1.6. Promotion gate already satisfied (Phase 37 3-greens); ready for v1.7 first-task. Backlog dir preserved at `.planning/phases/999.5-performance-load-test/`. |
| **Phase 31 reopening** (7-day cron stability watch) | **Absorbed into Phase 38 CRON-WATCH-01 (OPTIONAL).** Final absorb-or-defer decision locks at `/gsd:discuss-phase 38`. If not absorbed, carries to v1.7. |
| **Open-Meteo cache-write policy** (`water.ts:358-360`) | **Absorbed into Phase 38 LLM-FIX-02.** Audit-tier degraded-from-empty-result fixed there. |
| **`news:feed` cron warmer** | **Soft carry to Phase 38.** Folds in if scope allows during `38-CONTEXT.md`; otherwise carries to v1.7. Not a locked REQ-ID. |
| **Probe-side `lastErrorReason` token rename** | **Absorbed into Phase 38 LLM-FIX-01.** Split into `cache-fallback-active:` (generic) + `llm-optional-fallback-active:` (LLM-specific). |
| **Phase 999.1** rate-limiter public-global blocks operator | **Deferred to v1.7.** Re-evaluate at v1.7 milestone-start. Backlog dir preserved. |
| **Phase 999.2** api/vercel-entry rebuild discipline | **Potentially absorbed into Phase 38 VERCEL-PRO-02.** Vercel Build Output API evaluation may close this naturally; if pursued, 999.2 retires. If deferred, carries to v1.7. |
| **Phase 999.3** Phase 27.4.6 cron first-tick verification | **Deferred to v1.7.** Re-evaluate at v1.7 milestone-start. Backlog dir preserved. |
| **Phase 27.3.3** water-facility name romanization | **Absorbed into Phase 38 WATER-LATIN-01..04.** Operator reversed prior backlog status at v1.6 lock-in. |
| **Phase 27.4.5** LLM observability flight recorder | **Absorbed into Phase 39 OBS-FLIGHT-01..06.** Operator reversed prior "out-of-scope" status at v1.6 lock-in; adapted to v3-only pipeline. |
| **Cerebras + Groq adapter source-file removal** | **Absorbed into Phase 38 LLM-PURGE-07.** No v1.6 router-restoration scheduled; source files delete; rollback path is `git revert <Phase 29 commit range>`. |
| **Phase 999.6** Portfolio Documentation Polish + Vercel Pro Cleanup | **RETIRED from backlog.** Strand A (10 portfolio docs) → Phase 41 REVEAL-DOCS-01..10. Strand B (Vercel Pro cleanup-and-repair) → Phase 38 VERCEL-PRO-01..04. |

## v2.0 Phases (planned)

Roadmap created 2026-06-09. Numbering continues from v1.6 Phase 41 → Phase 42. Granularity `fine` (8 phases). Operator-locked priority order, research-reconciled sequencing (hardening before load test so its metrics validate the hardening and the 7-day cron watch runs in parallel; load remediation is its own phase immediately after the load test; docs last).

| Phase | Name | Requirements | Status |
| ----- | ---- | ------------ | ------ |
| 42 | Water Filter Fix | WATER-FILTER-01..04 | ✅ Closed 2026-06-10 |
| 43 | Ghost Link Prune Correctness | GHOST-06..10 | ✅ Closed 2026-06-10 |
| 44 | Events Subtab Pipeline Detail | EVENTS-TAB-01..02 | ✅ Closed 2026-06-21 (PR #43 shipped; + dead-URL count drift hotfix) |
| 45 | Dashboard Subtab Readability Redesign | DASH-READ-01..05 | 📋 Planned (next) |
| 46 | General Hardening + Cron Watch Start | HARD-01, HARD-02, CRON-WATCH-01, HARD-03 | 📋 Planned |
| 47 | ~100-User Load Test | LOAD-01..04 | 📋 Planned |
| 48 | Load Remediation | LOAD-FIX-01..02 | 📋 Planned |
| 49 | Docs Cleanup | DOCS-CLEAN-01..02 | 📋 Planned |

**Coverage:** 28 REQ-IDs across 8 phases. Every REQ-ID maps to exactly one phase. No orphans, no duplicates. Full REQ → phase → success-criterion mapping at [`.planning/REQUIREMENTS.md` §Traceability](REQUIREMENTS.md#traceability); per-phase success criteria at [`.planning/ROADMAP.md` §Milestone v2.0](ROADMAP.md#milestone-v20-final-hardening--in-progress-started-2026-06-09).

**Plans:** TBD per phase (created via `/gsd:plan-phase <N>`).

**Non-blocking:** CRON-WATCH-01 (Phase 46) is a 7-day auto-reported observation that MUST NOT gate milestone close — structured to avoid the v1.5 Phase 31 early-close repeat (logged early-close decision, not a silent Day-1 close).

**Execution order + dependencies:** 42 (independent; precedes water-subtab redesign) → 43 (server-only) → 44 (wires LLM blocks into `EventsFiltersSectionV3` before restyle) → 45 (restyle same file; ARIA contract frozen) → 46 (hardening BEFORE load test; starts the cron watch) → 47 (load test against hardened surface; D-19 edge-cache headers land at phase start) → 48 (remediate Phase 47 SLO failures; conditional-scope) → 49 (prose docs; drift gates kept green throughout 42–48).

## v1.3 Phases

| Phase | Name                                    | Status                                     |
| ----- | --------------------------------------- | ------------------------------------------ |
| 22    | GDELT Event Quality & OSINT Integration | COMPLETE (3/3 plans)                       |
| 22.1  | Fixing Dispersion                       | COMPLETE (2/2 plans)                       |
| 23    | Threat Density Improvements             | COMPLETE (2/2 plans)                       |
| 23.2  | Improving Threat Density Scatter Plots  | IN PROGRESS (1/2 plans)                    |
| 24    | Political Boundaries Layer              | IN PROGRESS (1/2 plans)                    |
| 25    | Ethnic Distribution Layer               | IN PROGRESS (1/2 plans)                    |
| 26    | Water Stress Layer                      | COMPLETE (6/6 plans, gap closure complete) |
| 26.1  | Water Layer Refinements                 | COMPLETE (3/3 plans)                       |
| 26.3  | Production Code Cleanup                 | COMPLETE (6/6 plans)                       |
| 26.4  | Documentation & External Presentation   | COMPLETE (6/6 plans)                       |

_Phase 26.2 was scrapped and renumbered to Phase 27 under v1.4 on 2026-04-08. Original Phase 27 (Performance & Load Testing) was also moved to v1.4 as Phase 28 on the same date._

## v1.4 Phases (planned)

| Phase | Name                                          | Status  |
| ----- | --------------------------------------------- | ------- |
| 27    | Conflict Geolocation Improvement (GDELT Redo) | Planned |
| 28    | Performance & Load Testing                    | Planned |

## Key Decisions

- (44-hotfix, 2026-06-21) dead-URL count drift → reconcile-sidecar over derive-from-SCAN. Root cause: `events:url-liveness-count` (no TTL) only mutated on dead↔live transitions + prune, while the liveness keys it counts expire on a finite per-status TTL; expired/departed dead keys were never decremented, so the counter drifted to a prod phantom `deadUrlCount=202` over an empty `events:url-liveness:*` keyspace, making the operator "Prune N dead events" button a permanent no-op (SCAN finds nothing → prunes 0 → count never drops). Chose to KEEP the O(1) sidecar (Phase 32 Pitfall 3 lock) and add `reconcileDeadUrlCount()` (authoritative SCAN-and-SET) wired into `runProbeSweep` (self-heals daily) + the prune path (SET to `terminalDead − pruned` instead of the drift-prone DECRBY, correcting a stale count even on a no-op) — rejected derive-deadUrlCount-from-SCAN-per-poll (undoes the O(1) optimization). DevApiStatus replay/prune buttons gained visible result lines so a 200/404/no-op never reads as "nothing happens". Proven against live Upstash (seeded 202/0-keys → reconciled to 0) and confirmed in prod (202 → 0 via the deployed prune). Shipped on `feature/44` (commit `ad5e7ba`) → `main` (PR #43). New ops tool: `scripts/reconcile-deadurl-count.ts`.
- (42-01, D-03) confirm-dedup: telemetry-first diagnosis (42-DIAGNOSIS.md, verdict confirmed_prime_suspect_dedup) confirms the name-blind, order-dependent O(n²) spatial-dedup loop (server/adapters/overpass-water.ts:1202-1212) as the cause of missing water facilities. No pivot — proceed to the pre-registered name-aware + deterministic spatialDedup fix in Plan 02. Latin-label admission gate NOT implicated; D-06 (forbidding gate loosening) NOT triggered. Diagnosis cites the SUMMED rejections.duplicate bucket, never byTypeRejections.*.duplicate (structurally always 0 post-merge per Pitfall 1). RED spatialDedup scaffold (cases a-d + it.todo e) verified: 4 dedup cases RED, 165 G1 tests GREEN, 1 todo. WATER-FILTER-01 complete.
- (41-05, D-07/D-11) Wave-3 distilled lessons + brainstorms receipts shipped (SC41-3 lessons+brainstorms portion): docs/LESSONS.md authored as a 1-page first-person distillation of RETROSPECTIVE.md surfacing the 5 named lessons (probe-before-commit, honest deferral, mechanical drift gates compound, deletion over deprecation, architecture decisions cascade into audit-tier semantics — Phase 37); cross-links BUILDING + SHOWCASE. BUILDING §7 Historical receipts (cross-links already in place from Plan 02) gained the load-bearing vision-to-shipped inline callout: origin brainstorm's day-one "numbers over narratives" thesis (held) vs its plumbing assumptions (ACLED→GDELT Phase 8.1, WebSocket→recursive setTimeout at v1.0 serverless). D-07 honored — nothing moved/deleted/archived. README localhost dead-links left untouched (pre-existing, out of scope); LESSONS.md links lint clean in isolation.
- (41-03) Wave-2 round-out docs shipped (SC41-3 concepts+COSTS+operator-guide portion): concepts.md (38 terms), COSTS.md (Vercel Pro $20/mo sole paid line + D-09 stay-on-vercel.app rationale + RETROSPECTIVE-cited dev cost), operator-guide.md (6-workflow visitor how-to distinct from runbook, `<your-bearer>` placeholder only). Audit-carried Wave-2 docs sweep applied: ADR #1/2/3/4/21/23, .env.example #6 (LLM_PIPELINE_V2/V3 removed) + #7-ACLED (marked historical, kept blank assignments so check:env drift gate stays satisfied — Rule 3), OpenAPI #16 (prune-dead-urls path) + NN-3 (llm-history path), reliability-doc NN-4 title. redocly lint valid; all 3 new docs link-check clean; fixed CLAUDE.md-inherited dead link rateLimiter.ts→rateLimit.ts.
- (41-01, D-10) Wave-0 final-sweep audit complete (SC41-1 satisfied): re-ran the v1.5-close 2nd-pass code+docs audit against current main. Phase 38 (LLM-FIX + LLM-PURGE) resolved the ENTIRE code-side punch-list (all 3 BUGS + all dead-code); the residual v1.6 cleanup is now a pure DOCS sweep. 4 net-new docs findings (README/CHANGELOG missing Phase 38/39/40 features; OpenAPI llm-history + reliability-doc title gaps) routed to Phase 41 docs waves 2-3 in 41-AUDIT.md §D. Both operator memories refreshed (resolved dropped, net-new added, still-open carried). News-warmer (punch-list #15) DEFERRED to v1.7 (operability nicety, not a reveal REQ-ID). Cerebras/Groq test fixtures RESOLVED-BY-REFRAME (LLM-PURGE-06 keeps them as deferred-provider scaffolding).
- (41-01) 7 Wave-0 red Vitest stubs on disk pinning REVEAL-SITE store slice + overlays + tour-selector existence + OG tags + capture:layers contract (RED until Plans 04/06; tsc clean). `@ts-expect-error`-glued unresolved imports wrapped in import/order disable blocks so the lint-staged sorter cannot detach the suppression.
- (38-05 PRO-01, D-09) DEFER vercel.json → vercel.ts: vercel.json is purely declarative (crons/rewrites/functions, NO headers block, no drift handlers), so the migration is net-zero simplification while adding @vercel/config + a build step + deploy-path risk mid-cleanup. Recorded in deployment.md; revisit v1.7. The recorded defer-with-rationale is what satisfies SC38-6 for PRO-01.
- (38-05 PRO-02, D-09) DEFER Build Output API for api/vercel-entry.js: a fundamental deploy-path change that risks the 800s maxDuration, the includeFiles eval-fixture copy, and the rewrite map simultaneously — wrong risk/reward mid-cleanup. Phase 999.2 stays open; revisit v1.7.
- (38-05 PRO-03) Fluid Compute compat verdict: COMPATIBLE, no code changes. Memoized createApp() reuse is correct (no per-request global state); no graceful-shutdown handler needed (Upstash REST = no connections to drain); callHistory/llmProgress singletons are process-scoped, cron-written (single writer), with Phase 28.2.7 Redis write-through — no cross-request leak. Guarded by a 2-sequential + 4-concurrent /health smoke assertion in vercel-entry.test.ts.
- (38-05 PRO-04) llm-pipeline-reliability.md header reconciled to NIM-primary / OpenRouter-dormant (consistent with the body's :134 NIM-only declaration) rather than the stale "NIM + OpenRouter cascade" header framing; Hobby/10s/60s/3-cron claims across 5 surfaces repaired to Pro 800s / 40-cron / Fluid-Compute-default semantics; dev-env Vercel CLI bumped 52.0.0 → 54.9.0 (global, not a package.json dependency).
- (38-04 WATER-LATIN-02, D-08) Library-evaluation outcome: KEEP transliteration@2.6.1, SKIP ICU. The reset acceptance bar (machine-searchable Latin token that admits the facility) is met by transliteration + an artifact-cleanup pass; ICU shares the same abjad vowel-less ceiling at native-binary serverless cost for zero quality win
- (38-04 WATER-LATIN-02) romanize() artifact-cleanup overrides applied: ة (`@`)→`a`; uppercase emphatic artifacts ص/ط/ح/ض/ظ/غ/ق lowercased en masse via toLowerCase then re-title-cased; separator-run collapse; <2-char fallback to qualifier or "Facility". No per-letter overrides beyond these were needed — the pass clears the searchable-token bar for every RESEARCH sample
- (38-04 WATER-LATIN-03) applyRomanizedName injects the romanized string as a synthetic name:en on a COPY of tags BEFORE computeAdmissionDecision; el.tags is never mutated, original preserved in nameOriginal, desalination + already-Latin facilities early-return untouched, GENERIC_OSM_NAME_RE filter intact
- (38-04 WATER-LATIN-04) The real water tooltip surface is WaterTooltip (WaterOverlay.tsx), NOT EntityTooltip.tsx (whose MapEntity|SiteEntity union excludes water); updated WaterTooltip + WaterFacilityDetail + searchUtils, left EntityTooltip unchanged
- (38-04) nameLatin/nameOriginal added OPTIONAL to WaterFacility so the live 24h-TTL water:facilities:v3 cache self-heals on next Overpass fetch (pre-Phase-38 entries without the fields still validate)
- (38-02 LLM-PURGE-01) Pipeline calls processEventGroupsV3/geocodeEnrichedEventsV3 directly with the v3-native flat-array signature; the llmEventExtractor.ts tagged-wrapper barrel was deleted rather than inlined — one truth source, fewer moving parts
- (38-02 LLM-PURGE-04, Pitfall 2) enrichedEventV2 survives as an UN-EXPORTED base const because enrichedEventV3 = enrichedEventV2.extend(); only the EXPORTED v1/v2 schemas + batchResponseV2 were deleted, and enrichedEventAny collapsed from a 3-arm discriminatedUnion to a single-arm v3 passthrough
- (38-02 LLM-PURGE-08, D-04 Path A) OpenRouter stays a dormant key-gated cascade provider (ADR-0010 semantics); only the dead llm:tokens:openrouter daily-cap counter + cap-gate were removed. daily_cap left as a legacy skipReason union member
- (38-02 LLM-PURGE-06) Cerebras/Groq env keys deleted from config + .env.example, but the Cerebras/Groq token-budget DAILY_LIMITS + circuit-breaker state are Phase-34 deferred-provider scaffolding (live structures) and were left in place per the triage rule
- Source tier registry as standalone module (sourceTiers.ts) rather than extending relevanceScorer.ts — cleaner separation of classification vs scoring
- Tier pre-filter runs before keyword/NLP scoring in filterAndScoreArticles — early exit saves NLP compute on unknown sources
- Unknown sourceTier defaults to tier 2 (neutral 1.0x multiplier) in severity scoring — conservative default avoids penalizing events where source URL is missing
- FACILITY_TYPE_LABELS exported from overpass-water.ts for shared detection of unnamed facilities in water route reverse geocoding
- labelUnnamedFacilities runs after fetch, before cache — Redis stores labeled facilities so reverse geocoding only runs on 24h cold cache
- Stress level thresholds: <=0.33 High, <=0.66 Medium, >0.66 Low (simple thirds of compositeHealth)
- Callback injection pattern for LLM pipeline progress instrumentation — keeps processEventGroups/geocodeEnrichedEvents pure and testable without module-level state mocks
- Module-level singleton for LLM progress (not Map) — simpler API, single pipeline per Vercel instance, warm-start persistence
- /api/events/llm-status gated by NODE_ENV !== 'production' — returns 404 in prod per threat model T-27.1-01
- GDELT stays on CSV export (no BigQuery) — tune existing pipeline instead
- Bellingcat RSS as sole OSINT gap-filter (no Telegram/GramJS)
- Ethnic layer: hatched overlay regions (Option C) — not solid fills
- Load target: 250 VUs (up from 100 in v1.2)
- Satellite imagery deferred to v1.4
- Dispersion only for ActionGeo_Type 3/4; centroid penalty 0.7x on confidence (multiplicative, not exclusion)
- Bellingcat corroboration uses three-gate matching (temporal AND geographic AND keyword) to prevent false boosts
- RSS_FEEDS changed from const assertion to typed array for extensibility
- parseAndFilterWithTrace kept separate from parseAndFilter to preserve production performance
- Fly-to dedup uses simple lat/lng !== equality (coordinates from lookup table, exact match correct)
- Added else-if branch to reset lastFlownPinRef when near: tag absent from query (deriveFiltersFromAST returns undefined, not null)
- disperseEvents relocated from parseAndFilter to events route for single-pass slot assignment post-merge
- CENTROID_TOLERANCE=0.01 extracted as shared constant between geoValidation.ts and dispersion.ts
- Thermal palette: 8-stop FLIR Ironbow (indigo->purple->violet->magenta->orange->amber->yellow->red) for better threat intensity differentiation
- P90 normalization: colorDomain=[0, p90] prevents high-activity zones from washing out lower-intensity areas
- Temporal decay removed from computeThreatWeight -- age-independent scoring, date filtering handles recency
- ThreatCluster type defined in ui.ts (not ThreatHeatmapOverlay) to avoid circular imports
- Integer grid indices (Math.round) for BFS neighbor lookup to avoid floating-point key mismatch
- selectedCluster and selectedEntityId mutually exclusive in uiStore via cross-clearing
- Cluster picker radius proportional to bounding box diagonal with 50km floor
- smoothstep GLSL falloff for radial gradient (smooth hermite, not quadratic)
- Linear interpolation for cell-count-to-pixel radius (12px single-cell to 100px at 20+ cells)
- Zoom threshold tracked via boolean isBelowZoom9 + ref crossover (not continuous zoom) to prevent 60fps re-renders
- Hover cluster state managed as local React state in BaseMap (not uiStore -- transient visual state)
- 4-stop simplified thermal palette replacing 8-stop FLIR Ironbow (deep purple->magenta->orange->bright red)
- Natural Earth 10m disputed areas file: ne_10m_admin_0_disputed_areas (not breakaway variant)
- Extended filter bbox (lat 0-50, lng 20-80) captures 57 countries for political overlay
- Canvas-generated 16x16 hatching pattern (8px spacing, amber #f59e0b) for disputed territories
- Disputed hover labels via MapLibre feature-state (preferred over always-visible)
- GeoEPR-2021 from ETH Zurich as ethnic boundary data source (1685 features, 596 in ME bbox)
- Douglas-Peucker simplification at epsilon=0.05 degrees reduces ethnic-zones.json from 580KB to 139KB
- Yazidi absent from GeoEPR (mapped as Kurds/Yezidis -> Kurdish); not hand-drawn per CONTEXT.md policy
- Grid-based overlap detection at 0.5-degree resolution identifies 23 overlap zones
- Only removed desalination from SiteType, left WaterFacilityType (added by 26-01) untouched -- clean parallel execution
- Karun and Litani rivers manually defined (not in Natural Earth 10m dataset)
- WRI Aqueduct 4.0 CSV used directly: 6377 basins across 29 ME countries (no fallback needed)
- Country matching for basin filtering uses exact equality (substring "Romania" matching "Oman" was a bug)
- compositeHealth: baseline dominates (75%), precipitation modifier adjusts (25%), clamped [0,1]
- PrecipitationData defined locally in waterStore.ts (not server/types.ts) since 26-03 server plan not yet executed
- Water facility icons now have dedicated shapes: waterDam (trapezoid), waterReservoir (oval), waterTreatment (building+tank), waterDesalination (factory+droplet)
- River labels use serif italic font to distinguish from ethnic overlay sans-serif labels
- Country-centroid basin lookup: WRI Aqueduct lacks lat/lng, so basinLookup uses haversine to nearest country centroid then median-stress basin
- Regional precipitation normals: 20mm/month arid default, 50mm/month Fertile Crescent (lat 30-40, lng 35-50)
- Water API dual-cache: water:facilities (24h) + water:precip (6h) as separate Redis keys
- Water facilities use same proximity alert system as sites (waterToSiteLike adapter pattern)
- Proximity alerts dismissible with 60s cooldown to prevent overwhelm from water facilities
- Alert click selects site/facility (not approaching flight) for detail panel context
- Dark purple [40,20,60] as water stress color floor -- visible on dark terrain while still reading as stressed
- Core/extended Overpass batch split: core 12 countries must succeed, extended 11 is best-effort (partial data > none)
- Route-level 30s timeout returns empty array with stale:true (not 500) -- client degrades gracefully on Overpass failure
- Score 0 (Destroyed) applied externally by useWaterLayers, not by healthToScore -- keeps scoring pure and destruction as separate concern
- STRESS_COLORS array unchanged at 5 stops -- score 0 black is handled separately in legend, not in gradient interpolation
- isPriorityCountry uses full 29-country COUNTRY_CENTROIDS_FULL (duplicated from basinLookup.ts to avoid circular dep)
- isExcludedLocation upgraded to use full centroids -- sparse 5-entry array was falsely excluding Iran/Pakistan/etc.
- Cron refresh=true guarded by vercel-cron user-agent in production; dev always allows refresh
- treatment_plant uses diamond icon placeholder pending dedicated water icons
- Labels already present from Plan 01/02 -- no duplicate changes needed for treatment_plant
- Inline haversine in useWaterLayers avoids cross-type dependency on attackStatus.ts SiteEntity imports
- Desalination audit: 63 OSM elements found but major Gulf plants missing (Israel, Kuwait, Qatar entirely absent); report-only per user decision
- Regex-based HTML title extraction (no DOM parser dep) with og:title priority and entity decoding; SHA-256 prefix cache keys
- GeoNames population threshold 200k (not 50k) to stay in 100-300 city target range; 22 ME country ISO codes for filtering
- Multi-word city substring fallback for names compromise tokenizes (Deir ez-Zor, Mazar-i-Sharif); conflict actor lexicon for Houthi/Hamas/etc.
- me-cities.json as single source of truth for both NLP lexicon and CITY_CENTROIDS (replaces 42 hardcoded entries)
- Cross-border events validated by NLP place country match (not actor country); CAMEO 182/190 hard-excluded; threshold raised 0.35->0.38
- CAMEO_TO_FIPS includes both YMN and YEM mappings for Yemen (GDELT uses both actor codes)
- ISO_TO_FIPS mapping bridges lookupCityCoords ISO codes to FIPS geo codes for NLP validation
- parseAndFilter reverted to synchronous (Phase 26.2 removed) -- was async only for title fetching
- CAMEO exclusion reverted to pre-26.2: ['180','192'] only (182/190 exclusions were 26.2-specific)
- Confidence threshold reverted to 0.35 (from 26.2's 0.38)
- Pre-existing tsc errors fixed alongside 26.2 reversion (unused imports, compromise typing)
- Express 5 req.query is read-only getter -- validateQuery middleware stores parsed data on res.locals.validatedQuery
- Zod v3 pinned (v4 has breaking changes: ZodTypeAny removed, different module structure)
- importOriginal pattern for config mocks to preserve constant re-exports after constants.ts consolidation
- parseEnv test defaults use explicit if-checks (not spread) to avoid env var override order bugs
- Pino logger with level:'silent' in test mode, pino-pretty in dev, raw JSON in production
- Module-level child loggers (not request-scoped) for adapter files lacking req context
- genReqId accepts client-provided X-Request-ID or generates UUID via crypto.randomUUID
- autoLogging ignores /health endpoint to reduce noise
- ParsedQs to Zod inferred type cast uses 'as unknown as' double-cast pattern
- AppError uses explicit property assignment (not parameter properties) due to erasableSyntaxOnly tsconfig
- Compression middleware gated by !VERCEL — Vercel CDN handles edge gzip/brotli, local dev gets compression for realistic testing
- Graceful SIGTERM handler only in isMainModule block — Vercel has its own 500ms window and Upstash Redis is REST-based (no connections to drain)
- Consistent error envelope { error, code, statusCode, requestId } established across all routes and middleware
- AppError(statusCode, code, message) is the canonical pattern for typed route errors
- Coverage thresholds pinned at current baseline (lines 66 / functions 69 / branches 53 / statements 65) as a regression ratchet -- ratchet upward as new tests land toward 80% target
- WAR_START defined locally in src/lib/constants.ts (was re-exported from removed server/constants.js); duplicates server/config.ts to keep frontend tier independent
- vi.useFakeTimers() pattern for tests that compare two computeSeverityScore() calls (eliminates Date.now() microsecond drift between back-to-back invocations)
- noUncheckedIndexedAccess enabled on server tsconfig only — client-side would cascade through deck.gl/maplibre layers where runtime types are looser than declared
- getCol() helper centralizes bounds-checked CSV column reads in GDELT adapter rather than scattering non-null assertions
- Cast-with-comment pattern for deck.gl v9 GeoJsonLayer/IconLayer types (runtime accepts FeatureCollection/HTMLCanvasElement but v9 type defs are stricter)
- Rate limit test fixture swap: rateLimiters.flights aliased locally instead of preserving deprecated rateLimitMiddleware export purely for tests
- OpenAPI 3.0.3 spec hand-written (not zod-to-openapi generated) to avoid code-gen runtime dep and keep editorial descriptions for portfolio review
- allOf composition in OpenAPI for CacheResponse&lt;T&gt; pattern (OpenAPI 3.0 has no generics)
- Prettier 3 + eslint-config-prettier 10 (flat) + knip 5 installed; lint:fix, format, format:check, knip, check:env scripts added (26.4-01)
- eslint argsIgnorePattern '^\_' enforces existing underscore-prefix convention for intentionally-unused identifiers (26.4-01)
- getIconAtlasForLayer() wrapper in icons.ts eliminates 9 iconAtlas `as any` casts across useEntityLayers and useWaterLayers (26.4-01)
- Static GeoJSON imports typed via `as unknown as FeatureCollection` instead of `as any` -- deck.gl v9 type defs are stricter than runtime contract (26.4-01)
- ColorReliefLayer wrapper component isolates the maplibre 5 `color-relief` type cast so @vis.gl/react-maplibre 8 type gap is contained (26.4-01)
- scripts/check-env-example.ts drift checker forces NODE_ENV=test before dynamic import of server/config so parseEnv() returns safe defaults (26.4-01)
- knip.json whitelists tailwindcss / pino-pretty / @types/pino-http -- CSS @import / string-literal / type-only usage cannot be statically detected (26.4-01)
- 81 pre-existing lint errors absorbed into Plan 01 Task 1 commit (26.4-01 cleanup pass intentionally covers pre-existing tech debt)
- Deleted @deck.gl/aggregation-layers and @deck.gl/react deps (genuinely unused; test mocks aliased via vite.config) (26.4-01)
- Pino redactPaths exported from server/lib/logger.ts; redact.paths includes authorization/cookie/x-api-key/set-cookie headers plus wildcard tokens (UPSTASH/OPENSKY/AISSTREAM/ADSB) and production-only req.ip/remoteAddress; redaction proof test uses pino write-stream sink (26.4-03)
- type-coverage baseline measured at 97.05% (7970/8212); CI gate locked at 97 floor as regression ratchet; 99% aspirational target deferred (deck.gl/maplibre v9 type-cast cleanup out of scope) (26.4-03)
- Chaos test server/**tests**/resilience/redis-death.test.ts boots real Express app via supertest + mocked @upstash/redis throwing on every call; asserts all 8 cached routes + /health return 200 degraded or 502/503 — never 500 (26.4-03)
- Chaos test exposed Path A gap in events route (shouldBackfill + backfill-ts writeback calling raw redis.get/set); fixed with try/catch helpers + new recordBackfillTimestamp best-effort helper (26.4-03)
- Chaos test exposed Path B gap in cacheGetSafe/cacheSetSafe — safe wrappers caught sync throws but NOT hung Upstash client calls (client retries internally on undefined URL, blocks forever); added withTimeout Promise.race wrapper with REDIS_OP_TIMEOUT_MS=2000 in server/cache/redis.ts — this is the core production resilience fix, not just test scaffolding (26.4-03)
- 2000ms Redis op timeout chosen as 25x the healthy Upstash RTT (~50-200ms) — zero impact on happy path, caps worst-case hung call, prevents Vercel lambda timeout cascade (26.4-03)
- sendValidated<S>(res, schema, payload) middleware added with dev-throw / prod-warn semantics; dev mismatch throws AppError(500, RESPONSE_SCHEMA_MISMATCH) caught by errorHandler; prod mismatch logs warn via pino child logger and falls through with original payload (26.4-03)
- cacheResponseSchema<T> generic zod wrapper mirrors OpenAPI CacheResponseBase allOf composition; entity schemas (flight, conflict event, water facility) use passthrough() on nested data fields for drift tolerance (26.4-03)
- sendValidated wired into flights, events, water routes as proof-of-concept (3 of 14 cached routes); remaining 11 deferred to future maintenance pass per plan scope (26.4-03)
- Sites route needed no code changes under chaos — its failure was purely the hung cacheGetSafe call which the timeout wrapper closes (26.4-03)
- Stripped 9 debug console.log('[EVENTS] ...') tracer lines from events.ts that were left uncommitted at end of previous session; pre-empted via grep check before commit (26.4-03)
- Mermaid inline architecture docs over committed SVG/PNG — renders natively on GitHub, diffs cleanly in PRs, no build step, evolves with code (26.4-05)
- Ontology documentation split into 4 focused files (types/algorithms/state-machines/complexity) to prevent unreadable monolith; single file approach rejected (26.4-05)
- As-built honesty principle: TODO(26.2) tech debt labeled inline in architecture diagrams (hardcoded CAMEO table in gdelt.ts, centroid dispersion gaps in dispersion.ts, NLP extraction fields in NewsArticle, coarse nearest-country-centroid basin lookup) rather than hidden in issues section (26.4-05)
- C4Context block with plain flowchart fallback in system-context.md because older Mermaid renderers don't support C4 syntax (26.4-05)
- 9 sequenceDiagrams in data-flows.md (plan required 8+) — geocode added as 9th with distinct two-tier lookup pattern (synchronous siteStore bbox check → async Nominatim) (26.4-05)
- Source pointers in architecture docs use relative repo paths so links work both in GitHub rendering and in local editors; no absolute github.com URLs (26.4-05)
- classDiagram mermaid syntax used only for MapEntity discriminated union (the single most important ontology concept); other type catalogs are prose + code blocks to reduce edit burden (26.4-05)
- stateDiagram-v2 preferred over flowchart for lifecycle state machines — semantically correct for finite-state behavior and renders the state transitions more clearly on GitHub (26.4-05)
- ADR-0005 written at 300 lines (5x minimum) as the honest Phase 26.2 NLP-scrap retrospective — names every file deleted, the 2-week time invested, includes a 4-lesson "What I Learned" section with rules for next time (patching downstream of bad signals compounds the problem, spike before commit, killing your darlings is a portfolio signal, cleanup phases are part of the product), and a forward-looking "what to do instead" section naming upstream NumSources + noisy-CAMEO filter as the leading redo candidate — explicitly identified as the highest-portfolio-signal artifact in Phase 26.4 (26.4-06)
- ADR-0001 Consequences section integrates the Plan 03 REDIS_OP_TIMEOUT_MS 2000ms Promise.race hardening as production resilience work rather than creating a separate ADR-0009 — keeps the decision record coherent ("we chose Upstash and here is how the choice has evolved") (26.4-06)
- Runbook failure modes grounded in specific code paths with line numbers (server/cache/redis.ts lines 19-42 for REDIS_OP_TIMEOUT_MS, server/middleware/rateLimit.ts lines 100-120 for rateLimiters.public, server/adapters/overpass.ts private.coffee mirror, server/routes/events.ts shouldBackfill/recordBackfillTimestamp helpers) rather than generic SRE advice — reviewable claims not hand-waving (26.4-06)
- degradation.md summary table includes a "Proof" column mapping each layer contract to a specific test file or code line — belt-and-suspenders documentation that is only believable if it points at proof; mirrors ADR-0001 Consequences structure for cross-document consistency (26.4-06)
- ADR template uses Positive/Negative/Neutral consequence split (not unstructured "Consequences") to force honest tradeoff consideration; ADR index README documents immutability rule (status line mutable, body frozen) and numbering convention (4-digit zero-padded) so future ADRs have clear conventions (26.4-06)
- README Plan 06 edits are additive and scoped: new Engineering Documentation subsection after Graceful Degradation with headline-linked paragraphs for architecture/adr/runbook/degradation, upgraded Architecture section prose to clickable per-file links, and ADR-0005 blockquote at the top of the Phase 26.2 retrospective — does NOT touch hero GIF area, Quick Start, or test metrics table from Plan 04 (26.4-06)
- ADR cross-referencing pattern established: ADRs link to each other (ADR-0003 ↔ ADR-0005), to runbook failure modes, to architecture data-flow diagrams, and to specific code files — the ADR directory is navigable from any entry point rather than a flat list (26.4-06)
- Agentic hero GIF capture via Playwright (scripts/capture-hero.ts, 527 lines, `npm run capture:hero`) chosen over manual Kap recording — ~45s repeatable regeneration survives UI changes, committed as permanent portfolio tooling rather than a one-off recording (26.4-04)
- Playwright recordVideo does not work for WebGL content in headless + software-GL mode (produces all-black frames because the compositor receives zeroed frames for WebGL canvases) — `page.screenshot()` frame-sequence stitched by gifski is the reliable fallback because screenshot reads the canvas backbuffer synchronously (26.4-04)
- Skip ffmpeg in the gifski pipeline — gifski accepts PNG frames directly on stdin and handles lanczos scaling via `--width`, avoiding rgb24→yuv4mpegpipe pixel-format errors and reducing the pipeline to 2 processes (Playwright → gifski) (26.4-04)
- MapDevExposer dev-only React component added to src/components/map/BaseMap.tsx, gated by `import.meta.env.DEV`, exposes the maplibre Map instance on `window.__map` for programmatic flyTo and layer toggling during capture — Vite tree-shakes entirely out of production builds, zero bundle impact (26.4-04)
- rateLimiters.public tier (6 req/min per-IP, prefix `ratelimit:public`) wired globally on `/api/*` BEFORE per-endpoint limiters in server/index.ts — protects the Upstash command budget from scraper abuse on the live demo URL while leaving per-endpoint budgets intact for legitimate high-volume users; paired with public/robots.txt disallowing /api/ and /health for polite crawlers (26.4-04)
- README live demo URL left as `_TBD_` placeholder (commit bd453cf replaced an earlier hardcoded URL) — user will substitute the actual Vercel URL at publication time rather than committing hardcoded production URLs mid-plan (26.4-04)
- REV-5 root cause: `DESTRUCTIVE_EVENT_TYPES` was `['airstrike', 'explosion']` but targeted precision strikes and ground combat near infrastructure were silently ignored for water facility attack detection; expanded to `ATTACK_EVENT_TYPES` combining destructive+combat sets (27.3-02)
- Dev-mode `console.debug('[useWaterLayers] attack detection:', ...)` added unthrottled per-render — acceptable because Vite strips it from production builds via `import.meta.env.DEV` (27.3-02)
- `filterStats` guarded with `!== undefined` in useWaterFetch — cached responses (Redis/dev-file-cache) don't carry the field, so the null fallback keeps the DevApiStatus Water Filters panel from rendering stale zeros (27.3-02)
- WaterFacilityDetail enrichment sections use the existing `<h3>` + DetailValue pattern (NOT a DetailSection component) — matches established convention in that file; DetailSection is not a component in this codebase (27.3-02)
- waterTreatment atlas slot at x=480 left intact (canvas draw code retained, harmless dead pixels) when removing treatment_plant from ICON_MAPPING — removing the shape would require renumbering downstream x-offsets (waterDesalination 512, triangle 544) for zero functional gain (27.3-02)
- Master `showSites` toggle wired into useEntityLayers visibleSites memo — previously the filter store had the field but the layer didn't consult it, so toggling the master sites control had no effect on the map (27.3-02, consistency fix bundled with Task 1)
- Proximity pin filter added to useWaterLayers — water facilities were the only entity type not honoring the pin (parity with flights/ships/events/sites via entityPassesFilters pattern) (27.3-02)
- WATER_ATTACK_EVENT_TYPES extracted to `src/lib/waterAttackEvents.ts` as single source of truth shared by useWaterLayers (map), WaterFacilityDetail (panel isDestroyed), useCounterData (counter score); the REV-5 expansion now reaches all three consumers so a facility near a `targeted` or `on_ground` event shows attacked/destroyed across map + detail + counter dropdown (27.3-03, WR-01)
- Water route test emptyStats fixture added: a well-formed WaterFilterStats stub (5 required sub-fields, all zero) replaces the `stats: {}` literal that violated waterFilterStatsSchema under NODE_ENV=test — chosen over `stats: undefined` so future tests have a reference payload; mock return type narrowed from `stats: unknown` to `stats: typeof emptyStats` (27.3-03, G-01/WR-02, IN-03)
- hasCapacityData(tags) exported from overpass-water.ts — returns true when any of height|volume|capacity|area tags has a non-empty trimmed value; used inside the D-06 compound admission gate and exported for Plan 06's computeAdmissionDecision consolidation (27.3.1-02, R-03)
- Admission gate restructured from three scattered branches (REV-2 reservoir + dam-only no-name + score floor) into a single three-stage unified gate: D-05 hasName mandatory → D-06 `isNotable OR isPriorityCountry OR hasCapacityData` → D-08 MIN_NOTABILITY_SCORE secondary floor; Round 3 Package A's bare-name-in-non-priority reservoir relaxation explicitly reverted (27.3.1-02, R-03)
- MIN_NOTABILITY_SCORE kept at 15 but demoted to secondary guard (D-08) — redundant in practice since D-06 clearance implies score≥15, but retained so regressions surface as low_score++ rather than silent admission (27.3.1-02, R-03)
- GENERIC_TYPE_RE fallback in src/lib/waterLabel.ts audited per D-10 and KEPT (not deleted): still reachable via the non-Latin-only OSM name path (hasName accepts any script, extractLabel's isLatin guard drops non-Latin names for display → bare-type fallback); inline comment now names the reach path and stamps the audit date, regression test proves the fallback chain handles the case (27.3.1-02, R-03)
- R-02 calibration tightened D-06 compound from 1-of-3 OR (`isNotable || inPriority || hasCapacityData`) to 2-of-3 signal-count (`signalCount = [...].filter(Boolean).length; if (signalCount < 2) reject`) with per-type exemption for desalination — closes the priority-country single-OR floodgate (Run 1 had Turkey 509 / Saudi Arabia 262 / Iran 234 admits via `isPriorityCountry` alone). Final post-calibration counts: dams=515, reservoirs=73, desalination=15. Branch 2b-(ii) over Branch 2b-(i) chosen because MIN_NOTABILITY_SCORE bump would lack per-type granularity and would slice desalination further. Outcome: single_tune. (27.3.1-04, R-02)
- Desalination exemption added to D-06 compound: `if (facilityType !== 'desalination') { 2-of-3 check }` — desal sparse OSM coverage (~63 raw) means name+type combination carries enough notability signal alone. Preserves D-05 hasName floor (regression test "still rejects unnamed desalination" proves it). Established the per-type exemption pattern as the prototype for Plan 06's planned `computeAdmissionDecision` consolidation. (27.3.1-04, R-02)
- MIN_NOTABILITY_SCORE confirmed redundant in production data — `low_score: 0` in both Run 1 and Run 2 of the calibration. Plan 06 cleanup (D-22) decision: drop the secondary floor or keep as defense-in-depth sentinel. Compound gate fully subsumes the score floor for non-desal types; desal exemption skips both gates (only D-05 hasName applies). (27.3.1-04, R-02 → R-06)
- Reservoirs at 73 admit count (below 300 floor) accepted per CONTEXT.md D-04 calibration philosophy ("err high not low — willing to go below 400 for those entities" + "Target is the ceiling, not the floor — UNDER-pulling is fine if every facility has a real name + notability signal"). All 73 clear D-05 hasName + 2-of-3 compound; quality > count. (27.3.1-04, R-02)
- R-04 committed snapshot shipped — `src/data/water-facilities.json` (337 KB, 602 facilities: 516 dams + 71 reservoirs + 15 desalination, sorted by id, coords rounded to 6dp, 2-space pretty-print). Generated by `npm run refresh:water` via `scripts/refresh-water-facilities.ts` running the full fetchWaterFacilities + labelUnnamedFacilities pipeline with atomic tempfile+rename write. Route tier is Redis → devFileCache (dev) → snapshot → Overpass (refresh gate only); snapshot loader forces `stats.source='snapshot'` defensively. (27.3.1-05, R-04)
- R-07 multi-user-resilience invariant documented inline in `server/routes/water.ts` and proven end-to-end via curl: cold Redis + snapshot present → `source: snapshot`, Overpass untouched; second hit → `source: redis` (snapshot populated Redis on first hit). `?refresh=true` still bypasses snapshot + devFileCache for cron/dev. Production NODE_ENV: Tier 4 Overpass is completely gated off for user requests — `npm run refresh:water` is the only developer-facing path. (27.3.1-05, R-07)
- `labelUnnamedFacilities` extracted from `server/routes/water.ts` into `server/lib/waterLabeling.ts` so refresh script + route share the identical pipeline. Preserves Phase 27.3 truth-19 ("never writes 'Unknown'") by sharing the exact function instead of re-implementing. (27.3.1-05, R-04)
- Plan 03's TODO flipped in water route: dev file cache branch now reports `source='snapshot'` (was `'redis'`). Dev file cache semantically shadows the snapshot tier — they're both cold-start floor, just ephemeral vs committed. (27.3.1-05, R-08 D-30 refinement)
- Redis-death chaos test updated to mock `loadWaterSnapshot → null`. Pre-Plan-05 the test passed because there was no snapshot tier; with a real 602-facility snapshot on disk, under Redis death `labelUnnamedFacilities` would trigger 134 consecutive 2000ms safe-timeout waits blowing past the 10s test timeout. Mocking preserves the test's original intent (prove no HTTP 500). (27.3.1-05)
- SitesFiltersSection mirrors WaterFiltersSection layout in DevApiStatus.tsx with intentional 4-bucket rejection asymmetry (excluded_turkey / no_coords / no_type / duplicate) — no synthetic water-style buckets (no_name, not_notable, low_score, no_city) per Plan 07 handoff guidance. Sites has genuinely narrower rejection surface because the adapter uses a single combined Overpass query across 5 types with no compound admission gate, no scoring, and no nearestCity requirement. No per-type byTypeRejections split for the same reason (per-type would require restructuring fetchSites). Module-scope `relativeTime` helper from Plan 03 reused without duplication — confirmed hoisted correctly at import time. (27.3.1-08, R-05 UI layer)
- Phase 27.3.1 Plan 08 chose a dedicated test file `src/__tests__/sitesFiltersSection.test.tsx` rather than extending the pre-existing failing `devApiStatus.test.tsx` — keeps sites section regression surface independent of the stale `parsed.sources.length === 8` assertion (current rows array has 9 entries including Precip; that failure is pre-existing baseline per deferred-items.md and not fixed by Plan 08). (27.3.1-08)
- Phase 27.3.2 Plan 04 inserted new admission branch "step 3b" in computeAdmissionDecision between step 3 (no_name) and step 4 (not_notable) — non-desal facilities failing hasLatinLabel(tags) now reject to no_resolved_name bucket; desalination unconditionally bypasses step 3b per D-03 exemption (sparse OSM coverage — 5 of 15 desal admits are non-Latin, dropping them would cost strategic infrastructure visibility); linkedRiver is NOT consulted at admission per D-02 river-rescue kill (linkedRiver enrichment survives post-admission in normalizeWaterElement for detail panel only); computeAdmissionDecision signature unchanged (no new linkedRiver param); all 151 existing adapter tests pass because prior fixtures used Latin names so Plan 06 test-extension becomes pure-addition with zero remediation. (27.3.2-04, D-01/D-02/D-03/D-05)
- hasLatinLabel(tags) exported from overpass-water.ts mirroring hasName/hasCapacityData shape: returns true when name:en/name/operator is non-empty trimmed AND passes the isLatin script guard (hoisted function declaration, reused verbatim from line 357, no new regex). Placed after hasCapacityData (line 192) to keep admission-decision helper exports clustered in first ~200 lines. (27.3.2-04, D-01)
- Phase 27.3.2 Plan 05 extended extractLabel in overpass-water.ts from 2-arg `(tags, facilityType)` to 5-arg `(tags, facilityType, lat, lng, nearestCity: ReturnType<typeof findNearestCity>)` with two desal-only synthesis branches inserted between the three existing Latin-check branches and the preserved bare FACILITY_TYPE_LABELS fallback: branch 4 returns `"Desalination Plant near ${nearestCity.name}"` when nearestCity resolves, branch 5 returns `"Desalination Plant at ${Math.abs(lat).toFixed(2)}°${N|S}, ${Math.abs(lng).toFixed(2)}°${E|W}"` when it doesn't — byte-identical to src/lib/waterLabel.ts lines 87-89 pre-Plan-07 so stale cached labels rehydrate character-identically. Non-desal facilities can't reach branches 4-5 (rejected at admission by Plan 04's step 3b), but branch 6 retained as defense-in-depth. (27.3.2-05, D-06/D-07)
- Phase 27.3.2 Plan 05 kept extractLabel module-private per plan directive — Plan 06 will decide export-for-unit-testing separately; current call graph is extractLabel ← normalizeWaterElement only, so private visibility costs nothing and Plan 06 has flexibility to either export for direct unit testing or mock through normalizeWaterElement. (27.3.2-05, D-07)
- Phase 27.3.2 Plan 05 typed the new nearestCity parameter as `ReturnType<typeof findNearestCity>` (per PATTERNS.md Pattern 3 prescription) rather than duplicating the inline `{ name, distanceKm, population } | null` shape. Keeps the type tethered to findNearestCity so any future field addition to the return shape propagates automatically to extractLabel. (27.3.2-05, D-07)
- Phase 27.4.2 Plan 06 baseline locked: resolver eval = 38/38/41/50 (within 5/20/100km), +5pp absolute target = 0.810 (≥41/50 within 20km), production fallback% = 9.7% (23/237) ALREADY << 25% target. Wave 2 stop condition (D-13) only requires eval-at-20km uplift of 3 events; fallback% gate is no longer binding. Reused existing v2 production run summary (events:llm-summary:v2 from 2026-04-25T02:00:49Z) instead of duplicating ~300K Cerebras token spend per Pitfall 4. watchdogTimeoutCount=0 satisfied inferentially via empty events:llm-dlq Redis key. (27.4.2-06)
- Phase 27.4.2 Plan 06 inner-loop ergonomic: `npm run eval:replay` runs `runEval()` resolver-only via `scripts/eval-replay.ts` and prints per-distance JSON + the D-25 deploy-gate ratio. Cost ~50s on cold Nominatim cache, instant on warm. Zero LLM token spend per A6 / Pitfall 8. Used between every Wave 2 sub-lever change per D-12 micro-iteration cadence. Mirrors `scripts/refresh-water-facilities.ts` shape with `node --env-file-if-exists=.env --import tsx/esm` runner pattern. (27.4.2-06)
- Phase 27.4.2 Plan 06 D-07 hang-recurrence response: `setProviderOrderOverride([groq, cerebras])` is the canonical incantation when `watchdogTimeoutCount ≥ 3` is observed in a run. Module-level `_providerOrderOverride` in `server/adapters/llm-provider.ts` mirrors `setPipelineOverride` from `server/config.ts:230-242`, no Redis persistence (wave-scoped, ops-managed). Cold-start naturally clears it. Phase close runbook restores `setProviderOrderOverride(null)` per T-27.4.2-03 mitigation. (27.4.2-06)
- Phase 27.4.2 Plan 06 closed RESEARCH §6 Pitfall 3: `watchdogTimeoutCount` field added to `LLMRunSummary` interface + `buildSummary()` body in `server/lib/llmProgress.ts` + frontend mirror in `src/hooks/useLLMStatusPolling.ts` per A9 sync rule. Pre-Plan-06 the field was set on the live singleton but lost across the idle transition because `buildSummary()` did not thread it. Now operator-checkable post-run via `/api/events/llm-status` and DevApiStatus dashboard. (27.4.2-06)
- Phase 32 Plan 01: dual schema-test placement (canonical at `server/__tests__/lib/urlLiveness.schema.test.ts` + literal-path shim at `src/__tests__/lib/urlLiveness.schema.test.ts` per RESEARCH A5) — shim uses direct-import not vitest test-file re-import so it survives canonical file moves. Both files run under `npx vitest run`; future schema drift fails BOTH locations. (32-01-03)
- Phase 32 Plan 01: `attemptCount` JSDoc pins monotonic-with-reset-on-live-or-unknown semantics (Claude's Discretion §4). Pure-monotonic accumulation would conflate dead→live→dead with three-in-a-row-dead and falsely trigger D-12's cron auto-prune `attemptCount >= 3` gate. The monotonic-with-reset rule makes the "≥3 consecutive terminal-dead ticks" semantics a one-line check inside the Plan 32-02 probe writer. (32-01-02)
- Phase 32 Plan 01: `server/lib/pruneQuota.ts` cloned verbatim from `server/lib/replayQuota.ts` (single namespace swap to `operator:prune-quota:`) rather than refactored into a generic `createDailyQuotaCounter()` factory — CONTEXT D-15 explicit "consistency-with-existing-pattern wins" + intentional future-divergence room if destructive-action cap ever needs to tighten. Test asserts `! grep "operator:replay-quota:"` to guard against accidental copy-paste regression. (32-01-04)
- Phase 32 Plan 01: `OperatorAuditEntry.operation` union widening (`'pipeline-swap' | 'replay' | 'prune-dead-urls'`) landed as standalone `chore(32)` commit (Task 5) ahead of any consumer — PATTERNS.md Primary-risk mitigation; Plan 32-03's first consumer commit (prune endpoint + helper) reviewable in isolation without the union-widening noise mixed in. (32-01-05)
- Phase 32 Plan 01: MEDIUM-02 plan-checker fix applied: `pruneQuota.test.ts` asserts `expect(process.env.NODE_ENV).toBe('test')` at file-import time so any future test-runner config drift (vitest no longer forcing NODE_ENV=test) fails this file loudly rather than silently compromising assertions elsewhere that gate on test-mode behavior. (32-01-04)
- Phase 32 Plan 01: `log = logger.child({ module: 'urlLiveness' })` binding pre-wired in `server/lib/urlLiveness.ts` at Task 2 even though unused at that surface — avoids a follow-up import edit in Plan 32-02 (probe/sweep consumers). Referenced via `void log` to keep eslint's `no-unused-vars` quiet at zero runtime cost. (32-01-02)
- Phase 32 Plan 02: waitForHostSlot reserves the next slot SYNCHRONOUSLY before awaiting (atomicity fix caught during Task 4 testing). Without it, N concurrent same-host dispatchers all read the same `prior` value and race to update, coalescing to 1 throttle gap instead of N-1. Math.max(now, target) floors against negative-jitter underflow. The plan's pseudocode (set AFTER await) was wrong; this is the corrected canonical pattern for any shared-state throttle map under concurrent dispatch. (32-02-02 → 32-02-04)
- Phase 32 Plan 02: Two-checkpoint deadline guard inside runProbeSweep — `if (Date.now() > deadlineMs) skippedBudget++; return;` runs at TASK ENTRY AND AGAIN after `waitForHostSlot` returns. A saturated same-host batch can otherwise consume seconds of throttle wait time AFTER the entry-gate check nominally cleared, overrunning Vercel maxDuration. Single-checkpoint designs leak budget after the per-task entry gate. (32-02-04)
- Phase 32 Plan 02: SSRF guard re-checks every redirect target inside the `for (let hop = 0; ...)` loop — a public-host primary URL can still pivot to a private host via a hostile `Location` header. Cheap to add (one regex match per hop), expensive to debug if missing. Initial-URL-only checks leak the redirect attack surface. (32-02-01)
- Phase 32 Plan 02: Probe entry writes route exclusively through `cacheSetSafe` (Pitfall 6 chaos-test contract). Sidecar count INCR/DECR can't use cacheSetSafe (wraps CacheEntry<T> shape, not integer counters) so raw redis.incr/decr are wrapped in try/catch and degrade-open. The ONLY raw `redis.set` call in urlLiveness.ts is the underflow floor on `URL_LIVENESS_COUNT_KEY` — documented as the sole permitted bypass of the chaos contract. (32-02-03)
- Phase 32 Plan 02: Sidecar INCR/DECR fires ONLY on prior→next dead-set transition (Pitfall 3 throughput rule). dead→dead transitions monotonically increment attemptCount but do NOT touch the count key (already counted at the first dead transition). Live→live, unknown→unknown, dead→dead, live→unknown, unknown→live: zero sidecar touches. Cuts Redis command volume on the steady-state sweep path. (32-02-03)
- Phase 32 Plan 02: `isTerminalDead(status)` exported as a named helper so sweep (sidecar maintenance) + prune (Plan 32-03's pruneDeadUrlEvents) share one truth source on what "dead" means. Same pattern as `ttlSecForStatus` from Plan 32-01 — extract the predicate, don't duplicate it across consumers. (32-02-03)
- Phase 32 Plan 02: `SWEEP_SAFETY_MARGIN_MS = 60_000` exported as a named constant (not a magic number scattered across Plan 32-03's call site). Plan 32-03's cron handler will compute `const deadline = cronStart + 800_000 - SWEEP_SAFETY_MARGIN_MS` so the safety margin is visible in one place and the executor can't accidentally pass a different value. Pitfall 1 mitigation. (32-02-01)
- Phase 32 Plan 02: `buildProbeCandidates` uses a minimal local interface (`ConflictEventEntityForProbe` with just `id` + `data.source?`) rather than importing the full ConflictEventEntity discriminated union — avoids pulling MapEntity + server types into the import graph. Runtime `typeof url === 'string'` guard defends against shape drift. (32-02-05)
- Phase 32 Plan 02: Combined Task 1 commit (probeUrl + SSRF guard in one feat commit) per the plan's "if the diff-split is awkward, ship them as one commit ... is acceptable fallback" clause. The diff was awkward because the SSRF guard requires BOTH the entry-point check AND the redirect-target re-check inside the loop; splitting them would leak the main probeUrl into a state where redirects bypass the guard. (32-02-01)
- Phase 32 Plan 03: Cron auto-prune uses DIRECT helper invocation (not self-HTTP) per RESEARCH A4 / Discretion §3 — same Vercel function instance has all exports loaded; bearerFingerprint:'cron:refresh-events' literal makes audit-log attribution unambiguous. HTTP route at POST /api/events/prune-dead-urls preserved for operator clicks (Plan 32-05) AND operator-simulated cron triggers ({trigger:'cron'} body bypasses quota). (32-03-03)
- Phase 32 Plan 03: Probe sweep + auto-prune post-step placed in safeWaitUntil IIFE's `finally` block (not success-only). Dead-URL cleanup is orthogonal to whether LLM extraction itself dispatched fresh enrichments this tick — if extraction failed, we still want to probe/prune dead URLs from prior runs. Probe/prune wrapped in its own try/catch so failures don't surface as extraction errors. (32-03-03)
- Phase 32 Plan 03: Widen POST /api/events/prune-dead-urls route try/catch to wrap the quota check (Rule 2 inline fix caught by chaos test). Original implementation had `checkPruneQuota(fingerprint)` BEFORE the try block; under Redis death the raw redis.incr surfaced as 500. Widening to include both quota check AND helper call surfaces any redis throw as 503 prune_failed. Pitfall 6 chaos contract preserved. (32-03-04)
- Phase 32 Plan 03: Exported `LLM_EVENTS_KEY_ACTIVE` + `LLM_REDIS_TTL_SEC` from `server/lib/llmExtractionPipeline.ts` (was module-private). Hand-rolling `'events:llm:v3'` or `9000` inside urlLiveness.ts would be the exact drift class CLAUDE.md §"Serverless Cache" warns against. One truth source — cron writer and prune writer always agree on key + TTL. (32-03-01)
- Phase 32 Plan 03: MEDIUM-01 plan-checker pin applied inline at the SCAN call site: `(await redis.scan(cursor, {match, count: 200})) as [string | number, string[]]` matches `@upstash/redis ^1.37.0` — silent shape drift now fails TypeScript instead of producing infinite SCAN loops in production. Mirrors Plan 04's buildDeadUrlSample SCAN-signature pin. (32-03-01)
- Phase 32 Plan 03: Test-side `flushSafeWaitUntil()` pattern for integration tests against fire-and-forget IIFE bodies — mocks safeWaitUntil to capture the IIFE promise into a shared `pendingPromises` array, then drains pending work before assertions. Production safeWaitUntil semantics unchanged (D-12 hard block preserves void return). Documented in `refresh-events-cron.prune.test.ts` JSDoc for reuse in future cron post-step tests. (32-03-03)
- Phase 32 Plan 04: `/api/operator-status` aggregator surfaces `prune` sibling block — sidecar O(1) read for `deadUrlCount` (Pitfall 3 mitigation; `redis.get(URL_LIVENESS_COUNT_KEY)` replaces N×GET over the liveness keyspace), in-memory derivation for `last24hPrunes` (zero extra Redis round-trips — reuses the same `last24h` array the existing aggregator already iterates), bounded SCAN drill-down for `deadUrlSample` (LIMIT_DRILL_DOWN=20 payload cap + MAX_SCAN_KEYS=200 wall-clock-budget cap). Per-block degrade-open envelopes around the sidecar read AND the SCAN helper mirror the existing advEval pattern — partial degrade always preserved over no surface (Pitfall 6 chaos contract for read-only routes). (32-04-01)
- Phase 32 Plan 04: Local `AuditEntry.operation` union widened to admit `'prune-dead-urls'` matching the canonical `OperatorAuditEntry.operation` widened in Plan 32-01 Task 5. Without this widening, SADD entries with the new tag would parse fine at the canonical layer but drop silently from the aggregator pass. Two-tier widening (canonical + local-narrow at each consumer) is the established lower-coupling pattern: aggregator only reads `timestamp`/`bearerFingerprint`/`operation`, not the full canonical type. (32-04-01)
- Phase 32 Plan 04: `byBearer[].prunes` counter added to the per-fingerprint aggregator map value (alongside existing `actions`/`swaps`/`replays`). Increments per `prune-dead-urls` audit entry, attributed to BOTH operator fingerprints AND to the literal `'cron:refresh-events'` pseudo-fingerprint (RESEARCH A8) so manual + cron prunes stay distinguishable in the Operator Actions block. (32-04-01)
- Phase 32 Plan 04: `buildDeadUrlSample()` extracted as a module-private helper (not exported) — keeps the route's GET handler readable + isolates the degrade-open try/catch. Cursor short-circuits via uniform `cursor = 0` assignment across all three termination paths (LIMIT exhaustion, MAX_SCAN_KEYS exhaustion, natural cursor return). MEDIUM-01 plan-checker SCAN-signature pin applied for the second time in the phase: `(await redis.scan(cursor, {...})) as [string | number, string[]]` matches `@upstash/redis ^1.37.0`. (32-04-01)
- Phase 32 Plan 04: LOW-03 plan-checker drill-down resolution fully delivered server-side — `prune.deadUrlSample` returns `Array<{eventId, url, status}>` so Plan 32-05's UI work consumes the drill-down list directly without an additional API call. Each entry has bare `eventId` (no key prefix), `url` from `lastUrlProbed`, and `status` narrowed to the terminal-dead union via `isTerminalDead` predicate (one truth source across sweep + prune + dashboard). (32-04-01)
- Phase 32 Plan 04: TDD discipline — landed RED commit (`af11707`) before GREEN commit (`5435196`). Plan's verbal "feat then test" ordering accepted as fallback; test-first matches the `<task tdd="true">` declaration in the PLAN.md frontmatter. Mock-shape mismatch for `cacheGetSafe` caught during local RED authoring (route's `cached?.data` dereference expects `{data, stale, lastFresh}` envelope, not bare `UrlLiveness` payload) — aligned to runtime contract from `server/cache/redis.ts:211` before committing. (32-04-01)
- Phase 32 Plan 05: `OperatorStatus.prune` field added as OPTIONAL (`prune?: {...} | null`) and `byBearer[].prunes?` widened to optional. Older Plan-32-04-pre-deploy servers omitting `prune` still type-check and the conditional render path `opStatus?.prune != null && ...` hides the new UI cleanly — frontend can deploy ahead of backend without breakage. Single-direction (server-then-client) deploy ordering is the conservative path; this widens it to either-direction. (32-05-01)
- Phase 32 Plan 05: `fetchOpStatus` hoisted out of the operator-status `useEffect` closure into a named `useCallback` (PLAN-CHECK MEDIUM-03 resolution). The polling `useEffect` now consumes the callback as a dep AND `pruneHandler` calls it directly in the `res.ok` branch after a successful prune POST — drops `prune.deadUrlCount` in-place without waiting for the next 30s poll tick. Stable reference (empty-dep useCallback) ensures the effect doesn't re-fire on parent re-renders. (32-05-01)
- Phase 32 Plan 05: Single feat commit covers both GHOST-03 (count display) AND GHOST-04 (Prune button) rather than two separate commits — plan offered the choice; collapsed form chosen because diff is small (~70 LOC), the two surfaces share the same `opStatus?.prune != null` conditional, and splitting them would produce a count-but-no-button intermediate state with no useful behavior to test independently. (32-05-01)
- Phase 32 Plan 05 (Rule 3 deviation): jsdom localStorage stub workaround for Node 22 — `window.localStorage.setItem` is `undefined` because Node 22's built-in localStorage (which requires `--localstorage-file` for persistence) shadows jsdom's Storage shim. Installed an in-memory Map-backed `Storage` stub via `vi.stubGlobal('localStorage', ls)` + `Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })` in `beforeEach` so `dashboardAuthHeaders()` reads the seeded Bearer key. Pattern reusable for any future jsdom test that touches dashboardAuth. (32-05-02)
- Phase 32 Plan 05: Drill-down list rendered as `<ul max-h-40 overflow-y-auto>` with `flex items-baseline gap-2` per-row (not a `<table>`). Matches the existing `operator-actions-bearer-row` style at L1496-1504 — lighter than table semantics for a transient bounded list. Truncation row uses Unicode ellipsis `…` (U+2026) matching the bearerFingerprint slice convention at L1501. Tailwind classes for the Prune button copied byte-for-byte from `replay-test-trigger` so no new utility class is invented (verified: `grep -c "rounded-md border border-white/10 px-2 py-1 text-xs hover:bg-white/5" DevApiStatus.tsx` returns 2). (32-05-01)
- Phase 32 Plan 05: Test 6 (post-200 fetchOpStatus refresh) asserts `mockFetch.calls.filter(url === '/api/operator-status').length AFTER > BEFORE` instead of exact-total assertion. The `useEffect` poller can fire on mount + setInterval + post-click in any timing order; before/after delta is robust to runner timing without coupling to a specific count. (32-05-02)
- Phase 32 close: URL liveness probe runs inside cron-only writer (anti-pattern #17 preserved); piggybacks `/api/cron/refresh-events` rather than adding a 4th cron entry (D-01). No new Vercel cron surface; probe sweep runs as a `finally`-block post-step inside `safeWaitUntil` IIFE after `runRefreshExtraction` resolves so dead-URL cleanup runs even when extraction itself errors.
- Phase 32 close: Per-event Redis key `events:url-liveness:{eventId}` (probe results, tiered TTL via `ttlSecForStatus`) + sidecar count `events:url-liveness-count` (O(1) dashboard polls, Pitfall 3 mitigation). Sidecar maintained jointly by Plan 32-02 `persistLiveness` (INCR on live→dead) and Plan 32-03 `pruneDeadUrlEvents` (DECRBY on prune). Underflow floors at 0 via the lone permitted raw `redis.set(KEY, 0)` call documented in CLAUDE.md.
- Phase 32 close: Cron auto-prune gated on `attemptCount >= 3` consecutive ticks (D-12); manual prune has no gate (operator owns the call). Primary URL is `data.source` (NOT `data.sourceUrls[0]`) for both raw GDELT and LLM v3 entities (D-05 / RESEARCH A1 — `enrichedV3ToEntities` spreads `template.data` and never writes a `sourceUrls[]` field; v3 inherits `data.source` identically to raw GDELT).
- Phase 32 close: `attemptCount` semantics = monotonic-with-reset-on-live-or-unknown (RESEARCH A2 / D-12). Pure-monotonic accumulation would conflate dead→live→dead with three-in-a-row-dead and falsely trigger the cron auto-prune gate. The monotonic-with-reset rule makes "≥3 consecutive terminal-dead ticks" a one-line check inside `persistLiveness`.
- Phase 38 Plan 03 (GDELT-MATCH-01): `scripts/audit-gdelt-corpus.ts` is a READ-ONLY corpus audit (D-07 non-destructive) — pure functions (bucketByTier/detectOrphans/detectDuplicateClusters/buildAuditReport) exported for unit testing with a `import.meta.url` direct-run guard so vitest imports never trigger Redis I/O. Orphan detection uses a conservative 3-gate match (temporal ±2d AND geo ≤50km AND ≥1 shared keyword token); duplicate-cluster sizing reuses `groupGdeltRows` and is explicitly labeled coarse batch-grouping NOT true dedup (Pitfall 6 — plan 02 adds the tighter pre-pass). (38-03)
- Phase 38 Plan 03 audit baseline: live `events:llm:v3` + `news:gdelt` were ABSENT in dev Redis at audit time, so the committed baseline (`gdelt-corpus-audit.json`) was sized from the dev raw `events:gdelt` corpus (688 events): 99.7% unknown source tier (expected for raw pre-LLM data), 134 duplicate-source clusters / 364 events (53% collapse) with a size-2-dominant histogram (81 of 134). Orphan rate is an unusable artifact (100% — `news:gdelt` empty). Plan 06 must RE-RUN `npm run audit:gdelt` against a warm `events:llm:v3` + `news:gdelt` for real tier/orphan distributions; the duplicate-cluster histogram is actionable now (start MATCH-02 Jaccard at 0.85 / geo gate at 5km, target the size-2 cohort, preserve the size 6–9 tail). (38-03)

## Pending Todos

None.

## Deferred Items

Items acknowledged and deferred at **v1.6 milestone close on 2026-06-09** (20 total — all v1.0–v1.5-era stale artifacts; none are v1.6 work):

| Category | Count | Notes |
|----------|-------|-------|
| Debug sessions (historical) | 10 | `27-uat-round2-issues`, `date-range-filter-broken`, `env-file-not-found`, `event-feed-zero-events`, `llmstatus-unknown-prod`, `phase27-events-invisible`, `reservoirs-missing-after-05`, `river-color-visibility`, `server-eager-config-crash`, `water-facility-icons-missing` — all 2026-03-14 → 2026-05-07; `diagnosed`/`root_cause_found`/`resolved-pending-user-verification`; root causes captured in merged phases |
| Quick tasks (legacy) | 8 | Pre-`/gsd-add-todo` slugs (CLN-01..13 requirement entries; 5-wiring-gaps; events-counter update; 4× threat-density cluster scaling; 2× Open-Meteo precip surfacing) — 2026-04 era; superseded by phase work that landed |
| Pending todos | 2 | `phase-27.4.2-ci-health` (CI red→green — main is green) / `phase-27.4.3-deckgl-v9-type-drift` — both phases shipped per prior STATE note |

These were carried from the v1.5 close and re-acknowledged at v1.6 close; revisit at v1.7 milestone-start if any remain relevant.

---

Items acknowledged and deferred at v1.5 milestone close on 2026-06-03:

| Category | Count | Notes |
|----------|-------|-------|
| Debug sessions (historical) | 10 | All dated 2026-03-14 through 2026-05-07 (v0.9–v1.4 era); `diagnosed` / `root_cause_found` / `resolved-pending-user-verification`; root causes captured in commits or merged phases |
| Quick tasks (legacy) | 11 | Pre-`/gsd-add-todo` slugs from 2026-03 → 2026-04 (v1.1–v1.3 era; UI/threat-density/water polish) — superseded by phase work that landed |
| Pending todos | 3 | `phase-27.4.2-ci-health` / `phase-27.4.3-deckgl-v9-type-drift` / `phase-27.4.5-llm-pipeline-observability` — all phases shipped except 27.4.5 which is operator-rejected at v1.5 start (BACKLOG-05 in archived REQUIREMENTS); existing 8-block DevApiStatus events tab covers diagnostic needs |
| Verification gap | 1 | Phase 32 `human_needed` — deployment-only UAT items (natural cron tick + live Upstash audit-log SADD + real browser prune click) all satisfied by Phase 37 acceptance-gate observation evidence; rolling forward as historical breadcrumb |
| Context-seed open questions | 1 | Phase 30.1 `CONTEXT-SEED.md` open questions — superseded by locked `30.1-CONTEXT.md` (probe-driven NIM-only outcome answered Q1 + Q2 mechanically) |

**v1.5 phase-specific deferrals** (already documented in `milestones/v1.5-ROADMAP.md` and `milestones/v1.5-REQUIREMENTS.md`):

| Phase | Item | Status |
|-------|------|--------|
| 31 | LLM-RELI-06 (7-day cron stability watch) | Validated single-day; Days 2-7 not pursued; reopening flagged for v1.6 |
| 34 | LLM-RELI-08..11 (Cerebras + Groq router fallback) | Closed `cerebras-groq-deferred`; planning artifacts preserved as ready-to-execute audit trail |

**v1.4 carry-forwards still acknowledged** (rolled forward from prior v1.4 close):

| Category | Count | Notes |
|----------|-------|-------|
| UAT gaps (resolved) | 4 | 27.3.1, 27.3.2, 27.4, 27.4.2 — human-checked at the time of phase close |
| UAT gaps (partial, post-deploy) | 2 | 28.2.6 (2 pending), 28.2.7 (4 pending) — operator-driven verification items |
| Verification gaps (`human_needed`) | 6 | 27.3.1, 27.4, 27.4.2, 28.2, 28.2.6, 28.2.7 — code-level verification PASSED in each |

Per Phase 28.2.7 close convention: `human_needed` is not a defect — it's the verifier's signal that some acceptance criteria require operator action against deployed prod. Phase 37 acceptance-gate observation evidence (3 consecutive `prod-connectivity-audit.yml` greens against live prod) satisfies the operator-action sentinel across the v1.4 + v1.5 verification surface.

## Blockers/Concerns

- Ethnic distribution GeoJSON data needs manual curation from published maps
- WRI Aqueduct 4.0 format verified: ZIP contains CSV + GeoPackage; CSV has 231 columns, no lat/lng centroids
- Redis command budget at ~92% — monitor with Bellingcat RSS adding another polling source

### Quick Tasks Completed

| #          | Description                                                                                                      | Date       | Commit  | Directory                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ---------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| 1          | add CLN-01..CLN-13 requirement entries to REQUIREMENTS.md                                                        | 2026-04-07 | e487029 | [1-add-cln-01-cln-13-requirement-entries-to](./quick/1-add-cln-01-cln-13-requirement-entries-to/)                   |
| 260409-jf3 | update events counters to reflect our new ontology                                                               | 2026-04-09 | 4c6c1cb | [260409-jf3-update-events-counters-to-reflect-our-ne](./quick/260409-jf3-update-events-counters-to-reflect-our-ne/) |
| 260411-m00 | Fix threat density cluster sizes to scale with event count while remaining zoom-independent                      | 2026-04-11 | c68d12a | [260411-m00-fix-threat-density-cluster-sizes-to-scal](./quick/260411-m00-fix-threat-density-cluster-sizes-to-scal/) |
| 260411-m4j | Threat density clusters use meter-based radius from bbox diagonal so they never shrink below their event spread  | 2026-04-11 | 475f900 | [260411-m4j-threat-density-clusters-use-meter-based-](./quick/260411-m4j-threat-density-clusters-use-meter-based-/) |
| 260411-ma5 | Remove radiusMaxPixels cap so threat density clusters never shrink below event spread                            | 2026-04-11 | 86b648f | [260411-ma5-remove-radiusmaxpixels-cap-so-threat-den](./quick/260411-ma5-remove-radiusmaxpixels-cap-so-threat-den/) |
| 260411-mh0 | Add Open-Meteo precipitation to API observability dashboard                                                      | 2026-04-11 | 7d73360 | [260411-mh0-add-open-meteo-precipitation-to-api-obse](./quick/260411-mh0-add-open-meteo-precipitation-to-api-obse/) |
| 260411-mn4 | Show precipitation in weather tooltip always, using raw precip data instead of facility lookup                   | 2026-04-11 | 490561f | [260411-mn4-show-precipitation-in-weather-tooltip-al](./quick/260411-mn4-show-precipitation-in-weather-tooltip-al/) |
| 260415-uzj | In our status line, keep the version number but remove the version title                                         | 2026-04-16 | 2c75caf | [260415-uzj-in-our-status-line-keep-the-version-numb](./quick/260415-uzj-in-our-status-line-keep-the-version-numb/) |
| 260417-dtt | Reorder water filter toggles (healthy above attacked) and make the attacked toggle dot black                     | 2026-04-17 | f9f169b | [260417-dtt-for-the-water-filters-let-s-move-the-att](./quick/260417-dtt-for-the-water-filters-let-s-move-the-att/) |
| 260417-fap | Make attacked (0-stress) water facilities deep dark purple on the map, in the legend, and on the Attacked toggle | 2026-04-17 | d3f5e4b | [260417-fap-make-attacked-0-stress-water-sites-deep-](./quick/260417-fap-make-attacked-0-stress-water-sites-deep-/) |

## Accumulated Context

### Roadmap Evolution

- Phase 22.1 inserted after Phase 22: fixing dispersion (URGENT)
- Phase 23.1 inserted after Phase 23: detail panel navigation stack (deferred from Phase 23 discussion)
- Phase 26.1 inserted after Phase 26: Water layer refinements (URGENT)
- Phase 26.2 inserted after Phase 26: Conflict geolocation improvement (URGENT)
- Phase 26.2 SCRAPPED and deferred — NLP approach was wrong, patching bad geocoding with more code didn't work
- Phase 26.3 inserted after Phase 26: Production Code Cleanup — portfolio-grade internal quality (URGENT)
- Phase 26.4 inserted after Phase 26.3: Documentation & External Presentation — portfolio-grade external polish
- Phase 26.2 now depends on 26.4 — GDELT redo on clean foundation
- Milestone v1.4 created (2026-04-08): Phase 26.2 renumbered to Phase 27 (Conflict Geolocation Improvement / GDELT Redo) and original Phase 27 renumbered to Phase 28 (Performance & Load Testing). Both moved out of v1.3 so v1.3 can close with its delivered phases (26.3 code cleanup and 26.4 documentation shipped as planned). Scrapped 26.2 artifacts archived to .planning/phases/archive-26.2-nlp-scrapped/. Historical references (ADR-0005, SUMMARY.md files, TODO(26.2) code markers) preserve the old number intentionally.
- Phase 27.1 inserted after Phase 27: Dev Observability and LLM Pipeline Status (URGENT) — server-side LLM progress tracking, /api/events/llm-status endpoint, granular DevApiStatus panel with completion %, ETA, historical success rates
- Phase 27.2 inserted after Phase 27.1: Event Quality and Water Data Improvements (URGENT) — high-tier news sources, richer LLM enrichment, precision ring UX, zoom icon fix, date slider styling, more dams/treatment plants, water filter parity, icon sizing
- Phase 27.3.1 inserted after Phase 27.3: Water Facility Retry and Cleanup (URGENT) — Package A verification blocked by Overpass outage 2026-04-18 15:15 PT; calibrate to ~100–500 dams / ~100–500 reservoirs, persist committed JSON snapshot to decouple cold-starts from Overpass, same treatment for sites, clean up overpass-water.ts ghost code from 5 plans + 2 debug rounds, prepare for multi-user concurrency
- Phase 27.4.2 inserted after Phase 27.4.1 (2026-04-24): CI Health + LLM v2 Quality Tuning — bundled phase greens main CI (32 filter-test failures, 4 npm-audit vulns, prettier format drift, lint warnings) so regression-watch is trustworthy during Track B — then runs one clean 184-batch v2 extraction to capture eval baseline and iterates prompts/resolver until eval ≥v1+5pp AND gdelt-actiongeo-fallback provenance <25%. Scope levers + hang-recurrence policy open for /gsd-discuss-phase. Out-of-scope: 27.4.3 (deck.gl v9 TS drift), 27.4.5 (LLM flight-recorder), 27.3.3 (romanization).
- Phase 27.4.3 inserted after Phase 27.4.2 (2026-04-25): free-claude-code Routing Evaluation (URGENT) — pivoted from the originally-deferred "Cerebras hang root-cause investigation" to evaluate https://github.com/Alishahryar1/free-claude-code as a replacement for the manual Cerebras/Groq routing in `server/adapters/llm-provider.ts`. Five evaluation criteria (feasibility, reliability, cost/quota, integration shape, eval quality parity ±5pp of Plan 07's 0.940 baseline). Phase 27.4.2 HUMAN-UAT.md tests 1+2 are blocked on this phase landing. Reassigned 27.4.3 number from the prior deck.gl v9 depthTest TS-drift placeholder to this evaluation; deck.gl v9 work renumbers to 27.4.4.
- Phase 28.2.6 inserted after Phase 28.2.5 (2026-05-07): Fix Vercel cron architecture so events:llm:v3 populates within budget (URGENT) — surfaced during 28.2.5 Plan 05 closeout when force-trigger of /api/cron/refresh-events?force=true returned `dispatched: true` in 400ms but the fire-and-forget IIFE body never executed (Vercel Fluid Compute kills the function once response is sent). Three resolution paths captured in 28.2.5-deferred-items.md for /gsd-discuss-phase 28.2.6 to pick from: (a) incremental terminal-key write refactor (~30 LOC), (b) Vercel Pro plan upgrade ($20/mo for 800s maxDuration), (c) waitUntil migration via @vercel/functions. Phase 28.3 entry now gated on 28.2.6 because the tier-green workflow run that 28.2.5 D-09 set up will keep returning allTiersGreen=false until critical[llmEvents] can flip from `unknown` to `healthy`.
- Phase 30.1 inserted after Phase 30 (2026-05-17): Cascade fallback fix — re-enable OpenRouter or document single-provider reality (URGENT) — surfaced immediately post-Phase-30 by operator review noticing OpenRouter never fired in Run 1 / Run 2 / 04:00 UTC daily cron. Phase 27.4.4's `skipOpenRouter: true` flag is still hardcoded in `server/lib/llmEventExtractor.v3.ts:622, 929`, removing OpenRouter from the cascade entirely. 04:00 UTC cron evidence: NIM 39 rate-limit errors → breaker tripped → 50+ batches `skipped:breaker` → 0 OpenRouter attempts. Phase 30's tuning therefore tunes a single-provider pipeline, not a cascade. Seed context at .planning/phases/30.1-cascade-fallback-fix-.../30.1-CONTEXT-SEED.md. Three scope options (minimum/right/full) for /gsd-discuss-phase 30.1 to pick from.

**Planned Phase:** 31 (cron-stability-validation-7-day-watch) — 5 plans — 2026-05-18T01:41:58.483Z

- Phase 31 closed early under operator decision 2026-05-19 at Day 1 / 7 (Day-1 natural cron PASS captured, commit `d0c16e4`). LLM-RELI-06 declared "validated single-day, monitoring continues opportunistically" — caveat-marked. Snapshot harness retained for ad-hoc capture; D-05 escalation to Phase 31.1 deferred (no FAIL row observed). Phase 37 acceptance gate (LLM-RELI-07, 3 consecutive `prod-connectivity-audit.yml` exit-0) unaffected and remains the mechanical reliability check at milestone close. See [`.planning/phases/31-cron-stability-validation-7-day-watch/31-SUMMARY.md`](phases/31-cron-stability-validation-7-day-watch/31-SUMMARY.md) for the full close-out rationale and resume path.

- Phase 34 (LLM Router Fallback Re-integration) inserted between Phase 33 and the existing Phase 34 (now Phase 35) on 2026-05-19 per operator decision. Goal: restore Cerebras + Groq as cascade fallbacks for NIM (probe-driven; mirrors Phase 30.1's `nim-only` precedent if free tiers fail the gate) plus per-provider eval scoring. Phase 31's Day-1 DLQ baseline (4 × `v3:timeout_watchdog`) is the empirical motivation. Existing Phases 34/35/36 renumbered → 35/36/37. New requirements LLM-RELI-08..11 added. Sequencing: Phase 34 sits on the LLM-RELI spine (29 → 30 → 31 → 34 → 37) and depends on Phase 33 closing first so cascade integration tests against the post-33 `actorConfidence` schema.

## Performance Metrics

| Phase | Plan | Duration | Notes |
|-------|------|----------|-------|
| Phase 38 P01 | 7min | 3 tasks | 15 files |
| Phase 39 P01 | 5 min | 4 tasks | 7 files |
| Phase 39 P02 | 21 min | 2 tasks | 5 files |
| Phase 39 P04 | 8 min | 2 tasks | 2 files |
| Phase 39 P05 | 5 min | 2 tasks | 4 files |
| Phase 40 P01 | 6 min | 2 tasks | 5 files |
| Phase 40 P02 | 18min | 3 tasks | 8 files |
| Phase 40 P40-04 | 12min | 3 tasks | 7 files |
| Phase 41 P02 | 22m | 3 tasks | 4 files |
| Phase 42 P02 | 8min | 3 tasks | 2 files |
| Phase 42 P03 | ~12min | 3 tasks | 12 files |
| Phase 43 P01 | 6 | 3 tasks | 6 files |
| Phase 43 P03 | 6 | 2 tasks | 4 files |
| Phase 43 P05 | 9min | 2 tasks | 3 files |
| Phase 44 P01 | 12min | 2 tasks | 4 files |
| Phase 44 P02 | 11min | 3 tasks | 4 files |
| Phase 45 P01 | 5min | 3 tasks | 7 files |
| Phase 45 P02 | 151 | 2 tasks | 4 files |
| Phase 45 P03 | 420 | 3 tasks | 3 files |
| Phase 45 P04 | 4min | 3 tasks | 2 files |
| Phase 45 P5 | 6min | 3 tasks | 0 files |
| Phase 46 P01 | 9 | 3 tasks | 7 files |
| Phase 46 P02 | 12min | 2 tasks | 6 files |
| Phase 46 P05 | 4 | 2 tasks | 3 files |
| Phase 46 P03 | 5min | 3 tasks | 6 files |
| Phase 46 P04 | 7 | 3 tasks | 4 files |

## Decisions

- [Phase ?]: Phase 38 LLM-FIX: honest single-source health tokens (cache-fallback-active: default, llm-optional only for llmEvents)
- [Phase ?]: Phase 38 LLM-FIX: actorMatchRate number|null — null=not-populated distinct from measured 0%; replay endpoint quota death now 503-not-500 (Pitfall 5 fix)
- [Phase 39]: 39-02: runId generated once at run boundary + stamped on llmProgress; every call entry (success+failure) inherits it and dual-writes to llm:calls:history — call->run back-correlation for the flight recorder (OBS-FLIGHT-05)
- [Phase 39]: 39-02: run record closed once in finally keyed off a runOutcome witness (Open Q3) — a missed branch still closes the run; default outcome 'error' is the honest fallback
- [Phase 39]: BudgetBlock sources the already-polled tokenBudget field (no new fetch); FlightRecorderBlock owns its Bearer fetch of /llm-history — GA-3 no Redis fan-out for cost; Plan-04 /llm-history is the single FlightRecorder read surface (39-05)
- [Phase 39]: FlightRecorder Level 3 renders the full CallHistoryEntry record as copyable JSON (call ring carries telemetry, not raw prompt/response text) — GA-1 baseline: operator CAN read a single call's record; richer prompt surface defers to Phase 40 (39-05)
- [Phase 40]: 40-01: status colors declared as hex (NOT OKLCH), byte-identical to the map tokens they replace, so colorBridge's hex parser roundtrips and the migration off borrowed map tokens is zero-visual-change (UI-POLISH-03 foundation)
- [Phase 40]: 40-01: status-token colorBridge re-exports are hex-only (no readCssRGB tuple) — no deck.gl consumer; collapse/drawer view-state is session-scoped (no localStorage, mirrors the DevApiStatus modal slice), drawer default closed per D-02a
- [Phase ?]: (40-02) DevApiStatusAllApisTab restructured into hero + 4 collapsible groups + default-closed operator-controls drawer; Replay/Prune buttons relocated into the drawer, read-only counters stay in Group 4 (D-01/D-02a)
- [Phase ?]: (40-02) Tier-banner/sparkline/hero status dots migrated to --color-status-* namespace (byte-identical hex, zero visual change); BudgetBlock/FlightRecorderBlock/actor-quality self-hides converted to canonical muted-placeholder degrade (D-06)
- [Phase ?]: (40-04 UI-POLISH-05) 8 UI-SPEC Regression-Lock assertions coded as RTL/snapshot tests across the 6 existing DevApiStatus test files (extended, not replaced) + 1 new consolidated-layout snapshot; assertion 5 (drawer default-closed) doubles as a security-adjacent guard
- [Phase 41]: Phase 41 Wave 1 docs core shipped: BUILDING-WITH-CLAUDE-CODE.md (first-person agentic meta-story), JOURNEY.md (product arc + Mermaid gantt), SHOWCASE.md (1-page guided-tour hub) + README hero link — SC41-2 satisfied (1-click to meta-story/product-arc/decisions)
- [Phase ?]: (42-02, D-04/D-07) Name-aware + deterministic spatialDedup shipped: extracted the inline name-blind O(n²) dedup loop into an exported pure spatialDedup(facilities)->{kept,collapsed}. Distinct named facilities of the same type within 50m now BOTH admit (D-04); survivor is deterministic (notabilityScore desc, osmId asc — D-07), order-independent of Overpass return order. normName reads f.label (Pitfall 4, not nameLatin). 50m window + facilityType equality unchanged (D-05); admission gate untouched (D-06). D-14 regression fixture pins the real Sd Wdy Rbg / Rabigh Dam dropped pair (collapsed===0 post-fix). Task 3 no schema change. WATER-FILTER-02 + WATER-FILTER-04 complete.
- [Phase ?]: (42-03, WATER-FILTER-03) water:facilities:v3 -> v4 bumped atomically across all 10 lockstep surfaces; v3 demoted to dead-surveillance in the redis-registry whitelist; snapshot regenerated 304 -> 460 facilities (D-09 behavior-change evidence); Open Question 2 resolved — data-flows.md not gate-covered, deferred to Phase 49 (D-11). Full server suite 1378 green; tsc clean; drift gate green.
- [Phase ?]: (43-01, D-04/D-06/D-16) UrlLiveness widened to 7-status taxonomy (+soft-404 +no-url) with required-but-nullable evidence + nullable lastUrlProbed; isTerminalDead(soft-404)=true, no-url=false; soft-404/no-url 24h TTL; D-10 attemptCount JSDoc amended (unknown PRESERVES prior count, full wiring Plan 03). Contract-lockstep across schema test + src shim + redis-keys.md + CLAUDE.md (D-18). Rule-3: 7 sweep-test ProbeResult fixtures gained evidence.
- [Phase ?]: (44-01, D-01/D-03) countsByStatus is a SAMPLED per-status tally (<=MAX_SCAN_KEYS=200) computed inside the existing buildDeadUrlSample SCAN loop with zero extra Redis reads; deadUrlCount stays the authoritative O(1) sidecar. lastProbedAt/attemptCount added to deadUrlSample (both already on stored UrlLiveness). Closed pre-existing Phase 43 OpenAPI drift (soft-404 enum + evidence) in the D-04 lockstep commit (route test + openapi.yaml + client interface).
- [Phase ?]: (44-02, D-05/D-06) 7 v2 LLM blocks mounted presence-gated into production EventsFiltersSectionV3; BudgetBarsBlock self-hides under NIM-only (correct/honest); WaterfallBlock gated on stage != idle
- [Phase ?]: (44-02, D-09/D-10) New DeadLinkBucketsBlock: authoritative deadUrlCount + sampled 'of N scanned' per-status buckets + drill-down rows with evidence-as-TEXT (T-44-04) + dead-streak attemptCount; self-hides on absent prune
- [Phase ?]: (44-02, Rule 3) prune threaded via events-tab-scoped operator-status fetch in DevApiStatus (eventsPrune); canonical opStatus fetch lives in sibling DevApiStatusAllApisTab; mutually-exclusive tabs => no concurrent double fetch
- [Phase ?]: Phase 45-01: TREND_HISTORY_KEY = 'dashboard:trends:history' (bounded LPUSH+LTRIM 30-cap, 30d TTL; Phase 49 registry sweep)
- [Phase ?]: Phase 45-01: trendHistory degrades to [] (not null) on Redis failure because readTrendHistory is itself degrade-open
- [Phase ?]: Phase 45-01: cronAgeMs is null (never fabricated 0) when a cron:lastTick key is absent — a stalled cron is a valid sparkline signal (D-02)
- [Phase ?]: Phase 45 readability atoms MetricRow + Sparkline extracted to separate files (CONTEXT D-06/D-07); no-inline-hex + two-weight; not yet wired into DevApiStatus (Plans 03/04 compose them)
- [Phase ?]: Phase 45-03: shared DisclosureSection helper (FlightRecorder idiom) reused across Water + Sites for visual parity; Plan 04 can reuse
- [Phase ?]: Phase 45-03: per-type table defaults open; By Country + Rejections default collapsed (the raw dumps being tamed)
- [Phase ?]: Plan 45-04: events trend sparklines thread opStatus.trendHistory off the existing events-scoped /api/operator-status poll (no new fetch); cron-stale threshold 30h, dead-link tint on a new high past prior peak
- [Phase ?]: (45-05) DASH-READ-04 freeze PROVEN + DASH-READ-03 no-inline-hex CLOSED: 4 behavioral pins (60 tests) pass unmodified; only phase tab-token diff line is a JSDoc comment (zero JSX role/aria/tabIndex changed); deliberate snapshot -u regen = ZERO diff (byte-stable, scope=all-apis-tab body only); atom + new-DevApiStatus hex grep = 0; full-phase sweep 12 files/150 green; tsc exit 0.
- [Phase ?]: 46-02: missedRun is a sibling field (cronRunStateEnum), never a healthStatusEnum value — protects prod-connectivity-audit okCron / LLM-RELI-07 gate
- [Phase ?]: 46-02: cron graceMs = 4h (D-04 band), keeps missed strictly earlier than the 26h degraded window
- [Phase ?]: 46-02: deriveCronRunState layered ON TOP of deriveStatus — 4-state ladder untouched (D-06)
- [Phase ?]: 46-05: HARD-03 backfill — hydration-throw no-op + flag-stays-set proven for both flight-recorder hydrate helpers; net-new trendHistory degrade-open test (Phase-45 gap closed). Test-only, no runtime change.
- [Phase ?]: cron:watch:v2 ring cap 14 / ~30d TTL piggybacks the existing 0 0 * * * health cron — no new cron/endpoint (CRON-WATCH-01 D-07)
- [Phase ?]: CRON-WATCH-01 watch is NON-BLOCKING; 46-WATCH.md + dated ring make a partial close visibly partial; early close requires a Phase-31-citing operator decision (D-08)
- [Phase ?]: 46-04: rate-limiter + cron-freshness operator blocks render inside the FROZEN API Health role=tabpanel (Phase 45 D-08); zero tablist DOM change
- [Phase ?]: 46-04: cron badge driven by the /api/health missedRun SIBLING field, never the wire status enum (okCron audit-gate safety)
- [Phase ?]: 46-04: both blocks degrade-open to a MutedPlaceholder on null/absent source; zero inline hex (colors via --color-status-* @theme tokens)

## Operator Next Steps

- Start the next milestone with /gsd-new-milestone

## Session

**Last session:** 2026-06-22T20:09:31.789Z
**Stopped at:** Completed 46-03-PLAN.md
**Resume file:** None

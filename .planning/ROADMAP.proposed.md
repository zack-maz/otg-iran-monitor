# Roadmap: Iran Monitor

Phase-by-phase history for every milestone before v2.0 (plans, research, verification, reviews) was removed from the working tree on 2026-09-17. It is preserved at git tag `planning-archive-2026-09` — e.g. `git show planning-archive-2026-09:.planning/milestones/v1.5-ROADMAP.md`. Summaries of shipped milestones live in [MILESTONES.md](MILESTONES.md); lessons in [RETROSPECTIVE.md](RETROSPECTIVE.md).

## Milestones

- ✅ **v0.9 MVP** — Phases 1–12 (shipped 2026-03-19)
- ✅ **v1.0 Deployment** — Phases 13–14 (shipped 2026-03-20)
- ✅ **v1.1 Intelligence Layer** — Phases 15–19.2 (shipped 2026-03-22)
- ✅ **v1.2 Visualization & Hardening** — Phases 20–21.3 (shipped 2026-03-29)
- ✅ **v1.3 Data Quality & Layers** — Phases 22–26.4 (shipped 2026-04-09)
- ✅ **v1.4 GDELT Redo & Performance** — Phases 27–28.2.7 (shipped 2026-05-08)
- ✅ **v1.5 LLM Reliability & Reveal Prep** — Phases 29–37 (shipped 2026-06-03)
- ✅ **v1.6 Production Hardening** — Phases 38–41 (shipped 2026-06-09)
- 🚧 **v2.0 Final Hardening** — Phases 42–49 (started 2026-06-09; idle 2026-06-22 → 2026-09-17)

## Read this first (2026-09-17)

The project sat unattended for ~12 weeks. A production + code + docs audit on 2026-09-17 found flights down, the LLM event pipeline producing nothing for months, and a set of latent defects. Findings, fixes made, and a recommended order of work are in [`docs/AUDIT-2026-09.md`](../docs/AUDIT-2026-09.md). Outage fixes and the documentation overhaul are on branch `chore/overhaul-2026-09`.

**Proposed, not yet accepted:** before Phases 47–48, insert a recovery phase covering AUDIT §6 steps 1–4 (deploy the branch; make the extraction run bounded, checkpointed and honestly reported; green CI; delete the inert pipeline machinery). Load-testing a system whose main pipeline cannot complete a cold run is the wrong order. Add it with `/gsd-phase` once agreed.

## Milestone v2.0: Final Hardening — 🚧 IN PROGRESS (started 2026-06-09)

**Goal:** Close out the production punch-list — fix the remaining data-quality bugs (water filter, ghost links), make the API-Health dashboard readable, prove ~100-concurrent-user capacity, and finish hardening + docs. This is a subsequent-milestone pass on an already-shipped, production-verified application: every feature decomposes onto existing modules with zero new runtime or dev dependencies. The work is debugging, wiring, styling, and verification — not redesign.

**Coverage:** 28 requirement IDs across 8 phases; mapping in [REQUIREMENTS.md](REQUIREMENTS.md#traceability). CRON-WATCH-01 is non-blocking and must not gate milestone close.

### Phases summary

- [x] **Phase 42: Water Filter Fix** — name-aware deterministic spatial dedup; `water:facilities:v3` → `v4`. _(WATER-FILTER-01..04)_ (completed 2026-06-10)
- [x] **Phase 43: Ghost Link Prune Correctness** — soft-404 heuristic, `no-url` status, `unknown` excluded from prune, 403 not auto-pruned, evidence strings. _(GHOST-06..10)_ (completed 2026-06-10)
- [x] **Phase 44: Events Subtab Pipeline Detail** — LLM blocks mounted in the events subtab; dead-URL count reconcile hotfix. _(EVENTS-TAB-01..02)_ (completed 2026-06-10)
- [x] **Phase 45: Dashboard Subtab Readability Redesign** — numerics, hierarchy, trend sparklines. _(DASH-READ-01..05)_ (completed 2026-06-22)
- [x] **Phase 46: General Hardening + Cron Watch Start** — per-tier 429 counters, cron missed-run detection, cron-watch ring, test backfill. _(HARD-01, HARD-02, CRON-WATCH-01, HARD-03)_ (completed 2026-06-22). The 7-day watch was never read: `cron:watch:v2` has no reader and its PASS criterion passed through every day the pipeline was empty. Treat CRON-WATCH-01 as structurally shipped, observationally void.
- [ ] **Phase 47: ~100-User Load Test** — k6 1→300 VU sweep with a sustained ~100-VU window, CI-failing per-endpoint SLO thresholds, SLO table, read-only allowlist / dual-Bearer / budget guardrails. _(LOAD-01..04)_ **Scope correction:** LOAD-01 assumed CDN cache headers were never implemented. They exist (`server/middleware/cacheControl.ts`, applied per route in `server/index.ts`); only the `s-maxage` values are shorter than the original plan. LOAD-01 is a tuning decision, not a missing layer.
- [ ] **Phase 48: Load Remediation** — root-cause and fix every SLO failure; re-run green. Closes trivially if 47 is green. _(LOAD-FIX-01..02)_
- [x] **Phase 49: Docs Cleanup** — delivered out of order by the 2026-09-17 overhaul: one Redis registry (`docs/redis-keys.md`) with its drift gate, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, rewritten `README.md` and `CLAUDE.md`, corrected `CHANGELOG.md` and `.env.example`. Will need a light pass after 47–48 land. _(DOCS-CLEAN-01..02)_

### Phase 42: Water Filter Fix

**Goal**: The water facilities layer stops intermittently dropping legitimate named facilities, with the fix proven telemetry-first (not guessed) and pinned against regression.
**Depends on**: Nothing (first v2.0 phase; fully independent — must precede any water-subtab readability work in Phase 45 so the redesign shows correct facility counts).
**Requirements**: WATER-FILTER-01, WATER-FILTER-02, WATER-FILTER-03, WATER-FILTER-04
**Success Criteria** (what must be TRUE):

1. Operator has a written diagnosis citing the specific `byTypeRejections` bucket(s) that ate the missing facilities, produced from `npm run refresh:water` telemetry BEFORE any code change (prime suspect: O(n²) spatial dedup keyed on `facilityType` only).
2. The facilities layer no longer drops entries — spatial dedup never collapses distinct named facilities, and the Latin-label admission gate stays as-tight (the Phase 27.3.1 G1 "Dam near X" regression remains fixed, not loosened).
3. The fix is visible in production data — if the persisted shape or behavior changed, `water:facilities:v3` is bumped (v3→v4) and `src/data/water-facilities.json` cold-start snapshot is regenerated and committed.
4. The `waterFilterStats` test suite is updated in lockstep — rejection-bucket deltas pin the fix and a fixture for the previously-dropped OSM element fails on regression.

**Plans:** 3/3 plans complete
Plans:
**Wave 1**

- [x] 42-01-PLAN.md — Telemetry-first diagnosis (42-DIAGNOSIS.md) + RED spatialDedup test scaffold [wave 1; checkpoint]

**Wave 2** _(blocked on Wave 1 completion)_

- [x] 42-02-PLAN.md — Name-aware + deterministic spatialDedup fix + D-14 regression fixture + stats lockstep [wave 2, after 01]

**Wave 3** _(blocked on Wave 2 completion)_

- [x] 42-03-PLAN.md — water:facilities:v3→v4 lockstep (10 surfaces) + snapshot regen + contract docs [wave 3, after 02]

### Phase 43: Ghost Link Prune Correctness

**Goal**: Dead-link detection gets more precise (catches soft-404s, covers every event) without getting more aggressive (never prunes live-but-flaky links), and the operator can see WHY any link was flagged.
**Depends on**: Phase 42 (sequence only; no code coupling). Server-only — independent of the dashboard work.
**Requirements**: GHOST-06, GHOST-07, GHOST-08, GHOST-09, GHOST-10
**Success Criteria** (what must be TRUE):

1. The URL-liveness probe detects soft-404s via a body heuristic on 200 responses (not-found markers, redirect-to-home, near-empty content) with no headless browser.
2. Every event is probe-reachable or explicitly classified — source-less events are no longer silently skipped by `buildProbeCandidates`, so prune can evaluate them.
3. Transient failures never count toward terminal-dead prune — the `unknown` bucket is excluded from prune eligibility, the `attemptCount >= 3` gate is retained, and flaky-host attempt-reset semantics are fixed so repeat offenders eventually accumulate; a `prunedIds` sample audit confirms no live events were swept.
4. The 403 auto-prune decision is made with evidence (a `prunedIds` sample) and implemented — 403 stays distinct from 404, demoted to manual-only if bot-blocking CDNs are confirmed false-positives.
5. The operator can see why a link was flagged dead — an evidence string (matched marker / redirect target / body length) is persisted in `events:url-liveness:{eventId}` with the schema test and Redis registry updated in lockstep.
   **Plans**: 5 plans

- [x] 43-01-PLAN.md — Widen UrlLiveness schema/enum/TTL/isTerminalDead + evidence field; contract lockstep (schema test + shim + redis-keys.md + CLAUDE.md) [GHOST-10] (Wave 1)
- [x] 43-02-PLAN.md — soft-404 body heuristic: classifySoft404 + 16 KiB capped GET on 200s + probeUrl wiring [GHOST-06] (Wave 2)
- [x] 43-03-PLAN.md — attemptCount semantics (live=0, unknown=preserve) + source-less no-url coverage + classifiedNoUrl log line [GHOST-07, GHOST-08] (Wave 3)
- [x] 43-04-PLAN.md — GHOST-09 evidence sample: prunedIds + 403 browser-UA re-probe (prod, checkpoint) → decision recorded [GHOST-09] (Wave 2)
- [x] 43-05-PLAN.md — cron-only 403 exclusion (per evidence) + unknown/no-url prune pins + DeadUrlSampleEntry evidence/soft-404 exposure [GHOST-09, GHOST-10] (Wave 4)

### Phase 44: Events Subtab Pipeline Detail

**Goal**: The operator can read full LLM-pipeline detail and per-bucket dead-link state directly in the API-Health events subtab, using data that already exists in Redis — a pure presentational mount, no server changes.
**Depends on**: Phase 43 (GHOST-10 persists the per-event evidence string this subtab surfaces). Must precede Phase 45 so the 3538-line `DevApiStatus.tsx` subtab is wired before it is restyled (avoids touching the same file twice for the same concern).
**Requirements**: EVENTS-TAB-01, EVENTS-TAB-02
**Success Criteria** (what must be TRUE):

1. The operator sees full LLM pipeline detail in the events subtab — the 7 already-built blocks (Waterfall, Histograms, CallLog, BudgetBars, EvalScore, Dlq, Suspect) are mounted into `EventsFiltersSectionV3`, fed from existing `LLMStatus` fields, with DLQ depth / breaker state / eval baseline+drift / run-history all visible.
2. The operator can read dead-link state per bucket in the events subtab — counts per liveness status plus first-seen-dead / transition timestamps.
3. The mount is data-wiring only — the WAI-ARIA tablist DOM contract (tab ids, `aria-labelledby` partners) is unchanged, and every block remains degrade-open (self-hides when its data is absent).

**Plans:** 2/2 plans complete
**Wave 1**

- [x] 44-01-PLAN.md — Server lockstep: `countsByStatus` tally + `lastProbedAt`/`attemptCount` on the prune `deadUrlSample` (inside the existing SCAN, no new reads) + 3-surface contract lockstep (route test, OpenAPI incl. closing the Phase-43 `evidence`/`soft-404` drift, client `OperatorStatus.prune` interface) [EVENTS-TAB-02] (Wave 1)

**Wave 2** _(blocked on Wave 1 completion)_

- [x] 44-02-PLAN.md — Client mount: presence-gated 7 v2 blocks + FlightRecorder re-mount + new `DeadLinkBucketsBlock` into `EventsFiltersSectionV3` + `prune` prop thread + evolve the two events-section test pins (5 pinning suites stay green) [EVENTS-TAB-01, EVENTS-TAB-02] (Wave 2, after 44-01)

**UI hint**: yes

### Phase 45: Dashboard Subtab Readability Redesign

**Goal**: The dense water / events / sites subtabs become scannable and trend-aware while keeping the off-the-grid military aesthetic and breaking nothing behavioral.
**Depends on**: Phase 44 (same file, same subtab — wiring lands first, restyle second). Sits between the ghost work and the load test per the operator priority insert.
**Requirements**: DASH-READ-01, DASH-READ-02, DASH-READ-03, DASH-READ-04, DASH-READ-05
**Success Criteria** (what must be TRUE):

1. Numeric data in the water/events/sites subtabs is scannable — `tabular-nums`, right-aligned numeric columns, labeled headers, whitespace grouping.
2. Raw data dumps are replaced with formatted summaries plus progressive disclosure — detail lives behind drill-down following the `FlightRecorderBlock` run→call→detail pattern.
3. Visual hierarchy reads within the off-the-grid aesthetic — one primary metric prominent per block, labels small, contrast meets readability, and every color comes from the `@theme` token block / colorBridge (no inline hex).
4. The redesign breaks nothing behavioral — the WAI-ARIA tablist contract (roving tabindex, tab ids) is frozen byte-stable, and the 5 pinning test suites (snapshot, tabMerge, diagnosticBlocks, operatorActions) plus degrade-open semantics stay green.
5. The operator can see trends, not just point-in-time numbers — sparklines for dead-link count and cron freshness, backed by small history rings, catch slow-burn regressions.

**Plans:** 5/5 plans complete

Plans:
**Wave 1** _(parallel — disjoint files: server ring vs new atom files)_

- [x] 45-01-PLAN.md — Server-backed bounded Redis trend ring (D-01): once-daily append in the existing `/api/cron/health` + `trendHistory` field on `/api/operator-status` w/ OpenAPI + route-test + client-interface lockstep [DASH-READ-05]
- [x] 45-02-PLAN.md — Extract the two reused atoms (D-06/D-07): `MetricRow.tsx` (tabular-nums right-aligned row) + `Sparkline.tsx` (30-pt SVG line, neutral stroke + semantic last-point tint) w/ own unit tests [DASH-READ-01, DASH-READ-03]

**Wave 2** _(after 45-02)_

- [x] 45-03-PLAN.md — Restyle Water + Sites subtabs: one 13px/600 primary metric + MetricRow Reason|Count tables + progressive-disclosure drill-downs + two-weight headers; render pins evolved in lockstep [DASH-READ-01, DASH-READ-02, DASH-READ-03]

**Wave 3** _(after 45-01 + 45-02 + 45-03 — same file, sequenced)_

- [x] 45-04-PLAN.md — Events subtab: mount the 4 trend sparklines (3 per-cron freshness + 1 dead-link, D-02) from the trend ring + readability grammar over the Phase-44 blocks (no re-mount); render pins evolved [DASH-READ-02, DASH-READ-03, DASH-READ-05]

**Wave 4** _(after 45-03 + 45-04)_

- [x] 45-05-PLAN.md — DASH-READ-04 behavioral freeze: 4 behavioral pins green unmodified + tablist byte-stability + deliberate snapshot regen (subtab-body-only diff) + no-inline-hex gate + full-phase sweep [DASH-READ-03, DASH-READ-04]

**UI hint**: yes

### Phase 46: General Hardening + Cron Watch Start

**Goal**: The rate-limiter and cron primitives become operator-visible and verifiably safe, the 7-day cron-stability watch starts as a non-blocking async observation, and the Phase 39/40 surfaces get Nyquist coverage — all BEFORE the load test so its metrics validate this hardening.
**Depends on**: Phase 45 (sequence). Must precede Phase 47 so the load test's 429-count and cold-start metrics exercise and confirm this hardening, making any load-test SLO failure unambiguous.
**Requirements**: HARD-01, HARD-02, CRON-WATCH-01, HARD-03
**Success Criteria** (what must be TRUE):

1. Rate-limiter state is operator-visible and operator-safe — the Bearer bypass is verified to cover all operator dashboard polls (999.1), and tier config plus recent 429 counts are surfaced in the dashboard.
2. Cron first-tick and missed-run detection works — an in-app freshness check computed from `cron:lastTick:{name}` age vs schedule + grace is surfaced via `/api/health` (999.3), with no external SaaS dependency.
3. The 7-day cron-stability watch is structured as a NON-BLOCKING, auto-reported observation with daily auto-captured results that do NOT gate milestone close — its early-close criteria are a logged decision (citing the v1.5 Phase 31 early-close precedent), not a silent repeat.
4. The Phase 39/40 surfaces have Nyquist test-coverage backfill — flight recorder, budget block, and subtab consolidation paths are covered, including degrade-open fault-injection tests.

**Plans:** 5/5 plans complete

**Wave 1** _(parallel — disjoint files)_

- [x] 46-01-PLAN.md — HARD-01 server: 429 sidecar counter (degrade-open) + RATE_LIMITER_CONFIG export + operator-status `rateLimiter` block + OpenAPI + 999.1 Bearer-bypass proof + CLAUDE.md key [HARD-01]
- [x] 46-02-PLAN.md — HARD-02 server: `CRON_SCHEDULE_GRACE_MS` table + `deriveCronRunState` + `missedRun` SIBLING field on /api/health (status enum UNCHANGED — protects the LLM-RELI-07 okCron gate) [HARD-02]
- [x] 46-05-PLAN.md — HARD-03 Nyquist backfill: hydration-throw no-op (call+run history) + net-new `trendHistory.test.ts` degrade-open backfill (narrow named gaps only) [HARD-03]

**Wave 2** _(after Wave 1 — see notes)_

- [x] 46-03-PLAN.md — CRON-WATCH-01: `cronWatch.ts` ring + daily `appendWatchSample` on the existing /api/cron/health + NON-BLOCKING WATCH artifact + CLAUDE.md key (Wave 2 only to serialize the shared CLAUDE.md append after 46-01) [CRON-WATCH-01]
- [x] 46-04-PLAN.md — HARD-01/02 dashboard: `rateLimiter` interface + two DevApiStatus blocks inside the frozen API-Health tabpanel (MISSED alarm badge) + sidecar-absent render coverage (after 46-01 + 46-02 server shapes) [HARD-01, HARD-02]

### Phase 47: ~100-User Load Test

**Goal**: ~100-concurrent-user capacity is measured against the hardened surface with CI-failing SLO thresholds and zero risk of burning money or skewing results.
**Depends on**: Phase 46, and in practice the recovery work in `docs/AUDIT-2026-09.md` §6.
**Requirements**: LOAD-01, LOAD-02, LOAD-03, LOAD-04
**Success Criteria** (what must be TRUE):

1. CDN `s-maxage` values on the cache-only GET routes are reviewed against the >90% cache-hit bar and tuned if needed (the header layer already exists).
2. ~100 concurrent users are proven — a k6 1→300 VU sweep with a sustained ~100-VU window, CI-failing `thresholds` (p95 + error rate per endpoint mix), cold-start tail distinguished from warm p95.
3. The run emits a per-endpoint SLO table (endpoint → p95/p99/error rate → pass/fail).
4. The load test cannot burn money or skew results — read-only endpoint allowlist (never `?force=true`, `/api/cron/*`, `/llm-replay`, `/llm-history`), dual Bearer/no-Bearer passes, 429s counted separately from failures, Vercel and Upstash budgets checked before sizing. Decision lock: `phases/999.5-performance-load-test/999.5-CONTEXT.md`; guardrails: `research/PITFALLS.md`.
   **Plans**: TBD

### Phase 48: Load Remediation

**Goal**: Every SLO failure the load test surfaced is root-caused and fixed, and a re-run proves ~100-user capacity.
**Depends on**: Phase 47.
**Requirements**: LOAD-FIX-01, LOAD-FIX-02
**Success Criteria** (what must be TRUE):

1. Every SLO failure is diagnosed to a specific root cause and remediated — or a clean first run is recorded as the explicit close rationale.
2. The full k6 sweep is re-run after remediation and passes all thresholds.
   **Plans**: TBD

### Phase 49: Docs Cleanup

**Goal**: Contract surfaces and prose docs reflect shipped reality with every drift gate green.
**Status**: Delivered 2026-09-17 on branch `chore/overhaul-2026-09`, outside the GSD phase flow. No phase directory exists.
**Requirements**: DOCS-CLEAN-01, DOCS-CLEAN-02

### Progress Table

| Phase | Name                                  | Plans Complete | Status                 | Completed  |
| ----- | ------------------------------------- | -------------- | ---------------------- | ---------- |
| 42    | Water Filter Fix                      | 3/3            | Complete               | 2026-06-10 |
| 43    | Ghost Link Prune Correctness          | 5/5            | Complete               | 2026-06-10 |
| 44    | Events Subtab Pipeline Detail         | 2/2            | Complete               | 2026-06-10 |
| 45    | Dashboard Subtab Readability Redesign | 5/5            | Complete               | 2026-06-22 |
| 46    | General Hardening + Cron Watch Start  | 5/5            | Complete               | 2026-06-22 |
| 47    | ~100-User Load Test                   | 0/TBD          | Not started            | -          |
| 48    | Load Remediation                      | 0/TBD          | Not started            | -          |
| 49    | Docs Cleanup                          | n/a            | Complete (out of band) | 2026-09-17 |

## Deferred Work

- **Satellite imagery layer** — ArcGIS World Imagery as a semi-transparent overlay.
- **GDELT BigQuery adapter** — SQL access to the full column set (needs a GCP project).
- **Telegram channel monitoring** — OSINT early-warning signals.
- **Second LLM provider** — Cerebras/Groq were deferred and their adapters deleted; OpenRouter's free tier measured 90% rate-limited on 2026-05-17 and is dormant. With one provider, the circuit breaker and rate window should wait rather than skip (AUDIT L5).
- **`vercel.json` → `vercel.ts`**, and splitting the extraction cron into its own function with its own `maxDuration` (AUDIT A13).
- **driver.js tour step-4 spotlight desync** — call `driver.refresh()` after the panel slide-in.

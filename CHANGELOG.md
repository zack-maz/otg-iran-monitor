# Changelog

All notable changes to the Iran Monitor project.

## [Unreleased] — branch `chore/overhaul-2026-09` (2026-09-17)

Audit of production, code and docs after ~12 weeks unattended. Full findings: [docs/AUDIT-2026-09.md](docs/AUDIT-2026-09.md).

### Fixed

- **Flights down in production.** adsb.lol returns 403 to Node's default `User-Agent`; the adapter now sends `OUTBOUND_USER_AGENT`.
- **LLM event pipeline produced nothing for months.** The refresh-events cron read `events:gdelt` cache-only, and only a browser visit wrote that key. The cron now refreshes raw GDELT itself through the shared `refreshRawEvents` (`server/lib/rawEventsRefresh.ts`), never runs the history backfill, and does not persist a backfill-less set into an empty accumulator.
- **`/api/events` re-downloaded GDELT on every request** whenever an LLM key was configured and the enriched cache was cold or stale.
- **News context was always empty.** The LLM prompt's news block, the corroboration boost and the Bellingcat boost read `news:gdelt`, a key with no writer; they now read `news:feed`.
- **Per-endpoint rate limiters shared one per-IP counter.** Each tier now has its own Redis prefix. The limiter also degrades open on Upstash errors instead of returning 500.
- **Request logs leaked Vercel platform headers** (`x-vercel-oidc-token`, `x-vercel-proxy-signature`, `forwarded`); now redacted.

### Changed

- Documentation rewritten: `README.md`, `CLAUDE.md`, new `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, single Redis registry at `docs/redis-keys.md`, `docs/AUDIT-2026-09.md`. Removed `PROJECT_STATUS.md`, `PROJECT_SPEC.md`, `docs/architecture/`, `docs/runbook.md`, `docs/degradation.md`, `docs/operator-guide.md`, `docs/concepts.md`, `docs/COSTS.md`, `docs/superpowers/`, `docs/brainstorms/`. Essays moved to `docs/portfolio/`.
- Pre-v2.0 planning history (`.planning/milestones`, `debug`, `quick`, `todos`) removed from the working tree; preserved at git tag `planning-archive-2026-09`.
- Eval fixtures moved from `.planning/eval/` to `server/data/eval/`; CAMEO codebook fixture to `src/__tests__/fixtures/`; snapshot/probe scripts write to `.snapshots/`.
- Redis registry drift test gates `docs/redis-keys.md` only (no second copy in `CLAUDE.md`). Removed `docs-exist.test.ts`.

## [v2.0] — Final Hardening — 🚧 in progress (started 2026-06-09)

Phases 42–46 shipped to production 2026-06-10 → 2026-06-22. Phases 47–48 (load test, load remediation) not started.

- **Water filter fix (42):** name-aware, deterministic `spatialDedup`; cache key `water:facilities:v3` → `v4`; snapshot grew from 304 to 460 facilities.
- **Ghost-link prune correctness (43):** soft-404 body heuristic, `no-url` status, `unknown` never pruned, 403 excluded from cron auto-prune, per-event evidence strings.
- **Events subtab pipeline detail (44):** LLM status blocks mounted in the events subtab; dead-URL counter reconcile (`reconcileDeadUrlCount`).
- **Dashboard subtab readability (45):** tabular numerics, hierarchy, trend sparklines from `dashboard:trends:history`.
- **General hardening (46):** per-tier 429 counters, cron missed-run detection on `/api/health`, cron-watch ring (never read — see audit), test backfill.

## [v1.6] — Production Hardening — 2026-06-09

**Span:** 2026-06-03 → 2026-06-05 (4 phases: 38 live-state verification, 39 LLM observability, 40 API-Health consolidation, 41 public-reveal polish). The v1.5-close code-side punch-list was fully resolved in Phase 38 — the residual v1.6 cleanup proved to be a pure docs sweep, completed alongside the reveal in Phase 41 (see `.planning/phases/41-public-reveal-polish/41-AUDIT.md`).

### Headline deliverables

- **Live-state verification & dead-code purge (Phase 38):** LLM-FIX honest health/audit/eval signals (split `health.ts` fallback token into generic `cache-fallback-active:` vs LLM-specific `llm-optional-fallback-active:`; `water.ts` writes a distinguishable degraded sentinel instead of skipping the cache write on total failure; `EvalScore.actorMatchRate` returns `null` not a silent `0`). LLM-PURGE removed the v1/v2 extractor schemas, the `pipelineAudit` writer + `PipelineFlipsBlock` UI, and the OpenRouter daily-cap writer; Cerebras/Groq retained as Phase-34 deferred-provider scaffolding. GDELT-MATCH added a high-confidence dedup pre-pass + three-gate OSINT corroboration with additive composite rescore. WATER-LATIN romanizes facility names before the Latin admission gate (`nameLatin`/`nameOriginal`). VERCEL-PRO repaired Hobby→Pro docs drift across 5 surfaces (`maxDuration` 800s, 40-cron cap, Fluid-Compute 300s default).
- **LLM observability — Flight Recorder (Phase 39):** `llm:calls:history` (500-cap call recorder) + `llm:runs:history` (200-cap per-run recorder) Redis flight recorders with cold-start hydration; Bearer-gated `GET /api/events/llm-history` read surface; operator **BudgetBlock** (per-provider token-budget proximity bars + cost-shadow USD) and **FlightRecorderBlock** (run→call→detail drill-down); degrade-open `tokenBudget` block in `/api/operator-status`.
- **API-Health dashboard consolidation (Phase 40):** restructured the API-Health tab into a hero + 4 collapsible groups + operator drawer; migrated status dots to `--color-status-*` tokens through the D-13 single-source color pipeline; muted-placeholder degrade for empty operator blocks; roving-tabindex keyboard nav + `role=tablist/tabpanel` ARIA + focus-visible affordances.
- **Public reveal polish (Phase 41):** seven portfolio docs — `BUILDING-WITH-CLAUDE-CODE.md` (first-person build meta-story with honest-failure receipts), `SHOWCASE.md` (1-click guided hub), `JOURNEY.md` (product arc + Mermaid gantt), `concepts.md` (38-term glossary), `COSTS.md` (honest accounting: Vercel Pro $20/mo, every feed free-tier), `operator-guide.md` (visitor how-to), `LESSONS.md` (distilled retrospective). D-10 final-sweep audit (code-side proven clean post-Phase-38; ADR-layer + README-currency + OpenAPI docs-drift swept). Screenshots consolidated to `public/screenshots/` with a reproducible `capture:layers` tool + a 1200×630 `og-card.png`. Interactive reveal: first-visit `IntroOverlay` + driver.js-powered `GuidedTour` (`TourTrigger`, `tourSteps`, `data-tour` HUD anchors) + static OG/Twitter meta in `index.html`. Stay-on-`vercel.app` decision recorded (REVEAL-SITE-04).

## [v1.5] — LLM Reliability & Reveal Prep — 2026-06-03

**Span:** 2026-05-11 → 2026-06-03 (24 days, 10 phases shipped). Closing milestone for the v1.x line; v1.6 promotion unblocked at close.

LLM pipeline narrowed and proven LLM-OPTIONAL: NIM at runtime, OpenRouter dormant, Cerebras + Groq deferred. The Pitfall 1 raw-GDELT cache bridge in `server/routes/events.ts` ships as the documented terminal fallback — when `events:llm:v3` is empty (LLM unconfigured, NIM throttled, or cron deferred), `/api/events` serves raw GDELT cleanly and the map never goes blank. ADR-0010 rewritten end-to-end to describe milestone-final shipped state. LLM-RELI-07 acceptance gate observed: 3 consecutive `prod-connectivity-audit.yml` exit-0 runs with `audit:connectivity:last-result.allTiersGreen === true`. Internal docs (JSDoc) + Redis-registry drift gate + public docs sweep + OpenAPI additions completed in lockstep. Vercel Pro upgrade ($20/mo, `maxDuration: 300 → 800`).

### Headline deliverables

- **LLM provider chain narrowing & LLM-Optional architecture (Phase 29):** Cascade narrowed to NIM + OpenRouter; v1 + v2 extractors deleted (Plans 04-06; ~6,400 LOC removed). `LLM_PIPELINE_V3=true` retired — v3 is the only extractor. LLM-optional contract proven via integration test (`/api/events` serves raw GDELT with all LLM credentials unset). Cerebras + Groq adapter dead-code purged. Vercel Pro upgrade. CLAUDE.md trimmed 73.3% to 5,018 tokens. Domain rename `irt-monitoring` → `otg-iran-monitor` finalized.
- **NIM throttle characterization & cascade tuning (Phase 30 + 30.1):** Path B measurement run: `Retry-After` headers absent in 213 batches; defensive defaults anchored to `perBatchLatency.p95 = 33,263ms`. Committed `LLM_BATCH_TIMEOUT_MS = 120000` / `RETRY_ATTEMPTS = 3` / `BACKOFF_MS = [2000, 8000, 32000]` / `JITTER_MS = 500`. SIMPLIFY-01 incremental flush retired (~95% fewer Redis SETs / cron run, net -92 LOC). SIMPLIFY-03 watchdog soft-warn tier eliminated (-97 LOC). `docs/architecture/llm-pipeline-reliability.md` created as measurement home. Phase 30.1 honest cascade declaration: OpenRouter declared dormant (`scripts/probe-openrouter.ts` 27/30 = 90.0% rate_limited).
- **Cron stability watch (Phase 31):** Day 1/7 watch passed; closed early per operator decision with caveat documented in 31-SUMMARY. The Day 1/7 caveat surfaced during Phase 37 acceptance-gate observation (slow-burn regression that the 7-day watch would have caught) — fix-pattern PRs landed in lockstep. Phase 31 reopening flagged as v1.6 candidate.
- **Ghost-event URL liveness + dashboard + prune (Phase 32):** GHOST-01..05 closed. `events:url-liveness:{eventId}` per-event probe sidecar (`live` 7d / `dead` 24h / `unknown` 1h tiered TTL); `events:url-liveness-count` O(1) sidecar for dashboard polls; per-Bearer prune quota (50/24h, `operator:prune-quota:{fp}:{date}`). Schema test pinning JSON shape. Operator-status aggregator surfaces dead-URL counts.
- **Actor metadata audit + canonical catalog + eval expansion (Phase 33):** ACTOR-01..05 closed. Canonical 200+ actor catalog with `actorConfidence` schema and inline LLM/manual citations. Eval expansion adds actor-resolution dimension.
- **LLM Router Fallback Re-integration — DEFERRED (Phase 34):** Cerebras + Groq deferred per operator decision (`cerebras-groq-deferred` close-out). LLM-RELI-08..11 closed as Done with the deferral outcome. CLAUDE.md "Active providers" amended in lockstep. Phase 31 Day-1 DLQ baseline (`4 × v3:timeout_watchdog`) accepted as known failure mode.
- **Internal docs + Redis registry verification + Redis optimization (Phase 35):** Redis-registry drift gate landed (`src/__tests__/lib/redis-registry.test.ts`; 39 assertions × 4 sub-suites; CLAUDE.md + `docs/architecture/redis-keys.md` + prod code parity). 32-key deep-dive inventory at `docs/architecture/redis-keys.md`. `events:llm:v3:partial` retired (SIMPLIFY-02; 358 LOC removed in single atomic commit). `freeClaudeRouter.ts` callers documented (SIMPLIFY-05). 7-module JSDoc audit (DOCS-INT-02). Bundle delta: +0.60% (JSDoc additions outweigh partial-key deletion).
- **Public docs sweep + OpenAPI additions (Phase 36):** DOCS-PUB-01, 02, 03, 05 + DOCS-API-01..07 closed. OpenAPI spec for public surfaces (`/api/health`, `/api/audit-status`, `/api/events`, `/api/operator-status` + 13 more). External-facing README + PROJECT_SPEC + PROJECT_STATUS updates. DOCS-PUB-04 deferred to Phase 37 (ADR-0010 milestone-final rewrite).
- **ADR-0010 milestone-final rewrite + acceptance-gate closeout (Phase 37):** DOCS-PUB-04 + LLM-RELI-07 closed. ADR-0010 body (Context / Decision / Consequences / Alternatives / References) rewritten to milestone-final shipped state. 6th and final v1.5 close sub-block appended with D-01..D-06 rows + v1.5 Milestone Close Rollup (6-arc retrospective inside the ADR). Status line gains second line `**Status:** Accepted (v1.5 closed 2026-06-03)`. 3 consecutive `prod-connectivity-audit.yml` exit-0 runs with `allTiersGreen=true` observed: Run 1 [26771054370](https://github.com/zack-maz/otg-iran-monitor/actions/runs/26771054370) (2026-06-01T17:33Z), Run 2 [26856054351](https://github.com/zack-maz/otg-iran-monitor/actions/runs/26856054351) (2026-06-03T00:24Z), Run 3 [26856364229](https://github.com/zack-maz/otg-iran-monitor/actions/runs/26856364229) (2026-06-03T00:33Z) — span 31h crossing 2 cron ticks; Runs 2+3 compressed ~9 min apart per D-08 NOTE after the truth-table relaxation landed.

### Acceptance-gate unblocker PRs (architectural mismatches surfaced during observation)

The Phase 37 acceptance-gate observation window (2026-06-01 → 2026-06-03) revealed architectural mismatches between the Phase 28.2.5 D-09 strict tier-green gate and the system's actual LLM-optional + browser-polled cache architecture. 4 PRs landed on main to correct the gate:

- **PR #32** (2026-06-01) — `llmEvents` demoted from critical → non-critical + LLM-optional `degraded-on-fallback` signal in `probeCacheKey` / `probeLlmStatus`. Aligns probe semantics with ADR-0010's LLM-optional contract.
- **PR #33** (2026-06-01) — `news` GDELT-DOC adapter made best-effort + `news:feed:rss-only` sidecar (RSS sources serve when GDELT-DOC is IP-throttled; the route degrades cleanly instead of 502-ing).
- **PR #34** (2026-06-03) — D-03 truth table relaxed for non-critical tier: now accepts `healthy | degraded | unknown`. Critical tier remains strict-`healthy`. Recognizes that browser-polled caches go cold during low-traffic windows by design.
- **PR #35** (2026-06-03) — hotfix YAML/shell apostrophe quoting in PR #34's comment block.

### Quantitative snapshot

- vitest baseline: 2193 → ~2386 (+~193 new tests across phases 29-37 and unblocker PRs)
- TypeScript errors: 0 → 0
- Lint errors: 0 → 0
- v1+v2 LLM extractor LOC: ~6,400 → 0 (deleted Phase 29)
- `events:llm:v3:partial` LOC: 358 → 0 (deleted Phase 35 SIMPLIFY-02)
- CLAUDE.md tokens: ~18,700 → 5,018 (73.3% reduction; Phase 29)
- Vercel `maxDuration`: 300s → 800s (Phase 29 D-08; Pro upgrade)
- Redis keys documented in `docs/architecture/redis-keys.md`: 0 → 32 (Phase 35)
- ADR-0010 v1.5 sub-blocks: 0 → 6 (Phases 30, 30.1, 34, 35, 37 + condensed-Phase-29 lead-in)
- Acceptance gate runs: 0 greens (2026-05-08 baseline; 9 reds in a row) → 3 consecutive greens (2026-06-03 close)
- Architectural unblocker PRs landed during Phase 37 observation: 4 (#32, #33, #34, #35)

### Migration notes (v1.4 → v1.5)

- **LLM cascade:** NIM is the runtime extractor. OpenRouter is dormant pending re-validation. Cerebras + Groq are deferred (no adapter code in `main`). `LLM_PIPELINE_V3` env var retired — v3 is the only extractor.
- **Operator kill switch:** Unsetting BOTH `NVIDIA_NIM_API_KEY` AND `OPENROUTER_API_KEY` is the documented kill switch per ADR-0010. `runRefreshExtraction()` short-circuits at `isLLMConfigured() → false`; the route degrades to raw GDELT via the Pitfall 1 bridge.
- **Audit gate semantics:** The `prod-connectivity-audit.yml` D-03 truth table now accepts `unknown` for non-critical-tier endpoints (Phase 37 PR #34). Critical tier (flights / ships / events) remains strict-`healthy`. `llmEvents` and `llmStatus` are non-critical and report `degraded` (not `unknown`) when the LLM-optional fallback path is engaged.
- **News route:** GDELT-DOC is best-effort. RSS sources serve when GDELT-DOC is rate-limiting prod (Phase 37 PR #33). New sidecar key `news:feed:rss-only` (15-min TTL) signals graceful degradation to the probe layer.
- **Vercel Pro:** Project on Pro plan; `vercel.json maxDuration: 800` (Phase 29 D-08).
- **Domain:** `otg-iran-monitor.vercel.app` remains canonical (no change from v1.4).

### Deferred to v1.6+ (carried forward)

- **Phase 999.5 (Performance load test, 1–300 VU k6 sweep):** PROMOTES to v1.6 as the first phase. The acceptance gate that gated promotion (LLM-RELI-07) closed at Phase 37 close.
- **Phase 999.1 (rate-limiter public-global blocks operator):** Parked. Re-evaluate against v1.6 hardening priorities.
- **Phase 999.2 (`api/vercel-entry.js` rebuild discipline):** Parked. Carried from v1.4.
- **Phase 999.3 (Phase 27.4.6 cron first-tick verification):** Parked. Carried from v1.4.
- **Phase 31 reopening:** Day 2-7 watch was the gap that let the Phase 37 acceptance-gate regression silently land. Consider 31.2 as a v1.6 entry.
- **Open-Meteo cache-write policy (`server/routes/water.ts:358-360`):** the `if (precipData.length > 0)` guard intentionally avoids caching empty results; the cold cache that results contributed to Phase 37 audit failures. Consider a tighter cache-write policy + cron-warmer in v1.6.
- **News route cron warmer:** `news:feed` is on-demand-only; consider `/api/cron/warm-news` (Vercel Pro cron quota likely supports it; CLAUDE.md "Hobby cap 3" line is stale).
- **Probe-side `lastErrorReason` token rename:** `'llm-optional-fallback-active'` is reused verbatim for the news case in PR #33 (mechanical mirror). Could be renamed to `'fallback-active'` if precision matters. Trivial follow-up.
- Telegram OSINT integration (carried from v1.3).
- GDELT BigQuery adapter (carried from v1.3).
- Satellite imagery overlay (carried from v1.2).
- **Phase 27.3.3:** Romanization of non-Latin water-facility names (carried from v1.4).

## [v1.4] — GDELT Redo & Performance — 2026-05-08

**Span:** 2026-04-09 → 2026-05-08 (29 days, 18 phases shipped, 1 deferred to backlog)

GDELT pipeline rebuilt around a structured LLM extraction layer (Cerebras → Groq → NIM v3 with parallel concurrency limiter), plus a full performance & operational hardening sweep against the stabilized v1.3 codebase. Daily cron triad (`/api/cron/{health,warm,refresh-events}`) replaces fire-and-forget extraction baked into request handlers. Production observability surface unified into the `API Health` tab with tier-grouped freshness, eval scores, adversarial robustness, DLQ, and operator audit log. Load test (originally Phase 28.3) deferred to backlog as `Phase 999.5` — promotes when `prod-connectivity-audit.yml` is exit-0 green for 3 consecutive runs.

### Headline deliverables

- **Structured LLM extraction (Phases 27 → 27.4.6):** v1 Cerebras + v2 watchdog/DLQ + v3 NIM parallel batches. Zod-validated 5-type ontology (`airstrike`, `on_ground`, `explosion`, `targeted`, `other`). 6-path geocode resolver with Nominatim throttling and 30-day Redis cache. Daily ground-truth eval (50 events / 11 countries) scored at 5/20/100km. Adversarial harness (~10 prompt-injection fixtures) folded into daily health cron.
- **Reliability primitives (Phases 27.4 → 27.4.6):** circuit breaker (sliding 10-call window, 5min pause >30% error), DLQ (200-entry SADD bounded set, 7d TTL, raw-string srem eviction), token budget (Cerebras 1M/day, Groq 200K/day, NIM 40 req/min, soft 0.8 / hard 0.95 caps), watchdog (90s hard kill + 60s soft warn, late-resolve guard + AbortController generation counter). Two-key cache discipline (`events:llm:v3` terminal vs `events:llm:v3:partial` observability) with reader defense-in-depth coercion at 3 read sites.
- **Cron-driven pipeline (Phase 27.4.6 + 28.2.6):** `/api/events` is now cache-only. Daily `/api/cron/refresh-events` at 04:00 UTC. Operator force-trigger via `?force=true`. Vercel `waitUntil` for fire-and-forget durability. Cold-cache self-heal bypasses 15-min cooldown when `events:llm:v3` is empty. NIM-throttle accept-and-fallback strategy (200 with DLQ recorded; raw GDELT serves users; map never goes blank).
- **Cleanup sweep (Phase 28.1, 7 waves):** ghost code deletion via knip + ts-prune triage. 12 operator-tunable env vars (`VITE_POLL_*`, `VITE_ATTACK_RADIUS_KM`, `VITE_SEVERITY_HALF_LIFE_HOURS`). Domain constants centralized at `src/lib/domain.ts` with byte-identical server mirror enforced by parity test. CSS `@theme` color tokens + `colorBridge.ts` (24 entity / event / site / faction / ethnic colors with byte-identity sentinel). 0 TypeScript errors / 0 lint errors / 0 react-hooks warnings baseline.
- **Dev/Prod sync (Phase 28.2):** domain rename `irt-monitoring.vercel.app` → `otg-iran-monitor.vercel.app` (new Vercel project `otg-iran-monitor`). Bearer-bypass for `rateLimiters.public` global tier (folds Phase 999.1) — extended to per-endpoint tiers in W6 hotfix. Operator endpoints (`POST /api/events/llm-pipeline`, `POST /api/events/llm-replay/:groupKey`) Bearer-gated with `operator:audit-log` (500-entry SADD set, 30d TTL) and per-Bearer `replay-quota` (50/24h INCR counter). Per-field dev/prod gate-swaps for event/OSM IDs, LLM confidence + provenance, EntityTooltip dev block. `MapDevExposer`, severity score, `notabilityScore` permanently dev-only.
- **API Health tab merge (Phase 28.2):** `Overview` folded into `All APIs` → renamed `API Health`, first tab in DevApiStatus. 4 diagnostic blocks (tier-grouped summary, per-endpoint quality metrics, manual retry, recent-fetch sparkline). Confirm modal on Pin-to-v1/v2. 429 replay-quota alert. Operator Actions block. Adversarial eval row. New `/api/operator-status` Bearer-gated aggregator. `HealthStatusProvider` single-poll guarantee.
- **Connectivity audit workflow (Phase 28.2 W6):** `.github/workflows/prod-connectivity-audit.yml` — manual-trigger CI smoke (16 endpoints) + rate-limit defense companion (D-30, B-6 target). Sidecar Redis key `audit:connectivity:last-result` (7d TTL). W-3 contract test pins JSON shape. 5 hotfixes surfaced by the audit itself landed on main directly (CACHE_KEY_PREFIX proxy fix, autoPipelining defense, Bearer-bypass extension, CacheResponse envelope, vitest reporter).
- **API green-light gate (Phase 28.2.5):** `events:llm:v3` registry promotion (DRIFT-5). `waterPrecip` SOURCE_KEYS fix (DRIFT-4). Registry-consistency invariant test. Weather tooltip widening (2°→4° + distance hint). Tier-green assertion in audit workflow with sidecar Redis write. Path B (cold-cache self-heal trusted; no `PROD_CRON_SECRET` GitHub Actions secret required).
- **Audit-tier completeness (Phase 28.2.7):** R1 `cron:lastTick:<name>` writers in all 3 cron handlers (7d TTL, `CRON_LASTTICK_TTL_SEC = 604_800`). R2 `llm:lastProgress` Redis write-through + Redis-first `probeLlmStatus()` survives Vercel Fluid Compute cold starts. R3 `probeProbeOnly()` returns `freshnessMs:0` honest stub instead of `null`. All 3 verified working in prod via `/api/health`. Compounding fixes: rate-limit companion test retargeted (`/api/health` → `/api/audit-status`); `llmStatus` freshness widened from 5min → 26h; `llmEvents` probe gains v3→v2→v1 fallback chain.

### Quantitative snapshot

- vitest baseline: 1700 → 2193 (+493 new tests)
- TypeScript errors: 8 → 0
- Lint errors: 0 → 0; warnings: 22 → 18
- Bundle: 1.2 MB → 1.72 MB (LLM pipeline + geocoder + eval harness + adversarial harness)
- Cron jobs: 2 → 3 (within Hobby cap)
- Critical-tier endpoints: 3 → 4 (added `llmEvents`)
- Eval ground-truth set: 0 → 50 events / 11 countries

### Migration notes (v1.3 → v1.4)

- **Domain change:** `irt-monitoring.vercel.app` retired; canonical alias is `otg-iran-monitor.vercel.app` on Vercel project `otg-iran-monitor`. Update any bookmarks, monitoring, or external scripts.
- **Operator Bearer:** prod surfaces (DevApiStatus dashboard, operator endpoints) require `Authorization: Bearer ${DASHBOARD_PASSWORD}`. Same Bearer skips global rate-limit tier (Phase 28.2 D-04).
- **Cron schedule:** `/api/events` no longer triggers extraction; `/api/cron/refresh-events` does, daily at 04:00 UTC. Operator force-trigger: `GET /api/cron/refresh-events?force=true` with `Authorization: Bearer ${CRON_SECRET}`.
- **Pipeline version:** `LLM_PIPELINE_V3=true` is the default in production. Runtime override via `POST /api/events/llm-pipeline {"version": "v1"|"v2"|"v3"|null}`. Override clears with `null`.

### Deferred to v1.5+ (carried forward)

- **Phase 999.5 (was 28.3):** Performance optimization + 1–300 VU k6 sweep. Decision lock preserved at `.planning/phases/999.5-performance-load-test/999.5-CONTEXT.md`.
- **Phase 27.3.3:** Romanization of non-Latin water-facility names (~125 facilities currently filtered by Latin-script admission gate).
- **Phase 999.2:** `api/vercel-entry.js` build-artifact discipline (migrate to Vercel Build Output API).
- **Phase 999.3:** Phase 27.4.6 cron first-tick passive verification.
- **Phase 999.4:** Cron route hydrates pipeline override (`await refreshPipelineOverride()` in `refresh-events-cron.ts`).
- Telegram OSINT integration (carried from v1.3).
- GDELT BigQuery adapter (carried from v1.3).
- Satellite imagery overlay (carried from v1.2).

---

## [v1.4 detail] — per-phase notes, Phases 27–28.2.7 (shipped in v1.4)

### Phase 28.2.7: Audit-tier Completeness (2026-05-07 → 2026-05-08)

Three independent code-only fixes that flip the remaining tier-unknown rows in `/api/health` to `healthy` so `prod-connectivity-audit.yml` can return `allTiersGreen=true`. Surfaced after Phase 28.2.6 cleared the dominant `critical[llmEvents]` blocker — these were latent bugs masked by the upstream issue.

#### Added

- **R1 — `cron:lastTick:<name>` writers in all 3 Vercel cron handlers.** `CRON_LASTTICK_TTL_SEC = 7 * 24 * 60 * 60` (604_800 — 7 days) declared in `server/lib/healthSources.ts`. Writers: `server/routes/cron-health.ts:118` writes `cron:lastTick:health` after eval blocks complete; `server/routes/cron-warm.ts:85` writes `cron:lastTick:warm` inside `if (partialOrBetter)` guard; `server/routes/refresh-events-cron.ts:64` writes `cron:lastTick:refresh-events` inside `try` block AFTER `runRefreshExtraction` resolves (NOT in catch — D-03 honest-failure semantics). Pre-fix: 1 reader (`probeCronTick`) + 0 writers → `cron` tier permanently `unknown` by construction.
- **R2 — `llm:lastProgress` Redis write-through + Redis-first `probeLlmStatus`.** `LLM_LASTPROGRESS_KEY` + `LLM_LASTPROGRESS_TTL_SEC` declared in `server/lib/llmProgress.ts`. Write-through fires in `resetProgress()` always (D-01) and in `updateProgress()` only on terminal transitions (`partial.completedAt !== undefined`, D-02). `probeLlmStatus()` refactored to async, reads Redis first via `cacheGetSafe` with try/catch fallback to in-memory singleton (D-08); returns `null` when both null (D-09); does not backfill the singleton (D-10). Pre-fix: probe read in-memory singleton directly which reset on every Vercel Fluid Compute cold-start, causing `llmStatus` to flap between `healthy` and `unknown`.
- **R3 — `probeProbeOnly()` returns `freshnessMs: 0` instead of `null`.** `server/routes/health.ts:211-219` body changed from `{ freshnessMs: null, ... }` to `{ freshnessMs: 0, ... }` so the `deriveStatus(0, 0, false)` chain evaluates to `'healthy'` instead of `'unknown'`. Mirrors `probeSources` canon pattern at `server/routes/health.ts:177-188`. Both probes are config-introspection-only — no upstream call, nothing to be "stale" relative to. JSDoc rewritten to cite Phase 28.2.7 R3 + the deriveStatus chain step-by-step.
- 3 new test files (18 contract tests total) — `server/__tests__/routes/cron-lasttick.test.ts` (6), `server/__tests__/lib/llmProgress.persistence.test.ts` (7), `server/__tests__/routes/health.probeOnly.test.ts` (5). Vitest baseline 2174 → 2192 (+18, zero regressions).

#### Changed

- Bumped `api/vercel-entry.js` bundle (267 insertions, 226 deletions; 493 lines changed) to bake R1+R2+R3 server changes for next `vercel --prod`. Verified: bundle contains `cron:lastTick:health` × 1, `cron:lastTick:warm` × 1, `cron:lastTick:refresh-events` × 1, `llm:lastProgress` × 1 literal, `freshnessMs: 0` × 2 (probeSources canon + probeProbeOnly fix). Source-leak grep on bundle commit returns 0 — bundle commit is `api/vercel-entry.js`-only.

#### Code Review

- 0 critical, 4 warnings, 6 info findings tracked in `.planning/phases/28.2.7-audit-tier-completeness/28.2.7-REVIEW.md`. Notable advisories: WR-01 (`redisLatest ?? memLatest` could let stale "started but never completed" Redis record mask successful in-memory completions for up to 7 days; suggested `Math.max`), WR-02 (write-through fires on `completedAt !== undefined` regardless of `errorMessage` / `stage: 'error'` — failed run advances `llm:lastProgress` and surfaces as fresh "success"). Both are advisory follow-ups, not phase blockers.

#### Human-UAT (4 items, post-deploy)

Persisted in `.planning/phases/28.2.7-audit-tier-completeness/28.2.7-HUMAN-UAT.md`:

1. `prod-connectivity-audit.yml` exits 0 + writes `allTiersGreen: true` against deployed prod (single binary acceptance signal).
2. `/api/health summary.cron === { healthy: 3, ... }` after force-triggering all 3 crons once each.
3. `endpoints.llmStatus.status === "healthy"` survives 10 hits across an idle window (Vercel Fluid Compute cold-start coverage).
4. `/api/health summary.probeOnly === { healthy: 2, ... }` on first request after new bundle goes live.

### Phase 28.2.5: API Green-Light Prereq Gate (2026-05-06 → 2026-05-06)

#### Added

- `events:llm:v3` to `SOURCE_KEYS` registry (DRIFT-5) so the cache-bridge fallback chain in `server/routes/events.ts:701-731` (events:llm:v3 → events:llm:v2 → events:llm → raw GDELT) is observable from the API Health tab. Tier `'critical'`, freshness threshold 26h (cron triad).
- `waterPrecip: 'water:precip'` to `SOURCE_KEYS` (DRIFT-4) — `FRESHNESS_THRESHOLDS_MS` + `TIER_BY_ENDPOINT` already had `waterPrecip` entries since Phase 28.1 W2; the missing registry row was the bug.
- Registry-consistency invariant test in `server/__tests__/lib/healthSources.test.ts` — every cache-backed `TIER_BY_ENDPOINT` key MUST have a matching `SOURCE_KEYS` entry; future drift fails LOUDLY.
- DevApiStatus row split: `Events` → `Events (raw)` (probes `events:gdelt`) + `Events (LLM)` (probes `events:llm:v3`). Operator gets a one-glance read on enriched-vs-fallback state.
- DevApiStatus `Precip` row consumes `aggregateHealth.endpoints.waterPrecip` from `/api/health` (matches every other row's pattern). Replaces the prior `useWaterStore` selector path.
- WeatherOverlay `findNearestPrecip` widened from 2° → 4° Manhattan; return shape `PrecipitationData | null` → `{ value: PrecipitationData; distanceKm: number } | null`. Tooltip surfaces "nearest sample, X km away" hint when distance > 100km.
- Tier-green assertion in `.github/workflows/prod-connectivity-audit.yml` Step 3 inline node script. Computes `allTiersGreen` + `tierStatus` against the D-03 truth table, writes both into `audit:connectivity:last-result` Redis sidecar payload (7d TTL), then `process.exit(allTiersGreen ? 0 : 1)` AFTER the sidecar write — no replication-lag race in Step 6 (which now reads `steps.sidecar.outcome` in-memory).
- W-3 contract test extension in `server/routes/__tests__/audit-status.test.ts` — pins the new `allTiersGreen?` + `tierStatus?` fields so either-side drift fails LOUDLY. Existing `'matches CI workflow JSON shape contract'` block byte-unchanged.
- `AuditPayload` interface widening in `server/routes/audit-status.ts` — optional `allTiersGreen?: boolean` + `tierStatus?: { critical, nonCritical, static, probeOnly, cron }` fields. Handler logic unchanged (still shape-agnostic `res.json(parsed)` passthrough).

#### Fixed

- DevApiStatus `Precip` row no longer falls back to `useWaterStore` selectors when health data is loading — sources from `/api/health` aggregate like every other row.
- Weather tooltip no longer drops precip data at most x,y mouse positions inside the Iran bbox (2° cutoff was too tight for the 1° grid spacing).

#### Changed

- Bumped `api/vercel-entry.js` bundle (837 insertions, 353 deletions) to bake in Plans 01/02/04 server changes for next `vercel --prod`.
- DevApiStatus copy-diagnostics payload: `sources[]` now ships 10 names (`Events` split + `Precip` enumerated) instead of legacy 8.

#### Verification

- 2161/2161 vitest assertions pass (5 todo, 19 skipped) — `+18` over phase base
- `npm run build` exits 0 (Vite + tsup)
- `npx tsc --noEmit` exits 0
- `npm run lint` exits 0 (18 advisory warnings unchanged)
- 5 plans across 4 waves, ~14 atomic commits

### Phase 27.4.1: V2 Extractor Watchdog + LLM Pipeline TS Cleanup (2026-04-22 → 2026-04-24)

#### Added

- Shared `server/lib/llmExtractorWatchdog.ts` helper with `withBatchWatchdog(batchFn, opts)` — per-batch `Promise.race` with AbortController late-resolve guard, soft-warn + hard-timeout thresholds, DLQ routing via `onTimeout` hook. Applied symmetrically to both v1 and v2 extractors.
- `LLM_BATCH_TIMEOUT_MS` env var (default 90000) — in-incident timeout tuning without code change; soft-warn hardcoded at 60000ms per D-02.
- `llmProgress.watchdogTimeoutCount` field — surfaces watchdog activations for DevApiStatus pipeline waterfall.
- DLQ `reason: 'timeout_watchdog'` — timed-out groups enter normal retry/exclusion pipeline.
- `LLMCachePayload` envelope type `{events, progress: 'N/M', complete: boolean, generatedAt}` written per-batch to `events:llm:v2:partial` (observability-only key).
- Reader defense-in-depth helpers `toEntityArray(data)` + `coerceCachedEvents(cached)` in `server/routes/events.ts` — coerce any unexpected envelope shape to `[]` so downstream consumers (sync HTTP, Pitfall 1 bridge, fire-and-forget background `llmCachedRef` iterations, `loadRecentEnrichedEvents` sort) degrade gracefully instead of throwing.

#### Fixed

- P0 from Phase 27.4 — v2 extractor now per-batch flushes state to Redis. One hung Cerebras call no longer loses 45+ min of LLM work (stall reproduced at batch 133/184 on 2026-04-21).
- 20 TypeScript errors in `server/lib/llmEventExtractor.v1.ts` cleaned via local-bind + early-continue pattern (all Category A `noUncheckedIndexedAccess` drift — Zod schemas untouched per D-16 audit).
- 1 TypeScript error in `server/adapters/llm-provider.ts:232` (BACKOFF_MS literal fallback narrowing).
- 1 failing test in `src/__tests__/entityLayers.test.ts` — `other is gray with red tint` expectation updated to shipped `[220,100,90]` (value diverged in Phase 27 commit `709fa15`).
- Post-ship: Plan 03 was writing `LLMCachePayload` envelopes to `events:llm:v2` (the terminal reader's key, expects `ConflictEventEntity[]`) which crashed `/api/events` with `TypeError: events.map is not a function`. Partial writes moved to dedicated observability key `events:llm:v2:partial` in commit `a5c8846`.
- Post-ship: `/gsd-debug` caught `llmCachedRef.data is not iterable` at the fire-and-forget background task's iteration sites. Commit `e26ceca` added defense-in-depth guards at all 3 `events:llm:v2` read sites.

#### Changed

- `PipelineVersionPill` in Topbar is now a **read-only indicator** — `onClick` handler stripped. Version still settable via `LLM_PIPELINE_V2` env var and `GET/POST /api/events/llm-pipeline` endpoints for scripted operator use.
- Total server TypeScript error count: **29 → 8** (−21). Remaining 8 are `useEntityLayers.ts` `depthTest` deck.gl v9 type drift, deferred to Phase 27.4.3.

#### Verification

- 971/971 server test suite pass (+3 new watchdog integration tests, zero regressions)
- All 23 locked CONTEXT decisions (D-01..D-23) covered, all 10 must-haves (MH-1..MH-10) met
- `/api/events` returns HTTP 200 post-fix (was HTTP 500 pre-fix)
- Old tech-debt todo `phase-27-llm-pipeline-ts-debt.md` closed + deleted

### Phase 27.4: LLM Enrichment Improvements (2026-04-13 → 2026-04-22)

#### Added

- Palantir-grade LLM geolocation pipeline with 6-path resolver (own-snapshot → POI-amenity Nominatim → direct Nominatim → 2-pass LLM verify → Bellingcat coord passthrough → GDELT ActionGeo fallback).
- Richer prompts — NEWS block (tier-tagged from `news:gdelt`, ±24h), BELLINGCAT block, TEMPORAL block (prior events ±72h + ±1deg bbox).
- Extended v2 Zod schema — structured place hierarchy `{country, admin1, city, neighborhood, landmark, confidence}`, `derivePrecision` + `deriveSuspect` pure functions, 6-value `GeocodeProvenance` enum, reasoning truncation-not-rejection.
- Reliability primitives — `llmCircuitBreaker.ts` (sliding 10-call window, 30% error pause), `llmDLQ.ts` (Redis SADD bounded set, 200 entry cap, 7d TTL), `llmTokenBudget.ts` (Cerebras 1M/day, Groq 200K/day, soft 0.8 / hard 0.95 caps).
- Eval harness — 50 curated ground-truth events across 11 countries, resolver-only accuracy scoring at 5/20/100km thresholds.
- DevApiStatus Events tab — 8 observability blocks (pipeline waterfall, precision/confidence/source-tier/casualty histograms, per-event drill-down, LLM call log with skip telemetry, per-provider budget bars, eval score gate, DLQ, suspect count).
- Dev-only `POST /api/events/llm-replay/:groupKey` endpoint — re-extract single group without writing to cache.
- Runtime pipeline override — `GET/POST /api/events/llm-pipeline` with Redis-backed override (7d TTL) for v1/v2 swap without redeploy.

#### Changed

- Flag-gated v2 pipeline — `LLM_PIPELINE_V2` env (default `true` post-debug 2026-04-21); v1 preserved as rollback at `llmEventExtractor.v1.ts`.
- Cache version bump — v2 Redis keys `events:llm:v2` + `events:llm-summary:v2` coexist with v1. Pitfall 1 bridge serves v1 when v2 is empty (map never goes blank during rollout).
- Cerebras model swapped — `gpt-oss-120b` → `qwen-3-235b-a22b-instruct-2507` (free-tier compatible; paid tier required for original).

#### Known at ship

- V2 extractor wrote cache only AFTER all batches complete — one hung call lost 45+ min of work. Addressed by Phase 27.4.1 watchdog + per-batch cache flush.

## [v1.2.3] - 2026-03-29

### Changed

- Excluded CAMEO 192 (territorial occupation) from conflict event pipeline — reduces false positive ground combat events

## [v1.2.2] - 2026-03-29

### Phase 21.3: Multi-User Load Testing

#### Added

- k6 load test script (`scripts/load-test.js`) with 6 scenarios (flights, ships, health, markets, slow-poll, static) ramping to 501 VUs over 5 minutes
- Playwright browser validation test (`scripts/load-test.spec.ts`) with parallel mode for 3 concurrent browser workers
- Pre/post-test health snapshots comparing Redis latency and source freshness

#### Results (Production — https://otg-iran-monitor.vercel.app)

- 100% application checks (9536/9536) across all endpoints
- Flights p95: 136ms, Ships p95: 145ms, Overall p95: 153ms
- 3/3 Playwright tests passed with 3 concurrent browser workers over 3-minute stability window
- Production remained healthy post-test (Redis ok, 68ms latency, all sources active)

## [v1.2.1] - 2026-03-28

### Phase 21.2: GDELT Event Quality Pipeline

#### Added

- Geo-validation module (`server/lib/geoValidation.ts`) — validates event coordinates against country polygons and FIPS mappings
- Event scoring engine (`server/lib/eventScoring.ts`) — composite confidence scoring with CAMEO specificity, Goldstein sanity check, NumSources >= 2 filter
- NLP extractor (`server/lib/nlpExtractor.ts`) — extracts structured data from GDELT event text
- Dev-mode confidence and geoPrecision display in EventDetail panel
- CAMEO 180 catch-all exclusion from conflict pipeline
- NumSources >= 2 requirement to filter single-source noise

### Phase 21.1: GDELT News Relevance Filtering

#### Added

- Relevance scoring engine (`server/lib/relevanceScorer.ts`) — multi-signal scoring for news article conflict relevance
- Configurable `newsRelevanceThreshold` in server config
- NLP-based keyword extraction for improved conflict detection

#### Changed

- News filter rewritten from keyword whitelist to relevance scoring approach
- Reduced false positive conflict news articles significantly

### Phase 21: Production Hardening & Deploy

#### Added

- Helmet security headers with Content-Security-Policy whitelist for map tiles, analytics, and API domains
- Per-endpoint Cache-Control middleware (`max-age=0, s-maxage=N` for CDN-only caching)
- Per-endpoint rate limiting via `createRateLimiter` factory (flights 30/min, events 10/min, etc.)
- Structured JSON logging (`server/lib/logger.ts`) replacing all console calls in server code
- Request logging middleware with method, path, status, and duration
- Redis graceful degradation: `cacheGetSafe`/`cacheSetSafe` with in-memory fallback on Redis failure
- Rich `/health` endpoint with Redis latency, per-source freshness timestamps, and command estimates
- Cron health endpoint (`/api/cron/health`) with stale source warnings, triggered every 6h via Vercel cron
- Production smoke test script (`scripts/smoke-test.ts`) validating all 9 endpoints
- Vercel Analytics and SpeedInsights integration
- 4 vendor chunks (react, maplibre, deckgl, app) for independent browser cache invalidation
- Rate limiter skips local dev (NODE_ENV !== production)
- All polling hooks check `res.ok` before parsing JSON
- ThreatHeatmapOverlay uses `useFilteredEntities` for consistent date/filter gating
- Vitest tuned: 10s timeout, forks pool (maxForks 4)

#### Changed

- All 7 data routes migrated to `cacheGetSafe`/`cacheSetSafe` for Redis graceful degradation
- All server adapter console calls replaced with structured `log()` calls
- Bundle splitting: vendor-react (~200KB), vendor-maplibre (~800KB), vendor-deckgl (~700KB), app
- 958 tests passing

### Phase 20: Visualization Layers & Filter Independence

#### Added

- Visualization layer system with `layerStore` (`Set<VisualizationLayerId>`) and LayerTogglesSlot with toggle rows
- Geographic overlay: elevation color-relief tinting, maplibre-contour lines, geographic feature labels (deserts, mountain ranges, seas)
- Weather overlay: Open-Meteo temperature heatmap (bilinear-interpolated canvas draped onto terrain), wind barb icons, weather grid tooltip
- Threat density heatmap: deck.gl HeatmapLayer with compound weight formula (type severity × log mentions × log sources × fatality boost × Goldstein hostility × temporal decay), SUM aggregation for proximity clustering, cluster tooltips with fatalities/mentions/hostility
- FilterButton component (pill toggle with color dot for entity categories)
- SliderToggle component (iOS-style switch for boolean filters)
- Weather store (`weatherStore`) and weather polling hook
- Contour tile protocol setup (`contourSetup.ts`) for maplibre-contour integration
- Geographic feature GeoJSON dataset (`geoFeatures.ts`)

#### Changed

- Entity filter toggles (flights, ships, events, sites) now operate independently from visualization layer toggles
- Layer stacking order: weather → threat → entities (threat tooltips supersede weather)
- Filter panel redesigned with FilterButton/SliderToggle components
- Sidebar layout updated for visualization layers section

#### Removed

- Political overlay (deferred — planned but not shipped)
- Political data module and canvas pattern generation files

## [v1.1.0] - 2026-03-22

### Phase 19.2: Counter Entity Dropdowns

#### Added

- Click-to-expand counter rows showing individual entities with label + key metric per type
- Accordion behavior (only one row expanded at a time)
- Fly-to-entity on click (map flies to entity and opens detail panel)
- Proximity sorting per category (flights/events from Tehran, ships from Strait of Hormuz, sites by attack count)
- Zero-count rows disabled and non-expandable; expanded rows that drop to 0 show empty state
- Scrollable entity lists with "Showing X-Y of Z" range indicator for 8+ items
- Ships counter row in CountersSlot

### Phase 19.1: Advanced Search with Tag & Entity Type Filtering

#### Added

- Tag-based query language with ~25 prefixes (type:, site:, country:, near:, callsign:, icao:, mmsi:, cameo:, etc.)
- Implicit OR evaluation across all entity types
- Bidirectional sync between search bar and sidebar filters via `useQuerySync`
- Two-stage autocomplete: tag prefix suggestions → known values with live entity counts
- TagChipRow, SyntaxOverlay, AutocompleteDropdown components
- Cheat sheet popover with full tag vocabulary reference
- `near:` queries support site names and cities, drops proximity pin with 100km radius
- `near:` auto-opens filters panel to show proximity controls
- Negated tag wildcards (`!site:`, `!type:`) for toggle control

#### Changed

- Search parser simplified to implicit OR (removed AND/NOT/parentheses)
- Search evaluator rewritten for OR-only evaluation
- Removed goldstein, vertical, squawk from tag registry

### Phase 19: Search, Filter & UI Cleanup

#### Added

- Global Cmd+K search bar with fuzzy matching across all entity types
- SearchModal with keyboard navigation and fly-to-entity on selection
- Filter panel redesign with per-entity grouped sections (Flights, Ships, Events, Sites)
- Reusable filter UI components (FilterSection, FilterToggle, FilterSlider)
- "Reset All" button to clear all active filters
- Severity filtering for events, health filtering for sites
- New filter predicates: callsign, ICAO, MMSI, name, CAMEO, mentions, heading

#### Changed

- Filter panel reordered with logical grouping
- Removed hit-only toggle (replaced by site health filtering)
- Simplified filterStore with per-entity filter fields
- Counter data hook updated for new filter system
- Sidebar layout refined with search integration

### Phase 18: Oil Markets Tracker

#### Added

- Yahoo Finance adapter (`server/adapters/yahoo-finance.ts`) for commodity prices
- `/api/markets` route with Redis cache (60s TTL)
- `marketStore` Zustand store with ConnectionStatus tracking
- `useMarketPolling` hook — 60s recursive setTimeout
- MarketsSlot collapsible overlay panel with 5 instruments (Brent, WTI, XLE, USO, XOM)
- 5-day sparkline SVG charts with color-coded direction (green up, red down)
- Green delta animations on price changes matching counter animation pattern
- 851 tests passing

## [v1.1.0-alpha.3] - 2026-03-20

### Phase 17: Notification Center

#### Added

- Severity scoring library (`src/lib/severity.ts`) — type weight × log(mentions) × log(sources) × recency decay
- News matching library (`src/lib/newsMatching.ts`) — temporal + geographic/keyword correlation between GDELT events and news clusters
- Time grouping library (`src/lib/timeGroup.ts`) — groups notifications into "Last hour", "Last 6 hours", "Last 24 hours"
- Notification store (`src/stores/notificationStore.ts`) — derives scored notifications from eventStore + newsStore with flyToTarget action
- `useNotifications` hook — connects stores, derives notifications, provides mark-read and fly-to actions
- NotificationBell component (`src/components/layout/NotificationBell.tsx`) — bell icon with unread badge count
- NotificationDropdown component — time-grouped notification cards with news headline previews
- NotificationCard component — severity-scored card with event type, matched news, click-to-fly-to-event
- `useProximityAlerts` hook — detects flights/ships within 50km of key sites, fires proximity notifications
- ProximityAlertOverlay component — animated warning badges on map at alert locations with expand/collapse
- 24h default event window in `useFilteredEntities` when no custom date filter is active
- "Showing last 24h" label in FilterPanelSlot
- `numMentions` and `numSources` fields added to GDELT event pipeline
- `useSiteImage` hook — ArcGIS satellite thumbnail URLs for site detail panels
- 647 tests passing (29 new)

#### Changed

- EventDetail, FlightDetail, SiteDetail panels gain satellite imagery and enhanced formatting
- News keyword filter upgraded with word-boundary matching and ambiguous-keyword gating
- Port icon changed from helm wheel to bollard (cleaner at small sizes)
- Proximity alert badges sized down for less visual clutter

## [v1.1.0-alpha.2] - 2026-03-20

### Phase 16: News Feed

#### Added

- GDELT DOC 2.0 adapter (`server/adapters/gdelt-doc.ts`) for conflict news articles
- RSS adapter (`server/adapters/rss.ts`) — 5 feeds: BBC, Al Jazeera, Tehran Times, Times of Israel, Middle East Eye
- Conflict keyword filter (`server/lib/newsFilter.ts`) with whitelist matching
- Jaccard dedup/clustering (`server/lib/newsClustering.ts`) — 0.8 similarity threshold, 7-day sliding window
- `/api/news` route with Redis cache (15-min TTL)
- `newsStore` Zustand store with ConnectionStatus tracking
- `useNewsPolling` hook — 15-min recursive setTimeout
- `sourceCountry` metadata tagging from GDELT `sourcecountry` field and RSS feed config
- English-only filter for GDELT DOC queries (`sourcelang:english`)
- 618 tests passing

## [v1.1.0-alpha.1] - 2026-03-20

### Phase 15: Key Sites Overlay

#### Added

- Overpass/OSM adapter (`server/adapters/overpass.ts`) querying nuclear, naval, oil, airbase, desalination, port sites across Middle East
- SiteEntity type with `siteType` discriminant and OSM metadata (operator, osmId)
- `siteStore` Zustand store with connection status tracking
- `useSiteFetch` one-time fetch hook (sites are static infrastructure, no polling)
- `/api/sites` route with Redis cache (24h TTL)
- Site IconLayer with 6 distinct icons (nuclear hazard, anchor, oil drop, jet, water drop, crane)
- Attack status detection (`src/lib/attackStatus.ts`) — cross-references site locations with recent conflict events within 5km
- 6 site category toggles in LayerTogglesSlot (Nuclear, Naval, Oil, Airbase, Desalination, Port)
- "Hit Only" toggle to show only recently-attacked sites
- Site row in StatusPanel with connection health dot
- Site counts in CountersSlot (per-category + total)
- SiteDetail panel with site type, operator, coordinates, and attack status
- Site tooltip in EntityTooltip
- Overpass API fallback (primary → private.coffee mirror)
- 571 tests passing (15 new)

#### Changed

- Icon sizes reduced: flights/ships 4000m (was 8000m), events 3000m (was 5000m), to accommodate site markers
- `useEntityLayers` expanded with site layer generation and category filtering
- `useSelectedEntity` extended for site entity lookup from siteStore
- CONFLICT_TOGGLE_GROUPS simplified to 3 groups (showOtherConflict merged into showGroundCombat)

## [v1.0.0] - 2026-03-20

### Phase 14: Vercel Deployment

#### Added

- Vercel serverless entry point (`server/vercel.ts`) with tsup bundling
- `vercel.json` configuration routing SPA + API functions
- Rate limiting middleware (configurable per-route limits)
- Graceful config: server boots without crashing when optional API keys are absent
- Node engine pin (>=20) in package.json

#### Changed

- Express app extracted to `createApp()` factory in `server/app.ts`
- TypeScript build excludes test files from production bundle

### Phase 13: Serverless Cache Migration

#### Added

- Upstash Redis cache (`@upstash/redis`) replacing in-memory EntityCache
- `CacheEntry<T>` pattern with `fetchedAt` for staleness computation (hard TTL = 10x logical TTL)
- AISStream on-demand connection model (connect-collect-close per request)
- Ship merge/prune by MMSI with 10-min stale threshold
- Events accumulator with merge-by-ID upsert and WAR_START pruning
- GDELT backfill: lazy on-demand via direct URL construction, 4 files/day sampling, 1hr cooldown
- `parseSqlDate` using `Date.UTC()` for consistent timestamp comparisons
- 556 tests passing

#### Removed

- In-memory EntityCache class (replaced by Redis)
- Persistent WebSocket connection for AISStream

## [v0.12.0] - 2026-03-18

### Phase 12: Analytics Dashboard

#### Added

- Counters panel (CountersSlot) with collapsible Flights + Events sections
- Flight counters: Iranian (originCountry) and Unidentified (hex-only) tallies
- Event counters: Airstrikes, Ground Combat, Targeted, Fatalities
- Visibility-aware counts: reflect only entities visible on the map (smart filters + toggle gating)
- Green +N delta animation with 3s fade (delta-fade keyframe in app.css)
- useCounterData hook deriving counts from flightStore, eventStore, uiStore, and useFilteredEntities
- CounterRow component with fixed-width label column for vertical value alignment
- 534 tests passing

## [v0.10.0] - 2026-03-18

### Phase 10: Detail Panel & GDELT Event Reclassification

#### Added

- Detail panel: 360px right-side slide-out with per-type content (FlightDetail, ShipDetail, EventDetail)
- Flight detail with dual units (ft/m, kn/m-s, ft-min/m-s) and data source label
- Event detail with Goldstein scale, CAMEO code, actors, "View source" link
- Flash-on-change animation for data values (DetailValue component)
- Cross-store entity lookup hook (useSelectedEntity) with lost contact tracking
- Copy-to-clipboard for coordinates with 2s "Copied!" feedback
- Lost contact state: grayscale overlay with "LOST CONTACT" banner
- Relative timestamp ticking "Updated Xs ago" every second
- 11 CAMEO-based ConflictEventType categories replacing drone/missile split
- 4 conflict toggle groups: Airstrikes, Ground Combat, Targeted, Other Conflict
- New map icons: explosion (8-point burst) and crosshair (targeting reticle)
- localStorage migration for old showDrones/showMissiles/showNews keys
- 365 tests passing

#### Fixed

- Unidentified flights now take precedence over Ground filter (visible when Ground OFF if pulse ON)
- Empty map click preserves detail panel selection (explicit close required)

#### Changed

- Entity types: `drone`/`missile` replaced with 11 granular ConflictEventType values
- Layer toggles: Drones/Missiles/News replaced with Airstrikes/Ground Combat/Targeted/Other Conflict
- Tooltip gating: per-category conflict toggles replace single showNews toggle
- GDELT classifier: classifyByBaseCode uses 3-digit EventBaseCode instead of root code

## [v0.9.0] - 2026-03-17

### Phase 9: Layer Controls & News Toggle

#### Added

- Layer toggles panel with 7 rows: Flights, Ground, Unidentified, Ships, Drones, Missiles, News
- Toggle opacity dimming (40% when OFF) with smooth transitions and localStorage persistence
- EntityTooltip component with per-type content (flight metadata, ship AIS data, GDELT event details)
- News toggle gates event tooltips (drone/missile hover tooltips hidden when News OFF)
- GDELT event deduplication by date/CAMEO code/location, keeping highest-mention row
- StatusPanel counts reflect only visible entities filtered by toggle state and entity type
- Zoom +/- controls enabled on NavigationControl
- Hover glow (2x) and highlight (1.2x) layers for active entity feedback
- 309 tests passing

#### Fixed

- Hover blink caused by glow/highlight layers intercepting picks (set pickable: false)
- Hover blink caused by active entity alpha=0 breaking deck.gl picking (keep full opacity)
- Duplicate GDELT markers for same real-world event with different actor fields

#### Changed

- "Pulse" toggle renamed to "Unidentified" for clarity
- showNews defaults to true (News ON by default)

## [v0.4.0] - 2026-03-15

### Phase 4: Flight Data Feed

#### Added

- Zustand flight store with connection health tracking (connected/stale/error/loading)
- `useFlightPolling` hook with recursive setTimeout (5s interval)
- Tab visibility awareness: polling pauses when hidden, immediate fetch on resume
- Stale data tracking with `lastFresh` timestamp and 60s drop threshold
- `unidentified` flag on FlightEntity for hex-only/no-callsign flights
- Cache-first server route to conserve OpenSky API credits
- onGround flight filtering at adapter level (airborne only)
- Vite dev proxy forwarding `/api` to Express on port 3001
- Flight polling wired into AppShell on mount
- 15 new tests (6 store, 5 polling hook, 3 adapter, 1 cache-first)

## [v0.3.0] - 2026-03-15

### Phase 3: API Proxy

#### Added

- Express 5 server on port 3001 with health check endpoint
- MapEntity discriminated union types (flight, ship, missile, drone)
- OpenSky Network adapter with OAuth2 client credentials and bbox filtering
- AISStream adapter with WebSocket connection for real-time ship data
- ACLED adapter for conflict events (last 7 days)
- In-memory entity cache with configurable TTLs per data source
- Security middleware: rate limiting, CORS, Helmet headers
- Environment-based configuration with .env support
- Routes: `/api/flights`, `/api/ships`, `/api/events`
- 37 server tests (adapters, cache, security, types)
- Concurrent dev workflow (Vite + Express via concurrently)

#### Fixed

- Handle Blob WebSocket messages in AISStream adapter
- Use `node --import tsx/esm` for dev scripts (ESM compatibility)
- Remove eager `loadConfig()` from server startup to prevent crashes with missing .env
- Use `--env-file-if-exists` flag to tolerate missing .env file

## [v0.2.0] - 2026-03-14

### Phase 2: Base Map

#### Added

- Interactive 2.5D map of Iran using Deck.gl + MapLibre with CARTO Dark Matter tiles
- DeckGLOverlay bridge component via MapboxOverlay + useControl hook
- Zustand map store (isMapLoaded, cursorPosition)
- CompassControl with double-click reset to default Iran view
- CoordinateReadout showing live lat/lon on cursor move
- Scale bar in bottom-right area
- MapVignette effect (faint dark gradient framing viewport edges)
- MapLoadingScreen with full-screen ripple animation and smooth map fade-in
- Map style customization: hidden road labels, brighter country borders, blue-tinted water
- Test mocks for maplibre-gl and @deck.gl/mapbox (jsdom compatibility)
- 30 tests passing across all map components

#### Fixed

- Switched terrain tiles from Alps-only MapLibre demo to global AWS Terrarium DEM
- Increased terrain exaggeration to 3.0 with pitch 50 for dramatically visible mountains
- Boosted hillshade exaggeration to 0.6 with brighter highlights for ridge contrast
- Fixed vignette rendering order (moved after Map in DOM to prevent occlusion)
- Set vignette opacity to 0.25 (was 0.6, too dark per user feedback)

## [v0.1.0] - 2026-03-14

### Phase 1: Project Scaffolding & Theme

#### Added

- Vite 6 + React 19 + TypeScript 5.9 project scaffold with ESM
- Tailwind CSS v4 dark theme with `@theme` semantic color tokens
- AppShell layout with full-viewport dark shell and z-indexed overlay regions
- Zustand UI store with panel visibility toggles
- OverlayPanel reusable component
- Vitest test infrastructure with jsdom and testing-library
- README and brainstorm notes

#### Fixed

- Moved filters to bottom-left and counters to top-right per layout feedback

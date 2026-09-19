---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Final Hardening — 🚧 IN PROGRESS
current_phase: 47
current_phase_name: ~100-User Load Test
status: planning
stopped_at: Phase 46 complete; 2026-09 audit, docs overhaul and LLM pipeline recovery merged to main (2026-09-19)
last_updated: '2026-09-19T00:00:00.000Z'
last_activity: 2026-09-19
last_activity_desc: LLM pipeline recovered in production (retired NIM model replaced, checkpointed waves); docs and ADR-0012
progress:
  total_phases: 8
  completed_phases: 6
  total_plans: 20
  completed_plans: 20
  percent: 75
---

# Project State

This file was reset on 2026-09-17. The previous 553-line version (self-contradictory status fields plus ~240 lines of accumulated per-phase decisions) is at git tag `planning-archive-2026-09`: `git show planning-archive-2026-09:.planning/STATE.md`. Decisions that still matter were carried into `CLAUDE.md` (invariants), `docs/ARCHITECTURE.md` and `docs/OPERATIONS.md`.

## Project Reference

See: .planning/PROJECT.md

**Core value:** Surface actionable, data-backed intelligence on the Iran conflict in real time on an interactive 2.5D map — numbers over narratives.

## Current Position

Milestone: v2.0 Final Hardening
Phases 42–46: complete (2026-06-10 … 2026-06-22). Phase 49 (docs cleanup): delivered out of band on 2026-09-17.
Next roadmap phase: 47 (~100-User Load Test) — not planned, not started.
Last activity: 2026-09-19 — LLM pipeline recovered in production; before that 2026-09-17/18 — audit, outage fixes, docs overhaul.

**Before planning Phase 47, read `docs/AUDIT-2026-09.md`.** Production had flights down and the LLM pipeline empty for months. Both are fixed and deployed: the September fixes merged 2026-09-18, the pipeline recovery (`fix/nim-model-eol`, ADR-0012) on 2026-09-19. The audit's §6 lists what is left before a load test: honest health (L2), green CI, the events read path (L9).

## Branch `chore/overhaul-2026-09` (merged 2026-09-18)

Fixes:

- flights: explicit `User-Agent` for adsb.lol (it 403s Node's default)
- events: the refresh-events cron refreshes `events:gdelt` itself (shared `refreshRawEvents`, no backfill inside the cron); `/api/events` no longer refetches GDELT on every request when an LLM key is configured
- events: news context, corroboration and the Bellingcat boost read `news:feed` — the old `news:gdelt` key never had a writer
- rate limiting: one Redis prefix per tier (they shared a single per-IP counter); limiter degrades open on Upstash errors
- logging: redact Vercel OIDC token / proxy signature headers

Housekeeping: eval fixtures moved to `server/data/eval/`, CAMEO fixture to `src/__tests__/fixtures/`, snapshot scripts write to `.snapshots/`; planning history archived to the git tag; docs rewritten.

## Open Concerns

- The first cold extraction run after deploy will likely exceed the 800 s function limit and persist nothing (AUDIT L3). Watch the first 04:00 UTC run.
- CI on `main` is red on `npm audit` (1 critical: maplibre-gl). The CodeQL workflow is disabled for inactivity.
- Site/water snapshot JSON files are absent from the deployed function.
- `OPENROUTER_API_KEY` is set in the Vercel production env and is live in the geocode reranker path.

## Pending Todos

None tracked here. The backlog is `docs/AUDIT-2026-09.md` §3–§6.

## Session

Last session: 2026-09-17
Stopped at: audit + overhaul complete on branch; awaiting owner review, merge and deploy.

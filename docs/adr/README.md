# Architecture Decision Records

This directory contains the Architecture Decision Records (ADRs) for the
Iran Monitor. An ADR captures a single significant architectural
or technical decision — the context that motivated it, the decision
itself, and the consequences (positive, negative, and neutral) that
followed. The goal is not to document _every_ design choice, but to
preserve the reasoning behind the load-bearing ones so that future
maintainers (including future-me) can understand why the system looks
the way it does and what the alternatives were.

The format is the [Michael Nygard short template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) —
context, decision, consequences, alternatives, references. See
[`template.md`](./template.md) to copy for a new ADR.

## Index

| ADR                                                                        | Title                                                       | Status                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------- |
| [0001](./0001-upstash-redis-over-traditional-redis.md)                     | Upstash Redis over traditional Redis                        | Accepted                            |
| [0002](./0002-vercel-serverless-over-traditional-hosting.md)               | Vercel serverless over traditional hosting                  | Accepted                            |
| [0003](./0003-gdelt-v2-as-default-conflict-source.md)                      | GDELT v2 as default conflict source                         | Accepted                            |
| [0004](./0004-threat-density-via-radial-gradient-shader.md)                | Threat density via RadialGradientExtension shader           | Accepted                            |
| [0005](./0005-phase-26-2-nlp-approach-scrapped.md)                         | Phase 26.2 NLP approach scrapped — the honest retrospective | Superseded — reverted in Phase 26.3 |
| [0006](./0006-pino-and-zod-for-production-hardening.md)                    | Pino structured logging + Zod config/response validation    | Accepted                            |
| [0007](./0007-water-stress-as-point-facilities.md)                         | Water stress as point facilities, not polygon fills         | Accepted                            |
| [0008](./0008-ethnic-distribution-via-geoepr-with-hatched-overlays.md)     | Ethnic distribution via GeoEPR 2021 with hatched overlays   | Accepted                            |
| [0009](./0009-two-key-split-for-llm-partial-progress-vs-terminal-reads.md) | Two-key split for LLM partial progress vs terminal reads    | Accepted                            |
| [0010](./0010-v1-5-llm-pipeline-narrowing-and-deletion.md)                 | v1.5 LLM pipeline narrowing and deletion                    | Accepted                            |
| [0011](./0011-v3-llm-pipeline-architecture.md)                             | v3 LLM pipeline architecture                                | Accepted                            |

## One-line summaries

- **ADR-0001 — Upstash Redis.** Serverless functions can't hold
  connections; Upstash REST + generous free tier was the only sensible
  option at the time.
- **ADR-0002 — Vercel serverless.** Zero-ops hosting with global CDN
  and PR preview deploys for a personal-budget project.
- **ADR-0003 — GDELT v2 as default conflict source.** Free, no auth,
  15-min updates. ACLED adapter preserved but gated behind account
  approval — not active.
- **ADR-0004 — RadialGradientExtension shader.** Custom deck.gl
  LayerExtension injecting a GLSL `smoothstep` falloff because the
  stock HeatmapLayer doesn't support per-cluster radius scaling.
- **ADR-0005 — Phase 26.2 NLP approach scrapped.** Two weeks of NLP
  geo-validation work deleted wholesale. The upstream signal was too
  noisy for any downstream filter to rescue. The highest
  portfolio-signal artifact in this repo — killing your darlings,
  documented.
- **ADR-0006 — Pino + Zod hardening.** Structured JSON logging,
  redacted secrets, and Zod validation at both input and output
  boundaries. Phase 26.3 + 26.4 Plan 03 production hardening.
- **ADR-0007 — Water stress as point facilities.** Pivoted from basin
  polygon fills to per-facility points because polygons obscured the
  entities and users care about specific dams/treatment plants.
- **ADR-0008 — GeoEPR 2021 + hatched overlays.** Academic ethnic
  distribution dataset rendered with canvas-generated hatch patterns
  so ethnic zones read as distinct from the political fill layer.
- **ADR-0009 — Two-key split for LLM partial progress.** Phase 27.4.1
  post-ship incident: the v2 extractor's per-batch durability flush
  collided with the terminal reader's array-shape contract on a
  shared Redis key, crashing `/api/events` with `events.map is not
a function`. Split observability (`events:llm:v2:partial`) from
  user-facing (`events:llm:v2`) + added `toEntityArray` /
  `coerceCachedEvents` reader guards. The lesson — accepted-rollout-
  window framing is never acceptable when it violates a writer/reader
  shape contract.
- **ADR-0010 — v1.5 LLM pipeline narrowing and deletion.** Phase 29
  retires the v1 + v2 extractors and narrows the provider cascade to
  NIM-only at runtime; OpenRouter remains a dormant, key-gated cascade
  provider. Phase 27.4 D-26/D-40 deep-rollback lock superseded; new
  rollback path is `git revert <Phase 29 range>`. LLM-optional
  architecture proved by integration test + runbook procedure. Vercel
  Pro upgrade landed in the same phase so subsequent v1.5 phases tune
  against the 800s maxDuration ceiling. Fully rewritten in Phase 37 with
  the milestone-close rationale (6 sub-blocks); no longer a stub.
- **ADR-0011 — v3 LLM pipeline architecture.** The positive description
  of the pipeline that remains after ADR-0010's deletions. Six load-
  bearing design properties: (1) cron-only writer, (2) cold-cache
  self-heal, (3) terminal-key writes with observability-key envelope,
  (4) parallel batches with circuit-breaker watchdog, (5) NIM-primary
  cascade via `freeClaudeRouter` with OpenRouter fallback, (6) six-path
  Nominatim location resolver. Each property maps to a specific v1 or
  v2 production incident it was designed to prevent. Companion to
  ADR-0009 (writer/reader-shape discipline) and ADR-0010 (deletion
  context).

## Conventions

**Numbering.** ADRs are numbered sequentially starting at `0001` with
zero-padding to 4 digits. Numbers are never reused. When a decision is
superseded, the new ADR gets the next available number and the old
ADR's status is updated to `Superseded by ADR-XXXX` — but its content
stays intact.

**Immutability.** Once an ADR reaches `Accepted`, its _body_ is
immutable. The _status line_ may change (e.g. from `Accepted` to
`Superseded by ADR-NNNN`), but the Context / Decision / Consequences
sections stay as they were when the decision was made. If the reasoning
has evolved, write a new ADR that supersedes the old one and reference
it. This is not paperwork — it's how you avoid re-litigating the same
decision every six months.

**Status values.**

- `Proposed` — under discussion, not yet acted on.
- `Accepted` — the decision is live in the codebase.
- `Deprecated` — the decision is no longer the current approach, but
  there's no clean successor (e.g. a technology was retired but the
  replacement is TBD).
- `Superseded by ADR-NNNN` — replaced by a newer decision. The ADR
  body stays as a historical record; the current state is documented
  in the successor ADR.

**Scope.** ADRs document _decisions_, not _designs_. Architecture
diagrams live in `docs/architecture/`;
the runbook for operational failure modes lives in
`docs/runbook.md`; the graceful degradation contract
lives in `docs/degradation.md`. This directory is
specifically the "why we chose X over Y" layer.

**What qualifies for an ADR?** A decision is ADR-worthy if answering
"why did we do it this way?" six months from now would be hard without
the written record. Library choices, major refactors, trade-offs
between cost/complexity/performance, and killed experiments all
qualify. Routine implementation details (naming, file layout, styling)
do not.

---

_These ADRs document decisions made during the Iran Monitor
project (phases 13 through 41). They are written in retrospect for
phases that predate this directory; new decisions from 26.4 onward
should get ADRs at the time the decision is made._

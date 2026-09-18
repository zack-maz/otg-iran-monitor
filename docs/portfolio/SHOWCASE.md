# Iran Monitor — Showcase

> A 1-page guided tour. Each stop is one click away. Follow it top to bottom for
> the full story, or jump straight to whatever you came to see.

[Iran Monitor](../README.md) is a personal real-time conflict-intelligence
dashboard — a 2.5D map fusing ten live public data feeds into a single view of
the Greater Middle East. Numbers over narratives. It was built almost entirely
through an agentic `/gsd` workflow, and this page walks you through both the
product and how it got made.

**Live demo:** [otg-iran-monitor.vercel.app](https://otg-iran-monitor.vercel.app)
· hosted on `otg-iran-monitor.vercel.app` (the custom-domain decision was to stay
on the clean `vercel.app` origin — zero cost, zero DNS work).

![Hero](../public/screenshots/hero.gif)

> The hero GIF above is served from `public/screenshots/` once the screenshot
> consolidation lands; if it isn't rendering yet, the live demo link above shows
> the real thing.

---

## The tour

Seven stops, each one click. This is the recommended path for a first-time
visitor — it moves from "what decisions shaped this" through the architecture and
operations to the build meta-story, and ends at the code itself.

### 1. The hero — what you're looking at

Start at the [live demo](https://otg-iran-monitor.vercel.app) or the hero GIF
above. The map fuses flights, ships, GDELT conflict events, OpenStreetMap
infrastructure, news clusters, oil prices, weather, water stress, political
alignment, and ethnic distribution — all live, all gated through one cache-first
serverless pipeline. The [README](../README.md) is the full repo front door.

### 2. The decisions — two honest exhibits

The highest-signal artifacts in the repo are the two ADRs that document where I
got it wrong:

- **[ADR-0005: Phase 26.2 NLP approach scrapped](./adr/0005-phase-26-2-nlp-approach-scrapped.md)**
  — the two-week NLP geolocation pipeline I built, then deleted (~1,500 lines).
  The "honest failure" exhibit: patching downstream of a bad signal, recognizing
  the stuck signal too late, and killing my darlings instead of feature-flagging
  them.
- **[ADR-0010: v1.5 LLM pipeline narrowing and deletion](./adr/0010-v1-5-llm-pipeline-narrowing-and-deletion.md)**
  — the NIM-only narrowing, the ~6,400-line v1+v2 deletion, and the honest
  deferral of Cerebras + Groq. The "deep rollback safety is technical debt"
  exhibit.

### 3. The architecture — how the system fits together

**[system-context.md](./architecture/system-context.md)** is the architecture
entry point: the system-context diagram, the trust boundaries, and how the ten
upstream feeds flow through the cache-first serverless pipeline into the map.

### 4. The operations — how it runs in production

**[runbook.md](./runbook.md)** is the operations entry point: real failure modes,
incident playbooks (NIM throttle handling, cron architecture, force-trigger,
prod-audit retry), and the degrade-open recovery procedures. (For the
visitor-facing how-to counterpart — replay, prune, force-trigger — see
[operator-guide.md](./operator-guide.md).)

### 5. The meta-story — how it was actually built

**[BUILDING-WITH-CLAUDE-CODE.md](./BUILDING-WITH-CLAUDE-CODE.md)** is the
first-person agentic-dev report: the `/gsd` workflow shape (CONTEXT → DISCUSSION →
PLAN → EXECUTE → VERIFY), where compounding worked (mechanical drift gates,
parallel agents, probe-before-commit), where it didn't (the four honest failures),
and what the agents still can't do without me.

### 6. The product arc — how the questions got harder

**[JOURNEY.md](./JOURNEY.md)** tells the first-person product story from the
2026-03-13 brainstorm to the v1.5 close, with a GitHub-native Mermaid gantt of all
seven milestones. Each milestone answered one question, and the questions got
harder as the project got more serious about telling the truth about itself.

### 7. The code — where to start reading

**[`src/components/map/BaseMap.tsx`](../src/components/map/BaseMap.tsx)** is the
codebase entry point — the main map component that wires every overlay (terrain,
deck.gl layers, compass, the entity tooltip, the detail panel). If you want to see
how the live system is assembled, start here.

---

## Go deeper

Once you've done the tour, these round out the picture:

- **[concepts.md](./concepts.md)** — a glossary of the project's key terms
  (Pitfall 1 cache bridge, the 6-path resolver, degrade-open, the LLM flight
  recorder, mechanical drift gates, honest deferral, and more).
- **[COSTS.md](./COSTS.md)** — the cost transparency page. The only non-free line
  item in the entire stack is Vercel Pro at $20/month; everything upstream is
  free-tier. A "you can do this too" breakdown.
- **[LESSONS.md](./LESSONS.md)** — the distilled retrospective: the key lessons
  pulled from every milestone into a single page.
- **[The architecture index](./architecture/)** — the full set of architecture
  docs, including the
  [LLM pipeline reliability deep-dive](./architecture/llm-pipeline-reliability.md)
  and the [32-key Redis registry](./architecture/redis-keys.md).
- **[Historical receipts](./BUILDING-WITH-CLAUDE-CODE.md#7-historical-receipts)**
  — the original brainstorm and design specs, kept in the tree as proof-of-process.

---

_The repo front door is the [README](../README.md). For the build meta-story,
[BUILDING-WITH-CLAUDE-CODE.md](./BUILDING-WITH-CLAUDE-CODE.md); for the product
arc, [JOURNEY.md](./JOURNEY.md)._

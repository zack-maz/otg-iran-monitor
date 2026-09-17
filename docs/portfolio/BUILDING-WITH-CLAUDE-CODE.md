# Building Iran Monitor With Claude Code

> A first-person field report on building a 90,000-line real-time intelligence
> dashboard almost entirely through an agentic `/gsd` workflow — what compounded,
> what I scrapped, and what the agents still can't do for me.

This is the meta-story behind [Iran Monitor](../README.md). The product itself —
a 2.5D map fusing ten live public data feeds into a single view of the Greater
Middle East — is documented elsewhere ([JOURNEY.md](./JOURNEY.md) for the product
arc, [system-context.md](./architecture/system-context.md) for the architecture).
This document is about _how it got built_: the workflow, the agents, the gates,
and the failures.

I'm writing it in the first person because the honest version of "I built a large
app with AI agents" isn't a sales pitch. It's a working relationship with sharp
edges. I want to show you the edges, because the edges are where the actual
lessons live — and because if you're reading this thinking "could I do this too?"
the answer is yes, but only if you know where the agents help and where they'll
happily drive you off a cliff with green tests the whole way down.

The numbers in this document are real. Every figure is pulled from
[`.planning/RETROSPECTIVE.md`](../.planning/RETROSPECTIVE.md) and
[`.planning/MILESTONES.md`](../.planning/MILESTONES.md), the living retrospective
and milestone ledgers I've kept since day one. I have not invented a single
metric. Where I don't have a number, I say so.

---

## Table of contents

1. [The shape of the work](#1-the-shape-of-the-work)
2. [The `/gsd` workflow: one phase, end to end](#2-the-gsd-workflow-one-phase-end-to-end)
3. [Where compounding worked](#3-where-compounding-worked)
4. [Where it didn't: four honest failures](#4-where-it-didnt-four-honest-failures)
5. [Cost observations](#5-cost-observations)
6. [What the agents are good at vs. what still needs me](#6-what-the-agents-are-good-at-vs-what-still-needs-me)
7. [Historical receipts](#7-historical-receipts)
8. [If you want to try this](#8-if-you-want-to-try-this)

---

## 1. The shape of the work

Let me anchor the scale first, because "I built an app with AI" is meaningless
without the size.

From the cross-milestone trends table in
[`.planning/RETROSPECTIVE.md`](../.planning/RETROSPECTIVE.md):

| Milestone | Phases | Plans | Days | LOC     | Commits | Tests  |
| --------- | ------ | ----- | ---- | ------- | ------- | ------ |
| v0.9 MVP  | 13     | 25/28 | 6    | 12,262  | 229     | —      |
| v1.0      | 2      | 6/6   | 2    | 13,637  | 35      | —      |
| v1.1      | 8      | 22/22 | 3    | 25,842  | 146     | 851    |
| v1.2      | 7      | 19/19 | 7    | ~30,000 | 129     | 958    |
| v1.3      | 11     | 36/36 | 11   | —       | —       | ~1,700 |
| v1.4      | 18     | 60/60 | 29   | —       | —       | 2,193  |
| v1.5      | 10     | 60/62 | 24   | 92,501  | 209     | ~2,386 |

That's a real codebase. By the v1.5 close on 2026-06-03 it was ~92,500 lines of
TypeScript and CSS, ~2,386 passing tests, zero TypeScript errors, zero lint
errors. It ships to production on Vercel and serves live data from OpenSky,
ADS-B Exchange, adsb.lol, AISStream, GDELT, Overpass/OSM, Open-Meteo, Yahoo
Finance, WRI Aqueduct, Natural Earth, and GeoEPR.

I did not type most of those 92,500 lines. I drove a workflow that did. But
"drove" is the load-bearing word — this was not "tell the AI to build me an app"
and walk away. It was a structured, gated, phase-by-phase collaboration where my
judgment was the bottleneck on direction and the agents were the bottleneck on
throughput. The whole game was keeping those two bottlenecks in their lanes.

The thing I want you to take away from the table above: **the velocity wasn't
constant, and the slowdowns were the valuable parts.** v0.9 shipped 12,000 lines
in 6 days. v1.4 took 29 days for 18 phases. The difference wasn't that the agents
got slower — it's that the later milestones were reliability work, where the
expensive thing isn't writing code, it's _knowing whether the code is telling the
truth_. More on that below.

---

## 2. The `/gsd` workflow: one phase, end to end

Everything in this repo was built through a workflow I call `/gsd` ("get stuff
done"). A phase moves through five stages:

```
CONTEXT  ->  DISCUSSION  ->  PLAN  ->  EXECUTE  ->  VERIFY
```

Let me walk you through one real phase so this isn't abstract. I'll use **Phase
32 (Ghost Event URL Liveness)** from v1.5, because it's a clean example of the
full loop and it's small enough to hold in your head.

### CONTEXT

The phase opens with a `CONTEXT.md` — a structured conversation where I (the
operator) lock the decisions that the downstream agents are forbidden to re-open.
For Phase 32 the problem was: GDELT conflict events carry source URLs, and some
of those URLs go dead over time (the article gets pulled, the host disappears).
A dead-URL event is a "ghost event" — it's still on the map but you can't verify
it. The CONTEXT decisions locked things like: probe URLs as a polite citizen
(concurrency cap, per-host rate limit, jitter, redirect cap), surface a count to
the operator dashboard, and let the operator prune dead events behind a Bearer
gate.

The CONTEXT stage is where _my_ judgment goes in. The agents don't decide whether
to build this — I do. They don't decide the trust boundaries — I do. The locked
decisions become hard constraints for everyone downstream.

### DISCUSSION

Before planning, there's a discussion pass that surfaces tradeoffs. This is where
I learned to insist the agent _explain the tradeoff before presenting the choice_,
not just hand me option A/B/C labels. "We could use HEAD requests (cheaper, but
some hosts 405 them) vs. GET (more reliable, more bytes)" is a useful tradeoff.
"Option A: HEAD. Option B: GET." is not. I have a standing instruction in my
project memory to discuss tradeoffs, and it changed the quality of these passes
substantially.

### PLAN

A planner agent reads CONTEXT + DISCUSSION + a research pass and emits one or more
`PLAN.md` files. Each plan is a sequence of atomic tasks, each task with a type
(`auto`, `checkpoint:human-verify`, `checkpoint:decision`), explicit files it will
touch, a verification command, and a "done" criterion. Plans also carry a
threat-model block (STRIDE register) and a must-haves block that the verifier
checks against later.

The plan is a contract. It's the artifact I review most carefully, because a bad
plan produces confidently-wrong code. A good plan produces code I barely have to
look at.

### EXECUTE

An executor agent runs the plan task by task. For each `auto` task it writes the
code, runs the verification, and commits — one atomic commit per task, conventional
format (`feat(32-01): ...`). When it hits a `checkpoint:human-verify` task it
stops and hands me a verification script (a URL to visit, a thing to click, a
visual to evaluate) — the agents never ask me to run CLI commands, only to make
human judgments.

The executor also has standing authority to fix bugs, add missing critical
functionality (error handling, validation, auth on protected routes), and unblock
itself — all auto-documented as deviations. What it can _not_ do without stopping
to ask me is make architectural changes: new DB tables, switching libraries,
changing the auth approach. Those are my calls.

### VERIFY

After execution, a verifier agent checks the shipped code against the plan's
must-haves and success criteria, and against the live system where applicable.
Phase 32's verification included the URL-liveness schema being pinned by a
`.strict()` Zod test so it can't drift silently.

That's the loop. CONTEXT and VERIFY are the two ends where _my_ judgment is
load-bearing; PLAN is the contract; EXECUTE is the throughput. The milestone
ledger shows this loop ran 60 times in v1.5 alone (60 plans executed of 62
declared — the 2 unrun ones are a story I'll tell in §4).

---

### 2.1 The artifacts that make the loop work

The `/gsd` loop runs on a small set of durable, version-controlled artifacts.
They're worth naming because they're the actual mechanism — the thing that lets a
fresh agent with an empty context window pick up exactly where the last one left
off.

- **`CONTEXT.md` (per phase)** — my locked decisions, written as hard constraints.
  Downstream agents may not re-open these. This is where I front-load judgment so
  I'm not re-litigating direction in every plan.
- **`RESEARCH.md` (per phase)** — a research pass that grounds the plan in real
  in-repo facts and verified library docs, with confidence tags (`[VERIFIED]`,
  `[ASSUMED]`, `[CITED]`). Assumptions get flagged so the planner knows what to
  gate behind a checkpoint (e.g. "this package's legitimacy is `[ASSUMED]` — add
  a human-verify checkpoint before installing").
- **`PLAN.md` (one or more per phase)** — the executable contract: atomic tasks,
  explicit files, verification commands, threat model, must-haves.
- **`SUMMARY.md` (one per plan)** — what actually shipped, including every
  deviation the executor auto-applied. This is the audit trail that the _next_
  phase's CONTEXT reads to know the current state.
- **`STATE.md` / `ROADMAP.md` / `REQUIREMENTS.md`** — the project-level ledgers
  that track position, progress, and requirement traceability across all phases.
- **`RETROSPECTIVE.md` / `MILESTONES.md`** — the living memory updated at each
  milestone close. Every number in this document comes from these two files.

The reason this matters for agentic dev specifically: an agent's context window is
finite and resets between sessions. These artifacts are the _external memory_.
A new executor doesn't need to have "been there" for Phase 26.2 — it reads
ADR-0005 and inherits the lesson. The discipline of writing the artifacts down is
what turns a sequence of stateless agent runs into a coherent, compounding
project. Skip the artifacts and every phase starts from amnesia.

There's also a current-state invariant I learned to enforce: `CLAUDE.md` (the
file every agent reads first) holds _only_ current state — conventions, the Redis
key registry, the data model, deployment facts. Phase history moves to archived
milestone roadmaps. v1.5 trimmed CLAUDE.md by 73.3% (from ~18,700 tokens to
5,018) by ruthlessly evicting historical narrative. A bloated current-state file
wastes every future agent's context budget on things that are no longer true.

## 3. Where compounding worked

"Compounding" is the thing people promise about agentic dev and rarely
demonstrate. Here's where it actually compounded for me — with real in-repo
receipts.

### 3.1 Mechanical drift gates

This is the single biggest win, and it's the one I'd tell anyone starting an
agentic project to adopt on day one.

The problem: when you have agents writing code _and_ docs _and_ tests across
dozens of phases, the artifacts drift. The docs claim a thing the code no longer
does. A constant defined in two places gets updated in one. An agent "helpfully"
hardcodes a color that's supposed to come from a single source of truth.

The fix is not "remind the reviewer to check." Reviewers (human or agent) forget.
The fix is a **mechanical drift gate**: a test that fails loudly the moment two
things that must agree stop agreeing.

Concrete examples from this repo:

- **The colorBridge byte-identity sentinel.** Every entity, event, and faction
  color in the app is declared once in a Tailwind `@theme` block
  ([`src/styles/app.css`](../src/styles/app.css)). A module-load reader
  ([`src/lib/colorBridge.ts`](../src/lib/colorBridge.ts)) parses those CSS vars
  once into RGBA tuples for deck.gl and re-exports them as hex for HTML/CSS
  consumers. The drift gate
  ([`src/__tests__/lib/colorBridge.test.ts`](../src/__tests__/lib/colorBridge.test.ts))
  asserts every bridge fallback default is byte-identical to the runtime value.
  An agent literally _cannot_ introduce a divergent color literal without turning
  the suite red. Theme drift is mechanically impossible.

- **The domain-constants mirror test.** The geographic bounding box, center
  point, war-start date, and ADS-B radius are canonical in
  [`src/lib/domain.ts`](../src/lib/domain.ts) with a byte-identical mirror in
  `server/config.ts`. A test asserts the mirror matches. Two files, one truth,
  enforced at vitest time.

- **The 32-key Redis registry test.** v1.5 shipped a deep-dive of all 32 Redis
  cache keys ([`docs/architecture/redis-keys.md`](./architecture/redis-keys.md))
  with a drift gate (`src/__tests__/lib/redis-registry.test.ts`) carrying 39
  assertions across 4 sub-suites. The doc, CLAUDE.md, and the production code
  have to agree or the suite fails.

- **OpenAPI lint + markdown-link-check.** The 19-endpoint OpenAPI 3.0.3 spec is
  Redocly-linted in CI, and every internal doc link is checked by
  `npm run docs:lint`. When Phase 36 ran the link checker for the first time it
  immediately surfaced 3 broken Mermaid blocks the drift gate caught on first run.

The retrospective's verdict on this, which I stand by completely:

> Mechanical drift gates over reviewer vigilance: Drift gates that fail vitest
> beat checklists that ask reviewers to remember to check. The cost of writing
> them was paid back in the same milestone.

The compounding here is real and measurable: each gate written in v1.5 is now
load-bearing for v1.6 and beyond. The cost is paid once; the protection is
forever (or until the gate itself drifts — which is why the drift gates are
themselves `*.test.ts` files under the same suite).

### 3.2 Parallel agents

The `/gsd` workflow structures phases into _waves_ of plans that can run in
parallel when they don't depend on each other. v1.5's Phase 33 and Phase 35 both
used wave structure; Phase 41 (the one producing this very document) splits its
14 requirements into a Wave-0 audit gate followed by three parallel docs/site
waves.

The win isn't just speed — it's that wave boundaries force me to think about
dependencies explicitly. If plan B can run in parallel with plan A, they're
genuinely independent. If they can't, I've surfaced a coupling I should know
about. The parallelism is a forcing function for clean phase decomposition.

The discipline that makes parallel agents safe: each runs on an isolated branch
or worktree, commits atomically, and never touches another agent's files. A
Wave-0 gate runs _first and alone_ when later waves depend on its output (e.g. an
audit that reshapes the scope of everything after it).

### 3.3 Probe-before-commit

This pattern earned its place the hard way (see §4.1), and v1.5 made it a
first-class habit.

The rule: **when code and docs disagree, or when you're about to build against a
noisy input, write a throwaway probe script and measure before you commit.**
Measurement beats opinion.

The canonical example is Phase 30.1. The docs had been advertising a "NIM ->
OpenRouter" LLM provider cascade, but a `skipOpenRouter: true` hardcode had been
silently in place for ~6 weeks. Instead of guessing which side was right, I ran
`scripts/probe-openrouter.ts` — 30 real fires against the OpenRouter free tier.
27 of 30 came back rate-limited (90.0%). That measurement made the decision for
me: declare OpenRouter dormant, ship NIM-only honestly, and amend the docs to
match shipped reality. No code change — docs follow measured truth.

The retrospective:

> Probe-driven decisions produce honest docs. Phase 30.1 probed OpenRouter
> (27/30 = 90% rate-limited) and committed to docs-only amendment. Both the
> probe-and-decide and the honest-deferral paths are correct; neither lies.

The reason this compounds is subtle: every probe script I write becomes a
reusable measurement harness. The OpenRouter probe became the template for the
Cerebras/Groq probe (which I then chose not to run — also a story for §4). The
NIM throttle characterization in Phase 30 (`Retry-After` absent in 213 batches;
p95 = 33,263ms) is the measurement that all the cron-timeout tuning is anchored
to. The numbers persist; the tuning follows the numbers; nobody has to argue.

### 3.4 Deletion over deprecation

A quieter compounding win. v1.5 deleted ~6,400 lines of v1 + v2 LLM extractor
code that had been kept as "deep rollback safety" for four months. The rollback
path was `git revert <commit range>` — so the code being preserved "for safety"
was just dead code waiting to confuse the next reader (human or agent).

Deleting it produced a clean v3-or-nothing posture: less code to read, less to
maintain, fewer "is this still load-bearing?" interruptions for every future
agent that has to reason about the codebase. The key lesson, verbatim from the
retrospective:

> Pre-existing "deep rollback safety" is technical debt, not safety. If the
> rollback path is `git revert`, the code being preserved "for safety" is just
> dead code waiting to confuse the next reader. Delete it; trust git.

This compounds because agentic codebases accumulate cruft _faster_ than
hand-written ones — agents are conservative, they keep things "just in case." A
standing bias toward deletion (with git as the safety net) keeps the codebase
legible enough that the next agent's context window isn't wasted on dead paths.

---

## 4. Where it didn't: four honest failures

Here's the part that actually matters for evaluating this kind of work. Anyone
can show you the wins. The judgment signal is in the failures — and more
specifically, in whether the failures got documented honestly or quietly buried.

I documented all four of these as first-class project events: two in ADRs, all
four in the retrospective. That's deliberate. Reviewers evaluate judgment, not
just code, and documenting a scrap is the judgment signal.

### 4.1 Phase 26.2: the NLP scrap (two weeks, deleted)

This is the big one. The full autopsy is
[ADR-0005](./adr/0005-phase-26-2-nlp-approach-scrapped.md) — ~300 lines of honest
retrospective, the highest-portfolio-signal artifact in the repo.

The short version: GDELT conflict events have known false-positive geolocation —
many arrive with country-centroid coordinates instead of real incident locations.
I tried to fix it with a server-side NLP pipeline: fetch each article's title,
run it through the `compromise` library with a custom 240-name Middle East
lexicon, extract place entities, cross-check them against GDELT's country code,
and replace centroid coordinates with the NLP-extracted city coordinates.

It ran for every GDELT event on every 15-minute poll. All three plans shipped
green tests and passing verifications in isolation. The problem wasn't that any
individual piece was broken — it's that **the whole stack was solving the wrong
problem.** The NLP layer sat _downstream_ of GDELT's geocoding. If the upstream
signal is unreliable, no amount of post-processing makes it reliable; it just
hides the unreliability behind an opaque layer that's even harder to debug.

By the end I had five layers of mitigation stacked on each other, each addressing
an edge case surfaced by the previous layer. That's the shape of every "almost
working" downstream-fix project. I should have recognized it as a stuck signal
two weeks earlier.

I scrapped all of it in Phase 26.3 — deleted ~1,500 lines, reverted six modified
files to their pre-26.2 state. From ADR-0005:

> ~1500 lines of code removed that didn't deliver the promised value. This is the
> biggest portfolio signal in the repo: the willingness to measure, admit
> failure, and delete. Dead code that "almost works" is worse than no code at all
> in a work sample.

The four lessons from that ADR are the ones I now carry into every phase:

1. **Patching downstream of a bad signal compounds the problem.** If a fix needs
   more than two layers of post-processing heuristics, the fix is wrong — go back
   upstream.
2. **Spike before commit.** Before writing production code against a noisy input,
   write a throwaway script that measures how noisy the input actually is. The
   measurement is the go/no-go signal, not the prototype. (This is the direct
   ancestor of the probe-before-commit pattern in §3.3.)
3. **Killing your darlings is a portfolio signal.** Delete, don't feature-flag.
   Document the scrap in an ADR, not a commented-out code block.
4. **Cleanup phases are part of the product.** The willingness to take a two-week
   hit in the middle of the roadmap to remove failed work compounds.

The honest cost: two weeks of evenings and weekends in the bin. The honest
benefit: the codebase is cleaner, the problem is correctly framed for a future
redo, and the failure is documented instead of hidden behind a feature flag.

The agents, for the record, did not save me from this. They happily built every
layer of the doomed NLP stack with green tests at each step. The "this is the
wrong problem" judgment was mine to make, and I made it two weeks too late. The
lesson there — spike before you commit — is a _human_ discipline the agents won't
enforce for you.

### 4.2 Phase 31: the 7-day watch that closed at Day 1

Phase 31 was a 7-day cron stability watch. The requirement said "≥7 consecutive
days." It closed early at **Day 1 / 7** under an operator decision (mine). Day 1
was a clean PASS — natural cron tick, eval 0.98 at all radii, zero circuit-breaker
trips — so closing early with a documented caveat felt honest.

It wasn't free. The slow-burn regression that Days 2-7 were designed to catch
surfaced **23 days later** during the Phase 37 acceptance-gate observation, and
required four unblocker PRs to resolve. From the retrospective:

> A 7-day stability watch needs to actually be 7 days. Closing early under
> operator decision sacrifices the very signal the watch was designed to catch.
> The slow-burn regression that surfaced 23 days later in Phase 37 is the lesson
> here.

This one is purely on me, not the agents. The watch was set up correctly; I
chose to skip Days 2-7 to keep momentum. Early-close-with-caveat is honest
documentation, but the operator-side decision to skip the window cost rework time
at the milestone-close gate. Phase 31 is flagged for reopening in v1.6 — this
time finished.

### 4.3 Phase 34: the honest deferral

Phase 34 was supposed to re-integrate Cerebras and Groq as fallback LLM providers
behind NIM. Five plans were written: probe -> adapter -> eval -> DLQ -> close.

When it came time to execute, I chose _not_ to provision the Cerebras + Groq
free-tier accounts and _not_ to run the probe. The empirical "no provider
expansion right now" was itself the load-bearing outcome. So Phase 34 closed as
`cerebras-groq-deferred` — 4 of 5 plans SKIPPED, only the close-out ran.

This is the inverse of the Phase 26.2 mistake, and I'm proud of it. Instead of
building an untested cascade and declaring it reliable, I closed honestly with a
named status and **preserved all five plans + the RESEARCH + the CONTEXT** as the
ready-to-execute audit trail. From the retrospective:

> Honest deferral preserves optionality. Phase 34's deferral kept 5 plans, 1
> RESEARCH, 1 CONTEXT, and the integration design intact. If v1.7 wants to
> restore the cascade, the work is `git checkout` away. Closing as "not in scope"
> with no artifacts would have forced re-planning from zero.

The full decision record is in
[ADR-0010](./adr/0010-v1-5-llm-pipeline-narrowing-and-deletion.md), which captures
both the NIM-only narrowing and the Cerebras/Groq deferral as the milestone-final
shipped state.

The inefficiency, in fairness: those five plans cost real planning time at the
probe + adapter design stage that turned out not to be load-bearing. The plan
investment was useful as an audit trail, but if I'd known I'd defer, I'd have
written one CONTEXT and a deferral note instead of five plans. The agents
faithfully planned all five; the "actually, let's not" was mine.

### 4.4 Phase 37: the unblocker PRs

The fourth failure is the most architecturally interesting. Phase 37 was the
v1.5-close acceptance gate: three consecutive green runs of the production
connectivity audit, with `allTiersGreen === true`.

The audit had been **red for 23 days.** The instinct is to read that as "the LLM
pipeline is broken." It wasn't. The real problem was a _framing gap_: the gate
itself, designed back in Phase 28.2.5, assumed `llmEvents` was a critical-tier
endpoint that had to be `healthy`. But Phase 29 had made the LLM pipeline
_optional_ — raw GDELT via the cache bridge is a legitimate terminal fallback,
not a failure. The gate was flagging correct shipped behavior as a failure.

Letting the gate run — instead of rubber-stamping it — uncovered the real
architectural debt. Four unblocker PRs landed during the observation window to
reconcile the gate semantics with the actual LLM-optional architecture:

- **PR #32** — demoted `llmEvents` to non-critical + added an LLM-optional
  `degraded-on-fallback` signal.
- **PR #33** — made the `news` GDELT-DOC adapter best-effort with an RSS-only
  fallback signal.
- **PR #34** — relaxed the truth table for the non-critical tier to accept
  `healthy | degraded | unknown` (critical tier stays strict-`healthy`).
- **PR #35** — a YAML/shell apostrophe-quoting hotfix for PR #34's inline script.

These were **not** gate-evasion patches. They corrected an architectural mismatch
that should have been caught in Phase 29 — the phase that _made_ the architecture
optional. The full framing-gap callout is in the
[Phase 37 milestone-close SUMMARY](../.planning/milestones/v1.5-phases/37-adr-0010-acceptance-gate-closeout/37-SUMMARY.md).
The lesson, from the retrospective:

> Architecture decisions cascade into audit-tier semantics. Phase 29 made the LLM
> pipeline optional; Phase 28.2.5's strict-tier-green gate hadn't been reconciled
> with that decision. The gate-vs-architecture mismatch should be audited at the
> same phase that changes the architecture, not 1 milestone later under a
> different acceptance gate.

And the sharper version:

> Acceptance gates that don't observe shipped reality are worse than no gate. A
> gate that flags correct shipped behavior as failures is documentation theater.

This one is a genuinely interesting failure mode of agentic dev: the agents will
faithfully implement a gate to the spec you give them, and faithfully implement
an architecture change that invalidates that spec, and _not_ notice the
contradiction — because each phase has its own context window and nobody is
holding both in their head except me. Cross-phase architectural coherence is a
human responsibility. The gate was right to exist; it was wrong to ship against
an assumption a later phase invalidated, and catching that at the milestone-close
gate cost ~3 days.

---

## 5. Cost observations

Honest numbers, pulled from the Cost Observations sections of
[`.planning/RETROSPECTIVE.md`](../.planning/RETROSPECTIVE.md).

### Pace

- **v0.9 MVP:** 229 commits over 6 days. ~2 hours total plan-execution time.
  Stable ~4-5 minutes per plan throughout. Average plan execution ~4.7 minutes.
- **v1.5:** 209 commits over 24 days. 60 plans executed of 62 declared (97%
  execution rate — 2 conditional SKIPs in Phase 30.1, 4 deferral SKIPs in Phase
  34). ~24 days wall-clock, ~8 of which had a phase-close commit landing (~3 days
  per closing phase on average; longer for the wave-structured Phases 33 + 35).

The contrast is the story. v0.9 was greenfield feature-building — the agents are
_fast_ at that, ~4.7 minutes per plan. v1.5 was reliability work, and it ran ~3
days per closing phase. The agents didn't slow down; the _verification_ slowed
down, because the expensive question in reliability work isn't "does it compile?"
(the agents handle that), it's "is this telling the truth under failure?" — which
needs probes, watches, eval harnesses, and my judgment.

### The cost-control deferrals were the cheap path

The retrospective's cost note on v1.5 is the one I'd underline:

> Cost-control deferrals (Phase 34 `cerebras-groq-deferred`, Phase 31 early-close)
> kept the milestone moving without false reliability claims; in both cases the
> "honest" path was the cheaper path.

Deferring Cerebras/Groq honestly was cheaper than building an untested cascade.
Even the Phase 31 early-close, which I count as a mistake, was a cheap mistake to
_recover_ from precisely because it was documented honestly — when the regression
surfaced 23 days later, the caveat was right there in the record pointing at it.

### The dollar cost of running the thing

For completeness, the _operating_ cost (distinct from the dev cost above): the
only non-free line item in the entire stack is Vercel Pro at $20/month, taken in
Phase 29 for the 800-second function ceiling the LLM cron needs. Every upstream
data feed — NIM, Upstash Redis, GDELT, OpenSky, adsb.lol, Open-Meteo, Yahoo
Finance, AISStream, Overpass, WRI, Natural Earth, GeoEPR — is free-tier. The full
breakdown lives in [COSTS.md](./COSTS.md).

The point worth sitting with: a 92,500-line production OSINT dashboard fusing ten
live feeds runs for $20/month in infrastructure. The expensive resource was never
the hosting or the APIs — it was the _judgment_ to keep the architecture honest
and the discipline to measure instead of guess. That's the resource I'd tell
anyone to budget for. The agents make the code cheap; they don't make the
direction cheap.

---

## 6. What the agents are good at vs. what still needs me

The clean division of labor, learned over seven milestones.

### What the agents are good at

- **Greenfield feature-building.** ~4.7 min per plan in v0.9. Give them a clear
  plan with explicit files and a verification command, and they produce correct,
  tested, committed code fast.
- **Mechanical consistency.** Once a drift gate exists, the agents respect it
  perfectly — they literally can't merge past a red suite. The colorBridge
  sentinel means no agent will ever introduce a divergent color literal.
- **Adapter / normalizer patterns.** Adding adsb.lol as a third flight source was
  trivial because the shared V2 normalizer was in place. The agents extend
  established patterns reliably.
- **Self-documenting deviations.** When an executor auto-fixes a bug or adds
  missing validation, it logs the deviation. The audit trail writes itself.
- **Bulk doc/test sweeps.** The 32-key Redis registry, the 7-module JSDoc audit,
  the OpenAPI spec — large, mechanical, detail-heavy work the agents do tirelessly.

### What still needs me

- **Problem framing.** The Phase 26.2 NLP scrap is the monument here. The agents
  built the wrong solution flawlessly. "This is the wrong problem" was mine to
  see, and I saw it two weeks late.
- **Spike/measure decisions.** Whether to probe OpenRouter, whether to defer
  Cerebras/Groq, whether a noisy input is worth building against — these are
  go/no-go calls the agents won't make. Probe-before-commit is a human discipline.
- **Cross-phase architectural coherence.** The Phase 37 framing gap existed
  because no single agent context held both "the gate spec" and "the architecture
  change that invalidated it." Holding the whole arc in my head is my job.
- **Knowing when to stop.** Closing Phase 34 as a deferral, closing Phase 31
  (correctly or not) early, scrapping Phase 26.2 — every "we're done here / we're
  not doing this" call was mine.
- **Tradeoff judgment.** The agents present tradeoffs well _when instructed to_,
  but choosing among them against the actual product values ("numbers over
  narratives," "the map never goes blank") is judgment, not computation.

The pattern: **the agents are a throughput multiplier on direction I provide, not
a substitute for direction.** When I gave good direction (clear plans, mechanical
gates, honest probes) the multiplier was enormous. When I gave bad direction
(build NLP downstream of a bad signal) the multiplier faithfully amplified the
mistake. The skill isn't prompting — it's knowing what's worth building and how
to know whether it's true.

---

## 6b. A worked example: the LLM enrichment pipeline

To make "the agents handle throughput, I handle judgment" concrete, let me walk
through the single most involved subsystem in the repo — the LLM event-enrichment
pipeline — and call out which decisions were mine and which were the agents'
execution.

The problem: GDELT gives you raw conflict events with noisy geolocation (the same
problem that defeated the NLP scrap in §4.1). After the scrap, the redo phase
reframed it correctly — instead of patching downstream, the v1.4 milestone built
a structured LLM extraction pipeline that re-geocodes events with provenance.

The shape that shipped (from CLAUDE.md, the canonical current-state reference):

- **A single extractor module** (`server/lib/llmEventExtractor.v3.ts`) that is
  cron-only — the daily `/api/cron/refresh-events` at 04:00 UTC is the _sole_
  writer of the enriched cache. `/api/events` is cache-only; it never triggers
  extraction on the request path (this is an explicit anti-pattern guard — I'll
  come back to why).
- **A 6-path geocode resolver** (`server/lib/llmResolver.ts`) that never returns
  a coordinate without provenance: own-site-snapshot, POI-amenity-Nominatim,
  nominatim-direct, nominatim-verified-2pass, gdelt-actiongeo-fallback,
  bellingcat-coord-passthrough. Each path is tried in order; the first that
  resolves wins, and the event records _which_ path produced its coordinate.
- **Reliability primitives** wrapping the cascade: a circuit breaker (sliding
  10-call window, pauses 5 min on >30% error rate), a dead-letter queue (bounded
  200-entry Redis set, 7-day TTL), a per-provider token budget (soft 0.8 / hard
  0.95 daily caps), and a watchdog (90s hard-kill with an AbortController +
  generation counter to prevent a late-resolving batch from clobbering a newer
  cache write).
- **A graceful-degradation bridge** so that when the LLM cache is empty,
  `/api/events` serves raw GDELT through the "Pitfall 1" cache bridge. The map
  never goes blank. This is the load-bearing product value — and it's the one
  that the Phase 37 acceptance gate (§4.4) initially mis-modeled as a failure.

Here's the division of labor that built it:

**Mine (judgment):** the anti-pattern guard. There's a comment in the codebase —
"anti-pattern #17: do NOT re-introduce fire-and-forget" — that exists because an
earlier version triggered extraction from the request path, which blew the
serverless function budget and produced inconsistent caches under concurrent
requests. Deciding that `/api/events` must be _cache-only_ and the cron must be
the _sole writer_ is an architectural call. The agents would have happily wired a
convenient fire-and-forget trigger if I'd let them; the discipline to forbid it
is mine.

**Mine (judgment):** the "never return a coordinate without provenance" rule. That
constraint on the resolver is a direct lesson from the NLP scrap — I no longer
trust any geocoding result that can't tell me where it came from. The agents
implemented the six paths; the _requirement_ that each path stamp its provenance
is the scar tissue from §4.1.

**The agents (throughput):** every one of those six resolver paths, the circuit
breaker's sliding window, the DLQ's bounded-set semantics, the watchdog's
generation-counter late-resolve guard, the parallel-batch concurrency limiter,
and the ~2,386 tests that pin all of it. That's thousands of lines of careful,
correct, well-tested infrastructure I described at the plan level and barely had
to touch at the code level.

**Mine (judgment):** the measurement. Phase 30 characterized the NIM throttle
empirically (`Retry-After` absent in 213 batches; p95 = 33,263ms) and every
timeout/backoff/concurrency default is anchored to those measured numbers, not to
a guess. Probe-before-commit again (§3.3). The agents ran the probe harness; the
decision to tune _against measured reality_ instead of around it was the point.

This is the whole thesis of the document in one subsystem: I provided the
architecture, the constraints born of past failures, and the measurements. The
agents provided the correct, tested, voluminous implementation. Neither half does
the job alone.

## 7. Historical receipts

I keep the original planning artifacts in the tree as proof-of-process, not
archived away. If you want to see how the thinking actually evolved — messy
brainstorms, design specs, the works — here are the receipts.

> These are kept in place deliberately (decision D-07 of the reveal phase):
> originals stay where they are, cross-linked here as historical receipts.
> Nothing is deleted or sanitized.

### The origin brainstorm

- [`docs/brainstorms/2026-03-13-iran-conflict-monitor-brainstorm.md`](./brainstorms/2026-03-13-iran-conflict-monitor-brainstorm.md)
  — the very first "what if I built this?" brainstorm, dated three weeks before
  the v0.9 MVP shipped. This is where the whole thing started: one question about
  what's actually happening around the Strait of Hormuz, quantitatively.

> **Vision → shipped.** The origin brainstorm fixed the core value on day one —
> _"prioritizes concrete, mathematical data — counts, timelines, movement vectors,
> force posture — over qualitative news."_ That "numbers over narratives" thesis
> survived every milestone unchanged; it's still the project's one-liner today.
> The data sources, though, did not survive contact with reality: the brainstorm's
> "Public APIs only" table specced **ACLED** for conflict events and a persistent
> **WebSocket** for ~5s flight refresh. ACLED was built in Phase 8 then immediately
> replaced by **GDELT** (free, no-auth, 15-min) in Phase 8.1, and the WebSocket
> polling model gave way to tab-visibility-aware recursive `setTimeout` once the
> serverless deploy (v1.0) made persistent connections untenable. The vision was
> right; the plumbing got rebuilt at least twice. That gap between the day-one
> thesis and the shipped plumbing is exactly what these receipts exist to show.

### Early design plans (superpowers/plans)

The structured plans that fed the v1.0 -> v1.1 intelligence-layer build:

- [`docs/superpowers/plans/2026-03-17-gdelt-event-categories.md`](./superpowers/plans/2026-03-17-gdelt-event-categories.md)
- [`docs/superpowers/plans/2026-03-18-filter-panel-redesign.md`](./superpowers/plans/2026-03-18-filter-panel-redesign.md)
- [`docs/superpowers/plans/2026-03-19-intelligence-layer.md`](./superpowers/plans/2026-03-19-intelligence-layer.md)
- [`docs/superpowers/plans/2026-03-22-search-filter-unification.md`](./superpowers/plans/2026-03-22-search-filter-unification.md)

### Design specs (superpowers/specs)

The corresponding design specs — the "how exactly" companions to the plans above:

- [`docs/superpowers/specs/2026-03-17-gdelt-event-categories-design.md`](./superpowers/specs/2026-03-17-gdelt-event-categories-design.md)
- [`docs/superpowers/specs/2026-03-18-filter-panel-redesign-design.md`](./superpowers/specs/2026-03-18-filter-panel-redesign-design.md)
- [`docs/superpowers/specs/2026-03-19-intelligence-layer-design.md`](./superpowers/specs/2026-03-19-intelligence-layer-design.md)
- [`docs/superpowers/specs/2026-03-27-gdelt-event-quality-pipeline-design.md`](./superpowers/specs/2026-03-27-gdelt-event-quality-pipeline-design.md)

### The honest-failure exhibits

The two ADRs that carry the failures from §4 in full:

- [ADR-0005: Phase 26.2 NLP approach scrapped](./adr/0005-phase-26-2-nlp-approach-scrapped.md)
  — the two-week NLP scrap, ~300 lines of autopsy.
- [ADR-0010: v1.5 LLM pipeline narrowing and deletion](./adr/0010-v1-5-llm-pipeline-narrowing-and-deletion.md)
  — the NIM-only narrowing, the ~6,400-line deletion, and the Cerebras/Groq
  honest deferral.

### The living ledgers

- [`.planning/RETROSPECTIVE.md`](../.planning/RETROSPECTIVE.md) — per-milestone
  What Worked / Inefficient / Patterns / Key Lessons / Cost. Every number in this
  document traces here.
- [`.planning/MILESTONES.md`](../.planning/MILESTONES.md) — the 7-milestone ledger
  with ship dates, LOC, commit ranges, and quantitative snapshots.

---

## 8. If you want to try this

You can do this too. Here's the honest starter advice, distilled from the seven
milestones above.

1. **Adopt mechanical drift gates on day one.** The single highest-leverage habit.
   Anything that must agree (a constant in two places, a color, a doc claim vs.
   code) gets a test that fails when they diverge. This is what makes a large
   agent-built codebase stay coherent instead of rotting into contradiction.

2. **Spike before you commit.** Before building against any noisy or uncertain
   input, write a throwaway probe that _measures_ the thing. The measurement is
   the go/no-go signal. I learned this by skipping it and losing two weeks
   (§4.1).

3. **Delete, don't feature-flag.** If `git revert` is your rollback path, the
   "safety" code you're keeping is just future confusion. Trust git. Keep the
   codebase legible for the next agent's context window.

4. **Document the failures as first-class events.** The ADRs naming my scraps and
   deferrals are the highest-signal artifacts in the repo. Reviewers evaluate
   judgment, not just code. An honestly-documented failure is worth more than
   another clean feature.

5. **Hold the architecture in your head — that's your job.** The agents have
   per-phase context windows. Cross-phase coherence (the Phase 37 framing gap) is
   the human's responsibility. Don't outsource the thing only you can see.

6. **Let the velocity vary.** Greenfield is fast (~4.7 min/plan); reliability is
   slow (~3 days/phase) and the slowness is the value. Don't fight it. The
   expensive question is usually "is this true under failure?", not "does it
   compile?".

The agents are an extraordinary throughput multiplier. They are not a substitute
for knowing what's worth building, measuring whether it works, and admitting when
it doesn't. Keep those three things on your side of the table and the rest
compounds.

---

_Built with Claude Code through the `/gsd` workflow, 2026-03-13 → ongoing. Every
metric in this document is sourced from
[`.planning/RETROSPECTIVE.md`](../.planning/RETROSPECTIVE.md) and
[`.planning/MILESTONES.md`](../.planning/MILESTONES.md). For the product arc, see
[JOURNEY.md](./JOURNEY.md); for the guided tour, [SHOWCASE.md](./SHOWCASE.md)._

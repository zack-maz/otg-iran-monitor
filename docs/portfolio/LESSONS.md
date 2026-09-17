# Lessons

_Distilled from [`.planning/RETROSPECTIVE.md`](../.planning/RETROSPECTIVE.md) — a living per-milestone retrospective. This is the one-page version; the fuller meta-story of building this with Claude Code is in [BUILDING-WITH-CLAUDE-CODE.md](./BUILDING-WITH-CLAUDE-CODE.md), and the guided product tour is [SHOWCASE.md](./SHOWCASE.md)._

These are the lessons I keep coming back to. Most of them I learned the expensive way — by skipping the right move, paying for it, and writing down what I should have done. They're in first person because they're mine, not abstractions.

## 1. Probe-before-commit for documentation reconciliation

When my code and my docs disagree, I no longer argue about which one is right — I write a throwaway probe that _measures_ the thing, and let the measurement decide. When OpenRouter's free tier started failing, I didn't re-enable a `skipOpenRouter` hardcode on a hunch. I fired 30 requests at it (`scripts/probe-openrouter.ts`), watched 90% come back rate-limited, and committed to NIM-only honestly — a docs-only amendment, no code lie. The same instinct caught me _not_ doing it: a `skipOpenRouter: true` hardcode lived ~6 weeks while my architecture diagrams advertised a cascade that didn't exist at runtime. Measurement beats opinion, and unmeasured docs rot.

## 2. Honest deferral as a first-class outcome

When a planned phase doesn't ship — the probe didn't run, I skipped the provisioning, the evidence didn't support it — I close it with a _named status_ (`cerebras-groq-deferred`, `nim-only`) instead of letting it linger as "in progress." Empirical "no provider expansion right now" is itself a load-bearing result. I keep the planning artifacts (CONTEXT, RESEARCH, the plans) intact as a ready-to-execute audit trail, so restoring the work later is a `git checkout` away rather than a re-plan from zero. Deferral done honestly preserves optionality; deferral hidden as "in progress" just lies to future-me.

## 3. Mechanical drift gates compound

Every gate that fails at `vitest` time instead of at audit-discovery-time-months-later pays for itself, usually within the same milestone. The Redis registry test, the Redocly OpenAPI lint, markdown-link-check, the byte-identity sentinels for domain constants — each one was written once and now protects forever. The cost is paid up front; the protection is permanent (or until the gate itself drifts, which is why drift gates need their own `*.test.ts`). A gate that fails loudly beats a checklist that asks a reviewer to remember to look. This is the single highest-leverage habit in the whole project.

## 4. Deletion over deprecation when rollback is git-revert-able

If my rollback path is "revert this commit range," then the code I'm keeping "for safety" is just dead code waiting to confuse the next reader. The v1 + v2 extractor modules, the override route, the Redis override key, the dev UI buttons — ~6,400 lines of "deep rollback safety" that had been load-bearing for confusion, not for safety. I deleted all of it and got a clean v3-or-nothing posture. Pre-existing "deep rollback safety" is technical debt, not safety. Trust git; keep the codebase legible for the next agent's context window.

## 5. Architecture decisions cascade into audit-tier semantics

This is the Phase 37 lesson, and it cost me ~3 days at a milestone-close gate. When Phase 29 made the LLM pipeline _optional_, it quietly invalidated a strict-tier-green acceptance gate written back in Phase 28.2.5 against a "critical[llmEvents]: healthy" assumption. The gate then flagged correct, shipped behavior as failures — documentation theater — and it took four unblocker PRs to reconcile. The lesson: when I change the architecture, I have to audit the audit-tier semantics _in the same phase_, not one milestone later under a different gate. Acceptance gates that don't observe shipped reality are worse than no gate at all. Cross-phase coherence is the human's job — the agents only have per-phase context windows, so the thing only I can see is the thing I can't outsource.

---

_For the failures behind these lessons in full — the two-week NLP scrap (ADR-0005), the LLM narrowing (ADR-0010), the 7-day watch that closed at Day 1 — see [BUILDING-WITH-CLAUDE-CODE.md §4](./BUILDING-WITH-CLAUDE-CODE.md) and the ADRs it cross-links. Every number traces back to [`.planning/RETROSPECTIVE.md`](../.planning/RETROSPECTIVE.md)._

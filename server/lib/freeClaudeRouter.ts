/**
 * Free Claude Router — multi-provider cascade for LLM-backed extraction + geocoding.
 *
 * Live production callers (verified Phase 38 / 2026-06-04):
 *   - server/lib/llmEventExtractor.v3.ts — sole runtime extractor; calls
 *     callLLM for each event-group batch.
 *   - server/lib/llmResolver.ts — 6-path geocode resolver; calls callLLM
 *     for the nominatim-verified-2pass reranker only.
 *
 * Phase 38 LLM-PURGE-02 — the server/adapters/llm-provider.ts callLLM bridge
 * wrapper was deleted; no module re-exports callLLM any more. Both live callers
 * import it from here directly.
 *
 * Active cascade shape (Phase 34 close): NIM primary (qwen-235b instruct);
 * OpenRouter dormant (skipOpenRouter: true at extractor sites per Phase 30.1);
 * Cerebras + Groq deferred (Phase 34 close — see ADR-0010 Phase 34 sub-block).
 *
 * Test callers (NOT live production — listed for completeness):
 *   - server/__tests__/lib/freeClaudeRouter.test.ts (canonical contract)
 *   - server/__tests__/lib/freeClaudeRouter.retryAfterMs.test.ts
 *   - server/__tests__/lib/llmEventExtractor.v3-adaptive.test.ts
 *   - server/__tests__/lib/llmLineage-prefilter.test.ts
 *   - server/__tests__/lib/llmResolver.test.ts
 */

/**
 * Vendored from https://github.com/Alishahryar1/free-claude-code
 * Pinned commit SHA: 40951c145ad29d6dfe450e83fd2b91fc19b9a27f
 * License: MIT (upstream LICENSE applies; see LICENSE-VENDORED.md if added)
 *
 * Phase 27.4.3 (D-01, D-02). This file ports four concepts from upstream:
 *   1. Per-provider client config (NVIDIA NIM, OpenRouter)
 *   2. Rolling-window rate limiter (40 req/min for NVIDIA NIM)
 *   3. Reactive 429 exponential backoff with jitter
 *   4. <think>-block stripper / reasoning_content parser (D-11)
 *
 * NOT ported (D-02 vendoring scope):
 *   - FastAPI / uvicorn server
 *   - Anthropic <-> OpenAI message-shape translator (we use OpenAI SDK natively)
 *   - Discord bot, Telegram bot, claude-pick CLI
 */

import OpenAI from 'openai';

import { redis } from '../cache/redis.js';
import { env } from '../config.js';

// Phase 39 OBS-FLIGHT-01 / -05 — dual-write each call entry to the Redis-backed
// `llm:calls:history` ring so the flight recorder survives cold starts and can
// group calls by runId. Degrade-open — appendCallHistory never throws.
import { appendCallHistory } from './llmCallHistory.js';
import { isAvailable, record, type Provider } from './llmCircuitBreaker.js';
// Phase 27.4.3 Plan 02b B-1 — instrumentation hooks. Writes per-attempt
// latency, headroom, error-taxonomy, and shadow-cost into the live progress
// singleton so DevApiStatus / /llm-status surfaces them under v3.
// Phase 39 OBS-FLIGHT-05 — CallHistoryEntry carries runId + batchIndex for
// call→run back-correlation; llmProgress.runId is the per-run id stamped at the
// run boundary in llmExtractionPipeline.ts.
import { llmProgress, updateProgress, type CallHistoryEntry } from './llmProgress.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FreeProvider = 'nvidia_nim' | 'openrouter';

export interface RoutingDecision {
  provider: FreeProvider;
  model: string;
  /**
   * 'primary' for the first provider in the cascade, or
   * `fall_through:<prevProvider>_<reason>` when a downstream provider is
   * tried after the previous one failed/skipped.
   */
  reason: 'primary' | string;
  timestamp: number;
}

export type RouterErrorBucket =
  | 'rate_limit'
  | 'timeout'
  | 'malformed_json'
  | 'schema_fail'
  | 'network'
  | 'upstream_500'
  | 'other';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NVIDIA_NIM_BASE = 'https://integrate.api.nvidia.com/v1';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
// Per-request timeout. The production model answers a batch in ~15 s; a call
// still open after 45 s is a hung connection, and a wave cannot finish until
// its slowest batch does. One timed-out attempt is retried (see callLLM), so
// the worst case stays under the 120 s batch watchdog.
const LLM_TIMEOUT_MS = 45_000;

// Phase 30 D-02 sanity-check tune (Run 1 baseline — Path B, no 429s):
//   - Run 1 measured `throttleWindowMs.path = "B"` (NIM did NOT 429 during
//     the 122s window), `steadyStateRpm = 0`, `watchdogTimeoutCount = 0`,
//     and `perBatchLatency.p95 = 33_263 ms`. See:
//     .planning/phases/30-nim-throttle-characterization-cascade-tuning-pro
//                     -enabled-sim/run-1-throttle-snapshot.json
//   - Because there is no measured throttle window, BACKOFF_MS is NOT
//     derived from `throttle_window_median / 2` (the CONTEXT D-02 formula
//     is undefined under Path B). Numbers here are a conservative-by-
//     default bump that preserves the prior 4× scaling pattern and gives
//     more recovery headroom on the Pro 800s ceiling — they are a
//     defensive choice, not an empirical fit. Plan 06 Run 2 (with eval
//     harness fixed) re-probes and re-tunes against real 429s if any.
//
// Side-by-side defaults (v1.4 → v1.5 sanity-check):
//   RETRY_ATTEMPTS : 2              → 3                (Pro 800s budget
//                                                       absorbs the extra
//                                                       attempt without
//                                                       watchdog conflict)
//   BACKOFF_MS     : [1000, 4000]   → [2000, 8000, 32000]   (4× scaling
//                                                       preserved; third
//                                                       element added for
//                                                       the new attempt 3)
//   JITTER_MS      : 250            → 500              (±25% ratio of
//                                                       BACKOFF[0] kept:
//                                                       0.25 × 2000 = 500)
//
// Worst-case retry wall-clock per attempt-exhausted call: 2000+8000+32000
// = 42_000 ms (~42s) ± jitter. New LLM_BATCH_TIMEOUT_MS = 120_000 (Task 1
// of this plan) comfortably bounds even a fully-retried call.
//
// Operator rollback (env override is NOT available — these are constants;
// in-incident reversion requires `git revert` of this commit):
//   RETRY_ATTEMPTS = 2; BACKOFF_MS = [1000, 4000]; JITTER_MS = 250.
// 401/403 = key rejected, 404 = model not served to this key, 410 = model retired.
const FATAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 410]);
const RETRY_ATTEMPTS = 3;
const BACKOFF_MS = [2000, 8000, 32_000] as const;
const JITTER_MS = 500;
// Production model. NIM retires free-tier models on a schedule: a retired id
// answers HTTP 410 on every call, and most ids in NIM's public catalog are not
// served to a free-tier key at all (404). Do not pick a replacement from the
// catalog — probe it: `GET /api/cron/llm-probe?models=<id>,<id>` sends one
// production-shaped batch per candidate and reports status, latency and schema
// validity (docs/OPERATIONS.md §3.3).
//
// History: `qwen/qwen3.5-397b-a17b` (bake-off winner, 2026-04) was retired on
// 2026-07-27 and the pipeline wrote nothing for eight weeks. On 2026-09-19 a
// probe of 20 candidates found one usable model: gemma-4-31b-it — 8/8
// schema-valid at 8 concurrent calls, ~15 s per 2-group batch. The GLM, Kimi,
// DeepSeek and gpt-oss reasoning models exceeded 90 s; nemotron-super
// truncated at 2048 tokens.
//
// `V3_PRIMARY_MODEL` overrides this without a code change (leave it unset in
// production once the default is live).
export const NVIDIA_NIM_DEFAULT_MODEL = process.env.V3_PRIMARY_MODEL ?? 'google/gemma-4-31b-it';

// D-09: OpenRouter free-tier fallback model.
export const OPENROUTER_DEFAULT_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
// D-09: free-tier daily request cap for OpenRouter (rough envelope; per-model
// caps vary 100-200/day on the free pool).
const OPENROUTER_DAILY_CAP = 200;

// Phase 27.4.4 D-06: data-driven per-model max_tokens cap (MAX_TOKENS_PER_MODEL).
// Values seeded from 27.4.4-PREFLIGHT-CHARACTERIZATION.md per-model p99(tokens-out)
// + 20% buffer. Hard ceiling 4096. Falls back to MAX_TOKENS_DEFAULT for
// un-cataloged models.
//
// Cheapest defense against runaway reasoning. For 27.4.4's candidates the
// observed p99 tokens-out is well under any cap — the long-tail is generation-
// rate collapse, NOT truncation (zero finish_reason: "length" across 39
// successful preflight calls). These caps are defensive ceilings, not load-
// bearing for p95 latency.
const MAX_TOKENS_PER_MODEL: Record<string, number> = {
  // Phase 27.4.4 Plan 02 dev-pass bump: 425 → 2048 after live dev /api/events?force=true
  // showed ~89% truncation rate (50 v3:malformed DLQ in 7 batches) — the
  // 20-event preflight characterization underestimated production hierarchy
  // verbosity. 2048 keeps a 5× safety margin against the 4096 default.
  // ~590 tokens observed per 2-group batch; 2048 leaves room for LLM_BATCH_SIZE up to ~6.
  'google/gemma-4-31b-it': 2048,
};
const MAX_TOKENS_DEFAULT = 4096;

// ---------------------------------------------------------------------------
// Rolling-window rate limiter (D-01 vendored primitive)
// ---------------------------------------------------------------------------

class RollingWindow {
  private readonly cap: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(cap: number, windowMs: number) {
    this.cap = cap;
    this.windowMs = windowMs;
  }

  private evict(now: number): void {
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
  }

  canRequest(): boolean {
    this.evict(Date.now());
    return this.timestamps.length < this.cap;
  }

  consume(): void {
    this.timestamps.push(Date.now());
  }

  /**
   * Wait for a free slot, then take it. Callers block instead of being turned
   * away: with a single provider there is nowhere to fall through to, so a
   * refused call is a lost batch, and a full window used to drain the rest of
   * a run as instant nulls.
   */
  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.evict(now);
      if (this.timestamps.length < this.cap) {
        this.timestamps.push(now);
        return;
      }
      const oldest = this.timestamps[0] ?? now;
      await new Promise((r) => setTimeout(r, Math.max(50, oldest + this.windowMs - now)));
    }
  }

  headroom(): { used: number; cap: number } {
    this.evict(Date.now());
    return { used: this.timestamps.length, cap: this.cap };
  }
}

// Module-level instance — NVIDIA NIM enforces 40 req/min on the free tier.
const nvidiaNimWindow = new RollingWindow(40, 60_000);

// ---------------------------------------------------------------------------
// Phase 27.4.4 D-21 — NIM cold-start pre-warm.
//
// In-memory timestamp of the most recent NIM call (any call, not just
// pre-warm). Persisted ONLY in module memory — RESEARCH §8 explicitly forbids
// Redis backing because (a) cross-instance staleness would defeat the
// 60s window and (b) Vercel Fluid Compute warm starts share module state
// already, so the in-memory value is the cheapest correct signal.
// ---------------------------------------------------------------------------
let lastNimCallTs = 0;
const PREWARM_COLD_THRESHOLD_MS = 60_000;

// ---------------------------------------------------------------------------
// Lazy client init (mirror server/adapters/llm-provider.ts:23-40)
// ---------------------------------------------------------------------------

function getNvidiaNimClient(): OpenAI | null {
  if (!env.NVIDIA_NIM_API_KEY) return null;
  return new OpenAI({
    apiKey: env.NVIDIA_NIM_API_KEY,
    baseURL: NVIDIA_NIM_BASE,
    timeout: LLM_TIMEOUT_MS,
    // The router owns retries. The SDK's default 2 hidden retries tripled the
    // real request rate behind the 40/min window and stretched a failing call
    // past the batch watchdog.
    maxRetries: 0,
  });
}

function getOpenRouterClient(): OpenAI | null {
  if (!env.OPENROUTER_API_KEY) return null;
  return new OpenAI({
    apiKey: env.OPENROUTER_API_KEY,
    baseURL: OPENROUTER_BASE,
    timeout: LLM_TIMEOUT_MS,
    maxRetries: 0,
  });
}

// ---------------------------------------------------------------------------
// Reasoning-block stripper (D-11)
// ---------------------------------------------------------------------------

/**
 * Strip `<think>...</think>` blocks AND a leading `reasoning_content:` prefix
 * line from raw LLM output. Tolerates unclosed `<think>` (returns string).
 *
 * The optional `reasoningContent` parameter is accepted for API compatibility
 * with providers that surface the reasoning trace on a separate field
 * (e.g. NVIDIA NIM `reasoning_content` on the message). It is not currently
 * used to mutate the returned content but is reserved for downstream
 * observability sinks.
 */
export function stripReasoningBlocks(
  raw: string | null,

  _reasoningContent?: string,
): string | null {
  if (!raw) return raw;
  let s = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  s = s.replace(/^reasoning_content:[^\n]*\n/m, '');
  return s.trim();
}

// ---------------------------------------------------------------------------
// Error classifier (drives D-14 error taxonomy)
// ---------------------------------------------------------------------------

export function classifyError(err: unknown): RouterErrorBucket {
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    if (m.includes('429') || m.includes('rate limit')) return 'rate_limit';
    if (m.includes('timeout') || m.includes('timed out')) return 'timeout';
    if (m.includes('enotfound') || m.includes('econnreset') || m.includes('eai_again'))
      return 'network';
    if (/\b5\d\d\b/.test(m)) return 'upstream_500';
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Backoff with jitter (verbatim from server/adapters/llm-provider.ts)
// ---------------------------------------------------------------------------

async function sleepWithJitter(base: number): Promise<void> {
  const jitter = (Math.random() * 2 - 1) * JITTER_MS;
  await new Promise((r) => setTimeout(r, Math.max(0, base + jitter)));
}

// ---------------------------------------------------------------------------
// UTC day key (YYYY-MM-DD) — used by the cost-shadow daily roll-up.
//
// Phase 38 LLM-PURGE-08 (D-04 Path A) — the OpenRouter daily-cap Redis counter
// (incrOpenRouterDaily writer + getOpenRouterDaily reader, on the
// `llm:tokens:openrouter:YYYY-MM-DD` key) was removed. OpenRouter stays a
// dormant key-gated provider in the cascade (client is null without
// OPENROUTER_API_KEY — ADR-0010 "dormant, could wake if key set" semantics);
// only the dead daily-cap accounting is gone. The legacy
// `llm:tokens:openrouter:YYYY-MM-DD` key drains on its 48h TTL.
// ---------------------------------------------------------------------------

function todayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Main cascade entrypoint (D-09)
// ---------------------------------------------------------------------------

/**
 * Try each free provider in order, returning the first non-null content along
 * with a routing decision per provider attempted. Never throws — failure
 * surfaces as `{ content: null, routing: [...] }` so the extractor can
 * gracefully degrade to raw GDELT (D-29 contract).
 *
 * D-10: response_format is `{ type: 'json_object' }` (NO strict mode); the
 * JSON Schema is delivered to the model as instruction text by the caller.
 * Zod enforces shape post-parse.
 */
// Phase 27.4.4 Plan 02 dev-pass: surface OpenAI-style finish_reason so the
// v3 extractor can classify max_tokens truncations distinctly from other
// JSON parse failures. 'length' = response cut at max_tokens cap; 'stop' =
// natural completion; null/undefined = provider didn't supply the field.
export type RouterFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;

export async function callLLM(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],

  _schemaText: string,
  // Phase 39 OBS-FLIGHT-05 — `batchIndex` is threaded from the
  // processEventGroupsV3 batch loop so each call-history entry can be grouped
  // by its parent batch within the run. Optional; defaults to -1 (unknown)
  // for non-extractor callers (e.g. the llmResolver reranker).
  opts: {
    batchSize?: number;
    modelOverride?: string;
    skipOpenRouter?: boolean;
    batchIndex?: number;
  } = {},
): Promise<{
  content: string | null;
  routing: RoutingDecision[];
  finishReason?: RouterFinishReason;
  /**
   * Set when the provider answered 401/403/404/410: the key is rejected or the
   * model is not served. No retry can succeed, so the caller should stop the
   * run and say why instead of grinding through every batch.
   */
  fatalStatus?: number;
}> {
  const log = logger.child({ component: 'freeClaudeRouter' });
  const decisions: RoutingDecision[] = [];

  // Phase 27.4.4 Plan 02 — `skipOpenRouter` lets the v3 extractor opt out of
  // the OpenRouter fallback. Free-tier OR rate-limits ~every call (~16
  // attempts × 16 rate_limit errors observed in dev), and a 100%-failing
  // fallback is worse than no fallback: it amplifies the breaker error
  // rate and burns the per-call retry budget on a guaranteed loser. v2
  // keeps OR enabled so the legacy rollback path is unchanged.
  const includeOpenRouter = !opts.skipOpenRouter;

  const allProviders: Array<{ name: FreeProvider; model: string; client: OpenAI | null }> = [
    {
      name: 'nvidia_nim',
      model: opts.modelOverride ?? NVIDIA_NIM_DEFAULT_MODEL,
      client: getNvidiaNimClient(),
    },
    {
      name: 'openrouter',
      model: OPENROUTER_DEFAULT_MODEL,
      client: getOpenRouterClient(),
    },
  ];
  const providers = includeOpenRouter
    ? allProviders
    : allProviders.filter((p) => p.name !== 'openrouter');
  // A breaker only helps when there is somewhere else to send the call. With a
  // single live provider a tripped breaker turned every remaining batch of the
  // run into an instant null for five minutes.
  const hasFallThrough = providers.filter((p) => p.client).length > 1;
  let fatalStatus: number | undefined;

  for (let idx = 0; idx < providers.length; idx++) {
    const p = providers[idx];
    if (!p) continue;
    const isPrimary = idx === 0;
    const prevName = idx > 0 ? providers[idx - 1]?.name : null;
    /**
     * Build the routing reason for the *current* provider when it is BYPASSED
     * by a gate (no_client / breaker). Phase 38 LLM-PURGE-08
     * removed the OpenRouter daily-cap gate; `daily_cap` survives only as a
     * legacy skipReason union member.
     *   - For the primary, encode the bypass cause as `skipped:<suffix>` so
     *     observability sees why we never even attempted it (otherwise primary
     *     bypass would be indistinguishable from a normal primary attempt).
     *   - For downstream providers, use the existing `fall_through:<prev>_<suffix>`
     *     shape so the trace shows which prior provider triggered the cascade.
     */
    const buildReason = (suffix: string): string =>
      isPrimary ? `skipped:${suffix}` : `fall_through:${prevName}_${suffix}`;

    if (!p.client) {
      decisions.push({
        provider: p.name,
        model: p.model,
        reason: buildReason('no_client'),
        timestamp: Date.now(),
      });
      continue;
    }
    if (hasFallThrough && !isAvailable(p.name as Provider)) {
      decisions.push({
        provider: p.name,
        model: p.model,
        reason: buildReason('breaker'),
        timestamp: Date.now(),
      });
      continue;
    }
    decisions.push({
      provider: p.name,
      model: p.model,
      reason: isPrimary ? 'primary' : `fall_through:${prevName}_429`,
      timestamp: Date.now(),
    });

    // Phase 27.4.4 Plan 02 — `record(p.name, 'err')` is moved out of the per-
    // attempt catch block (was at the old line 441). Counting every retry
    // attempt as a breaker-window failure was tripping the breaker on
    // rate-limit storms even when the SAME call eventually succeeded on
    // retry — the breaker's 30%-error-rate threshold treats a 429-then-
    // success as a failure, which is wrong. The fix records `'ok'` on the
    // success path (existing behavior) and records `'err'` exactly once if
    // ALL retries are exhausted (non-retriable error or retry budget
    // burned). recordErrorBucket still increments per-attempt because that
    // is a raw failure counter, not a breaker signal.
    let callFailed = false;
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      let t0 = Date.now();
      try {
        // Blocks until the 40/min window has room (see RollingWindow.acquire).
        if (p.name === 'nvidia_nim') await nvidiaNimWindow.acquire();
        t0 = Date.now(); // latency measures the provider, not the wait for a slot

        const res = await p.client.chat.completions.create({
          model: p.model,
          messages,
          response_format: { type: 'json_object' }, // D-10: NO strict mode
          temperature: 0,
          max_tokens: MAX_TOKENS_PER_MODEL[p.model] ?? MAX_TOKENS_DEFAULT, // D-06
        });
        const latencyMs = Date.now() - t0;

        // === B-1 §1: Latency capture ===
        recordLatency(p.name, latencyMs);

        // === B-1 §2: Rate-limit headroom snapshot ===
        recordHeadroom(p.name);

        // === B-1 §4: Shadow-cost accrual (read usage from completion) ===
        const usage = (res as { usage?: { prompt_tokens?: number; completion_tokens?: number } })
          .usage;
        const tokensIn = usage?.prompt_tokens ?? 0;
        const tokensOut = usage?.completion_tokens ?? 0;
        if (tokensIn > 0 || tokensOut > 0) {
          await accrueShadowCost(tokensIn, tokensOut);
        }

        const raw = res.choices[0]?.message?.content ?? null;
        const reasoningField = (
          res.choices[0]?.message as { reasoning_content?: string } | undefined
        )?.reasoning_content;
        const content = stripReasoningBlocks(raw, reasoningField);
        // Phase 27.4.4 Plan 02 dev-pass: capture OpenAI-style finish_reason.
        // 'length' indicates max_tokens cap was hit; downstream JSON.parse
        // catch uses this to tag DLQ entries as v3:max_tokens_truncation
        // (vs. the generic v3:malformed bucket).
        const finishReason: RouterFinishReason =
          (res.choices[0]?.finish_reason as RouterFinishReason | undefined) ?? null;
        record(p.name as Provider, 'ok');
        // Phase 27.4.4 D-21 — stamp lastNimCallTs on every successful NIM
        // call so prewarmIfCold() correctly detects > 60s of NIM idleness.
        if (p.name === 'nvidia_nim') lastNimCallTs = Date.now();

        // Phase 39 OBS-FLIGHT-05 — SUCCESS-PATH callHistory writer. Pre-Phase-39
        // the success branch only `record`ed 'ok' and returned; the in-memory
        // callHistory row was written ONLY on the failure path. Build a
        // runId+batchIndex-stamped entry here (real tokensIn/tokensOut from the
        // completion usage), prepend it to the cap-20 singleton via the same
        // updateProgress .slice(0,20) idiom, then dual-write it to
        // `llm:calls:history` (degrade-open; never throws). Do NOT add a second
        // `record(p.name,'err')` anywhere — the single per-call recording at
        // the end of the failure path is unchanged (Pitfall 4).
        const successEntry: CallHistoryEntry = {
          provider: p.name,
          model: p.model,
          tokensIn,
          tokensOut,
          durationMs: latencyMs,
          ok: true,
          batchSize: opts.batchSize ?? 0,
          timestamp: Date.now(),
          runId: llmProgress.runId ?? '',
          batchIndex: opts.batchIndex ?? -1,
        };
        const successHistory = llmProgress.callHistory ?? [];
        updateProgress({ callHistory: [successEntry, ...successHistory].slice(0, 20) });
        void appendCallHistory(successEntry); // dual-write — degrade-open

        return { content, routing: decisions, finishReason };
      } catch (err) {
        const latencyMs = Date.now() - t0;
        // Latency captured even on failure — surfaces hung calls in dashboard.
        recordLatency(p.name, latencyMs);
        // === B-1 §3: Error taxonomy increment ===
        const bucket = classifyError(err);
        recordErrorBucket(p.name, bucket);

        // D-01 (Phase 30): capture Retry-After from 429s when the provider supplies it.
        // OpenAI SDK surfaces response headers on APIError.headers; NIM-specific
        // header presence verified by Run 1 telemetry. Milliseconds; null when absent.
        // Per RESEARCH Pitfall 2: NIM 429 header surface is undocumented — analyzer
        // handles both Path A (header present here → median+p95 of retryAfterMs) and
        // Path B (header absent → infer recovery from callHistory timestamp gaps).
        let retryAfterMs: number | null = null;
        if (bucket === 'rate_limit' && err instanceof Error && 'headers' in err) {
          const headers = (err as { headers?: Record<string, string> }).headers;
          const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
          if (raw) {
            const parsed = parseFloat(raw);
            if (Number.isFinite(parsed) && parsed > 0) retryAfterMs = parsed * 1000;
          }
        }

        // Append failed-attempt row to callHistory via updateProgress (existing
        // mutation pattern; mirrors soft-warn synthetic entry at
        // llmEventExtractor.v3.ts:662-682). The 20-row .slice(0, 20) cap is
        // invariant. retryAfterMs is the only D-01-added field on the row shape.
        // NOTE: this writes per-attempt failure rows, distinct from the success
        // path's `return` at line 447. RESEARCH gotcha 2: do NOT add a duplicate
        // `record(p.name, 'err')` here — the existing single recording at the
        // end of the call (line 479) is unchanged so the breaker window still
        // sees exactly one 'err' per call, not per attempt.
        const history = llmProgress.callHistory ?? [];
        // Phase 39 OBS-FLIGHT-05 — stamp runId + batchIndex on the failure-path
        // entry too (back-correlation), and dual-write it to `llm:calls:history`
        // below so the flight recorder sees failed attempts as well as successes.
        const failureEntry: CallHistoryEntry = {
          provider: p.name,
          model: p.model,
          tokensIn: 0,
          tokensOut: 0,
          durationMs: latencyMs,
          ok: false,
          batchSize: opts.batchSize ?? 0,
          timestamp: Date.now(),
          retryAfterMs,
          runId: llmProgress.runId ?? '',
          batchIndex: opts.batchIndex ?? -1,
        };
        updateProgress({
          callHistory: [failureEntry, ...history].slice(0, 20),
        });
        void appendCallHistory(failureEntry); // dual-write — degrade-open

        log.warn(
          {
            provider: p.name,
            attempt,
            bucket,
            latencyMs,
            retryAfterMs,
            err: err instanceof Error ? err.message : String(err),
          },
          'router attempt failed',
        );
        const status = (err as { status?: unknown }).status;
        if (typeof status === 'number' && FATAL_STATUSES.has(status)) fatalStatus = status;
        if (bucket === 'rate_limit' && attempt < RETRY_ATTEMPTS - 1) {
          const base: number = BACKOFF_MS[attempt] ?? BACKOFF_MS[0] ?? 1000;
          await sleepWithJitter(base);
          continue;
        }
        // A hung request is usually a one-off; retry it once, without backoff.
        if (bucket === 'timeout' && attempt === 0) continue;
        // non-retriable or retry-exhausted -> mark call as failed, fall
        // through to next provider. Single 'err' record per call (not per
        // attempt) so a single rate-limit-then-retry-succeeds doesn't pollute
        // the breaker window.
        callFailed = true;
        break;
      }
    }
    if (callFailed) {
      record(p.name as Provider, 'err');
    }
  }

  log.warn({ fatalStatus }, 'all free providers unavailable — returning null content');
  return { content: null, routing: decisions, fatalStatus };
}

// ---------------------------------------------------------------------------
// B-1 instrumentation helpers (D-12, D-14, D-19)
//
// Each freeClaudeRouter attempt records: (1) latencyMs into a per-provider
// ring buffer with P50/P95/P99 recompute; (2) headroom snapshot via the
// RollingWindow.headroom() / OpenRouter daily counter; (3) error bucket on
// catch via classifyError; (4) shadow cost from res.usage tokens.
//
// All writes go through updateProgress() so the same Object.assign-based
// mutability semantics that existing v2 code relies on are preserved. The
// helpers gracefully no-op when llmProgress is empty / under test mocks.
// ---------------------------------------------------------------------------

/** Ring buffer cap per provider. P50/P95/P99 recompute on each insert. */
const LATENCY_RING_CAP = 100;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[idx] ?? 0;
}

function recordLatency(provider: FreeProvider, latencyMs: number): void {
  const current = llmProgress.latencyHistogram ?? {
    nvidia_nim: { p50: 0, p95: 0, p99: 0, sparkline: [], samples: [] },
    openrouter: { p50: 0, p95: 0, p99: 0, sparkline: [], samples: [] },
  };
  const bucket = current[provider];
  const samples = [...(bucket.samples ?? []), latencyMs].slice(-LATENCY_RING_CAP);
  const sorted = [...samples].sort((a, b) => a - b);
  const next = {
    ...current,
    [provider]: {
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      p99: quantile(sorted, 0.99),
      sparkline: samples.slice(-30), // last 30 for the SVG sparkline
      samples,
    },
  };
  updateProgress({ latencyHistogram: next });
}

function recordHeadroom(provider: FreeProvider): void {
  // Ensure both providers have a record; only the active one updates per attempt.
  const current = llmProgress.rateLimit ?? {
    nvidia_nim: { used: 0, cap: 40, window: 'minute' as const, perModel: {} },
    openrouter: { used: 0, cap: OPENROUTER_DAILY_CAP, window: 'day' as const, perModel: {} },
  };
  if (provider === 'nvidia_nim') {
    const h = nvidiaNimWindow.headroom();
    current.nvidia_nim = { ...current.nvidia_nim, used: h.used, cap: h.cap };
  } else {
    // openrouter — Phase 38 LLM-PURGE-08: the daily-cap counter was removed,
    // so there is no per-day `used` to snapshot. OpenRouter is dormant
    // (key-gated); report `used: 0` against the static cap for the headroom UI.
    current.openrouter = { ...current.openrouter, used: 0 };
  }
  updateProgress({ rateLimit: current });
}

function recordErrorBucket(provider: FreeProvider, bucket: RouterErrorBucket): void {
  // 7-bucket taxonomy seed (D-14) — kept single-line so the acceptance grep
  // anchors on the exact field-set without prettier-driven reformatting.
  // prettier-ignore
  const current = llmProgress.errorTaxonomy ?? {
    nvidia_nim: { rate_limit: 0, timeout: 0, malformed_json: 0, schema_fail: 0, network: 0, upstream_500: 0, other: 0 },
    openrouter: { rate_limit: 0, timeout: 0, malformed_json: 0, schema_fail: 0, network: 0, upstream_500: 0, other: 0 },
  };
  const next = {
    ...current,
    [provider]: { ...current[provider], [bucket]: (current[provider][bucket] ?? 0) + 1 },
  };
  updateProgress({ errorTaxonomy: next });
}

/** D-19: tokens_in × $0.20/M + tokens_out × $0.40/M. Daily roll-up persisted to Redis. */
async function accrueShadowCost(tokensIn: number, tokensOut: number): Promise<void> {
  const usd = (tokensIn * 0.2 + tokensOut * 0.4) / 1_000_000;
  const current = llmProgress.costShadow ?? { tokensIn: 0, tokensOut: 0, usd: 0 };
  updateProgress({
    costShadow: {
      tokensIn: current.tokensIn + tokensIn,
      tokensOut: current.tokensOut + tokensOut,
      usd: current.usd + usd,
    },
  });
  // Daily roll-up Redis key per CONTEXT D-19 (90d ring).
  try {
    const key = `events:llm-cost-shadow:v3:${todayKey()}`;
    await redis.hincrby(key, 'tokensIn', tokensIn);
    await redis.hincrby(key, 'tokensOut', tokensOut);
    // usd stored as integer microcents (×1e6) to avoid Redis float precision loss.
    await redis.hincrby(key, 'usdMicrocents', Math.round(usd * 1_000_000));
    await redis.expire(key, 90 * 24 * 3600);
  } catch {
    // observability-only; skip on Redis failure
  }
}

// ---------------------------------------------------------------------------
// Phase 27.4.4 D-21 — prewarmIfCold.
//
// Fires a 1-token synthetic NIM call when the in-memory `lastNimCallTs`
// indicates the NIM client has gone cold (>60s idle). The synthetic call
// is intentionally small (max_tokens=1, 1-message prompt) so the cost is
// negligible vs. the latency cliff that follows a cold start. Failures are
// swallowed — pre-warm is best-effort observability, never a hard gate.
//
// Side-effects on llmProgress (mirrored to DevApiStatus's pre-warm cell):
//   - prewarmCount: total prewarmIfCold() calls that fired a request this run.
//   - lastPrewarmTs: timestamp of most recent fired prewarm.
//   - prewarmState: 'warm' (recent NIM activity) | 'cold-fired' (this call
//     fired a warmup) | 'unknown' (no NIM client configured).
//
// Caller is `processEventGroupsV3` before the main batch loop; the helper
// is also re-exported here so unit tests can drive its branches directly.
// ---------------------------------------------------------------------------
export async function prewarmIfCold(): Promise<void> {
  const log = logger.child({ component: 'freeClaudeRouter.prewarmIfCold' });
  const client = getNvidiaNimClient();
  if (!client) {
    updateProgress({ prewarmState: 'unknown' });
    return;
  }
  const now = Date.now();
  const elapsed = lastNimCallTs > 0 ? now - lastNimCallTs : Number.POSITIVE_INFINITY;
  if (elapsed <= PREWARM_COLD_THRESHOLD_MS) {
    updateProgress({ prewarmState: 'warm' });
    return;
  }
  // Cold — fire a 1-token synthetic warmup. Best-effort, never throws out.
  try {
    await client.chat.completions.create({
      model: NVIDIA_NIM_DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'ok' }],
      max_tokens: 1,
      temperature: 0,
    });
    lastNimCallTs = Date.now();
    updateProgress({
      prewarmCount: (llmProgress.prewarmCount ?? 0) + 1,
      lastPrewarmTs: lastNimCallTs,
      prewarmState: 'cold-fired',
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'prewarmIfCold synthetic call failed (non-fatal)',
    );
    updateProgress({
      prewarmCount: (llmProgress.prewarmCount ?? 0) + 1,
      lastPrewarmTs: Date.now(),
      prewarmState: 'cold-fired',
    });
  }
}

// ---------------------------------------------------------------------------
// Internal exports for unit tests ONLY — do not consume from production code
// ---------------------------------------------------------------------------

export const __internal = { RollingWindow };

#!/usr/bin/env node
/**
 * Phase 30.1 D-03..D-06 — OpenRouter free-tier rate-limit probe.
 *
 * Re-validates OpenRouter free-tier rate-limit behavior so Phase 30.1 can
 * decide whether to re-enable OpenRouter in the v3 cascade (currently
 * `skipOpenRouter: true` at llmEventExtractor.v3.ts:622, 929) or to document
 * the NIM-only reality in ADR-0010 + the architecture doc.
 *
 * The Phase 27.4.4 measurement of 16/16 rate_limited responses is stale; this
 * probe takes a fresh measurement against the same model the production
 * cascade uses (imported from server/lib/freeClaudeRouter — never hardcoded
 * here, so a future model swap automatically follows).
 *
 * Behavior:
 *   - 30 single-event payloads (D-04: N=30)
 *   - 100ms gap between calls (D-04: gapMs=100)
 *   - Bypasses the cascade, breaker, and rolling-window limiter — direct
 *     OpenAI client against OPENROUTER_BASE to measure raw provider behavior
 *   - Writes a byte-stable snapshot (sorted by attempt, ISO-Z timestamp,
 *     truncated error messages, retry-after header captured when finite)
 *   - Bucket decision per D-05:
 *       rateLimitedPct < 50   → 'restored-cascade'   (Wave 2: 30.1-02)
 *       rateLimitedPct < 90   → 'middle-bucket-defer' (Wave 2: 30.1-03)
 *       rateLimitedPct ≥ 90   → 'nim-only'            (Wave 2: 30.1-04)
 *
 * Usage:  npm run probe:openrouter
 *
 * Cost: ~15% of the 200/day free-tier daily cap. Safe to re-run once or
 * twice per planning cycle.
 *
 * Threat model (T-30.1-01): per-attempt errorMessage truncated to 200 chars;
 * ONLY `retry-after` header is captured; raw response bodies are never
 * serialized.
 */

import { writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import OpenAI from 'openai';

import { env } from '../server/config.js';
import { OPENROUTER_DEFAULT_MODEL } from '../server/lib/freeClaudeRouter.js';
import { logger } from '../server/lib/logger.js';

const log = logger.child({ module: 'probeOpenRouter' });

const __dirname = dirname(fileURLToPath(import.meta.url));

// D-04 probe constants.
const N = 30;
const GAP_MS = 100;
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const OUT_DIR = resolve(__dirname, '../.snapshots');
const OUT_PATH = resolve(OUT_DIR, '30.1-or-pulse-snapshot.json');
const TMP_PATH = resolve(OUT_DIR, '30.1-or-pulse-snapshot.json.tmp');

type AttemptStatus = 'ok' | 'rate_limit' | 'other_error';
type Decision = 'restored-cascade' | 'middle-bucket-defer' | 'nim-only';

interface AttemptResult {
  attempt: number;
  status: AttemptStatus;
  latencyMs: number;
  retryAfterMs?: number;
  errorMessage?: string;
}

interface SnapshotSummary {
  rateLimitedCount: number;
  rateLimitedPct: number;
  decision: Decision;
}

interface Snapshot {
  timestamp: string;
  n: number;
  gapMs: number;
  model: string;
  results: AttemptResult[];
  summary: SnapshotSummary;
}

/**
 * Mirrors the 429 / 'rate limit' substring check in
 * server/lib/freeClaudeRouter.ts:classifyError. 'ok' is reserved for the
 * success branch and never returned from this helper.
 */
function classifyOutcome(err: unknown): Exclude<AttemptStatus, 'ok'> {
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    if (m.includes('429') || m.includes('rate limit')) return 'rate_limit';
  }
  return 'other_error';
}

/**
 * Minimal 2-message conversation mirroring the single-event shape v3
 * produces post-Phase-30. Body is intentionally minimal — the test is
 * rate-limit behavior, not extraction quality.
 */
function singleEventPayload(): OpenAI.Chat.ChatCompletionMessageParam[] {
  return [
    {
      role: 'system',
      content: 'Return a JSON object with a single field "location".',
    },
    {
      role: 'user',
      content: 'Extract location from: Tehran airstrike 2026-05-01',
    },
  ];
}

/**
 * Read the `retry-after` header from an OpenAI APIError (case-insensitive).
 * Returns the value in milliseconds only when finite and positive; otherwise
 * undefined (so the snapshot never serializes garbage).
 */
function extractRetryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof OpenAI.APIError)) return undefined;
  const headers = err.headers as Record<string, string | undefined> | undefined;
  if (!headers) return undefined;
  const raw = headers['retry-after'] ?? headers['Retry-After'] ?? headers['RETRY-AFTER'];
  if (typeof raw !== 'string') return undefined;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed * 1000);
}

function deriveDecision(rateLimitedPct: number): Decision {
  if (rateLimitedPct < 50) return 'restored-cascade';
  if (rateLimitedPct < 90) return 'middle-bucket-defer';
  return 'nim-only';
}

async function main(): Promise<void> {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY is empty in env — set it in .env.local before running the probe',
    );
  }

  const client = new OpenAI({
    apiKey: env.OPENROUTER_API_KEY,
    baseURL: OPENROUTER_BASE,
    timeout: 30_000,
  });

  const results: AttemptResult[] = [];

  for (let attempt = 1; attempt <= N; attempt++) {
    const t0 = Date.now();
    try {
      await client.chat.completions.create({
        model: OPENROUTER_DEFAULT_MODEL,
        messages: singleEventPayload(),
        max_tokens: 256,
        response_format: { type: 'json_object' },
      });
      const latencyMs = Math.round(Date.now() - t0);
      results.push({ attempt, status: 'ok', latencyMs });
      log.info({ attempt, status: 'ok', latencyMs }, 'probe attempt complete');
    } catch (err) {
      const latencyMs = Math.round(Date.now() - t0);
      const status = classifyOutcome(err);
      const retryAfterMs = extractRetryAfterMs(err);
      const rawMessage = err instanceof Error ? err.message : String(err);
      const errorMessage = rawMessage.slice(0, 200);
      const entry: AttemptResult = { attempt, status, latencyMs, errorMessage };
      if (retryAfterMs !== undefined) entry.retryAfterMs = retryAfterMs;
      results.push(entry);
      log.warn({ attempt, status, latencyMs, retryAfterMs }, 'probe attempt failed');
    }

    if (attempt < N) {
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
  }

  results.sort((a, b) => a.attempt - b.attempt);

  const rateLimitedCount = results.filter((r) => r.status === 'rate_limit').length;
  const rateLimitedPct = Math.round((rateLimitedCount / N) * 1000) / 10;
  const decision = deriveDecision(rateLimitedPct);

  const snapshot: Snapshot = {
    timestamp: new Date().toISOString(),
    n: N,
    gapMs: GAP_MS,
    model: OPENROUTER_DEFAULT_MODEL,
    results,
    summary: { rateLimitedCount, rateLimitedPct, decision },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(TMP_PATH, JSON.stringify(snapshot, null, 2) + '\n');
  renameSync(TMP_PATH, OUT_PATH);

  console.log(JSON.stringify(snapshot.summary, null, 2));
  const nextPlan =
    snapshot.summary.decision === 'restored-cascade'
      ? '02'
      : snapshot.summary.decision === 'middle-bucket-defer'
        ? '03'
        : '04';
  console.log(
    `Decision per D-05: ${snapshot.summary.decision} → Next plan: 30.1-${nextPlan}-PLAN.md`,
  );
}

main().catch((err) => {
  console.error(err);
  try {
    if (existsSync(TMP_PATH)) unlinkSync(TMP_PATH);
  } catch {
    /* swallow */
  }
  process.exit(1);
});

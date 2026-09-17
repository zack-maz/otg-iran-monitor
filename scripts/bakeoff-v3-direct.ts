#!/usr/bin/env node
/**
 * Phase 27.4.3 Plan 03 — D-08 multi-model NVIDIA NIM bake-off (direct OpenAI SDK).
 *
 * SECOND-PASS implementation that bypasses freeClaudeRouter to avoid:
 *   - Circuit breaker contamination across models (one failing model trips the
 *     breaker for nvidia_nim wholesale, which then skips all subsequent models)
 *   - Cascading retries amplifying per-event latency beyond 75s budget
 *
 * For each candidate model, we call NVIDIA NIM directly with a 60s per-call
 * timeout, parse the response via the v3 Zod schema, run resolveLocation, and
 * haversine-compare against the GT corpus truth coords.
 *
 * Persists per-model EvalScore to Redis via runEval({model}) for the plan's
 * `events:llm-eval-baseline:v3:<sanitized-model-id>` acceptance criterion.
 */

import { readFileSync } from 'node:fs';
import { writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import OpenAI from 'openai';

import { stripReasoningBlocks } from '../server/lib/freeClaudeRouter.js';
import { runEval } from '../server/lib/llmEvalHarness.js';
import { resolveLocation, __resetThrottleForTests } from '../server/lib/llmResolver.js';
import { batchResponseV3, EVENT_EXTRACTION_SCHEMA_V3 } from '../server/lib/llmSchema.js';

import type { LocationHierarchyV2 } from '../server/lib/llmSchema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GT_PATH = resolve(__dirname, '../server/data/eval/ground-truth-events.json');
const RESULTS_PATH = '/tmp/27.4.3-03-bakeoff-direct-results.jsonl';

interface GTEvent {
  id: string;
  description: string;
  sourceUrl: string;
  truth: {
    lat: number;
    lng: number;
    precision: 'exact' | 'neighborhood' | 'city' | 'region';
    landmark?: string | null;
    country?: string | null;
    admin1?: string | null;
  };
  hierarchy: LocationHierarchyV2;
}

interface BakeoffResult {
  model: string;
  totalEvents: number;
  llmCallSuccess: number;
  llmCallTimeout: number;
  llmCallError: number;
  emptyContent: number;
  jsonParseFail: number;
  schemaFail: number;
  resolverError: number;
  within5km: number;
  within20km: number;
  within100km: number;
  ratio20km: number;
  durationMs: number;
  latencies: { p50: number; p95: number; p99: number; mean: number };
  errorPreviews: string[];
  resolverOnlyEvalScore: {
    within5km: number;
    within20km: number;
    within100km: number;
    total: number;
  } | null;
  notes: string;
}

const NVIDIA_NIM_BASE = 'https://integrate.api.nvidia.com/v1';
const PER_CALL_TIMEOUT_MS = 60_000;

// Phase 27.4.4 D-05 — instrumented preflight trace sink. Each --mode=characterize
// call appends one JSONL record per event with TTFB / gen duration / token rate /
// max_tokens hits / reasoning bytes. Operator derives the per-candidate matrix in
// 27.4.4-PREFLIGHT-CHARACTERIZATION.md from this file.
const TRACE_PATH = '/tmp/27.4.4-preflight-trace.jsonl';

// Phase 27.4.4 D-07 — per-model prompt-tuning best-bets (RESEARCH §2.3 + §2.4).
// nemotron Tier-1 baseline emits a flat object instead of the `events` array
// envelope; explicit envelope-shape demand should pull it back into compliance.
// glm4.7 Tier-1 baseline burns output budget on `<think>` blocks; disabling
// reasoning frees those tokens for the JSON envelope.
//
// Apply uniformly via the resolved {messages, extraBody} bundle below — never
// route through freeClaudeRouter (Anti-Pattern A6 — direct-SDK precision is
// load-bearing for D-02 latency measurements).
const PROMPT_OVERRIDES: Record<
  string,
  {
    systemPromptSuffix?: string;
    extraBody?: Record<string, unknown>;
    responseFormatMode?: 'json_object' | 'text';
  }
> = {
  'nvidia/nemotron-3-super-120b-a12b': {
    systemPromptSuffix:
      '\n\nIMPORTANT: Your output MUST be a single JSON object with a top-level "events" array. Example: {"events": [{"groupKey": "...", "location": {...}, ...}]}. Do NOT emit a flat object with groupKey at the top level. The "events" array wrapper is REQUIRED.',
  },
  'z-ai/glm4.7': {
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  },
};

type Mode = 'evaluate' | 'characterize';

const SYSTEM_PROMPT_BAKEOFF = [
  'You are a conflict event analyst extracting structured data from GDELT event records.',
  '',
  'For each event group, extract these fields (REQUIRED unless stated nullable):',
  '1. location: { country, admin1, city, neighborhood, landmark, confidence } — each text field NULLABLE if not supported by source. confidence is 0..1.',
  '2. type: one of "airstrike", "on_ground", "explosion", "targeted", "other"',
  '3. confidence: 0..1 overall extraction confidence',
  '4. reasoning: <=200 chars — cite which signals led to the location pick',
  '5. weaponType: one of "airstrike","drone","missile","artillery","small_arms","IED" or null',
  '6. targetType: one of "military","infrastructure","civilian","leadership" or null',
  '7. timeOfDay: UTC HH:MM (e.g., "03:15") or null',
  '8. durationMinutes: non-negative integer or null',
  '9. actors: array of actor names',
  '10. severity: "critical" | "high" | "medium" | "low"',
  '11. summary: 2-3 sentence description',
  '12. casualties: { killed: integer|null, injured: integer|null, unknown: boolean }',
  '13. sourceCount: integer',
  '',
  'Hard rules:',
  '- NEVER emit coordinates (lat/lng).',
  '- NEVER emit a "precision" field — server derives it.',
  '- Use null when a field is not supported by the source — do NOT guess.',
  '',
  'JSON Schema (your output MUST validate against this):',
  JSON.stringify(EVENT_EXTRACTION_SCHEMA_V3, null, 2),
  '',
  'Respond with ONLY a JSON object: { "events": [ { groupKey, location, type, ... } ] }',
  'Do NOT include <think> blocks; place all reasoning in the "reasoning" field.',
].join('\n');

function buildUserPromptForGT(ev: GTEvent): string {
  return [
    'Analyze this conflict event report and extract structured data:',
    '',
    `--- Event Group 1 (key: ${ev.id}) ---`,
    'Date: 2026-04-01',
    'CAMEO Code: 195',
    `Location (GDELT ActionGeo): ${ev.truth.country ?? 'unknown'}`,
    'Total Mentions: 5, Total Sources: 3',
    `Source URL: ${ev.sourceUrl}`,
    '',
    '--- NEWS BLOCK ---',
    `[T1] ${ev.description.slice(0, 280)}`,
    '',
    'Return JSON: { "events": [ { "groupKey": "' + ev.id + '", "location": {...}, ... } ] }',
  ].join('\n');
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[idx] ?? 0;
}

async function bakeoffOne(
  model: string,
  events: GTEvent[],
  mode: Mode = 'evaluate',
): Promise<BakeoffResult> {
  console.error(`\n=== bake-off (direct, mode=${mode}): ${model} (${events.length} events) ===`);
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_NIM_API_KEY not set');
  const client = new OpenAI({
    apiKey,
    baseURL: NVIDIA_NIM_BASE,
    timeout: PER_CALL_TIMEOUT_MS,
    maxRetries: 0, // Bake-off needs precise per-call latency; disable SDK retries (default is 2).
  });

  // Phase 27.4.4 D-07 — resolve per-model prompt overrides once per bake-off run.
  // PROMPT_OVERRIDES contains nemotron envelope-shape demand + glm4.7 thinking-disable.
  const override = PROMPT_OVERRIDES[model] ?? {};
  const systemPrompt = override.systemPromptSuffix
    ? SYSTEM_PROMPT_BAKEOFF + override.systemPromptSuffix
    : SYSTEM_PROMPT_BAKEOFF;
  const responseFormat: { type: 'json_object' | 'text' } = {
    type: override.responseFormatMode ?? 'json_object',
  };

  // EARLY-ABORT: if first 3 calls all hard-fail (timeout / 5xx / null content),
  // skip the remaining 7 events and mark the model unfit. Saves ~10 min per
  // unfit candidate without sacrificing decision signal.
  let consecHardFail = 0;
  const HARD_FAIL_LIMIT = 3;

  const t0 = Date.now();
  const latencies: number[] = [];
  let llmCallSuccess = 0;
  let llmCallTimeout = 0;
  let llmCallError = 0;
  let emptyContent = 0;
  let jsonParseFail = 0;
  let schemaFail = 0;
  let resolverError = 0;
  let w5 = 0;
  let w20 = 0;
  let w100 = 0;
  const errorPreviews: string[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;

    if (consecHardFail >= HARD_FAIL_LIMIT) {
      // Skip remaining events for unfit model — record skip reason once.
      console.error(
        `  [${i + 1}/${events.length}] ${ev.id} — SKIPPED (early-abort: ${consecHardFail} consec hard-fails)`,
      );
      llmCallError++;
      continue;
    }

    const evStart = Date.now();
    let raw: string | null = null;
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), PER_CALL_TIMEOUT_MS);
    try {
      if (mode === 'characterize') {
        // Phase 27.4.4 D-05 — instrumented streaming path.
        // stream_options.include_usage attaches a final chunk with usage stats.
        // We capture firstByteTs on first chunk, accumulate raw delta, capture
        // finish_reason + usage from final chunk, then append a per-call telemetry
        // record to TRACE_PATH for operator-side derivation of the per-candidate
        // matrix in 27.4.4-PREFLIGHT-CHARACTERIZATION.md.
        const streamArgs: Record<string, unknown> = {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: buildUserPromptForGT(ev) },
          ],
          response_format: responseFormat,
          temperature: 0,
          stream: true,
          stream_options: { include_usage: true },
        };
        if (override.extraBody) {
          streamArgs.extra_body = override.extraBody;
        }
        const stream = await client.chat.completions.create(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          streamArgs as any,
          { signal: ac.signal },
        );
        let firstByteTs: number | null = null;
        let acc = '';
        let usage: { completion_tokens?: number; prompt_tokens?: number } | null = null;
        let finishReason: string | null = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const chunk of stream as any) {
          if (firstByteTs === null) firstByteTs = Date.now();
          const delta = chunk?.choices?.[0]?.delta?.content ?? '';
          if (delta) acc += delta;
          if (chunk?.choices?.[0]?.finish_reason) {
            finishReason = chunk.choices[0].finish_reason;
          }
          if (chunk?.usage) usage = chunk.usage;
        }
        raw = acc || null;
        const totalLatencyMs = Date.now() - evStart;
        const ttfbMs = firstByteTs !== null ? firstByteTs - evStart : null;
        const genDurationMs = firstByteTs !== null ? Date.now() - firstByteTs : null;
        const tokensOut = usage?.completion_tokens ?? null;
        const emissionRateTps =
          genDurationMs && tokensOut
            ? Number((tokensOut / (genDurationMs / 1000)).toFixed(2))
            : null;
        const reasoningMatches = (acc || '').match(/<think>[\s\S]*?<\/think>/g);
        const reasoningBytes = reasoningMatches
          ? reasoningMatches.reduce((s, m) => s + m.length, 0)
          : 0;
        appendFileSync(
          TRACE_PATH,
          JSON.stringify({
            timestamp: new Date().toISOString(),
            model,
            eventId: ev.id,
            ttfbMs,
            genDurationMs,
            totalLatencyMs,
            tokensOut,
            emissionRateTps,
            reasoningBytes,
            finishReason,
            promptOverrideApplied: !!(override.systemPromptSuffix || override.extraBody),
          }) + '\n',
        );
      } else {
        // Default 'evaluate' path — non-streaming, preserves existing 27.4.3 latency
        // measurement shape verbatim. A6 invariant: direct-SDK call, no router.
        const completionArgs: Record<string, unknown> = {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: buildUserPromptForGT(ev) },
          ],
          response_format: responseFormat,
          temperature: 0,
        };
        if (override.extraBody) {
          completionArgs.extra_body = override.extraBody;
        }
        const completion = await client.chat.completions.create(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          completionArgs as any,
          { signal: ac.signal },
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        raw = (completion as any).choices?.[0]?.message?.content ?? null;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const evLatency = Date.now() - evStart;
      latencies.push(evLatency);
      if (
        msg.toLowerCase().includes('timeout') ||
        msg.toLowerCase().includes('timed out') ||
        msg.toLowerCase().includes('aborted')
      ) {
        llmCallTimeout++;
      } else {
        llmCallError++;
      }
      errorPreviews.push(`${ev.id}: ${msg.slice(0, 200)}`);
      console.error(
        `  [${i + 1}/${events.length}] ${ev.id} — call ERROR after ${evLatency}ms: ${msg.slice(0, 100)}`,
      );
      consecHardFail++;
      continue;
    } finally {
      clearTimeout(abortTimer);
    }

    const evLatency = Date.now() - evStart;
    latencies.push(evLatency);
    llmCallSuccess++;
    consecHardFail = 0; // Network call succeeded — reset early-abort counter.

    const stripped = stripReasoningBlocks(raw);
    if (!stripped || stripped.trim() === '') {
      emptyContent++;
      errorPreviews.push(`${ev.id}: empty content (raw len=${raw?.length ?? 0})`);
      console.error(`  [${i + 1}/${events.length}] ${ev.id} — empty content (${evLatency}ms)`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch (jsonErr) {
      jsonParseFail++;
      errorPreviews.push(
        `${ev.id}: JSON.parse — ${(jsonErr as Error).message.slice(0, 120)} (preview: ${stripped.slice(0, 80)})`,
      );
      console.error(`  [${i + 1}/${events.length}] ${ev.id} — JSON parse fail (${evLatency}ms)`);
      continue;
    }

    const validated = batchResponseV3.safeParse(parsed);
    if (!validated.success) {
      schemaFail++;
      const issues = validated.error.issues
        .slice(0, 2)
        .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
        .join('; ');
      errorPreviews.push(`${ev.id}: Zod fail — ${issues.slice(0, 200)}`);
      console.error(
        `  [${i + 1}/${events.length}] ${ev.id} — Zod fail (${evLatency}ms): ${issues.slice(0, 80)}`,
      );
      continue;
    }

    const llmEvent = validated.data.events[0];
    if (!llmEvent) {
      schemaFail++;
      errorPreviews.push(`${ev.id}: empty events array`);
      continue;
    }

    let resolved;
    try {
      resolved = await resolveLocation(llmEvent.location, {
        centroidLat: ev.truth.lat,
        centroidLng: ev.truth.lng,
      });
    } catch (resolverErr) {
      resolverError++;
      errorPreviews.push(`${ev.id}: resolver — ${(resolverErr as Error).message.slice(0, 120)}`);
      console.error(`  [${i + 1}/${events.length}] ${ev.id} — resolver error`);
      continue;
    }

    const distKm = haversineKm(resolved.lat, resolved.lng, ev.truth.lat, ev.truth.lng);
    if (distKm <= 5) w5++;
    if (distKm <= 20) w20++;
    if (distKm <= 100) w100++;

    console.error(
      `  [${i + 1}/${events.length}] ${ev.id} — ok in ${evLatency}ms, dist=${distKm.toFixed(1)}km (${resolved.provenance})`,
    );
  }

  const durationMs = Date.now() - t0;
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const meanLat =
    latencies.length > 0 ? Math.round(latencies.reduce((s, x) => s + x, 0) / latencies.length) : 0;

  const ratio = events.length > 0 ? w20 / events.length : 0;

  let resolverOnlyEvalScore = null;
  try {
    __resetThrottleForTests();
    resolverOnlyEvalScore = await runEval({ model });
    console.error(
      `  resolver-only baseline persisted: ${resolverOnlyEvalScore.within20km}/${resolverOnlyEvalScore.total}`,
    );
  } catch (err) {
    console.error(`  runEval failed: ${(err as Error).message.slice(0, 120)}`);
  }

  return {
    model,
    totalEvents: events.length,
    llmCallSuccess,
    llmCallTimeout,
    llmCallError,
    emptyContent,
    jsonParseFail,
    schemaFail,
    resolverError,
    within5km: w5,
    within20km: w20,
    within100km: w100,
    ratio20km: Number(ratio.toFixed(3)),
    durationMs,
    latencies: {
      p50: quantile(sortedLat, 0.5),
      p95: quantile(sortedLat, 0.95),
      p99: quantile(sortedLat, 0.99),
      mean: meanLat,
    },
    errorPreviews: errorPreviews.slice(0, 6),
    resolverOnlyEvalScore,
    notes: '',
  };
}

async function main(): Promise<void> {
  const modelsArg = process.argv.find((a) => a.startsWith('--models='));
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const modeArg = process.argv.find((a) => a.startsWith('--mode='));
  if (!modelsArg) {
    console.error(
      'Usage: tsx scripts/bakeoff-v3-direct.ts --models=<m1>,<m2>,... [--limit=N] [--mode=evaluate|characterize]',
    );
    process.exit(1);
  }
  const models = modelsArg
    .split('=')[1]!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const limit = limitArg ? parseInt(limitArg.split('=')[1]!, 10) : 10;
  const modeRaw = modeArg ? modeArg.split('=')[1] : 'evaluate';
  if (modeRaw !== 'evaluate' && modeRaw !== 'characterize') {
    console.error('--mode must be "evaluate" or "characterize"');
    process.exit(1);
  }
  const mode: Mode = modeRaw;

  const gtRaw = readFileSync(GT_PATH, 'utf-8');
  const gtFile = JSON.parse(gtRaw) as { events: GTEvent[] };
  const allEvents = gtFile.events.slice(0, limit);

  console.error(
    `Bake-off (direct OpenAI SDK, mode=${mode}): ${models.length} models × ${allEvents.length} GT events`,
  );
  console.error(`Models: ${models.join(', ')}`);
  console.error(`Per-call timeout: ${PER_CALL_TIMEOUT_MS}ms`);
  if (mode === 'characterize') {
    // Phase 27.4.4 D-05 — fresh trace file per characterize run.
    writeFileSync(TRACE_PATH, '');
    console.error(`Preflight trace sink: ${TRACE_PATH}`);
  }
  console.error('');

  writeFileSync(RESULTS_PATH, '');

  const results: BakeoffResult[] = [];
  for (const model of models) {
    const r = await bakeoffOne(model, allEvents, mode);
    results.push(r);
    appendFileSync(RESULTS_PATH, JSON.stringify(r) + '\n');
    console.error(
      `\n>>> ${model}: within5km=${r.within5km}/${r.totalEvents}, within20km=${r.within20km}/${r.totalEvents}, within100km=${r.within100km}/${r.totalEvents} (ratio=${r.ratio20km})`,
    );
    console.error(
      `    llm_ok=${r.llmCallSuccess}, timeout=${r.llmCallTimeout}, err=${r.llmCallError}, empty=${r.emptyContent}, json_fail=${r.jsonParseFail}, schema_fail=${r.schemaFail}`,
    );
    console.error(
      `    p50=${r.latencies.p50}ms p95=${r.latencies.p95}ms mean=${r.latencies.mean}ms duration=${r.durationMs}ms`,
    );
  }

  console.error('\n=== SCOREBOARD ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

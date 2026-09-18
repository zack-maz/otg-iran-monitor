#!/usr/bin/env node
/**
 * Phase 27.4.3 Plan 03 — D-08 multi-model NVIDIA NIM bake-off harness.
 *
 * For each candidate model:
 *   1. Iterate through the 50-event ground-truth corpus
 *      (server/data/eval/ground-truth-events.json).
 *   2. For each GT event, build a synthetic GDELT-shaped user prompt seeded
 *      from the event description and invoke freeClaudeRouter.callLLM with
 *      `modelOverride: <candidate>` so the cascade routes to NVIDIA NIM.
 *   3. Parse the JSON response, run it through batchResponseV3 (Zod) to
 *      extract the LLM-emitted location hierarchy.
 *   4. Pass the LLM hierarchy through resolveLocation() to produce coords.
 *   5. Haversine vs ground-truth lat/lng → bucket counts (5 / 20 / 100 km).
 *   6. Capture: per-distance scores, latency stats, JSON parse failures,
 *      schema-fail counts, watchdog timeouts, total run duration.
 *   7. Persist per-model EvalScore to events:llm-eval-baseline:v3:<sanitized>
 *      via runEval({model}) (RESOLVER-ONLY — provides the GT-against-resolver
 *      sanity floor; the full LLM-pipeline score above is the bake-off
 *      discriminator).
 *
 * Output: JSON results to stdout + machine-readable scoreboard appended to
 * /tmp/27.4.3-03-bakeoff-results.jsonl for BAKEOFF.md ingestion.
 *
 * Usage:
 *   tsx scripts/bakeoff-v3.ts --models=moonshotai/kimi-k2.5,z-ai/glm4.7,meta/llama-3.3-70b-instruct
 *   tsx scripts/bakeoff-v3.ts --models=moonshotai/kimi-k2.5 --limit=5  # quick smoke
 */

import { readFileSync } from 'node:fs';
import { writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { callLLM } from '../server/lib/freeClaudeRouter.js';
import { runEval } from '../server/lib/llmEvalHarness.js';
import { resolveLocation, __resetThrottleForTests } from '../server/lib/llmResolver.js';
import { batchResponseV3, EVENT_EXTRACTION_SCHEMA_V3 } from '../server/lib/llmSchema.js';

import type { LocationHierarchyV2 } from '../server/lib/llmSchema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GT_PATH = resolve(__dirname, '../server/data/eval/ground-truth-events.json');
const RESULTS_PATH = '/tmp/27.4.3-03-bakeoff-results.jsonl';

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

interface GTFile {
  events: GTEvent[];
}

interface BakeoffResult {
  model: string;
  totalEvents: number;
  attempted: number;
  llmCallSuccess: number;
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
  watchdogTimeouts: number;
  notes: string;
}

const SYSTEM_PROMPT_BAKEOFF = [
  'You are a conflict event analyst extracting structured data from GDELT event records.',
  '',
  'For each event group, extract (all fields REQUIRED unless stated nullable):',
  '1. location: A structured place hierarchy — each field NULLABLE when the source text does not support it:',
  '   - country: full English name (e.g., "Iran", "Iraq") or null',
  '   - admin1: province / state / governorate name or null',
  '   - city: city or town name or null',
  '   - neighborhood: neighborhood / district / suburb name or null',
  '   - landmark: specific facility / site name (e.g., "Natanz nuclear facility") or null',
  '   - confidence: number between 0 and 1 indicating how confident you are in this location',
  '2. type: one of "airstrike", "on_ground", "explosion", "targeted", "other"',
  '3. confidence: number between 0 and 1 for overall extraction confidence',
  '4. reasoning: <=200 characters — cite which signals led to the location pick (news source, Bellingcat, GDELT metadata, etc.)',
  '5. weaponType: one of "airstrike","drone","missile","artillery","small_arms","IED", or null if not stated',
  '6. targetType: one of "military","infrastructure","civilian","leadership", or null if not stated',
  '7. timeOfDay: UTC HH:MM (e.g., "03:15") if the source mentions a specific strike time, else null',
  '8. durationMinutes: non-negative integer if the source mentions duration, else null',
  '9. actors: array of actor names involved',
  '10. severity: "critical" | "high" | "medium" | "low"',
  '11. summary: 2-3 sentence description of what happened',
  '12. casualties: { killed: integer | null, injured: integer | null, unknown: boolean }',
  '13. sourceCount: integer — count of independent sources',
  '',
  'Hard rules:',
  '- NEVER emit coordinates (lat/lng). Only output place names.',
  '- NEVER emit a "precision" field — the server derives it from which hierarchy fields you populated.',
  '- Use null when a field is not supported by the source text — do NOT guess.',
  '',
  'JSON Schema (this is the contract — your output MUST validate):',
  JSON.stringify(EVENT_EXTRACTION_SCHEMA_V3, null, 2),
  '',
  '- Output ONLY the JSON object. Any reasoning must go in the "reasoning" field, not in <think> blocks (those are stripped).',
].join('\n');

function buildUserPromptForGT(ev: GTEvent): string {
  return [
    'Analyze this conflict event report and extract structured data:',
    '',
    `--- Event Group 1 (key: ${ev.id}) ---`,
    'Date: 2026-04-01',
    'CAMEO Code: 195',
    `Location (GDELT ActionGeo): ${ev.truth.country ?? 'unknown'}`,
    'Actors: Unknown vs Unknown',
    'Goldstein Scale: -10',
    'Total Mentions: 5, Total Sources: 3',
    'Rows in group: 1',
    `Source URLs: ${ev.sourceUrl}`,
    '',
    '--- NEWS BLOCK (tier-tagged) ---',
    `[T1] ${ev.description.slice(0, 240)}`,
    '',
    'Return a JSON object with the shape: { events: [{ groupKey, location, type, confidence, reasoning, weaponType, targetType, timeOfDay, durationMinutes, actors, severity, summary, casualties, sourceCount }] }',
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

async function bakeoffOne(model: string, events: GTEvent[]): Promise<BakeoffResult> {
  console.error(`\n=== bake-off: ${model} (${events.length} events) ===`);
  const t0 = Date.now();
  const latencies: number[] = [];
  let llmCallSuccess = 0;
  let jsonParseFail = 0;
  let schemaFail = 0;
  let resolverError = 0;
  let w5 = 0;
  let w20 = 0;
  let w100 = 0;
  let watchdogTimeouts = 0;
  const errorPreviews: string[] = [];

  // Per-event hard cap to keep wall-clock bounded across slow models.
  // 75s per event × 10 events × 3 models ≈ 38min worst case.
  const PER_EVENT_TIMEOUT_MS = 75_000;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;
    const evStart = Date.now();
    let llmResult;
    try {
      llmResult = await Promise.race([
        callLLM(
          [
            { role: 'system', content: SYSTEM_PROMPT_BAKEOFF },
            { role: 'user', content: buildUserPromptForGT(ev) },
          ],
          JSON.stringify(EVENT_EXTRACTION_SCHEMA_V3),
          { batchSize: 1, modelOverride: model },
        ),
        new Promise<never>((_, rej) =>
          setTimeout(
            () => rej(new Error(`bakeoff per-event timeout ${PER_EVENT_TIMEOUT_MS}ms`)),
            PER_EVENT_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('timeout')) watchdogTimeouts++;
      errorPreviews.push(`${ev.id}: callLLM threw — ${msg.slice(0, 200)}`);
      const evLatency = Date.now() - evStart;
      latencies.push(evLatency);
      console.error(
        `  [${i + 1}/${events.length}] ${ev.id} — callLLM ERROR after ${evLatency}ms: ${msg.slice(0, 100)}`,
      );
      continue;
    }
    const evLatency = Date.now() - evStart;
    latencies.push(evLatency);

    if (!llmResult.content) {
      const reason = llmResult.routing.map((r) => `${r.provider}:${r.reason}`).join(' → ');
      errorPreviews.push(`${ev.id}: null content (${reason})`);
      console.error(`  [${i + 1}/${events.length}] ${ev.id} — null content (${reason})`);
      continue;
    }

    llmCallSuccess++;

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(llmResult.content);
    } catch (jsonErr) {
      jsonParseFail++;
      errorPreviews.push(
        `${ev.id}: JSON.parse failed — ${(jsonErr as Error).message.slice(0, 120)}`,
      );
      console.error(`  [${i + 1}/${events.length}] ${ev.id} — JSON parse fail`);
      continue;
    }

    // Zod-validate
    const validated = batchResponseV3.safeParse(parsed);
    if (!validated.success) {
      schemaFail++;
      const issues = validated.error.issues
        .slice(0, 2)
        .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
        .join('; ');
      errorPreviews.push(`${ev.id}: Zod fail — ${issues.slice(0, 200)}`);
      console.error(`  [${i + 1}/${events.length}] ${ev.id} — Zod fail`);
      continue;
    }

    const llmEvent = validated.data.events[0];
    if (!llmEvent) {
      schemaFail++;
      errorPreviews.push(`${ev.id}: empty events array`);
      continue;
    }

    // Resolve LLM hierarchy via the same resolver the production pipeline uses
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
      `  [${i + 1}/${events.length}] ${ev.id} — ok in ${evLatency}ms, dist=${distKm.toFixed(1)}km (provenance=${resolved.provenance})`,
    );
  }

  const durationMs = Date.now() - t0;
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const meanLat =
    latencies.length > 0 ? Math.round(latencies.reduce((s, x) => s + x, 0) / latencies.length) : 0;

  const ratio = events.length > 0 ? w20 / events.length : 0;

  // Persist resolver-only baseline (matches plan acceptance criterion for
  // events:llm-eval-baseline:v3:<sanitized-model-id> Redis key population).
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
    attempted: events.length,
    llmCallSuccess,
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
    errorPreviews: errorPreviews.slice(0, 5),
    resolverOnlyEvalScore,
    watchdogTimeouts,
    notes: '',
  };
}

async function main(): Promise<void> {
  const modelsArg = process.argv.find((a) => a.startsWith('--models='));
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  if (!modelsArg) {
    console.error('Usage: tsx scripts/bakeoff-v3.ts --models=<m1>,<m2>,... [--limit=N]');
    process.exit(1);
  }
  const models = modelsArg
    .split('=')[1]!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const limit = limitArg ? parseInt(limitArg.split('=')[1]!, 10) : Infinity;

  const gtRaw = readFileSync(GT_PATH, 'utf-8');
  const gtFile = JSON.parse(gtRaw) as GTFile;
  const allEvents = gtFile.events.slice(0, limit);

  console.error(`Bake-off: ${models.length} models × ${allEvents.length} GT events`);
  console.error(`Models: ${models.join(', ')}`);

  // Truncate results file
  writeFileSync(RESULTS_PATH, '');

  const results: BakeoffResult[] = [];
  for (const model of models) {
    const r = await bakeoffOne(model, allEvents);
    results.push(r);
    appendFileSync(RESULTS_PATH, JSON.stringify(r) + '\n');
    console.error(
      `\n>>> ${model}: ${r.within20km}/${r.totalEvents} within20km (ratio=${r.ratio20km}), llm_ok=${r.llmCallSuccess}, schema_fail=${r.schemaFail}, json_fail=${r.jsonParseFail}, p50=${r.latencies.p50}ms`,
    );
  }

  console.error('\n=== SCOREBOARD ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

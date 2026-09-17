#!/usr/bin/env node
/**
 * Phase 27.4.4 Plan 01 Task 11 (D-19) — forensic snapshot of the v3 LLM
 * pipeline's Redis state.
 *
 * Reads 6 v3 observability keys, dispatches each by its native datatype, and
 * writes a single timestamped JSON file under the phase directory so Plan 02
 * Gate B passes can be diffed against earlier snapshots when investigating
 * latency / fallback / pipeline-flip regressions.
 *
 * Keys captured (per RESEARCH §6 + HANDOFF Task 11):
 *   1. events:llm:v3                          GET (terminal cache; ConflictEventEntity[] envelope)
 *   2. events:llm:v3:lineage:<eventId>        KEYS+HGETALL (per-event lineage HSETs)
 *   3. events:llm-pipeline-audit              LRANGE 0 -1 (auto-rollback audit log)
 *   4. events:llm-dlq                         SMEMBERS (bounded set of DLQ entries)
 *   5. events:llm-eval-baseline:v3:*          KEYS+GET (per-model eval baselines)
 *
 * Phase 35 D-12 (SIMPLIFY-02): events:llm:v3:partial removed from this snapshot
 * after the writer was retired. Existing snapshot JSON files in
 * .planning/phases/27.4.4-* still contain the legacy field for historical record.
 *
 * Usage:
 *   npm run snapshot:v3 -- --label=<name> [--prod-confirm]
 *
 *   --label=<name>      Required. Output written to
 *                       .planning/phases/27.4.4-v3-latency-remediation-and-cutover/<name>.json
 *   --prod-confirm      Required when env.CACHE_KEY_PREFIX is empty/unset.
 *                       Defense-in-depth gate so an accidental dev invocation
 *                       can't commit a prod-tier snapshot — see RESEARCH §6
 *                       Option C. Dev runs (CACHE_KEY_PREFIX=dev:) auto-pass.
 *
 * The script uses the wrapped `redis` instance from server/cache/redis.ts so
 * CACHE_KEY_PREFIX is honored automatically: a dev run with
 * CACHE_KEY_PREFIX=dev: snapshots the dev keys; a prod run with no prefix
 * snapshots the live prod keys.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redis } from '../server/cache/redis.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PHASE_DIR = resolve(__dirname, '../.snapshots');

interface SnapshotPayload {
  label: string;
  capturedAt: string;
  cacheKeyPrefix: string;
  keys: {
    'events:llm:v3': unknown;
    'events:llm:v3:lineage': Record<string, unknown>;
    'events:llm-pipeline-audit': unknown;
    'events:llm-dlq': unknown;
    'events:llm-eval-baseline:v3': Record<string, unknown>;
  };
}

function parseArgs(): { label: string; prodConfirm: boolean } {
  const labelArg = process.argv.find((a) => a.startsWith('--label='));
  const label = labelArg?.split('=')[1];
  if (!label) {
    console.error('error: --label=<name> is required');
    console.error('usage: npm run snapshot:v3 -- --label=<name> [--prod-confirm]');
    process.exit(2);
  }
  if (label.includes('/') || label.includes('..')) {
    console.error('error: --label cannot contain "/" or ".."');
    process.exit(2);
  }
  const prodConfirm = process.argv.includes('--prod-confirm');
  return { label, prodConfirm };
}

async function captureLineage(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const keys = (await redis.keys('events:llm:v3:lineage:*')) ?? [];
    for (const key of keys) {
      // The LRU index sits at events:llm:v3:lineage-keys (sorted set, NOT hash);
      // skip it explicitly so hgetall doesn't barf.
      if (key.endsWith(':lineage-keys')) continue;
      out[key] = await redis.hgetall(key).catch(() => null);
    }
  } catch (err) {
    out['__error__'] = err instanceof Error ? err.message : String(err);
  }
  return out;
}

async function captureBaselines(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const keys = (await redis.keys('events:llm-eval-baseline:v3*')) ?? [];
    for (const key of keys) {
      out[key] = await redis.get(key).catch(() => null);
    }
  } catch (err) {
    out['__error__'] = err instanceof Error ? err.message : String(err);
  }
  return out;
}

async function safeGet(key: string): Promise<unknown> {
  try {
    return await redis.get(key);
  } catch (err) {
    return { __error__: err instanceof Error ? err.message : String(err) };
  }
}

async function safeLrange(key: string): Promise<unknown> {
  try {
    return await redis.lrange(key, 0, -1);
  } catch (err) {
    return { __error__: err instanceof Error ? err.message : String(err) };
  }
}

async function safeSmembers(key: string): Promise<unknown> {
  try {
    return await redis.smembers(key);
  } catch (err) {
    return { __error__: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const { label, prodConfirm } = parseArgs();
  const cacheKeyPrefix = process.env.CACHE_KEY_PREFIX ?? '';

  // D-19 Option C — refuse prod-tier snapshots without explicit confirmation.
  if (!cacheKeyPrefix && !prodConfirm) {
    console.error(
      'error: env.CACHE_KEY_PREFIX is empty (production tier) — re-run with --prod-confirm to acknowledge',
    );
    process.exit(2);
  }

  const [terminal, audit, dlq, lineage, baselines] = await Promise.all([
    safeGet('events:llm:v3'),
    safeLrange('events:llm-pipeline-audit'),
    safeSmembers('events:llm-dlq'),
    captureLineage(),
    captureBaselines(),
  ]);

  const payload: SnapshotPayload = {
    label,
    capturedAt: new Date().toISOString(),
    cacheKeyPrefix,
    keys: {
      'events:llm:v3': terminal,
      'events:llm:v3:lineage': lineage,
      'events:llm-pipeline-audit': audit,
      'events:llm-dlq': dlq,
      'events:llm-eval-baseline:v3': baselines,
    },
  };

  if (!existsSync(PHASE_DIR)) {
    mkdirSync(PHASE_DIR, { recursive: true });
  }
  const outPath = resolve(PHASE_DIR, `${label}.json`);
  writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  const summary = {
    label,
    cacheKeyPrefix: cacheKeyPrefix || '(prod)',
    out: outPath.replace(`${process.cwd()}/`, ''),
    counts: {
      terminal:
        typeof terminal === 'object' && terminal !== null
          ? 'present'
          : terminal === null
            ? 'null'
            : typeof terminal,
      partial:
        typeof partial === 'object' && partial !== null
          ? 'present'
          : partial === null
            ? 'null'
            : typeof partial,
      auditEntries: Array.isArray(audit) ? audit.length : 'n/a',
      dlqEntries: Array.isArray(dlq) ? dlq.length : 'n/a',
      lineageEntries: Object.keys(lineage).length,
      baselineEntries: Object.keys(baselines).length,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('snapshot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * Model probe — `GET /api/cron/llm-probe?models=<id>,<id>`.
 *
 * Sends ONE production-shaped v3 batch (the real system prompt, two live GDELT
 * groups, JSON mode) to each candidate NVIDIA NIM model and reports HTTP
 * status, latency, finish_reason and whether the reply parses and passes the
 * v3 Zod schema.
 *
 * Why it exists: NIM retires free-tier models on a schedule (a retired id
 * answers 410 forever) and every Production secret is write-only in Vercel, so
 * a candidate cannot be tried locally. A full extraction run costs up to 800 s
 * and says nothing until the end; this answers "is this model usable?" in one
 * call per model. It writes nothing and bypasses the router, so a failing
 * candidate cannot pollute the breaker or the rate window.
 *
 * Auth: Bearer CRON_SECRET, same gate as the other cron routes. With no
 * `models` param it probes the configured production model.
 */

import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';
import OpenAI from 'openai';

import { cacheGetSafe } from '../cache/redis.js';
import { env } from '../config.js';
import { dedupHighConfidence, groupGdeltRows } from '../lib/eventGrouping.js';
import {
  NVIDIA_NIM_BASE,
  NVIDIA_NIM_DEFAULT_MODEL,
  stripReasoningBlocks,
} from '../lib/freeClaudeRouter.js';
import { SYSTEM_PROMPT_V3, buildBatchUserPromptV3 } from '../lib/llmEventExtractor.v3.js';
import { batchResponseV3 } from '../lib/llmSchema.js';
import { logger } from '../lib/logger.js';
import { EVENTS_KEY } from '../lib/rawEventsRefresh.js';

import type { ConflictEventEntity } from '../types.js';

const log = logger.child({ module: 'llm-probe-cron' });

const PROBE_TIMEOUT_MS = 90_000;
const PROBE_MAX_MODELS = 8;
const PROBE_MAX_TOKENS = 2048;
const PROBE_GROUPS = 2;

interface ProbeResult {
  model: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  finishReason: string | null;
  tokensOut: number | null;
  jsonParsed: boolean;
  schemaValid: boolean;
  eventCount: number;
  error: string | null;
}

export const llmProbeCronRouter = Router();

async function probeModel(client: OpenAI, model: string, userPrompt: string): Promise<ProbeResult> {
  const t0 = Date.now();
  const result: ProbeResult = {
    model,
    ok: false,
    status: null,
    latencyMs: 0,
    finishReason: null,
    tokensOut: null,
    jsonParsed: false,
    schemaValid: false,
    eventCount: 0,
    error: null,
  };
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT_V3 },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: PROBE_MAX_TOKENS,
    });
    result.status = 200;
    const choice = res.choices[0];
    result.finishReason = choice?.finish_reason ?? null;
    result.tokensOut = res.usage?.completion_tokens ?? null;
    const reasoning = (choice?.message as { reasoning_content?: string } | undefined)
      ?.reasoning_content;
    const content = stripReasoningBlocks(choice?.message?.content ?? null, reasoning);
    if (content) {
      try {
        const parsed: unknown = JSON.parse(content);
        result.jsonParsed = true;
        const checked = batchResponseV3.safeParse(parsed);
        result.schemaValid = checked.success;
        if (checked.success) result.eventCount = checked.data.events.length;
        else result.error = checked.error.issues[0]?.message ?? 'schema_invalid';
      } catch {
        result.error = `json_parse_failed: ${content.slice(0, 120)}`;
      }
    } else {
      result.error = 'empty_content';
    }
    result.ok = result.schemaValid;
  } catch (err) {
    result.status = (err as { status?: number }).status ?? null;
    result.error = (err instanceof Error ? err.message : String(err)).slice(0, 240);
  }
  result.latencyMs = Date.now() - t0;
  return result;
}

llmProbeCronRouter.get('/', async (req, res) => {
  if (env.CRON_SECRET) {
    const auth = req.header('Authorization') ?? req.header('authorization') ?? '';
    const expected = `Bearer ${env.CRON_SECRET}`;
    const a = Buffer.from(auth);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }

  if (!env.NVIDIA_NIM_API_KEY) {
    res.status(200).json({ ok: false, reason: 'llm_unconfigured' });
    return;
  }

  const modelsParam = typeof req.query.models === 'string' ? req.query.models : '';
  const requested = modelsParam
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, PROBE_MAX_MODELS);
  const models = requested.length > 0 ? requested : [NVIDIA_NIM_DEFAULT_MODEL];

  const raw = await cacheGetSafe<ConflictEventEntity[]>(EVENTS_KEY, 999_999_999);
  const groups = groupGdeltRows(dedupHighConfidence(raw?.data ?? [])).slice(0, PROBE_GROUPS);
  if (groups.length === 0) {
    res.status(200).json({ ok: false, reason: 'no_raw_events' });
    return;
  }
  const userPrompt = buildBatchUserPromptV3(
    groups.map((group) => ({ group, matchedNews: [], bellingcatHits: [], temporalEvents: [] })),
  );

  // maxRetries: 0 — the SDK's hidden retries would mask a 429 and triple the latency.
  const client = new OpenAI({
    apiKey: env.NVIDIA_NIM_API_KEY,
    baseURL: NVIDIA_NIM_BASE,
    timeout: PROBE_TIMEOUT_MS,
    maxRetries: 0,
  });

  // Parallel: probes are independent and the whole call must fit one request.
  const results = await Promise.all(models.map((m) => probeModel(client, m, userPrompt)));
  log.info({ results }, 'llm probe complete');
  res.status(200).json({ ok: true, groups: groups.length, results });
});

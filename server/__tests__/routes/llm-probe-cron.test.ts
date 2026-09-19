// @vitest-environment node
/**
 * `GET /api/cron/llm-probe?models=a,b` — try candidate NIM models with the
 * production key.
 *
 * NIM retires free-tier models on a schedule and every Production secret is
 * write-only, so a replacement can only be tried from production. The probe
 * sends one production-shaped batch per candidate and reports status, latency
 * and schema validity. It must be safe to call at any time: same Bearer gate
 * as the other cron routes, no cache writes, and a failing candidate is a row
 * in the report, never a failed request.
 */

import { Router } from 'express';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ConflictEventEntity } from '../../types.js';

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    CRON_SECRET: '',
    NVIDIA_NIM_API_KEY: 'nvapi-test',
    OPENROUTER_API_KEY: '',
    LLM_BATCH_SIZE: 2,
    LLM_BATCH_TIMEOUT_MS: 90_000,
    LLM_V3_CONCURRENCY: 1,
  },
}));
vi.mock('../../config.js', () => ({ env: mockEnv }));

const createMock = vi.fn();
const clientOptions: Array<Record<string, unknown>> = [];
vi.mock('openai', () => {
  class MockOpenAI {
    chat = { completions: { create: (...args: unknown[]) => createMock(...args) } };
    constructor(opts: Record<string, unknown>) {
      clientOptions.push(opts);
    }
  }
  return { default: MockOpenAI };
});

const cacheGetSafeMock = vi.fn();
const cacheSetSafeMock = vi.fn();
const cacheSetReportedMock = vi.fn();
vi.mock('../../cache/redis.js', () => ({
  cacheGetSafe: (...args: unknown[]) => cacheGetSafeMock(...args),
  cacheSetSafe: (...args: unknown[]) => cacheSetSafeMock(...args),
  cacheSetReported: (...args: unknown[]) => cacheSetReportedMock(...args),
  redis: {},
}));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

function createReqRes(headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const req = {
    headers: lower,
    header: (name: string) => lower[name.toLowerCase()],
    query,
  } as unknown as import('express').Request;
  let statusCode = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: unknown) {
      body = data;
      return res;
    },
  } as unknown as import('express').Response;
  return {
    req,
    res,
    getStatus: () => statusCode,
    getBody: () => body as Record<string, unknown>,
  };
}

interface RouteLayer {
  route?: {
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }>;
  };
}
function extractHandler(router: ReturnType<typeof Router>) {
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  for (const layer of stack) {
    const handle = layer.route?.methods.get ? layer.route.stack[0]?.handle : undefined;
    if (handle) return handle;
  }
  throw new Error('No GET handler found');
}

async function callProbe(headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  const { llmProbeCronRouter } = await import('../../routes/llm-probe-cron.js');
  const handler = extractHandler(llmProbeCronRouter);
  const ctx = createReqRes(headers, query);
  await handler(ctx.req, ctx.res);
  return { status: ctx.getStatus(), body: ctx.getBody() };
}

function rawEvent(id: string, lat: number, lng: number): ConflictEventEntity {
  return {
    id,
    type: 'airstrike',
    lat,
    lng,
    timestamp: Date.UTC(2026, 8, 18, 12),
    label: 'Aerial weapons',
    data: {
      eventType: 'Aerial weapons',
      subEventType: 'CAMEO 195',
      fatalities: 0,
      actor1: 'ISR',
      actor2: 'IRN',
      notes: '',
      source: `https://example.com/${id}`,
      goldsteinScale: -10,
      locationName: 'Somewhere',
      cameoCode: '195',
      numMentions: 5,
      numSources: 2,
    },
  } as ConflictEventEntity;
}

// Three groups (far apart), so the probe has more than the two it sends.
const rawCorpus = [
  rawEvent('gdelt-1', 33.3, 44.4),
  rawEvent('gdelt-2', 35.7, 51.4),
  rawEvent('gdelt-3', 30.5, 47.8),
];

function validEvent(groupKey: string) {
  return {
    schemaVersion: 'v3',
    groupKey,
    location: {
      country: 'Iran',
      admin1: null,
      city: null,
      neighborhood: null,
      landmark: null,
      confidence: 0.7,
    },
    type: 'airstrike',
    confidence: 0.7,
    reasoning: 'probe fixture',
    weaponType: null,
    targetType: null,
    timeOfDay: null,
    durationMinutes: null,
    actors: ['IRGC'],
    severity: 'high',
    summary: 'Strike on suspected military site.',
    casualties: { killed: null, injured: null, unknown: true },
    sourceCount: 3,
  };
}

function completion(content: string | null, finishReason = 'stop') {
  return {
    choices: [{ finish_reason: finishReason, message: { content } }],
    usage: { completion_tokens: 590 },
  };
}

const validCompletion = () =>
  completion(JSON.stringify({ events: [validEvent('grp-a'), validEvent('grp-b')] }));

beforeEach(() => {
  mockEnv.CRON_SECRET = '';
  mockEnv.NVIDIA_NIM_API_KEY = 'nvapi-test';
  createMock.mockReset();
  clientOptions.length = 0;
  cacheGetSafeMock.mockReset().mockResolvedValue({ data: rawCorpus, stale: false, lastFresh: 0 });
  cacheSetSafeMock.mockReset();
  cacheSetReportedMock.mockReset();
});

describe('/api/cron/llm-probe — Bearer CRON_SECRET gate', () => {
  it('CRON_SECRET set + Authorization missing → 401, no model is called', async () => {
    mockEnv.CRON_SECRET = 's3cret';

    const { status, body } = await callProbe();

    expect(status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('CRON_SECRET set + wrong Bearer → 401, no model is called', async () => {
    mockEnv.CRON_SECRET = 's3cret';

    const { status } = await callProbe({ Authorization: 'Bearer wrong!' });

    expect(status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('a wrong Bearer of the same length as the right one → 401', async () => {
    mockEnv.CRON_SECRET = 's3cret';

    const { status } = await callProbe({ Authorization: 'Bearer s3creT' });

    expect(status).toBe(401);
  });

  it('CRON_SECRET set + correct Bearer → the probe runs', async () => {
    mockEnv.CRON_SECRET = 's3cret';
    createMock.mockResolvedValue(validCompletion());

    const { status, body } = await callProbe({ Authorization: 'Bearer s3cret' });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

describe('/api/cron/llm-probe — declines without burning a call', () => {
  it('no NIM key → llm_unconfigured', async () => {
    mockEnv.NVIDIA_NIM_API_KEY = '';

    const { status, body } = await callProbe();

    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, reason: 'llm_unconfigured' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('empty raw cache → no_raw_events', async () => {
    cacheGetSafeMock.mockResolvedValue(null);

    const { status, body } = await callProbe();

    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, reason: 'no_raw_events' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('raw cache present but empty → no_raw_events', async () => {
    cacheGetSafeMock.mockResolvedValue({ data: [], stale: false, lastFresh: 0 });

    const { body } = await callProbe();

    expect(body).toEqual({ ok: false, reason: 'no_raw_events' });
  });
});

describe('/api/cron/llm-probe — one production-shaped batch per candidate', () => {
  it('a schema-valid reply is reported ok:true, schemaValid:true with latency and token count', async () => {
    createMock.mockResolvedValue(validCompletion());

    const { status, body } = await callProbe({}, { models: 'google/gemma-4-31b-it' });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.groups).toBe(2);
    expect(body.results).toEqual([
      {
        model: 'google/gemma-4-31b-it',
        ok: true,
        status: 200,
        latencyMs: expect.any(Number),
        finishReason: 'stop',
        tokensOut: 590,
        jsonParsed: true,
        schemaValid: true,
        eventCount: 2,
        error: null,
      },
    ]);
  });

  it('the request is the production one: v3 system prompt, two live groups, JSON mode, temperature 0', async () => {
    const { SYSTEM_PROMPT_V3 } = await import('../../lib/llmEventExtractor.v3.js');
    const { groupGdeltRows } = await import('../../lib/eventGrouping.js');
    createMock.mockResolvedValue(validCompletion());

    await callProbe({}, { models: 'a/model' });

    const request = createMock.mock.calls[0]?.[0] as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      response_format: unknown;
      temperature: number;
    };
    expect(request.model).toBe('a/model');
    expect(request.response_format).toEqual({ type: 'json_object' });
    expect(request.temperature).toBe(0);
    expect(request.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT_V3 });
    const sentKeys = groupGdeltRows(rawCorpus)
      .map((g) => g.key)
      .filter((key) => request.messages[1]?.content.includes(key));
    expect(sentKeys).toHaveLength(2);
  });

  it('a 410 from the client is a row in the report — status 410, ok:false — not a failed request', async () => {
    createMock.mockRejectedValue(
      Object.assign(new Error('410 The model has reached its end of life'), { status: 410 }),
    );

    const { status, body } = await callProbe({}, { models: 'qwen/qwen3.5-397b-a17b' });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const [row] = body.results as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      model: 'qwen/qwen3.5-397b-a17b',
      ok: false,
      status: 410,
      jsonParsed: false,
      schemaValid: false,
      eventCount: 0,
    });
    expect(row?.error).toContain('end of life');
  });

  it('each model gets one call and its own row, in the order asked', async () => {
    createMock.mockImplementation(async (request: { model: string }) => {
      if (request.model === 'b/retired')
        throw Object.assign(new Error('410 gone'), { status: 410 });
      return validCompletion();
    });

    const { body } = await callProbe({}, { models: 'a/good, b/retired ,c/good' });

    expect(createMock).toHaveBeenCalledTimes(3);
    const rows = body.results as Array<{ model: string; ok: boolean; status: number }>;
    expect(rows.map((r) => [r.model, r.ok, r.status])).toEqual([
      ['a/good', true, 200],
      ['b/retired', false, 410],
      ['c/good', true, 200],
    ]);
  });

  it('no models param probes the configured production model', async () => {
    const { NVIDIA_NIM_DEFAULT_MODEL } = await import('../../lib/freeClaudeRouter.js');
    createMock.mockResolvedValue(validCompletion());

    const { body } = await callProbe();

    expect((body.results as Array<{ model: string }>).map((r) => r.model)).toEqual([
      NVIDIA_NIM_DEFAULT_MODEL,
    ]);
  });

  it('at most eight models are probed per request', async () => {
    createMock.mockResolvedValue(validCompletion());
    const models = Array.from({ length: 12 }, (_, i) => `m/${i}`).join(',');

    const { body } = await callProbe({}, { models });

    expect(createMock).toHaveBeenCalledTimes(8);
    expect(body.results).toHaveLength(8);
  });
});

describe('/api/cron/llm-probe — a reply that is not usable is reported as such', () => {
  it('HTTP 200 with text that is not JSON → ok:false, jsonParsed:false', async () => {
    createMock.mockResolvedValue(completion('Sure! Here are the events you asked for.'));

    const { body } = await callProbe({}, { models: 'a/chatty' });

    const [row] = body.results as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ ok: false, status: 200, jsonParsed: false, schemaValid: false });
    expect(row?.error).toContain('json_parse_failed');
  });

  it('JSON that fails the v3 schema → ok:false, jsonParsed:true, schemaValid:false', async () => {
    createMock.mockResolvedValue(completion(JSON.stringify({ events: [{ groupKey: 'grp-a' }] })));

    const { body } = await callProbe({}, { models: 'a/sloppy' });

    const [row] = body.results as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ ok: false, status: 200, jsonParsed: true, schemaValid: false });
    expect(row?.error).toEqual(expect.any(String));
  });

  it('an empty reply → ok:false, error empty_content, finish_reason carried through', async () => {
    createMock.mockResolvedValue(completion(null, 'length'));

    const { body } = await callProbe({}, { models: 'a/truncated' });

    const [row] = body.results as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ ok: false, finishReason: 'length', error: 'empty_content' });
  });

  it('a reasoning model: the <think> block is stripped before the reply is parsed', async () => {
    createMock.mockResolvedValue(
      completion(`<think>let me see</think>${JSON.stringify({ events: [validEvent('grp-a')] })}`),
    );

    const { body } = await callProbe({}, { models: 'a/reasoner' });

    const [row] = body.results as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ ok: true, schemaValid: true, eventCount: 1 });
  });
});

describe('/api/cron/llm-probe — a probe leaves no trace', () => {
  it('writes no cache key, whether the candidates pass or fail', async () => {
    createMock
      .mockResolvedValueOnce(validCompletion())
      .mockRejectedValueOnce(Object.assign(new Error('410 gone'), { status: 410 }));

    await callProbe({}, { models: 'a/good,b/retired' });

    expect(cacheSetSafeMock).not.toHaveBeenCalled();
    expect(cacheSetReportedMock).not.toHaveBeenCalled();
  });

  // The SDK's hidden retries would mask a 429 and triple the reported latency.
  it('its client does not retry, and talks to NIM with the production key', async () => {
    createMock.mockResolvedValue(validCompletion());

    await callProbe({}, { models: 'a/good' });

    expect(clientOptions).toHaveLength(1);
    expect(clientOptions[0]).toMatchObject({
      apiKey: 'nvapi-test',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      maxRetries: 0,
    });
  });
});

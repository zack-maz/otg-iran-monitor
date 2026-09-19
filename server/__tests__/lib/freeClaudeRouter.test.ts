// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before importing the module-under-test
// ---------------------------------------------------------------------------

const createMock = vi.fn();
// Options each `new OpenAI({...})` was constructed with.
const clientOptions: Array<Record<string, unknown>> = [];
vi.mock('openai', () => {
  // Provide a constructor-callable default export so `new OpenAI({...})` in the
  // module-under-test resolves correctly under Vitest's ESM interop. A plain
  // `vi.fn().mockImplementation(...)` is NOT detected as a class constructor
  // by Node's `new` operator under all transpile pipelines.
  class MockOpenAI {
    chat = { completions: { create: (...args: unknown[]) => createMock(...args) } };
    constructor(opts: Record<string, unknown>) {
      // behavior is provided by the `chat.completions.create` mock
      clientOptions.push(opts);
    }
  }
  return { default: MockOpenAI };
});

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { NVIDIA_NIM_API_KEY: 'test-nvapi', OPENROUTER_API_KEY: 'test-or' },
}));
vi.mock('../../config.js', () => ({ env: mockEnv }));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const incrMock = vi.fn().mockResolvedValue(1);
const getMock = vi.fn().mockResolvedValue(0);
const expireMock = vi.fn().mockResolvedValue(1);
vi.mock('../../cache/redis.js', () => ({
  redis: { incr: incrMock, get: getMock, expire: expireMock },
}));

const isAvailableMock = vi.fn().mockReturnValue(true);
const recordMock = vi.fn();
vi.mock('../../lib/llmCircuitBreaker.js', () => ({
  isAvailable: (...args: unknown[]) => isAvailableMock(...args),
  record: (...args: unknown[]) => recordMock(...args),
}));

// Dynamic import after mocks are registered.
const { callLLM, stripReasoningBlocks, classifyError, __internal, NVIDIA_NIM_DEFAULT_MODEL } =
  await import('../../lib/freeClaudeRouter.js');

/** An error shaped like the OpenAI SDK's APIError: a message plus the HTTP status. */
function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const okResponse = { choices: [{ message: { content: '{"ok":true}' } }] };

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockReset();
  mockEnv.OPENROUTER_API_KEY = 'test-or';
  isAvailableMock.mockReturnValue(true);
  getMock.mockResolvedValue(0);
  incrMock.mockResolvedValue(1);
  expireMock.mockResolvedValue(1);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Group 1 — Rolling-window rate limiter (R1-R3)
// ---------------------------------------------------------------------------

describe('freeClaudeRouter — rolling-window rate limiter', () => {
  it('R1: empty window — canRequest returns true', () => {
    const w = new __internal.RollingWindow(40, 60_000);
    expect(w.canRequest()).toBe(true);
  });

  it('R2: 40 consume calls fill the window — 41st returns false', () => {
    const w = new __internal.RollingWindow(40, 60_000);
    for (let i = 0; i < 40; i++) w.consume();
    expect(w.canRequest()).toBe(false);
  });

  it('R3: 60s after first consume — evict drops it and canRequest returns true again', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const w = new __internal.RollingWindow(40, 60_000);
    for (let i = 0; i < 40; i++) w.consume();
    expect(w.canRequest()).toBe(false);
    vi.setSystemTime(t0 + 60_001);
    expect(w.canRequest()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — 429 backoff path (B1-B3)
// ---------------------------------------------------------------------------

describe('freeClaudeRouter — 429 backoff path', () => {
  it('B1: 429 triggers retry — succeeds on attempt 2', async () => {
    createMock
      .mockRejectedValueOnce(new Error('429 rate limit'))
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"ok":true}' } }] });
    const { content, routing } = await callLLM([{ role: 'user', content: 'hi' }], '{}');
    expect(content).toBe('{"ok":true}');
    expect(routing[0]?.provider).toBe('nvidia_nim');
  });

  it('B2: NIM exhausts RETRY_ATTEMPTS=3 of 429s — falls through to OpenRouter', async () => {
    // Phase 30 D-02 tune: RETRY_ATTEMPTS bumped 2→3, so NIM needs THREE
    // rejections (not two) to exhaust the per-provider retry budget before
    // the cascade falls through to OpenRouter. BACKOFF_MS = [2000, 8000,
    // 32000] means real-time waits would exceed the default 10s test
    // timeout; fake timers + advanceTimersByTimeAsync make the sleeps
    // instant while preserving the retry-loop's sequential awaits.
    vi.useFakeTimers();
    createMock
      .mockRejectedValueOnce(new Error('429 rate limit'))
      .mockRejectedValueOnce(new Error('429 rate limit'))
      .mockRejectedValueOnce(new Error('429 rate limit'))
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"ok":true}' } }] });
    const callPromise = callLLM([{ role: 'user', content: 'hi' }], '{}');
    // Advance through the two BACKOFF[0]=2000 + BACKOFF[1]=8000 sleeps that
    // separate the 3 NIM attempts (no sleep after the third — exhausted).
    await vi.advanceTimersByTimeAsync(2000 + 500); // JITTER_MS ±500
    await vi.advanceTimersByTimeAsync(8000 + 500);
    const { content, routing } = await callPromise;
    expect(content).toBe('{"ok":true}');
    expect(routing.length).toBeGreaterThanOrEqual(2);
    expect(routing[1]?.provider).toBe('openrouter');
    expect(String(routing[1]?.reason)).toContain('fall_through');
  });

  it('B3: all providers exhausted — returns null', async () => {
    // Phase 30 D-02 tune: RETRY_ATTEMPTS=3 + BACKOFF=[2000,8000,32000]
    // means the worst-case retry-exhaustion wall-clock is ~42s per provider
    // = ~84s for both providers. Use fake timers to keep the test inside
    // its 10s budget while still proving the cascade exits with null.
    vi.useFakeTimers();
    createMock.mockRejectedValue(new Error('429 rate limit'));
    const callPromise = callLLM([{ role: 'user', content: 'hi' }], '{}');
    // Drain the full retry budget across both providers (2 backoffs per
    // provider since attempt N has no trailing sleep on exhaustion).
    // BACKOFF[0]=2000, BACKOFF[1]=8000 per attempt-pair × 2 providers.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(10_000); // covers 2000+8000+jitter
    }
    const { content, routing } = await callPromise;
    expect(content).toBeNull();
    expect(routing.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — <think>-block stripping (T1-T3)
// ---------------------------------------------------------------------------

describe('freeClaudeRouter — <think>-block stripping', () => {
  it('T1: strips <think>...</think> blocks', () => {
    expect(stripReasoningBlocks('<think>foo</think>{"a":1}')).toBe('{"a":1}');
  });

  it('T2: strips reasoning_content: prefix line', () => {
    expect(stripReasoningBlocks('reasoning_content: blah\n{"a":1}')).toBe('{"a":1}');
  });

  it('T3: tolerates unclosed <think> block — returns a string, no throw', () => {
    const out = stripReasoningBlocks('<think>foo{"a":1}');
    expect(typeof out).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Group 4 — Cap fall-through (F1-F2)
// ---------------------------------------------------------------------------

describe('freeClaudeRouter — cap fall-through', () => {
  it('F1: NVIDIA NIM circuit-broken — routes to OpenRouter', async () => {
    isAvailableMock.mockImplementation((p: string) => p !== 'nvidia_nim');
    createMock.mockResolvedValue({ choices: [{ message: { content: '{"x":2}' } }] });
    const { content, routing } = await callLLM([{ role: 'user', content: 'hi' }], '{}');
    expect(content).toBe('{"x":2}');
    expect(routing[0]?.provider).toBe('nvidia_nim');
    expect(String(routing[0]?.reason)).toContain('breaker');
    expect(routing[1]?.provider).toBe('openrouter');
  });

  it('F2: both providers unavailable — null content', async () => {
    isAvailableMock.mockReturnValue(false);
    const { content, routing } = await callLLM([{ role: 'user', content: 'hi' }], '{}');
    expect(content).toBeNull();
    expect(routing.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Group 5 — Error taxonomy classification (E1-E4)
// ---------------------------------------------------------------------------

describe('freeClaudeRouter — error taxonomy', () => {
  it('E1: 429 + rate limit -> rate_limit', () => {
    expect(classifyError(new Error('HTTP 429 rate limit exceeded'))).toBe('rate_limit');
  });

  it('E2: timeout -> timeout', () => {
    expect(classifyError(new Error('socket timeout after 30s'))).toBe('timeout');
  });

  it('E3: ENOTFOUND -> network', () => {
    expect(classifyError(new Error('getaddrinfo ENOTFOUND api.nvidia.com'))).toBe('network');
  });

  it('E4: 5xx -> upstream_500', () => {
    expect(classifyError(new Error('HTTP 502 bad gateway'))).toBe('upstream_500');
  });
});

// ---------------------------------------------------------------------------
// Group 6 — Phase 27.4.4 Plan 02: breaker accuracy + skipOpenRouter (P1-P3)
// ---------------------------------------------------------------------------

describe('freeClaudeRouter — breaker semantics (per-call, not per-attempt)', () => {
  it('P1: 429-then-success-on-retry records only ok to the breaker (not err+ok)', async () => {
    // The pre-Plan-02 implementation called record(name, "err") inside the
    // catch block on EVERY failed attempt. A single retried-and-succeeded
    // call would push (err, ok) into the breaker window, polluting the
    // 30%-error-rate threshold. Plan 02 moves the err record outside the
    // retry loop so it fires once-per-call only when retries are exhausted.
    createMock
      .mockRejectedValueOnce(new Error('429 rate limit'))
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"ok":true}' } }] });
    const { content } = await callLLM([{ role: 'user', content: 'hi' }], '{}');
    expect(content).toBe('{"ok":true}');
    // record should be called exactly once (with 'ok'), NOT (err, ok).
    const calls = recordMock.mock.calls;
    const errCalls = calls.filter(([, outcome]) => outcome === 'err');
    const okCalls = calls.filter(([, outcome]) => outcome === 'ok');
    expect(errCalls.length).toBe(0);
    expect(okCalls.length).toBe(1);
  });

  it('P2: retries-exhausted records err exactly once (not per-attempt)', async () => {
    // When NIM 429s on every retry attempt, only ONE 'err' should land in
    // the breaker window for that call (not RETRY_ATTEMPTS errs).
    // Phase 30 D-02 tune: RETRY_ATTEMPTS=3 + BACKOFF=[2000,8000,32000]
    // means the test would block on ~84s of real-time sleep without fake
    // timers. Drain through the backoffs to assert the err-record count.
    vi.useFakeTimers();
    createMock.mockRejectedValue(new Error('429 rate limit'));
    const callPromise = callLLM([{ role: 'user', content: 'hi' }], '{}');
    // 2 backoffs per provider × 2 providers = 4 sleeps (max 8s+jitter each).
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await callPromise;
    // First provider attempted then exhausted -> one 'err' for nvidia_nim.
    // Second provider also exhausted -> one more 'err' for openrouter.
    const errCalls = recordMock.mock.calls.filter(([, outcome]) => outcome === 'err');
    // Exactly 2 'err' records total — one per provider, NOT one per attempt.
    expect(errCalls.length).toBe(2);
    expect(errCalls[0]?.[0]).toBe('nvidia_nim');
    expect(errCalls[1]?.[0]).toBe('openrouter');
  });
});

describe('freeClaudeRouter — skipOpenRouter option', () => {
  it('P3: skipOpenRouter=true excludes OR from cascade even on full NIM failure', async () => {
    // With skipOpenRouter set, the v3 extractor opts out of the OR fallback.
    // OR is unusable on free tier (~16/16 rate_limit observed in dev runs).
    // When NIM fails, the call returns null content — no OR attempt fires.
    // Phase 30 D-02 tune: RETRY_ATTEMPTS=3 means NIM-only path waits
    // BACKOFF[0]=2000 + BACKOFF[1]=8000 = 10s+jitter before exhausting,
    // which would tip the test over the 10s timeout. Use fake timers.
    vi.useFakeTimers();
    createMock.mockRejectedValue(new Error('429 rate limit'));
    const callPromise = callLLM([{ role: 'user', content: 'hi' }], '{}', {
      skipOpenRouter: true,
    });
    await vi.advanceTimersByTimeAsync(2000 + 500);
    await vi.advanceTimersByTimeAsync(8000 + 500);
    const { content, routing } = await callPromise;
    expect(content).toBeNull();
    // Routing trace contains only NIM entries (no openrouter).
    const orEntries = routing.filter((r) => r.provider === 'openrouter');
    expect(orEntries.length).toBe(0);
    expect(routing.some((r) => r.provider === 'nvidia_nim')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The 40/min NIM window blocks instead of refusing
// ---------------------------------------------------------------------------

describe('freeClaudeRouter — a full NIM rate window makes the call wait, not fail', () => {
  it('RollingWindow.acquire resolves only once the oldest request leaves the window', async () => {
    vi.useFakeTimers();
    const w = new __internal.RollingWindow(2, 60_000);
    await w.acquire();
    await vi.advanceTimersByTimeAsync(10_000);
    await w.acquire();

    let acquired = false;
    const third = w.acquire().then(() => {
      acquired = true;
    });
    await vi.advanceTimersByTimeAsync(49_000); // 59 s after the first request
    expect(acquired).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100); // first request is now > 60 s old
    await third;
    expect(acquired).toBe(true);
    expect(w.headroom()).toEqual({ used: 2, cap: 2 });
  });

  // With a single provider there is nowhere to fall through to: a call turned
  // away by a full window was a lost batch, and the rest of a run drained as
  // instant nulls.
  it('callLLM waits for a slot when 40 requests went out in the last minute', async () => {
    vi.useFakeTimers();
    // Start from an empty window whatever the earlier tests consumed.
    vi.setSystemTime(Date.now() + 120_000);
    const windowStart = Date.now();
    createMock.mockResolvedValue(okResponse);
    for (let i = 0; i < 40; i++) {
      await callLLM([{ role: 'user', content: 'fill' }], '{}', { skipOpenRouter: true });
    }
    expect(createMock).toHaveBeenCalledTimes(40);

    let settled = false;
    const blocked = callLLM([{ role: 'user', content: 'hi' }], '{}', {
      skipOpenRouter: true,
    }).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    // Neither refused (the old `rate_limit_window` skip returned null at once)
    // nor sent: it is waiting.
    expect(settled).toBe(false);
    expect(createMock).toHaveBeenCalledTimes(40);

    await vi.advanceTimersByTimeAsync(30_100);
    const { content, routing } = await blocked;
    expect(Date.now() - windowStart).toBeGreaterThanOrEqual(60_000);
    expect(content).toBe('{"ok":true}');
    expect(createMock).toHaveBeenCalledTimes(41);
    expect(routing.map((r) => String(r.reason))).not.toContain('skipped:rate_limit_window');
  });
});

// ---------------------------------------------------------------------------
// The breaker only gates a provider when there is another one to use
// ---------------------------------------------------------------------------

describe('freeClaudeRouter — a tripped breaker does not skip the only provider', () => {
  it('NIM is the only configured provider: the call still goes out', async () => {
    mockEnv.OPENROUTER_API_KEY = '';
    isAvailableMock.mockReturnValue(false);
    createMock.mockResolvedValue(okResponse);

    const { content, routing } = await callLLM([{ role: 'user', content: 'hi' }], '{}');

    expect(content).toBe('{"ok":true}');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(String(routing[0]?.reason)).not.toContain('breaker');
  });

  it('OpenRouter is configured but opted out (skipOpenRouter): NIM is still the only provider', async () => {
    isAvailableMock.mockReturnValue(false);
    createMock.mockResolvedValue(okResponse);

    const { content } = await callLLM([{ role: 'user', content: 'hi' }], '{}', {
      skipOpenRouter: true,
    });

    expect(content).toBe('{"ok":true}');
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Provider answers no retry can fix
// ---------------------------------------------------------------------------

describe('freeClaudeRouter — 401/403/404/410 are reported as fatalStatus and not retried', () => {
  it('410 (model retired): one attempt, null content, fatalStatus 410', async () => {
    createMock.mockRejectedValue(httpError(410, '410 The model has reached its end of life'));

    const result = await callLLM([{ role: 'user', content: 'hi' }], '{}', {
      skipOpenRouter: true,
    });

    expect(result.content).toBeNull();
    expect(result.fatalStatus).toBe(410);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404])('%i is fatal too', async (status) => {
    createMock.mockRejectedValue(httpError(status, `${status} rejected`));

    const result = await callLLM([{ role: 'user', content: 'hi' }], '{}', {
      skipOpenRouter: true,
    });

    expect(result.fatalStatus).toBe(status);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('429 is not fatal: it is retried with backoff and the success carries no fatalStatus', async () => {
    vi.useFakeTimers();
    createMock
      .mockRejectedValueOnce(httpError(429, '429 rate limit'))
      .mockRejectedValueOnce(httpError(429, '429 rate limit'))
      .mockResolvedValueOnce(okResponse);

    const call = callLLM([{ role: 'user', content: 'hi' }], '{}', { skipOpenRouter: true });
    await vi.advanceTimersByTimeAsync(2000 + 500);
    await vi.advanceTimersByTimeAsync(8000 + 500);
    const result = await call;

    expect(result.content).toBe('{"ok":true}');
    expect(result.fatalStatus).toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it('429 on every attempt ends null without a fatalStatus — the run may try again later', async () => {
    vi.useFakeTimers();
    createMock.mockRejectedValue(httpError(429, '429 rate limit'));

    const call = callLLM([{ role: 'user', content: 'hi' }], '{}', { skipOpenRouter: true });
    await vi.advanceTimersByTimeAsync(2000 + 500);
    await vi.advanceTimersByTimeAsync(8000 + 500);
    const result = await call;

    expect(result.content).toBeNull();
    expect(result.fatalStatus).toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it('a 500 is neither retried nor fatal', async () => {
    createMock.mockRejectedValue(httpError(500, '500 internal error'));

    const result = await callLLM([{ role: 'user', content: 'hi' }], '{}', {
      skipOpenRouter: true,
    });

    expect(result.content).toBeNull();
    expect(result.fatalStatus).toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// A hung request is retried once
// ---------------------------------------------------------------------------

describe('freeClaudeRouter — a timeout is retried once, at once', () => {
  it('timeout then success: two attempts with no backoff sleep between them', async () => {
    vi.useFakeTimers();
    createMock
      .mockRejectedValueOnce(new Error('Request timed out.'))
      .mockResolvedValueOnce(okResponse);

    // No timers are advanced: a backoff sleep would leave this call pending.
    const result = await callLLM([{ role: 'user', content: 'hi' }], '{}', {
      skipOpenRouter: true,
    });

    expect(result.content).toBe('{"ok":true}');
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(recordMock.mock.calls.filter(([, outcome]) => outcome === 'err')).toHaveLength(0);
  });

  it('a second timeout ends the call: two attempts, not three, and one breaker error', async () => {
    createMock.mockRejectedValue(new Error('Request timed out.'));

    const result = await callLLM([{ role: 'user', content: 'hi' }], '{}', {
      skipOpenRouter: true,
    });

    expect(result.content).toBeNull();
    expect(result.fatalStatus).toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(recordMock.mock.calls.filter(([, outcome]) => outcome === 'err')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Client construction and the production model
// ---------------------------------------------------------------------------

describe('freeClaudeRouter — the router owns retries and the timeout', () => {
  // The SDK retries twice on its own by default. Hidden behind the 40/min
  // window that tripled the real request rate and stretched a failing call
  // past the batch watchdog.
  it('both clients are built with maxRetries 0 and a 45 s timeout', async () => {
    clientOptions.length = 0;
    createMock.mockResolvedValue(okResponse);

    await callLLM([{ role: 'user', content: 'hi' }], '{}');

    expect(clientOptions.map((o) => o.baseURL)).toEqual([
      'https://integrate.api.nvidia.com/v1',
      'https://openrouter.ai/api/v1',
    ]);
    for (const opts of clientOptions) {
      expect(opts.maxRetries).toBe(0);
      expect(opts.timeout).toBe(45_000);
    }
  });
});

describe('freeClaudeRouter — production model', () => {
  it('defaults to google/gemma-4-31b-it unless V3_PRIMARY_MODEL overrides it', () => {
    expect(NVIDIA_NIM_DEFAULT_MODEL).toBe(process.env.V3_PRIMARY_MODEL ?? 'google/gemma-4-31b-it');
  });

  it('sends the default model to NIM when the caller gives no override', async () => {
    createMock.mockResolvedValue(okResponse);

    await callLLM([{ role: 'user', content: 'hi' }], '{}', { skipOpenRouter: true });

    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ model: NVIDIA_NIM_DEFAULT_MODEL });
  });
});

// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Request, Response, NextFunction } from 'express';

// Mock @upstash/ratelimit
const mockLimit = vi.fn();

const constructedPrefixes: string[] = [];

class MockRatelimit {
  limit = mockLimit;
  constructor(opts: { prefix: string }) {
    constructedPrefixes.push(opts.prefix);
  }
  static slidingWindow(_tokens: number, _window: string) {
    return 'sliding-window-config';
  }
}

vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: MockRatelimit,
}));

// Mock redis instance
vi.mock('../cache/redis.js', () => ({
  redis: { ping: vi.fn(async () => 'PONG') },
}));

// Force production mode so the rate limiter actually runs in tests
vi.stubEnv('NODE_ENV', 'production');

// Import after mocks. Use the production `flights` limiter as the canonical
// fixture since the deprecated `rateLimitMiddleware` export was removed in 26.3-05.
const { rateLimiters } = await import('../middleware/rateLimit.js');
const rateLimitMiddleware = rateLimiters.flights;

function createMockReq(ip = '127.0.0.1'): Partial<Request> {
  return {
    ip,
    headers: {},
  };
}

function createMockRes(): Partial<Response> & {
  _status: number;
  _json: unknown;
  _headers: Record<string, string>;
} {
  const res = {
    _status: 200,
    _json: null as unknown,
    _headers: {} as Record<string, string>,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._json = body;
      return res;
    },
    set(name: string, value: string) {
      res._headers[name] = value;
      return res;
    },
  };
  return res as unknown as Partial<Response> & {
    _status: number;
    _json: unknown;
    _headers: Record<string, string>;
  };
}

describe('rateLimitMiddleware', () => {
  beforeEach(() => {
    mockLimit.mockReset();
  });

  it('gives every tier its own Redis prefix so per-IP counters are not shared', () => {
    // @upstash/ratelimit keys on `${prefix}:${identifier}`; a shared prefix means
    // flights polling burns the sites/water/weather budgets.
    expect(constructedPrefixes.length).toBeGreaterThanOrEqual(Object.keys(rateLimiters).length);
    expect(new Set(constructedPrefixes).size).toBe(constructedPrefixes.length);
    expect(constructedPrefixes).toContain('ratelimit:prod:flights');
    expect(constructedPrefixes).toContain('ratelimit:prod:sites');
  });

  it('degrades open (next, no 500) when the limiter backend throws', async () => {
    mockLimit.mockRejectedValue(new Error('upstash down'));
    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn();

    await rateLimitMiddleware(req as Request, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(res._status).toBe(200);
  });

  it('calls next() when under rate limit', async () => {
    mockLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 59,
      reset: Date.now() + 60000,
    });

    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await rateLimitMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 429 JSON when rate limit exceeded', async () => {
    mockLimit.mockResolvedValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 30000,
    });

    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await rateLimitMiddleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(429);
    expect(res._json).toEqual({
      error: 'Too many requests',
      code: 'RATE_LIMITED',
      statusCode: 429,
    });
  });

  it('sets X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset headers', async () => {
    const resetTime = Date.now() + 45000;
    mockLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 42,
      reset: resetTime,
    });

    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await rateLimitMiddleware(req as Request, res as Response, next);

    expect(res._headers['X-RateLimit-Limit']).toBe('60');
    expect(res._headers['X-RateLimit-Remaining']).toBe('42');
    expect(res._headers['X-RateLimit-Reset']).toBe(String(resetTime));
  });

  it('uses x-forwarded-for when req.ip is undefined', async () => {
    mockLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 58,
      reset: Date.now() + 60000,
    });

    const req: Partial<Request> = {
      headers: { 'x-forwarded-for': '10.0.0.1' },
    };
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await rateLimitMiddleware(req as Request, res as Response, next);

    expect(mockLimit).toHaveBeenCalledWith('10.0.0.1');
    expect(next).toHaveBeenCalled();
  });

  it('falls back to "anonymous" when no IP available', async () => {
    mockLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 57,
      reset: Date.now() + 60000,
    });

    const req: Partial<Request> = {
      headers: {},
    };
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await rateLimitMiddleware(req as Request, res as Response, next);

    expect(mockLimit).toHaveBeenCalledWith('anonymous');
    expect(next).toHaveBeenCalled();
  });
});

// @vitest-environment node
import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, it, expect, beforeEach } from 'vitest';

import { redactPaths } from '../../lib/logger.js';

/**
 * Helper: build a pino logger that streams JSON lines into an in-memory sink,
 * mirroring the redact configuration we ship in `server/lib/logger.ts`.
 *
 * Production logger.ts wires the same redactPaths array into pino's redact
 * config; this test uses the exported constant so the two cannot drift apart.
 */
function buildSinkLogger(): { logger: pino.Logger; getLines: () => string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString('utf8'));
      cb();
    },
  });
  const logger = pino(
    { redact: { paths: redactPaths, censor: '[REDACTED]' }, level: 'info' },
    sink,
  );
  return { logger, getLines: () => lines };
}

describe('Pino logger redaction', () => {
  let logger: pino.Logger;
  let getLines: () => string[];

  beforeEach(() => {
    ({ logger, getLines } = buildSinkLogger());
  });

  it('redacts req.headers.authorization', () => {
    logger.info(
      {
        req: {
          headers: {
            authorization: 'Bearer super-secret-token-12345',
          },
        },
      },
      'incoming request',
    );
    const line = getLines()[0]!;
    const parsed = JSON.parse(line);
    expect(parsed.req.headers.authorization).toBe('[REDACTED]');
    expect(line).not.toContain('super-secret-token-12345');
  });

  it('redacts req.headers.cookie and req.headers["x-api-key"]', () => {
    logger.info(
      {
        req: {
          headers: {
            cookie: 'session=abcdef-cookie-value',
            'x-api-key': 'sk_live_xyz-api-key-value',
          },
        },
      },
      'cookie + api key',
    );
    const line = getLines()[0]!;
    const parsed = JSON.parse(line);
    expect(parsed.req.headers.cookie).toBe('[REDACTED]');
    expect(parsed.req.headers['x-api-key']).toBe('[REDACTED]');
    expect(line).not.toContain('abcdef-cookie-value');
    expect(line).not.toContain('sk_live_xyz-api-key-value');
  });

  it('redacts Vercel platform credential headers (OIDC token + proxy signature)', () => {
    logger.info(
      {
        req: {
          headers: {
            'x-vercel-oidc-token': 'eyJ0eXAi.oidc-jwt-leak.sig',
            'x-vercel-proxy-signature': 'Bearer proxy-signature-leak',
            forwarded: 'for=1.2.3.4;host=example.app;proto=https;sig=forwarded-sig-leak;exp=1',
          },
        },
      },
      'incoming request',
    );
    const line = getLines()[0]!;
    expect(line).not.toContain('oidc-jwt-leak');
    expect(line).not.toContain('proxy-signature-leak');
    expect(line).not.toContain('forwarded-sig-leak');
  });

  it('redacts res.headers["set-cookie"]', () => {
    logger.info(
      {
        res: {
          headers: {
            'set-cookie': 'token=outgoing-secret; HttpOnly',
          },
        },
      },
      'outgoing response',
    );
    const line = getLines()[0]!;
    const parsed = JSON.parse(line);
    expect(parsed.res.headers['set-cookie']).toBe('[REDACTED]');
    expect(line).not.toContain('outgoing-secret');
  });

  it('wildcard *.UPSTASH_REDIS_REST_TOKEN catches the token under any nested object', () => {
    logger.info(
      {
        env: {
          UPSTASH_REDIS_REST_TOKEN: 'AXXXupstash-token-leak',
          UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
        },
      },
      'env dump',
    );
    const line = getLines()[0]!;
    const parsed = JSON.parse(line);
    expect(parsed.env.UPSTASH_REDIS_REST_TOKEN).toBe('[REDACTED]');
    // The URL is not a secret, so it should pass through unchanged.
    expect(parsed.env.UPSTASH_REDIS_REST_URL).toBe('https://example.upstash.io');
    expect(line).not.toContain('AXXXupstash-token-leak');
  });

  it('wildcard *.OPENSKY_CLIENT_SECRET catches OpenSky credentials at one level deep', () => {
    // Pino redact wildcards (`*.x`) match at exactly one level of nesting.
    // Adapter logs should put the secret one level under a context object
    // (e.g. `upstream`, `env`, `cfg`) — not deeper.
    logger.info(
      {
        upstream: {
          OPENSKY_CLIENT_SECRET: 'opensky-shhh-secret',
          OPENSKY_CLIENT_ID: 'public-client-id',
        },
      },
      'opensky auth',
    );
    const line = getLines()[0]!;
    const parsed = JSON.parse(line);
    expect(parsed.upstream.OPENSKY_CLIENT_SECRET).toBe('[REDACTED]');
    expect(parsed.upstream.OPENSKY_CLIENT_ID).toBe('public-client-id');
    expect(line).not.toContain('opensky-shhh-secret');
  });

  it('wildcards catch AISSTREAM_API_KEY and ADSB_EXCHANGE_API_KEY', () => {
    logger.info(
      {
        ctx: {
          AISSTREAM_API_KEY: 'ais-secret-key',
          ADSB_EXCHANGE_API_KEY: 'adsb-secret-key',
        },
      },
      'upstream keys',
    );
    const line = getLines()[0]!;
    const parsed = JSON.parse(line);
    expect(parsed.ctx.AISSTREAM_API_KEY).toBe('[REDACTED]');
    expect(parsed.ctx.ADSB_EXCHANGE_API_KEY).toBe('[REDACTED]');
    expect(line).not.toContain('ais-secret-key');
    expect(line).not.toContain('adsb-secret-key');
  });

  it('plain log messages and unrelated fields pass through unchanged', () => {
    logger.info(
      {
        method: 'GET',
        path: '/api/flights',
        status: 200,
        durationMs: 42,
      },
      'GET /api/flights 200',
    );
    const line = getLines()[0]!;
    const parsed = JSON.parse(line);
    expect(parsed.method).toBe('GET');
    expect(parsed.path).toBe('/api/flights');
    expect(parsed.status).toBe(200);
    expect(parsed.durationMs).toBe(42);
    expect(parsed.msg).toBe('GET /api/flights 200');
    // No `[REDACTED]` should appear anywhere — this fixture has no sensitive paths.
    expect(line).not.toContain('[REDACTED]');
  });

  it('captured stream output never contains the original secret strings anywhere', () => {
    logger.info(
      {
        req: {
          headers: {
            authorization: 'Bearer ANTI-LEAK-TOKEN-AAA',
            cookie: 'sid=ANTI-LEAK-COOKIE-BBB',
            'x-api-key': 'ANTI-LEAK-API-CCC',
          },
        },
        env: {
          UPSTASH_REDIS_REST_TOKEN: 'ANTI-LEAK-UPSTASH-DDD',
          OPENSKY_CLIENT_SECRET: 'ANTI-LEAK-OPENSKY-EEE',
          AISSTREAM_API_KEY: 'ANTI-LEAK-AIS-FFF',
          ADSB_EXCHANGE_API_KEY: 'ANTI-LEAK-ADSB-GGG',
        },
      },
      'kitchen sink',
    );
    const allOutput = getLines().join('\n');
    const secrets = [
      'ANTI-LEAK-TOKEN-AAA',
      'ANTI-LEAK-COOKIE-BBB',
      'ANTI-LEAK-API-CCC',
      'ANTI-LEAK-UPSTASH-DDD',
      'ANTI-LEAK-OPENSKY-EEE',
      'ANTI-LEAK-AIS-FFF',
      'ANTI-LEAK-ADSB-GGG',
    ];
    for (const s of secrets) {
      expect(allOutput).not.toContain(s);
    }
    // And [REDACTED] should appear in place of each.
    const redactedCount = (allOutput.match(/\[REDACTED\]/g) ?? []).length;
    expect(redactedCount).toBeGreaterThanOrEqual(secrets.length);
  });

  it('redactPaths array includes the canonical sensitive paths', () => {
    // Sanity check: the constant exported from logger.ts must contain the
    // baseline paths this test relies on. Catches accidental refactors.
    expect(redactPaths).toContain('req.headers.authorization');
    expect(redactPaths).toContain('req.headers.cookie');
    expect(redactPaths).toContain('req.headers["x-api-key"]');
    expect(redactPaths).toContain('res.headers["set-cookie"]');
    expect(redactPaths).toContain('*.UPSTASH_REDIS_REST_TOKEN');
    expect(redactPaths).toContain('*.OPENSKY_CLIENT_SECRET');
    expect(redactPaths).toContain('*.AISSTREAM_API_KEY');
    expect(redactPaths).toContain('*.ADSB_EXCHANGE_API_KEY');
  });
});

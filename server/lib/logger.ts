import pino from 'pino';

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  cacheHit?: boolean;
  timestamp?: string;
}

const isTest = process.env.NODE_ENV === 'test';
const isProd = process.env.NODE_ENV === 'production';

/**
 * Pino redaction paths — every path listed here is replaced with `[REDACTED]`
 * before any sink (stdout, transport, network) sees the log line.
 *
 * Categories:
 *
 *   1. HTTP request/response auth headers — pino-http logs `req` and `res`
 *      objects on every request; the auth/cookie/api-key headers must never
 *      land in production logs.
 *        - req.headers.authorization     Bearer tokens, Basic auth
 *        - req.headers.cookie            session cookies (sid=, etc.)
 *        - req.headers["x-api-key"]      upstream API keys forwarded to us
 *        - res.headers["set-cookie"]     outgoing session cookies
 *        - req.headers["x-vercel-oidc-token"]       Vercel-injected project OIDC JWT
 *        - req.headers["x-vercel-proxy-signature"]  Vercel edge→function proxy signature
 *        - req.headers.forwarded                    carries the same proxy `sig=`
 *      (The three Vercel headers were found unredacted in prod logs, 2026-09.)
 *
 *   2. Wildcard secret keys — match common upstream credential field names
 *      under any nested object. Adapter logs occasionally capture process.env
 *      slices or fixture payloads; these wildcards catch them defensively.
 *        - *.UPSTASH_REDIS_REST_TOKEN    Upstash Redis REST auth token
 *        - *.OPENSKY_CLIENT_SECRET       OpenSky OAuth client secret
 *        - *.AISSTREAM_API_KEY           AISStream WebSocket API key
 *        - *.ADSB_EXCHANGE_API_KEY       (legacy) ADS-B Exchange RapidAPI key
 *
 *   3. Production-only PII — only redacted when NODE_ENV === 'production'.
 *      In dev we leave req.ip / req.remoteAddress visible for debugging
 *      bot traffic and rate limit issues.
 *        - req.remoteAddress / req.ip
 *
 * Exported so the redaction proof test (server/__tests__/lib/logger-redaction.test.ts)
 * can import this exact array — preventing test/runtime drift.
 */
export const redactPaths: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'req.headers["x-vercel-oidc-token"]',
  'req.headers["x-vercel-proxy-signature"]',
  'req.headers.forwarded',
  '*.UPSTASH_REDIS_REST_TOKEN',
  '*.OPENSKY_CLIENT_SECRET',
  '*.AISSTREAM_API_KEY',
  '*.ADSB_EXCHANGE_API_KEY',
  ...(isProd ? ['req.remoteAddress', 'req.ip'] : []),
];

export const logger = pino({
  level: isTest ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  ...(!isProd && !isTest
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : {}),
});

/**
 * Backward-compatible log() wrapper that delegates to the pino logger.
 * Callers can continue using `log({ level, message, ...meta })` while
 * new code uses `logger.info(meta, message)` directly.
 */
export function log(entry: LogEntry): void {
  const { level, message, ...meta } = entry;
  logger[level](meta, message);
}

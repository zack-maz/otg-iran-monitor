import { timingSafeEqual } from 'node:crypto';

import { Ratelimit } from '@upstash/ratelimit';

import { redis } from '../cache/redis.js';

import type { Request, Response, NextFunction } from 'express';

/**
 * Create a sliding-window rate limiter middleware backed by Upstash Redis.
 *
 * - Skips entirely in non-production / non-Vercel environments to keep the
 *   local dev loop fast and avoid Redis writes during tests.
 * - Identifies callers by `req.ip`, falling back to the `x-forwarded-for`
 *   header when behind a proxy, then `'anonymous'` for sandboxed tools.
 * - Always sets `X-RateLimit-{Limit,Remaining,Reset}` response headers so
 *   clients can implement client-side backoff.
 * - On rejection, returns the canonical error envelope from
 *   `server/middleware/errorHandler.ts`:
 *
 *   ```json
 *   { "error": "Too many requests", "code": "RATE_LIMITED", "statusCode": 429 }
 *   ```
 *
 * @param maxRequests Max requests per window per caller.
 * @param windowSec Sliding window duration in seconds.
 * @param prefix Redis key prefix (defaults to `'ratelimit:prod'`). Pass a
 *   dedicated prefix like `'ratelimit:public'` when namespacing a baseline
 *   tier separately from per-endpoint tiers so their counters don't collide.
 */
/**
 * Phase 46 HARD-01 (D-02) — degrade-open per-tier-per-UTC-day 429 counter.
 *
 * Fires from the 429 branch of `rateLimitHandler` when a request is rejected.
 * INCRs `ratelimit:429:{tier}:{YYYY-MM-DD}` (UTC date) and, on the first INCR
 * of the day (`used === 1`), sets a 48h TTL (EXPIRE-on-first — the canonical
 * form from RESEARCH Pattern 1; cf. `replayQuota.ts:71-77`).
 *
 * CRITICAL degrade-open contract (D-02 / Pitfall 3): this helper sits on the
 * hot ERROR path inside the 429 branch. `redis.incr`/`redis.expire` are raw
 * (NOT wrapped by `cacheSetSafe`), so a Redis throw here would otherwise reject
 * the middleware promise → Express error handler → a 429 silently becomes a
 * 500. The ENTIRE body is wrapped in try/catch that swallows and returns void;
 * callers fire it as `void incr429(tier)` (fire-and-forget) so it can never
 * block or fail the 429 response. Precedent: `urlLiveness.ts` raw-incr
 * try/catch ("cacheSetSafe shape doesn't fit").
 *
 * The 48h TTL gives the operator-status aggregator a today+yesterday rolling
 * "recent 429s" window (RESEARCH Open-Q2) before the key self-expires.
 */
const INCR429_TTL_SEC = 48 * 60 * 60;

export async function incr429(tier: string): Promise<void> {
  try {
    const ymd = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD' UTC
    const key = `ratelimit:429:${tier}:${ymd}`;
    const used = await redis.incr(key);
    if (used === 1) {
      // EXPIRE-on-first: only the first INCR of the UTC day sets the TTL,
      // avoiding per-rejection TTL churn. A per-day key self-rolls, so a
      // missed EXPIRE (Redis flap) at worst leaks one dated key for ≤48h
      // until the next day's first INCR — never a permanent leak.
      await redis.expire(key, INCR429_TTL_SEC);
    }
  } catch {
    // Degrade-open (D-02 / Pitfall 3): swallow ALL errors. The 429 response
    // sends regardless — a counter failure must NEVER convert a 429 into a
    // 500 or block the rejected request.
  }
}

export function createRateLimiter(
  maxRequests: number,
  windowSec: number,
  prefix: string = 'ratelimit:prod',
  tierName?: string,
) {
  // The tier name MUST be part of the Redis prefix: @upstash/ratelimit keys on
  // `${prefix}:${identifier}` only, so tiers sharing a bare prefix share ONE
  // per-IP counter — 12 flights polls/min were being counted against the
  // 10/min sites/water/weather/geocode limits (found 2026-09).
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(maxRequests, `${windowSec} s`),
    prefix: tierName ? `${prefix}:${tierName}` : prefix,
  });

  return async function rateLimitHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // Skip rate limiting in local development
    if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
      next();
      return;
    }

    // D-04 (Phase 999.1 fold-in) + Phase 28.2 W6 audit-extension: when a valid
    // DASHBOARD_PASSWORD Bearer is present, skip the limiter entirely — for
    // both the global 'ratelimit:public' tier AND every per-endpoint tier.
    //
    // The original D-04 contract scoped bypass to the public tier only
    // ("defense in depth: a leaked operator Bearer cannot exhaust per-route
    // budgets"). The W6 prod connectivity audit (run 25467532661, 5/17 PASS)
    // surfaced that the 10/min per-endpoint limiters reject the audit's own
    // Bearer-attached probes when run repeatedly from a single GH-runner IP.
    // Operator scripts and the audit itself are the *only* known Bearer
    // holders; the smaller blast radius of "operator Bearer can drain a
    // per-route budget" is acceptable in exchange for a working audit + the
    // operator's own browser not self-throttling on cold-start polling burst.
    //
    // Empty DASHBOARD_PASSWORD means "no privileged callers configured",
    // so the bypass falls through to the existing limiter (NOT a 503;
    // differs from `dashboardAuth.ts` which fail-closes on missing config).
    //
    // The closure-captured `prefix` is no longer load-bearing for the bypass
    // decision; it remains in scope only for the namespaced Redis key.
    void prefix;
    {
      const expected = process.env.DASHBOARD_PASSWORD ?? '';
      if (expected !== '') {
        const header = req.headers.authorization ?? '';
        const bearerPrefix = 'Bearer ';
        if (header.startsWith(bearerPrefix)) {
          const provided = header.slice(bearerPrefix.length);
          // Length check is required before timingSafeEqual — Node throws
          // RangeError on unequal-length Buffers. Length is not the secret.
          if (provided.length === expected.length) {
            const a = Buffer.from(provided);
            const b = Buffer.from(expected);
            if (timingSafeEqual(a, b)) {
              next();
              return;
            }
          }
        }
      }
    }
    // Fall through to existing limiter.limit() pathway.

    const identifier = req.ip ?? (req.headers['x-forwarded-for'] as string) ?? 'anonymous';

    // Degrade-open: an Upstash error must not turn every /api/* request into a
    // 500 in front of routes that can still serve from cache.
    let result: Awaited<ReturnType<typeof limiter.limit>>;
    try {
      result = await limiter.limit(identifier);
    } catch {
      next();
      return;
    }

    res.set('X-RateLimit-Limit', String(result.limit));
    res.set('X-RateLimit-Remaining', String(result.remaining));
    res.set('X-RateLimit-Reset', String(result.reset));

    if (!result.success) {
      // Phase 46 HARD-01 (D-02) — fire-and-forget the per-tier-per-day 429
      // counter. `incr429` is fully try/caught internally and returns void;
      // `void` here makes the no-await explicit so a Redis throw can NEVER
      // turn this 429 into a 500 or delay the response (Pitfall 3). The tier
      // name falls back to the closure-captured `prefix` when not provided so
      // ad-hoc limiters (e.g. test-only `createRateLimiter(120, 60)`) still
      // produce a sensible, non-colliding key.
      void incr429(tierName ?? prefix);
      res.status(429).json({
        error: 'Too many requests',
        code: 'RATE_LIMITED',
        statusCode: 429,
      });
      return;
    }

    next();
  };
}

/**
 * Per-endpoint rate limiters with tuned limits.
 *
 * Limits are deliberately differentiated by client polling cadence and
 * upstream cost: routes with aggressive client polling (flights, ships) get
 * the largest budgets, expensive serverless routes (events, news) get the
 * smallest, and routes that fetch once per session (sites, water) sit in
 * between. All limits are per-IP per-minute.
 */
export const rateLimiters = {
  /** 120 req/min — flights poll every 5s in the browser; allow 2x headroom for tab focus bursts. */
  flights: createRateLimiter(120, 60, 'ratelimit:prod', 'flights'),
  /** 60 req/min — ships poll every 30s; allow burst when AISStream batches arrive. */
  ships: createRateLimiter(60, 60, 'ratelimit:prod', 'ships'),
  /** 20 req/min — events served from 15-min GDELT cache; clients rarely re-fetch. */
  events: createRateLimiter(20, 60, 'ratelimit:prod', 'events'),
  /** 20 req/min — news served from 15-min GDELT DOC cache; matches events cadence. */
  news: createRateLimiter(20, 60, 'ratelimit:prod', 'news'),
  /** 30 req/min — markets poll every 60s; allow modest burst on tab focus. */
  markets: createRateLimiter(30, 60, 'ratelimit:prod', 'markets'),
  /** 10 req/min — weather refreshed at 30-min cache TTL; barely polled. */
  weather: createRateLimiter(10, 60, 'ratelimit:prod', 'weather'),
  /** 10 req/min — sites are static infrastructure, fetched once on mount. */
  sites: createRateLimiter(10, 60, 'ratelimit:prod', 'sites'),
  /** 30 req/min — /api/sources is a lightweight config check, can spike on UI mounts. */
  sources: createRateLimiter(30, 60, 'ratelimit:prod', 'sources'),
  /** 10 req/min — Nominatim downstream caps us at 1 rps; cache aggressively. */
  geocode: createRateLimiter(10, 60, 'ratelimit:prod', 'geocode'),
  /** 10 req/min — water facilities are static, fetched once on mount. */
  water: createRateLimiter(10, 60, 'ratelimit:prod', 'water'),
  /**
   * 60 req/min — public global pre-filter for /api/* routes.
   *
   * Applied as a _global_ pre-filter across all `/api/*` routes in
   * `server/index.ts`, running _before_ the per-endpoint limiters above.
   * Job: catch obvious scraper abuse / runaway client recursion while
   * staying out of the way of legitimate dashboard sessions.
   *
   * Sized for the live dashboard's actual cold-start + steady-state cost:
   * AppShell mounts ~9 polling hooks (flights, ships, events, news,
   * markets, weather, water, waterPrecip, llmStatus) which burst-fire
   * their first fetch in <50ms. Steady-state ~20-25 req/min per tab from
   * flight polling + llm-status + health probe. Two open tabs ≈ 50/min.
   * 60/min handles both with margin.
   *
   * History: was 6/min (Plan 26.4-04). At that cap the dashboard tripped
   * its own rate limit on cold-start because hooks 7+ in the burst hit
   * 429 → setError → red dots. Raised in Phase 28.1 hot-fix on the same
   * branch as the cleanup sweep. Phase 28.2 D-04 will add Bearer bypass
   * for operator browsers, restoring tighter caps for anonymous traffic.
   *
   * The "strictly tighter than per-endpoint" property no longer holds —
   * sites/weather/water/geocode are 10/min, public is 60/min, so per-
   * endpoint limiters dominate for those routes. That's intentional:
   * public is a coarse abuse filter, per-endpoint is the real budget.
   *
   * Key prefix `'ratelimit:public'` namespaces this tier's counters so
   * they don't collide with per-endpoint counters under `'ratelimit:prod'`.
   */
  public: createRateLimiter(60, 60, 'ratelimit:public', 'public'),
} as const;

/**
 * Phase 46 HARD-01 (D-01 / A4) — operator-visible per-tier limit config.
 *
 * The `maxRequests`/`windowSec` numbers passed into `createRateLimiter` are
 * closure-captured and NOT introspectable from the returned middleware
 * function, so the `/api/operator-status` aggregator cannot read them off
 * `rateLimiters` directly. This sibling const mirrors the table above and is
 * the single source the aggregator's `rateLimiter` block reads to surface
 * per-tier limits alongside the recent `ratelimit:429:{tier}:{date}` counts.
 *
 * LOCKSTEP INVARIANT: every key + number here MUST byte-match the
 * `createRateLimiter(max, windowSec, ...)` arguments in `rateLimiters` above.
 * `rateLimit.test.ts` asserts this byte-identity so any drift fails the build.
 */
export const RATE_LIMITER_CONFIG: Record<string, { max: number; windowSec: number }> = {
  flights: { max: 120, windowSec: 60 },
  ships: { max: 60, windowSec: 60 },
  events: { max: 20, windowSec: 60 },
  news: { max: 20, windowSec: 60 },
  markets: { max: 30, windowSec: 60 },
  weather: { max: 10, windowSec: 60 },
  sites: { max: 10, windowSec: 60 },
  sources: { max: 30, windowSec: 60 },
  geocode: { max: 10, windowSec: 60 },
  water: { max: 10, windowSec: 60 },
  public: { max: 60, windowSec: 60 },
};

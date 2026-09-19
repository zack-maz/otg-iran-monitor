import { Redis } from '@upstash/redis';

import type { CacheResponse } from '../types.js';

/**
 * Phase 27.4.4 D-20 Option B (RESEARCH §6) — dev/prod key isolation.
 *
 * When `CACHE_KEY_PREFIX` is set in env (e.g. `dev:`), every key passing
 * through this exported `redis` instance gets the prefix applied
 * automatically. Production never sets the var; dev sets it in `.env.local`
 * so a dry-run against the same Upstash database doesn't pollute the live
 * `events:llm:v3` / `events:llm-eval-baseline:v3` / `events:llm-pipeline-audit`
 * keys.
 *
 * Implemented as a Proxy on the Redis client so all 30+ existing call sites
 * (redis.get, redis.set, redis.sadd, redis.expire, redis.hincrby, redis.zadd,
 *  redis.lpush, redis.lrange, redis.scard, redis.smembers, redis.srem, ...)
 * get prefixed without per-call-site changes. Methods that don't take a key
 * (`ping`, `dbsize`, `info`, `time`, `echo`, `flushall`, `flushdb`) pass
 * through unchanged. `del`/`unlink` may take multiple keys variadic; all
 * trailing string args are prefixed too. Other methods only ever take the
 * key as the first arg (members/values/fields are never keys).
 *
 * The four cacheGet/cacheSet/cacheGetSafe/cacheSetSafe helpers below all
 * funnel through this same `redis` instance, so they inherit the prefix
 * for free.
 */
const NON_KEY_METHODS = new Set<string>([
  'ping',
  'dbsize',
  'info',
  'time',
  'echo',
  'flushall',
  'flushdb',
]);
const VARIADIC_KEY_METHODS = new Set<string>(['del', 'unlink']);
// Phase 27.4.4 Plan 02 — SCAN's first arg is the cursor (an opaque string the
// server returns for pagination), not a key. The default key-prefix behavior
// would corrupt the cursor on iteration 2+ of a SCAN loop ("ERR invalid
// cursor"). The `match` option, however, IS a key-pattern and must receive
// the prefix so callers can write portable patterns like `geocode:*` and have
// them match the prefixed keys actually stored in dev.
const SCAN_METHODS = new Set<string>(['scan']);
// Phase 28.2 W6 hotfix — eval-family methods take the script (or its sha1) as
// args[0]; the keys live in args[1] as a `string[]`. Prefixing args[0] would
// corrupt the Lua script (Upstash returns "ERR Error running script:
// @user_script line:2(column:7) near 'local': syntax error" — the parser
// chokes on the prepended prefix as line 1). Instead, leave args[0] alone and
// prefix every element of the keys array. `@upstash/ratelimit` is the
// load-bearing caller — its sliding-window/fixed-window limit and refund
// scripts pass through this branch on every rate-limited request.
const EVAL_METHODS = new Set<string>(['eval', 'evalsha', 'eval_ro', 'evalsha_ro']);

function wrapWithPrefix(client: Redis): Redis {
  const prefix = process.env.CACHE_KEY_PREFIX ?? '';
  if (!prefix) return client;

  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (typeof prop !== 'string' || NON_KEY_METHODS.has(prop)) {
        return value.bind(target);
      }
      if (SCAN_METHODS.has(prop)) {
        return function (...args: unknown[]) {
          // Pass cursor (args[0]) through unchanged. Prefix the `match` option
          // when present so callers write unprefixed patterns and get correct
          // matches against prefixed keys.
          const opts = args[1] as { match?: string; count?: number } | undefined;
          if (opts && typeof opts.match === 'string') {
            args[1] = { ...opts, match: prefix + opts.match };
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (EVAL_METHODS.has(prop)) {
        return function (...args: unknown[]) {
          // args[0] is the script or sha — never prefixed. args[1] is the keys
          // array; each element gets the prefix so dev/prod isolation still
          // applies to whatever the script reads/writes. args[2] (the script
          // ARGV) passes through untouched.
          if (Array.isArray(args[1])) {
            args[1] = (args[1] as unknown[]).map((k) => (typeof k === 'string' ? prefix + k : k));
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return function (...args: unknown[]) {
        if (args.length > 0 && typeof args[0] === 'string') {
          args[0] = prefix + args[0];
        }
        if (VARIADIC_KEY_METHODS.has(prop)) {
          for (let i = 1; i < args.length; i++) {
            if (typeof args[i] === 'string') args[i] = prefix + args[i];
          }
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as Redis;
}

/** Shared Upstash Redis client (REST-based, safe for serverless).
 *
 * `enableAutoPipelining: false` — `@upstash/redis` 1.37 defaults this to true,
 * which silently batches `redis.eval(...)` from `@upstash/ratelimit` with any
 * other commands in flight on the same tick. Under Vercel's Fluid Compute the
 * batched wire format corrupts the script string and Upstash returns
 * `ERR Error running script: @user_script line:2(column:7) near 'local': syntax error`.
 * Single-call local repros never trigger the bug. Disabling autopipeline
 * forces serial command dispatch — the rate-limiter stays correct, throughput
 * is unaffected because we run one limiter check per request anyway.
 * Surfaced by Phase 28.2 W6 prod connectivity audit (run 25466712222).
 */
export const redis = wrapWithPrefix(
  new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    enableAutoPipelining: false,
  }),
);

/** Internal storage shape persisted in Redis */
interface CacheEntry<T> {
  data: T;
  fetchedAt: number; // Unix ms
}

/** In-memory fallback cache for when Redis is unavailable */
const memCache = new Map<string, { data: unknown; fetchedAt: number }>();

/**
 * Hard timeout (ms) for a single Redis operation inside the safe wrappers.
 *
 * Upstash REST is synchronous from our perspective (HTTP fetch under the hood),
 * but the client retries internally on network errors. Under pathological
 * network partitions or misconfiguration the call can hang indefinitely — e.g.
 * when `UPSTASH_REDIS_REST_URL` is missing the client still attempts to fetch
 * and retries per its default retry policy, blocking the request thread.
 *
 * 2000 ms is an order of magnitude above a healthy Upstash RTT (~10-80 ms),
 * so it doesn't affect the happy path, but it caps the worst case and lets
 * the safe wrapper fall through to the in-memory cache.
 */
const REDIS_OP_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Read a cached value from Redis.
 *
 * Returns null if the key does not exist.
 * Returns { data, stale, lastFresh } — where `stale` is true when
 * the entry age exceeds `logicalTtlMs`.
 */
export async function cacheGet<T>(
  key: string,
  logicalTtlMs: number,
): Promise<CacheResponse<T> | null> {
  const entry = await redis.get<CacheEntry<T>>(key);
  if (!entry) return null;

  const stale = Date.now() - entry.fetchedAt > logicalTtlMs;
  return {
    data: entry.data,
    stale,
    lastFresh: entry.fetchedAt,
  };
}

/**
 * Write a value to Redis with a hard TTL (seconds).
 *
 * The hard TTL should be generously larger than the logical TTL so that
 * stale-but-servable data remains available for upstream error fallback.
 */
export async function cacheSet<T>(key: string, data: T, redisTtlSec: number): Promise<void> {
  const entry: CacheEntry<T> = { data, fetchedAt: Date.now() };
  await redis.set(key, entry, { ex: redisTtlSec });
}

/**
 * Safe cache read with in-memory fallback.
 *
 * On Redis success: returns result and populates memCache.
 * On Redis failure: returns memCache entry with `degraded: true`.
 * On both miss: returns null.
 */
export async function cacheGetSafe<T>(
  key: string,
  logicalTtlMs: number,
): Promise<CacheResponse<T> | null> {
  try {
    const result = await withTimeout(
      cacheGet<T>(key, logicalTtlMs),
      REDIS_OP_TIMEOUT_MS,
      `cacheGet(${key})`,
    );
    if (result) {
      // Populate memCache on success
      memCache.set(key, { data: result.data, fetchedAt: result.lastFresh });
    }
    return result;
  } catch {
    // Redis failed or timed out -- try in-memory fallback
    const mem = memCache.get(key);
    if (mem) {
      return {
        data: mem.data as T,
        stale: true,
        lastFresh: mem.fetchedAt,
        degraded: true,
      };
    }
    return null;
  }
}

/**
 * Cache write for background jobs whose whole purpose is the write (the LLM
 * pipeline's `events:llm:v3`). Unlike `cacheSetSafe` it waits longer than the
 * 2 s request-path budget — the payload is the full enriched corpus — and it
 * reports the outcome instead of swallowing it, so the caller cannot log
 * "persisted" over a write that never landed. Never throws.
 */
const REDIS_BULK_WRITE_TIMEOUT_MS = 20_000;

export async function cacheSetReported<T>(
  key: string,
  data: T,
  redisTtlSec: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  memCache.set(key, { data, fetchedAt: Date.now() });
  try {
    await withTimeout(
      cacheSet(key, data, redisTtlSec),
      REDIS_BULK_WRITE_TIMEOUT_MS,
      `cacheSet(${key})`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Safe cache write to both Redis and in-memory fallback.
 *
 * Always writes to memCache regardless of Redis success.
 */
export async function cacheSetSafe<T>(key: string, data: T, redisTtlSec: number): Promise<void> {
  // Always update memCache first
  memCache.set(key, { data, fetchedAt: Date.now() });
  try {
    await withTimeout(cacheSet(key, data, redisTtlSec), REDIS_OP_TIMEOUT_MS, `cacheSet(${key})`);
  } catch {
    // Swallow Redis error or timeout -- memCache is already updated
  }
}

/**
 * Raw GDELT refresh — fetch the latest GDELT export, merge it into the
 * `events:gdelt` accumulator (with lazy WAR_START backfill), and persist.
 *
 * Shared by two callers:
 *   - `GET /api/events` (server/routes/events.ts) — refreshes on a stale/missing cache.
 *   - `runRefreshExtraction` (server/lib/llmExtractionPipeline.ts) — the cron has no
 *     client to warm `events:gdelt` for it. Before this module existed the cron
 *     read the key cache-only, so with no dashboard tab open inside the key's hard
 *     TTL every run exited `no_raw_events` and `events:llm:v3` stayed cold.
 */
import { fetchEvents, backfillEvents } from '../adapters/gdelt.js';
import { cacheGetSafe, cacheSetSafe, redis } from '../cache/redis.js';
import { WAR_START } from '../config.js';

import { extractBellingcatGeo } from './eventScoring.js';
import { logger } from './logger.js';
import { extractDomain, getSourceTier } from './sourceTiers.js';

import type { ConflictEventEntity, NewsCluster } from '../types.js';

const log = logger.child({ module: 'raw-events-refresh' });

/** Raw GDELT accumulator key. */
export const EVENTS_KEY = 'events:gdelt';

/** Logical TTL — raw rows older than this are refreshed (15 min, GDELT's update cadence). */
export const EVENTS_LOGICAL_TTL_MS = 900_000;

/** Hard Redis TTL for `events:gdelt` — 150 min (10x the 15-min logical TTL). */
export const EVENTS_REDIS_TTL_SEC = 9000;

/** Redis key for backfill cooldown timestamp */
const BACKFILL_KEY = 'events:backfill-ts';

/** Backfill cooldown: 1 hour */
const BACKFILL_COOLDOWN_MS = 3_600_000;

/**
 * Check whether a backfill should run.
 * Returns true if never backfilled or cooldown has expired.
 *
 * Resilient to Redis death: if the redis client throws (e.g. Upstash REST is
 * down), we allow the backfill attempt rather than crashing the request. The
 * backfill itself is wrapped in its own try/catch by the caller, so a
 * subsequent redis.set failure is also non-fatal.
 */
async function shouldBackfill(): Promise<boolean> {
  try {
    const lastTs = await redis.get<number>(BACKFILL_KEY);
    if (lastTs === null || lastTs === undefined) return true;
    return Date.now() - lastTs > BACKFILL_COOLDOWN_MS;
  } catch {
    // Redis unreachable -- allow backfill, it has its own error handling
    return true;
  }
}

/**
 * Persist the backfill timestamp without throwing on Redis failure.
 * Best-effort: if Redis is dead, the next request will simply re-attempt
 * the backfill (rate-limited by GDELT itself, not catastrophic).
 */
async function recordBackfillTimestamp(): Promise<void> {
  try {
    await redis.set(BACKFILL_KEY, Date.now(), { ex: EVENTS_REDIS_TTL_SEC });
  } catch {
    // Swallow: cooldown tracking is non-critical
  }
}

export interface RefreshRawEventsOpts {
  /** Existing accumulator contents (stale is fine) to merge fresh events into. */
  cached: { data: ConflictEventEntity[] } | null;
  /** Force a WAR_START backfill regardless of cooldown (`?backfill=true`). */
  forceBackfill?: boolean;
}

/**
 * Fetch fresh GDELT events, merge into the accumulator, persist to
 * `events:gdelt`, and return the merged set. Throws if the GDELT fetch fails —
 * callers own the fallback (stale cache for the route, skip for the cron).
 */
export async function refreshRawEvents(opts: RefreshRawEventsOpts): Promise<ConflictEventEntity[]> {
  const { cached, forceBackfill = false } = opts;

  // Extract Bellingcat articles from news cache for corroboration boost (opportunistic)
  let bellingcatArticles: {
    title: string;
    url: string;
    publishedAt: number;
    lat?: number;
    lng?: number;
  }[] = [];
  try {
    const newsCache = await cacheGetSafe<NewsCluster[]>('news:gdelt', 0);
    if (newsCache?.data) {
      bellingcatArticles = newsCache.data
        .flatMap((cluster) => cluster.articles)
        .filter((a) => a.source === 'Bellingcat')
        .map((a) => ({
          title: a.title,
          url: a.url,
          publishedAt: a.publishedAt,
          ...extractBellingcatGeo(a.title),
        }));
    }
  } catch {
    // Non-fatal: if news cache is unavailable, proceed without corroboration
    log.warn('failed to fetch Bellingcat articles for corroboration');
  }

  const fresh = await fetchEvents(bellingcatArticles);

  // Merge: seed with cached data (if any), then overwrite with fresh events
  const eventMap = new Map<string, ConflictEventEntity>();
  if (cached) {
    for (const event of cached.data) {
      eventMap.set(event.id, event);
    }
  }

  // Lazy backfill: seed historical events when cache is empty or forced
  if ((!cached || forceBackfill) && (forceBackfill || (await shouldBackfill()))) {
    try {
      const backfillDays = Math.ceil((Date.now() - WAR_START) / 86_400_000);
      const backfillData = await backfillEvents(backfillDays);
      // Merge backfill first so fresh events overwrite any duplicates
      for (const event of backfillData) {
        eventMap.set(event.id, event);
      }
      await recordBackfillTimestamp();
      log.info({ count: backfillData.length }, 'backfill: merged historical events');
    } catch (backfillErr) {
      log.warn({ err: backfillErr }, 'backfill failed (non-fatal)');
    }
  }

  for (const event of fresh) {
    eventMap.set(event.id, event);
  }

  // Prune events with timestamp before WAR_START
  for (const [id, event] of eventMap) {
    if (event.timestamp < WAR_START) {
      eventMap.delete(id);
    }
  }

  const merged = Array.from(eventMap.values());

  // Inject sourceTier on raw events that don't already have it
  for (const event of merged) {
    if (event.data.sourceTier === undefined && event.data.source) {
      const domain = extractDomain(event.data.source);
      const tier = domain ? getSourceTier('', domain) : null;
      if (tier !== null) {
        event.data.sourceTier = tier;
      }
    }
  }

  // Store raw (undispersed) coordinates — dispersion is applied client-side
  // in useFilteredEntities so it dynamically adjusts when filters change.
  await cacheSetSafe(EVENTS_KEY, merged, EVENTS_REDIS_TTL_SEC);

  return merged;
}

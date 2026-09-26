#!/usr/bin/env node
/**
 * Phase 43 Plan 04 Task 1 (GHOST-09 / SC-3, D-13 / D-14) — production
 * evidence-sample for the 403 auto-prune demotion decision.
 *
 * Gathers the evidence the GHOST-09 decision is gated on BEFORE Plan 43-05
 * implements the cron-only 403 prune-filter change (the diagnosis-first
 * pattern mirroring Phase 42's D-03 pivot). It:
 *
 *   1. Reads recent `prune-dead-urls` entries from the production
 *      `operator:audit-log` (SADD set) and collects their `args.prunedIds`
 *      arrays (D-13). For each pruned eventId it resolves a last-known URL
 *      where one is still recoverable — pruned events have their
 *      `events:url-liveness:{eventId}` key DELETED by the prune
 *      (urlLiveness.ts:1149-1150), so most pruned URLs are NOT recoverable
 *      from Redis post-prune; those are reported `unresolvable` and the
 *      operator can re-run after a fresh prune (or against the aggregator).
 *   2. SCANs the `events:url-liveness:*` keyspace for entries with
 *      `status === '403'` and collects those URLs (the current bot-blocked
 *      candidates — the same set the `/api/operator-status` `deadUrlSample`
 *      surfaces, but unbounded by the 20-row drill-down cap).
 *   3. Re-probes each sampled URL with a BROWSER-like User-Agent
 *      (HEAD-then-GET) and records the HTTP status + a live/dead verdict per
 *      URL. The production prober uses `IranMonitor-LinkCheck/1.0`
 *      (urlLiveness.ts:211); if a browser UA gets 200 where the bot UA got
 *      403/404, the bot-blocking-CDN false-positive hypothesis is confirmed.
 *   4. Prints two markdown verdict tables (URL → browser-UA status →
 *      verdict) suitable for pasting into 43-VERIFICATION.md.
 *
 * Degrade-open: any fetch failure is recorded as `dead-host` / `unknown`,
 * never crashes the script (T-43-13). A polite per-request delay throttles
 * the re-probe so it reads as a citizen, not a scanner (T-43-12).
 *
 * Credentials (T-43-11 — env only, never hard-coded):
 *   - Direct Redis mode (default): requires `UPSTASH_REDIS_REST_URL` +
 *     `UPSTASH_REDIS_REST_TOKEN`. Reads prod Redis via the wrapped `redis`
 *     instance (CACHE_KEY_PREFIX honored — a dev run with CACHE_KEY_PREFIX
 *     set reads dev keys; an unset prefix reads prod keys). Closest analog:
 *     scripts/snapshot-v3-redis.ts.
 *   - Aggregator mode (`--via-aggregator`): requires `DASHBOARD_PASSWORD`.
 *     Reads the Bearer-gated `/api/operator-status` `.prune.deadUrlSample`
 *     (403 rows only) when direct Redis access is unavailable. The audit-log
 *     `prunedIds` are NOT exposed by the aggregator beyond the
 *     `last24hPrunes` count, so prunedIds-URL resolution is direct-Redis-only.
 *
 * Usage:
 *   npx tsx scripts/sample-pruned-urls.ts [--via-aggregator] [--limit=20] [--delay-ms=1500]
 *   # or, to load .env automatically:
 *   node --env-file-if-exists=.env --env-file-if-exists=.env.local \
 *     --import tsx/esm scripts/sample-pruned-urls.ts
 *
 * No secret is printed or written; only URLs, statuses, and verdicts.
 */

import type { UrlLiveness } from '../server/lib/urlLiveness.js';

// Browser-like UA — the whole point of the re-probe (grep "Mozilla").
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const PROD_BASE = 'https://motg-iran.vercel.app';
const URL_LIVENESS_KEY_PREFIX = 'events:url-liveness:';
const OPERATOR_AUDIT_KEY = 'operator:audit-log';
const PROBE_TIMEOUT_MS = 10_000;

interface CliArgs {
  viaAggregator: boolean;
  limit: number;
  delayMs: number;
}

function parseArgs(): CliArgs {
  const viaAggregator = process.argv.includes('--via-aggregator');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const delayArg = process.argv.find((a) => a.startsWith('--delay-ms='));
  const limit = limitArg ? Number.parseInt(limitArg.split('=')[1] ?? '', 10) : 20;
  const delayMs = delayArg ? Number.parseInt(delayArg.split('=')[1] ?? '', 10) : 1500;
  return {
    viaAggregator,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
    delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 1500,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Verdict = 'live' | 'dead' | 'unknown';

interface ProbeRow {
  eventId: string;
  url: string;
  /** Status recorded by the production bot-UA prober (when known). */
  probeUaStatus: string;
  /** HTTP status (or failure token) seen by THIS browser-UA re-probe. */
  browserUaStatus: string;
  verdict: Verdict;
}

/**
 * Re-probe a single URL with the browser UA. HEAD first; if HEAD is
 * inconclusive (405/501/network), fall back to a capped GET. Degrade-open:
 * a thrown fetch (DNS failure, TLS error, abort) records `dead-host` and
 * never propagates.
 */
async function reprobeBrowserUa(
  url: string,
): Promise<{ browserUaStatus: string; verdict: Verdict }> {
  const attempt = async (method: 'HEAD' | 'GET'): Promise<number | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { 'User-Agent': BROWSER_UA };
      if (method === 'GET') headers.Range = 'bytes=0-1023';
      const res = await fetch(url, {
        method,
        headers,
        redirect: 'follow',
        signal: controller.signal,
      });
      return res.status;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  let status = await attempt('HEAD');
  // HEAD blocked / not allowed → try a capped GET (many publishers 405 HEAD).
  if (status === null || status === 405 || status === 501 || status === 403) {
    const getStatus = await attempt('GET');
    if (getStatus !== null) status = getStatus;
  }

  if (status === null) return { browserUaStatus: 'dead-host: fetch failed', verdict: 'dead' };
  if (status >= 200 && status < 300) return { browserUaStatus: String(status), verdict: 'live' };
  if (status >= 300 && status < 400) return { browserUaStatus: String(status), verdict: 'live' };
  if (status === 403) return { browserUaStatus: '403', verdict: 'dead' };
  if (status === 404 || status === 410) return { browserUaStatus: String(status), verdict: 'dead' };
  // 5xx / other 4xx — inconclusive (could be transient).
  return { browserUaStatus: String(status), verdict: 'unknown' };
}

/** A single `operator:audit-log` member's parsed shape (subset we read). */
interface AuditEntry {
  timestamp?: number;
  operation?: string;
  args?: { trigger?: string; prunedCount?: number; prunedIds?: string[] };
}

/**
 * Direct-Redis path: read prunedIds from the audit-log, resolve any still-
 * recoverable URLs, and SCAN the 403-status keys.
 */
async function gatherViaRedis(limit: number): Promise<{
  prunedTargets: { eventId: string; url: string | null }[];
  live403: { eventId: string; url: string }[];
}> {
  // Raw @upstash/redis client (dynamic import so --via-aggregator mode runs
  // WITHOUT Upstash env present). Deliberately NOT the server cache module:
  // that client applies the dev `CACHE_KEY_PREFIX` from .env.local, which
  // would silently SCAN the empty `dev:` keyspace when this prod-sampling
  // script runs on a dev machine. This tool's whole purpose is to read the
  // LIVE production keys, so it must stay unprefixed.
  const { Redis } = await import('@upstash/redis');
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    enableAutoPipelining: false,
  });

  // 1. prunedIds from recent prune-dead-urls audit entries.
  const prunedTargets: { eventId: string; url: string | null }[] = [];
  try {
    const members = ((await redis.smembers(OPERATOR_AUDIT_KEY)) as string[]) ?? [];
    const pruneEntries: AuditEntry[] = [];
    for (const m of members) {
      try {
        const parsed = typeof m === 'string' ? (JSON.parse(m) as AuditEntry) : (m as AuditEntry);
        if (parsed.operation === 'prune-dead-urls' && Array.isArray(parsed.args?.prunedIds)) {
          pruneEntries.push(parsed);
        }
      } catch {
        // Non-JSON / legacy member — skip.
      }
    }
    // Newest first.
    pruneEntries.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    const seen = new Set<string>();
    for (const entry of pruneEntries) {
      for (const eventId of entry.args?.prunedIds ?? []) {
        if (seen.has(eventId)) continue;
        seen.add(eventId);
        // The url-liveness key is usually DELETED by the prune; try anyway.
        let url: string | null = null;
        try {
          // Values are persisted via cacheSetSafe as CacheEntry<UrlLiveness>
          // ({data, fetchedAt}); unwrap .data with a bare-shape fallback for
          // any legacy unwrapped writes.
          const raw = (await redis.get(`${URL_LIVENESS_KEY_PREFIX}${eventId}`)) as
            | { data?: UrlLiveness }
            | UrlLiveness
            | null;
          const cached = (raw && 'data' in raw ? raw.data : raw) as UrlLiveness | null;
          url = cached?.lastUrlProbed ?? null;
        } catch {
          url = null;
        }
        prunedTargets.push({ eventId, url });
        if (prunedTargets.length >= limit) break;
      }
      if (prunedTargets.length >= limit) break;
    }
  } catch (err) {
    console.error(
      'warn: failed to read operator:audit-log —',
      err instanceof Error ? err.message : err,
    );
  }

  // 2. SCAN events:url-liveness:* for status === '403'.
  const live403: { eventId: string; url: string }[] = [];
  try {
    let cursor: string | number = 0;
    let scanned = 0;
    do {
      const reply = (await redis.scan(cursor, {
        match: `${URL_LIVENESS_KEY_PREFIX}*`,
        count: 50,
      })) as [string | number, string[]];
      cursor = reply[0];
      for (const key of reply[1]) {
        if (scanned >= 500 || live403.length >= limit) {
          cursor = 0;
          break;
        }
        scanned += 1;
        try {
          // CacheEntry<UrlLiveness> unwrap — same rationale as the prunedIds
          // read above.
          const raw = (await redis.get(key)) as { data?: UrlLiveness } | UrlLiveness | null;
          const value = (raw && 'data' in raw ? raw.data : raw) as UrlLiveness | null;
          if (value?.status === '403' && value.lastUrlProbed) {
            const eventId = key.startsWith(URL_LIVENESS_KEY_PREFIX)
              ? key.slice(URL_LIVENESS_KEY_PREFIX.length)
              : key;
            live403.push({ eventId, url: value.lastUrlProbed });
          }
        } catch {
          // Per-key failure — skip, keep scanning.
        }
      }
    } while (cursor !== 0 && cursor !== '0' && live403.length < limit);
  } catch (err) {
    console.error('warn: SCAN for 403 keys failed —', err instanceof Error ? err.message : err);
  }

  return { prunedTargets, live403 };
}

/**
 * Aggregator path: read the Bearer-gated `/api/operator-status`
 * `.prune.deadUrlSample` and keep the `status === '403'` rows. prunedIds are
 * NOT exposed by the aggregator (only the `last24hPrunes` count), so this
 * path covers the 403-keys half only.
 */
async function gatherViaAggregator(): Promise<{ live403: { eventId: string; url: string }[] }> {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    throw new Error('DASHBOARD_PASSWORD is required for --via-aggregator mode (env only)');
  }
  const res = await fetch(`${PROD_BASE}/api/operator-status`, {
    headers: { Authorization: `Bearer ${password}` },
  });
  if (!res.ok) {
    throw new Error(`/api/operator-status returned ${res.status}`);
  }
  const body = (await res.json()) as {
    prune?: { deadUrlSample?: { eventId: string; url: string; status: string }[] };
  };
  const sample = body.prune?.deadUrlSample ?? [];
  const live403 = sample
    .filter((r) => r.status === '403' && typeof r.url === 'string' && r.url.length > 0)
    .map((r) => ({ eventId: r.eventId, url: r.url }));
  return { live403 };
}

function renderTable(title: string, rows: ProbeRow[]): string {
  const lines: string[] = [];
  lines.push(`### ${title}`);
  lines.push('');
  if (rows.length === 0) {
    lines.push('_No rows in this sample._');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('| eventId | URL | probe-UA status | browser-UA status | verdict |');
  lines.push('| ------- | --- | --------------- | ----------------- | ------- |');
  for (const r of rows) {
    const url = r.url.replace(/\|/g, '%7C');
    lines.push(
      `| \`${r.eventId}\` | ${url} | ${r.probeUaStatus} | ${r.browserUaStatus} | ${r.verdict} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { viaAggregator, limit, delayMs } = parseArgs();

  let prunedTargets: { eventId: string; url: string | null }[] = [];
  let live403: { eventId: string; url: string }[] = [];

  if (viaAggregator) {
    const out = await gatherViaAggregator();
    live403 = out.live403;
    console.error(
      'note: --via-aggregator mode — prunedIds-URL resolution is unavailable (direct-Redis only). Reporting 403 sample only.',
    );
  } else {
    const out = await gatherViaRedis(limit);
    prunedTargets = out.prunedTargets;
    live403 = out.live403;
  }

  // Re-probe prunedIds sample (only the resolvable URLs).
  const prunedRows: ProbeRow[] = [];
  let unresolvable = 0;
  for (const t of prunedTargets) {
    if (!t.url) {
      unresolvable += 1;
      continue;
    }
    const { browserUaStatus, verdict } = await reprobeBrowserUa(t.url);
    prunedRows.push({
      eventId: t.eventId,
      url: t.url,
      probeUaStatus: 'pruned (terminal-dead)',
      browserUaStatus,
      verdict,
    });
    await sleep(delayMs);
  }

  // Re-probe 403 sample.
  const live403Rows: ProbeRow[] = [];
  for (const t of live403.slice(0, limit)) {
    const { browserUaStatus, verdict } = await reprobeBrowserUa(t.url);
    live403Rows.push({
      eventId: t.eventId,
      url: t.url,
      probeUaStatus: '403',
      browserUaStatus,
      verdict,
    });
    await sleep(delayMs);
  }

  const liveInPruned = prunedRows.filter((r) => r.verdict === 'live').length;
  const live403Confirmed = live403Rows.filter((r) => r.verdict === 'live').length;

  const out: string[] = [];
  out.push(`## GHOST-09 / SC-3 Evidence Sample`);
  out.push('');
  out.push(`_Generated ${new Date().toISOString()} by \`scripts/sample-pruned-urls.ts\`._`);
  out.push(
    `_Browser UA: \`${BROWSER_UA}\` — production prober UA: \`IranMonitor-LinkCheck/1.0\`._`,
  );
  out.push('');
  out.push(
    renderTable(
      `prunedIds sample (re-probed with browser UA) — ${prunedRows.length} resolvable, ${unresolvable} unresolvable (key deleted by prune)`,
      prunedRows,
    ),
  );
  out.push(renderTable(`403-status keys sample (re-probed with browser UA)`, live403Rows));
  out.push('');
  out.push(
    `**SC-3 verdict:** ${liveInPruned === 0 ? 'PASS — zero live URLs in the prunedIds sample.' : `FLAG — ${liveInPruned} live URL(s) in the prunedIds sample (a prune swept a live event).`}`,
  );
  out.push('');
  out.push(
    `**403 false-positive signal:** ${live403Confirmed} of ${live403Rows.length} re-probed 403-status URLs serve a LIVE article with a browser UA. ${live403Confirmed > 0 ? 'Bot-blocking-CDN false-positive hypothesis SUPPORTED → favors DEMOTE 403 to manual-only cron prune (D-14).' : 'No live-in-browser 403s in this sample → favors KEEP 403 cron-prunable (genuinely dead).'}`,
  );
  out.push('');
  out.push(
    `_Paste this section into 43-VERIFICATION.md and record the locked DEMOTE/KEEP decision (Task 2)._`,
  );

  console.log(out.join('\n'));
}

main().catch((err) => {
  console.error('sample-pruned-urls failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

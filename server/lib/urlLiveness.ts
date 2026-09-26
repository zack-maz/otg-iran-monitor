/**
 * Phase 32 (Plan 32-01) — UrlLiveness schema + tiered TTL surface.
 *
 * Foundation module for the ghost-event URL liveness pipeline. This file
 * lands the Zod contract + TTL upper-bound helper + Redis key namespace
 * constants BEFORE any writer / reader exists so future commits in plans
 * 32-02..32-06 compile against a pinned surface and a `.strict()` schema
 * drift fails the next `vitest run`.
 *
 * Decisions implemented in this file:
 *   - D-19  Per-event Redis key shape: `events:url-liveness:{eventId}`
 *           with a JSON value `{status, lastProbedAt, attemptCount,
 *           lastUrlProbed, lastHttpStatus}`.
 *   - D-20  Tiered TTL by status: `live` → 7d, terminal-dead
 *           (`404`/`403`/`dead-host`) → 24h, `unknown` → 24h (WR-02 — raised
 *           from 1h so entries survive the once-daily sweep gap).
 *   - D-22  Schema is `z.object({...}).strict()` so extra keys / missing
 *           fields / unknown enum values all throw at parse time. The
 *           D-22 contract test (`server/__tests__/lib/urlLiveness.schema.test.ts`)
 *           pins this BEFORE Plan 02 adds the probe writer — silent shape
 *           drift fails the next `vitest run`.
 *
 * NOT in this file (lands in Plans 02 + 03):
 *   - `probeUrl` HTTP HEAD/GET primitive (Plan 02 Task 1; D-16/D-17/D-18/D-21).
 *   - `runProbeSweep` orchestrator + per-host throttle map (Plan 02 Tasks 2-5).
 *   - `pruneDeadUrlEvents` Redis splice + audit-log helper (Plan 03 Task 1).
 *   - `events:url-liveness-count` sidecar INCR/DECR (Plan 02 Task 3 +
 *     Plan 03 Task 1 jointly maintain the integer; the key constant is
 *     declared here as the canonical single source of truth).
 *
 * The unused `log` binding is pre-wired so Plans 02/03 do not need to
 * re-edit the imports — they consume `log.info`/`log.warn`/`log.error`
 * inside the probe + sweep + prune helpers.
 */

import { z } from 'zod';

import { cacheGetSafe, cacheSetSafe, redis } from '../cache/redis.js';

import { createLimit } from './concurrencyLimit.js';
// Phase 32 Plan 32-03 — reuse the canonical v3 cache key + terminal v3 cache
// TTL from llmExtractionPipeline so the prune splice writer shares ONE truth
// source with the cron writer. Hand-rolling the literal 'events:llm:v3' or the
// 48h LLM_TERMINAL_TTL_SEC here is the exact drift class CLAUDE.md §"Serverless
// Cache" warns against. The prune splice MUST use the terminal TTL (not the
// short cooldown sentinel) so it never silently re-TTLs v3 down. The
// plan-checker MEDIUM-01 note (Upstash SCAN
// signature) is honored inline at the SCAN call below — the cast to
// `Promise<[string | number, string[]]>` matches @upstash/redis ^1.37.0
// and the pinning pattern Plan 04's buildDeadUrlSample uses for its
// SCAN iteration.
import { LLM_EVENTS_KEY_ACTIVE, LLM_TERMINAL_TTL_SEC } from './llmExtractionPipeline.js';
import { logger } from './logger.js';
import { appendOperatorAuditEntry } from './operatorAudit.js';

// ============================================================================
// Redis key namespace constants
// ============================================================================

/**
 * D-19 — per-event URL-liveness key family prefix. Callers append the
 * event ID: `${URL_LIVENESS_KEY_PREFIX}${eventId}` → `events:url-liveness:abc123`.
 * Written by the probe sweep (Plan 32-02), DEL'd by `pruneDeadUrlEvents`
 * (Plan 32-03). Tiered TTL per status — see `ttlSecForStatus` below.
 */
export const URL_LIVENESS_KEY_PREFIX = 'events:url-liveness:';

/**
 * Pitfall 3 mitigation — sidecar integer key. Count of events whose primary
 * URL has terminal-dead status. INCR on live→dead transitions, DECR on
 * dead→non-dead AND on prune. No TTL (persistent). Avoids N Redis GETs per
 * dashboard poll. Maintained by Plan 32-02 (probe writer) and Plan 32-03
 * (prune helper); read by Plan 32-04 (`/api/operator-status` aggregator).
 */
export const URL_LIVENESS_COUNT_KEY = 'events:url-liveness-count';

// ============================================================================
// Zod schema + types (D-22 contract — pinned BEFORE any writer exists)
// ============================================================================

/**
 * D-04/D-06 + D-19 — seven-status taxonomy (Phase 43 widens the Phase 32
 * five-status set with `soft-404` and `no-url`). Terminal-dead statuses
 * (`404`/`403`/`dead-host`/`soft-404`) count toward the dashboard dead-URL
 * count and are eligible for prune. `unknown` (5xx, network blip, transient
 * error) is excluded from the count and re-probed on the next sweep
 * tick. `no-url` (event has no primary URL to probe) is NOT terminal-dead
 * (D-08) — it is bookkeeping for events that can never have a live link.
 * `live` is live.
 */
export const UrlLivenessStatusSchema = z.enum([
  'live',
  '404',
  '403',
  'dead-host',
  'unknown',
  'soft-404',
  'no-url',
]);
export type UrlLivenessStatus = z.infer<typeof UrlLivenessStatusSchema>;

/**
 * D-22 contract — `.strict()` rejects extra keys, missing fields, AND
 * unknown enum values at parse time. The matching contract test at
 * `server/__tests__/lib/urlLiveness.schema.test.ts` pins this so future
 * shape drift fails the next `vitest run`.
 */
export const UrlLivenessSchema = z
  .object({
    status: UrlLivenessStatusSchema,
    lastProbedAt: z.string().datetime(),
    /**
     * Phase 32 D-12 / 32-RESEARCH.md A2 origin: monotonic-with-reset on
     * any non-dead transition. Phase 43 D-10 AMENDS this: `live` resets to
     * 0; `unknown` PRESERVES the prior count (a transient blip must not
     * erase an accumulating terminal-dead run); `dead→dead` increments.
     * The "≥3 consecutive terminal-dead ticks" cron auto-prune gate
     * (D-12) therefore survives a single intervening `unknown` tick.
     *
     * Increment ONLY when the latest probe status is terminal-dead AND
     * the prior stored status was also terminal-dead (or first-write
     * dead → start at 1). `no-url` resets to 0 (it is not a dead run).
     */
    attemptCount: z.number().int().nonnegative(),
    /**
     * D-07 — nullable so a `no-url` entry (event has no primary URL to
     * probe) can record `lastUrlProbed: null`. All other statuses carry
     * the probed URL string.
     */
    lastUrlProbed: z.string().url().nullable(),
    lastHttpStatus: z.number().int().nullable(),
    /**
     * D-16 — required-but-nullable provenance string (≤200 chars).
     * Carries the body/redirect heuristic that produced a `soft-404`
     * verdict (e.g. `'soft-404: matched "page not found" in title'`),
     * the status-code literal for hard 4xx (`'http-404'`, `'http-403'`),
     * the dead-host reason (`'dead-host: fetch failed'`), or `null` for
     * `live`/`unknown`/`no-url` verdicts with no body evidence yet.
     * Required so the writer always carries it; nullable so status-only
     * verdicts need no synthetic prose. Old Phase 32 entries lacking this
     * field are read via TS-generic cast (no runtime re-parse) and surface
     * as `undefined`/`null` safely (T-43-01 accept).
     */
    evidence: z.string().max(200).nullable(),
  })
  .strict();

export type UrlLiveness = z.infer<typeof UrlLivenessSchema>;

// ============================================================================
// D-20 tiered TTL (per status)
// ============================================================================

/**
 * D-20 — TTL ceilings by status. Re-probe cadence proportional to verdict
 * confidence: live verdicts last a week (no need to re-confirm fresh
 * content frequently), terminal-dead verdicts re-confirm daily (so the
 * prune list stays current as publishers move URLs).
 *
 * The TTL itself is the GC mechanism — there is no separate cleanup
 * pass. When the per-event key expires, the next sweep tick re-probes it.
 *
 * WR-02/WR-03 (GHOST-08 intent restored) — `unknown` was raised from 1h
 * to 24h. `cacheSetSafe` writes this value as the HARD Redis TTL (no 10×
 * multiplier — `server/cache/redis.ts` `cacheSet` does `{ ex: redisTtlSec }`).
 * The sweep runs ONCE per day (4am cron). At a 1h TTL an `unknown` entry had
 * ALWAYS expired by the next daily probe, so on the post-blip tick the writer
 * read `prior = null` and RESTARTED attemptCount at 1 — making the D-10
 * "unknown PRESERVES the prior count" rule unreachable at the production
 * cadence (the flaky-host dead→unknown→dead accumulation it was built for
 * never crossed the ≥3 gate). It ALSO meant an expired-then-re-probed dead
 * entry read `prior = null` and re-INCR'd the sidecar (WR-03 monotonic
 * inflation). A 24h logical tier lets unknown (and terminal-dead) entries
 * survive between daily ticks so `prior` is non-null on the next sweep,
 * engaging the D-10 preserve rule and avoiding the spurious re-INCR.
 *
 * Schema test (Plan 32-01 Task 3) asserts each value here matches the
 * D-20 upper-bound, so silent ceiling raises fail loudly.
 */
const TTL_SEC_BY_STATUS: Record<UrlLivenessStatus, number> = {
  live: 7 * 24 * 3600, // D-20: 7 days
  '404': 24 * 3600, // D-20: 24 hours
  '403': 24 * 3600, // D-20: 24 hours
  'dead-host': 24 * 3600, // D-20: 24 hours
  unknown: 24 * 3600, // WR-02: 24 hours (raised from 1h — must survive the daily sweep gap)
  'soft-404': 24 * 3600, // D-04/D-09: 24 hours (terminal-dead tier)
  'no-url': 24 * 3600, // D-04/D-09: 24 hours (re-confirm no-url daily)
};

/**
 * Look up the TTL (in seconds) for a given liveness status. Pure
 * function — no Redis call, no side effects. Used by the probe writer
 * (Plan 32-02) when calling `cacheSetSafe(key, entry, ttlSecForStatus(status))`.
 */
export function ttlSecForStatus(status: UrlLivenessStatus): number {
  return TTL_SEC_BY_STATUS[status];
}

// ============================================================================
// Module-private log binding (pre-wired for Plans 02/03)
// ============================================================================

/**
 * Pino child logger for the urlLiveness module. Pre-declared here so
 * Plans 02/03 (probe + sweep + prune helpers) do not need to re-edit
 * imports.
 */
const log = logger.child({ module: 'urlLiveness' });

// ============================================================================
// Plan 32-02 — probe primitives (D-16, D-17, D-18, D-21)
// ============================================================================

/**
 * D-18 — polite-citizen constants. Hard-coded per CONTEXT "no new
 * env-tunable surfaces" — these are domain knobs for this phase, not
 * operator levers. If a future incident requires emergency tuning,
 * promote to a `VITE_PROBE_*` env family in a separate decimal phase.
 */
const PROBE_CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 10_000;
const PER_HOST_INTERVAL_MS = 1_000;
const JITTER_MS = 200;
const MAX_REDIRECTS = 3;
const PROBE_UA = 'IranMonitor-LinkCheck/1.0 (+https://motg-iran.vercel.app)';

// ============================================================================
// Phase 43 Plan 02 — soft-404 body heuristic constants (D-20, no env)
// ============================================================================

/**
 * D-01 / D-20 — capped GET byte budget for the soft-404 body read. 16 KiB
 * (`Range: bytes=0-16383`) is enough to capture the `<head>`/`<title>` of any
 * realistic publisher page; the manual `readCappedBody` reader aborts at this
 * cap even when the server ignores the `Range` header (DoS guard T-43-04).
 * Hard-coded module const, NOT env — heuristic knobs are domain constants for
 * this phase, not operator levers.
 *
 * Consumed by the `probeUrl` 200-branch capped GET wiring (`classifyTwoHundred`)
 * as the canonical single source of truth for the 16 KiB cap.
 */
const SOFT404_BODY_CAP_BYTES = 16384;

/**
 * D-02c / D-20 — near-empty content floor. A 200 response whose body, after
 * stripping HTML tags, holds fewer than this many bytes of actual text is
 * treated as a soft-404 shell. ~512 bytes is deliberately conservative
 * (precision-first, D-03): a real React SPA shell with meta + script tags
 * typically exceeds 512 bytes of MARKUP, but tag-stripping measures TEXT, so a
 * genuine "page not found" empty body falls well under while a hydrated
 * article stays above. A dead-but-heavy-shell SPA link surviving is within the
 * asymmetric error budget (Pitfall 2).
 */
const NEAR_EMPTY_FLOOR_BYTES = 512;

/**
 * D-02a / D-20 — curated, precision-first not-found marker list (lowercase).
 * Matched case-insensitively against the `<title>` of a 200 response. Kept
 * deliberately tiny and unambiguous: a marker matched anywhere in BODY text
 * would false-positive on legitimate articles that are ABOUT 404s/errors
 * (RESEARCH anti-pattern), so classifySoft404 matches markers against the
 * `<title>` only. The exact membership of this list is Claude's discretion per
 * the CONTEXT D-discretion note ("keep small, curated, precision-first;
 * expanding it later is cheap"); these are the conservative core English
 * phrases plus two common CMS strings.
 */
const NOT_FOUND_MARKERS: readonly string[] = [
  // CR-03 — every entry must be an error-context phrase that cannot occur in a
  // live conflict-news <title>. The bare substrings `'404'`, `'not found'`, and
  // `'no longer exists'` were DROPPED because they deterministically match live
  // headlines in THIS corpus: `'404'` hits Persian Solar-Hijri years (SH 1404 =
  // Mar 2025–Mar 2026) + hardware (GE F404) + flight/casualty numbers;
  // `'not found'` hits "Missing sailors not found after strike"; `'no longer
  // exists'` hits "Hamas says the ceasefire no longer exists". Each survivor
  // below requires the error framing ("page"/"article"/"content"/"error 404"/
  // "404 not found"/"http 404"/"this page no longer exists") so a live article
  // title cannot match. Precision-first (D-03); expanding later is cheap.
  'page not found',
  'article not available',
  'page no longer available',
  'content not found',
  'this page no longer exists',
  'error 404',
  '404 not found',
  'http 404',
];

/**
 * Phase 43 Plan 02 Task 1 (GHOST-06) — pure soft-404 body heuristic.
 *
 * Evaluates the three D-02 signals IN ORDER with early-return, applying the
 * D-03 precision-first tie-break (any ambiguity / no-signal → `live`,
 * `evidence: null`; NEVER flag live content dead):
 *
 *   (a) not-found markers — extract the `<title>`, lowercase it, and if it
 *       includes any `NOT_FOUND_MARKERS` entry return a soft-404 verdict with
 *       evidence `soft-404: matched "<marker>" in title` (D-16 verbatim).
 *       Markers are matched against the title ONLY — never the full body — so
 *       an article ABOUT a 404 does not false-positive.
 *   (b) redirect-to-home — if the ORIGINAL URL had a deep path (≥2 segments)
 *       and the FINAL URL landed at `/` or a single-segment root (≤1 segment),
 *       the redirect chain bounced an article to a homepage/section root.
 *       Evidence `redirect-to-home: <origPath> → <finalPath>` (D-16). A
 *       deep→deep canonical move does NOT match (Pitfall 3).
 *   (c) near-empty content — strip tags and if the remaining text is below
 *       `NEAR_EMPTY_FLOOR_BYTES` AND the body contains no `<script` tag,
 *       return evidence `near-empty: <n> bytes` (D-16). WR-04 — the
 *       no-`<script>` co-condition exempts CSR/SPA shells (which serve the
 *       same near-empty HTML for live AND dead articles); firing on
 *       text-length alone would flag every live article on a CSR outlet as
 *       dead, the one direction the asymmetric error budget forbids.
 *
 * Pure function (no fetch, no Redis, no side effects) so it gets a
 * table-driven test without fetch mocking. Exported directly — it needs no
 * NODE_ENV gate (that gate is only for module-private fetch/Redis helpers like
 * `persistLiveness`).
 *
 * The fetched HTML body is UNTRUSTED external input (T-43-05): it is only
 * substring-scanned for ASCII markers and tag-stripped for a length count —
 * never eval'd, parsed-as-code, or rendered. The evidence string is bounded by
 * the schema's `z.string().max(200)` from Plan 01.
 */
export function classifySoft404(
  bodyText: string,
  finalUrl: string,
  originalUrl: string,
): { soft404: boolean; evidence: string | null } {
  // (a) not-found markers in <title> (case-insensitive). Single regex capture
  // over the decoded head — no DOM parser (D-20 / RESEARCH "Don't Hand-Roll").
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(bodyText)?.[1] ?? '').toLowerCase();
  for (const marker of NOT_FOUND_MARKERS) {
    if (title.includes(marker)) {
      return { soft404: true, evidence: `soft-404: matched "${marker}" in title` };
    }
  }

  // (b) redirect-to-home — deep original bounced to a shallow root. Wrapped in
  // a try so a malformed URL degrades open (D-03 / D-22) rather than throwing.
  try {
    const origDepth = new URL(originalUrl).pathname.split('/').filter(Boolean).length;
    const finalPath = new URL(finalUrl).pathname;
    const finalDepth = finalPath.split('/').filter(Boolean).length;
    if (origDepth >= 2 && finalDepth <= 1) {
      return {
        soft404: true,
        evidence: `redirect-to-home: ${new URL(originalUrl).pathname} → ${finalPath}`,
      };
    }
  } catch {
    // Unparseable URL → fall through to the near-empty check (precision-first:
    // no redirect signal rather than a crash).
  }

  // (c) near-empty content — strip tags, trim, measure remaining text length.
  // WR-04 — a client-side-rendered (CSR/SPA) news site serves the SAME
  // near-empty HTML shell (`<div id="root"></div>` + external `<script src>`
  // tags, ~0 text after stripping) for LIVE articles as for dead ones. Firing
  // soft-404 on text-length alone would condemn every live article on such an
  // outlet (live-marked-dead — the one direction the phase's asymmetric error
  // budget forbids). Require the body to ALSO contain no `<script` tag: a real
  // SPA shell is script-heavy, so its presence means "JS will hydrate content"
  // → degrade-open to live. A genuine static "page not found" body has no
  // script and stays caught. Precision-first (D-03).
  const contentLen = bodyText.replace(/<[^>]+>/g, '').trim().length;
  const hasScript = /<script[\s>]/i.test(bodyText);
  if (contentLen < NEAR_EMPTY_FLOOR_BYTES && !hasScript) {
    return { soft404: true, evidence: `near-empty: ${contentLen} bytes` };
  }

  // D-03 precision-first: no unambiguous signal fired → live, no evidence.
  return { soft404: false, evidence: null };
}

/**
 * Pitfall 1 / RESEARCH A6 — caller-supplied wall-clock cutoff for the
 * sweep. Plan 32-03 will compute this as `cronStart + 800_000 - 60_000`
 * so the 60s safety margin reserves time for the post-sweep prune +
 * audit-log writes under Vercel Pro's 800s `maxDuration`. Exported here
 * so all callsites cite the same constant.
 */
export const SWEEP_SAFETY_MARGIN_MS = 60_000;

/**
 * Defense-in-depth SSRF guard (RESEARCH §Security V11). Rejects URLs
 * whose hostname maps to RFC1918 private space, loopback, link-local,
 * IPv6 ULA, ::1, or the AWS / GCP / Azure cloud-metadata services.
 * The probe runs inside the Vercel sandbox; these ranges should never
 * be routable from Vercel egress, but a stored URL that points at one
 * is a tampering signal regardless. Returns `unknown` without issuing
 * fetch.
 *
 * Phase 32 CR-02 fix — IPv6 alternates split out into `IPV6_PRIVATE`
 * because `URL.hostname` returns bracket-wrapped form for v6
 * (`'[::1]'`, `'[fd00::1]'`, `'[fe80::1]'`). The IPv4 regex anchors at
 * `^` and never matched the leading `[`; brackets are now stripped
 * before pattern-matching. The `fc`/`fd` ULA alternates also gained
 * `[0-9a-f]{2}:` hex disambiguation so legitimate hostnames like
 * `fc-barcelona.com` and `fdcompany.com` no longer false-positive-block.
 */
const PRIVATE_HOST_REGEX =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/i;

function isPrivateHost(hostname: string): boolean {
  // Node's URL.hostname returns IPv6 with surrounding brackets, e.g. '[::1]'.
  // Strip them so the v6 alternates below anchor against the bare address.
  const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (PRIVATE_HOST_REGEX.test(h)) return true;
  // IPv6 loopback + unspecified + IPv4-mapped + link-local + ULA.
  // The fc/fd alternates require `[0-9a-f]{2}:` to ensure a real v6 hextet
  // (defangs false positives like `fc-barcelona.com`).
  if (/^::1$/i.test(h)) return true;
  if (/^::$/i.test(h)) return true;
  if (/^::ffff:/i.test(h)) return true;
  if (/^fe80:/i.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
  return false;
}

/**
 * Internal shape returned by `probeUrl`. The probe writer (Task 3)
 * derives the `UrlLiveness` Zod-validated entry from this plus the
 * prior cached value.
 */
export interface ProbeResult {
  status: UrlLivenessStatus;
  httpStatus: number | null;
  finalUrl: string;
  /**
   * D-16 — provenance for the verdict, threaded so `persistLiveness`
   * (Plan 03) reads it off the probe result rather than recomputing.
   * Status-code-only verdicts carry the D-16 literal (`'http-404'`,
   * `'http-403'`, `'dead-host: fetch failed'`); `live`/`unknown` carry
   * `null`; the `soft-404` body heuristic (Plan 02) populates the match
   * detail.
   */
  evidence: string | null;
}

/**
 * fetch-with-timeout helper. Diverges from `server/adapters/nominatim.ts`
 * in two places per CONTEXT D-16 / D-17:
 *   - `redirect: 'manual'` so Phase 32 counts hops itself (not fetch)
 *   - GET branch sets a `Range` header so the download is capped. The
 *     default `rangeBytes` (1024) preserves the Phase 32 405-fallback's
 *     1 KiB cap; Phase 43's soft-404 body GET passes `SOFT404_BODY_CAP_BYTES`
 *     (16 KiB) so the heuristic sees enough of the `<head>`/`<title>`.
 */
async function fetchOnce(
  url: string,
  method: 'HEAD' | 'GET',
  rangeBytes = 1024,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'User-Agent': PROBE_UA };
    if (method === 'GET') headers.Range = `bytes=0-${rangeBytes - 1}`;
    return await fetch(url, {
      method,
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Phase 43 Plan 02 Task 2 — read at most `maxBytes` of a Response body via a
 * manual `getReader()` loop, then abort the rest.
 *
 * DoS guard (T-43-04): some CDNs (Cloudflare, Fastly, many WordPress hosts)
 * ignore `Range` on `text/html` and stream the full body with `200 OK` (not
 * `206`). The manual loop breaks once `total >= maxBytes` and the `finally`
 * `reader.cancel()` releases the connection — so a multi-MB article never gets
 * fully buffered.
 *
 * Charset: decode with `TextDecoder('utf-8', { fatal: false })` so a multibyte
 * character split across the cap boundary does NOT throw — the not-found
 * markers are ASCII, so a garbled partial tail is harmless. Exotic
 * `Content-Type; charset=` values are deliberately NOT honored (precision-first
 * posture, D-03 — a mis-decoded body simply yields no marker → `live`).
 */
async function readCappedBody(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    // Releases the connection for servers that ignore `Range` and keep
    // streaming. Swallow any cancel rejection — best-effort cleanup.
    await reader.cancel().catch(() => {});
  }
  // Concatenate the accumulated chunks, capped to maxBytes.
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    merged.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged.subarray(0, maxBytes));
}

/**
 * Phase 43 Plan 02 Task 2 (GHOST-06) — soft-404 body heuristic on the 200
 * branch. Issues a 16 KiB capped GET on the ALREADY-SSRF-VETTED `finalUrl`
 * (the redirect-followed `currentUrl` — never a fresh fetch to an unvetted
 * host; T-43-03), reads the body via `readCappedBody` (DoS-capped; T-43-04),
 * and feeds the decoded head into the pure `classifySoft404` helper.
 *
 * Degrade-open (D-22 / D-03): on ANY failure — the GET returns null (fetch
 * threw), the body read throws, the body is empty/unreadable — the verdict is
 * `live` with `evidence: null`. A body-read failure is treated as live, never
 * poisons the sweep, and never flips live content to dead.
 *
 * D-21 — the extra GET respects the per-host 1-req/s throttle map via
 * `waitForHostSlot` so the polite-citizen contract holds (it is the only added
 * outbound traffic this phase introduces).
 */
async function classifyTwoHundred(
  finalUrl: string,
  originalUrl: string,
  httpStatus: number,
): Promise<ProbeResult> {
  const liveVerdict: ProbeResult = {
    status: 'live',
    httpStatus,
    finalUrl,
    evidence: null,
  };
  try {
    // D-21 — honor the per-host throttle for the follow-up GET (same host as
    // the just-completed HEAD). First-touch hosts incur ~no delay.
    try {
      await waitForHostSlot(new URL(finalUrl).hostname);
    } catch {
      // Unparseable finalUrl host → skip throttle, degrade-open below.
    }
    // SSRF (T-43-03): the GET targets the already-vetted finalUrl ONLY.
    const res = await fetchOnce(finalUrl, 'GET', SOFT404_BODY_CAP_BYTES);
    if (res === null) {
      // fetch threw on the body GET — degrade-open to live.
      return liveVerdict;
    }
    // CR-02 (GHOST-09 false-positive re-import guard) — the HEAD said 200, but
    // the follow-up body GET can land on a DIFFERENT response: method-asymmetric
    // bot-blocking CDNs pass HEAD then challenge/deny GET (403/429), and
    // `redirect: 'manual'` means a GET answered with 3xx carries an empty body.
    // Both produce a tiny/empty body that signal (c) near-empty would condemn —
    // flipping a LIVE article to `soft-404` (cron-prunable), exactly the
    // class GHOST-09's 403 demotion exists to prevent. Precision-first
    // (D-03): only run the heuristic on a 2xx body GET; any non-2xx is
    // no-trustworthy-signal → degrade-open to live.
    if (res.status < 200 || res.status >= 300) {
      log.info(
        { finalUrl, getStatus: res.status, headStatus: httpStatus },
        'soft-404 body GET non-2xx where HEAD was 200 — no body signal, returning live',
      );
      // Release the connection on the discarded body (Range-ignoring servers).
      await res.body?.cancel().catch(() => {});
      return liveVerdict;
    }
    const body = await readCappedBody(res, SOFT404_BODY_CAP_BYTES);
    const verdict = classifySoft404(body, finalUrl, originalUrl);
    if (verdict.soft404) {
      return { status: 'soft-404', httpStatus, finalUrl, evidence: verdict.evidence };
    }
    return liveVerdict;
  } catch (err) {
    // D-22 — any body-read / classification throw degrades open to live.
    log.warn({ err, finalUrl }, 'soft-404 body classification failed (degrade-open to live)');
    return liveVerdict;
  }
}

/**
 * D-16 / D-17 / D-18 / D-21 — single-URL liveness probe.
 *
 * Method sequence:
 *   1. HEAD with `redirect: 'manual'`. 200 → soft-404 heuristic; 404 → 404;
 *      403 → 403.
 *   2. On 405, GET with `Range: bytes=0-1023`. 200 → soft-404 heuristic;
 *      4xx/5xx → same taxonomy.
 *   3. On 3xx with a `location` header, follow up to MAX_REDIRECTS (3)
 *      hops, counting hops manually. 4th 3xx → `unknown`.
 *   4. fetch throws (DNS / ECONNREFUSED / abort) → `dead-host`.
 *   5. Any other code (5xx, 451, 410, ...) → `unknown`.
 *
 * Defense-in-depth: hostname is checked against `PRIVATE_HOST_REGEX`
 * before any fetch — SSRF target URLs short-circuit to `unknown` with
 * NO outbound request issued.
 */
export async function probeUrl(rawUrl: string): Promise<ProbeResult> {
  // Stage 0 — URL parse + SSRF guard.
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Malformed URL — treat as dead-host (no DNS resolution possible).
    return {
      status: 'dead-host',
      httpStatus: null,
      finalUrl: rawUrl,
      evidence: 'dead-host: fetch failed',
    };
  }
  if (isPrivateHost(parsed.hostname)) {
    log.warn({ rawUrl }, 'probe target rejected by SSRF guard');
    return { status: 'unknown', httpStatus: null, finalUrl: rawUrl, evidence: null };
  }

  let currentUrl = rawUrl;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // First request is HEAD; subsequent redirect hops also HEAD.
      let res = await fetchOnce(currentUrl, 'HEAD');

      // fetch threw or aborted (network/DNS/timeout) → dead-host.
      if (res === null) {
        return {
          status: 'dead-host',
          httpStatus: null,
          finalUrl: currentUrl,
          evidence: 'dead-host: fetch failed',
        };
      }

      // 405 Method Not Allowed — fall back to GET (D-16). CDN-fronted
      // publishers (Cloudflare, Fastly) often refuse HEAD.
      if (res.status === 405) {
        res = await fetchOnce(currentUrl, 'GET');
        if (res === null) {
          return {
            status: 'dead-host',
            httpStatus: null,
            finalUrl: currentUrl,
            evidence: 'dead-host: fetch failed',
          };
        }
      }

      const code = res.status;

      // 2xx → run the soft-404 body heuristic (Phase 43 Plan 02, GHOST-06).
      if (code >= 200 && code < 300) {
        return await classifyTwoHundred(currentUrl, rawUrl, code);
      }

      // Specific 4xx codes that count toward the dashboard dead surface.
      if (code === 404) {
        return { status: '404', httpStatus: 404, finalUrl: currentUrl, evidence: 'http-404' };
      }
      if (code === 403) {
        return { status: '403', httpStatus: 403, finalUrl: currentUrl, evidence: 'http-403' };
      }

      // 3xx — follow up to MAX_REDIRECTS hops. On the (MAX_REDIRECTS+1)th
      // 3xx (i.e. hop === MAX_REDIRECTS at this branch), return unknown.
      if (code >= 300 && code < 400) {
        if (hop >= MAX_REDIRECTS) {
          return { status: 'unknown', httpStatus: code, finalUrl: currentUrl, evidence: null };
        }
        const location = res.headers.get('location');
        if (!location) {
          // 3xx without Location — protocol violation. Bail with unknown.
          return { status: 'unknown', httpStatus: code, finalUrl: currentUrl, evidence: null };
        }
        // Resolve relative redirects against the current URL.
        try {
          currentUrl = new URL(location, currentUrl).toString();
        } catch {
          return { status: 'unknown', httpStatus: code, finalUrl: currentUrl, evidence: null };
        }
        // Re-run SSRF guard for each redirect target (defense-in-depth —
        // a hostile redirect can point at a private host).
        try {
          if (isPrivateHost(new URL(currentUrl).hostname)) {
            log.warn(
              { rawUrl, redirectTarget: currentUrl },
              'redirect target rejected by SSRF guard',
            );
            return { status: 'unknown', httpStatus: code, finalUrl: currentUrl, evidence: null };
          }
        } catch {
          return { status: 'unknown', httpStatus: code, finalUrl: currentUrl, evidence: null };
        }
        continue; // next hop
      }

      // Any other code (5xx, 451, 410, 4xx not in {403,404,405}) → unknown.
      return { status: 'unknown', httpStatus: code, finalUrl: currentUrl, evidence: null };
    }

    // Loop exhausted without return (shouldn't be reachable; MAX_REDIRECTS+1
    // iterations always terminate inside the loop). Treat as unknown.
    return { status: 'unknown', httpStatus: null, finalUrl: currentUrl, evidence: null };
  } catch (err) {
    // Catch-all guard — any unexpected throw collapses to dead-host so
    // the sweep keeps moving.
    log.warn({ err, rawUrl }, 'probeUrl unexpected throw');
    return {
      status: 'dead-host',
      httpStatus: null,
      finalUrl: currentUrl,
      evidence: 'dead-host: fetch failed',
    };
  }
}

// ============================================================================
// Plan 32-02 Task 2 — per-host throttle map (D-18 polite-citizen contract)
// ============================================================================

/**
 * Module-singleton hostname → next-allowed-timestamp map. Persists across
 * `runProbeSweep` invocations within a single warm Vercel function
 * instance — so back-to-back sweeps don't burst the same publisher.
 *
 * Pitfall 2: this Map can grow unboundedly across long-warm function
 * instances. `pruneStaleHostSlots()` runs at end-of-sweep and removes
 * entries older than `now - 60s`; daily cold-start naturally resets the
 * full state.
 */
const hostNext = new Map<string, number>();

/**
 * D-18 — block until the per-host probe slot is available, then reserve
 * the next slot. Mirrors the philosophical contract of the Nominatim
 * 1-req/s throttle (CLAUDE.md §LLM pipeline). ±JITTER_MS prevents
 * stampede when many hosts unblock simultaneously.
 */
async function waitForHostSlot(hostname: string): Promise<void> {
  const now = Date.now();
  const prior = hostNext.get(hostname) ?? 0;
  // Symmetric jitter in [-JITTER_MS, +JITTER_MS]. Floor so the test
  // assertion "≥ PER_HOST_INTERVAL_MS - JITTER_MS" holds deterministically.
  const jitter = Math.floor((Math.random() - 0.5) * 2 * JITTER_MS);
  const target = Math.max(now, prior) + jitter;
  // Reserve the NEXT slot SYNCHRONOUSLY before awaiting. Without this,
  // concurrent same-host dispatchers (e.g. 4 items dispatched into
  // createLimit(8) on the same hostname) all read the same `prior`
  // simultaneously and race to update — coalescing to ~1 throttle gap
  // instead of N-1. Math.max(now, target) floors against the
  // negative-jitter case.
  const reservedAt = Math.max(now, target);
  hostNext.set(hostname, reservedAt + PER_HOST_INTERVAL_MS);
  if (target > now) {
    await new Promise<void>((resolve) => setTimeout(resolve, target - now));
  }
}

/**
 * Pitfall 2 — drop hostname entries whose next-allowed timestamp is
 * already 60s in the past. Called at end-of-sweep so the map doesn't
 * leak memory across warm-instance lifetime.
 */
function pruneStaleHostSlots(): void {
  const cutoff = Date.now() - 60_000;
  for (const [host, ts] of hostNext) {
    if (ts < cutoff) hostNext.delete(host);
  }
}

// ============================================================================
// Plan 32-02 Task 3 — persistLiveness writer (D-12 / RESEARCH A2)
// ============================================================================

/**
 * D-07 — terminal-dead statuses count toward the dashboard dead-URL
 * surface and are eligible for prune. Exported so Plan 32-03 reuses the
 * predicate inside `pruneDeadUrlEvents` (and the sweep+prune INCR/DECR
 * sidecar maintenance share one truth source).
 */
export function isTerminalDead(status: UrlLivenessStatus): boolean {
  // D-04/D-08 — `soft-404` joins the terminal-dead set (counts toward the
  // dashboard dead-URL surface + prune-eligible). `no-url` is explicitly
  // NOT terminal-dead (D-08 — an event with no primary URL is not a dead
  // link). `403` stays terminal-dead here; the GHOST-09 cron-only 403
  // demotion is a prune-filter-local change (Plan 04), NOT an
  // isTerminalDead change (RESEARCH anti-pattern).
  return status === '404' || status === '403' || status === 'dead-host' || status === 'soft-404';
}

/**
 * Logical TTL passed to `cacheGetSafe` — the safe wrapper uses this only
 * to set the `stale` flag on the response envelope; the read itself
 * always returns whatever is in Redis (or the in-memory fallback). For
 * the probe path we don't gate on stale-ness — we always trust the most
 * recent stored value as `prior`. A huge sentinel (~31y) suppresses the
 * stale flag in all realistic conditions.
 */
const LIVENESS_READ_LOGICAL_TTL_MS = 999_999_999;

/**
 * Probe writer. Reads the prior `events:url-liveness:{eventId}` entry
 * (if any), derives the next `UrlLiveness` via the D-12 / RESEARCH A2
 * monotonic-with-reset attemptCount semantics, validates the result
 * against `UrlLivenessSchema` (paranoid drift catch), persists via
 * `cacheSetSafe` exclusively (Pitfall 6 — chaos-test contract holds),
 * and maintains the sidecar `events:url-liveness-count` integer on
 * live↔terminal-dead transitions (Pitfall 3).
 *
 * attemptCount semantics (Phase 32 RESEARCH A2 origin; Phase 43 D-10
 * splits the reset rule by status — `live` resets to 0, `unknown`
 * PRESERVES the prior count, `no-url` is 0, dead→dead increments):
 *   next=live                              → attemptCount=0 (full reset)
 *   next=unknown                           → attemptCount=prior?.attemptCount ?? 0 (PRESERVE)
 *   next=no-url                            → attemptCount=0
 *   prior=terminal-dead, next=terminal-dead → attemptCount=prior+1 (monotonic)
 *   prior≠terminal-dead, next=terminal-dead → attemptCount=1 (start of run)
 *
 * Sidecar INCR fires only on the prior→next transition NOT-DEAD → DEAD.
 * DECR fires only on DEAD → NOT-DEAD. Same-state transitions (dead→dead,
 * live→live, unknown→unknown) do NOT touch the sidecar. Underflow
 * floors at 0 via `redis.set(KEY, 0)` so a DECR race past zero
 * self-heals.
 *
 * Kept module-private. Test access flows through the NODE_ENV='test'
 * `__test__` export. Plan 32-03's `pruneDeadUrlEvents` reads the entry
 * shape but does NOT call this writer — prune is a delete, not a
 * status transition.
 */
async function persistLiveness(
  eventId: string,
  urlProbed: string | null,
  probeResult: ProbeResult,
): Promise<void> {
  const key = `${URL_LIVENESS_KEY_PREFIX}${eventId}`;
  const priorEntry = await cacheGetSafe<UrlLiveness>(key, LIVENESS_READ_LOGICAL_TTL_MS);
  const prior: UrlLiveness | null = priorEntry?.data ?? null;

  // Phase 43 D-10 — split attemptCount derivation (replaces the Phase 32
  // reset-on-any-non-dead rule). The reset rule is now status-specific:
  //   - `live`    → 0  (a recovered link fully resets; a blip is forgiven).
  //   - `unknown` → PRESERVE prior?.attemptCount ?? 0  (a transient failure
  //                 must NOT reset the consecutive-dead run a flaky host
  //                 accumulates — the dead→unknown→dead repeat offender then
  //                 eventually crosses the >=3 cron prune gate).
  //   - `no-url`  → 0  (no probe issued; not a dead-link signal).
  //   - dead→dead → prior+1 (monotonic increment).
  //   - not-dead→dead → 1 (first write of a dead run).
  // attemptCount (consecutive-dead history) and the sidecar dead-count
  // (current terminal-dead membership) are INDEPENDENT axes: the sidecar
  // DECR below still fires on dead→unknown even though attemptCount is
  // preserved (the event has exited terminal-dead membership).
  const nextDead = isTerminalDead(probeResult.status);
  const priorDead = prior !== null && isTerminalDead(prior.status);
  let attemptCount: number;
  if (probeResult.status === 'live') {
    attemptCount = 0;
  } else if (probeResult.status === 'unknown') {
    // D-10 — PRESERVE the prior count (no increment, no reset).
    attemptCount = prior?.attemptCount ?? 0;
  } else if (probeResult.status === 'no-url') {
    attemptCount = 0;
  } else if (priorDead) {
    // dead → dead: monotonic increment.
    attemptCount = prior.attemptCount + 1;
  } else {
    // not-dead → dead (or first write that's dead): start at 1.
    attemptCount = 1;
  }

  const next: UrlLiveness = {
    status: probeResult.status,
    lastProbedAt: new Date().toISOString(),
    attemptCount,
    lastUrlProbed: urlProbed,
    lastHttpStatus: probeResult.httpStatus,
    // D-16/D-17 — writer always carries the probe's evidence string
    // (null for status-only verdicts). WR-01 — truncate to 200 chars at this
    // single writer choke point BEFORE the `.strict()` parse below. The
    // redirect-to-home evidence embeds two verbatim pathnames; percent-encoded
    // Persian/Arabic news slugs (this corpus is Middle-East-outlet dominated)
    // routinely exceed the schema's `z.string().max(200)`, and an over-length
    // string makes `UrlLivenessSchema.parse` THROW — which would silently drop
    // this event's liveness write every sweep (it stays Tier A forever and can
    // never accumulate attemptCount≥3 to be pruned). Truncating here guarantees
    // persistLiveness never throws on a long evidence string.
    evidence: probeResult.evidence === null ? null : probeResult.evidence.slice(0, 200),
  };

  // Paranoid contract guard — throws on schema drift so the failing
  // sweep task surfaces via the catch-all log.warn in runProbeSweep.
  UrlLivenessSchema.parse(next);

  await cacheSetSafe(key, next, ttlSecForStatus(next.status));

  // Pitfall 3 — sidecar count maintenance on dead-set transitions only.
  // Wrap raw redis.incr/decr in try/catch (cacheSetSafe shape doesn't
  // fit integer counters; Pitfall 6 note says raw incr/decr must
  // degrade-open).
  //
  // WR-03 (bounded residual drift) — the INCR fires on prior-not-dead →
  // next-dead. The WR-02 TTL fix (unknown + terminal-dead now 24h hard) keeps
  // `prior` non-null across the single daily sweep gap, so a still-dead entry
  // re-probed the next day reads `priorDead = true` and does NOT re-INCR. A
  // residual drift window remains only if a terminal-dead key outlives its 24h
  // hard TTL between two sweeps that are themselves >24h apart (e.g. a skipped
  // cron day): the key expires, `prior = null`, and the next dead re-probe
  // re-INCRs an already-counted event. This is bounded (at most +1 per such
  // skipped-day-then-re-probe per event) and self-heals downward via the
  // floor-at-0 DECR underflow guard below + the prune-time DECRBY; the
  // dashboard read also floors at 0 (`Math.max(0, …)` in operator-status). No
  // mechanism change beyond the TTL fix is warranted given the daily cadence.
  try {
    if (!priorDead && nextDead) {
      await redis.incr(URL_LIVENESS_COUNT_KEY);
    } else if (priorDead && !nextDead) {
      const after = await redis.decr(URL_LIVENESS_COUNT_KEY);
      if (typeof after === 'number' && after < 0) {
        // Underflow race (concurrent prune ran between our read of
        // `prior` and the DECR) — floor at 0.
        await redis.set(URL_LIVENESS_COUNT_KEY, 0);
      }
    }
  } catch (err) {
    log.warn({ err, eventId, priorDead, nextDead }, 'sidecar count update failed (degrade-open)');
  }
}

/**
 * Phase 44 — reconcile the `events:url-liveness-count` sidecar against the
 * authoritative liveness keyspace.
 *
 * The sidecar has NO TTL and only mutates on dead<->live transitions
 * (persistLiveness) and prune (pruneDeadUrlEvents). A terminal-dead key that
 * expires on its finite per-status TTL — or whose event leaves the daily probe
 * candidate set so no future transition ever fires — is never decremented, so
 * the counter drifts upward without bound. Observed in prod as deadUrlCount=202
 * with ZERO live `events:url-liveness:*` keys, which made the operator "Prune N
 * dead events" button a permanent no-op (it SCANs the keyspace, finds nothing,
 * prunes 0, and the count never drops). The WR-03 note on persistLiveness
 * assumed this drift stayed bounded; it does not once events exit the probe set.
 *
 * This SCANs the full keyspace, counts entries where `isTerminalDead(status)`
 * is true (the same membership the sidecar INCR tracks — 403 included, per the
 * D-07 / line ~1234 invariant), and SETs the sidecar to that authoritative
 * total. Drift can therefore only ever last until the next reconcile (daily
 * cron sweep + every prune). Degrade-open per the Pitfall 6 raw-counter rule:
 * returns the reconciled count, or `null` if reconciliation could not run.
 */
export async function reconcileDeadUrlCount(): Promise<number | null> {
  try {
    let cursor: string | number = '0';
    let terminalDead = 0;
    do {
      const reply = (await redis.scan(cursor, {
        match: `${URL_LIVENESS_KEY_PREFIX}*`,
        count: 200,
      })) as [string | number, string[]];
      cursor = reply[0];
      for (const key of reply[1]) {
        const cached = await cacheGetSafe<UrlLiveness>(key, LIVENESS_READ_LOGICAL_TTL_MS);
        const entry = cached?.data ?? null;
        if (entry && isTerminalDead(entry.status)) terminalDead++;
      }
    } while (cursor !== '0' && cursor !== 0);
    await redis.set(URL_LIVENESS_COUNT_KEY, terminalDead);
    return terminalDead;
  } catch (err) {
    log.warn({ err }, 'reconcileDeadUrlCount failed (degrade-open)');
    return null;
  }
}

// ============================================================================
// Plan 32-02 Task 5 — buildProbeCandidates priority sort (D-04)
// ============================================================================

/**
 * Minimal shape this module needs from a `events:llm:v3` cache entry.
 * Avoids importing the full `ConflictEventEntity` discriminated union
 * (which would pull in MapEntity + server types and bloat the import
 * graph). The runtime check `typeof url === 'string'` defends against
 * any drift in this assumed shape.
 */
interface ConflictEventEntityForProbe {
  id: string;
  data: { source?: string | null };
}

/**
 * Logical TTL for the v3 cache read. Same sentinel rationale as
 * `persistLiveness` — we want whatever is in Redis regardless of
 * stale-ness.
 */
const V3_READ_LOGICAL_TTL_MS = 999_999_999;

/**
 * D-04 — build the sweep candidate list with two-tier priority sort:
 *   Tier A: events with NO `events:url-liveness:{eventId}` key yet
 *           (sorted first; never-probed → dashboard count converges fast
 *           for new events). Internal order within Tier A follows the
 *           natural input order from `events:llm:v3` — deterministic
 *           and stable.
 *   Tier B: events with a prior liveness key, sorted ascending by
 *           `lastProbedAt` (oldest first — re-probe stale verdicts).
 *           ISO-8601 byte-lex sort equals chronological sort.
 *
 * Phase 43 GHOST-07 (D-06/D-07/D-08/D-09) — entities whose `data.source`
 * is empty / missing / non-string are NO LONGER silently dropped. Each
 * source-less event now gets an explicit `no-url` liveness write (via
 * `persistLiveness`, NO fetch issued) so prune can SEE the event and
 * explicitly skip it (D-08 — `no-url` is NOT terminal-dead, so pruning an
 * event merely for lacking a URL never happens). The count of such events
 * is returned as `classifiedNoUrl` and surfaced in the cron post-step log
 * line (D-09 — full coverage accounting). A `no-url` write does NOT INCR
 * the sidecar dead-count (no-url is not-dead; first write of a fresh
 * source-less event has `priorDead === false`).
 *
 * Reads `events:llm:v3` once and one `events:url-liveness:{eventId}`
 * lookup per candidate. Plan 32-03 calls this immediately before
 * `runProbeSweep` inside the cron handler.
 */
export async function buildProbeCandidates(): Promise<{
  candidates: Array<{ eventId: string; url: string }>;
  classifiedNoUrl: number;
}> {
  const v3 = await cacheGetSafe<ConflictEventEntityForProbe[]>(
    'events:llm:v3',
    V3_READ_LOGICAL_TTL_MS,
  );
  const entities = v3?.data ?? [];
  if (!Array.isArray(entities) || entities.length === 0) {
    return { candidates: [], classifiedNoUrl: 0 };
  }

  const tierA: Array<{ eventId: string; url: string }> = [];
  const tierB: Array<{ eventId: string; url: string; lastProbedAt: string }> = [];
  let classifiedNoUrl = 0;

  for (const entity of entities) {
    const url = entity?.data?.source;
    if (!url || typeof url !== 'string' || url.length === 0) {
      // GHOST-07 (D-08/D-16) — source-less event: write an explicit `no-url`
      // liveness entry (no HTTP issued) instead of silently dropping it, so
      // prune can evaluate-and-skip it. Degrade-open — a write throw for one
      // event must never poison the candidate build.
      classifiedNoUrl++;
      try {
        await persistLiveness(entity.id, null, {
          status: 'no-url',
          httpStatus: null,
          finalUrl: '',
          evidence: 'no-url: event has no source URL',
        });
      } catch (err) {
        log.warn({ err, eventId: entity?.id }, 'no-url liveness write failed (degrade-open)');
      }
      continue;
    }
    const prior = await cacheGetSafe<UrlLiveness>(
      `${URL_LIVENESS_KEY_PREFIX}${entity.id}`,
      LIVENESS_READ_LOGICAL_TTL_MS,
    );
    if (!prior?.data) {
      tierA.push({ eventId: entity.id, url });
    } else {
      tierB.push({
        eventId: entity.id,
        url,
        lastProbedAt: prior.data.lastProbedAt,
      });
    }
  }

  // ISO-8601 byte-lex sort == chronological sort (well-known JS idiom).
  tierB.sort((a, b) => a.lastProbedAt.localeCompare(b.lastProbedAt));

  return {
    candidates: [...tierA, ...tierB.map(({ eventId, url }) => ({ eventId, url }))],
    classifiedNoUrl,
  };
}

// ============================================================================
// Plan 32-02 Task 4 — runProbeSweep orchestrator (D-03, D-18, Pitfall 1)
// ============================================================================

/**
 * D-03 — best-effort partial sweep. Given a candidate list (built by
 * `buildProbeCandidates` — Task 5), probes each candidate's URL under
 * `createLimit(PROBE_CONCURRENCY=8)` concurrency cap + per-host 1-req/s
 * throttle + caller-supplied `deadlineMs` wall-clock cutoff.
 *
 * Each task body does the deadline check FIRST (before any URL parse or
 * fetch), so when budget is exhausted the remaining items short-circuit
 * to `skippedBudget++` without consuming wall-clock or Redis calls.
 *
 * Plan 32-03 will compute `deadlineMs` as
 *   `cronStart + 800_000 - SWEEP_SAFETY_MARGIN_MS`
 * inside `/api/cron/refresh-events`, reserving the 60s safety margin
 * for the post-sweep prune + audit-log writes under Vercel Pro's 800s
 * `maxDuration` (Pitfall 1).
 *
 * On exit, `pruneStaleHostSlots()` runs (Pitfall 2) so the per-host
 * throttle map doesn't grow unboundedly across warm-instance lifetime.
 *
 * Errors inside each task body (URL parse, probeUrl unexpected throw,
 * persistLiveness throw) are caught and logged via `log.warn` — one
 * bad task never poisons the rest of the sweep.
 */
export async function runProbeSweep(opts: {
  eventIdsWithUrls: Array<{ eventId: string; url: string }>;
  deadlineMs: number;
}): Promise<{ probed: number; skippedBudget: number }> {
  const limit = createLimit(PROBE_CONCURRENCY);
  let probed = 0;
  let skippedBudget = 0;

  const tasks = opts.eventIdsWithUrls.map(({ eventId, url }) =>
    limit(async () => {
      // Pitfall 1 — deadline guard MUST be the first statement in the
      // task body. Items dispatched AFTER the deadline must NOT touch
      // fetch or Redis.
      if (Date.now() > opts.deadlineMs) {
        skippedBudget++;
        return;
      }

      try {
        const host = new URL(url).hostname;
        await waitForHostSlot(host);
        // Re-check deadline AFTER the throttle wait — the per-host
        // throttle can push us past the cutoff. (Without this, a
        // saturated same-host batch could overrun the Vercel
        // maxDuration after the throttle wait, defeating Pitfall 1.)
        if (Date.now() > opts.deadlineMs) {
          skippedBudget++;
          return;
        }
        const result = await probeUrl(url);
        await persistLiveness(eventId, url, result);
        probed++;
      } catch (err) {
        // Log but never re-throw — one bad URL never poisons the sweep.
        log.warn({ err, eventId, url }, 'probe sweep task failed');
      }
    }),
  );

  await Promise.all(tasks);
  pruneStaleHostSlots();

  // Phase 44 — reconcile the dead-URL sidecar against the now-current keyspace.
  // The daily sweep is the natural heal point: after re-probing, the
  // events:url-liveness:* keyspace reflects reality, so a SCAN-and-SET corrects
  // any drift (keys that expired on their TTL, or events that left the probe
  // set, were never decremented from the no-TTL counter). Bounds the phantom
  // dead-URL count to at most one cron interval. Degrade-open (never throws).
  await reconcileDeadUrlCount();

  return { probed, skippedBudget };
}

// ============================================================================
// Plan 32-03 Task 1 — pruneDeadUrlEvents helper (D-12, D-13, D-14)
// ============================================================================

/**
 * Minimal shape pruneDeadUrlEvents needs from an `events:llm:v3` entry.
 * Avoids importing the full `ConflictEventEntity` discriminated union —
 * same rationale as `ConflictEventEntityForProbe` above.
 */
interface ConflictEventEntityForPrune {
  id: string;
}

/**
 * Read-side stale ignore: prune is a deliberate destructive action and
 * must operate against whatever the cache currently holds. Same sentinel
 * shape as the probe path.
 */
const PRUNE_READ_LOGICAL_TTL_MS = 999_999_999;

/**
 * D-12 + D-13 + D-14 — splice dead-URL events out of `events:llm:v3`.
 *
 * Called from two paths:
 *   - `POST /api/events/prune-dead-urls` (operator click via the API
 *     Health dashboard button — Plan 32-05) with `trigger:'manual'` +
 *     the operator's Bearer fingerprint.
 *   - `runRefreshExtraction` cron post-step (Plan 32-03 Task 3) with
 *     `trigger:'cron'` (no fingerprint — audit log records the literal
 *     string `'cron:refresh-events'` per RESEARCH A8).
 *
 * Filter logic:
 *   - For every event in `events:llm:v3`, look up its
 *     `events:url-liveness:{id}` entry.
 *   - Event is a prune candidate IFF the liveness entry exists AND
 *     `isTerminalDead(status)` is true.
 *   - When `trigger === 'cron'`, additionally require `attemptCount >= 3`
 *     (D-12 — only events terminal-dead across ≥3 consecutive ticks are
 *     eligible for unattended deletion). Manual trigger has no
 *     attemptCount gate (D-09 — operator can prune any flagged event).
 *
 * Delete scope (D-13 — smallest blast radius):
 *   - Splice out of `events:llm:v3` via cacheSetSafe.
 *   - DEL the `events:url-liveness:{id}` keys via bulk `redis.del`.
 *   - DECR the `events:url-liveness-count` sidecar by prunedCount (paired
 *     with the persistLiveness INCR from Plan 32-02 — the count stays
 *     consistent across probe-time INCR and prune-time DECR).
 *   - Does NOT touch `llmLineage`, `callHistory`, news cluster indices,
 *     `operator:audit-log`, or anything else.
 *
 * Audit log (D-14 — RESEARCH Common Op 2 path (b)):
 *   - `{operation:'prune-dead-urls', args:{trigger, prunedCount, prunedIds},
 *      result:'ok'}`. Stashing the count + ids in `args` (rather than
 *     widening `OperatorAuditEntry.result` to admit a struct) avoids
 *     schema migration and is forensically sufficient — operators drill
 *     in via `/operator-status` and see the IDs.
 *
 * SCAN signature (MEDIUM-01 plan-checker pin):
 *   `redis.scan` on `@upstash/redis ^1.37.0` returns
 *   `Promise<[string | number, string[]]>` — cursor type is string OR
 *   number depending on Upstash response shape. We cast explicitly so
 *   the executor's inferred type matches the runtime contract.
 *
 * Race window (T-32-07 / RESEARCH Pitfall 4 / Open Question 3):
 *   GET → splice → SET against `/api/events` reads is documented but
 *   not mutex-locked in v1. The map can flicker a dead event for ≤1
 *   poll cycle (≤15min logical TTL) until the next refresh. Operator
 *   can re-extract via `/llm-replay` if mis-pruned. Promote to a
 *   Redis-backed lock only if a real overlap is observed in audit-log
 *   telemetry.
 *
 * Errors:
 *   The helper does NOT catch its own errors — chaos-test compatibility
 *   (RESEARCH Pitfall 6) requires the route handler at
 *   `POST /api/events/prune-dead-urls` to translate a Redis throw into
 *   `503 prune_failed`, NOT `500`. Caller's try/catch is the contract.
 */
export async function pruneDeadUrlEvents(opts: {
  trigger: 'manual' | 'cron';
  fingerprint?: string;
}): Promise<{ prunedCount: number; prunedIds: string[] }> {
  // 1. Read the v3 cache. If empty / null → nothing to prune.
  const v3 = await cacheGetSafe<ConflictEventEntityForPrune[]>(
    LLM_EVENTS_KEY_ACTIVE,
    PRUNE_READ_LOGICAL_TTL_MS,
  );
  const events = Array.isArray(v3?.data) ? v3.data : [];
  if (events.length === 0) {
    return { prunedCount: 0, prunedIds: [] };
  }

  // 2. SCAN the events:url-liveness:* keyspace.
  //    MEDIUM-01 — pin Upstash @upstash/redis ^1.37.0 signature.
  const livenessKeys: string[] = [];
  let cursor: string | number = '0';
  do {
    const reply = (await redis.scan(cursor, {
      match: `${URL_LIVENESS_KEY_PREFIX}*`,
      count: 200,
    })) as [string | number, string[]];
    cursor = reply[0];
    for (const key of reply[1]) livenessKeys.push(key);
  } while (cursor !== '0' && cursor !== 0);

  // 3. For each scanned liveness key, load the entry + apply the filter.
  // Phase 44 — `terminalDeadFound` is the authoritative terminal-dead
  // membership observed THIS scan (403 included; pre cron-exclusion filters).
  // The sidecar count is reconciled to it below so the count can never outlive
  // the keys it represents (the 202-phantom drift root cause).
  const prunedIds: string[] = [];
  let terminalDeadFound = 0;
  for (const key of livenessKeys) {
    const eventId = key.startsWith(URL_LIVENESS_KEY_PREFIX)
      ? key.slice(URL_LIVENESS_KEY_PREFIX.length)
      : null;
    if (!eventId) continue;

    const cached = await cacheGetSafe<UrlLiveness>(key, PRUNE_READ_LOGICAL_TTL_MS);
    const entry = cached?.data ?? null;
    if (!entry) continue;

    // D-07 — only terminal-dead statuses are ever pruned. This shared
    // `isTerminalDead` predicate is INTENTIONALLY left unchanged (RESEARCH
    // anti-pattern): 403 stays terminal-dead so the dashboard count, the
    // deadUrlSample drill-down, and the manual operator prune all keep
    // treating it as dead. Only the cron auto-prune filter below demotes it.
    if (!isTerminalDead(entry.status)) continue;
    terminalDeadFound++;

    // Phase 43 D-14/D-15 (DEMOTE) — cron-only 403 exclusion. Evidence:
    // 43-VERIFICATION.md GHOST-09 sample re-probed 20 of 20 production
    // 403-status URLs and found all 20 serve a LIVE article under a browser
    // UA (bot-blocking CDN false positives confirmed). The cron auto-prune
    // skips 403 regardless of attemptCount; the manual prune (operator
    // judgment) still prunes it. This is prune-filter-local — NOT an
    // isTerminalDead change.
    if (opts.trigger === 'cron' && entry.status === '403') continue;

    // D-12 cron gate — manual trigger bypasses, cron requires ≥3 ticks.
    if (opts.trigger === 'cron' && entry.attemptCount < 3) continue;

    prunedIds.push(eventId);
  }

  if (prunedIds.length === 0) {
    // Phase 44 — reconcile the sidecar to the authoritative terminal-dead
    // membership even on the no-candidate path. This is the fix for the
    // "Prune N dead events" button no-op: a drifted counter (terminal-dead
    // keys long expired) is corrected to reality (often 0) here instead of
    // being left stale, so the phantom count drops the moment an operator
    // clicks. Degrade-open on Redis throw (Pitfall 6 raw-counter rule).
    try {
      await redis.set(URL_LIVENESS_COUNT_KEY, terminalDeadFound);
    } catch (err) {
      log.warn({ err, terminalDeadFound }, 'sidecar reconcile failed (degrade-open)');
    }
    // No prune candidates — still write the audit-log entry so operator
    // sees the no-op (forensic completeness). Skip the splice + DEL steps
    // since there's nothing to mutate.
    await appendOperatorAuditEntry({
      timestamp: Date.now(),
      bearerFingerprint:
        opts.trigger === 'cron' ? 'cron:refresh-events' : (opts.fingerprint ?? 'unknown'),
      operation: 'prune-dead-urls',
      args: { trigger: opts.trigger, prunedCount: 0, prunedIds: [] },
      result: 'ok',
    });
    return { prunedCount: 0, prunedIds: [] };
  }

  // 4. Splice prunedIds out of the v3 events[] array, write back.
  const prunedSet = new Set(prunedIds);
  const spliced = events.filter((e) => !prunedSet.has(e.id));
  // Terminal v3 TTL (48h, > cron interval) — a prune must NOT re-TTL the
  // enriched cache back down to the short cooldown sentinel TTL.
  await cacheSetSafe(LLM_EVENTS_KEY_ACTIVE, spliced, LLM_TERMINAL_TTL_SEC);

  // 5. Bulk DEL the url-liveness keys.
  const keysToDelete = prunedIds.map((id) => `${URL_LIVENESS_KEY_PREFIX}${id}`);
  await redis.del(...keysToDelete);

  // 6. Reconcile the sidecar count authoritatively.
  //    Phase 44 — the prior `DECRBY prunedCount` assumed the counter started
  //    accurate, so an already-drifted counter (terminal-dead keys expired on
  //    their TTL with no decrement) stayed wrong after a prune. SET it to the
  //    terminal-dead membership we actually observed minus what we just pruned
  //    (and DELeted): for a manual prune that is 0; for a cron prune it leaves
  //    the cron-excluded 403 / <3-tick members still counted. `Math.max(0, …)`
  //    guards against a concurrent-prune race. Degrade-open on Redis throw
  //    (Pitfall 6 raw-counter rule).
  const reconciledCount = Math.max(0, terminalDeadFound - prunedIds.length);
  try {
    await redis.set(URL_LIVENESS_COUNT_KEY, reconciledCount);
  } catch (err) {
    log.warn({ err, reconciledCount }, 'sidecar reconcile failed (degrade-open)');
  }

  // 7. Append the audit-log entry (D-14 + RESEARCH A8).
  await appendOperatorAuditEntry({
    timestamp: Date.now(),
    bearerFingerprint:
      opts.trigger === 'cron' ? 'cron:refresh-events' : (opts.fingerprint ?? 'unknown'),
    operation: 'prune-dead-urls',
    args: {
      trigger: opts.trigger,
      prunedCount: prunedIds.length,
      prunedIds,
    },
    result: 'ok',
  });

  log.info({ trigger: opts.trigger, prunedCount: prunedIds.length }, 'pruneDeadUrlEvents complete');

  return { prunedCount: prunedIds.length, prunedIds };
}

// ============================================================================
// Test-only export (NODE_ENV=test-gated) — MEDIUM-02 plan-checker fix
// ============================================================================

/**
 * NODE_ENV-gated visibility for module-private throttle + writer
 * helpers. Used by `server/__tests__/lib/urlLiveness.sweep.test.ts` to
 * assert the D-18 polite-citizen contract + the D-12 attemptCount
 * semantics without breaking encapsulation in production builds.
 * Consumers in dev/prod NEVER see this surface — it resolves to
 * `undefined` whenever NODE_ENV !== 'test'.
 *
 * MEDIUM-02 plan-checker fix: the sweep test file asserts
 * `expect(process.env.NODE_ENV).toBe('test')` at file-import time so
 * runner-config drift (vitest no longer forcing NODE_ENV=test) fails
 * loudly rather than silently producing `__test__ === undefined`.
 */
export const __test__ =
  process.env.NODE_ENV === 'test'
    ? { waitForHostSlot, pruneStaleHostSlots, hostNext, persistLiveness }
    : undefined;

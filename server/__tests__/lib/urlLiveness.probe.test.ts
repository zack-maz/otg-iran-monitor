// @vitest-environment node
/**
 * Phase 32 Plan 32-02 Task 1 — `probeUrl` mocked-fetch matrix.
 *
 * Pins the D-16 (HEAD-then-GET on 405) + D-17 (≤3 redirect hops with
 * `redirect: 'manual'`) + D-21 (User-Agent literal) + defense-in-depth
 * SSRF guard contracts. Every status taxonomy branch from
 * `UrlLivenessStatusSchema` (`live | 404 | 403 | dead-host | unknown`)
 * has a dedicated test case so future refactors of `probeUrl` fail loudly
 * on regression.
 *
 * Mock strategy mirrors `server/__tests__/lib/freeClaudeRouter.test.ts`:
 * `vi.stubGlobal('fetch', fetchMock)` + `vi.mock('../../cache/redis.js')`
 * + `vi.mock('../../lib/logger.js')`. Dynamic import after mocks are
 * registered so the module-under-test consumes the mocked surface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Sanity guard — MEDIUM-02 plan-checker fix. If the runner ever stops
// forcing NODE_ENV=test, file-load fails loudly so silent fallthrough
// (e.g. real Redis writes from a future cacheSetSafe call site) can't
// occur.
expect(process.env.NODE_ENV).toBe('test');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('../../cache/redis.js', () => ({
  cacheGetSafe: vi.fn(async () => null),
  cacheSetSafe: vi.fn(async () => undefined),
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    incr: vi.fn(),
    decr: vi.fn(),
    del: vi.fn(),
    expire: vi.fn(),
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// Dynamic import — mocks must be registered first.
const { probeUrl, classifySoft404 } = await import('../../lib/urlLiveness.js');

function makeResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/**
 * Phase 43 Plan 02 — build a 200 Response whose `.body` streams the given HTML
 * via a real `getReader()`-bearing ReadableStream, so the capped-GET body read
 * in `probeUrl` exercises the manual reader loop. `chunkBytes` controls how
 * many bytes each `read()` yields (used to assert the 16 KiB cap aborts a
 * server that ignores `Range`). `onCancel` records `reader.cancel()` calls.
 */
function makeBodyResponse(
  html: string,
  opts: { status?: number; chunkBytes?: number; onCancel?: () => void } = {},
): Response {
  const { status = 200, chunkBytes = 1 << 20, onCancel } = opts;
  const full = new TextEncoder().encode(html);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= full.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkBytes, full.byteLength);
      controller.enqueue(full.subarray(offset, end));
      offset = end;
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/html' } });
}

const NORMAL_ARTICLE_HTML =
  '<html><head><title>A real news article</title></head><body><article>' +
  'The situation on the ground continued to develop today. '.repeat(40) +
  '</article></body></html>';

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Phase 32 Plan 02 Task 1 — probeUrl', () => {
  describe('terminal-2xx and explicit-4xx taxonomy (D-07)', () => {
    it('HEAD 200 → status:live, httpStatus:200 (+ capped body GET classifies live)', async () => {
      // Phase 43: the 200 branch now issues a follow-up capped GET whose body
      // feeds classifySoft404. A normal article body → still live.
      fetchMock
        .mockResolvedValueOnce(makeResponse(200))
        .mockResolvedValueOnce(makeBodyResponse(NORMAL_ARTICLE_HTML));
      const result = await probeUrl('https://example.com/article');
      expect(result.status).toBe('live');
      expect(result.httpStatus).toBe(200);
      expect(result.finalUrl).toBe('https://example.com/article');
      expect(result.evidence).toBeNull();
      // 1 HEAD + 1 capped GET.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('HEAD 404 → status:"404"', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(404));
      const result = await probeUrl('https://example.com/missing');
      expect(result.status).toBe('404');
      expect(result.httpStatus).toBe(404);
    });

    it('HEAD 403 → status:"403"', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(403));
      const result = await probeUrl('https://example.com/forbidden');
      expect(result.status).toBe('403');
      expect(result.httpStatus).toBe(403);
    });

    it('HEAD 405 → GET with Range fallback, then 200 → status:live (D-16)', async () => {
      fetchMock
        .mockResolvedValueOnce(makeResponse(405))
        .mockResolvedValueOnce(makeResponse(200))
        .mockResolvedValueOnce(makeBodyResponse(NORMAL_ARTICLE_HTML));
      const result = await probeUrl('https://cdn.example.com/article');
      expect(result.status).toBe('live');
      expect(result.httpStatus).toBe(200);
      // 1 HEAD + 1 405-fallback GET + 1 capped body GET.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // Assert the 405-fallback GET carried the 1 KiB Range header.
      const getCall = fetchMock.mock.calls[1];
      expect(getCall?.[1]?.method).toBe('GET');
      expect(getCall?.[1]?.headers?.Range).toBe('bytes=0-1023');
    });

    it('5xx / unmapped 4xx (e.g. 451) → status:unknown', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(503));
      const result = await probeUrl('https://example.com/down');
      expect(result.status).toBe('unknown');
      expect(result.httpStatus).toBe(503);
    });
  });

  describe('redirect handling (D-17)', () => {
    it('3xx chain length ≤3 with terminal 200 → status:live', async () => {
      fetchMock
        .mockResolvedValueOnce(makeResponse(301, { location: 'https://b.example.com/' }))
        .mockResolvedValueOnce(makeResponse(302, { location: 'https://c.example.com/' }))
        .mockResolvedValueOnce(makeResponse(200))
        .mockResolvedValueOnce(makeBodyResponse(NORMAL_ARTICLE_HTML));
      const result = await probeUrl('https://a.example.com/');
      expect(result.status).toBe('live');
      expect(result.httpStatus).toBe(200);
      expect(result.finalUrl).toBe('https://c.example.com/');
      // 3 redirect/terminal HEADs + 1 capped body GET.
      expect(fetchMock).toHaveBeenCalledTimes(4);
      // Every redirect-following fetch must carry `redirect: 'manual'` so the
      // hop count is honest (the capped body GET also uses manual).
      for (const call of fetchMock.mock.calls) {
        expect(call[1]?.redirect).toBe('manual');
      }
    });

    it('3xx chain that hits 4th 3xx → status:unknown', async () => {
      fetchMock
        .mockResolvedValueOnce(makeResponse(301, { location: 'https://b.example.com/' }))
        .mockResolvedValueOnce(makeResponse(301, { location: 'https://c.example.com/' }))
        .mockResolvedValueOnce(makeResponse(301, { location: 'https://d.example.com/' }))
        .mockResolvedValueOnce(makeResponse(301, { location: 'https://e.example.com/' }));
      const result = await probeUrl('https://a.example.com/');
      expect(result.status).toBe('unknown');
      // 3 follows + 1 evaluation at hop=3 = 4 calls total.
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  describe('failure modes', () => {
    it('fetch throws (DNS/ECONNREFUSED) → status:dead-host, httpStatus:null', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed: ENOTFOUND'));
      const result = await probeUrl('https://no-such-host.invalid/');
      expect(result.status).toBe('dead-host');
      expect(result.httpStatus).toBe(null);
    });

    it('AbortController timeout (fake timers) → status:dead-host', async () => {
      vi.useFakeTimers();
      // Mock fetch as a hang that rejects via AbortError when the controller fires.
      fetchMock.mockImplementationOnce((_url, init) => {
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }
        });
      });
      const promise = probeUrl('https://slow.example.com/');
      // Advance past PROBE_TIMEOUT_MS = 10_000.
      await vi.advanceTimersByTimeAsync(11_000);
      const result = await promise;
      expect(result.status).toBe('dead-host');
      expect(result.httpStatus).toBe(null);
    });
  });

  describe('polite-citizen headers (D-21)', () => {
    it('every fetch carries the exact PROBE_UA User-Agent', async () => {
      fetchMock
        .mockResolvedValueOnce(makeResponse(200))
        .mockResolvedValueOnce(makeBodyResponse(NORMAL_ARTICLE_HTML));
      await probeUrl('https://example.com/');
      // Both the HEAD and the follow-up capped GET carry the UA.
      for (const call of fetchMock.mock.calls) {
        expect(call?.[1]?.headers?.['User-Agent']).toBe(
          'IranMonitor-LinkCheck/1.0 (+https://motg-iran.vercel.app)',
        );
      }
    });
  });

  describe('SSRF guard (defense-in-depth)', () => {
    it('localhost target → status:unknown WITHOUT calling fetch', async () => {
      const result = await probeUrl('http://localhost:6379/secret');
      expect(result.status).toBe('unknown');
      expect(result.httpStatus).toBe(null);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('RFC1918 private host (10.x) → status:unknown WITHOUT calling fetch', async () => {
      const result = await probeUrl('http://10.0.0.1/admin');
      expect(result.status).toBe('unknown');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('link-local AWS metadata (169.254.x) → status:unknown WITHOUT calling fetch', async () => {
      const result = await probeUrl('http://169.254.169.254/latest/meta-data/');
      expect(result.status).toBe('unknown');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // CR-02 regression — URL.hostname returns IPv6 with surrounding brackets
    // (e.g. '[::1]'). The previous regex anchored at `^` against literal
    // '::1' / 'fc' / 'fd' and never matched the leading '[', leaving the
    // probe open to fetches against IPv6 loopback / link-local / ULA hosts.
    it('CR-02 — IPv6 loopback http://[::1]/ → status:unknown WITHOUT calling fetch', async () => {
      const result = await probeUrl('http://[::1]:6379/secret');
      expect(result.status).toBe('unknown');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('CR-02 — IPv6 ULA http://[fd00::1]/ → status:unknown WITHOUT calling fetch', async () => {
      const result = await probeUrl('http://[fd00::1]/admin');
      expect(result.status).toBe('unknown');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('CR-02 — IPv6 link-local http://[fe80::1]/ → status:unknown WITHOUT calling fetch', async () => {
      const result = await probeUrl('http://[fe80::1]/admin');
      expect(result.status).toBe('unknown');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('CR-02 — IPv4-mapped-IPv6 http://[::ffff:127.0.0.1]/ → status:unknown WITHOUT calling fetch', async () => {
      const result = await probeUrl('http://[::ffff:127.0.0.1]/admin');
      expect(result.status).toBe('unknown');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('CR-02 — IPv6 unspecified http://[::]/ → status:unknown WITHOUT calling fetch', async () => {
      const result = await probeUrl('http://[::]/admin');
      expect(result.status).toBe('unknown');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // CR-02 negative test — legitimate hostnames containing 'fc'/'fd' prefixes
    // (e.g. 'fc-barcelona.com', 'fdcompany.com') must NOT be false-positive-blocked
    // now that ULA detection requires the `[0-9a-f]{2}:` hex disambiguation.
    it('CR-02 — legitimate hostname "fc-barcelona.com" is NOT blocked by SSRF guard', async () => {
      fetchMock
        .mockResolvedValueOnce(makeResponse(200))
        .mockResolvedValueOnce(makeBodyResponse(NORMAL_ARTICLE_HTML));
      const result = await probeUrl('https://fc-barcelona.com/players');
      expect(result.status).toBe('live');
      expect(fetchMock).toHaveBeenCalled();
    });

    it('CR-02 — legitimate hostname "fdcompany.com" is NOT blocked by SSRF guard', async () => {
      fetchMock
        .mockResolvedValueOnce(makeResponse(200))
        .mockResolvedValueOnce(makeBodyResponse(NORMAL_ARTICLE_HTML));
      const result = await probeUrl('https://fdcompany.com/about');
      expect(result.status).toBe('live');
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});

// ============================================================================
// Phase 43 Plan 02 Task 1 — classifySoft404 pure heuristic (GHOST-06)
// ============================================================================
//
// Table-driven test for the pure soft-404 body heuristic. No fetch mock — the
// function takes (bodyText, finalUrl, originalUrl) and returns a verdict.
// Covers all three D-02 signals in order, the D-03 precision-first tie-break,
// and the D-02 signal-order precedence (markers win over near-empty).

describe('Phase 43 Plan 02 Task 1 — classifySoft404 (GHOST-06)', () => {
  const DEEP = 'https://x.com/news/article-123';

  describe('(a) not-found markers in <title> — D-02a, case-insensitive', () => {
    const markerCases: Array<{ name: string; title: string; marker: string }> = [
      { name: 'lowercase "page not found"', title: 'Page not found', marker: 'page not found' },
      { name: 'mixed-case "Page Not Found"', title: 'Page Not Found', marker: 'page not found' },
      // CR-03 — error-context "404" phrase (bare '404' dropped to avoid
      // matching live Persian-calendar / hardware / flight-number titles).
      { name: 'error-context "error 404"', title: 'Error 404 — Oops', marker: 'error 404' },
      {
        name: '"article not available"',
        title: 'This article not available',
        marker: 'article not available',
      },
      {
        name: '"this page no longer exists"',
        title: 'Sorry, this page no longer exists',
        marker: 'this page no longer exists',
      },
    ];

    for (const { name, title, marker } of markerCases) {
      it(`title containing ${name} → soft404:true with verbatim D-16 evidence`, () => {
        const body = `<html><head><title>${title}</title></head><body>x</body></html>`;
        // Deep→deep URLs so ONLY the marker signal can fire.
        const result = classifySoft404(body, DEEP, DEEP);
        expect(result.soft404).toBe(true);
        expect(result.evidence).toBe(`soft-404: matched "${marker}" in title`);
      });
    }

    it('marker present only in BODY text (not title) does NOT fire (precision — articles about 404s)', () => {
      // A legitimate article ABOUT 404 errors; title is benign, body mentions "404".
      const body =
        '<html><head><title>How HTTP status codes work</title></head>' +
        '<body>' +
        'A 404 means page not found. '.repeat(40) +
        '</body></html>';
      const result = classifySoft404(body, DEEP, DEEP);
      expect(result.soft404).toBe(false);
      expect(result.evidence).toBeNull();
    });

    // CR-03 — live conflict-news titles that the OLD bare substrings ('404',
    // 'not found', 'no longer exists') would have deterministically flagged as
    // soft-404, pruning a live event. Each must classify LIVE now that markers
    // require explicit error framing.
    const liveTitleCases: Array<{ name: string; title: string }> = [
      // Persian Solar-Hijri year 1404 (Mar 2025–Mar 2026, in the war window).
      { name: 'Persian year 1404 budget headline', title: "Iran's 1404 budget review under way" },
      // Casualty/search headline containing "not found".
      {
        name: '"sailors not found" headline',
        title: 'Missing sailors not found after strike on tanker',
      },
      // Ceasefire headline containing "no longer exists".
      {
        name: '"ceasefire no longer exists" headline',
        title: 'Hamas says the ceasefire no longer exists, official confirms',
      },
      // Military hardware containing "404".
      {
        name: 'GE F404 engine headline',
        title: 'GE F404 engine deliveries resume to fighter fleet',
      },
    ];

    for (const { name, title } of liveTitleCases) {
      it(`live title ${name} → soft404:false (CR-03 regression — must NOT prune live)`, () => {
        // Substantial body + deep→deep URLs so ONLY the marker signal could fire.
        const body =
          `<html><head><title>${title}</title></head><body><article>` +
          'Substantial reporting content fills the article body here. '.repeat(40) +
          '</article></body></html>';
        const result = classifySoft404(body, DEEP, DEEP);
        expect(result.soft404).toBe(false);
        expect(result.evidence).toBeNull();
      });
    }
  });

  describe('(b) redirect-to-home — D-02b (deep→shallow only)', () => {
    it('deep article → homepage root "/" → soft404:true with D-16 evidence', () => {
      const body =
        '<html><head><title>Home</title></head><body>' + 'x'.repeat(2000) + '</body></html>';
      const result = classifySoft404(body, 'https://x.com/', 'https://x.com/news/article-123');
      expect(result.soft404).toBe(true);
      expect(result.evidence).toBe('redirect-to-home: /news/article-123 → /');
    });

    it('deep article → single-segment section root → soft404:true', () => {
      const body =
        '<html><head><title>News</title></head><body>' + 'x'.repeat(2000) + '</body></html>';
      const result = classifySoft404(body, 'https://x.com/news', 'https://x.com/news/article-123');
      expect(result.soft404).toBe(true);
      expect(result.evidence).toBe('redirect-to-home: /news/article-123 → /news');
    });

    it('deep → deep canonical move is NOT redirect-to-home (final depth > 1)', () => {
      const body =
        '<html><head><title>Article</title></head><body>' + 'x'.repeat(2000) + '</body></html>';
      const result = classifySoft404(
        body,
        'https://x.com/news/2026/article-123-final',
        'https://x.com/news/article-123',
      );
      expect(result.soft404).toBe(false);
      expect(result.evidence).toBeNull();
    });

    it('shallow original → shallow final does NOT fire (orig depth < 2)', () => {
      const body =
        '<html><head><title>Section</title></head><body>' + 'x'.repeat(2000) + '</body></html>';
      const result = classifySoft404(body, 'https://x.com/', 'https://x.com/news');
      expect(result.soft404).toBe(false);
      expect(result.evidence).toBeNull();
    });
  });

  describe('(c) near-empty content — D-02c (stripped-of-tags floor)', () => {
    it('body whose stripped content is below the floor → soft404:true with byte-count evidence', () => {
      // Markup with almost no text content after tag-stripping.
      const body =
        '<html><head><title>Article</title></head><body><div id="root"></div></body></html>';
      const result = classifySoft404(body, DEEP, DEEP);
      expect(result.soft404).toBe(true);
      // Evidence format: "near-empty: <n> bytes" with the stripped content length.
      expect(result.evidence).toMatch(/^near-empty: \d+ bytes$/);
    });

    it('normal article body (above floor, no markers, deep→deep) → soft404:false', () => {
      const body =
        '<html><head><title>A real news article</title></head><body><article>' +
        'The situation on the ground continued to develop today. '.repeat(40) +
        '</article></body></html>';
      const result = classifySoft404(body, DEEP, DEEP);
      expect(result.soft404).toBe(false);
      expect(result.evidence).toBeNull();
    });

    // WR-04 — a CSR/SPA shell is near-empty after tag-stripping but is
    // script-heavy (JS hydrates the live article client-side). The OLD
    // text-length-only rule would have flagged this LIVE article dead. With
    // the no-`<script>` co-condition it must classify live.
    it('near-empty SPA shell WITH a <script> tag → soft404:false (WR-04 — never prune live CSR)', () => {
      const body =
        '<html><head><title>Loading…</title></head><body>' +
        '<div id="root"></div>' +
        '<script src="/assets/app.bundle.js"></script>' +
        '</body></html>';
      const result = classifySoft404(body, DEEP, DEEP);
      expect(result.soft404).toBe(false);
      expect(result.evidence).toBeNull();
    });
  });

  describe('precision-first tie-break (D-03) + signal order (D-02)', () => {
    it('no signal fires → soft404:false, evidence:null (NEVER flag live)', () => {
      const body =
        '<html><head><title>Breaking news from the region</title></head><body><article>' +
        'Detailed reporting with substantial content goes here. '.repeat(50) +
        '</article></body></html>';
      const result = classifySoft404(body, DEEP, DEEP);
      expect(result.soft404).toBe(false);
      expect(result.evidence).toBeNull();
    });

    it('body that is BOTH near-empty AND has a title marker returns MARKER evidence (markers first per D-02)', () => {
      // Near-empty body whose title also carries a not-found marker. Markers
      // evaluated first → evidence must be the marker, not "near-empty".
      const body = '<html><head><title>Page not found</title></head><body></body></html>';
      const result = classifySoft404(body, DEEP, DEEP);
      expect(result.soft404).toBe(true);
      expect(result.evidence).toBe('soft-404: matched "page not found" in title');
    });
  });
});

// ============================================================================
// Phase 43 Plan 02 Task 2 — probeUrl 200-branch capped GET + soft-404 wiring
// ============================================================================
//
// Integration over the mocked fetch: every 200 (HEAD or 405-fallback GET, or
// the terminal hop of a redirect chain) triggers a follow-up 16 KiB capped GET
// whose decoded body feeds classifySoft404. Asserts soft-404 detection, the
// 16 KiB Range header, the cap abort on Range-ignoring servers, degrade-open
// on body-read throw, and the SSRF-safe target (the already-vetted finalUrl).

describe('Phase 43 Plan 02 Task 2 — probeUrl soft-404 body wiring (GHOST-06)', () => {
  it('200 with <title>Page not found</title> → status:soft-404 + D-16 evidence', async () => {
    const soft404Body =
      '<html><head><title>Page not found</title></head><body>' +
      'x'.repeat(1000) +
      '</body></html>';
    fetchMock
      .mockResolvedValueOnce(makeResponse(200))
      .mockResolvedValueOnce(makeBodyResponse(soft404Body));
    const result = await probeUrl('https://example.com/news/article-1');
    expect(result.status).toBe('soft-404');
    expect(result.evidence).toBe('soft-404: matched "page not found" in title');
    expect(result.httpStatus).toBe(200);
    expect(result.finalUrl).toBe('https://example.com/news/article-1');
  });

  it('200 with a normal deep-article body → status:live, evidence:null', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(200))
      .mockResolvedValueOnce(makeBodyResponse(NORMAL_ARTICLE_HTML));
    const result = await probeUrl('https://example.com/news/2026/big-story');
    expect(result.status).toBe('live');
    expect(result.evidence).toBeNull();
    expect(result.httpStatus).toBe(200);
  });

  it('the capped GET sends Range: bytes=0-16383 (16 KiB, NOT the 1 KiB 405-fallback)', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(200))
      .mockResolvedValueOnce(makeBodyResponse(NORMAL_ARTICLE_HTML));
    await probeUrl('https://example.com/news/article-2');
    // calls[0] = HEAD, calls[1] = capped body GET.
    const cappedGet = fetchMock.mock.calls[1];
    expect(cappedGet?.[1]?.method).toBe('GET');
    expect(cappedGet?.[1]?.headers?.Range).toBe('bytes=0-16383');
  });

  it('server ignores Range and streams > 16 KiB → read aborts at the cap (reader.cancel called)', async () => {
    let cancelled = false;
    // 64 KiB of normal content; tiny chunks so the reader loop iterates many
    // times and the cap break happens mid-stream.
    const bigHtml =
      '<html><head><title>Huge but live</title></head><body>' +
      'y'.repeat(64 * 1024) +
      '</body></html>';
    fetchMock.mockResolvedValueOnce(makeResponse(200)).mockResolvedValueOnce(
      makeBodyResponse(bigHtml, {
        chunkBytes: 4096,
        onCancel: () => {
          cancelled = true;
        },
      }),
    );
    const result = await probeUrl('https://example.com/news/huge');
    // Cap aborted the read → connection released via reader.cancel().
    expect(cancelled).toBe(true);
    // A huge-but-live body classifies live (markers absent, deep→deep, above floor).
    expect(result.status).toBe('live');
  });

  it('degrade-open (D-22): body read throws → status:live, evidence:null', async () => {
    // A 200 HEAD, then a capped GET whose body stream errors on read.
    const erroringStream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('stream blew up');
      },
    });
    const erroringResponse = new Response(erroringStream, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    fetchMock.mockResolvedValueOnce(makeResponse(200)).mockResolvedValueOnce(erroringResponse);
    const result = await probeUrl('https://example.com/news/flaky');
    expect(result.status).toBe('live');
    expect(result.evidence).toBeNull();
    expect(result.httpStatus).toBe(200);
  });

  it('SSRF: the capped GET targets the already-vetted finalUrl (same currentUrl, no fresh unvetted fetch)', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(200))
      .mockResolvedValueOnce(makeBodyResponse(NORMAL_ARTICLE_HTML));
    const url = 'https://vetted.example.com/news/article-3';
    await probeUrl(url);
    // The capped GET (calls[1]) must hit the exact vetted finalUrl.
    const cappedGet = fetchMock.mock.calls[1];
    expect(cappedGet?.[0]).toBe(url);
  });

  it('capped GET that itself returns null (fetch threw) → degrade-open to live', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(200))
      .mockRejectedValueOnce(new Error('GET failed'));
    const result = await probeUrl('https://example.com/news/article-4');
    expect(result.status).toBe('live');
    expect(result.evidence).toBeNull();
    expect(result.httpStatus).toBe(200);
  });

  // CR-02 — method-asymmetric bot-blocking: HEAD 200 then a GET 403 with a
  // tiny "Access Denied" body. Without the body-GET status check, signal (c)
  // near-empty would condemn this LIVE article as soft-404 (cron-prunable).
  // The 2xx-only gate must return live (degrade-open, precision-first).
  it('CR-02 — HEAD 200 then GET 403 with tiny body → status:live (no soft-404 false positive)', async () => {
    const tinyDenied =
      '<html><head><title>Access Denied</title></head><body>Forbidden</body></html>';
    fetchMock
      .mockResolvedValueOnce(makeResponse(200))
      .mockResolvedValueOnce(makeBodyResponse(tinyDenied, { status: 403 }));
    const result = await probeUrl('https://cdn.example.com/news/blocked-article');
    expect(result.status).toBe('live');
    expect(result.evidence).toBeNull();
    expect(result.httpStatus).toBe(200);
  });

  // CR-02 — method-dependent redirect: GET answered with a 3xx (empty body
  // under redirect:'manual'). Near-empty would fire on the 0-byte body; the
  // non-2xx gate must short-circuit to live.
  it('CR-02 — HEAD 200 then GET 302 with empty body → status:live (no near-empty false positive)', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(200))
      .mockResolvedValueOnce(makeResponse(302, { location: 'https://cdn.example.com/' }));
    const result = await probeUrl('https://cdn.example.com/news/redirected-on-get');
    expect(result.status).toBe('live');
    expect(result.evidence).toBeNull();
    expect(result.httpStatus).toBe(200);
  });
});

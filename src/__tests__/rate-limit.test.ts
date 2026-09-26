/**
 * Phase 28.2 W6 Plan 06 Task 3 — D-30 companion rate-limit defense test (B-6).
 *
 * Per CONTEXT D-30 + checker B-6: validates that Plan 02's
 * `rateLimiters.public` global tier (60 req / 60s) is firing for
 * unauthenticated traffic AND being skipped (Bearer-bypassed) for
 * privileged operator traffic.
 *
 * Target endpoint: `/api/audit-status`.
 *
 * Originally targeted `/api/health` (per checker B-6 wording), but
 * `server/index.ts:93-94` mounts both `/health` and `/api/health` BEFORE
 * `app.use('/api', rateLimiters.public)` at line 109, intentionally to keep
 * health probes unthrottled. The pre-fix test against `/api/health` always
 * returned 70/70 200 because the global limiter never saw the requests —
 * verified via `gh run view 25574926020` (Phase 28.2.7 audit run after
 * fast-xml-builder bump). All 5 prior `prod-connectivity-audit.yml` runs
 * (2026-05-06 → 2026-05-08) failed for this reason.
 *
 * `/api/audit-status` is mounted AFTER the global limiter
 * (`server/index.ts:141`) and has NO per-endpoint cap (the route comment
 * even spells this out: "per-endpoint global 60/min rate limit applies").
 * That makes it the smallest reproducer for "global tier firing":
 * 70 unauth bursts → ≥1 returns 429.
 *
 * Per-endpoint routes (flights/ships/etc) cannot prove the global tier
 * because their tighter per-endpoint caps trip first; a 429 there is
 * ambiguous between the two layers.
 *
 * Two named test files (this one + api-connectivity.test.ts), two atomic
 * commits per CONTEXT <specifics> "D-30 two-pass audit".
 *
 * To run:
 *   API_BASE_URL=http://localhost:5173 RUN_RATE_LIMIT_TEST=1 \
 *     DASHBOARD_PASSWORD=<secret> npx vitest run src/__tests__/rate-limit.test.ts
 *
 * To run against prod (CI workflow does this with secrets):
 *   API_BASE_URL=https://motg-iran.vercel.app RUN_RATE_LIMIT_TEST=1 \
 *     DASHBOARD_PASSWORD=<secret> npx vitest run src/__tests__/rate-limit.test.ts
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:5173';
const BEARER = process.env.DASHBOARD_PASSWORD ?? '';
const RUN = process.env.RUN_RATE_LIMIT_TEST === '1';

/**
 * Path that goes through the global rate limiter (mounted under
 * `app.use('/api', rateLimiters.public)`) but has no per-endpoint cap.
 * See file-header rationale for why `/api/health` is wrong.
 */
const TARGET_PATH = '/api/audit-status';

/**
 * Number of bursts. 70 is just above the 60/min global ceiling so the
 * sliding-window counter trips during the burst. Below ANY reasonable
 * DDoS threshold and below per-endpoint caps for the routes flights/ships
 * (which we explicitly do NOT target — see file-header rationale).
 */
const BURST_SIZE = 70;

describe.skipIf(!RUN)(`Rate limit (D-30 companion, B-6: ${TARGET_PATH} target)`, () => {
  it(`public tier throttles unauthenticated burst on ${TARGET_PATH} (B-6)`, async () => {
    const responses = await Promise.all(
      Array.from({ length: BURST_SIZE }, () => fetch(`${API_BASE_URL}${TARGET_PATH}`)),
    );
    const throttled = responses.filter((r) => r.status === 429);
    expect(
      throttled.length,
      `expected ≥1 of ${BURST_SIZE} unauthenticated ${TARGET_PATH} bursts to return 429 ` +
        `(global tier defends); got ${throttled.length}. ` +
        `If running locally, ensure NODE_ENV=production+VERCEL=1 are set so the ` +
        `dev short-circuit doesn't bypass the limiter.`,
    ).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it(`Bearer bypasses public tier on ${TARGET_PATH} (D-04 positive path)`, async () => {
    if (BEARER === '') {
      // Skip when no secret in env — local dev short-circuits the limiter
      // entirely, so the bypass branch isn't exercised. CI workflow always
      // attaches the secret so this assertion runs in prod.

      console.warn('Skipping Bearer-bypass positive-path assertion — DASHBOARD_PASSWORD not set.');
      return;
    }
    const responses = await Promise.all(
      Array.from({ length: BURST_SIZE }, () =>
        fetch(`${API_BASE_URL}${TARGET_PATH}`, {
          headers: { Authorization: `Bearer ${BEARER}` },
        }),
      ),
    );
    const throttled = responses.filter((r) => r.status === 429);
    expect(
      throttled.length,
      `expected 0 of ${BURST_SIZE} Bearer-attached ${TARGET_PATH} bursts to return 429 ` +
        `(global tier should be bypassed); got ${throttled.length}. ` +
        `If failing, the D-04 Bearer-bypass branch in rateLimiters.public is broken.`,
    ).toBe(0);
  }, 60_000);
});

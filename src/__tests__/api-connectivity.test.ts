/**
 * Phase 28.2 W6 Plan 06 Task 2 — API connectivity smoke suite (D-24/D-29).
 *
 * Probes every adapter from `server/routes/health.ts:227` `PROBE_STRATEGIES`
 * (16 endpoints) and asserts ≥1 successful fetch with non-empty body.
 *
 * Single suite, two environments — `API_BASE_URL` env var defaults to
 * `http://localhost:5173`. CI workflow at `.github/workflows/prod-connectivity-audit.yml`
 * sets `API_BASE_URL=https://motg-iran.vercel.app` from a GitHub
 * Actions secret for the prod-URL run (D-25 phase-close gate).
 *
 * Bearer is attached to every probe (D-30) — exercises Plan 02 Bearer-bypass
 * end-to-end so the suite hits all 16 endpoints in seconds without 429s.
 *
 * The suite SKIPS by default during local `npx vitest run` (no
 * `RUN_CONNECTIVITY_TEST` env var) so CI's regular test pass doesn't trigger
 * 16 fetches against a possibly-not-running localhost server. To run locally:
 *   API_BASE_URL=http://localhost:5173 RUN_CONNECTIVITY_TEST=1 \
 *     DASHBOARD_PASSWORD=<secret> npx vitest run src/__tests__/api-connectivity.test.ts
 *
 * To run against prod (manual smoke):
 *   API_BASE_URL=https://motg-iran.vercel.app RUN_CONNECTIVITY_TEST=1 \
 *     DASHBOARD_PASSWORD=<secret> npx vitest run src/__tests__/api-connectivity.test.ts
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:5173';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD ?? '';
const RUN = process.env.RUN_CONNECTIVITY_TEST === '1';

/**
 * Build the Authorization header for every probe (D-30).
 * In local dev with no DASHBOARD_PASSWORD, return empty headers — the server
 * dev short-circuit handles auth bypass; in prod the workflow secret must be set.
 */
function bearerHeaders(): Record<string, string> {
  if (DASHBOARD_PASSWORD === '') return {};
  return { Authorization: `Bearer ${DASHBOARD_PASSWORD}` };
}

/**
 * Generic probe + JSON parse for an endpoint. Throws with diagnostic context
 * on network failure / non-200 / non-JSON.
 */
async function probe(name: string, path: string): Promise<unknown> {
  const url = `${API_BASE_URL}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: bearerHeaders() });
  } catch (err) {
    throw new Error(
      `${name} fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `${name} returned ${res.status} ${res.statusText} for ${url}; body excerpt: ${bodyText.slice(0, 200)}`,
    );
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(
      `${name} returned non-JSON body for ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Generic non-empty assertion per D-24 contract.
 */
function assertNonEmpty(name: string, body: unknown): void {
  expect(body, `${name} body must be truthy`).toBeTruthy();
  if (typeof body === 'object' && body !== null) {
    expect(Object.keys(body).length, `${name} body must have at least one key`).toBeGreaterThan(0);
  }
}

describe.skipIf(!RUN)('API connectivity (D-24, 16 endpoints from PROBE_STRATEGIES)', () => {
  // Phase 28.2 W6 fix: API routes wrap payloads in a CacheResponse envelope
  // `{ data, fetchedAt, stale }` (Phase 13). The original schema assertions
  // tolerated raw arrays or `{ flights: [] }` only and rejected the actual
  // prod shape. Accept any of: raw array, named-key array, or the envelope.
  const arrayShape = (body: unknown): unknown[] | undefined => {
    if (Array.isArray(body)) return body;
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      for (const k of ['data', 'flights', 'ships', 'events', 'sites', 'facilities']) {
        if (Array.isArray(obj[k])) return obj[k] as unknown[];
      }
    }
    return undefined;
  };

  // ---------------------------------------------------------------------
  // Critical tier — live conflict data
  // ---------------------------------------------------------------------

  it('flights (/api/flights) returns non-empty data with Bearer', async () => {
    const body = await probe('flights', '/api/flights');
    assertNonEmpty('flights', body);
    expect(
      arrayShape(body),
      'flights body must be an array, { flights: [] }, or { data: [] }',
    ).not.toBeUndefined();
  }, 30_000);

  it('ships (/api/ships) returns non-empty data with Bearer', async () => {
    const body = await probe('ships', '/api/ships');
    assertNonEmpty('ships', body);
    expect(
      arrayShape(body),
      'ships body must be an array, { ships: [] }, or { data: [] }',
    ).not.toBeUndefined();
  }, 30_000);

  it('events (/api/events) returns non-empty data with Bearer', async () => {
    const body = await probe('events', '/api/events');
    assertNonEmpty('events', body);
    expect(
      arrayShape(body),
      'events body must be an array, { events: [] }, or { data: [] }',
    ).not.toBeUndefined();
  }, 30_000);

  // ---------------------------------------------------------------------
  // Non-critical tier
  // ---------------------------------------------------------------------

  it('news (/api/news) returns non-empty data with Bearer', async () => {
    const body = await probe('news', '/api/news');
    assertNonEmpty('news', body);
  }, 30_000);

  it('markets (/api/markets) returns non-empty data with Bearer', async () => {
    const body = await probe('markets', '/api/markets');
    assertNonEmpty('markets', body);
  }, 30_000);

  it('weather (/api/weather) returns non-empty data with Bearer', async () => {
    const body = await probe('weather', '/api/weather');
    assertNonEmpty('weather', body);
  }, 30_000);

  it('waterPrecip (/api/water/precip) returns non-empty data with Bearer', async () => {
    const body = await probe('waterPrecip', '/api/water/precip');
    assertNonEmpty('waterPrecip', body);
  }, 30_000);

  it('sources (/api/sources) returns non-empty data with Bearer', async () => {
    const body = await probe('sources', '/api/sources');
    assertNonEmpty('sources', body);
  }, 30_000);

  it('llmStatus (/api/events/llm-status) returns non-empty data with Bearer', async () => {
    const body = await probe('llmStatus', '/api/events/llm-status');
    assertNonEmpty('llmStatus', body);
  }, 30_000);

  // ---------------------------------------------------------------------
  // Static tier
  // ---------------------------------------------------------------------

  it('sites (/api/sites) returns non-empty data with Bearer', async () => {
    const body = await probe('sites', '/api/sites');
    assertNonEmpty('sites', body);
    expect(
      arrayShape(body),
      'sites body must be an array, { sites: [] }, or { data: [] }',
    ).not.toBeUndefined();
  }, 30_000);

  it('water (/api/water) returns non-empty data with Bearer', async () => {
    const body = await probe('water', '/api/water');
    assertNonEmpty('water', body);
    expect(
      arrayShape(body),
      'water body must be an array, { facilities: [] }, or { data: [] }',
    ).not.toBeUndefined();
  }, 30_000);

  // ---------------------------------------------------------------------
  // Probe-only tier
  // ---------------------------------------------------------------------

  it('authCheck (/api/dashboard/auth-check) returns 200 with Bearer', async () => {
    // Probe-only — 200 means Bearer matches (or dev short-circuit). No body shape.
    const body = await probe('authCheck', '/api/dashboard/auth-check');
    // Some impls return {ok:true}, others empty; 200 is the contract.
    expect(body).toBeTruthy();
  }, 30_000);

  it('geocode (/api/geocode) returns non-empty data with Bearer', async () => {
    // Geocode requires lat/lon query params — Tehran coords for the probe.
    const body = await probe('geocode', '/api/geocode?lat=35.6892&lon=51.3890');
    assertNonEmpty('geocode', body);
  }, 30_000);

  // ---------------------------------------------------------------------
  // Aggregate / always-on
  // ---------------------------------------------------------------------

  it('health (/api/health) returns aggregate with summary + endpoints', async () => {
    const body = await probe('health', '/api/health');
    assertNonEmpty('health', body);
    const obj = body as { summary?: unknown; endpoints?: unknown };
    expect(obj.summary, 'health.summary must be present').toBeTruthy();
    expect(obj.endpoints, 'health.endpoints must be present').toBeTruthy();
  }, 30_000);

  // ---------------------------------------------------------------------
  // Cron tier — probed via /api/health.endpoints aggregate (cron routes
  // require CRON_SECRET Bearer, NOT DASHBOARD_PASSWORD; direct probing
  // would 401, so we verify their freshness telemetry is being captured
  // through the /api/health aggregate.)
  // ---------------------------------------------------------------------

  it('cronHealth (probed via /api/health.endpoints) freshness is captured', async () => {
    const body = await probe('cronHealth', '/api/health');
    const obj = body as { endpoints?: Record<string, unknown> };
    expect(
      obj.endpoints?.cronHealth,
      '/api/health.endpoints.cronHealth must be present',
    ).toBeTruthy();
  }, 30_000);

  it('cronWarm (probed via /api/health.endpoints) freshness is captured', async () => {
    const body = await probe('cronWarm', '/api/health');
    const obj = body as { endpoints?: Record<string, unknown> };
    expect(obj.endpoints?.cronWarm, '/api/health.endpoints.cronWarm must be present').toBeTruthy();
  }, 30_000);

  it('cronRefreshEvents (probed via /api/health.endpoints) freshness is captured', async () => {
    const body = await probe('cronRefreshEvents', '/api/health');
    const obj = body as { endpoints?: Record<string, unknown> };
    expect(
      obj.endpoints?.cronRefreshEvents,
      '/api/health.endpoints.cronRefreshEvents must be present',
    ).toBeTruthy();
  }, 30_000);
});

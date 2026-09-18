// Consolidated server configuration — env validation (Zod) + constants
// Single source of truth for all server environment variables and constants.

import { z } from 'zod';

import type { BoundingBox } from './types.js';

// ---------------------------------------------------------------------------
// Env schema — Zod validates at module load (fail-fast on bad config)
// ---------------------------------------------------------------------------

export const envSchema = z
  .object({
    // Required (crash if missing in non-test environments)
    UPSTASH_REDIS_REST_URL: z.string().url(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1),

    // Optional with defaults
    PORT: z.coerce.number().default(3001),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    // Vercel runtime environment ('production' | 'preview' | 'development'),
    // injected by Vercel; unset locally and in CI. Read by the CACHE_KEY_PREFIX
    // production guard (superRefine below). z.string() (not enum) so an
    // unexpected value never rejects the whole config over this advisory field.
    VERCEL_ENV: z.string().optional(),
    CORS_ORIGIN: z.string().default('*'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    // Optional API keys (graceful degradation — empty string means unconfigured)
    OPENSKY_CLIENT_ID: z.string().default(''),
    OPENSKY_CLIENT_SECRET: z.string().default(''),
    ADSB_EXCHANGE_API_KEY: z.string().default(''),
    AISSTREAM_API_KEY: z.string().default(''),
    ACLED_EMAIL: z.string().default(''),
    ACLED_PASSWORD: z.string().default(''),
    // Phase 38 LLM-PURGE-06 — CEREBRAS_API_KEY / GROQ_API_KEY env vars deleted.
    // The Cerebras + Groq providers were deferred (Phase 34) and never wired into
    // the runtime NIM-only cascade; the keys had `.default('')` and zero readers.

    // Phase 27.4.3 (D-04, D-22): free-claude-code routing providers.
    // NVIDIA NIM is the v3 primary (40 req/min free tier, no documented
    // daily token cap). OpenRouter is the v3 fallback (~100-200 req/day per
    // free model). Both are graceful — empty string means unconfigured and
    // the v3 cascade falls through to the next provider (or returns null,
    // letting the extractor degrade to raw GDELT per D-29).
    NVIDIA_NIM_API_KEY: z.string().default(''),
    OPENROUTER_API_KEY: z.string().default(''),

    // Phase 29 D-02 part C — LLM_PIPELINE_V2 / LLM_PIPELINE_V3 env entries
    // removed alongside the v1 + v2 extractor modules and the
    // pipeline-version helper functions. The active pipeline is now v3-only;
    // no env flag controls the dispatch. The Vercel env vars themselves
    // (LLM_PIPELINE_V2, LLM_PIPELINE_V3) are left set during the deploy
    // window so a git-revert finds them; operator prunes them when v1.5
    // closes (per RESEARCH.md Open Question 4).

    // Phase 27.4.1 (D-01/D-02/D-03): per-batch timeout for the LLM extractor
    // watchdog. Default hard-kills a batch that NIM never returns from; the DLQ
    // absorbs the group and the loop continues. Phase 30 D-05 retired the
    // 60s soft-warn tier — only the hard cap remains, env-tunable for
    // in-incident rescue without a redeploy.
    //
    // Phase 30 D-02 retune: bumped 90_000 → 120_000 ms. Derivation per
    // CONTEXT D-02 formula `max(2 × measured_batch_latency_p95, observed
    // throttle_window + 30s)` against Run 1 baseline
    // (.planning/phases/30-.../run-1-throttle-snapshot.json):
    //   - perBatchLatency.p95 = 33_263 ms  → 2× = 66_526 ms
    //   - throttleWindowMs    = Path B (no 429s) → fallback path (lower bound)
    //   - Headroom for the long-tail beyond a 213-sample p95 → round up to 120s
    // Pitfall 4 math at concurrency=12 over ~196 batches: wall-clock stays
    // comfortably inside the Pro 800s ceiling even at worst-case 120s/batch.
    // Operator rollback: `LLM_BATCH_TIMEOUT_MS=90000` reverts to v1.4 default.
    LLM_BATCH_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

    // Phase 27.4.4 Plan 02 — v3 batch concurrency. Sequential processing was
    // ~2 batches/min against a NIM ceiling of 40 req/min, leaving ~95% of the
    // rate budget unused. With ~27s/batch latency, default concurrency = 12
    // lands roughly 26 req/min steady-state — well under the 40 cap, with
    // enough headroom to absorb cold-start spikes and per-batch latency
    // variance. Drives 197-batch dev runs from ~95 min → ~10 min.
    //
    // Phase 30 D-02 sanity-check (Run 1 baseline): no re-tune.
    // CONTEXT D-02 formula `(observed_NIM_steady_RPM × measured_batch_latency
    // _seconds) / 60` is undefined because Run 1 measured `steadyStateRpm = 0`
    // (Path B — NIM did not return 429s during the 122s window so the analyzer
    // never observed a steady-state RPM ceiling). The 213 batches in 122s
    // wall-clock imply effective parallelism >12 in production, which suggests
    // there is headroom — but without a measured throttle ceiling we keep the
    // default conservative. Plan 06 Run 2 (with eval harness fixed) can
    // re-probe by raising concurrency and watching for the first 429s.
    //
    // Tuning knob:
    //   - LLM_V3_CONCURRENCY=1 reverts to fully sequential (rollback path)
    //   - LLM_V3_CONCURRENCY=20 saturates NIM but risks 429s mid-run
    //   - default=12 balances throughput against rate-limit safety
    //
    // The setting only affects the per-batch fan-out; resolver geocoding is
    // still serialized at 1 req/s for Nominatim regardless of this value.
    LLM_V3_CONCURRENCY: z.coerce.number().int().positive().default(12),

    // Phase 30 D-07 (LLM-RELI-03) — promoted from the hard-coded
    // `const BATCH_SIZE = 2` at server/lib/llmEventExtractor.v3.ts (D-10
    // rationale: each group already carries news + Bellingcat + temporal
    // context, so narrow batches fit the qwen-235b attention budget better
    // than wider ones).
    //
    // Phase 30 D-02 sanity-check (Run 1 baseline): kept at 2.
    // CONTEXT D-02 invited a raise toward 4-8 gated by `runEval()` accuracy
    // under the wider group context (Plan 06 ±3pp absolute regression budget
    // at 5/20/100km). Run 1's `evalScore.total = 0` because the ground-truth
    // fixture is not bundled into the Vercel deploy output (Plan 02 SUMMARY
    // run-note 2) — the gate cannot be evaluated. Raise to 4-8 only after
    // Plan 06 lands the eval-harness fix and Run 2 confirms the ±3pp budget.
    //
    // Tuning knob:
    //   - LLM_BATCH_SIZE=2   v1.4 default (sized for Hobby 300s ceiling)
    //   - LLM_BATCH_SIZE=4-8 v1.5 candidates (Plan 06 ±3pp eval gate bounds
    //     the upper end; wider batches stress the model's schema adherence
    //     on verbose groups).
    LLM_BATCH_SIZE: z.coerce.number().int().positive().default(2),

    // Phase 30 D-04 (SIMPLIFY-01) — the prior incremental-flush cadence env
    // var was retired here. The Phase 28.2.6 incremental-flush mechanism is
    // gone; the terminal write at end of runRefreshExtraction is now the
    // canonical (and only) writer of events:llm:v3. Operators with the legacy
    // flush-cadence var still set in their Vercel environment can prune it
    // post-merge — Zod no longer parses it.

    // Phase 27.4.4 D-04 / D-13 / D-18: opt-in feature flags for v3 latency remediation.
    // Default OFF for D-04 + D-18 keeps Gate B telemetry pure; activated post-cutover when
    // ops cost > telemetry purity (D-04, D-18).
    V3_ADAPTIVE_BATCH: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    V3_LINEAGE_PREFILTER: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Phase 27.4.4 D-13: env-tunable Trigger 1 (auto-rollback) threshold. Default 2
    // (lowered from hardcoded 3 to keep consistent with strict Gate B watchdog=0
    // while letting single timeouts recover without spurious flip).
    V3_WATCHDOG_ROLLBACK_THRESHOLD: z.coerce.number().int().positive().default(2),
    // Phase 27.4.4 D-14: Vercel cron secret. Empty default preserves existing
    // un-authed cron-warm/cron-health behavior; eval-cron route 401s when set.
    CRON_SECRET: z.string().default(''),

    // Phase 27.4.4 Plan 02 — Bearer-token gate for the dashboard surfaces:
    //   - GET  /api/events/llm-pipeline    (state read)
    //   - POST /api/events/llm-pipeline    (cutover flip — the v3 deploy gate)
    //   - POST /api/events/llm-replay/:id  (single-group replay; fires upstream LLM tokens)
    //   - GET  /api/dashboard/auth-check   (client-side gate validation)
    //
    // Behavior (server/middleware/dashboardAuth.ts):
    //   - NODE_ENV !== 'production'           → bypass auth (dev convenience)
    //   - NODE_ENV === 'production' + empty   → 503 auth_not_configured (fail-closed)
    //   - NODE_ENV === 'production' + matches → next()
    //
    // Operator generates the value with `openssl rand -hex 32` and sets it in
    // both `.env.local` (dev parity) and `vercel env add DASHBOARD_PASSWORD
    // production` (prod gate). Replaces the previous `NODE_ENV === 'production'`
    // 404 gates which made the cutover endpoint physically unreachable from the
    // operator's laptop.
    DASHBOARD_PASSWORD: z.string().default(''),

    // Phase 27.4.4 D-20 Option B (RESEARCH §6) — dev/prod Redis key isolation
    // when a separate Upstash database is unavailable. When set (e.g. `dev:`),
    // every key passing through the wrapped `redis` instance + cacheGet/Set
    // helpers gets the prefix applied. Production never sets this so prod keys
    // remain unsuffixed (`events:llm:v3`); dev sets `CACHE_KEY_PREFIX=dev:` in
    // .env.local so dev runs land at `dev:events:llm:v3` and never collide with
    // the live prod cache. Defense-in-depth — survives operator forgetting to
    // swap Upstash databases.
    CACHE_KEY_PREFIX: z.string().default(''),

    // Tuning parameters
    EVENT_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),
    EVENT_MIN_SOURCES: z.coerce.number().int().min(1).default(2),
    EVENT_CENTROID_PENALTY: z.coerce.number().min(0).max(1).default(0.7),
    EVENT_EXCLUDED_CAMEO: z
      .string()
      .default('180,192')
      .transform((s) =>
        s
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    BELLINGCAT_CORROBORATION_BOOST: z.coerce.number().min(0).max(1).default(0.2),
    NEWS_RELEVANCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  })
  // Production guard — recurrence defense for the llm-events-not-enriched-prod
  // incident (2026-06-06): prod had `CACHE_KEY_PREFIX=dev: ` set, routing every
  // prod cache write into the `dev:` namespace while readers used bare keys, so
  // `events:llm:v3` looked empty and `/api/events` served raw GDELT for ~31 days.
  // The contract (CACHE_KEY_PREFIX comment above) is "production never sets
  // this". This refinement makes a violation a LOUD fail-fast at startup instead
  // of a silent multi-week degradation. Keyed on VERCEL_ENV so preview/dev can
  // still isolate keys; only production is forbidden from prefixing.
  .superRefine((val, ctx) => {
    if (val.VERCEL_ENV === 'production' && val.CACHE_KEY_PREFIX.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CACHE_KEY_PREFIX'],
        message:
          `CACHE_KEY_PREFIX must be empty in production (got ${JSON.stringify(val.CACHE_KEY_PREFIX)}). ` +
          'A non-empty prefix routes every prod cache write into a prefixed namespace while ' +
          'readers use bare keys — silently breaking events:llm:v3 and the live cache. ' +
          'Delete CACHE_KEY_PREFIX from the production Vercel env; it is for local/preview only.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

// Parse eagerly — crashes at startup if required vars are missing.
// In test environments, provide safe defaults for Redis vars so unit tests
// that don't have real Redis don't crash on import.
function parseEnv(): Env {
  const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  if (isTest) {
    // In test: provide safe defaults for Redis vars, but let real env vars override
    const merged = { ...process.env };
    if (!merged.UPSTASH_REDIS_REST_URL)
      merged.UPSTASH_REDIS_REST_URL = 'https://test-redis.upstash.io';
    if (!merged.UPSTASH_REDIS_REST_TOKEN) merged.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    return envSchema.parse(merged);
  }
  return envSchema.parse(process.env);
}

export const env = parseEnv();

// ---------------------------------------------------------------------------
// Backward-compatible config object (replaces old AppConfig / getConfig)
// ---------------------------------------------------------------------------

export interface AppConfig {
  port: number;
  corsOrigin: string;
  opensky: { clientId: string; clientSecret: string };
  aisstream: { apiKey: string };
  acled: { email: string; password: string };
  newsRelevanceThreshold: number;
  eventConfidenceThreshold: number;
  eventMinSources: number;
  eventCentroidPenalty: number;
  eventExcludedCameo: string[];
  bellingcatCorroborationBoost: number;
}

export const config: AppConfig = {
  port: env.PORT,
  corsOrigin: env.CORS_ORIGIN,
  opensky: {
    clientId: env.OPENSKY_CLIENT_ID,
    clientSecret: env.OPENSKY_CLIENT_SECRET,
  },
  aisstream: {
    apiKey: env.AISSTREAM_API_KEY,
  },
  acled: {
    email: env.ACLED_EMAIL,
    password: env.ACLED_PASSWORD,
  },
  newsRelevanceThreshold: env.NEWS_RELEVANCE_THRESHOLD,
  eventConfidenceThreshold: env.EVENT_CONFIDENCE_THRESHOLD,
  eventMinSources: env.EVENT_MIN_SOURCES,
  eventCentroidPenalty: env.EVENT_CENTROID_PENALTY,
  eventExcludedCameo: env.EVENT_EXCLUDED_CAMEO,
  bellingcatCorroborationBoost: env.BELLINGCAT_CORROBORATION_BOOST,
};

/** @deprecated Use `config` directly — kept for backward compat during migration */
export function getConfig(): AppConfig {
  return config;
}

/** @deprecated Use `config` directly */
export function loadConfig(): AppConfig {
  return config;
}

// ---------------------------------------------------------------------------
// Domain-definitional constants (Phase 28.1 W5 D-11)
//
// Canonical home for the client tier is `src/lib/domain.ts`. This server-side
// copy exists because tsconfig.server.json (`include: ["server","api"]`)
// excludes the src/ tree, so a cross-tier re-export is not buildable.
//
// Drift sentinel: `src/__tests__/domain.test.ts` asserts byte-identity between
// the two copies on every CI run. Editing any of these values here REQUIRES
// the same edit to src/lib/domain.ts in the same commit.
// ---------------------------------------------------------------------------

/** Start of the US-Iran war — earliest date for historical event data */
export const WAR_START = Date.UTC(2026, 1, 28); // Feb 28, 2026 00:00Z

// Greater Middle East + Mediterranean + Arabian Sea
// Covers full visible map area for ship/event subscriptions
export const IRAN_BBOX: BoundingBox = {
  south: 0.0,
  north: 50.0,
  west: 20.0,
  east: 80.0,
};

// adsb.lol center point for radius query (centered on region)
export const IRAN_CENTER = { lat: 28.0, lon: 45.0 } as const;
export const ADSB_RADIUS_NM = 1200;

/**
 * User-Agent sent on outbound upstream fetches. Node's default (`node`) is
 * blocklisted by some public APIs — adsb.lol began returning 403 for it, which
 * took /api/flights down in prod (2026-09). Always identify ourselves.
 */
export const OUTBOUND_USER_AGENT = 'otg-iran-monitor/1.0 (+https://otg-iran-monitor.vercel.app)';

// Unit conversion constants (adsb.lol v2 API uses imperial units)
export const KNOTS_TO_MS = 0.514444;
export const FEET_TO_METERS = 0.3048;
export const FPM_TO_MS = 0.00508; // feet per minute to meters per second

// Sites cache TTL (24 hours -- static infrastructure data)
export const SITES_CACHE_TTL = 86_400_000;

// Cache TTL values per data source (milliseconds)
export const CACHE_TTL = {
  flights: 10_000, // 10s -- OpenSky polling interval
  adsblolFlights: 30_000, // 30s -- adsb.lol community API (respectful polling)
  ships: 0, // N/A for WebSocket push
  events: 900_000, // 15min -- GDELT updates every 15 minutes
  news: 900_000, // 15min -- news feed TTL
} as const;

// Markets cache TTL (5 minutes -- matches client polling interval)
export const MARKETS_CACHE_TTL = 300_000; // 5 min logical TTL
export const MARKETS_REDIS_TTL_SEC = 3000; // 50 min hard TTL (10x logical)

// Weather cache TTL (30 minutes -- Open-Meteo hourly update frequency)
export const WEATHER_CACHE_TTL = 1_800_000; // 30 min logical TTL
export const WEATHER_REDIS_TTL_SEC = 18_000; // 5h hard TTL (10x logical)
export const WEATHER_CACHE_KEY = 'weather:open-meteo';

// Water infrastructure cache TTLs
export const WATER_CACHE_TTL = 86_400_000; // 24h logical TTL
export const WATER_REDIS_TTL_SEC = 604_800; // 7 days hard TTL
export const WATER_PRECIP_CACHE_TTL = 21_600_000; // 6h logical TTL
export const WATER_PRECIP_REDIS_TTL_SEC = 86_400; // 1 day hard TTL

// News aggregation constants
export const NEWS_CACHE_TTL = 900_000; // 15 min logical TTL
export const NEWS_REDIS_TTL_SEC = 9000; // 2.5h hard TTL (10x logical)
export const NEWS_SLIDING_WINDOW_MS = 7 * 86_400_000; // 7 days
export const NEWS_CLUSTER_WINDOW_MS = 86_400_000; // 24h fuzzy match window
export const NEWS_JACCARD_THRESHOLD = 0.8;
export const NEWS_MIN_TOKENS_FOR_FUZZY = 5;

// ---------------------------------------------------------------------------
// Phase 29 D-02 part C — pipeline-version helpers fully removed.
//
// Plan 04 deleted the in-memory pipeline-override module state +
// set/get/refresh override helpers. Plan 06 (this commit) finished the
// collapse by deleting the per-version probe functions now that v1 + v2
// extractor modules are gone. The active pipeline is v3-only; callers that
// previously branched on the version helper now reference inline
// `'events:llm:v3'` constants directly (see
// server/lib/llmExtractionPipeline.ts).
// ---------------------------------------------------------------------------

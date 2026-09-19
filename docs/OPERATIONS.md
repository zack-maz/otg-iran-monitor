# Operations

How to tell what is wrong with Iran Monitor, what each failure looks like, and how to fix it.
System design lives in [ARCHITECTURE.md](./ARCHITECTURE.md); Redis keys in [redis-keys.md](./redis-keys.md); env vars in [`.env.example`](../.env.example); known open defects in [AUDIT-2026-09.md](./AUDIT-2026-09.md).

**Production:** `https://otg-iran-monitor.vercel.app` · Vercel project `otg-iran-monitor` (Pro; one Express function, `maxDuration: 800`) · Upstash Redis (REST) · three daily crons from `vercel.json`: `/api/cron/health` 00:00 UTC, `/api/cron/refresh-events` 04:00, `/api/cron/warm` 12:00.

**Secrets you need:** `DASHBOARD_PASSWORD` (operator Bearer for the dashboard and operator endpoints) and `CRON_SECRET` (Bearer for cron routes). Never paste either into a shared command or commit. Every Production env var is marked **Sensitive** in Vercel: it cannot be read back from the dashboard, and `vercel env pull` writes it as an empty string. If you have lost a value, rotate it — `vercel env rm X production --yes && printf '<new>' | vercel env add X production`, then `vercel redeploy <current prod URL>` (env changes only apply to new deployments). Rotating `CRON_SECRET` is safe: Vercel's scheduler injects the current value itself.

```bash
export BASE=https://otg-iran-monitor.vercel.app
export BEARER='<DASHBOARD_PASSWORD>'
export CRON='<CRON_SECRET>'
```

## 1. First five minutes

### 1.1 `/api/health` (public, always HTTP 200, never rate-limited; `/health` is an alias)

```bash
curl -s $BASE/api/health | jq -r '.endpoints[] | [.name,.tier,.status,(.missedRun//"-"),((.freshnessMs//0)/60000|floor|tostring+"m"),(.lastErrorReason//"")] | @tsv'
```

This is a **freshness view of Redis keys** (`SOURCE_KEYS` in `server/lib/healthSources.ts`). It never calls an upstream, so it cannot tell you _why_ a feed is down.

| `status`    | Meaning (`deriveStatus`)                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `healthy`   | key age ≤ threshold                                                                                                 |
| `degraded`  | threshold < age ≤ 2× threshold, **or** a fallback key is fresh while the primary is cold (reason string says which) |
| `unhealthy` | age > 2× threshold, or the probe itself threw / timed out                                                           |
| `unknown`   | key absent. No data, no error history                                                                               |

Tiers: `critical` (flights, ships, events), `non-critical` (llmEvents, llmStatus, news, markets, weather, waterPrecip, sources), `static` (sites, water), `probe-only` (authCheck, geocode — always healthy if the process is up), `cron` (three `cron:lastTick:*` keys, 26 h threshold, plus a `missedRun` field: `unknown` never fired, `healthy`, `missed` = more than 28 h since last tick).

Reading it correctly:

- **`unknown` on a polled feed usually means "nobody has the site open".** Hard TTLs are short (flights and ships 5 min, markets 50 min, events and news 2.5 h, weather 5 h). Open the site or curl the route, then re-check. **Still `unknown` after hitting the route = the route is failing** (this is how the 2026-09 flights outage presented — never `unhealthy`, and the in-app outage banner only reacts to `unhealthy`).
- `llmEvents` / `llmStatus` = `degraded` with `llm-optional-fallback-active` → the enriched cache `events:llm:v3` is cold and the app is serving raw GDELT. Expected only if LLM keys are deliberately unset; otherwise see §3.3.
- `news` = `degraded` with `cache-fallback-active` → news is RSS-only because GDELT-DOC is blocked (§3.8).
- **A healthy `cronRefreshEvents` row proves only that the handler returned.** `cron:lastTick:refresh-events` is written even when the run was declined (`no_raw_events`, `cooldown`, …). Use §1.4 or `llm-history` to see what actually happened.
- Redis unreachable → nearly every row `unknown` (reads fall through to an empty in-memory map), some `unhealthy` (2 s probe timeout).

### 1.2 Hit the routes

```bash
for p in flights ships events news markets weather sites water sources; do
  printf '%-8s %s\n' $p "$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/$p)"; done
curl -s $BASE/api/flights | jq '{error,code,stale,degraded,n:(.data|length?)}'
```

Success envelope: `{data, stale, lastFresh, degraded?}`. `stale:true` = upstream failed or cache past logical TTL, old data served. `degraded:true` = Redis failed, served from instance memory. Error envelope: `{error, code, statusCode, requestId}`; the `requestId` (also the `X-Request-ID` response header) appears as `req.id` in that request's pino lines.

Responses are CDN-cached (`server/middleware/cacheControl.ts`): a fix can take `s-maxage` + `stale-while-revalidate` to show — 30 s for flights, 15 min for events/news, up to 24 h for sites/water. Add a throwaway query param to bypass.

### 1.3 Operator surfaces (Bearer = `DASHBOARD_PASSWORD`; 503 `auth_not_configured` if that env var is empty in prod)

```bash
curl -s -H "Authorization: Bearer $BEARER" $BASE/api/operator-status | jq 'keys'
curl -s -H "Authorization: Bearer $BEARER" $BASE/api/events/llm-status | jq '{stage,lastRun,dlqRecent}'
curl -s -H "Authorization: Bearer $BEARER" "$BASE/api/events/llm-history?limit=20" | jq '.runs[] | {runId,startedAt,outcome,batchCount,batchesFailed}'
```

- `operator-status` → `audit24h`, `byBearer`, `advEval`, `prune` (dead-URL counts), `actorQuality`, `tokenBudget`, `trendHistory`, `rateLimiter` (per-tier limits and 429 counts for today + yesterday).
- `llm-history` → `runs` (from `llm:runs:history`) and `calls` (`llm:calls:history`). **No run rows = the cron never dispatched. A `running` row that never closed = the function was killed at 800 s. `error` rows = the run failed.** Outcomes: `running | completed | watchdog_aborted | breaker_paused | budget_hit | error`.
- In the app: the `API ~` / `API !` badge in the top bar opens the same data (password prompt in prod).
- `GET /api/audit-status` (public) shows the last manual connectivity-audit result; `{"status":"absent"}` means the 7-day key expired (§4.8).

### 1.4 Vercel logs

The repo is not linked to the Vercel project, so pass `--project`. **Always pass `--no-branch`**: the CLI otherwise filters to your current git branch and prod (`main`) returns nothing. Output is capped at 2,000 rows and unfiltered output is mostly polling traffic (a chatty request can occupy dozens of rows), so always narrow with `--query` / `--status-code` and a time window. With `--json` each row is one request; the app's pino lines are JSON strings under `.logs[].message`.

```bash
vl() { vercel logs --project otg-iran-monitor --environment production --no-branch --json "$@"; }
# What did last night's LLM cron decide?  -> {"dispatched":false,"reason":"no_raw_events"} etc.
vl --since 30h --query "/api/cron/refresh-events" --limit 50 | jq -r 'select(.requestPath=="/api/cron/refresh-events")
  | .logs[]?.message | fromjson? | select(.module=="refresh-events-cron") | [(.time/1000|todate),.msg,(.result|tostring),.durationMs] | @tsv'
# All 5xx in the last day, grouped by path
vl --since 24h --status-code 5xx --limit 500 | jq -r '[.requestPath,.responseStatusCode]|@tsv' | sort | uniq -c | sort -rn
# The error behind them (pino level 50 = error, 40 = warn)
vl --since 2h --status-code 5xx --limit 50 | jq -r '.logs[]?.message | fromjson? | select(.level>=40) | [.module,.msg,(.err.message//"")] | @tsv' | sort | uniq -c
# One request end to end: <id> is the `.id` of a row above (the part of x-vercel-id after `::`)
vl --since 1h --request-id <id> | jq -r '.logs[]?.message'
```

Logger `module` names are short: `flights`, `ships`, `events`, `raw-events-refresh`, `gdelt`, `news`, `rss`, `markets`, `yahoo-finance`, `weather`, `sites`, `water`, `overpass`, `overpass-water`, `health`, `cron-health`, `cron-warm`, `refresh-events-cron`, `llm-extraction-pipeline`, `llm-extractor-v3`, `llm-resolver`, `llm-watchdog`, `llm-dlq`, `urlLiveness`, `operator-status`. The Redis wrapper does not log. Authorization, cookies and Vercel OIDC/proxy-signature headers are redacted (`server/lib/logger.ts`); API keys are not in the redact list, so never log env objects.

### 1.5 Other consoles

- **Vercel dashboard:** Deployments (last deploy, build errors), Cron Jobs (run history + status code), Usage (bill; Pro exists only for the 800 s limit).
- **GitHub Actions:** `CI` (lint, format, typecheck, knip, tests with coverage, `npm audit --audit-level=high`), `CodeQL` (weekly; GitHub disables it after 60 days of repo inactivity — re-enable in the Actions tab), `Prod Connectivity Audit` (manual only). As of 2026-09 `main` is red on the `audit` job (1 critical in maplibre-gl needing a major bump, 17 high).
- **Upstash console:** daily command count (free tier ≈ 500 K/day, resets 00:00 UTC), data browser for keys. Every rate-limit check costs Redis commands.

## 2. Degradation contract

Design rules: the map never goes blank; one dead source never takes down another; Redis failure never produces a 500; the LLM is optional ([ADR-0010](./adr/0010-v1-5-llm-pipeline-narrowing-and-deletion.md)). Known violations are listed as such.

| Layer                                             | Failure                                                                         | Server returns                                                                                                                                                            | User sees                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Redis                                             | Upstash unreachable, hung, or over quota                                        | Every op raced against 2 s (`REDIS_OP_TIMEOUT_MS`), then per-instance memory map; 200 with `degraded:true`. Enforced by `server/__tests__/resilience/redis-death.test.ts` | Slower first request per instance; otherwise normal                                                   |
| Rate limiter                                      | Upstash error                                                                   | Request passes (degrade-open)                                                                                                                                             | Nothing                                                                                               |
| Rate limiter                                      | Limit exceeded                                                                  | 429 `RATE_LIMITED` + `X-RateLimit-*` headers; counted in `ratelimit:429:{tier}:{date}`                                                                                    | Red status dot for that feed                                                                          |
| Any upstream                                      | Fails, cached copy still inside hard TTL                                        | 200, `stale:true`, old `lastFresh`                                                                                                                                        | Yellow dot                                                                                            |
| Events                                            | LLM cache cold, LLM unconfigured, or LLM run failed                             | Raw GDELT from `events:gdelt`                                                                                                                                             | Events still render with GDELT's own coordinates; no summaries or precision rings                     |
| Events                                            | LLM cache warm                                                                  | Enriched events. Flagged `stale:true` most of the day because the writer is daily and the logical TTL is 15 min                                                           | Yellow events dot is normal                                                                           |
| Events / news / markets / weather / sites / water | Upstream fails **and** no cached copy                                           | 502 `UPSTREAM_FAIL`                                                                                                                                                       | Red dot, layer empty                                                                                  |
| Flights                                           | Upstream fails and key expired (5 min)                                          | **500 `INTERNAL_ERROR`** (untyped error — known flaw)                                                                                                                     | Red dot, red `API !` badge, no planes, no explanation. Client keeps polling every 5 s with no backoff |
| Ships                                             | AISStream fails or `AISSTREAM_API_KEY` missing, no cache                        | **500 `UPSTREAM_ERROR`**                                                                                                                                                  | Red dot, no ships                                                                                     |
| Flights (client)                                  | No fresh data for 60 s                                                          | —                                                                                                                                                                         | Flights are cleared, not shown stale (≈15 km drift per minute)                                        |
| Response validation                               | Payload drifts from Zod schema (`sendValidated`: flights, events, sites, water) | Dev/test: 500 `RESPONSE_SCHEMA_MISMATCH`. Prod: warn log, payload sent anyway                                                                                             | Nothing                                                                                               |
| Selected entity                                   | Disappears from feed                                                            | —                                                                                                                                                                         | Detail panel greys out with "LOST CONTACT", last-known values kept                                    |
| Function                                          | Exceeds 800 s                                                                   | 504; work lost                                                                                                                                                            | Only the LLM cron can get near this                                                                   |
| Env                                               | Zod schema rejects env at cold start                                            | Every request 500 (module load fails)                                                                                                                                     | Blank map, all dots red                                                                               |

Sites and water were designed to fall back to committed JSON snapshots (`src/data/sites.json`, `src/data/water-facilities.json`) so Overpass stays off the request path. **In production the snapshot files are not in the deployed function** (`vercel.json` `includeFiles` ships only `api/_eval/*.json`; logs show `snapshot file absent`). A cold key therefore goes straight to Overpass. The daily warm cron and 3-day / 7-day hard TTLs are what actually keep these layers up.

## 3. Failure playbooks

### 3.1 Flights empty — upstream blocking us

- **Symptom:** `/api/flights` → 500 `adsb.lol API error: 403`; health row `unknown`.
- **Cause (2026-09 incident):** adsb.lol rejects Node's default `User-Agent: node`. Fixed by sending `OUTBOUND_USER_AGENT` (`server/config.ts`) from `server/adapters/adsb-lol.ts`.
- **Check:** `curl -s -o /dev/null -w '%{http_code}\n' -A 'otg-iran-monitor/1.0' https://api.adsb.lol/v2/lat/28/lon/45/dist/250` vs. the same with `-A node` (403 = that UA is blocked).
- **Fix:** if the UA is blocked again, change `OUTBOUND_USER_AGENT` and redeploy. There is no fallback: the client is hard-wired to `source=adsblol`, no source selector exists, and OpenSky is not configured in prod (`?source=opensky` → 503 unless `OPENSKY_CLIENT_ID/SECRET` are set).

### 3.2 GDELT stale or paused

- **Symptom:** same events on every poll, `stale:true`, log module `gdelt` errors.
- **Check:** `curl -s http://data.gdeltproject.org/gdeltv2/lastupdate.txt` — deliberately HTTP (GDELT's TLS is unreliable). Normal cadence 15 min; GDELT pauses on holidays and maintenance. Wait 15–60 min first.
- **History missing** (only recent events on the map): `curl -s "$BASE/api/events?backfill=true" | jq '.data|length'`. This rebuilds from the war start date by sampling 4 files per day. It is slow (hundreds of ZIP downloads, no per-fetch timeout) and runs inside the request; it bypasses the 1 h `events:backfill-ts` cooldown. Normally unnecessary: the route backfills on its own whenever `events:gdelt` is absent (the cron never persists a backfill-less set into an empty key).

### 3.3 LLM cache cold (app serving raw GDELT)

1. **What did the cron decide?** §1.4 first recipe, or force it and read the body:
   `curl -s -H "Authorization: Bearer $CRON" "$BASE/api/cron/refresh-events?force=true" | jq`

   | Body                        | Meaning                                                                                                                                                                                                                                      |
   | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `dispatched:true`           | Run started in the background (`safeWaitUntil`); the HTTP response returns immediately. Follow it in `llm-status` / logs                                                                                                                     |
   | `reason:"no_raw_events"`    | No raw GDELT available and the refresh failed → §3.2. (Before 2026-09 this happened nightly: the cron only read `events:gdelt`, which only a browser visit wrote. The cron now refreshes it itself via `refreshRawEvents`, without backfill) |
   | `reason:"llm_unconfigured"` | `NVIDIA_NIM_API_KEY` missing in that environment                                                                                                                                                                                             |
   | `reason:"cooldown"`         | Ran < 15 min ago (`events:llm-process-ts`). `?force=true` or an empty cache bypasses this                                                                                                                                                    |
   | `reason:"pipeline_busy"`    | This instance thinks a run is in progress (in-memory flag)                                                                                                                                                                                   |

2. **Did the run finish?** `llm-history` runs (§1.3). `running` forever = killed at 800 s, which should no longer happen: the run works in waves (extract → geocode → persist) under its own budgets — no new LLM wave after 480 s, geocoding stops at 660 s — and every wave is written to `events:llm:v3` as it completes. A cold corpus (~1,100 groups) takes a few runs to cover, highest severity first; force the next one (§4.1) rather than waiting a day. `outcome: error` with `LLM provider answered HTTP 4xx` = step 4.
3. **Did the write land?** Each wave logs `LLM: persisted enriched events` with `writtenCount` and `total`, or `LLM: write to the enriched cache FAILED` with the error (20 s timeout; a run that persisted nothing ends `error`). From outside: `curl -s "$BASE/api/events?nc=$RANDOM" | jq '[.data[]|select(.data.llmProcessed)]|length'` — the number should climb during a run.
4. **All batches null within seconds?** Look at `calls` in `llm-history`, or the `router attempt failed` lines in the logs (§1.4), for the error text. 401 = NIM key revoked. **410 = model id retired** — NIM retires free-tier preview models on a schedule and answers `{"title":"Gone","detail":"The model '…' has reached its end of life on <date>"}` for every call afterwards; the run still ends `completed` with nothing written, and health stays green. This killed the pipeline from 2026-07-27 (`qwen/qwen3.5-397b-a17b`) until 2026-09-19. Check without a key — a retired id 410s before auth, a live one 403s:

   ```bash
   curl -s -X POST https://integrate.api.nvidia.com/v1/chat/completions -H 'Content-Type: application/json' \
     -d '{"model":"<id>","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'
   curl -s https://integrate.api.nvidia.com/v1/models | jq -r '.data[].id'   # current catalog
   ```

   The catalog over-promises: most listed ids answer 404 to a free-tier key, and the reasoning models (GLM, Kimi, DeepSeek, gpt-oss) exceed 90 s on this prompt. Find a replacement with the probe (§4.1b) — it sends one real batch per candidate with the production key. Hotfix: `printf '<live id>' | vercel env add V3_PRIMARY_MODEL production`, then `vercel redeploy <current prod URL>` (env changes need a new deployment), then §4.1. Follow up by changing the default in `server/lib/freeClaudeRouter.ts` and removing the env var. Also check that a stray `V3_BAKEOFF_MODEL` is **not** set in Vercel — it silently overrides the production model.

Turning the LLM off on purpose: unset `NVIDIA_NIM_API_KEY`, redeploy. `/api/events` keeps serving raw GDELT; locked by `server/__tests__/routes/llm-optional.test.ts`. To test "no key", use an empty value, not an invalid one. Do not set `OPENROUTER_API_KEY` in prod: the extractor skips OpenRouter (`skipOpenRouter: true`) but the geocode reranker in `server/lib/llmResolver.ts` will use it.

### 3.4 NIM throttling

- **Symptom:** 429s in `llm-history` calls, DLQ (`events:llm-dlq`) entries, `breaker_paused` outcomes. A few `v3:timeout_watchdog` DLQ entries per run are baseline, not an incident.
- **Mechanics:** in-process limiter of 40 calls/min — callers wait for a slot, they are not turned away; the OpenAI SDK's own retries are off, so the router's 3 attempts per batch (2 s / 8 s / 32 s backoff ± 500 ms, code constants) are the only ones. The circuit breaker (> 30 % of the last 10 calls failed ⇒ 5 min pause) applies only when a second provider has a key; with NIM alone it would void the rest of the run. Nothing is user-visible (raw GDELT fallback).
- **Levers (Vercel env, then redeploy):** `LLM_V3_CONCURRENCY` (default 8 ≈ 32 req/min at gemma's ~15 s per batch; try 4, or 1 for fully sequential; it also sets the wave size) · `LLM_BATCH_SIZE` (default 2 groups per call) · `LLM_BATCH_TIMEOUT_MS` (default 120000; a batch over this is dead-lettered and the run continues). Then force-trigger (§4.1). Measure before tuning: `GET /api/cron/llm-probe?models=<id>,<id>,…` with the same id repeated shows latency under that much concurrency. NIM's behaviour changes month to month.
- OpenRouter as fallback is dormant: free tier measured 90 % rate-limited (2026-05-17). Re-probe with §4.7.

### 3.5 Overpass flaky (sites / water)

- **Symptom:** `/api/sites` or `/api/water` slow then 502, or `/api/cron/warm` returns `status:"partial"`.
- Adapters try `overpass-api.de`, then `overpass.private.coffee`. Core-country query must succeed; extended countries are best-effort. Hard TTLs (sites 3 d, water 7 d) ride out multi-day outages.
- **Fix:** re-run the warm cron: `curl -s $BASE/api/cron/warm | jq` (unauthenticated — known flaw; two full Overpass pulls, can take minutes). `/api/sites?refresh=true` forces Overpass for sites; on `/api/water` the flag works only in dev or from Vercel cron.
- Never loosen the water name / Latin-label admission gate to "recover" missing facilities; that reintroduces generic "Dam near X" labels.

### 3.6 Yahoo Finance blocked

- **Symptom:** `/api/markets` stale or 502; module `yahoo-finance` shows 401/403/429 or an HTML body.
- Unofficial API; blocks by User-Agent and burst. One batched upstream call per range; logical TTL 5 min, hard TTL 50 min.
- **Fix:** wait 5 min; if persistent update the `User-Agent` in `server/adapters/yahoo-finance.ts` and redeploy. Markets is a soft dependency.

### 3.7 AISStream (ships)

- **Symptom:** no ships, `/api/ships` 500 or `stale:true`.
- Serverless cannot hold a socket: each cache-miss request connects, collects ~5 s (`AISSTREAM_COLLECT_MS`, raw env, optional), closes, merges by MMSI, prunes at 10 min. Failures are per-request and do not compound.
- **Fix:** confirm `AISSTREAM_API_KEY` exists in the Vercel production env (missing key = 500, not a silent disable); rotate at aisstream.io if rejected.

### 3.8 GDELT-DOC sticky 429 (news)

- GDELT-DOC rate-limits by IP and the block sticks for hours across the Vercel function pool. The news route treats GDELT-DOC and RSS as independent best-effort sources, so news continues RSS-only and health shows `news: degraded (cache-fallback-active)`. No action; it clears on its own. 502 only if both return nothing and there is no cache.

### 3.9 Upstash outage or quota exhausted

- **Symptom:** everything slower, `degraded:true` in responses, health mostly `unknown`, Upstash console at quota.
- The app keeps serving from per-instance memory and upstreams. Find the spender: `operator-status` `.rateLimiter`, 429/volume by path in logs (§1.4), bots ignoring `public/robots.txt`.
- **Fix:** tighten `rateLimiters.public` in `server/middleware/rateLimit.ts` and redeploy, or wait for the 00:00 UTC reset, or upgrade the Upstash plan. Verify `UPSTASH_REDIS_REST_URL/TOKEN` after any rotation.

### 3.10 Self-throttling (429 for a normal browser session)

- Tiers per IP per minute: flights 120, ships 60, events 20, news 20, markets 30, sources 30, weather / sites / water / geocode 10, global `public` 60 applied first. A valid `DASHBOARD_PASSWORD` Bearer skips **all** tiers. An empty `DASHBOARD_PASSWORD` disables the bypass (it does not fail closed here).
- Until 2026-09 every per-endpoint tier shared one Redis counter, so 12 flight polls/min tripped the 10/min tiers. Keys are now `ratelimit:prod:<tier>:<ip>`. If 429s reappear for ordinary use, check `.rateLimiter` in `operator-status`, and check for the client polling bug that multiplies poll loops after tab switches ([AUDIT-2026-09.md](./AUDIT-2026-09.md)).

### 3.11 CORS errors

- `CORS_ORIGIN` defaults to `*`. A wrong value is worse than none: preview URLs are dynamic. Leave it unset for Preview; for Production either unset or the exact origin. Verify: `curl -sI -H 'Origin: https://otg-iran-monitor.vercel.app' $BASE/api/health | grep -i access-control`.

### 3.12 Every route 500 right after a deploy (env fail-fast)

- `server/config.ts` parses env with Zod at module load. Missing `UPSTASH_REDIS_REST_URL/TOKEN`, a malformed number, or **`CACHE_KEY_PREFIX` set in production** throws and the function never starts. The ZodError names the variable in the function logs.
- `CACHE_KEY_PREFIX` must not exist in the Production env. It once held `dev: ` there; all prod writes went to a parallel namespace while readers looked at unprefixed keys, and enrichment "vanished" for a month. Caveat: the guard lives in `config.ts`; scripts importing `server/cache/redis.ts` directly bypass it — check your local `.env` before running any script against prod Redis.

### 3.13 Cron did not run

- Health row `missedRun: "missed"`, or Vercel → Cron Jobs shows failures. Check `vercel.json` `crons`, then run by hand: `curl -s -H "Authorization: Bearer $CRON" $BASE/api/cron/health | jq '.status'`. `health` and `refresh-events` return 401 without `CRON_SECRET` (when it is set); `warm` has no auth.
- Pro allows 40 crons. On Hobby, anything more frequent than daily fails the _deploy_, not the cron.
- Work started after the HTTP response is sent is killed by Fluid Compute unless wrapped in `safeWaitUntil`. Never trigger extraction from a read path; `/api/cron/refresh-events` is the only writer of `events:llm:v3`.

## 4. Operator actions

Scripts run as `npm run <name>`; they load `.env` then `.env.local` and talk to whatever Redis those point at.

| #    | Action                            | Command                                                                                                                                        | Notes                                                                                                                                                                                                                                                                              |
| ---- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1  | Force LLM extraction              | `curl -s -H "Authorization: Bearer $CRON" "$BASE/api/cron/refresh-events?force=true"`                                                          | **`CRON_SECRET` only** — `DASHBOARD_PASSWORD` gets 401. Skips the 15-min cooldown; does not skip the circuit breaker. Returns at dispatch; the run takes 2–13 min                                                                                                                  |
| 4.1b | Probe NIM models                  | `curl -s -H "Authorization: Bearer $CRON" "$BASE/api/cron/llm-probe?models=<id>,<id>" \| jq '.results'`                                        | One production-shaped batch per model (max 8, in parallel): status, latency, `schemaValid`. No `models` = the production model. Repeat an id to test concurrency. Writes nothing                                                                                                   |
| 4.2  | Replay one event group            | `curl -s -X POST -H "Authorization: Bearer $BEARER" $BASE/api/events/llm-replay/<groupKey>`                                                    | Re-extracts with the current prompt, returns `{old,new}`, never writes the cache. 50/day; logged to `operator:audit-log`. Group keys are positional and shift between runs                                                                                                         |
| 4.3  | Prune dead-URL events             | `curl -s -X POST -H "Authorization: Bearer $BEARER" $BASE/api/events/prune-dead-urls`                                                          | Removes events whose source URL is `404`, `403`, `dead-host` or `soft-404`. 50/day → 429 + `Retry-After`; 503 if Redis is down. The cron prunes automatically after each run but skips `403` (usually bot-blocking, not dead) and needs 3 failed probes; `unknown` is never pruned |
| 4.4  | Reconcile dead-URL counter        | `node --env-file-if-exists=.env --env-file-if-exists=.env.local --import tsx/esm scripts/reconcile-deadurl-count.ts` (add `--commit` to write) | For when the dashboard count disagrees with reality. The sidecar `events:url-liveness-count` has no TTL but the keys it counts expire. Also runs automatically on every sweep and prune. No npm alias                                                                              |
| 4.5  | Refresh snapshots                 | `npm run refresh:sites` · `npm run refresh:water`                                                                                              | Pulls Overpass from your machine, rewrites `src/data/*.json`; commit the result. Useful in dev only until the files are shipped to prod (§2). `npm run audit:water` reviews name quality                                                                                           |
| 4.6  | Resolver eval                     | `npm run eval:replay` · `npm run eval:detail`                                                                                                  | Geocoder-only (no LLM calls) over `server/data/eval/ground-truth-events.json` (50 events, 5/20/100 km). Writes the baseline key to your configured Redis. Also runs inside the health cron and every extraction. `POST /api/cron/eval` exists but is not scheduled                 |
| 4.7  | Model bake-off / OpenRouter probe | `npm run bakeoff:preflight` · `npm run bakeoff:full` · `npm run probe:openrouter`                                                              | Spends real NIM / OpenRouter quota (the probe uses ~15 % of the 200/day free cap). Probe writes `.snapshots/`. If `decision` is `restored-cascade`, remove the two `skipOpenRouter: true` flags in `server/lib/llmEventExtractor.v3.ts`                                            |
| 4.8  | Connectivity audit                | GitHub → Actions → _Prod Connectivity Audit_ → Run workflow                                                                                    | Manual only. Writes `audit:connectivity:last-result` (7 d TTL), shown by `/api/audit-status`. It treats `llmEvents` as non-critical by design                                                                                                                                      |
| 4.9  | Run forensics                     | `npm run analyze:llm-run` · `npm run snapshot:v3` · `npm run watch:snapshot` · `npm run audit:gdelt`                                           | Read-only against Redis; output to stdout or `.snapshots/`. There is no API that returns the `cron:watch:v2` ring; read it in Upstash or via `watch:snapshot`                                                                                                                      |
| 4.10 | Screenshots                       | `npm run capture:hero` · `npm run capture:layers`                                                                                              | Playwright + gifski against the local dev server; writes `public/screenshots/`                                                                                                                                                                                                     |

Broken or stale tooling: **`npm run check:env` crashes** (it reads `.shape` from a schema that became a `ZodEffects`); `npm run bakeoff` points at `scripts/bakeoff-v3-direct.ts` and `scripts/bakeoff-v3.ts` is an orphan; `scripts/record-v3-run.sh`, `extract-gate-b-snapshot.sh`, `sample-pruned-urls.ts`, `audit-events.ts`, `clear-llm-cache-dev.ts` have no npm alias and were one-off tools — read before running.

**Load test (`scripts/load-test.js`, k6):** `BASE_URL` defaults to **production**. Rules: read-only GET routes only; never include `?force=true`, `?backfill=true`, `?refresh=true`, `/api/cron/*`, `/llm-replay`, `/llm-history`, `/prune-dead-urls`; count 429 separately from failures (the script does); above ~100 VUs from one IP you are measuring the rate limiter; a Bearer bypasses the limiter entirely, so decide which one you are testing; watch the Upstash command budget during the run. Edge cache headers already exist, so most load should never reach the function.

## 5. Deploy checklist

**Conventions:** conventional commits; one feature branch per unit of work, never commit to `main`; merge to `main` = production deploy (Vercel Git integration); every push to another branch builds a Preview. Merge often — a branch that drifted 145 commits shipped as one unreviewable merge. Previews sit behind Vercel authentication, so crawler / OG-tag checks only work against production.

**Before merging:**

```bash
npm ci
npm run lint && npm run format:check && npm run typecheck && npm run knip
npx vitest run            # ~90 s, ~2.7k tests
npm run build             # vite + tsup -> api/vercel-entry.js, copies eval fixtures to api/_eval/. Does NOT typecheck
npm run openapi:lint      # if server/openapi.yaml changed
```

- Node `22.x` (`package.json` engines). Husky pre-commit runs lint-staged and gitleaks if installed.
- **After a gap of weeks, run `vercel build` locally first.** Stale lockfile, bundling and env drift have stacked up to five separate deploy blockers in a row before.
- `api/vercel-entry.js` is committed but Vercel rebuilds it; do not trust the committed copy.
- New data files read at runtime must be `import … with { type: 'json' }` or listed in `vercel.json` `includeFiles`. tsup inlines imports but does not copy files; a module-load `readFileSync` of a missing file is a cold-start crash.
- Never gate route _registration_ on `NODE_ENV`; gate in middleware, or the route is simply absent in prod.
- Changing what a cached value looks like → bump the key version (`water:facilities:v4`, `geocode:fwd:constrained:v2:`), or the old shape hides the fix for a full TTL. Writers must use the exported TTL constants (`LLM_TERMINAL_TTL_SEC`, `WATER_REDIS_TTL_SEC`), not literals.
- Env changes: Vercel → Settings → Environment Variables, Production scope, then redeploy (env is read at cold start). Confirm `CACHE_KEY_PREFIX` is absent and `V3_BAKEOFF_MODEL` is absent.
- Do not lower `maxDuration: 800` in `vercel.json`.

**After deploy:** §1.1 health one-liner; §1.2 route loop (all 200); load the site and confirm flights, ships, events render and the status dot is green or yellow; if the LLM path changed, force-trigger (§4.1) and watch it finish (§3.3); next morning confirm the 04:00 cron result with §1.4.

**Rollback:** Vercel → Deployments → previous production deployment → _Promote_ (or `vercel rollback`). Redis is not rolled back; if the bad deploy wrote a new-shape value, delete that key in Upstash and let it rebuild. Then `git revert` on `main` so the next deploy does not reintroduce it.

## 6. Routine maintenance

| Cadence                | Check                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Monthly                | §1.1 health and §1.4 cron recipe: did the last few nights dispatch and complete? `llm-history` has `completed` runs?           |
| Monthly                | `npm audit` and the CI `audit` job. Major bumps (maplibre-gl, deck.gl) need a manual map smoke test — WebGL is mocked in tests |
| Monthly                | Upstash daily command peak vs. the free-tier ceiling; Vercel usage and invoice (Pro, ~$20/mo, only for the 800 s limit)        |
| Monthly                | DLQ size and reasons (`llm-status` → `dlqRecent`); dead-URL count (`operator-status` → `prune`)                                |
| Quarterly              | NIM: key still valid, model id still in the catalog, one forced run completes. Free-tier catalogs rotate without notice        |
| Quarterly              | `npm run probe:openrouter` — is a fallback provider viable yet?                                                                |
| Quarterly              | Run the Prod Connectivity Audit workflow; re-enable CodeQL if GitHub paused it                                                 |
| Quarterly              | Outbound User-Agents still accepted: adsb.lol, Yahoo, Overpass, Nominatim (each adapter sets its own)                          |
| Quarterly              | `npm run refresh:sites` / `refresh:water`, review the diff, commit                                                             |
| After any long absence | All of the above, then the deploy checklist with `vercel build` before the first push                                          |

# ADR-0002: Vercel serverless over traditional hosting

**Status:** Accepted
**Date:** 2025-08-?? (Phase 14, Vercel Deployment)
**Deciders:** solo author

## Context

By Phase 14 the app had grown into a two-tier stack: a Vite-built React
SPA and an Express API. Hosting had to cover both tiers, handle cache
bursts when the UI re-loads on mobile, and stay within a personal
project budget. The upstream data sources (OpenSky, ADS-B Exchange,
GDELT v2, Overpass, Yahoo Finance, AISStream, Open-Meteo, Natural
Earth, GeoEPR, Nominatim) span the globe, so latency to end users
anywhere outside the hosting region was a concern — not a deal-breaker
for a personal tool, but annoying enough to care about.

Additional forces:

- **Ops surface:** I wasn't willing to manage an nginx config, TLS
  renewal, log rotation, or a reverse proxy. Every hour spent on ops
  is an hour not spent on the product.
- **Deploy friction:** I wanted `git push` to deploy. PR preview
  environments would be a bonus.
- **Cold start tolerance:** the frontend is read-heavy with
  browser-side polling. A 500-ms cold start on first paint is fine if
  warm paths are sub-100-ms.
- **Traffic shape:** zero to a handful of simultaneous users, with
  cron-driven background warming to keep the cache from going cold
  between bursts.

## Decision

Use [Vercel](https://vercel.com/) for both tiers:

- The Vite SPA is built via `npm run build` and served as static
  assets from the global Vercel Edge CDN.
- The Express API is wrapped in a thin serverless entry point
  (`server/vercel-entry.ts` → `createApp()` factory in `server/index.ts`) and
  deployed as a serverless function via `vercel.json` rewrites
  (`/api/*` → the function, everything else → SPA `index.html`).
- The build pipeline is `vite build` for the frontend plus `tsup` for
  the server bundle (CommonJS output at `dist-server/vercel.cjs`),
  with `tsc -b` providing typechecking as a separate step.

## Consequences

### Positive

- **Free tier covers the use case.** Hobby plan includes enough
  function invocations, bandwidth, and build minutes to host a
  single-user OSINT tool indefinitely. Upstash command budget is the
  real constraint, not Vercel compute.
- **Global edge CDN.** Static SPA assets are served from the nearest
  edge POP to the user, which matters more than I expected when
  demoing the tool from different locations.
- **PR preview deploys.** Every PR gets a unique preview URL
  automatically via the Vercel ↔ GitHub integration. No custom YAML.
  This alone made review-loop friction drop to near-zero.
- **Zero ops.** No TLS renewal, no nginx, no log rotation, no CDN
  invalidation rituals. `git push` ships.
- **Cron jobs included.** `vercel.json` supports a `crons` array that
  hits internal HTTP endpoints on a schedule. Used to warm the cache
  before it goes stale on low-traffic periods.

### Negative

- **10-second function timeout** (Hobby plan). Cold-start + upstream
  latency can exceed this for some routes when the cache is
  completely cold (e.g. `/api/water` fetches Overpass + WRI
  Aqueduct). Mitigated by (a) Vercel cron warming endpoints before
  users hit them, (b) serving stale cache on upstream failure rather
  than propagating the error, and (c) s-maxage CDN headers so most
  requests don't hit the function at all.
- **Upstash command budget is tied to traffic volume.** Every cache
  read/write is a command. Preview deploys share the same Upstash
  keyspace as production (unless you remember to override the env
  vars per environment), so an accidental PR-preview re-poll loop
  can burn budget.
- **CJS server bundle is awkward.** `tsup` emits CommonJS because
  Vercel's Node runtime expects it, but the rest of the server code
  is written as ES modules. The factory pattern
  (`createApp()` + separate `server/vercel-entry.ts` entry) keeps this
  ugliness contained to one file.
- **Function cold starts on low-traffic paths.** Routes that aren't
  hit frequently take 300-800 ms on first request after idle. Edge
  caching masks this for most users, but the first request after
  deploy is visibly slower. Acceptable for a personal tool; unshippable
  for a latency-sensitive commercial product.

### Neutral

- **Two deployment surfaces are kept in sync via a single Git
  push.** The SPA and the API share a repo and a `package.json`, so
  they can't drift — but they do share a deploy cycle, so a
  server-only fix still re-deploys the SPA. Fine at this scale.
- **Compression is gated by `VERCEL` env var.** Local dev gets
  gzip/brotli via the Express `compression` middleware for realistic
  testing; Vercel production skips it because the edge CDN handles
  compression. See `server/index.ts`.
- **Graceful SIGTERM handling is only wired in the `isMainModule`
  block.** Vercel has its own 500 ms teardown window and Upstash is
  REST-based (no connections to drain), so the SIGTERM handler is
  effectively dead code on Vercel — but it's still worth having for
  local dev and potential non-Vercel deploys.

## Alternatives Considered

- **Render** — rejected on cost. Render's hobby tier is less generous
  than Vercel's, and the always-on process model would mean paying
  for idle time on a tool that has near-zero traffic most of the day.
- **Fly.io** — rejected on regional latency for a single-region
  hobby deploy. Fly's multi-region deploys are slick but more
  complexity than a personal project needs, and single-region Fly is
  no cheaper than Vercel.
- **AWS Lambda + CloudFront + S3** — rejected on ops overhead. Each
  piece is individually cheap, but wiring them together (API Gateway,
  IAM, CloudFront OAI, S3 bucket policies, TLS via ACM) is a weekend
  of setup before the first `git push` ships anything. Vercel does
  this for free.
- **Self-hosted on a $5 VPS** — rejected on TLS/nginx/ops toil. Also
  loses global edge, PR previews, and cron jobs.
- **GitHub Pages + Cloudflare Workers API** — considered, but the
  Express + Node.js code and the `@deck.gl` / MapLibre tooling fit
  Vercel's Node runtime more naturally than Workers' V8 isolate
  environment.

## References

- [`server/vercel-entry.ts`](../../server/vercel-entry.ts) — serverless entry
  point that exports the Express app.
- [`server/index.ts`](../../server/index.ts) — `createApp()` factory
  shared by local dev and Vercel.
- [`vercel.json`](../../vercel.json) — rewrites and cron schedule.
- `docs/architecture/deployment.md` —
  Vercel topology diagram, build pipeline, and per-route cache header
  table.
- Phase 14 CONTEXT and SUMMARY
  (`.planning/phases/14-vercel-deployment/`).

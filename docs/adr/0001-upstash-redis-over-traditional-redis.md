# ADR-0001: Upstash Redis over traditional Redis

**Status:** Accepted
**Date:** 2025-08-?? (Phase 13, Serverless Cache Migration)
**Deciders:** solo author

## Context

Phase 13 migrated the app from a long-running Node process (where
`ioredis` with a persistent TCP connection is idiomatic) to Vercel
serverless functions, where every request runs in its own short-lived
execution context. Persistent Redis connections don't survive cold
starts — each function instance either has to re-open a TCP socket on
every invocation (slow, and ElastiCache/RedisLabs clients are
noticeably sensitive to connection churn) or rely on a connection pool
that serverless function lifecycles fight against.

Additional constraints:

- **Budget:** this is a single-developer personal project. A paid
  Redis tier from ElastiCache or RedisLabs would dominate the monthly
  cost of the whole stack.
- **Ops surface:** I wasn't willing to manage a VPC, IAM roles,
  security groups, or multi-region failover.
- **Use case:** the data cached is read-heavy, small per-entry (a few
  KB), and has logical TTLs between 60 seconds and 24 hours. There's no
  persistence requirement — if the cache goes away, the app degrades to
  upstream fetches. There's no pub/sub, no transactions, no Lua
  scripting.

## Decision

Use [Upstash Redis](https://upstash.com/) as the cache layer, accessed
exclusively via its REST API through the `@upstash/redis` client. The
entire cache module (`server/cache/redis.ts`) is built around the
async REST semantics — `await redis.get(...)`, `await redis.set(...)`
with explicit `ex` TTL — and makes no assumptions about connection
state.

## Consequences

### Positive

- **No connection management.** Every cache call is an isolated HTTPS
  fetch. Cold starts, warm starts, concurrent invocations — none of it
  matters to the client. There is no connection pool to tune, no
  max-clients ceiling to negotiate with a managed Redis tier.
- **Generous free tier.** The free plan covers ~500K commands/day,
  which is enough for a personal OSINT tool with modest traffic even
  across 8 polling endpoints.
- **Zero ops.** No VPC, no IAM, no network config. The entire "setup"
  is two env vars: `UPSTASH_REDIS_REST_URL` and
  `UPSTASH_REDIS_REST_TOKEN`.
- **Global replication included.** Upstash serves from the nearest
  edge by default; Vercel serverless functions running in `iad1` see
  single-digit-ms latency to the nearest Upstash replica.
- **REST surface plays nicely with chaos testing.** Phase 26.4 Plan 03
  chaos test (`server/__tests__/resilience/redis-death.test.ts`) mocks
  `@upstash/redis` at the module boundary to throw on every call — a
  direct TCP client would have been harder to intercept cleanly.

### Negative

- **Higher latency than TCP.** REST calls over HTTPS are meaningfully
  slower than a persistent TCP connection (roughly 10-80 ms vs 1-5 ms
  for a warm pool). For a read-heavy cache this is acceptable, but a
  write-heavy or latency-sensitive workload would suffer.
- **Command count is the real budget constraint.** Upstash bills by
  command, not by bytes or connections. This makes every `GET`, `SET`,
  and `ZADD` visible in the budget. As of Phase 25 the project was at
  ~92 % of the monthly ceiling, which forced retrofit work in
  subsequent phases: aggressive CDN caching (`s-maxage` on Vercel
  Edge), client-side severity/notification computation, on-demand
  AISStream connect-collect-close, and GDELT backfill cooldown gates.
  See the README "What I'd do differently" section — budget
  management is a day-1 design problem, not a deployment problem.
- **No Lua, no transactions.** Upstash supports a subset of Redis
  commands. Anything requiring server-side scripting would have to
  move client-side or be reimplemented. The project never needed
  this, but the ceiling is real.
- **Hung calls need an explicit timeout.** Phase 26.4 Plan 03 chaos
  testing revealed that on misconfigured credentials the `@upstash/redis`
  client retries internally and blocks indefinitely, which would
  freeze a Vercel lambda until its 60-second function timeout. Fixed
  by adding a 2000 ms `Promise.race` timeout wrapper
  (`REDIS_OP_TIMEOUT_MS`) inside `cacheGetSafe` / `cacheSetSafe`. See
  [`server/cache/redis.ts`](../../server/cache/redis.ts) lines 19-42.
  Any REST-based client that retries internally needs this kind of
  hard cap — not an Upstash-specific issue, but it showed up here
  first.

### Neutral

- **In-memory fallback sits on top.** `cacheGetSafe` / `cacheSetSafe`
  catch every Upstash failure (network, auth, timeout) and fall
  through to a process-local `Map<string, CacheEntry>`. This means
  the app survives total Upstash outage at the cost of per-request
  upstream fetches until the in-memory cache warms up. The degraded
  path is proven by the chaos test.
- **The decision is not reversible overnight but the module boundary
  is clean.** Every cache call in the project goes through
  `cacheGetSafe` / `cacheSetSafe` in `server/cache/redis.ts`. Swapping
  Upstash for Vercel KV (which has since become more competitive) or
  a different REST-based cache would be a contained refactor of that
  one file plus env var rename.

## Alternatives Considered

- **AWS ElastiCache / RedisLabs** — rejected because of cost and the
  VPC / connection-pool ops overhead. A persistent-connection Redis
  client in a serverless function is a known anti-pattern; the
  workarounds (RDS Proxy-style connection multiplexing for Redis)
  didn't exist cleanly at the time.
- **Vercel KV (Upstash under the hood in its early form)** — at the
  time of Phase 13, Vercel KV was either unavailable or strictly less
  generous than going direct to Upstash. The project still uses
  Upstash directly because the free tier remains better for
  non-Vercel-Pro accounts, and the direct API is thinner.
- **In-memory cache only** — rejected because Vercel serverless
  function instances are short-lived and isolated. Cold starts would
  wipe state, and concurrent instances wouldn't share cache, leading
  to upstream thundering herds on every deploy.
- **No cache at all, direct upstream every request** — rejected
  immediately. Several upstream APIs (OpenSky, ADS-B Exchange, Yahoo
  Finance unofficial) rate-limit aggressively enough that a single
  user reloading the page would exhaust their quota in minutes.

## References

- [`server/cache/redis.ts`](../../server/cache/redis.ts) — cache module
  with safe wrappers and the timeout helper.
- [`server/__tests__/resilience/redis-death.test.ts`](../../server/__tests__/resilience/redis-death.test.ts) —
  chaos test proving the degraded path.
- `docs/architecture/deployment.md` —
  cache tier in the Vercel topology diagram.
- `docs/degradation.md` — graceful degradation
  contract including the cache layer fallback.
- Phase 13 CONTEXT and SUMMARY (`.planning/phases/13-serverless-cache/`)
  for the original migration.
- Phase 26.4-03 SUMMARY (`.planning/phases/26.4-documentation-external-presentation/26.4-03-SUMMARY.md`)
  for the chaos-test-driven timeout fix.

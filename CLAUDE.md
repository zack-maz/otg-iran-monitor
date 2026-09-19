# Iran Monitor

Personal real-time intelligence dashboard for the Iran conflict: a 2.5D map (MapLibre + deck.gl) over live public data — flights, ships, conflict events, news, markets, infrastructure, water. Numbers over narratives.

- **Frontend** `src/` — Vite, React 19, Zustand, Tailwind v4.
- **Server** `server/` — one Express app (`createApp` in `server/index.ts`), bundled by tsup from `server/vercel-entry.ts` into a single Vercel function, `api/vercel-entry.js`.
- **Cache** — Upstash Redis over REST. **Deploy** — Vercel Pro, project `otg-iran-monitor`, https://otg-iran-monitor.vercel.app.

## Where to look

| Need                                                                     | Go to                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| How the system works, per-source gotchas, pipeline, deployment, frontend | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                        |
| Something is broken; operator actions; deploy checklist                  | [docs/OPERATIONS.md](docs/OPERATIONS.md)                            |
| Every Redis key, its writer, reader and TTL                              | [docs/redis-keys.md](docs/redis-keys.md)                            |
| Known defects, dead code, cleanup backlog (snapshot, 2026-09-17)         | [docs/AUDIT-2026-09.md](docs/AUDIT-2026-09.md)                      |
| Env vars                                                                 | [.env.example](.env.example) + the Zod schema in `server/config.ts` |
| API contract                                                             | `server/openapi.yaml` (`npm run openapi:lint`)                      |
| Why a decision was made                                                  | [docs/adr/](docs/adr/README.md)                                     |
| Roadmap and current phase                                                | `.planning/ROADMAP.md`, `.planning/STATE.md`                        |

Trust code over docs. If a doc is wrong, fix it in the same change.

## Commands

```bash
npm run dev            # vite + server (node --watch does NOT reload .env; restart it)
npx vitest run         # all tests; `npx vitest run server/` for server only
npm run typecheck      # tsc -b + type-coverage. `npm run build` does NOT typecheck.
npm run lint
npm run build          # vite build + tsup bundle + copy eval fixtures to api/_eval/
npm run docs:lint      # markdown link check
```

## Conventions

- **TypeScript** strict; pinned `~5.9.3` (avoid TS 6 breaking changes). Node `22.x`.
- **Zustand** — curried `create<T>()()`; select with `s => s.field`.
- **Tailwind v4** — CSS-first `@theme` in `src/styles/app.css`; no `tailwind.config.js`. Z-index scale is CSS custom properties.
- **Colors** — entity/event/site/faction/ethnic colors are hex CSS vars in the `@theme` block, read once by `src/lib/colorBridge.ts` into RGB tuples for deck.gl. Hex, not OKLCH, so the bridge can parse them. `colorBridge.ts` carries fallback literals that must match `app.css` by hand — nothing enforces it.
- **Polling** — recursive `setTimeout`, never `setInterval`; pause when the tab is hidden, fetch immediately when visible. Flights are cleared (not shown stale) after 60 s.
- **Tests** — Vitest; jsdom for `src/`, `// @vitest-environment node` for server. `maplibre-gl` and `@deck.gl/mapbox` are mocked through `test.alias` in `vite.config.ts` (mocks in `src/test/__mocks__/`).
- **Commits** — conventional commits. **Branches** — never commit to `main`; one branch per phase or change. Pushing `main` deploys to production.
- **Comments and docs** — describe the rule and the reason. No phase/plan/decision tags (`Phase 27.4`, `D-13`); the history they point to is archived.

## Invariants — do not break these

1. **`/api/events` never triggers LLM extraction.** The refresh-events cron (`runRefreshExtraction` in `server/lib/llmExtractionPipeline.ts`) is the only writer of `events:llm:v3`. On Vercel the function is frozen once the response is sent; read-path fire-and-forget work silently never finishes.
2. **The LLM is optional.** With no key, or a cold cache, `/api/events` serves raw GDELT from `events:gdelt`. The map never goes blank. Health treats `llmEvents` as non-critical.
3. **A Redis failure never produces a 500.** Use `cacheGetSafe` / `cacheSetSafe` (`server/cache/redis.ts`); they time out at 2 s and fall back to memory. The rate limiter degrades open.
4. **TTL is per call, not per key.** Writers of a shared key import the shared TTL constant (`LLM_TERMINAL_TTL_SEC`, `WATER_REDIS_TTL_SEC`, `EVENTS_REDIS_TTL_SEC`). A literal silently shortens the cache.
5. **Bump the key version** (`sites:v3`, `water:facilities:v4`) when a change alters the stored shape or filtering. Register every new key in `docs/redis-keys.md` — a test enforces it.
6. **No module-init file reads on the server.** tsup inlines JSON _imports_ but does not copy data files; a top-level `readFileSync` of a relative path crashes the cold start in production. Import the JSON, or guard a lazy read with `existsSync`. Files that must ship go through the build `cp` step + `includeFiles` in `vercel.json`.
7. **Never wrap route registration in a `NODE_ENV` check.** Gate in middleware; a conditionally registered route is simply absent in prod.
8. **Every outbound `fetch` sets `User-Agent: OUTBOUND_USER_AGENT`** (`server/config.ts`) and a timeout. Node's default UA is blocked by some upstreams — that took flights down in 2026-09.
9. **`CACHE_KEY_PREFIX` stays unset in production.** Set, it splits writers from readers.
10. **Domain constants** (`IRAN_BBOX`, `IRAN_CENTER`, `WAR_START`, `ADSB_RADIUS_NM`) live in `src/lib/domain.ts` with a mirror in `server/config.ts`; `src/__tests__/domain.test.ts` fails if they differ. They are not env-tunable.
11. **GDELT quirks are deliberate:** the master list is fetched over plain HTTP (their TLS is unreliable), files are ZIPs (`adm-zip`), country codes are FIPS 10-4 not ISO (IZ = Iraq, IS = Israel, TU = Turkey), dates parse with `Date.UTC`.
12. **Water admission gate** — do not loosen `hasName` / `hasLatinLabel` to recover "missing" facilities; that reintroduces junk labels.

## Map patterns

- `DeckGLOverlay` wraps `MapboxOverlay` via the `useControl` hook from `@vis.gl/react-maplibre`.
- Style edits are imperative in `onLoad`, behind `getLayer()` guards. Never pre-fetch and modify the CARTO `style.json`.
- Terrain uses AWS Terrarium tiles (`tiles` array + `encoding`); MapLibre's demo terrain only covers the Alps.
- Overlay `div`s must come after `<Map>` in DOM order — the map canvas creates its own stacking context.
- deck.gl v9: `parameters: { depthCompare: 'always', depthWriteEnabled: false }` keeps icons above 3D terrain.
- `CompassControl` renders null; it is behavior only.

## Key files

| File                                                     | Role                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/components/layout/AppShell.tsx`                     | Root layout; mounts every polling/fetch hook                               |
| `src/components/map/BaseMap.tsx`                         | Map, terrain, all overlays                                                 |
| `src/hooks/useEntityLayers.ts`                           | deck.gl layers for flights, ships, events, sites                           |
| `src/hooks/useFilteredEntities.ts`                       | Applies filters + client-side event dispersion                             |
| `src/stores/filterStore.ts`, `src/hooks/useQuerySync.ts` | Filter state and its two-way sync with the search query                    |
| `src/components/ui/DevApiStatus.tsx`                     | Password-gated operator console (large; shipped to every visitor today)    |
| `src/lib/colorBridge.ts`, `src/styles/app.css`           | Color tokens                                                               |
| `server/index.ts`                                        | `createApp`: middleware order, route mounts, cache headers                 |
| `server/config.ts`                                       | Zod env schema (`parseEnv` throws at startup), domain constants, TTLs      |
| `server/cache/redis.ts`                                  | `cacheGetSafe` / `cacheSetSafe`, `CacheEntry<T> = { data, fetchedAt }`     |
| `server/middleware/rateLimit.ts`                         | `@upstash/ratelimit` tiers, one Redis prefix per tier                      |
| `server/routes/events.ts`                                | `/api/events` + LLM status/history/replay/prune endpoints                  |
| `server/lib/rawEventsRefresh.ts`                         | GDELT fetch → merge → backfill → `events:gdelt` (shared by route and cron) |
| `server/lib/llmExtractionPipeline.ts`                    | Cron entry: dispatch decision, then waves of extract → geocode → persist   |
| `server/lib/llmEventExtractor.v3.ts`                     | Prompting, batching, validation                                            |
| `server/lib/freeClaudeRouter.ts`                         | `callLLM`: NVIDIA NIM client, production model id, retry, rate window      |
| `server/routes/llm-probe-cron.ts`                        | `/api/cron/llm-probe`: try candidate NIM models with the production key    |
| `server/lib/llmResolver.ts`                              | Location hierarchy → coordinates, always with provenance                   |
| `server/adapters/*`                                      | One file per upstream                                                      |
| `vercel.json`                                            | 3 daily crons, rewrites, `maxDuration: 800`                                |

## Data model

- `MapEntity` — discriminated union: shared `id`, `type`, `lat`, `lng`, `timestamp`, `label` + nested `data`. Types live in `server/types.ts`; `src/` imports them.
- Entity types: `flight`, `ship`, five conflict event types (`airstrike`, `on_ground`, `explosion`, `targeted`, `other`). `site` and water facilities are separate from the union.
- Event location precision: `exact | neighborhood | city | region`, drawn as radius rings.
- API responses are `{ data, stale, lastFresh }`.

## State of the project (2026-09-19)

Milestone v2.0 "Final Hardening": phases 42–46 done; 47 (load test) and 48 (load remediation) not started. Production was unattended from 2026-06-22 to the September audit ([docs/AUDIT-2026-09.md](docs/AUDIT-2026-09.md)), which found flights down and the LLM pipeline producing nothing. The pipeline's causes were stacked: the cron depended on a browser visit (L1), NVIDIA retired the model on 2026-07-27 (L8), and the run could neither survive throttling nor finish inside 800 s (L3–L6). All are fixed as of 2026-09-19; the model is `google/gemma-4-31b-it`. Still open: L2 — health stays green when the cron declines or fails, so check `llm-history` or the logs, not the health row.

**NIM will retire this model too.** The symptom is every batch failing within seconds and a run that ends `error` with `HTTP 410`. The playbook is docs/OPERATIONS.md §3.3 step 4; pick the replacement with `/api/cron/llm-probe`, never from NIM's catalog.

**Production secrets are write-only.** Every Production env var is Sensitive in Vercel: `vercel env pull` yields empty strings and nothing can be read back. Anything that needs the real NIM key or Redis has to run in production (hence the probe route) — or rotate the secret.

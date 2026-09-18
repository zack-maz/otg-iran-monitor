# Iran Monitor

> **Real-time Iran conflict intelligence dashboard. Numbers over narratives.**

![Hero](public/screenshots/hero.gif)

A personal open-source-intelligence tool that puts ten public data feeds on one 2.5D map of the Greater Middle East: flights, ships, conflict events, infrastructure, news, oil markets, weather, water stress, political alignment and ethnic distribution. Built to answer one question: _what is actually happening around the Strait of Hormuz right now, quantitatively?_

**Live:** [otg-iran-monitor.vercel.app](https://otg-iran-monitor.vercel.app)

> Please be gentle. This runs on free-tier upstreams and a single-user Redis budget. `/api/*` is rate-limited per IP and disallowed in `robots.txt`.

[![CI](https://github.com/zack-maz/otg-iran-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/zack-maz/otg-iran-monitor/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![Node](https://img.shields.io/badge/node-22.x-green)
[![API Spec](https://img.shields.io/badge/API-OpenAPI%203.0-orange)](server/openapi.yaml)

## Documentation

| Doc                                            | What it covers                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)   | How it works: data sources, caching, the event pipeline, deployment, frontend |
| [docs/OPERATIONS.md](docs/OPERATIONS.md)       | Diagnosing failures, operator actions, deploying                              |
| [docs/redis-keys.md](docs/redis-keys.md)       | Every Redis key, its writer, reader and TTL                                   |
| [docs/AUDIT-2026-09.md](docs/AUDIT-2026-09.md) | Known defects and cleanup backlog as of September 2026                        |
| [docs/adr/](docs/adr/README.md)                | Architecture decision records                                                 |
| [CLAUDE.md](CLAUDE.md)                         | Conventions and invariants for coding agents (and humans)                     |
| [CHANGELOG.md](CHANGELOG.md)                   | Release history                                                               |
| [docs/portfolio/](docs/portfolio/)             | Essays: how this was built with Claude Code, the product journey, lessons     |

## Features

- **Live tracking** — flights (adsb.lol; OpenSky optional), ships (AISStream), conflict events (GDELT v2, optionally enriched by an LLM for type, location precision, actors and casualties).
- **Key sites** — nuclear, naval, oil, airbase and port facilities from OpenStreetMap, cross-referenced against nearby conflict events for an attacked/healthy status.
- **News** — GDELT DOC 2.0 plus six RSS feeds (BBC, Al Jazeera, Tehran Times, Times of Israel, Middle East Eye, Bellingcat), deduplicated and clustered.
- **Notifications** — severity-scored alerts; proximity warnings when flights or ships approach key sites.
- **Oil markets** — Brent, WTI, XLE, USO, XOM with sparklines.
- **Visualization layers** — geographic relief and contours, weather (temperature + wind), threat density (custom GLSL radial-gradient heatmap over clustered events), political alignment, ethnic distribution (hatched overlaps), water stress (WRI Aqueduct + precipitation anomaly at named facilities).
- **Search** — Cmd+K query language with ~25 tag prefixes (`type:`, `near:`, `country:`, `callsign:`, `severity:` …), synced both ways with the sidebar filters.
- **Detail panels** — per-entity data in dual units, lost-contact state, back-navigation stack.

| Threat density                             | Political                                   | Ethnic                                   | Water stress                             |
| ------------------------------------------ | ------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| ![](public/screenshots/threat-density.png) | ![](public/screenshots/political-layer.png) | ![](public/screenshots/ethnic-layer.png) | ![](public/screenshots/water-stress.png) |

## Quick start

Requires **Node 22.x**. `gitleaks` is recommended for the pre-commit secret scan (`brew install gitleaks`).

```bash
git clone https://github.com/zack-maz/otg-iran-monitor.git
cd otg-iran-monitor
npm install
cp .env.example .env.local     # every variable is optional for local dev
npm run dev                    # frontend :5173, API :3001 (Vite proxies /api)
```

Without Upstash credentials the server falls back to an in-memory cache. Without an LLM key, events are served as raw GDELT. [.env.example](.env.example) is the environment reference.

```bash
npx vitest run         # all tests   (npx vitest run server/  |  src/)
npm run typecheck      # tsc -b + type-coverage floor
npm run lint
npm run build          # vite build + server bundle for Vercel
```

## Stack

React 19 · Vite · TypeScript (strict) · Zustand · Tailwind v4 · MapLibre GL + deck.gl · Express 5 on a single Vercel function · Upstash Redis (REST) · Zod · Pino · Vitest.

## Data sources and cost

| Source                                 | Data                                                          | Client poll                   | Auth          |
| -------------------------------------- | ------------------------------------------------------------- | ----------------------------- | ------------- |
| adsb.lol (default), OpenSky (optional) | Flights (ADS-B)                                               | 5 s                           | none / OAuth2 |
| AISStream                              | Ships (AIS over WebSocket, connect-collect-close per request) | 30 s                          | API key       |
| GDELT v2 events export                 | Conflict events (CAMEO)                                       | 15 min                        | none          |
| GDELT DOC 2.0 + 6 RSS feeds            | News                                                          | 15 min                        | none          |
| Overpass / OpenStreetMap               | Key sites, water facilities                                   | once per session (24 h cache) | none          |
| WRI Aqueduct 4.0, Open-Meteo           | Water stress baseline, precipitation anomaly                  | 6 h                           | none          |
| Yahoo Finance (unofficial)             | Oil markets                                                   | 5 min                         | none          |
| Open-Meteo                             | Weather grid                                                  | 30 min                        | none          |
| Nominatim                              | Geocoding (1 req/s, cached 30 d)                              | on demand                     | none          |
| NVIDIA NIM (free tier)                 | LLM event enrichment, daily cron                              | —                             | API key       |
| Natural Earth, GeoEPR 2021             | Political and ethnic polygons                                 | static                        | bundled       |

The only recurring cost is **Vercel Pro at $20/month**, needed for the 800-second function limit that the daily LLM extraction run uses. Every data feed and the Redis cache are on free tiers.

## Lessons

Short version of [docs/portfolio/LESSONS.md](docs/portfolio/LESSONS.md):

1. **Measure before reconciling code and docs.** When they disagree, write a throwaway probe and let the measurement decide.
2. **Close unshipped work with a named status** instead of leaving it "in progress".
3. **Mechanical drift gates beat reviewer vigilance** — but only gates that test behavior. A gate that compares a value to itself, or counts comments as references, is theater.
4. **Delete rather than deprecate** when rollback is `git revert`.
5. **When the architecture changes, change the health checks in the same change.** Health that measures "the scheduler ticked" rather than "the product has data" stayed green through months of a silently empty pipeline.
6. **GDELT needs filtering at several levels at once** — no single downstream filter rescues the raw signal ([ADR-0005](docs/adr/0005-phase-26-2-nlp-approach-scrapped.md)).

## License

Private — personal project. Source code is provided as a portfolio work sample. All third-party data sources are used under their respective public terms of service.

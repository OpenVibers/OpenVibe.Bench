# OpenVibe.Bench

The shared AI benchmark and comparison engine for every OpenVibe room (plan 2026-10-28 §4.12).

**Live site:** https://bench.openvibe.services · **API docs:** https://openvibe.services · **For AI:** https://bench.openvibe.services/llms.txt
**Run it:** `npm ci && npm run dev` (Node 22 or newer) · **Tests:** `npm test`

Bench is the comparative-evaluation authority. AI stays the run authority, Report the analytics authority, Route the learner, and each room keeps its own pages. Bench owns kinds, tasks, pinned rounds, entries, judgements, ratings, boards, the open dataset and private evals.

**The public pages live on OpenVibe.Compare (11-13; Report's AI section held them from 11-08 and forwards there):** `https://openvibe.compare/ai`, `/ai/<benchmark>` and `/ai/models/<model>`. This origin's old HTML pages answer `301` there; its API, MCP endpoint, render origin, badges and embeds stay here. The owner's pages stay here too: `/benchmarks/mine` (the default audience, "apply to all", and each benchmark's Share button), `/benchmarks/new`, an unlisted share link (`/b/<token>`), and the noindex task and run pages. A benchmark's own page redirects only when it is public and the viewer is not its owner: a private benchmark, a named reader and an unlisted link have no Report page.

- Service id: `bench`
- Port: `5230`
- Public origin: `https://bench.openvibe.services`
- Database: `ov_bench`
- Cookies: `bench_at`, `bench_rt`, `bench_oauth`

## Run

```
npm install
npm start
```

Without `DATABASE_URL` the service runs an embedded PGlite database in `data/pglite` (development only). Production uses PostgreSQL with `DATABASE_DIRECT_URL` for migrations.

## Test

```
OV_ALLOW_SUITE=1 npm test
```

Tests use a temporary PGlite database, an in-process mock Network and a fake AI; none needs the network or a paid API.

## API

JSON under `/api/v1`; errors are `application/problem+json`. The full list is in `/openapi.json` and Report's `/ai/method`. The MCP endpoint is `POST /mcp`.

The public reads Report's AI pages use are `GET /api/v1/overview`, `GET /api/v1/benchmarks`, `GET /api/v1/rankings`, `GET /api/v1/runs`, `GET /api/v1/models/:model/summary` and `GET /api/v1/runs/:id`; the long list is at `/openapi.json` and in Report's method page.

<!-- versions:start -->
- openvibe-contracts: v0.422.0
- openvibe-sdk: v0.166.0
- openvibe-shared: v4.245.0
<!-- versions:end -->

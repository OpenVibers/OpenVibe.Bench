# OpenVibe.Bench

The shared AI benchmark and comparison engine for every OpenVibe room (plan 2026-10-28 §4.12).

Bench is the comparative-evaluation authority. AI stays the run authority, Report the analytics authority, Route the learner, and each room keeps its own pages. Bench owns kinds, tasks, pinned rounds, entries, judgements, ratings, boards, the open dataset and private evals.

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

JSON under `/api/v1`; errors are `application/problem+json`. See `/docs` for the full list. The MCP endpoint is `POST /mcp`.

<!-- versions:start -->
- openvibe-contracts: v0.238.0
- openvibe-sdk: v0.70.0
- openvibe-shared: v4.45.0
<!-- versions:end -->

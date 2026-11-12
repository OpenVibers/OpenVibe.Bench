# AGENTS.md — OpenVibe.Bench

## Project overview

The shared AI benchmark and comparison engine for every OpenVibe room: kinds, tasks, pinned
benchmark versions, entries, judgements, the Bradley–Terry ratings, boards, the open dataset and
private evals. Node.js/Express, PostgreSQL (`ov_bench`), CommonJS, **no build step**.

- Service id `bench`, port `5230`, origin `https://bench.openvibe.services`; the render origin
  `https://bench-render.openvibe.services` serves the same app; unit `openvibe-bench.service`.
- Division of authority: **AI** runs models, **Bench** judges and rates, **Report** owns the public AI
  analytics pages, **Route** learns from the results, and each room keeps its own pages.
- Public pages moved to OpenVibe.Report on 2026-11-08: `https://openvibe.report/ai`,
  `/ai/<benchmark>`, `/ai/models/<model>`. This origin's old public HTML answers `301` there; its API,
  MCP endpoint, render origin, badges, embeds and **owner** pages stay here.

## What it owns

- Benchmark kinds, tasks, a benchmark's drafts and **frozen versions** (`bench.benchmark@1`), entries
  and judged rounds; private by default, an owner-only prompt set, a share link and an audience.
- Votes and judgements, including anonymous votes, daily rounds, battles and the pick flow.
- Ratings: `GET /api/v1/boards/:kindId`, `GET /api/v1/datasets/:kindId.jsonl`,
  `GET /api/v1/ratings/:kindId` (the shared public read other sites consume).
- The registry API (`/api/v1/benchmarks…`), showcase, gallery, badges, embeds, watches, imports and
  variant evidence.
- `POST /mcp`, `/openapi.json`, `/llms.txt`, the AI section data Report reads.
- Owner-only pages: `/benchmarks/mine` (default audience, "apply to all", Share), `/benchmarks/new`,
  `/b/<token>` unlisted links, and the noindex task/run pages.

Not owned: model execution (AI), the site's analytics presentation (Report), the learning loop
(Route), each room's product pages.

## Who calls it, and whom it calls

- Callers: OpenVibe.Report (public AI pages and `/ai/method`), Live and other rooms (boards/ratings,
  badges, embeds), AI (`bench.rating.changed`, `GET /api/v1/boards/:kind?type=elo|cost` for routed
  evidence), and people/agents through the API and MCP.
- Depends on: Network (JWKS, user/service tokens, SSO with PKCE in `server/auth/sso.js`); AI
  (`server/bench/ai.js` runs benchmark tasks); Events (outbox publisher, `bench.rating.changed`);
  PostgreSQL through `openvibe-sdk/db`; Valkey optional through `openvibe-sdk/valkey`.

## Repository map

- **Entry:** [server/index.js](server/index.js) — `createApp()`, graceful shutdown of keys, jobs,
  daily rounds, EEE sync, fidelity job, publisher, telemetry.
- **App:** [server/app.js](server/app.js) — helmet/CSP, cookies, rate limits, `/auth`, `/internal/events`,
  `/shared`, `/api/v1` (api, registry, variant evidence, showcase, arena, gallery), `/api`, `/render`,
  `/vendor`, pages, `/mcp`, `/badge`, `/embed`.
- **Config:** [server/config.js](server/config.js), [server/variant-evidence-config.js](server/variant-evidence-config.js).
- **Database:** [server/db.js](server/db.js); migrations `0001…0017` in [migrations/](migrations/).
- **Store/domain:** [server/store.js](server/store.js), [server/bench/](server/bench/) (battles, anon,
  daily, registry, launch, seed), [server/rating/](server/rating/) (statistics, boards, style).
- **HTTP:** [server/http/](server/http/) — `api.js`, `router.js`, `registry.js`, `ratings.js`,
  `pages.js`, `badge.js`, `embed.js`, `watch.js`, `pick.js`, `arena.js`, `gallery.js`, `render.js`.
- **Auth:** [server/auth/keys.js](server/auth/keys.js), [server/auth/sso.js](server/auth/sso.js),
  [server/http/principal.js](server/http/principal.js).
- **Frontend:** [public/js/bench.js](public/js/bench.js), [public/css/bench.css](public/css/bench.css);
  server-rendered pages in [server/render/](server/render/).
- **MCP:** [server/mcp.js](server/mcp.js).

## Commands

```bash
npm ci
npm run dev                # NODE_ENV=development node server/index.js
npm start                  # node server/index.js, http://127.0.0.1:5230
OV_ALLOW_SUITE=1 npm test  # the suite refuses to run without the guard in some environments
npm run test:pg            # same suite on PostgreSQL (BENCH_TEST_STORE=pg)
npm test -- api            # only files whose name contains the word
ov test                    # the harness's sharded run of what the change reaches
node --check <file.js>
```

Tests use a temporary PGlite database, an in-process mock Network and a fake AI; nothing needs the
network or a paid key.

## Database and migrations

PostgreSQL database `ov_bench` (host data role, ADR-035); development and tests use PGlite. Every
read/write is async through `openvibe-sdk/db`. Schema is `migrations/NNNN_*.sql`, applied at boot;
never edit a migration that has run, and add a new number. A **benchmark version is frozen**: the
document and its SHA-256 hash are immutable and addressable as `<benchmark>@<version>`; drafts are
separate. Do not "fix" a frozen version in place.

## Auth

A person is the `bench_at` session cookie (with `bench_rt`, `bench_oauth`) or a Network user token as
`Bearer`; a service sends a client-credentials token with the `bench.*` capability. A **session write
must come from `bench.openvibe.services` itself** (same-origin). Capability ids come from the pinned
`openvibe-contracts`; an unknown id is refused. Anonymous browser reads are allowed only on the
public rating/board/embed paths, which return no prompts, answers, voters or site identifiers.

## Frontend loading model

Server-rendered HTML (no SPA framework, no bundler, no transpiler) plus one page script,
[public/js/bench.js](public/js/bench.js); `/shared/*` comes from the pinned `openvibe-shared` tarball
through its serve handler. CSP and cache policy are in [server/app.js](server/app.js) and
`openvibe-shared/cache-policy`. The `bench-render.` vhost exists for rendering/embeds; it is the same
process, not a second app.

## Deploy

Unit [deploy/systemd/openvibe-bench.service](deploy/systemd/openvibe-bench.service) runs
`/opt/openvibe.bench/server/index.js` on `127.0.0.1:5230`, env `/etc/openvibe/bench.env`; two vhosts,
[deploy/nginx/bench.openvibe.services.conf](deploy/nginx/bench.openvibe.services.conf) and
[deploy/nginx/bench-render.openvibe.services.conf](deploy/nginx/bench-render.openvibe.services.conf).
The repository does not record an `ovhost deploy` command; keep the unit and vhost in sync with
`deploy/`. Migrations run at boot; no secret in a file or a log.

## Ratings rules (the part people rely on)

- Every board is a Bradley–Terry fit over votes, centred on 1000, with a bootstrap giving each model
  a rating interval and a 95% rank interval ([docs/index.md](docs/index.md)).
- `GET /api/v1/ratings/:kindId?category=all` omits models with fewer than 20 eligible games,
  including their counts; clients must **not average** ratings from different kinds or sources
  ([docs/shared-ratings.md](docs/shared-ratings.md)).
- The dataset (`/api/v1/datasets/:kindId.jsonl`) carries the same numbers as the board.
- No prompts, answers, voters or site identifiers leave through the public read.

## Tests

`npm test` runs `test/run.js`, each `test/*.test.js` in its own process with a 90 s timeout through
`openvibe-shared/test-runner`; failure of any file fails the run. The suite pins the registry/frozen
versions and hashes, daily rounds, anonymous votes, boards, the dataset and JSON-LD, Report-move
redirects, MCP, OpenAPI, badges, embeds, privacy and the contracts pin. `ov test` runs the same.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; factories (`createApp`, `createApi`,
  `createStore`) and injectable clock/fetch/log so tests need no network.
- Errors are `application/problem+json` with a stable `code`; never leak SQL or upstream text.
- Contracts and enums come from `openvibe-contracts`; bump the pin before using a new id.
- Keep the API backward-compatible: Report, AI, Live and rooms read these endpoints.

## Pitfalls

- **Frozen means frozen.** A benchmark version is immutable and hashed; editing it breaks every run
  and judgement that names it.
- **The public pages are Report's.** Only owner, unlisted and private pages belong on this origin;
  redirect the rest instead of re-growing HTML.
- **Same-origin writes.** A session write from another origin is refused; do not relax it for embeds.
- **Minimum 20 games** and exact identity: a small or fuzzy sample is omitted, never shown as a weak
  rating.
- **Private benchmarks stay private.** Prompts are owner-only; a share link is the only door.
- **`OV_ALLOW_SUITE=1`** is required by the suite harness in this environment; a plain `npm test` may
  refuse, which is not a test failure to "fix" by disabling the guard.
- **`bench-render.` is the same service.** A change there is a change here.

## Documentation

- [README.md](README.md) — what works and the API summary.
- [docs/index.md](docs/index.md) — the rating method and intervals.
- [docs/api.md](docs/api.md) — the API, auth and the frozen/unlisted distinction.
- [docs/benchmarks.md](docs/benchmarks.md) — writing and versioning a benchmark.
- [docs/shared-ratings.md](docs/shared-ratings.md) — the public rating read other sites consume.

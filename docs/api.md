# The Bench API

JSON under `/api/v1`. Errors are `application/problem+json` with a stable `code`. A person is the `bench_at`
session cookie or a Network user token as a Bearer; a service sends a client-credentials token with `bench.*`
capabilities. A session write must come from bench.openvibe.services itself.

## The registry (stage B1)

| Route | Who | What |
|---|---|---|
| `POST /api/v1/benchmarks` | a person, or `bench.benchmark.write` | Create a benchmark (a draft). |
| `PUT /api/v1/benchmarks/:id` | the same | Save a new draft. A body with `version` edits that version, and is refused once a run names it. |
| `POST /api/v1/benchmarks/:id/versions` | the same | Freeze the working copy into the next immutable version. |
| `POST /api/v1/benchmarks/:id/fork` | the same | Fork a benchmark; the fork records its parent. |
| `POST /api/v1/benchmarks/:id/share` | its owner | `{ visibility: "private" | "unlisted" | "public" }`. `unlisted` returns a new share token once; the old link stops. |
| `GET /api/v1/benchmarks?kind=&tag=&q=&mine=1` | anyone | The registry; `mine=1` adds the caller's own unlisted and private benchmarks. |
| `GET /api/v1/benchmarks/:id[@version]` | anyone who may read it | One benchmark and its definition. A private benchmark is a 404 except to its owner and the executor; a shared unlisted one needs its link. Holdout tasks are withheld unless the caller holds `bench.run.publish` or owns the benchmark. |

The documents are the published contracts, from `openvibe-contracts`: `bench.benchmark@1` for a benchmark
version, `bench.run@1` for a run. Every contract document is checked against them before it is stored. `private`
is Bench's own stricter form of unlisted: the contract document is frozen as `unlisted`, and the benchmark row's
visibility is what every access check reads.

### Your own prompts

`POST /benchmarks/new` on the site (or the API above) makes a benchmark from 5 to 50 pasted prompts: one per line,
or CSV with an optional expected answer. The default kind is `text.answer`; any existing kind may be chosen. It is
private by default, exports and deletes with the account, and its runs go through the existing openvibe.codes launcher
(the same estimate and confirmation).

The open data: `GET /api/v1/datasets/benchmarks.jsonl` carries every public benchmark, its visible tasks and every
run under it, with no person id. Nothing private or unlisted is ever read there.

## The results

| Route | Who | What |
|---|---|---|
| `POST /api/v1/runs` | a person, or `bench.run.publish` | Publish a run. A service token with `bench.run.publish` makes a **verified** run; a person's token makes a **submitted** one, badged and out of the default rankings. |
| `GET /api/v1/runs/:id` | anyone | One run with its per-task results. `run.document` is the published `bench.run@1` document. |
| `GET /api/v1/compare?runs=a,b,c` | anyone | Up to four runs side by side, per task. |
| `GET /api/v1/rankings?benchmark=&metric=score\|value\|speed\|consistency&harness=&since=` | anyone | The rankings for a benchmark. Verified runs only, unless `include_submitted=true`. |
| `GET /api/v1/percentile?benchmark=&model=&score=` | anyone | Where a score sits among that model's runs. |

## Voting without signing in

A person who has not signed in may still judge a pairwise round (`human_pairwise` kinds only). There are two ways in,
and both are capped.

**On Bench's own pages.** `/showcase/round/:id` (and `POST /api/v1/showcase/rounds/:id/vote`) hands the visitor a
random opaque id in a signed, httpOnly cookie (`bench_anon`). The id says nothing about the visitor, and the cookie
is signed with a server secret, so a client cannot mint a new voter id at will. Bench never stores the address: the
per-address cap counts a hash of it, salted per day, so two days of addresses cannot be linked.

**Relayed by a first-party service.** A service that may relay sends its own service token (with
`bench.judgement.cast`) and the header `X-OV-Voter: anon:<opaque id it derived from its own cookie>`. Only a service
on the allow-list may relay: `BENCH_ANON_RELAY_SERVICES` (default `design`). The relay's own daily total is capped
apart from the per-voter cap.

| Route | Who | What |
|---|---|---|
| `GET /api/v1/judgements/next?kind=` | a person, an anonymous voter (cookie), or a relaying service (`X-OV-Voter`) | The next ready round of that kind the caller has not judged and did not start, blind. A signed-in person keeps the old answer (`200` with `pair: null` when there is nothing); an anonymous voter gets `204` when there is nothing to judge. |
| `POST /api/v1/rounds/:id/judgements` | a person, a service with `bench.judgement.cast`, or a relaying service with `X-OV-Voter` | The vote. A relayed vote is a `human_pairwise` vote of the anonymous voter the header names. |
| `POST /api/v1/showcase/rounds/:id/vote` | a person, or an anonymous voter (the cookie) | The vote from Bench's own page. |
| `GET /api/v1/boards/:kindId?voters=people\|anon` | anyone | The board of the signed-in votes alone, or of the anonymous votes alone. Every board says how many votes of each kind of voter it holds (`voters`). |

What is stored is never the opaque id: the judgement carries `voter_kind` `anon` and the hash of the id, in the same
column a person's id would use. One vote per voter per round, and a creator never judges their own round, follow from
that. The open dataset never carries a voter id.

Every cap answers the same way: `429` with the code `bench.limit_anon` and the detail "Sign in to keep voting today".

| Cap | Environment variable | Default |
|---|---|---|
| One anonymous voter, per day | `BENCH_ANON_VOTER_PER_DAY` | 30 |
| One address (a salted hash of it, salted per day), per day | `BENCH_ANON_IP_PER_DAY` | 60 |
| One relaying service, per day | `BENCH_ANON_RELAY_PER_DAY` | 3000 |
| Every anonymous vote on the site, per day | `BENCH_ANON_GLOBAL_PER_DAY` | 20000 |
| The services that may relay | `BENCH_ANON_RELAY_SERVICES` | `design` |
| Signed-out voting on or off | `BENCH_ANON_ENABLED` | on |
| The secret the cookie is signed with | `BENCH_ANON_SECRET` | the OAuth client secret |

## The daily rounds

Bench makes one round per design kind per day, at one fixed UTC hour, on its own budget. It is off until the owner
turns it on (`BENCH_DAILY_ROUNDS`), and it never starts under the drill. The prompts come from a curated list of
about twenty per kind (`server/bench/daily-prompts.js`), and the two models of every round come from the pool the
ordinary rounds use. A kind whose share of the day's budget is gone is skipped, and what the day spent is written
down in `bench_daily_rounds`.

| Setting | Environment variable | Default |
|---|---|---|
| The job on or off | `BENCH_DAILY_ROUNDS` | off |
| The job under the drill (the tests) | `BENCH_DAILY_ROUNDS_IN_DRILL` | off |
| The UTC hour of the day | `BENCH_DAILY_ROUNDS_HOUR_UTC` | 8 |
| What the day's rounds may cost | `BENCH_DAILY_BUDGET_USD` | 1.00 |
| What one round is assumed to cost | `BENCH_DAILY_ROUND_ESTIMATE_USD` | 0.05 |

## The older API

Bench also serves kinds, tasks, rounds, entries, judgements, the boards, the models, the open dataset and the private
evals. Those are the round-based engine; the registry above is the versioned, forkable set the platform grows on.
See `/docs` on the site for the live list.

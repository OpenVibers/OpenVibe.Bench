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
| `GET /api/v1/benchmarks?kind=&tag=&q=` | anyone | The registry. |
| `GET /api/v1/benchmarks/:id[@version]` | anyone | One benchmark and its definition. Holdout tasks are withheld unless the caller holds `bench.run.publish` or owns the benchmark. |

The documents are the published contracts, from `openvibe-contracts` v0.244.0: `bench.benchmark@1` for a
benchmark version, `bench.run@1` for a run. Every document is checked against them before it is stored.

## The results

| Route | Who | What |
|---|---|---|
| `POST /api/v1/runs` | a person, or `bench.run.publish` | Publish a run. A service token with `bench.run.publish` makes a **verified** run; a person's token makes a **submitted** one, badged and out of the default rankings. |
| `GET /api/v1/runs/:id` | anyone | One run with its per-task results. `run.document` is the published `bench.run@1` document. |
| `GET /api/v1/compare?runs=a,b,c` | anyone | Up to four runs side by side, per task. |
| `GET /api/v1/rankings?benchmark=&metric=score\|value\|speed\|consistency&harness=&since=` | anyone | The rankings for a benchmark. Verified runs only, unless `include_submitted=true`. |
| `GET /api/v1/percentile?benchmark=&model=&score=` | anyone | Where a score sits among that model's runs. |

## The older API

Bench also serves kinds, tasks, rounds, entries, judgements, the boards, the models, the open dataset and the private
evals. Those are the round-based engine; the registry above is the versioned, forkable set the platform grows on.
See `/docs` on the site for the live list.

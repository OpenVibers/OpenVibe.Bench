# Writing a benchmark

A benchmark is a set you own, version and fork. This is how to write one.

## The shape

A benchmark (the contract is `bench.benchmark@1`) holds:

| Field | What it is |
|---|---|
| `id` | `bmk_…`, given by Bench when you create it. The same id carries every version. |
| `owner` | You. A person (`usr_…`), a project (`prj_…`) or a service. |
| `title`, `description` | What the set is and who it is for. |
| `kind` | One of Bench's kinds (`games.play`, `design.ui`, `codes.patch`, …). The kind sets the renderer. |
| `tags` | Up to 32 words people search by. |
| `visibility` | `public` (in the registry), `unlisted` (reachable by its id; a share link when one is made), or `private` (its owner only). A pasted set of your own prompts starts private. |
| `version` | The version this document is. Bench numbers them. |
| `parent` | The `id@version` this one was forked from, or `null`. |
| `tasks[]` | `{ id, prompt, files?, expected?, holdout }`. The prompt is the task; `holdout: true` hides it from everyone but the executor. |
| `judges[]` | `{ type, version, config }`. The judge is pinned by version, so a run names the judge it used. |
| `scoring` | `{ method, scale, weights? }`. `method` is `mean`, `weighted`, `pass_rate` or `sum`; the scale is 0-100. |
| `limits` | `{ ms?, tokens?, usd }`. A run may not pass them. |
| `matrix` | `{ models[], harnesses[] }`. The defaults a runner starts from. |

## The three calls

```
POST /api/v1/benchmarks                 create it (a draft)
PUT  /api/v1/benchmarks/:id             save a new draft
POST /api/v1/benchmarks/:id/versions    freeze a version
POST /api/v1/benchmarks/:id/fork        fork it
```

Authoring needs the `bench.benchmark.write` capability on a service token, or a signed-in person.

A version is **immutable once a run names it**. Write a new draft and freeze it again instead; if you want to change a
published set, fork it — the fork records the parent, and the old version stays where the old runs point.

## An example

```json
{
  "title": "Playable games arena",
  "description": "One-screen arcade games, judged by play.",
  "kind": "games.play",
  "tags": ["games", "arcade"],
  "visibility": "public",
  "tasks": [
    { "id": "t1", "prompt": "Build a one-screen arcade game with a paddle, bricks, a ball and a score.", "files": [], "expected": null, "holdout": false },
    { "id": "t2", "prompt": "Build a snake game on a 20x20 grid.", "files": [], "expected": null, "holdout": true }
  ],
  "judges": [{ "type": "human_pairwise", "version": "1.0", "config": {} }],
  "scoring": { "method": "mean", "scale": { "min": 0, "max": 100 } },
  "limits": { "ms": 120000, "tokens": 200000, "usd": 0.5 },
  "matrix": { "models": ["claude-opus-4"], "harnesses": ["claude-code"] }
}
```

## Your own prompts

A person can paste 5 to 50 of their own prompts at `/benchmarks/new`: one per line, or CSV with an optional
expected answer in the second column. They become the tasks of a private benchmark (`text.answer`, or any existing
kind), frozen as version 1. It is private by default: the owner alone sees the prompts, and another person gets a
404. The owner may share an unlisted link (a 256-bit token, stored as a hash and checked in constant time), make it
public (then it is in the lists, the sitemap and `/api/v1/datasets/benchmarks.jsonl`), or make it private again (the
link stops working). Runs still go through the openvibe.codes launcher: the same estimate, the same "ask before it
starts".

## The contracts

Bench speaks the published shapes, from `openvibe-contracts` **v0.244.0**:

| Contract | What it is |
|---|---|
| `bench.benchmark@1` | the document a frozen version holds, exactly |
| `bench.run@1` | the document a run is, exactly |

The service reads both from the package — there is no second copy — and checks every document against them before it
is stored, so a run that is not a `bench.run@1` run is refused with `bench.invalid` and a field-level error. A run
that is read back carries its contract document under `document`:

```json
{
  "run": {
    "id": "brn_…",
    "provenance": "verified",
    "document": { "id": "brn_…", "benchmark": "bmk_…@1", "provenance": "verified", "…": "…" }
  }
}
```

The capabilities the registry uses are published too: `bench.benchmark.write`, `bench.run.publish` and
`bench.run.read`.

## The holdout

A task with `holdout: true` keeps its prompt from everyone but two callers: the executor (a service token with
`bench.run.publish`) and the benchmark's owner. Everybody else gets the task listed with its prompt withheld, so the
set cannot be tuned to.

## Running it

A run (the contract is `bench.run@1`) names the benchmark `id@version`, the model, the route, the provider, the
harness and its version, the settings, the executor, and the per-task score, cost, time, tokens and artifacts. It
ends with the run's own score, its cost, time and tokens, and its provenance.

Publish it with `POST /api/v1/runs`. A service token with `bench.run.publish` publishes a **verified** run (an
executor ran it, so it can be re-run and it counts in the rankings). A person's token publishes a **submitted** run:
it is badged and kept out of the default rankings.

## Reading the results

```
GET /api/v1/runs/:id
GET /api/v1/compare?runs=a,b,c
GET /api/v1/rankings?benchmark=&metric=score|value|speed|consistency&harness=&since=
GET /api/v1/percentile?benchmark=&model=&score=
```

`value` is the score per dollar, `speed` the score per minute, and `consistency` the spread of a model's scores
inside one session (the lower, the steadier). The percentile says where a score sits among that model's runs.

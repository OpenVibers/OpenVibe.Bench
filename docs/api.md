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
| `GET /api/v1/rankings?benchmark=&metric=score\|value\|speed\|consistency\|tickets&harness=&since=&effort=` | anyone | The rankings for a benchmark. Verified runs only, unless `include_submitted=true`. `metric=tickets` (also `pass_k`, `pass@k`) is the AL8 gate: pass@1, pass^k and cost per solved by model and effort (`effort` filters one). |
| `GET /api/v1/percentile?benchmark=&model=&score=` | anyone | Where a score sits among that model's runs. |

## Whole tickets (AL8, the gate)

`codes.ticket` scores a whole ticket: a goal and its check, run over 3 to 5 trials on each model and effort. A run
is one trial; each task is one ticket, and its score is 100 when the check passed and 0 when it did not. The
results API answers the gate's table:

```
GET /api/v1/rankings?benchmark=bmk_…@1&metric=tickets&effort=high
{
  "rankings": {
    "metric": "tickets",
    "entries": [{
      "model": "deepseek-flash", "effort": "high", "k": 3, "trials": 3, "task_trials": 9, "tickets": 3,
      "pass_at_1": 0.888889,        // share of all (ticket, trial) pairs that passed
      "pass_at_k": 0.666667,        // share of tickets whose every one of k trials passed
      "cost_usd": 0.31, "solved": 3,
      "cost_per_solved": 0.103333,  // every trial's cost ÷ the tickets solved at least once
      "insufficient_trials": false,
      "per_ticket": [{ "task_id": "…", "trials": 3, "passes": 3, "pass_at_1": 1, "pass_at_k": true, "cost_usd": 0.1 }]
    }]
  }
}
```

A group with fewer than three trials sets `insufficient_trials: true`; it is not a gate result. The suite file
(`bench.codes-ticket-suite@1`) and the runner are in `fixtures/codes.ticket/` and `scripts/ticket-suite.js`. A suite
runs only when a person passes `--run`; the default models are `deepseek-flash` and `local`, and nothing is
scheduled.

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

## live.clip: OpenVibe.Live's AI clip picks

`live.clip` is a **private** kind: Live submits the clips its picker made (or chose not to make) and Bench compares
them blind, against another policy's pick for the same recording. Bench never makes clips itself, and the kind never
appears in the public kind list, a board, the gallery, the open dataset or the vote dump.

Only Live's service token submits to it (`service:live`), and only for the recordings that token is granted.

| Route | Who | What |
|---|---|---|
| `POST /api/v1/kinds/live.clip/tasks` | Live's service token | A task for one recording. It is never public. |
| `POST /api/v1/tasks/:id/rounds` | Live's service token | The round. It spends no AI and takes none of the site's daily round budget. |
| `POST /api/v1/rounds/:id/entries` | Live's service token | One clip, or one abstention. |
| `GET /api/v1/kinds/live.clip/policies` | Live's service token | What each picker did: entries, abstentions, cost, wins, ties, losses, both-bad votes and the accept rate. |

An entry's payload is typed, and only the typed fields are kept:

```json
{
  "source":   { "recording_id": "vod_5021", "start_ms": 60000, "end_ms": 90000, "language": "ja", "genre": "irl" },
  "playback": { "url": "https://openvibe.media/c/1234?exp=…&sig=…", "expires_at": "2026-11-03T12:00:00.000Z" },
  "policy":   { "selector": "auto-clip", "version": "2026-11-02", "models": ["qwen3-vl-4b"] },
  "title":    "The cat walks onto the keyboard",
  "cost_usd": 0.002
}
```

`end_ms` must be after `start_ms`, the clip 5 to 180 seconds long, `playback.url` an `https` address and
`playback.expires_at` a time still to come. The `policy` is pinned on the entry when it is stored and is never
rewritten. An **abstention** is a valid entry — the picker saw nothing worth clipping — and carries no `playback`, a
`reason` instead, and `abstained: true`.

**Which recordings a service may submit for.** The grant is the service token's `ns` claim, the same namespace list
OpenVibe.Media reads: the namespace of a recording is `rec:<recording_id>`. A token holding `ns: ["rec:vod_*"]` may
submit for the recordings whose id starts with `vod_`; `rec:*` (or `*`) is every recording. A token that names no
namespace is authorised for **none**: the check fails closed, so an entry for a recording the submitter was never
granted is refused with `bench.clip_source_denied` and nothing is stored.

**The playback is for a voter only.** It is never in a round read, only in the pair a voter is given
(`GET /api/v1/judgements/next?kind=live.clip`) and on the battle page, and never once `expires_at` has passed: an
expired clip is shown as expired and its link is not served.

## Model-variant evidence (P6)

P6 records measured throughput, TTFT and cold-start evidence per **exact model id**, grouped into variant families.
It is Bench's evaluation evidence for a placement: Bench still never runs inference, and nothing here starts a run.
The whole surface is behind `BENCH_VARIANT_EVIDENCE` and is **off** by default; with the flag off these routes do not
exist (a 404 with `route.not_found`).

An exact id is the D3 form `<org>/<model>[:<quant>]@<revision>`, and the quant and the revision are optional:

```
qwen/qwen3-9b-abliterated:q4_k_m@3f2a1c9
qwen/qwen3-9b-abliterated:q4_k_m
qwen/qwen3-9b-abliterated@main
qwen/qwen3-9b-abliterated
```

The **family** is `<org>/<model>`, so the four ids above are one family with two quants and two revisions.

| Route | Who | What |
|---|---|---|
| `GET /api/v1/variant-families` | anyone | Every family: its exact ids (variants), quants, revisions and sample counts. |
| `GET /api/v1/variant-families/:family` | anyone | One family; `:family` is URL-encoded (`qwen%2Fqwen3-9b-abliterated`). |
| `GET /api/v1/variant-evidence` | anyone | Every exact id's evidence; `?family=` filters one family. |
| `GET /api/v1/variant-evidence/:exactId` | anyone | One exact id; `:exactId` is URL-encoded. |
| `POST /api/v1/variant-evidence` | a service token | Record one observation from a pinned round or an authenticated run. |

A write is accepted only from a service token, never from a person, an anonymous caller or a model's own agent:

- **A pinned round** (`source.kind: "round"`, `source.id: "brd_…"`) needs `bench.entry.create`. The round must be
  `finished` and carry its receipt; a queued or failed round is refused.
- **A run** (`source.kind: "run"`) needs `bench.run.publish`. A Bench run (`brn_…`) must be `verified`; a Run job
  (`job_…`) or AI run (`run_…`) is recorded as an authenticated run. A submitted run is refused.
- A token whose identity names the model (for example `agent:qwen/qwen3-9b-abliterated`) is refused with
  `bench.self_rating`: a model never rates itself.

```json
{
  "exact_id": "qwen/qwen3-9b-abliterated:q4_k_m@3f2a1c9",
  "source": { "kind": "round", "id": "brd_0123456789ABCDEFGHJKMNPQRS" },
  "measured_at": "2026-11-04T10:00:00.000Z",
  "sample_count": 120,
  "success_count": 118,
  "timeout_count": 2,
  "ttft_p50_ms": 210,
  "ttft_p95_ms": 480,
  "prefill_tokens_per_s": 1420,
  "decode_tokens_per_s": 86.5,
  "cold_start_ms": 5300
}
```

A rate may be sent instead of its count (`success_rate`, `timeout_rate`, each 0 to 1); it is converted with the
sample count. `sample_count` is required. Every other number is optional, and a missing one stays `null` — it is never
guessed or filled in from the family or another revision.

The read returns the observations and their totals. The newest observation's metrics are also on the variant for
convenience, and `observations` keeps each source's own numbers:

```json
{
  "evidence": {
    "exact_id": "qwen/qwen3-9b-abliterated:q4_k_m@3f2a1c9",
    "family": "qwen/qwen3-9b-abliterated",
    "quant": "q4_k_m",
    "revision": "3f2a1c9",
    "sample_count": 120,
    "success_rate": 0.983333,
    "timeout_rate": 0.016667,
    "confidence": {
      "level": "high",
      "sparse": false,
      "samples": 120,
      "minimum_samples": 10,
      "success_rate": { "estimate": 0.983333, "lower": 0.9412, "upper": 0.9965 }
    },
    "metrics": { "ttft_p50_ms": 210, "ttft_p95_ms": 480, "decode_tokens_per_s": 86.5 },
    "ttft_p50_ms": 210,
    "ttft_p95_ms": 480,
    "provenance": { "kind": "round", "id": "brd_…", "receipt": "…" },
    "observations": [ { "sample_count": 120, "metrics": { "…": "…" }, "provenance": { "…": "…" } } ]
  }
}
```

`confidence.level` is `sparse` under 10 samples, `low` from 10, `moderate` from 30 and `high` from 100;
`sparse: true` is always explicit. The success and timeout intervals are Wilson bounds. A rate across several
observations is returned only when every observation counts that outcome; a missing count is not a zero.

**Private sets stay private.** The evidence table has no prompt, output, payload or transcript column, the write
ignores any such fields, and the read routes never join a task, benchmark or entry. The only text in a row is an
exact id, a family, and the id of the round or run that produced it.

## The boards: ranks, categories, the Index and the holdout

`GET /api/v1/boards/:kindId?type=elo` returns the fit, not just the Elo updates: each row carries `elo`, its
`ci_lower`/`ci_upper` rating interval, and `rank`/`rank_lo`/`rank_hi` — the 95% rank interval from the same bootstrap.
The board also carries:

| Field | What it holds |
|---|---|
| `categories` | One board per task category with at least 30 games: `{ category, games, rows }`, each row fitted the same way. A category below the floor is left out. `?category=<slug>` answers for one category alone. |
| `index` | The OpenVibe Index per model: `{ weights, rating_anchor, benchmark_count, benchmarks[], rows[] }`. Each row is `{ subject, index, n_components, weight_sum, components[] }`; `index` is null when fewer than two components exist. |
| `holdout` | `{ available, held_out_tasks, rows[] }`; each row is `{ subject, public_n, public_score, holdout_n, holdout_score, gap }`, with a null gap when either side has no scores. |

The open dataset (`/api/v1/datasets/:kindId.jsonl`) also emits `type: "category"`, `type: "index"` and
`type: "holdout"` lines, and its rating lines carry the rank interval. The formulas, the 0.5/0.5 weights and the
30-game floor are in [index.md](index.md).

## Provider fidelity (stage B5)

| Route | Who | What |
|---|---|---|
| `GET /api/v1/fidelity` | anyone | The latest measurement of every offer: `score` (pass rate), `n`, `interval` (95% Wilson), `compared_to`, `measured_at`, `prompt_set`. Cached 60 seconds. |
| `GET /api/v1/fidelity/objective-set` | anyone | The fixed public set (`fidelity-2026-11-09.v1`): every prompt and the deterministic check it is graded by. |
| `POST /api/v1/fidelity/plan` | operator token | The dry run: each offer, its calls, the own-page price estimate and whether it fits the daily cap. Spends nothing. |
| `POST /api/v1/fidelity/run` | operator token | One bounded pass. Refused with `fidelity.disabled` until `BENCH_FIDELITY=1`; capped by `BENCH_FIDELITY_DAILY_CAP_USD` and `BENCH_FIDELITY_MAX_CALLS`. |
| `GET /api/v1/fidelity/status` | operator token | Whether the switch is on and the last pass's state. |

The measurement asks every enabled provider of an open-weight model the same ten objective items, answers only, and
grades each answer with a published exact/JSON/regex check. A provider that quantizes, truncates the context or
serves another checkpoint answers fewer correctly; that is the number beside its price. A caller never sees a rank
or a winner. Scores travel to OpenVibe.AI with `GET /api/v1/exchange/market` / `catalog` as each offer's `fidelity`
field (null when unmeasured). The dry run and the cap are the owner's switch: fidelity is off by default.

## The older API

Bench also serves kinds, tasks, rounds, entries, judgements, the boards, the models, the open dataset and the private
evals. Those are the round-based engine; the registry above is the versioned, forkable set the platform grows on.
See `/docs` on the site for the live list.

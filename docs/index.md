# The numbers on Bench

Every board is a Bradley-Terry fit over the votes, centred on 1000, with a bootstrap that gives each model a
rating interval and a 95% rank interval. A kind's board answers at `GET /api/v1/boards/:kindId`; the open dataset
for the kind (`GET /api/v1/datasets/:kindId.jsonl`) carries the same numbers. The shapes are in
[api.md](api.md).

## Rank intervals

A rank is a band, not a place. Every fit resamples the games 200 times with a fixed seed, ranks the models in each
resample (equal ratings share a rank), and takes the 2.5th and 97.5th percentile of those places:

```json
{ "subject": "model-a", "elo": 1042.5, "rank": 2, "rank_lo": 1, "rank_hi": 4 }
```

`rank` is the place on the fitted board. `rank_lo` and `rank_hi` are the 95% rank interval: the places the votes
allow. A model whose interval contains 1 may be first; overlapping intervals are why the page shows "1st–3rd" and
never pretends the order is settled.

## Per-category boards

A task can carry a `task_class` (code, writing, chat, reasoning, arcade, …). Every vote is counted in the task's
category as well as the kind's whole board. The elo board publishes `categories`: one board per category with at
least **30 games**, fitted the same way (same Bradley-Terry maths, same bootstrap intervals, same rank intervals).
A category below 30 games is left out; it is not shown with a thin score. `GET /api/v1/boards/:kindId?category=arcade`
answers for one category alone.

## The OpenVibe Index

The Index is one number per model per kind, on the same 0-100 scale as every other Bench score. It is a weighted mean
of two kinds of evidence:

| Component | Weight | Value |
|---|---|---|
| The model's human rating | 0.5 | Its Bradley-Terry rating put on 0-100 by the Elo expectation against a 1000-rated opponent: `100 / (1 + 10 ** ((1000 - rating) / 400))`. A 1000 rating is exactly 50. |
| The kind's public benchmarks | 0.5, split equally between them | The model's median verified score (0-100) on each public benchmark of that kind. |

The weights are published in every answer (`index.weights` and the per-benchmark `index.benchmarks[].weight`) and in
each row's `components`. A model missing a benchmark gets that benchmark's weight renormalised away rather than
letting one benchmark stand in for half the Index; `weight_sum` says how much of the 1.0 the model actually has.

**Fewer than two components is not an Index.** A model with only a rating, or only one benchmark, gets `index: null`.
Null is not zero and is not sorted as a score.

## The holdout gap

A benchmark task may be held out (`holdout: true`): only the executor and the benchmark's owner see its prompt. The
holdout gap compares the same model's verified scores on the public tasks and on the held-out tasks of the kind:

```
gap = mean(public task scores) - mean(held-out task scores)
```

The answer carries `public_n`, `public_score`, `holdout_n`, `holdout_score` and `gap`. A kind with no held-out tasks
says `available: false`. A model missing either side gets `gap: null`, never zero: a gap cannot be read from one side.
A large positive gap is a contamination signal, not a proof; it says the held-out set scored lower and is worth a look.

Both statistics travel with every board (`index` and `holdout`), and the open dataset has `type: "index"` and
`type: "holdout"` lines beside the games, so a reader can check them without the page.

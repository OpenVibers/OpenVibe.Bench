# Changelog

## Unreleased

- **The matchmaker for battles.** A battle no longer takes a random finished round and always puts its first entry on
  side A. Every pair of every candidate round is now scored by what the vote is worth — `p(1-p) × (wA + wB)`, where
  `p = 1 / (1 + 10^((rB - rA) / 400))` is the chance the board gives the first side and `w` the width of each
  model's interval — and the pair the board knows least about is the one asked. A model the board has never rated, or
  has fewer than 20 games for, counts as the board's widest interval at its median, so a new entrant is asked early
  without drowning the rest; two models of one family (openai, anthropic, google, deepseek, qwen, meta, mistral, xai,
  zhipu, moonshot) do not meet while another family is in the round; and the two sides are put in a random order, the
  order shown being the order recorded in `bench_battle_seen`, so the ratings can correct for the position. The
  candidates are read in two queries instead of one per round, and a private kind's clip payload is fetched only for
  the two entries that are shown.
- **Whole tickets, the gate (AL8).** A new kind, `codes.ticket`, scores a whole ticket — a goal and a typed check
  in `agent.goal@1`'s shape, with a token/turn/minute budget and a no-progress limit — over 3 to 5 trials per model
  and effort. A run is one trial; a task's score is 100 when the check exited 0 and 0 when it did not, and the
  check's test patch is applied only after the worker stops, so the merged pull request's own test grades the work.
  `GET /api/v1/rankings?benchmark=…&metric=tickets&effort=…` (also `pass_k`, `pass@k`) reports pass@1, pass^k (every
  one of k trials passed) and cost per solved by model and effort, with the per-ticket rows. The first suite
  (`fixtures/codes.ticket/openvibe-merged-2026-11.json`) holds twelve small tickets from merged OpenVibe pull
  requests across Bench, Codes, AI, Actor, Exchange, Report and Network; each goal is the change in words and each
  check is the pull request's own test. `scripts/ticket-suite.js` prints the plan and runs only with `--run`; the
  default models are `deepseek-flash` and `local`, and nothing is scheduled.
- **Provider fidelity (B5).** `GET /api/v1/fidelity` publishes, for every measured open-weight model offer, the
  score of the fixed public objective set (`fidelity-2026-11-09.v1`: ten objective items, a deterministic check each,
  no judge), with n, its 95% Wilson interval and the model it was compared on. `POST /api/v1/fidelity/plan` is the
  dry run: every call, the own-page price estimate and whether it fits the owner's daily cap. `POST
  /api/v1/fidelity/run` runs one bounded pass; every call goes through OpenVibe.AI's normal generate path, pinned to
  the exact offer, with a durable idempotency key per prompt and week. Off by default (`BENCH_FIDELITY=1`), daily
  capped, and a weekly due-based job when on. The objective set is public at `GET /api/v1/fidelity/objective-set`;
  answers are never stored, only which item passed.
- **The 18+ board (`chat.willing`).** A new adult kind and `GET /api/v1/boards/chat.willing`, marked `adult: true` on the board and every row. It reads OpenVibe.AI's measured refusal and hedge rates (n and Wilson intervals) on the published 60-prompt lawful adult set, plus the abliteration tax for each declared base/abliterated pair: the same objective set on both, with the score difference and its Newcombe interval. A non-willingness type on the adult kind is refused; when AI cannot answer, the board says the measurements are unavailable and invents no rows.
- **Every Eval Ever (B2).** Bench imports the public EEE datastore (`github.com/evaleval/every_eval_ever`,
  `evaleval/EEE_datastore`) as *external* results: the model (joined by Report's rule — maker prefix and a date or
  channel suffix dropped), the harness and its version, the task and its version, few-shot, the metric, the score,
  the source link and the licence. A record whose licence does not allow redistribution is dropped and counted.
  The rows live in `bench_eee_records` and are served by `GET /api/v1/external/records` with `external: true`; they
  never enter Bench's ratings, boards or medians. A weekly, resumable, bounded job (`BENCH_EEE_SYNC`) imports them.
  Bench's own public runs are exported as EEE `evaluation_run` records at `GET /api/v1/datasets/eee` (JSONL, paged;
  per-sample scores at `/api/v1/datasets/eee/runs/:id.samples.jsonl`).
- **Two more harnesses (B7).** HF lighteval and Stanford HELM results join Inspect AI, Harbor, the
  lm-evaluation-harness and promptfoo. Every import keeps the harness name and version, each task's version, the
  few-shot and the seed on the run.
- **The public pages moved to OpenVibe.Report's AI section (2026-11-08).** `/`, `/docs`, `/benchmarks`, `/models/*`, `/compare` and the other page routes answer `301` to `https://openvibe.report/ai` counterparts; the API, MCP, render origin, badges and embeds stay on bench.openvibe.services. New public reads feed Report: `GET /api/v1/runs`, `/api/v1/overview` (with every public model and its last run) and `/api/v1/models/:model/summary` (per-benchmark and per-task medians, cost, recent runs). `/api/v1/benchmarks` now carries each benchmark's runs and last run.
- **The Exchange arena (`chat.arena`).** A new kind, and a first-party API only OpenVibe.Exchange may call:
  `POST /api/v1/arena/rounds` builds a round from two answers the Exchange already has, and
  `POST /api/v1/arena/rounds/:id/votes` records the person's own `human_pairwise` judgement from
  `X-OV-Subject`. The service owns the round, so the person can vote on it; a second vote is 409 and the round
  is revealed. The arena's rounds skip a person's daily quota and have their own daily cap.
- **Task-category ratings.** A judgement now also updates the task's `task_class` category (code, writing, chat,
  reasoning, translation, analysis) beside `all` and the voter kind, and `GET /api/v1/boards/:kindId?category=…`
  reads it. A category board lists only the models that played in it.

## 0.1.0 — 2026-10-28

- OpenVibe.Bench v1: the shared AI benchmark and comparison engine (plan 2026-10-28 §4.12).
- Fifteen kinds seeded from code; pinned, reproducible rounds; blind pairwise judgements with one vote per person per round and no vote on your own round.
- Elo, pareto and cost boards; open dataset per kind without voter ids; private evals (free daily cap, no charging in v1).
- MCP endpoint (`POST /mcp`) and events outbox (`bench.round.finished`, `bench.judgement.recorded`, `bench.rating.changed`).

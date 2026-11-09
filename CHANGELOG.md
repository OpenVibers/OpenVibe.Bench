# Changelog

## Unreleased

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

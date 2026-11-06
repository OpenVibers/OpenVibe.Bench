# Changelog

## Unreleased

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

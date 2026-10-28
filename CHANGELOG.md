# Changelog

## 0.1.0 — 2026-10-28

- OpenVibe.Bench v1: the shared AI benchmark and comparison engine (plan 2026-10-28 §4.12).
- Fifteen kinds seeded from code; pinned, reproducible rounds; blind pairwise judgements with one vote per person per round and no vote on your own round.
- Elo, pareto and cost boards; open dataset per kind without voter ids; private evals (free daily cap, no charging in v1).
- MCP endpoint (`POST /mcp`) and events outbox (`bench.round.finished`, `bench.judgement.recorded`, `bench.rating.changed`).

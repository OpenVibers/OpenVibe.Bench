# Shared ratings

`GET /api/v1/ratings/:kindId?category=all` is the public rating read for other sites.
It returns `{ board: { schema, kind_id, category, minimum_samples: 20, source,
methodology, rows } }`, caches for sixty seconds and permits anonymous browser GETs.
Each row contains a model subject, fitted Elo, games, wins/losses/ties, confidence
and rank intervals. No prompts, answers, voters or site identifiers are returned.
Models with fewer than twenty eligible games are omitted, including their counts.
An empty board means insufficient evidence, never a baseline score of 1000.
Private kinds and the separate adult willingness test are excluded.

This reads `boardElo`, the same deterministic Bradley-Terry fit used by the board
and JSONL export. `GET /api/v1/models/:model` now takes its rating for each kind
from this same read. The incremental `bench_ratings` table remains for write-side
accounting and events; it is no longer the model-summary rating source. Existing
`/boards` reads retain their provisional views for compatibility.

Design's `server/arena/bench.js` submits each vote to Bench judgements. Exchange's
`server/bench.js` submits its arena votes to Bench's arena API. Bench kinds already
write the same judgement stream. There is no second rating computation for these
consumers. A model subject and kind identify the rating; clients must not average
different subjects, kinds or provider revisions into a new rating.

For Fable: rating, confidence bounds, eligible games, kind, and category come from
this read. Empty rows need an insufficient-evidence state. Receipt-based latency
and costs come from the separate AI metrics API, not these votes.

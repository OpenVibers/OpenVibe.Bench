-- phase: expand
-- Every comparison on the network as one record (bench.match@1, Contracts 0.422.0, compare-arena-ecosystem.md,
-- 2026-11-13): an Arena vote, a Codes race whose patch was merged, a check job's tests, a game, a Live poll. The
-- boards that rate model and harness apart (server/rating/factors.js) are fitted from these.
--
-- BODY is the whole bench.match@1 document (sides, receipts, shown order, judgements); the columns beside it are what
-- a board selects on. RECORDED_BY is the service that sent it: only that service adds judgements to it later.
CREATE TABLE IF NOT EXISTS bench_matches (
    id text COLLATE "C" PRIMARY KEY,
    source text COLLATE "C" NOT NULL,
    task_kind text COLLATE "C" NOT NULL,
    category text COLLATE "C",
    prompt_hash text COLLATE "C",
    recorded_by text COLLATE "C" NOT NULL,
    body jsonb NOT NULL,
    at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bench_matches_board ON bench_matches (task_kind, category, at);

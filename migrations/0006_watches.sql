-- phase: expand
-- The watches (spec 6): a person follows a benchmark, or a model on a benchmark. The rows go into the account export
-- and are deleted with the person.
CREATE TABLE IF NOT EXISTS bench_watches (
    id               TEXT PRIMARY KEY,
    subject          TEXT NOT NULL,
    benchmark_id     TEXT NOT NULL REFERENCES bench_benchmarks (id) ON DELETE CASCADE,
    model            TEXT,
    user_id          BIGINT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_notified_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS bench_watches_once ON bench_watches (subject, benchmark_id, COALESCE(model, ''));
CREATE INDEX IF NOT EXISTS bench_watches_benchmark ON bench_watches (benchmark_id);

-- The board as it was last seen, so the next fit can be compared with it. The model is a model, not a person.
CREATE TABLE IF NOT EXISTS bench_watch_ratings (
    kind_id    TEXT NOT NULL,
    model      TEXT NOT NULL,
    rating     DOUBLE PRECISION,
    ci_lower   DOUBLE PRECISION,
    ci_upper   DOUBLE PRECISION,
    band       TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind_id, model)
);

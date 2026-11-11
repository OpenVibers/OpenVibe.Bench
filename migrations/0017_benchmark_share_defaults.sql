-- phase: expand
-- Personal benchmarks and their runs start Only me unless their maker chooses another audience.
CREATE TABLE IF NOT EXISTS bench_share_defaults (
    owner_subject text COLLATE "C" PRIMARY KEY,
    audience text NOT NULL CHECK (audience IN ('public', 'link', 'people', 'private')),
    updated_at timestamptz NOT NULL DEFAULT now()
);

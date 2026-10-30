-- phase: expand
-- B12: imported results. An upload is the owner's own file (private until they share it), the runs it becomes are
-- submitted (never verified) and carry the provenance of where they came from: a tool, or a mirror's source.
CREATE TABLE bench_imports (
    id            text COLLATE "C" PRIMARY KEY,          -- bim_ + ULID
    owner         text COLLATE "C" NOT NULL,
    tool          text COLLATE "C" NOT NULL,             -- inspect | harbor | lm-eval | promptfoo
    tool_version  text COLLATE "C" NOT NULL DEFAULT '',
    filename      text COLLATE "C" NOT NULL DEFAULT '',   -- the name the person gave it; never a path
    sha256        text COLLATE "C" NOT NULL,
    size          integer NOT NULL DEFAULT 0,
    status        text COLLATE "C" NOT NULL DEFAULT 'preview',   -- preview | imported | failed
    summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
    benchmark_id  text COLLATE "C" REFERENCES bench_benchmarks (id) ON DELETE SET NULL,
    run_ids       jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by    text COLLATE "C" NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_imports_id CHECK (id ~ '^bim_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_imports_tool CHECK (tool IN ('inspect', 'harbor', 'lm-eval', 'promptfoo')),
    CONSTRAINT bench_imports_status CHECK (status IN ('preview', 'imported', 'failed')),
    CONSTRAINT bench_imports_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT bench_imports_size CHECK (size >= 0)
);
CREATE INDEX bench_imports_by_owner ON bench_imports (owner, created_at DESC);

-- The uploaded file itself. It hangs off the import, so erasing the person erases the file with it.
CREATE TABLE bench_import_files (
    import_id  text COLLATE "C" PRIMARY KEY REFERENCES bench_imports (id) ON DELETE CASCADE,
    content    bytea NOT NULL,
    size       integer NOT NULL DEFAULT 0,
    CONSTRAINT bench_import_files_size CHECK (size >= 0)
);

-- Where a run came from: an upload (tool and its version) or a mirror (source url, licence, the day it was read).
-- It sits beside the run, not inside the published bench.run document, which the contract closes to extras.
ALTER TABLE bench_runs ADD COLUMN source jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The mirror's ledger: one row per source read, with the licence it was read under.
CREATE TABLE bench_mirror_reads (
    id          text COLLATE "C" PRIMARY KEY,             -- bmr_ + ULID
    source_key  text COLLATE "C" NOT NULL,
    source_url  text COLLATE "C" NOT NULL,
    licence     text COLLATE "C" NOT NULL,
    licence_url text COLLATE "C" NOT NULL DEFAULT '',
    attribution text COLLATE "C" NOT NULL DEFAULT '',
    read_at     timestamptz NOT NULL DEFAULT now(),
    rows        integer NOT NULL DEFAULT 0,
    CONSTRAINT bench_mirror_reads_id CHECK (id ~ '^bmr_[0-9A-HJKMNP-TV-Z]{26}$')
);
CREATE UNIQUE INDEX bench_mirror_reads_source ON bench_mirror_reads (source_key, source_url);

-- One mirrored result per model, benchmark version and source: the same one never lands twice.
CREATE TABLE bench_mirror_runs (
    id                text COLLATE "C" PRIMARY KEY,       -- bmr_ + ULID
    source_key        text COLLATE "C" NOT NULL,
    source_url        text COLLATE "C" NOT NULL,
    licence           text COLLATE "C" NOT NULL,
    licence_url       text COLLATE "C" NOT NULL DEFAULT '',
    read_at           timestamptz NOT NULL DEFAULT now(),
    benchmark_id      text COLLATE "C" NOT NULL REFERENCES bench_benchmarks (id) ON DELETE CASCADE,
    benchmark_version integer NOT NULL,
    model             text COLLATE "C" NOT NULL,
    run_id            text COLLATE "C" REFERENCES bench_runs (id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_mirror_runs_id CHECK (id ~ '^bmr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_mirror_runs_version CHECK (benchmark_version >= 1)
);
CREATE UNIQUE INDEX bench_mirror_runs_dedupe ON bench_mirror_runs (source_key, benchmark_id, benchmark_version, model);

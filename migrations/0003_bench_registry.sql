-- phase: expand
-- Stage B1 (spec 2026-10-30): the benchmark registry and the results API.
--
-- A benchmark is an owned, versioned and forkable set: its tasks, its judges, how they combine into one score, the
-- limits a run may not pass and the default model and harness matrix. A version is immutable once a run names it, so
-- bench_benchmark_versions keeps the frozen JSON definition and its hash; a fork records its parent.
--
-- A run is one result: a benchmark version × a model × a harness × settings × who ran it. Provenance says who ran it:
-- verified (an executor did) or submitted (posted through the API with no executor). Submitted runs are badged and
-- kept out of the default rankings. Nothing written here is a credential: a run never carries a key.

CREATE TABLE bench_benchmarks (
    id              text COLLATE "C" PRIMARY KEY,        -- bmk_ + ULID
    owner           text COLLATE "C" NOT NULL,           -- usr_…, prj_… or a service
    title           text NOT NULL,
    description     text NOT NULL DEFAULT '',
    kind            text COLLATE "C" NOT NULL,           -- one of Bench's kinds; the kind sets the renderer
    tags            jsonb NOT NULL DEFAULT '[]'::jsonb,
    visibility      text COLLATE "C" NOT NULL DEFAULT 'unlisted',  -- public | unlisted
    parent          text COLLATE "C",                    -- the benchmark id@version this one was forked from
    latest_version  integer NOT NULL DEFAULT 0,          -- the newest frozen version (0: a draft)
    draft           jsonb,                               -- the unpublished working copy (PUT saves it)
    created_by      text COLLATE "C" NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_benchmarks_id CHECK (id ~ '^bmk_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_benchmarks_visibility CHECK (visibility IN ('public', 'unlisted')),
    CONSTRAINT bench_benchmarks_latest CHECK (latest_version >= 0),
    CONSTRAINT bench_benchmarks_title CHECK (length(title) BETWEEN 1 AND 160),
    CONSTRAINT bench_benchmarks_kind CHECK (length(kind) BETWEEN 1 AND 80)
);
CREATE INDEX bench_benchmarks_by_kind ON bench_benchmarks (kind, created_at DESC);
CREATE INDEX bench_benchmarks_by_owner ON bench_benchmarks (owner, created_at DESC);
CREATE INDEX bench_benchmarks_by_visibility ON bench_benchmarks (visibility, created_at DESC);

CREATE TABLE bench_benchmark_versions (
    benchmark_id text COLLATE "C" NOT NULL REFERENCES bench_benchmarks (id) ON DELETE CASCADE,
    version      integer NOT NULL,
    definition   jsonb NOT NULL,                         -- the whole bench.benchmark@1 document
    hash         text COLLATE "C" NOT NULL,              -- sha256 of the canonical definition
    created_by   text COLLATE "C" NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (benchmark_id, version),
    CONSTRAINT bench_benchmark_versions_version CHECK (version >= 1),
    CONSTRAINT bench_benchmark_versions_hash CHECK (hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX bench_benchmark_versions_by_hash ON bench_benchmark_versions (hash);

CREATE TABLE bench_runs (
    id                text COLLATE "C" PRIMARY KEY,      -- brn_ + ULID
    benchmark_id      text COLLATE "C" NOT NULL REFERENCES bench_benchmarks (id),
    benchmark_version integer NOT NULL,
    model             text COLLATE "C" NOT NULL,
    route             jsonb NOT NULL DEFAULT '{}'::jsonb, -- the route that produced the run
    provider          text COLLATE "C" NOT NULL,
    harness           jsonb NOT NULL DEFAULT '{}'::jsonb, -- { name, version }
    settings          jsonb NOT NULL DEFAULT '{}'::jsonb, -- { temperature, effort }
    executor          jsonb NOT NULL DEFAULT '{}'::jsonb, -- { kind: codes|run|node|submitted, id }
    hardware          jsonb,                              -- the machine, for a local model
    score             numeric(8, 3) NOT NULL DEFAULT 0,  -- 0-100
    cost_usd          numeric(12, 6) NOT NULL DEFAULT 0,
    ms                integer NOT NULL DEFAULT 0,
    tokens            integer NOT NULL DEFAULT 0,
    provenance        text COLLATE "C" NOT NULL,          -- verified | submitted
    session           text COLLATE "C",                   -- a session groups repeated runs of one configuration
    created_by        text COLLATE "C" NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_runs_id CHECK (id ~ '^brn_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_runs_provenance CHECK (provenance IN ('verified', 'submitted')),
    CONSTRAINT bench_runs_score CHECK (score >= 0 AND score <= 100),
    CONSTRAINT bench_runs_version CHECK (benchmark_version >= 1),
    FOREIGN KEY (benchmark_id, benchmark_version) REFERENCES bench_benchmark_versions (benchmark_id, version)
);
CREATE INDEX bench_runs_by_benchmark ON bench_runs (benchmark_id, benchmark_version, created_at DESC);
CREATE INDEX bench_runs_by_model ON bench_runs (model, created_at DESC);
CREATE INDEX bench_runs_by_session ON bench_runs (session, created_at DESC);
CREATE INDEX bench_runs_verified ON bench_runs (benchmark_id, created_at DESC) WHERE provenance = 'verified';

CREATE TABLE bench_run_tasks (
    id             text COLLATE "C" PRIMARY KEY,         -- brt_ + ULID
    run_id         text COLLATE "C" NOT NULL REFERENCES bench_runs (id) ON DELETE CASCADE,
    task_id        text COLLATE "C" NOT NULL,            -- the benchmark task's id
    score          numeric(8, 3) NOT NULL DEFAULT 0,     -- 0-100
    cost_usd       numeric(12, 6) NOT NULL DEFAULT 0,
    ms             integer NOT NULL DEFAULT 0,
    tokens         integer NOT NULL DEFAULT 0,
    artifacts      jsonb NOT NULL DEFAULT '[]'::jsonb,    -- [{ kind, url }]
    transcript_url text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_run_tasks_id CHECK (id ~ '^brt_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_run_tasks_score CHECK (score >= 0 AND score <= 100)
);
CREATE INDEX bench_run_tasks_by_run ON bench_run_tasks (run_id, created_at, id);

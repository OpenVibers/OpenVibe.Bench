-- phase: expand
-- Stage B2 (plan 2026-11-09): Every Eval Ever (EEE).
--
-- Bench imports the EEE datastore (github.com/evaleval/every_eval_ever, HF evaleval/EEE_datastore) as *external*
-- results: they sit beside Bench's own runs in their own table, with the provenance and the licence they were
-- published under, and they never enter Bench's ratings, boards or medians. The licence that does not allow
-- redistribution stops a record at the door, and the sync's ledger counts how many and why.
--
-- The exporter is the other direction: Bench's own public runs are served as EEE `evaluation_run` records from
-- /api/v1/datasets/eee (server/bench/eee.js), so nothing here stores the export.

-- One row per (record, evaluation result, metric): the same EEE record never lands twice.
CREATE TABLE bench_eee_records (
    id                  text COLLATE "C" PRIMARY KEY,       -- ber_ + ULID
    eee_id              text COLLATE "C" NOT NULL,          -- the EEE evaluation_id (record identity)
    source_name         text COLLATE "C" NOT NULL DEFAULT '',
    source_type         text COLLATE "C" NOT NULL,          -- documentation | evaluation_run
    source_url          text COLLATE "C" NOT NULL DEFAULT '',
    source_org          text COLLATE "C" NOT NULL DEFAULT '',
    evaluator_relationship text COLLATE "C" NOT NULL DEFAULT 'other',
    licence             text COLLATE "C" NOT NULL,
    licence_url         text COLLATE "C" NOT NULL DEFAULT '',
    licence_source      text COLLATE "C" NOT NULL DEFAULT '', -- record | datastore
    model               text COLLATE "C" NOT NULL,          -- the join name (maker prefix and date/channel suffix dropped)
    model_raw           text COLLATE "C" NOT NULL DEFAULT '', -- the source's own id
    developer           text COLLATE "C" NOT NULL DEFAULT '',
    harness_name        text COLLATE "C" NOT NULL DEFAULT 'unknown',
    harness_version     text COLLATE "C" NOT NULL DEFAULT 'unknown',
    task                text COLLATE "C" NOT NULL,
    task_version        text COLLATE "C" NOT NULL DEFAULT '',
    few_shot            integer,
    seed                text COLLATE "C" NOT NULL DEFAULT '',
    metric_id           text COLLATE "C" NOT NULL DEFAULT '',
    metric_name         text COLLATE "C" NOT NULL DEFAULT '',
    lower_is_better     boolean,
    score               numeric(14, 6) NOT NULL,
    score_min           numeric(14, 6),
    score_max           numeric(14, 6),
    evaluation_at       timestamptz,
    retrieved_at        timestamptz,
    provenance          jsonb NOT NULL DEFAULT '{}'::jsonb, -- the EEE record as published (its licence, harness, link)
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_eee_records_id CHECK (id ~ '^ber_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_eee_records_source_type CHECK (source_type IN ('documentation', 'evaluation_run')),
    CONSTRAINT bench_eee_records_relationship CHECK (evaluator_relationship IN ('first_party', 'third_party', 'collaborative', 'other')),
    CONSTRAINT bench_eee_records_few_shot CHECK (few_shot IS NULL OR few_shot >= 0)
);
CREATE UNIQUE INDEX bench_eee_records_dedupe ON bench_eee_records (eee_id, task, metric_id, metric_name);
CREATE INDEX bench_eee_records_by_model ON bench_eee_records (model, task);
CREATE INDEX bench_eee_records_by_task ON bench_eee_records (task, created_at DESC);
CREATE INDEX bench_eee_records_by_source ON bench_eee_records (source_type, created_at DESC);

-- A sync run: where it got to and what it did. A run that stopped half way leaves its cursor here, and the next
-- run of the weekly job resumes from it instead of starting the datastore again.
CREATE TABLE bench_eee_syncs (
    id               text COLLATE "C" PRIMARY KEY,          -- bes_ + ULID
    status           text COLLATE "C" NOT NULL DEFAULT 'running', -- running | finished | failed
    cursor           jsonb NOT NULL DEFAULT '{}'::jsonb,    -- { collection, file }
    collections      integer NOT NULL DEFAULT 0,
    files_seen       integer NOT NULL DEFAULT 0,
    records_read     integer NOT NULL DEFAULT 0,
    records_kept     integer NOT NULL DEFAULT 0,
    dropped_licence  integer NOT NULL DEFAULT 0,
    dropped_invalid  integer NOT NULL DEFAULT 0,
    dropped_reason   jsonb NOT NULL DEFAULT '{}'::jsonb,    -- { reason: count }
    default_licence  text COLLATE "C" NOT NULL DEFAULT '',
    licence_url      text COLLATE "C" NOT NULL DEFAULT '',
    error            text COLLATE "C" NOT NULL DEFAULT '',
    started_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    finished_at      timestamptz,
    CONSTRAINT bench_eee_syncs_id CHECK (id ~ '^bes_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_eee_syncs_status CHECK (status IN ('running', 'finished', 'failed')),
    CONSTRAINT bench_eee_syncs_counts CHECK (files_seen >= 0 AND records_read >= 0 AND records_kept >= 0
        AND dropped_licence >= 0 AND dropped_invalid >= 0)
);
CREATE INDEX bench_eee_syncs_by_status ON bench_eee_syncs (status, started_at DESC);

-- B7: the two harnesses added beside the four. Widening the check is the expand step.
ALTER TABLE bench_imports DROP CONSTRAINT bench_imports_tool;
ALTER TABLE bench_imports ADD CONSTRAINT bench_imports_tool
    CHECK (tool IN ('inspect', 'harbor', 'lm-eval', 'promptfoo', 'lighteval', 'helm'));

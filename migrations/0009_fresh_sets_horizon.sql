-- phase: expand
-- B13: fresh monthly sets, the contamination flag and time-horizon estimates (spec 2026-10-30).
--
-- A task may carry the day it was added (`added_on`), whether it is held out (`held_out`, also accepted as the
-- older `holdout`) and a human time estimate (`human_minutes`) with its source. The run-task rows below copy the
-- facts at publish time, so a board can filter by month and fit a horizon without parsing every version; the
-- version-keyed table below keeps the same facts beside the closed benchmark document.
ALTER TABLE bench_run_tasks ADD COLUMN added_on date;
ALTER TABLE bench_run_tasks ADD COLUMN held_out boolean NOT NULL DEFAULT false;
ALTER TABLE bench_run_tasks ADD COLUMN human_minutes numeric(10, 1);
ALTER TABLE bench_run_tasks ADD COLUMN human_minutes_source text COLLATE "C";

-- Editors' human-time estimates. One per person per task: a later entry replaces the earlier one, and the median of
-- three distinct people is what a task's time becomes. The row is the person's data and goes with them.
CREATE TABLE bench_task_estimates (
    id                text COLLATE "C" PRIMARY KEY,      -- bte_ + ULID
    benchmark_id      text COLLATE "C" NOT NULL REFERENCES bench_benchmarks (id) ON DELETE CASCADE,
    benchmark_version integer NOT NULL,
    task_id           text COLLATE "C" NOT NULL,
    subject           text COLLATE "C" NOT NULL,
    minutes           numeric(10, 1) NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_task_estimates_id CHECK (id ~ '^bte_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_task_estimates_version CHECK (benchmark_version >= 1),
    CONSTRAINT bench_task_estimates_minutes CHECK (minutes > 0 AND minutes <= 100000),
    FOREIGN KEY (benchmark_id, benchmark_version) REFERENCES bench_benchmark_versions (benchmark_id, version) ON DELETE CASCADE,
    UNIQUE (benchmark_id, benchmark_version, task_id, subject)
);
CREATE INDEX bench_task_estimates_by_subject ON bench_task_estimates (subject, created_at DESC);
CREATE INDEX bench_task_estimates_by_task ON bench_task_estimates (benchmark_id, benchmark_version, task_id);

-- The task metadata itself. The published bench.benchmark@1 task shape is closed (id, prompt, files, expected,
-- holdout), so the B13 fields live beside the frozen definition, keyed by the version and task, and are merged into
-- the definition on Bench's own pages. The frozen document stays a valid contract document.
CREATE TABLE bench_task_meta (
    benchmark_id          text COLLATE "C" NOT NULL,
    benchmark_version     integer NOT NULL,
    task_id               text COLLATE "C" NOT NULL,
    added_on              date,
    held_out              boolean NOT NULL DEFAULT false,
    human_minutes         numeric(10, 1),
    human_minutes_source  text COLLATE "C",
    PRIMARY KEY (benchmark_id, benchmark_version, task_id),
    CONSTRAINT bench_task_meta_minutes CHECK (human_minutes IS NULL OR (human_minutes > 0 AND human_minutes <= 100000)),
    FOREIGN KEY (benchmark_id, benchmark_version) REFERENCES bench_benchmark_versions (benchmark_id, version) ON DELETE CASCADE
);

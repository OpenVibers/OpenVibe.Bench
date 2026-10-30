-- phase: expand
-- B3: verified human-judged runs publish their outputs before a score exists.
ALTER TABLE bench_runs ALTER COLUMN score DROP NOT NULL;
ALTER TABLE bench_runs ALTER COLUMN score DROP DEFAULT;
ALTER TABLE bench_run_tasks ALTER COLUMN score DROP NOT NULL;
ALTER TABLE bench_run_tasks ALTER COLUMN score DROP DEFAULT;

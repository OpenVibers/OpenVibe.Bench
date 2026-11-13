-- OpenVibe.Bench data-honesty audit (plan 2026-11-13 §X).
--
-- Read-only: run this against the production ov_bench database after migration 0019 has been applied. It counts the
-- rows that were already affected before the fix; it never writes. Run it as one transaction so the counts are one
-- consistent snapshot.
--
--   psql "$DATABASE_URL" -f docs/data-honesty-audit.sql

BEGIN TRANSACTION READ ONLY;

-- 1. A licence that was never read, stored as MIT. Before 0019 every datastore fallback was MIT and no read flag was
--    kept; 0019 backfills licence_read = false on those rows. A record's own stated licence is marked read = true.
SELECT count(*) AS rows_with_a_guessed_mit,
       count(DISTINCT model_raw) AS models
FROM bench_eee_records
WHERE licence = 'MIT' AND licence_source = 'datastore' AND licence_read = false;

SELECT id, status, default_licence, licence_read, licence_reason, records_kept, started_at
FROM bench_eee_syncs
WHERE NOT licence_read
ORDER BY started_at DESC;

-- 2. Missing measurements that were written as 0 by the importers and the mirror. Imports had every task cost,
--    latency and token count forced to 0; ran-level cost/tokens could also be 0 through num(). The mirror forced all
--    of them to 0. Real measured zeros are indistinguishable from these in the old rows, so the count is the review
--    list, not a claim that every zero is wrong.
SELECT r.source->>'kind' AS source_kind,
       count(*) AS runs,
       count(*) FILTER (WHERE r.cost_usd = 0) AS runs_cost_zero,
       count(*) FILTER (WHERE r.ms = 0) AS runs_ms_zero,
       count(*) FILTER (WHERE r.tokens = 0) AS runs_tokens_zero,
       count(*) FILTER (WHERE r.score = 0) AS runs_score_zero
FROM bench_runs r
WHERE r.source->>'kind' IN ('import', 'mirror')
GROUP BY 1
ORDER BY 1;

SELECT r.source->>'kind' AS source_kind,
       count(*) AS task_rows,
       count(*) FILTER (WHERE t.cost_usd = 0) AS tasks_cost_zero,
       count(*) FILTER (WHERE t.ms = 0) AS tasks_ms_zero,
       count(*) FILTER (WHERE t.tokens = 0) AS tasks_tokens_zero,
       count(*) FILTER (WHERE t.score = 0) AS tasks_score_zero
FROM bench_run_tasks t
JOIN bench_runs r ON r.id = t.run_id
WHERE r.source->>'kind' IN ('import', 'mirror')
GROUP BY 1
ORDER BY 1;

-- The mirror's own ledger: runs whose source never carried a cost, latency or token count.
SELECT count(*) AS mirrored_runs_with_a_forced_zero
FROM bench_runs r
JOIN bench_mirror_runs m ON m.run_id = r.id
WHERE r.cost_usd = 0 OR r.ms = 0 OR r.tokens = 0;

-- 3. Model joins that dropped the version. A raw id that ends in a date, year-month, "latest" or "free" but whose
--    stored join name does not is a row the old bareModel() merged into its family.
SELECT count(*) AS rows_with_the_version_dropped
FROM bench_eee_records
WHERE model_raw ~* '[-_@:]([0-9]{4}-?[0-9]{2}(-?[0-9]{2})?|latest|free)$'
  AND model !~* '([0-9]{4}-?[0-9]{2}(-?[0-9]{2})?|latest|free)$';

-- One row per model name that was fed more than one raw versioned id: the merge itself, with the raw ids.
SELECT model,
       model_family,
       count(DISTINCT model_raw) AS raw_ids,
       count(*) AS result_rows
FROM bench_eee_records
GROUP BY model, model_family
HAVING count(DISTINCT model_raw) > 1
ORDER BY result_rows DESC, model;

-- 4. The state after the fix, so the next run can compare: unknown licences, and rows with no family backfill.
SELECT licence_source, licence_read, count(*) AS rows
FROM bench_eee_records
GROUP BY 1, 2
ORDER BY 1, 2;

SELECT count(*) AS rows_with_no_model_family FROM bench_eee_records WHERE model_family = '';

COMMIT;

-- phase: expand
ALTER TABLE bench_judgements DROP CONSTRAINT bench_judgements_method;
ALTER TABLE bench_judgements ADD CONSTRAINT bench_judgements_method CHECK (method IN ('human_pairwise', 'audience_poll', 'rubric', 'automatic_grader', 'test_suite', 'game_outcome'));
ALTER TABLE bench_judgements ADD COLUMN vote_counts jsonb;

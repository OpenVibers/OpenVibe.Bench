-- phase: expand
-- Data honesty (plan 2026-11-13 §X): a licence that cannot be read is unknown, a measurement a harness did not
-- report is null rather than 0, and a model id keeps its version so two versions never join into one family.
--
-- The columns stay nullable on purpose. A NULL means "the source did not measure this", which is a different fact
-- from a measured zero; the API and the pages render it as unknown.

-- 1. EEE records: the datastore card may be unreadable, so the stored licence is nullable and carries why. The
--    record also says whether the licence was actually read and whether it is cleared for republication.
ALTER TABLE bench_eee_records ALTER COLUMN licence DROP NOT NULL;
ALTER TABLE bench_eee_records ADD COLUMN licence_reason text COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE bench_eee_records ADD COLUMN licence_read boolean NOT NULL DEFAULT false;
ALTER TABLE bench_eee_records ADD COLUMN republishable boolean NOT NULL DEFAULT false;
-- The join keeps the full versioned id; the family is a second field for grouping, never the identity.
ALTER TABLE bench_eee_records ADD COLUMN model_family text COLLATE "C" NOT NULL DEFAULT '';
UPDATE bench_eee_records SET model_family = model WHERE model_family = '';
-- Old rows never recorded whether the licence was read. A record's own stated licence was read; a datastore
-- fallback was the old guessed MIT and stays not-read and not republishable until the card is read again.
UPDATE bench_eee_records SET licence_read = true, republishable = true WHERE licence_source = 'record';
CREATE INDEX bench_eee_records_by_family ON bench_eee_records (model_family, task);

-- 2. The sync ledger: the same distinction (unknown licence, why it is unknown, whether it was read).
ALTER TABLE bench_eee_syncs ALTER COLUMN default_licence DROP NOT NULL;
ALTER TABLE bench_eee_syncs ADD COLUMN licence_reason text COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE bench_eee_syncs ADD COLUMN licence_read boolean NOT NULL DEFAULT false;

-- 3. A run's score, cost, time and tokens are nullable. A missing score already was; now a missing cost, time or
--    token count is not silently written as 0 either. Dropping the default makes an omission fail instead of become
--    a false zero.
ALTER TABLE bench_runs ALTER COLUMN cost_usd DROP NOT NULL;
ALTER TABLE bench_runs ALTER COLUMN cost_usd DROP DEFAULT;
ALTER TABLE bench_runs ALTER COLUMN ms DROP NOT NULL;
ALTER TABLE bench_runs ALTER COLUMN ms DROP DEFAULT;
ALTER TABLE bench_runs ALTER COLUMN tokens DROP NOT NULL;
ALTER TABLE bench_runs ALTER COLUMN tokens DROP DEFAULT;
ALTER TABLE bench_run_tasks ALTER COLUMN cost_usd DROP NOT NULL;
ALTER TABLE bench_run_tasks ALTER COLUMN cost_usd DROP DEFAULT;
ALTER TABLE bench_run_tasks ALTER COLUMN ms DROP NOT NULL;
ALTER TABLE bench_run_tasks ALTER COLUMN ms DROP DEFAULT;
ALTER TABLE bench_run_tasks ALTER COLUMN tokens DROP NOT NULL;
ALTER TABLE bench_run_tasks ALTER COLUMN tokens DROP DEFAULT;

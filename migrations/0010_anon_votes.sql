-- phase: expand
-- Plan L51 step 1 (signed-out voting) and step 2 (the daily rounds job).
--
-- 1. A judgement now says who voted: a person, a first-party service, or an anonymous voter. The anonymous
--    voter is a hash, never an id: the raw opaque id never reaches the database.
ALTER TABLE bench_judgements ADD COLUMN voter_kind text COLLATE "C";
UPDATE bench_judgements
   SET voter_kind = CASE WHEN subject IS NULL THEN 'service'
                         WHEN left(subject, 4) = 'usr_' THEN 'person'
                         ELSE 'service' END;
ALTER TABLE bench_judgements ALTER COLUMN voter_kind SET DEFAULT 'person';
ALTER TABLE bench_judgements ADD CONSTRAINT bench_judgements_voter_kind
    CHECK (voter_kind IS NULL OR voter_kind IN ('person', 'anon', 'service'));
CREATE INDEX bench_judgements_by_voter_kind ON bench_judgements (kind_id, voter_kind, at);

-- 2. The daily counters of the anonymous vote: one row per scope, key and UTC day.
--    scope is 'voter' (the hashed opaque id), 'ip' (the salted hash of the address, salted per day),
--    'relay' (the relaying service) or 'global'. The address itself is never written anywhere.
CREATE TABLE bench_anon_counters (
    scope text COLLATE "C" NOT NULL,     -- voter | ip | relay | global
    key   text COLLATE "C" NOT NULL,     -- the hashed voter id, the hashed address, the service, or 'all'
    day   text COLLATE "C" NOT NULL,     -- the UTC day, 'YYYY-MM-DD'
    count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, key, day),
    CONSTRAINT bench_anon_counters_count CHECK (count >= 0)
);
CREATE INDEX bench_anon_counters_day ON bench_anon_counters (day);

-- 3. The daily rounds job: what it planned for every kind, what it skipped and what it spent.
CREATE TABLE bench_daily_rounds (
    id           text COLLATE "C" PRIMARY KEY,   -- bdr_ + ULID
    day          text COLLATE "C" NOT NULL,      -- the UTC day, 'YYYY-MM-DD'
    kind_id      text COLLATE "C" NOT NULL,
    prompt       text,
    models       jsonb,
    task_id      text,
    round_id     text,
    estimated_usd numeric(12, 6) NOT NULL DEFAULT 0,
    spent_usd    numeric(12, 6),
    status       text COLLATE "C" NOT NULL,      -- planned | created | skipped | failed
    skip_reason  text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_daily_rounds_id CHECK (id ~ '^bdr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_daily_rounds_status CHECK (status IN ('planned', 'created', 'skipped', 'failed'))
);
CREATE UNIQUE INDEX bench_daily_rounds_day_kind ON bench_daily_rounds (day, kind_id);
CREATE INDEX bench_daily_rounds_day ON bench_daily_rounds (day);

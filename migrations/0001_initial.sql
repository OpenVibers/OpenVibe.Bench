-- phase: expand
-- OpenVibe.Bench (plan 2026-10-28 §4.12): the comparative-evaluation authority. Kinds, tasks, pinned rounds,
-- entries, judgements, ratings, private evals and the events outbox. Nothing written here is a credential; the
-- public dataset is anonymous by design and a judgement never carries a voter id into an export.

CREATE TABLE bench_kinds (
    id         text COLLATE "C" PRIMARY KEY,               -- e.g. design.page
    room       text COLLATE "C" NOT NULL,
    entry      text COLLATE "C" NOT NULL,
    judge      text COLLATE "C" NOT NULL,                  -- human_pairwise | rubric | automatic_grader | test_suite | game_outcome
    name       text NOT NULL,
    schema     jsonb NOT NULL DEFAULT '{}'::jsonb,
    metrics    jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_kinds_id CHECK (id ~ '^[a-z0-9]+(\.[a-z0-9]+)*$'),
    CONSTRAINT bench_kinds_room CHECK (length(room) BETWEEN 1 AND 40),
    CONSTRAINT bench_kinds_judge CHECK (judge IN ('human_pairwise', 'rubric', 'automatic_grader', 'test_suite', 'game_outcome'))
);

CREATE TABLE bench_tasks (
    id         text COLLATE "C" PRIMARY KEY,               -- btk_ + ULID
    kind_id    text COLLATE "C" NOT NULL REFERENCES bench_kinds (id),
    prompt     text NOT NULL,
    task_class text COLLATE "C",                           -- the class Route learns from
    public     boolean NOT NULL DEFAULT false,
    created_by text COLLATE "C" NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_tasks_id CHECK (id ~ '^btk_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_tasks_prompt CHECK (length(prompt) BETWEEN 1 AND 4000),
    CONSTRAINT bench_tasks_public CHECK (public IN (true, false))
);
CREATE INDEX bench_tasks_by_kind ON bench_tasks (kind_id, created_at DESC);

CREATE TABLE bench_rounds (
    id            text COLLATE "C" PRIMARY KEY,            -- brd_ + ULID
    task_id       text COLLATE "C" NOT NULL REFERENCES bench_tasks (id),
    kind_id       text COLLATE "C" NOT NULL REFERENCES bench_kinds (id),
    offers        jsonb NOT NULL DEFAULT '[]'::jsonb,      -- pinned { provider, model, version?, params? }
    status        text COLLATE "C" NOT NULL DEFAULT 'queued', -- queued | running | ready | finished | failed
    seed          integer NOT NULL DEFAULT 0,
    params        jsonb NOT NULL DEFAULT '{}'::jsonb,
    pool_fallback boolean NOT NULL DEFAULT false,
    receipt       text COLLATE "C",                        -- sha256 of the finished round's reproducible parts
    created_by    text COLLATE "C" NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    CONSTRAINT bench_rounds_id CHECK (id ~ '^brd_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_rounds_status CHECK (status IN ('queued', 'running', 'ready', 'finished', 'failed')),
    CONSTRAINT bench_rounds_receipt CHECK (receipt IS NULL OR receipt ~ '^[0-9a-f]{64}$')
);
CREATE INDEX bench_rounds_status_created ON bench_rounds (status, created_at);
CREATE INDEX bench_rounds_by_kind ON bench_rounds (kind_id, created_at DESC);
CREATE INDEX bench_rounds_by_creator ON bench_rounds (created_by, created_at DESC);

CREATE TABLE bench_entries (
    id         text COLLATE "C" PRIMARY KEY,               -- bte_ + ULID
    round_id   text COLLATE "C" NOT NULL REFERENCES bench_rounds (id) ON DELETE CASCADE,
    provider   text COLLATE "C" NOT NULL,
    model      text COLLATE "C" NOT NULL,
    route      jsonb NOT NULL DEFAULT '{}'::jsonb,         -- the route that produced the entry
    payload    jsonb NOT NULL DEFAULT '{}'::jsonb,         -- the output (html, patch, transcript, game result, ...)
    cost_usd   numeric(12, 6) NOT NULL DEFAULT 0,
    ms         integer NOT NULL DEFAULT 0,
    tokens     integer NOT NULL DEFAULT 0,
    error      text,
    ui_check   jsonb,
    run_id     text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_entries_id CHECK (id ~ '^bte_[0-9A-HJKMNP-TV-Z]{26}$')
);
CREATE INDEX bench_entries_by_round ON bench_entries (round_id);
CREATE INDEX bench_entries_by_model ON bench_entries (model);

CREATE TABLE bench_judgements (
    id            text COLLATE "C" PRIMARY KEY,            -- bju_ + ULID
    round_id      text COLLATE "C" NOT NULL REFERENCES bench_rounds (id) ON DELETE CASCADE,
    kind_id       text COLLATE "C" NOT NULL REFERENCES bench_kinds (id),
    judge         text COLLATE "C" NOT NULL,               -- the kind's judge
    judge_name    text,                                    -- named automatic grader / test suite
    judge_version text,
    method        text COLLATE "C" NOT NULL,               -- the kind's judge
    pair          jsonb,                                   -- { left, right } for a pairwise judgement
    outcome       text COLLATE "C",                        -- left | right | tie | both_bad | pass | fail | draw
    score         numeric(12, 6),
    subject       text COLLATE "C",                        -- the person (usr_…) or service; never in the open dataset
    at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_judgements_id CHECK (id ~ '^bju_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_judgements_method CHECK (method IN ('human_pairwise', 'rubric', 'automatic_grader', 'test_suite', 'game_outcome')),
    CONSTRAINT bench_judgements_outcome CHECK (outcome IS NULL OR outcome IN ('left', 'right', 'tie', 'both_bad', 'pass', 'fail', 'draw'))
);
CREATE INDEX bench_judgements_by_round ON bench_judgements (round_id, at);
CREATE INDEX bench_judgements_by_kind ON bench_judgements (kind_id, at);
CREATE INDEX bench_judgements_by_subject ON bench_judgements (subject, at);

CREATE TABLE bench_ratings (
    kind_id         text COLLATE "C" NOT NULL,
    category        text COLLATE "C" NOT NULL DEFAULT 'all',
    subject         text COLLATE "C" NOT NULL,             -- the reported model name
    elo             numeric(8, 2) NOT NULL DEFAULT 1000,
    games           integer NOT NULL DEFAULT 0,
    wins            integer NOT NULL DEFAULT 0,
    losses          integer NOT NULL DEFAULT 0,
    ties            integer NOT NULL DEFAULT 0,
    win_rate        numeric(8, 4) NOT NULL DEFAULT 0,
    ci_lower        numeric(8, 2),
    ci_upper        numeric(8, 2),
    median_cost_usd numeric(12, 6),
    median_ms       numeric(12, 1),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind_id, category, subject),
    CONSTRAINT bench_ratings_counters CHECK (games >= 0 AND wins >= 0 AND losses >= 0 AND ties >= 0)
);
CREATE INDEX bench_ratings_order ON bench_ratings (kind_id, category, elo DESC, games DESC);

CREATE TABLE bench_evals (
    id          text COLLATE "C" PRIMARY KEY,              -- bev_ + ULID
    owner       text COLLATE "C" NOT NULL,                 -- usr_… or prj_…; private by construction
    kind_id     text COLLATE "C" NOT NULL REFERENCES bench_kinds (id),
    name        text NOT NULL,
    test_suite  jsonb NOT NULL DEFAULT '[]'::jsonb,        -- the owner's held-out tasks
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_evals_id CHECK (id ~ '^bev_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_evals_name CHECK (length(name) BETWEEN 1 AND 160)
);
CREATE INDEX bench_evals_by_owner ON bench_evals (owner, created_at DESC);

CREATE TABLE bench_eval_runs (
    id         text COLLATE "C" PRIMARY KEY,               -- ber_ + ULID
    eval_id    text COLLATE "C" NOT NULL REFERENCES bench_evals (id) ON DELETE CASCADE,
    offers     jsonb NOT NULL DEFAULT '[]'::jsonb,
    status     text COLLATE "C" NOT NULL DEFAULT 'queued', -- queued | running | ready | failed
    results    jsonb,                                      -- private results, never in the public dataset
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    CONSTRAINT bench_eval_runs_id CHECK (id ~ '^ber_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_eval_runs_status CHECK (status IN ('queued', 'running', 'ready', 'failed'))
);
CREATE INDEX bench_eval_runs_by_eval ON bench_eval_runs (eval_id, created_at DESC);

-- The events outbox (Today's shape). A round.finished / judgement.recorded / rating.changed row is written in
-- the same transaction as the change; the publisher claims and sends it to OpenVibe.Events.
CREATE TABLE bench_outbox (
    event_id        text COLLATE "C" PRIMARY KEY,
    topic           text COLLATE "C" NOT NULL,
    payload         jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    published_at    timestamptz,
    attempts        integer NOT NULL DEFAULT 0,
    last_error      text,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    claimed_at      timestamptz,
    claimed_by      text
);
CREATE INDEX bench_outbox_pending ON bench_outbox (next_attempt_at) WHERE published_at IS NULL;

-- openvibe-sdk/account-data idempotency (ADR-033).
CREATE TABLE account_data_events (
    id         text PRIMARY KEY,
    kind       text NOT NULL,
    subject    text NOT NULL,
    outcome    jsonb,
    applied_at timestamptz NOT NULL DEFAULT now(),
    sent_at    timestamptz
);

-- Request telemetry (openvibe-sdk/telemetry).
CREATE TABLE telemetry_samples (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at                    timestamptz NOT NULL,
    service               text NOT NULL,
    project               text,
    subject               text,
    resource              text,
    provider              text,
    node                  text,
    cell                  text,
    region                text,
    operation             text NOT NULL,
    latency_ms            double precision,
    queue_delay_ms        double precision,
    ttfb_ms               double precision,
    throughput_per_second double precision,
    bytes                 bigint,
    status                text,
    cache_status          text,
    cost_estimate         double precision,
    route_epoch           bigint,
    trace_id              text,
    extra                 jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX telemetry_samples_at_idx ON telemetry_samples (at);
CREATE INDEX telemetry_samples_service_idx ON telemetry_samples (service, operation, at);

-- phase: expand
-- Provider fidelity (plan 2026-11-09, stage B5).
--
-- One row per measured offer and pass: the same open-weight model, served by one provider, asked the
-- fixed objective set. The score is passes / answered items with its Wilson interval; the answers
-- themselves are not kept, only which item passed. A provider that quantizes, truncates the context or
-- serves a different checkpoint scores lower on the same set, and the public read shows the difference
-- rather than a rank.
--
-- measured_at is when the pass ran; cost_usd is what the calls reported, so the daily cap can sum the
-- day's spend without a second ledger. results keeps the per-item verdicts (id, passed, error) for audit.
CREATE TABLE IF NOT EXISTS bench_fidelity_runs (
    id              text COLLATE "C" PRIMARY KEY,
    objective_set   text COLLATE "C" NOT NULL,
    model           text COLLATE "C" NOT NULL,            -- the model the provider claims to serve
    provider        text COLLATE "C" NOT NULL,
    provider_model  text COLLATE "C" NOT NULL,            -- the exact endpoint id that answered
    n               integer NOT NULL DEFAULT 0,           -- answered items (errors are counted apart)
    passed          integer NOT NULL DEFAULT 0,
    errors          integer NOT NULL DEFAULT 0,           -- items the provider did not answer
    score           double precision,                      -- passed / n, null when nothing was answered
    ci_lower        double precision,                      -- Wilson 95% interval
    ci_upper        double precision,
    cost_usd        double precision NOT NULL DEFAULT 0,
    measured_at     timestamptz NOT NULL,
    measured_on     date NOT NULL,
    results         jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bench_fidelity_latest_idx ON bench_fidelity_runs (provider, provider_model, measured_at DESC);
CREATE INDEX IF NOT EXISTS bench_fidelity_day_idx ON bench_fidelity_runs (measured_at);

-- The weekly job is due-based: its last pass survives restarts and deploys.
CREATE TABLE IF NOT EXISTS bench_fidelity_state (
    id              text COLLATE "C" PRIMARY KEY CHECK (id = 'fidelity'),
    last_run_at     timestamptz,
    last_status     text COLLATE "C",
    last_error      text COLLATE "C",
    updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO bench_fidelity_state (id) VALUES ('fidelity') ON CONFLICT (id) DO NOTHING;

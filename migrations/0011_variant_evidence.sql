-- phase: expand
-- P6 (plan 2026-11-04, G-P6 and ObservedPerformance): measured model-variant evidence.
--
-- One row is one observation batch for one exact id from one source. The exact id is the D3 form
-- <org>/<model>[:<quant>]@<revision>; the family is <org>/<model>, so the variants of one model group across
-- quants and revisions. The source is a pinned Bench round or an authenticated Run job / verified Bench run.
-- Nothing here is prompt or output text: only identifiers, counts and measurements are stored, so a private
-- benchmark's prompt can never leak through this table or its read API.

CREATE TABLE bench_variant_evidence (
    id                     text COLLATE "C" PRIMARY KEY,   -- bve_ + ULID
    exact_id               text COLLATE "C" NOT NULL,      -- org/model[:quant]@revision
    family                 text COLLATE "C" NOT NULL,      -- org/model
    quant                  text COLLATE "C",
    revision               text COLLATE "C",
    source_kind            text COLLATE "C" NOT NULL,      -- round | run
    source_id              text COLLATE "C" NOT NULL,      -- brd_…, brn_…, job_… or run_…
    provenance             jsonb NOT NULL DEFAULT '{}'::jsonb,
    measured_at            timestamptz NOT NULL,
    sample_count           integer NOT NULL,
    success_count          integer,
    timeout_count          integer,
    ttft_p50_ms            integer,
    ttft_p95_ms            integer,
    prefill_tokens_per_s   numeric(14, 3),
    decode_tokens_per_s    numeric(14, 3),
    cold_start_ms          integer,
    recorded_by            text COLLATE "C" NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bench_variant_evidence_id CHECK (id ~ '^bve_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT bench_variant_evidence_exact CHECK (length(exact_id) BETWEEN 3 AND 200),
    CONSTRAINT bench_variant_evidence_family CHECK (length(family) BETWEEN 3 AND 200),
    CONSTRAINT bench_variant_evidence_source CHECK (source_kind IN ('round', 'run')),
    CONSTRAINT bench_variant_evidence_source_id CHECK (length(source_id) BETWEEN 3 AND 200),
    CONSTRAINT bench_variant_evidence_samples CHECK (sample_count > 0),
    CONSTRAINT bench_variant_evidence_success CHECK (success_count IS NULL OR (success_count >= 0 AND success_count <= sample_count)),
    CONSTRAINT bench_variant_evidence_timeout CHECK (timeout_count IS NULL OR (timeout_count >= 0 AND timeout_count <= sample_count)),
    CONSTRAINT bench_variant_evidence_counts CHECK (success_count IS NULL OR timeout_count IS NULL OR success_count + timeout_count <= sample_count),
    CONSTRAINT bench_variant_evidence_ttft_p50 CHECK (ttft_p50_ms IS NULL OR ttft_p50_ms >= 0),
    CONSTRAINT bench_variant_evidence_ttft_p95 CHECK (ttft_p95_ms IS NULL OR ttft_p95_ms >= 0),
    CONSTRAINT bench_variant_evidence_ttft_order CHECK (ttft_p50_ms IS NULL OR ttft_p95_ms IS NULL OR ttft_p95_ms >= ttft_p50_ms),
    CONSTRAINT bench_variant_evidence_prefill CHECK (prefill_tokens_per_s IS NULL OR prefill_tokens_per_s >= 0),
    CONSTRAINT bench_variant_evidence_decode CHECK (decode_tokens_per_s IS NULL OR decode_tokens_per_s >= 0),
    CONSTRAINT bench_variant_evidence_cold CHECK (cold_start_ms IS NULL OR cold_start_ms >= 0),
    UNIQUE (exact_id, source_kind, source_id)
);
CREATE INDEX bench_variant_evidence_family ON bench_variant_evidence (family, measured_at DESC);
CREATE INDEX bench_variant_evidence_exact ON bench_variant_evidence (exact_id, measured_at DESC);

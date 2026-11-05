'use strict';

/**
 * P6 (plan 2026-11-04, G-P6 and ObservedPerformance): model-variant evidence.
 *
 * Bench is the evaluation authority, never an inference gateway. This module keeps the measured, typed evidence a
 * placement can read: one exact id (D3: org/model[:quant]@revision) per row, grouped by its family org/model across
 * quants and revisions. A row is written only when it names a finished pinned Bench round or an authenticated run,
 * and a model's own agent identity may never write evidence for itself.
 *
 * The numbers are stored as counts and integers so the read API cannot invent precision:
 *   - sample_count, success_count, timeout_count;
 *   - ttft_p50_ms, ttft_p95_ms, cold_start_ms (whole milliseconds);
 *   - prefill_tokens_per_s, decode_tokens_per_s (three decimal places).
 * No prompt, output, payload or transcript is accepted or stored. The read API never joins a task, benchmark or
 * entry, so private sets stay private.
 */

const ratingLib = require('../rating/lib');

const MAX_EXACT_ID = 200;
const MIN_SAMPLES = 10;
const MODERATE_SAMPLES = 30;
const HIGH_SAMPLES = 100;
const MAX_OBSERVATIONS = 5000;
const MAX_MS = 3_600_000;
const MAX_TPS = 1e7;

/** The D3 exact id: <org>/<model>[:<quant>]@<revision>, with the quant and the revision optional. */
const EXACT_ID_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?::([A-Za-z0-9][A-Za-z0-9._-]*))?(?:@([A-Za-z0-9][A-Za-z0-9._-]*))?$/;
const IDENTITY_PREFIX = /^(?:svc|service|app|mod|agent):/i;

const SELF_RATING = 'bench.self_rating';

class VariantEvidenceError extends Error {
    constructor(status, code, detail) {
        super(detail);
        this.name = 'VariantEvidenceError';
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}

const text = (v) => (v == null ? '' : String(v).trim());
const objectOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const firstDefined = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');
const round3 = (v) => (v == null ? null : Math.round(Number(v) * 1000) / 1000);
const round6 = (v) => (v == null ? null : Math.round(Number(v) * 1e6) / 1e6);
const numberOrNull = (v) => (v == null || v === '' ? null : Number(v));

function parseExactId(value) {
    const raw = text(value);
    if (!raw) return { ok: false, error: 'exact_id is required' };
    if (raw.length > MAX_EXACT_ID) return { ok: false, error: `exact_id must be at most ${MAX_EXACT_ID} characters` };
    const match = EXACT_ID_RE.exec(raw);
    if (!match) return { ok: false, error: 'exact_id must be org/model[:quant]@revision, with the quant and the revision optional' };
    const [, org, model, quant, revision] = match;
    return {
        ok: true,
        value: {
            exact_id: raw,
            org,
            model,
            family: `${org}/${model}`,
            quant: quant || null,
            revision: revision || null,
        },
    };
}

/** A family is exactly org/model: no quant and no revision. */
function parseFamily(value) {
    const raw = text(value);
    if (!raw || raw.length > MAX_EXACT_ID) return null;
    if (raw.includes(':') || raw.includes('@')) return null;
    const parsed = parseExactId(raw);
    if (!parsed.ok) return null;
    return parsed.value;
}

/**
 * How much weight the sample count carries. Sparse evidence is never hidden or filled in: it is returned with the
 * count that makes it sparse. The 10-sample line is the same provisional line the rest of Bench uses.
 */
function confidenceFor(samples) {
    const n = Number.isSafeInteger(Number(samples)) && Number(samples) >= 0 ? Number(samples) : 0;
    let level = 'none';
    if (n >= HIGH_SAMPLES) level = 'high';
    else if (n >= MODERATE_SAMPLES) level = 'moderate';
    else if (n >= MIN_SAMPLES) level = 'low';
    else if (n > 0) level = 'sparse';
    return { level, sparse: n < MIN_SAMPLES, samples: n, minimum_samples: MIN_SAMPLES };
}

function rateOf(count, sample) {
    if (count == null || !sample) return null;
    return round6(Number(count) / Number(sample));
}

function confidenceInterval(successes, samples) {
    if (successes == null || !samples) return null;
    const w = ratingLib.wilson(Number(successes), Number(samples));
    return { estimate: round6(w.p), lower: round6(w.lower), upper: round6(w.upper) };
}

function readInteger(errors, label, value, { min = 0, max = null } = {}) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'number' && typeof value !== 'string') {
        errors.push(`${label} must be a whole number`);
        return null;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || (max != null && n > max)) {
        errors.push(`${label} must be a whole number${max == null ? ` at least ${min}` : ` from ${min} to ${max}`}`);
        return null;
    }
    return n;
}

function readDecimal(errors, label, value, { min = 0, max = MAX_TPS } = {}) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'number' && typeof value !== 'string') {
        errors.push(`${label} must be a number`);
        return null;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) {
        errors.push(`${label} must be a number from ${min} to ${max}`);
        return null;
    }
    return n;
}

function readRate(errors, label, value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'number' && typeof value !== 'string') {
        errors.push(`${label} must be a fraction from 0 to 1`);
        return null;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
        errors.push(`${label} must be a fraction from 0 to 1`);
        return null;
    }
    return n;
}

function readSource(body) {
    const raw = body.source;
    const source = typeof raw === 'string' ? { id: raw } : objectOf(firstDefined(raw, body.provenance));
    let kind = text(firstDefined(source.kind, source.type)).toLowerCase();
    if (kind === 'pinned_round') kind = 'round';
    if (kind === 'run_job') kind = 'run';
    const roundId = firstDefined(source.round_id, body.round_id, body.pinned_round);
    const runId = firstDefined(source.run_id, body.run_id, body.job_id, body.run_job_id);
    const id = text(firstDefined(source.id, roundId, runId));
    if (!kind) kind = roundId ? 'round' : (runId ? 'run' : '');
    return { kind, id };
}

/**
 * Validate and normalize one observation. Unknown fields are ignored, never stored: a caller cannot smuggle prompt
 * or output text into an evidence row. Returns { ok: true, value } or { ok: false, errors }.
 */
function validateObservation(body, { now = new Date().toISOString() } = {}) {
    const input = objectOf(body);
    const errors = [];

    const exact = parseExactId(firstDefined(input.exact_id, input.exactId, input.model_id));
    if (!exact.ok) errors.push(exact.error);

    const source = readSource(input);
    if (!source.kind) errors.push('source.kind must be round or run');
    else if (source.kind !== 'round' && source.kind !== 'run') errors.push('source.kind must be round or run');
    if (!source.id) errors.push('source.id is required');
    else if (source.id.length > MAX_EXACT_ID) errors.push(`source.id must be at most ${MAX_EXACT_ID} characters`);
    if (source.kind === 'round' && source.id && !/^brd_[0-9A-HJKMNP-TV-Z]{26}$/.test(source.id)) {
        errors.push('a round source id must be a Bench round id (brd_…)');
    }
    if (source.kind === 'run' && source.id && !/^(?:brn|job)_[0-9A-HJKMNP-TV-Z]{26}$/.test(source.id) && !/^run_[A-Za-z0-9_-]{1,120}$/.test(source.id)) {
        errors.push('a run source id must be a Bench run id (brn_…), a Run job id (job_…) or an AI run id (run_…)');
    }

    const sampleCount = readInteger(errors, 'sample_count', firstDefined(input.sample_count, input.samples, input.n), { min: 1, max: 10_000_000 });

    const ttft = objectOf(firstDefined(input.ttft, input.ttft_ms));
    const ttftP50 = readInteger(errors, 'ttft_p50_ms', firstDefined(input.ttft_p50_ms, input.ttft_ms_p50, input.ttft_p50, ttft.p50_ms, ttft.p50), { min: 0, max: MAX_MS });
    const ttftP95 = readInteger(errors, 'ttft_p95_ms', firstDefined(input.ttft_p95_ms, input.ttft_ms_p95, input.ttft_p95, ttft.p95_ms, ttft.p95), { min: 0, max: MAX_MS });
    if (ttftP50 != null && ttftP95 != null && ttftP95 < ttftP50) errors.push('ttft_p95_ms must be at least ttft_p50_ms');

    const throughput = objectOf(input.throughput);
    const prefill = readDecimal(errors, 'prefill_tokens_per_s', firstDefined(
        input.prefill_tokens_per_s, input.prefill_tps, input.prefill_tokens_s,
        throughput.prefill_tokens_per_s, throughput.prefill_tps,
    ));
    const decode = readDecimal(errors, 'decode_tokens_per_s', firstDefined(
        input.decode_tokens_per_s, input.decode_tps, input.decode_tokens_s,
        throughput.decode_tokens_per_s, throughput.decode_tps,
    ));
    const coldStart = readInteger(errors, 'cold_start_ms', firstDefined(
        input.cold_start_ms, input.coldStartMs, typeof input.cold_start === 'number' ? input.cold_start : undefined,
        objectOf(input.cold_start).ms, objectOf(input.cold_start).cold_start_ms,
    ), { min: 0, max: MAX_MS });

    const successInfo = objectOf(input.success);
    const timeoutInfo = objectOf(input.timeout);
    const successCount = readInteger(errors, 'success_count', firstDefined(
        input.success_count, input.successes, successInfo.count, typeof input.success === 'number' ? input.success : undefined,
    ), { min: 0, max: sampleCount == null ? undefined : sampleCount });
    const timeoutCount = readInteger(errors, 'timeout_count', firstDefined(
        input.timeout_count, input.timeouts, timeoutInfo.count, typeof input.timeout === 'number' ? input.timeout : undefined,
    ), { min: 0, max: sampleCount == null ? undefined : sampleCount });
    const successRate = readRate(errors, 'success_rate', firstDefined(input.success_rate, successInfo.rate));
    const timeoutRate = readRate(errors, 'timeout_rate', firstDefined(input.timeout_rate, timeoutInfo.rate));

    let successes = successCount;
    let timeouts = timeoutCount;
    if (sampleCount != null) {
        if (successes == null && successRate != null) successes = Math.round(successRate * sampleCount);
        if (timeouts == null && timeoutRate != null) timeouts = Math.round(timeoutRate * sampleCount);
        if (successes != null && timeouts != null && successes + timeouts > sampleCount) {
            errors.push('success_count and timeout_count cannot add up to more than sample_count');
        }
    }

    let measuredAt = text(now) || new Date().toISOString();
    const measuredInput = firstDefined(input.measured_at, input.measuredAt, input.at);
    if (measuredInput != null) {
        const ms = Date.parse(measuredInput);
        if (!Number.isFinite(ms)) errors.push('measured_at must be an ISO timestamp');
        else measuredAt = new Date(ms).toISOString();
    }

    if (errors.length) return { ok: false, errors };
    return {
        ok: true,
        value: {
            exact_id: exact.value.exact_id,
            family: exact.value.family,
            org: exact.value.org,
            model: exact.value.model,
            quant: exact.value.quant,
            revision: exact.value.revision,
            source_kind: source.kind,
            source_id: source.id,
            sample_count: sampleCount,
            success_count: successes,
            timeout_count: timeouts,
            ttft_p50_ms: ttftP50,
            ttft_p95_ms: ttftP95,
            prefill_tokens_per_s: prefill == null ? null : round3(prefill),
            decode_tokens_per_s: decode == null ? null : round3(decode),
            cold_start_ms: coldStart,
            measured_at: measuredAt,
        },
    };
}

/** True when the caller is the model it is trying to measure. A model never rates itself. */
function isSelfRating(principal, value) {
    if (!principal || !value) return false;
    const claims = objectOf(principal.claims);
    const names = [value.exact_id, value.family, value.model, `${value.org}/${value.model}`]
        .filter(Boolean).map((v) => String(v).toLowerCase());
    const identities = [
        principal.requester,
        claims.sub,
        claims.model,
        claims.model_id,
        claims.exact_id,
        claims.model_key,
    ].filter(Boolean).map((v) => String(v).trim().toLowerCase());
    for (const identity of identities) {
        const id = identity.replace(IDENTITY_PREFIX, '');
        if (!id) continue;
        if (names.includes(id)) return true;
        const family = String(value.family || '').toLowerCase();
        if (family && id.startsWith(family)) {
            const rest = id.slice(family.length);
            if (!rest || rest.startsWith(':') || rest.startsWith('@')) return true;
        }
    }
    return false;
}

function wireObservation(row) {
    const samples = numberOrNull(row.sample_count) || 0;
    const successes = row.success_count == null ? null : numberOrNull(row.success_count);
    const timeouts = row.timeout_count == null ? null : numberOrNull(row.timeout_count);
    const provenance = typeof row.provenance === 'string' ? JSON.parse(row.provenance) : (row.provenance || {});
    return {
        id: row.id,
        exact_id: row.exact_id,
        family: row.family,
        quant: row.quant || null,
        revision: row.revision || null,
        sample_count: samples,
        success_count: successes,
        success_rate: rateOf(successes, samples),
        timeout_count: timeouts,
        timeout_rate: rateOf(timeouts, samples),
        metrics: {
            ttft_p50_ms: row.ttft_p50_ms == null ? null : numberOrNull(row.ttft_p50_ms),
            ttft_p95_ms: row.ttft_p95_ms == null ? null : numberOrNull(row.ttft_p95_ms),
            prefill_tokens_per_s: round3(numberOrNull(row.prefill_tokens_per_s)),
            decode_tokens_per_s: round3(numberOrNull(row.decode_tokens_per_s)),
            cold_start_ms: row.cold_start_ms == null ? null : numberOrNull(row.cold_start_ms),
        },
        measured_at: row.measured_at == null ? null : (row.measured_at instanceof Date ? row.measured_at.toISOString() : String(row.measured_at)),
        provenance,
        recorded_by: row.recorded_by,
        created_at: row.created_at == null ? null : (row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)),
    };
}

/** One exact id's evidence: every observation, plus the totals and the confidence they carry. */
function aggregateRows(exactId, rows) {
    const list = (rows || []).filter(Boolean);
    if (!list.length) return null;
    const parsed = parseExactId(exactId);
    const first = list[0];
    const observations = list.map(wireObservation).sort((a, b) => String(b.measured_at || '').localeCompare(String(a.measured_at || '')) || String(b.id).localeCompare(String(a.id)));
    const latest = observations[0] || null;
    const samples = observations.reduce((sum, o) => sum + (o.sample_count || 0), 0);
    // A rate is known only when every observation counts that outcome. A missing count is not a zero.
    const completeSuccess = observations.every((o) => o.success_count != null);
    const completeTimeout = observations.every((o) => o.timeout_count != null);
    const successes = completeSuccess ? observations.reduce((sum, o) => sum + (o.success_count || 0), 0) : null;
    const timeouts = completeTimeout ? observations.reduce((sum, o) => sum + (o.timeout_count || 0), 0) : null;
    const confidence = confidenceFor(samples);
    const successInterval = confidenceInterval(successes, samples);
    const timeoutInterval = confidenceInterval(timeouts, samples);
    if (successInterval) confidence.success_rate = successInterval;
    if (timeoutInterval) confidence.timeout_rate = timeoutInterval;
    const metrics = latest ? latest.metrics : {};
    return {
        exact_id: parsed.ok ? parsed.value.exact_id : String(exactId || ''),
        family: parsed.ok ? parsed.value.family : first.family,
        org: parsed.ok ? parsed.value.org : null,
        model: parsed.ok ? parsed.value.model : null,
        quant: parsed.ok ? parsed.value.quant : (first.quant || null),
        revision: parsed.ok ? parsed.value.revision : (first.revision || null),
        sample_count: samples,
        success_count: successes,
        success_rate: rateOf(successes, samples),
        timeout_count: timeouts,
        timeout_rate: rateOf(timeouts, samples),
        confidence,
        sparse: confidence.sparse,
        metrics,
        ...metrics,
        measured_at: latest ? latest.measured_at : null,
        provenance: latest ? latest.provenance : null,
        observations,
    };
}

/** Group evidence rows by exact id and then by family org/model. Pure, no I/O. */
function groupFamilies(rows) {
    const byFamily = new Map();
    for (const row of (rows || [])) {
        if (!row) continue;
        const parsed = parseExactId(row.exact_id);
        if (!parsed.ok) continue;
        const family = parsed.value.family;
        if (!byFamily.has(family)) byFamily.set(family, { org: parsed.value.org, model: parsed.value.model, rows: [] });
        byFamily.get(family).rows.push(row);
    }
    const families = [];
    for (const [family, group] of byFamily) {
        const byExact = new Map();
        for (const row of group.rows) {
            if (!byExact.has(row.exact_id)) byExact.set(row.exact_id, []);
            byExact.get(row.exact_id).push(row);
        }
        const variants = [...byExact.entries()].map(([exact, list]) => aggregateRows(exact, list)).filter(Boolean);
        variants.sort((a, b) => String(a.exact_id).localeCompare(String(b.exact_id)));
        families.push({
            family,
            org: group.org,
            model: group.model,
            variants,
            quants: [...new Set(variants.map((v) => v.quant).filter(Boolean))].sort(),
            revisions: [...new Set(variants.map((v) => v.revision).filter(Boolean))].sort(),
            sample_count: variants.reduce((sum, v) => sum + (v.sample_count || 0), 0),
        });
    }
    families.sort((a, b) => a.family.localeCompare(b.family));
    return families;
}

function createVariantEvidence({ s, log = console }) {
    async function sourceProvenance(sourceKind, sourceId) {
        if (sourceKind === 'round') {
            const row = await s.db.maybe('SELECT id, status, receipt FROM bench_rounds WHERE id = $1', [sourceId]);
            if (!row) throw new VariantEvidenceError(404, 'bench.round_not_found', 'No such Bench round.');
            if (row.status !== 'finished' || !row.receipt) {
                throw new VariantEvidenceError(409, 'bench.round_not_pinned', 'Evidence can only come from a finished, pinned round with a receipt.');
            }
            return { kind: 'round', id: row.id, receipt: row.receipt };
        }
        if (sourceId.startsWith('brn_')) {
            const row = await s.db.maybe('SELECT id, provenance FROM bench_runs WHERE id = $1', [sourceId]);
            if (!row) throw new VariantEvidenceError(404, 'bench.run_not_found', 'No such Bench run.');
            if (row.provenance !== 'verified') {
                throw new VariantEvidenceError(409, 'bench.run_not_verified', 'Evidence can only come from a verified run.');
            }
            return { kind: 'run', id: row.id, verified: true, bench_run_id: row.id };
        }
        const viaRun = await s.db.maybe(
            `SELECT id FROM bench_runs
              WHERE provenance = 'verified' AND executor->>'kind' = 'run' AND executor->>'id' = $1
              ORDER BY created_at DESC, id LIMIT 1`,
            [sourceId],
        ).catch(() => null);
        return {
            kind: 'run',
            id: sourceId,
            verified: Boolean(viaRun),
            executor: sourceId.startsWith('job_') ? 'run' : 'ai',
            bench_run_id: viaRun ? viaRun.id : null,
        };
    }

    async function record(value, { createdBy }) {
        const provenance = await sourceProvenance(value.source_kind, value.source_id);
        const row = await s.db.maybe(
            `INSERT INTO bench_variant_evidence
                (id, exact_id, family, quant, revision, source_kind, source_id, provenance, measured_at,
                 sample_count, success_count, timeout_count, ttft_p50_ms, ttft_p95_ms, prefill_tokens_per_s,
                 decode_tokens_per_s, cold_start_ms, recorded_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz,
                 $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::timestamptz)
             ON CONFLICT (exact_id, source_kind, source_id) DO UPDATE SET
                 family = EXCLUDED.family, quant = EXCLUDED.quant, revision = EXCLUDED.revision,
                 provenance = EXCLUDED.provenance, measured_at = EXCLUDED.measured_at,
                 sample_count = EXCLUDED.sample_count, success_count = EXCLUDED.success_count,
                 timeout_count = EXCLUDED.timeout_count, ttft_p50_ms = EXCLUDED.ttft_p50_ms,
                 ttft_p95_ms = EXCLUDED.ttft_p95_ms, prefill_tokens_per_s = EXCLUDED.prefill_tokens_per_s,
                 decode_tokens_per_s = EXCLUDED.decode_tokens_per_s, cold_start_ms = EXCLUDED.cold_start_ms,
                 recorded_by = EXCLUDED.recorded_by
             RETURNING *`,
            [s.newId('bve'), value.exact_id, value.family, value.quant, value.revision, value.source_kind, value.source_id,
                JSON.stringify(provenance), value.measured_at, value.sample_count, value.success_count, value.timeout_count,
                value.ttft_p50_ms, value.ttft_p95_ms, value.prefill_tokens_per_s, value.decode_tokens_per_s,
                value.cold_start_ms, String(createdBy || 'service:unknown').slice(0, 200), s.iso()],
        );
        return aggregateRows(value.exact_id, [row]);
    }

    async function rowsFor({ family = null, exactId = null } = {}) {
        const clauses = [];
        const params = [];
        if (family) { params.push(String(family)); clauses.push(`family = $${params.length}`); }
        if (exactId) { params.push(String(exactId)); clauses.push(`exact_id = $${params.length}`); }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        return await s.db.many(
            `SELECT * FROM bench_variant_evidence ${where}
              ORDER BY measured_at DESC, created_at DESC, id DESC LIMIT ${MAX_OBSERVATIONS}`,
            params,
        );
    }

    async function families() {
        return groupFamilies(await rowsFor());
    }

    async function family(familyValue) {
        const parsed = parseFamily(familyValue);
        if (!parsed) return null;
        const rows = await rowsFor({ family: parsed.family });
        if (!rows.length) return null;
        return groupFamilies(rows)[0] || null;
    }

    async function list({ family: familyValue = null, exactId = null } = {}) {
        if (exactId) {
            const one = await get(exactId);
            return one ? [one] : [];
        }
        const rows = await rowsFor({ family: familyValue ? text(familyValue) : null });
        const byExact = new Map();
        for (const row of rows) {
            if (!byExact.has(row.exact_id)) byExact.set(row.exact_id, []);
            byExact.get(row.exact_id).push(row);
        }
        return [...byExact.entries()].map(([exact, listOfRows]) => aggregateRows(exact, listOfRows)).filter(Boolean)
            .sort((a, b) => a.family.localeCompare(b.family) || String(a.exact_id).localeCompare(String(b.exact_id)));
    }

    async function get(exactId) {
        const parsed = parseExactId(exactId);
        if (!parsed.ok) return null;
        const rows = await rowsFor({ exactId: parsed.value.exact_id });
        return aggregateRows(parsed.value.exact_id, rows);
    }

    return { record, families, family, list, get, sourceProvenance };
}

module.exports = {
    parseExactId,
    parseFamily,
    confidenceFor,
    validateObservation,
    isSelfRating,
    aggregateRows,
    groupFamilies,
    wireObservation,
    createVariantEvidence,
    VariantEvidenceError,
    MIN_SAMPLES,
    MAX_EXACT_ID,
    SELF_RATING,
};

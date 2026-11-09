'use strict';

/**
 * The 18+ board's view of OpenVibe.AI's measurements (plan 2026-11-09, stage B4).
 *
 * The prompts, the refusal/hedge classifiers and the abliteration tax live in OpenVibe.AI, the service
 * that measures offers. Bench declares the `chat.willing` kind and shows the numbers. This module reads
 * AI's public read API, maps the rows to the board's shape, and keeps a short cache so a busy Report
 * page does not turn one board into a stream of upstream calls.
 *
 * If AI cannot be reached, the board does not invent rows: it says the measurements are unavailable
 * and keeps `adult: true`. A missing number stays missing (the house's "missing is not zero" rule).
 */

const CACHE_MS = 60_000;
const ADULT = true;

const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const ci = (value) => (value && num(value.lower) !== null && num(value.upper) !== null
    ? { lower: num(value.lower), upper: num(value.upper) }
    : null);

function mapRows(payload) {
    const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
    return rows.map((row) => ({
        subject: row.model,
        provider: row.provider,
        offer_id: row.offer_id || null,
        adult: ADULT,
        n: num(row.n),
        refusals: num(row.refusals),
        hedges: num(row.hedges),
        refusal_rate: num(row.refusal_rate),
        hedge_rate: num(row.hedge_rate),
        refusal_ci: ci(row.refusal_ci),
        hedge_ci: ci(row.hedge_ci),
        prompt_set: row.prompt_set || null,
        measured_on: row.measured_on || null,
    }));
}

function mapTax(payload) {
    const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
    return {
        pairs_version: (payload && payload.pairs_version) || null,
        objective_set: (payload && payload.objective_set) || null,
        objective_items: num(payload && payload.objective_items),
        measured_on: (payload && payload.measured_on) || null,
        pairs: rows.map((row) => ({
            pair_id: row.pair_id,
            family: row.family || null,
            adult: ADULT,
            base: {
                provider: row.base && row.base.provider,
                model: row.base && row.base.model,
                n: num(row.base && row.base.n),
                passed: num(row.base && row.base.passed),
                rate: num(row.base && row.base.rate),
            },
            abliterated: {
                provider: row.abliterated && row.abliterated.provider,
                model: row.abliterated && row.abliterated.model,
                n: num(row.abliterated && row.abliterated.n),
                passed: num(row.abliterated && row.abliterated.passed),
                rate: num(row.abliterated && row.abliterated.rate),
            },
            difference: num(row.difference),
            ci: ci(row.ci),
            source: row.source || null,
            measured_on: row.measured_on || null,
        })),
    };
}

function empty(reason, error = null) {
    return {
        adult: ADULT,
        prompt_set: null,
        prompts: null,
        measured_on: null,
        rows: [],
        abliteration: { pairs_version: null, objective_set: null, objective_items: null, measured_on: null, pairs: [] },
        unavailable: true,
        error,
        note: reason,
    };
}

/**
 * Read the 18+ board. `ai` is Bench's gateway (server/bench/ai.js); a test passes its own object.
 * → { adult: true, prompt_set, prompts, measured_on, rows, abliteration, unavailable }
 */
function createWillingReader({ ai = null, log = console, now = () => Date.now() } = {}) {
    let cache = null;

    async function read() {
        if (!ai || typeof ai.willingness !== 'function' || typeof ai.abliterationTax !== 'function') {
            return empty('The 18+ measurements are not configured on this Bench.');
        }
        if (cache && now() - cache.at < CACHE_MS) return cache.value;
        try {
            const [willingness, tax] = await Promise.all([ai.willingness(), ai.abliterationTax()]);
            const value = {
                adult: ADULT,
                prompt_set: (willingness && willingness.prompt_set) || null,
                prompts: num(willingness && willingness.prompts),
                measured_on: (willingness && willingness.measured_on) || null,
                rows: mapRows(willingness),
                abliteration: mapTax(tax),
                unavailable: false,
                error: null,
                note: Array.isArray(willingness && willingness.rows) && willingness.rows.length
                    ? null
                    : (willingness && willingness.note) || 'No offer has been measured on this prompt set yet.',
            };
            cache = { at: now(), value };
            return value;
        } catch (err) {
            log.warn('[OpenVibe.Bench] the 18+ measurements are unavailable: ' + String((err && err.message) || err));
            // Do not cache a failure: the next request asks again.
            return empty('The 18+ measurements are unavailable right now.', 'ai.unavailable');
        }
    }

    return { read, get cached() { return cache ? cache.value : null; } };
}

module.exports = { createWillingReader, mapRows, mapTax, CACHE_MS };

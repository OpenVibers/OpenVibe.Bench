'use strict';

/**
 * Provider fidelity (plan 2026-11-09, stage B5).
 *
 * OpenVibe.AI routes; this module measures. For every popular open-weight model the network routes, it
 * finds every enabled provider that serves that model in AI's public market feed, asks each offer the
 * fixed objective set, and scores the answers deterministically. A provider that quantizes, truncates
 * the context or serves another checkpoint answers fewer items correctly; the score is a pass rate with
 * a Wilson interval and the sample size beside it, never a rank or a bare winner.
 *
 * Money: the owner's switch is off by default; a pass has a daily cap in US dollars and a call cap. The
 * dry run lists every call and what the pricebook says it would cost before anything is spent. Every
 * call goes through AI's normal generate path (its own reserve/settle accounting), pinned to the exact
 * provider and model, with a durable idempotency key per prompt and week, so a retried pass is not
 * charged twice. The answers never leave this service: the table stores only which item passed.
 */
const crypto = require('crypto');
const { OBJECTIVE_SET, SYSTEM, ITEMS, check, promptTokens, publicSet } = require('./fidelity-set');

const ERROR_MAX = 300;
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (v) => (v == null ? null : Math.round(Number(v) * 1e6) / 1e6);
// PostgreSQL returns `date` as a JS Date; PGlite returns the string. Both are the same day.
const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

class FidelityError extends Error {
    constructor(status, code, detail) {
        super(detail);
        this.name = 'FidelityError';
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}

/** The Wilson score interval at 95%: an honest band around a pass rate with few items. */
function wilson(passed, n, z = 1.96) {
    if (!Number.isFinite(n) || n <= 0) return { lower: null, upper: null };
    const p = Math.max(0, Math.min(1, passed / n));
    const d = 1 + (z * z) / n;
    const centre = (p + (z * z) / (2 * n)) / d;
    const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    return { lower: Math.max(0, round(centre - half)), upper: Math.min(1, round(centre + half)) };
}

/** The Monday 00:00 UTC of the week a moment falls in, and the key the idempotency of a pass uses. */
function weekOf(ms) {
    const d = new Date(ms);
    const day = (d.getUTCDay() + 6) % 7;
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
    return { start, key: new Date(start).toISOString().slice(0, 10) };
}

function startOfUtcDay(ms) {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The planned cost of one item on one offer, from the market's own-page price. Null when unknown. */
function estimateItem(item, price) {
    const inPrice = num(price && price.in);
    const outPrice = num(price && price.out);
    if (inPrice == null || outPrice == null) return null;
    return round(((promptTokens(item) / 1e6) * inPrice) + ((item.max_tokens / 1e6) * outPrice));
}

const idempotencyKey = (weekKey, provider, providerModel, itemId) => {
    const digest = crypto.createHash('sha256')
        .update(`${OBJECTIVE_SET}\0${weekKey}\0${provider}\0${providerModel}\0${itemId}`, 'utf8')
        .digest('hex')
        .slice(0, 40);
    return `fid_${digest}`;
};

function keyOf(provider, providerModel) {
    return `${String(provider || '').toLowerCase()}\0${String(providerModel || '').toLowerCase()}`;
}

/**
 * The public read: the latest measurement of every offer, grouped by the model it serves. No row means
 * nobody measured that offer; the field is absent there, never a zero.
 */
function createFidelity({ s, ai, config, clock = { now: () => Date.now() }, log = console } = {}) {
    const cfg = (config && config.bench && config.bench.fidelity) || {};
    const dailyCapUsd = Math.max(0, num(cfg.dailyCapUsd) == null ? 0 : num(cfg.dailyCapUsd));
    const maxModels = Math.max(1, Number(cfg.maxModels) || 10);
    const maxCalls = Math.max(1, Number(cfg.maxCallsPerRun) || 60);
    const minAnswered = Math.max(1, Number(cfg.minAnswered) || Math.min(5, ITEMS.length));

    const latest = s.db.prepare(`SELECT DISTINCT ON (provider, provider_model)
        provider, provider_model, model, n, passed, errors, score, ci_lower, ci_upper, measured_at, measured_on, objective_set
        FROM bench_fidelity_runs WHERE objective_set = ?
        ORDER BY provider, provider_model, measured_at DESC, id DESC`);
    const spent = s.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM bench_fidelity_runs WHERE measured_at >= ?');
    const insert = s.db.prepare(`INSERT INTO bench_fidelity_runs
        (id, objective_set, model, provider, provider_model, n, passed, errors, score, ci_lower, ci_upper, cost_usd, measured_at, measured_on, results)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::date, ?::jsonb)`);
    const state = s.db.prepare(`UPDATE bench_fidelity_state SET last_run_at = ?::timestamptz, last_status = ?, last_error = ?,
        updated_at = now() WHERE id = 'fidelity'`);
    const stateRow = s.db.prepare("SELECT last_run_at, last_status, last_error FROM bench_fidelity_state WHERE id = 'fidelity'");

    async function todaySpent() {
        const row = await spent.get(new Date(startOfUtcDay(clock.now())).toISOString());
        return Number(row && row.usd) || 0;
    }

    /** The public market: every own-page offer, enabled or not. A missing client is a plain 503. */
    async function market() {
        if (!ai || typeof ai.market !== 'function') throw new FidelityError(503, 'fidelity.unavailable', 'OpenVibe.AI market readings are not configured for Bench.');
        let body;
        try {
            body = await ai.market({ openWeights: true, limit: 500 });
        } catch (err) {
            throw new FidelityError(503, 'fidelity.market_unavailable', `OpenVibe.AI's market feed is unavailable: ${String((err && (err.detail || err.message)) || err).slice(0, ERROR_MAX)}`);
        }
        const offers = Array.isArray(body && body.offers) ? body.offers : [];
        if (!offers.length && body && body.error) throw new FidelityError(503, 'fidelity.market_unavailable', 'OpenVibe.AI returned no market offers.');
        return offers;
    }

    /** The offers worth measuring: open weights, routed, chat, a real provider and endpoint id. */
    function eligible(offers) {
        const out = [];
        for (const offer of offers) {
            if (!offer || typeof offer !== 'object') continue;
            if (offer.open_weights !== true || offer.routed !== true) continue;
            if (offer.kind != null && offer.kind !== 'chat') continue;
            const provider = String(offer.provider || '').trim();
            const providerModel = String(offer.provider_model || offer.model || '').trim();
            const model = String(offer.model || providerModel).trim();
            if (!provider || !providerModel || !model) continue;
            out.push({ model, provider, provider_model: providerModel, name: offer.name || providerModel, price: offer.price || null });
        }
        return out;
    }

    function groupByModel(offers) {
        const groups = new Map();
        for (const offer of offers) {
            if (!groups.has(offer.model)) groups.set(offer.model, []);
            groups.get(offer.model).push(offer);
        }
        return [...groups.entries()]
            .map(([model, list]) => ({ model, offers: list.sort((a, b) => a.provider.localeCompare(b.provider) || a.provider_model.localeCompare(b.provider_model)) }))
            // "Popular" means served by more providers first; the cap keeps a pass inside the owner's call budget.
            .sort((a, b) => b.offers.length - a.offers.length || a.model.localeCompare(b.model))
            .slice(0, maxModels);
    }

    /**
     * What a pass would do, and what the pricebook says it would cost. Every offer says whether it is
     * included and, when it is not, the plain reason: no price, a disabled switch, the daily cap or the
     * call cap. The plan never spends anything.
     */
    async function plan() {
        const available = eligible(await market());
        const groups = groupByModel(available);
        const spentUsd = await todaySpent();
        const remaining = Math.max(0, dailyCapUsd - spentUsd);
        let calls = 0;
        let estimated = 0;
        const offers = [];
        for (const group of groups) {
            for (const offer of group.offers) {
                const estimates = ITEMS.map((item) => estimateItem(item, offer.price));
                const offerEstimate = estimates.some((v) => v == null) ? null : round(estimates.reduce((a, b) => a + b, 0));
                const offerCalls = ITEMS.length;
                let included = true;
                let reason = null;
                if (offerEstimate == null) { included = false; reason = 'the market has no own-page price for this offer'; }
                else if (calls + offerCalls > maxCalls) { included = false; reason = `the pass is capped at ${maxCalls} calls`; }
                else if (estimated + offerEstimate > remaining) { included = false; reason = `the daily cap leaves $${round(remaining - estimated)}`; }
                if (included) { calls += offerCalls; estimated = round(estimated + offerEstimate); }
                offers.push({
                    model: group.model, provider: offer.provider, provider_model: offer.provider_model, name: offer.name,
                    price: offer.price, calls: offerCalls, estimated_usd: offerEstimate, included, reason,
                });
            }
        }
        return {
            $schema: 'exchange.fidelity.plan@1',
            dry_run: true,
            generated_at: new Date(clock.now()).toISOString(),
            objective_set: OBJECTIVE_SET,
            items: ITEMS.length,
            enabled: Boolean(cfg.enabled),
            daily: { cap_usd: round(dailyCapUsd), spent_usd: round(spentUsd), remaining_usd: round(remaining) },
            limits: { max_models: maxModels, max_calls: maxCalls },
            models: groups.map((g) => ({ model: g.model, offers: g.offers.length })),
            offers,
            calls,
            estimated_usd: estimated,
        };
    }

    /** One bounded pass. Default off; returns what it measured, and never starts when nothing fits. */
    async function run({ trigger = 'manual' } = {}) {
        if (!cfg.enabled) throw new FidelityError(503, 'fidelity.disabled', 'Provider fidelity is off: the owner turns it on with BENCH_FIDELITY=1.');
        const before = await plan();
        const week = weekOf(clock.now());
        const measuredAt = new Date(clock.now()).toISOString();
        const measuredOn = measuredAt.slice(0, 10);
        const ran = [];
        let calls = 0;
        let spentUsd = 0;
        const included = before.offers.filter((offer) => offer.included);
        for (const offer of included) {
            if (calls >= maxCalls) break;
            if (dailyCapUsd > 0 && spentUsd >= dailyCapUsd) break;
            const results = [];
            let passed = 0;
            let answered = 0;
            let errors = 0;
            let cost = 0;
            for (const item of ITEMS) {
                if (calls >= maxCalls) break;
                calls += 1;
                try {
                    if (!ai || typeof ai.generate !== 'function') throw new FidelityError(503, 'fidelity.unavailable', 'AI generation is not configured for Bench.');
                    const out = await ai.generate({
                        prompt: item.prompt,
                        kind: 'text.answer',
                        slot: { provider: offer.provider, model: offer.provider_model },
                        system: SYSTEM,
                        maxTokens: item.max_tokens,
                        temperature: 0,
                        idempotencyKey: idempotencyKey(week.key, offer.provider, offer.provider_model, item.id),
                    });
                    cost += Number(out.cost_usd) || 0;
                    spentUsd += Number(out.cost_usd) || 0;
                    const verdict = check(item, out.html || out.text || '');
                    answered += 1;
                    if (verdict.passed) passed += 1;
                    results.push({ id: item.id, passed: verdict.passed, reason: verdict.reason, ms: out.ms == null ? null : out.ms });
                } catch (err) {
                    errors += 1;
                    results.push({ id: item.id, error: String((err && (err.detail || err.code || err.message)) || err).slice(0, ERROR_MAX) });
                }
            }
            if (answered < minAnswered) {
                log.warn(`[OpenVibe.Bench] fidelity: ${offer.provider}/${offer.provider_model} answered ${answered} of ${ITEMS.length}; no score stored`);
                continue;
            }
            const score = round(passed / answered);
            const interval = wilson(passed, answered);
            const id = s.newId('fid');
            await insert.run(id, OBJECTIVE_SET, offer.model, offer.provider, offer.provider_model, answered, passed, errors,
                score, interval.lower, interval.upper, round(cost), measuredAt, measuredOn, JSON.stringify(results));
            ran.push({ model: offer.model, provider: offer.provider, provider_model: offer.provider_model, n: answered, passed, errors, score, interval });
        }
        await state.run(measuredAt, 'ok', null).catch((err) => log.warn('[OpenVibe.Bench] fidelity state:', (err && err.message) || err));
        log.log(`[OpenVibe.Bench] fidelity ${trigger}: measured ${ran.length} offer(s), ${calls} call(s), $${round(spentUsd)}`);
        return { dry_run: false, generated_at: new Date(clock.now()).toISOString(), objective_set: OBJECTIVE_SET, ran, calls, spent_usd: round(spentUsd) };
    }

    /** The latest score of every offer. This is the shape OpenVibe.AI reads to put fidelity on an offer. */
    async function read() {
        const rows = await latest.all(OBJECTIVE_SET);
        const offers = (rows || []).map((row) => ({
            model: row.model,
            provider: row.provider,
            provider_model: row.provider_model,
            score: num(row.score),
            passed: Number(row.passed) || 0,
            n: Number(row.n) || 0,
            errors: Number(row.errors) || 0,
            interval: { lower: num(row.ci_lower), upper: num(row.ci_upper) },
            compared_to: row.model,
            prompt_set: row.objective_set,
            measured_at: s.iso(row.measured_at),
            measured_on: String(row.measured_on).slice(0, 10),
        })).sort((a, b) => a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider) || a.provider_model.localeCompare(b.provider_model));
        const models = new Map();
        for (const offer of offers) {
            const m = models.get(offer.model) || { model: offer.model, providers: new Set(), offers: 0, best_score: null };
            m.providers.add(offer.provider);
            m.offers += 1;
            if (offer.score != null && (m.best_score == null || offer.score > m.best_score)) m.best_score = offer.score;
            models.set(offer.model, m);
        }
        return {
            $schema: 'exchange.fidelity@1',
            objective_set: OBJECTIVE_SET,
            items: ITEMS.length,
            measured_on: offers.length ? offers.map((o) => o.measured_on).sort().slice(-1)[0] : null,
            offers,
            models: [...models.values()].map((m) => ({ model: m.model, providers: m.providers.size, offers: m.offers, best_score: m.best_score })),
            note: offers.length ? null : 'No offer has been measured on this objective set yet.',
        };
    }

    /** Whether the weekly pass is due (the state row survives restarts, like the price book's). */
    async function due() {
        const interval = Math.max(3600000, Number(cfg.intervalMs) || 7 * 24 * 3600000);
        const row = await stateRow.get();
        if (!row || !row.last_run_at) return true;
        return clock.now() - new Date(row.last_run_at).getTime() >= interval;
    }

    async function lastState() {
        const row = await stateRow.get();
        return row ? { last_run_at: s.iso(row.last_run_at), last_status: row.last_status || null, last_error: row.last_error || null } : null;
    }

    return { plan, run, read, due, lastState, objectiveSet: publicSet };
}

module.exports = { createFidelity, FidelityError, wilson, weekOf, estimateItem, idempotencyKey, keyOf, dayOf, OBJECTIVE_SET, ITEMS };

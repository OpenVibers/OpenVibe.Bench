'use strict';

/**
 * The pick (spec 3): the answer to "which model should I use for this job", read straight from the run data.
 *
 * Nothing here calls a model or a network service: the answer is the frontier of the kind — the models no other
 * model beats on both score and cost per solved task — with the numbers that produced it. A model with fewer than
 * three runs is greyed and says so; no number is ever invented.
 */

const { frontier } = require('./frontier');
const { parsePick } = require('./parser');
const { KINDS, kindById, SHOWCASE_KIND_IDS, PRIVATE_KIND_IDS } = require('../kinds');
const renderLib = require('../bench/render');
const { screenshotOf } = require('../http/gallery');

/** The price steps the form offers, in dollars a solved task. */
const PRICE_STEPS = Object.freeze([
    { value: 0.005, label: '0.5¢ a solved task' },
    { value: 0.02, label: '2¢ a solved task' },
    { value: 0.1, label: '10¢ a solved task' },
]);

/** Fewer runs than this and the numbers are too thin to stand on. */
const MIN_RUNS = 3;

const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));

function estimateExchangeTask(offer, inputTokens, outputTokens) {
    const input = Number(offer && offer.price && offer.price.in);
    const output = Number(offer && offer.price && offer.price.out);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
    return Math.round(((inputTokens * input + outputTokens * output) / 1e6) * 1e9) / 1e9;
}

function median(list) {
    const xs = list.map(Number).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!xs.length) return null;
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** The band each model sits in, from the style-controlled board. */
function bandMap(fit) {
    const out = new Map();
    const bands = (fit && fit.bands && fit.bands.controlled) || [];
    for (const band of bands) for (const model of band.models || []) out.set(model, band.label);
    return out;
}

/** The band a model sits in, from the board of one kind. */
async function boardForKind(ctx, kindId) {
    const board = require('../rating/board');
    return board.boardForKind(ctx, kindId);
}

/** The kind with the most runs, when the reader did not name one. */
async function busiestKind(ctx) {
    const rows = await ctx.s.db.many(
        `SELECT r.kind_id AS id, COUNT(e.id)::int AS n
           FROM bench_entries e JOIN bench_rounds r ON r.id = e.round_id
          WHERE e.error IS NULL AND NOT (r.kind_id = ANY($1::text[])) GROUP BY r.kind_id ORDER BY n DESC, r.kind_id LIMIT 1`, [PRIVATE_KIND_IDS]);
    if (rows && rows[0] && rows[0].id) return rows[0].id;
    return SHOWCASE_KIND_IDS[0] || 'games.play';
}

/** One model's newest output in the kind, the way the gallery shows it. */
async function sampleFor(ctx, kindId, model) {
    const rows = await ctx.s.db.many(
        `SELECT e.id, e.model, e.provider, e.cost_usd, e.ms, e.ui_check, r.id AS round_id, t.prompt
           FROM bench_entries e
           JOIN bench_rounds r ON r.id = e.round_id
           JOIN bench_tasks t ON t.id = r.task_id
          WHERE r.kind_id = $1 AND e.model = $2 AND e.error IS NULL AND r.status = 'finished'
          ORDER BY r.created_at DESC, e.id LIMIT 1`,
        [String(kindId), String(model)]);
    const row = rows && rows[0];
    if (!row) return null;
    return {
        id: row.id,
        round_id: row.round_id,
        prompt: row.prompt,
        model: row.model,
        provider: row.provider,
        cost_usd: num(row.cost_usd),
        ms: num(row.ms),
        screenshot: screenshotOf(row.ui_check),
        wrapper_url: renderLib.RENDER_ORIGIN + '/render/w/' + encodeURIComponent(row.id),
    };
}

/** Why the top pick is first, in one sentence, from the numbers. */
function whySentence(rows, kindName) {
    const top = rows[0];
    if (!top) return '';
    const rivals = rows.slice(1);
    const cents = (v) => (v == null ? 'an unknown price' : (Math.round(v * 10000) / 100) + '¢');
    const head = top.model + ' is first on ' + kindName + ' because no other model beats it on both score and cost per solved task: '
        + 'it scores ' + top.score + ' at ' + cents(top.cost_per_solved) + ' a solved task';
    if (!rivals.length) return head + ', and it is the only model with enough data to stand on.';
    // A rival is compared only when its runs can carry a number: a greyed one is too thin to say "lower" about.
    const rival = rivals.find((r) => !r.thin);
    if (!rival) return head + '. No other model has enough runs to compare with it yet.';
    const lower = rival.score < top.score
        ? 'scores lower (' + rival.score + ')'
        : 'costs more (' + cents(rival.cost_per_solved) + ')';
    return head + '. The closest, ' + rival.model + ', ' + lower + '.';
}

/**
 * The answer. Reads the controls (with the free text read first, so the words can set them), and returns the frontier
 * with every number that made it.
 */
async function answer(ctx, { kind = '', maxCost = null, minScore = null, inputTokens = 1000, outputTokens = 1000, fast = false, q = '', kinds = KINDS } = {}) {
    const parsed = q ? parsePick(q, { kinds }) : { kind: null, max_cost: null, fast: false, notes: [] };
    const kindId = parsed.kind || (kind && kindById(kind) ? kind : null) || await busiestKind(ctx);
    const price = parsed.max_cost != null ? parsed.max_cost : (maxCost == null || maxCost === '' ? null : Number(maxCost));
    const qualityBar = minScore == null || minScore === '' ? null : Number(minScore);
    const inputTokenBudget = Math.min(1000000, Math.max(0, num(inputTokens, 1000)));
    const outputTokenBudget = Math.min(1000000, Math.max(0, num(outputTokens, 1000)));
    const wantFast = parsed.fast || !!fast;

    const all = await ctx.bench.valueRows(kindId);
    let exchangeOffers = [];
    if (ctx.ai && typeof ctx.ai.market === 'function') {
        try {
            const market = await ctx.ai.market({ openWeights: false, limit: 500 });
            exchangeOffers = Array.isArray(market && market.offers) ? market.offers : [];
        } catch { /* Exchange prices may be temporarily unavailable; measured Bench costs remain available. */ }
    }
    const fit = await boardForKind(ctx, kindId);
    const bands = bandMap(fit && fit.fit);

    // The price comes first: a model over it is out whatever else it does.
    const qualified = qualityBar == null ? all : all.filter((r) => r.score >= qualityBar);
    const priced = price == null ? qualified : qualified.filter((r) => r.cost_per_solved != null && r.cost_per_solved <= price + 1e-9);

    // "Fast" is a time cap taken from the run data: the middle of the models' median times.
    const fastCap = wantFast ? median(priced.map((r) => r.median_ms).filter((v) => v > 0)) : null;
    const timed = fastCap == null ? priced : priced.filter((r) => !r.median_ms || r.median_ms <= fastCap + 1e-9);

    // The frontier maths works on { model, score, cost }: the cost is the cost per solved task.
    const comparable = timed.filter((r) => r.score != null && r.cost_per_solved != null)
        .map((r) => ({ ...r, model: r.subject, cost: r.cost_per_solved }));
    const front = frontier(comparable);
    const order = new Map(comparable.map((r, i) => [r.subject, i]));
    front.sort((a, b) => (qualityBar == null ? b.score - a.score : (a.cost_per_solved - b.cost_per_solved))
        || (b.score - a.score)
        || ((a.cost_per_solved == null ? Infinity : a.cost_per_solved) - (b.cost_per_solved == null ? Infinity : b.cost_per_solved))
        || a.subject.localeCompare(b.subject));

    const rowOffers = new Map();
    const currentPrices = [];
    for (const row of all) {
        const offers = exchangeOffers.filter((offer) => [offer.model, offer.provider_model].some((model) => String(model || '').toLowerCase() === row.subject.toLowerCase()));
        const pricedOffers = offers.map((offer) => ({
            provider: offer.provider || null,
            provider_model: offer.provider_model || null,
            price: offer.price || null,
            checked_at: offer.checked_at || offer.updated_at || null,
            estimated_task_cost_usd: estimateExchangeTask(offer, inputTokenBudget, outputTokenBudget),
        }));
        rowOffers.set(row.subject, pricedOffers);
        if (qualityBar != null && row.score >= qualityBar && row.runs >= MIN_RUNS) {
            for (const offer of pricedOffers) if (offer.estimated_task_cost_usd != null) currentPrices.push({
                model: row.subject, score: row.score, cost_usd: offer.estimated_task_cost_usd,
                provider: offer.provider, provider_model: offer.provider_model, price: offer.price, checked_at: offer.checked_at,
            });
        }
    }
    const withinCurrentPrice = price == null ? currentPrices : currentPrices.filter((offer) => offer.cost_usd <= price + 1e-9);
    withinCurrentPrice.sort((a, b) => a.cost_usd - b.cost_usd || b.score - a.score || a.model.localeCompare(b.model));

    const rows = [];
    for (const r of front) {
        rows.push({
            model: r.subject,
            score: r.score,
            band: bands.get(r.subject) || null,
            votes: r.votes,
            cost_per_solved: r.cost_per_solved,
            median_ms: r.median_ms,
            runs: r.runs,
            thin: r.runs < MIN_RUNS,
            exchange_offers: rowOffers.get(r.subject) || [],
            sample: await sampleFor(ctx, kindId, r.subject),
        });
    }

    const kindInfo = kindById(kindId) || { id: kindId, name: kindId };
    const onFront = new Set(front.map((r) => r.subject));
    const alsoRan = timed.filter((r) => !onFront.has(r.subject)).map((r) => ({
        model: r.subject,
        score: r.score,
        cost_per_solved: r.cost_per_solved,
        median_ms: r.median_ms,
        runs: r.runs,
        thin: r.runs < MIN_RUNS,
    }));
    const others = alsoRan.length;
    const thinElsewhere = alsoRan.filter((r) => r.thin).length;

    return {
        kind: { id: kindInfo.id, name: kindInfo.name, room: kindInfo.room || null },
        controls: {
            kind: kindId,
            max_cost: price == null ? null : price,
            min_score: qualityBar,
            fast: wantFast,
            q: String(q || ''),
            notes: parsed.notes || [],
        },
        filters: { max_cost: price == null ? null : price, min_score: qualityBar, fast: wantFast, fast_cap_ms: fastCap, min_runs: MIN_RUNS },
        price_assumptions: { input_tokens: inputTokenBudget, output_tokens: outputTokenBudget, exchange_price_unit: 'USD per million tokens' },
        cheapest_that_clears_quality_bar: qualityBar == null ? null : (withinCurrentPrice[0] || null),
        cheapest_that_clears_quality_bar_reason: qualityBar == null ? 'Set min_score to choose the cheapest current Exchange offer among models clearing a measured Bench quality bar.'
            : (withinCurrentPrice.length ? null : `No exact Bench model and Exchange offer match with a current input and output price was found among models with at least ${MIN_RUNS} runs within the selected cost limit.`),
        rows,
        also_ran: alsoRan,
        why: whySentence(rows, kindInfo.name),
        counts: { models: all.length, qualified: qualified.length, priced: priced.length, timed: timed.length, frontier: rows.length, others, thin_elsewhere: thinElsewhere },
        price_source: 'historical frontier uses measured Bench cost_per_solved; cheapest_that_clears_quality_bar uses current exact-match Exchange input/output prices and the stated token budgets',
        generated_at: new Date().toISOString(),
    };
}

module.exports = { answer, PRICE_STEPS, MIN_RUNS, median, bandMap, whySentence, estimateExchangeTask };

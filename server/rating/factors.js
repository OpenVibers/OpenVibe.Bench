'use strict';

/**
 * Model and harness, apart (compare-arena-ecosystem.md, bench.rating@1 1.1.0 `factors`, 2026-11-13).
 *
 * A coding agent is a harness driving a model, and the 2026 harness papers show the harness moves a score by 7 to 27
 * points: as much as the model. A board that rates `codex+gpt-5-mini` as one subject cannot say which half earned it.
 * This fit can. Every entrant is a sum of parameters:
 *
 *     model:M               θ = μ_M                       (on the neutral harness, whose effect is 0 by definition)
 *     harness:H@v           θ = η_H                       (a harness rated over a panel: its matches name agents)
 *     agent:H+M#cfg         θ = μ_M + η_H + γ_(M,H)
 *
 * and a match between two entrants is a conditional logit on their difference, with the outputs' style covariates:
 *
 *     P(a beats b) = sigmoid( θ_a − θ_b + Σ_k β_k (z_a,k − z_b,k) )
 *
 * The parameters are fitted together by Newton's method on the penalised log-likelihood. The penalties are the
 * partial pooling: small on μ and η (they are identified by many matches), large on γ (an interaction must earn its
 * place, so a harness's effect is shared across models until the data say otherwise). Because μ and η enter every
 * agent, a harness's effect has an estimate and an interval even with a model it never ran: it is learnt from its
 * runs with the other models.
 *
 * What a harness's effect means: its average over the models it ran with. The pooling centres the interactions within
 * each harness, so η_H is "how much H adds, on average", and γ is how much more or less it adds with one model.
 *
 * Identification: the neutral harness (`ov-bare`, mini-swe-agent's shape) has η = 0 when it appears; otherwise the
 * η are centred. μ is centred. Scores are on the Elo scale (400 / ln 10 per unit of log-odds) around ANCHOR.
 * Intervals are percentile bootstraps over matches with a fixed seed, so a board is reproducible from the vote dump.
 *
 * Games: { a, b, outcome: 'a'|'b'|'tie'|'both_bad', fa?: number[], fb?: number[], weight? } where a and b are
 * bench.entrant@1 ids. A tie is half a win each; both_bad says nothing about the order and is skipped.
 */

const SCALE = 400 / Math.log(10);
const ANCHOR = 1000;
const NEUTRAL = 'ov-bare';

/** bench.entrant@1 id → { kind, model, harness }. Unknown shapes are null (left out of the fit). */
function parseEntrant(id) {
    const s = String(id || '');
    let m;
    if ((m = /^model:(.+)$/.exec(s))) return { kind: 'model', model: m[1], harness: null };
    if ((m = /^harness:([a-z0-9][a-z0-9._-]*)@[A-Za-z0-9._-]+$/.exec(s))) return { kind: 'harness', model: null, harness: m[1] };
    if ((m = /^agent:([a-z0-9][a-z0-9._-]*)\+(.+)#[a-f0-9]{8,64}$/.exec(s))) return { kind: 'agent', model: m[2], harness: m[1] };
    return null;
}

function seededRandom(seed) {
    let state = (seed >>> 0) || 1;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

const sigmoid = (x) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));

function percentile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Solve A x = b for a symmetric positive definite A (Cholesky). A is an array of rows; it is not modified. */
function solveSpd(A, b) {
    const n = b.length;
    const L = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let sum = A[i][j];
            for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
            if (i === j) L[i][i] = Math.sqrt(Math.max(sum, 1e-12));
            else L[i][j] = sum / L[j][j];
        }
    }
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let sum = b[i];
        for (let k = 0; k < i; k++) sum -= L[i][k] * y[k];
        y[i] = sum / L[i][i];
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let sum = y[i];
        for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
        x[i] = sum / L[i][i];
    }
    return x;
}

/**
 * The parameter layout from the entrants the games name: μ per model, η per harness (the neutral one has none: it is
 * the zero), γ per (model, harness) pair seen as an agent, then β per covariate.
 */
function layout(games, covariates) {
    const models = new Map();
    const harnesses = new Map();
    const pairs = new Map();
    const entrants = new Map();
    let next = 0;
    const slot = (map, key) => { if (!map.has(key)) map.set(key, next++); return map.get(key); };
    for (const g of games) {
        for (const id of [g.a, g.b]) {
            if (entrants.has(id)) continue;
            const e = parseEntrant(id);
            if (!e) { entrants.set(id, null); continue; }
            const idx = [];
            if (e.model) idx.push(slot(models, e.model));
            if (e.harness && e.harness !== NEUTRAL) idx.push(slot(harnesses, e.harness));
            if (e.kind === 'agent' && e.harness !== NEUTRAL) idx.push(slot(pairs, `${e.model}\u0000${e.harness}`));
            entrants.set(id, { ...e, idx });
        }
    }
    const betaStart = next;
    return { models, harnesses, pairs, entrants, size: betaStart + covariates, betaStart, covariates };
}

/** One penalised Newton fit. Returns the parameter vector. */
function fitOnce(rows, lay, { ridge, maxIter = 60, tol = 1e-9 }) {
    const P = lay.size;
    const penalty = new Float64Array(P);
    for (const i of lay.models.values()) penalty[i] = ridge.model;
    for (const i of lay.harnesses.values()) penalty[i] = ridge.harness;
    for (const i of lay.pairs.values()) penalty[i] = ridge.interaction;
    for (let k = 0; k < lay.covariates; k++) penalty[lay.betaStart + k] = ridge.beta;
    const w = new Float64Array(P);
    for (let iter = 0; iter < maxIter; iter++) {
        const grad = new Float64Array(P);
        const H = Array.from({ length: P }, () => new Float64Array(P));
        for (let i = 0; i < P; i++) { grad[i] = -penalty[i] * w[i]; H[i][i] = penalty[i]; }
        for (const r of rows) {
            let eta = 0;
            for (const [i, v] of r.x) eta += v * w[i];
            const p = sigmoid(eta);
            const resid = r.yw - p * r.weight;
            const curv = p * (1 - p) * r.weight;
            for (const [i, vi] of r.x) {
                grad[i] += resid * vi;
                for (const [j, vj] of r.x) H[i][j] += curv * vi * vj;
            }
        }
        const step = solveSpd(H, grad);
        let max = 0;
        for (let i = 0; i < P; i++) { w[i] += step[i]; max = Math.max(max, Math.abs(step[i])); }
        if (max < tol) break;
    }
    return w;
}

/** Each game as a sparse row: x = x_a − x_b (and the style difference), y = 1 when a won, ½ for a tie. */
function rowsOf(games, lay) {
    const rows = [];
    for (const g of games) {
        const ea = lay.entrants.get(g.a);
        const eb = lay.entrants.get(g.b);
        if (!ea || !eb || g.a === g.b) continue;
        const y = g.outcome === 'a' ? 1 : g.outcome === 'b' ? 0 : g.outcome === 'tie' ? 0.5 : null;
        if (y == null) continue;
        const x = new Map();
        for (const i of ea.idx) x.set(i, (x.get(i) || 0) + 1);
        for (const i of eb.idx) x.set(i, (x.get(i) || 0) - 1);
        for (let k = 0; k < lay.covariates; k++) {
            const d = Number((g.fa || [])[k] || 0) - Number((g.fb || [])[k] || 0);
            if (d) x.set(lay.betaStart + k, d);
        }
        for (const [i, v] of [...x]) if (v === 0) x.delete(i);
        const weight = g.weight == null ? 1 : Math.max(0, Number(g.weight) || 0);
        if (!x.size || !weight) continue;
        rows.push({ x: [...x], yw: y * weight, weight });
    }
    return rows;
}

/** Rows with the same x add up (their wins and weights): the fit then reads each distinct pairing once. */
function grouped(rows) {
    const map = new Map();
    for (const r of rows) {
        const key = r.x.map(([i, v]) => `${i}:${v}`).join(',');
        const g = map.get(key);
        if (g) { g.yw += r.yw; g.weight += r.weight; } else map.set(key, { x: r.x, yw: r.yw, weight: r.weight });
    }
    return [...map.values()];
}

/** Centre μ (always) and η (when no neutral harness anchors it), moving the mean into nothing: only differences matter. */
function identify(w, lay, hasNeutral) {
    const centre = (map) => {
        const idx = [...map.values()];
        if (!idx.length) return;
        const mean = idx.reduce((s, i) => s + w[i], 0) / idx.length;
        for (const i of idx) w[i] -= mean;
    };
    centre(lay.models);
    if (!hasNeutral) centre(lay.harnesses);
    return w;
}

/**
 * fitFactors(games, options) → {
 *   models:     [{ id: 'model:M', model, score, ci_lower, ci_upper, games }],
 *   harnesses:  [{ id: 'harness:H', harness, effect, ci_lower, ci_upper, games }]   effect in Elo points vs the neutral
 *   agents:     [{ id, model, harness, score, ci_lower, ci_upper, factors: { model, harness, interaction } }]
 *   beta, n, method
 * }
 */
function fitFactors(games, {
    covariates = 0,
    ridge = { model: 0.01, harness: 0.05, interaction: 1.0, beta: 0.002 },
    bootstrap = 200,
    seed = 20261113,
    anchor = ANCHOR,
} = {}) {
    const list = (Array.isArray(games) ? games : []).filter((g) => g && g.a && g.b && g.outcome !== 'both_bad');
    const lay = layout(list, covariates);
    const hasNeutral = list.some((g) => [g.a, g.b].some((id) => { const e = parseEntrant(id); return e && e.harness === NEUTRAL; }));
    const rows = rowsOf(list, lay);
    const fitted = identify(fitOnce(grouped(rows), lay, { ridge }), lay, hasNeutral);

    // Bootstrap over matches: the same layout, resampled rows.
    const draws = [];
    const random = seededRandom(seed);
    for (let b = 0; b < bootstrap && rows.length; b++) {
        const sample = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
        draws.push(identify(fitOnce(grouped(sample), lay, { ridge, maxIter: 30 }), lay, hasNeutral));
    }
    const interval = (fn) => {
        const values = draws.map(fn).sort((a, b) => a - b);
        return values.length ? [percentile(values, 0.025), percentile(values, 0.975)] : [null, null];
    };
    const elo = (v) => Math.round((anchor + SCALE * v) * 10) / 10;
    const pts = (v) => Math.round(SCALE * v * 10) / 10;
    const gamesOf = (pred) => rows.length ? list.filter((g) => pred(g.a) || pred(g.b)).length : 0;

    const models = [...lay.models].map(([model, i]) => {
        const [lo, hi] = interval((w) => w[i]);
        return { id: `model:${model}`, model, score: elo(fitted[i]), ci_lower: lo == null ? null : elo(lo), ci_upper: hi == null ? null : elo(hi),
            games: gamesOf((id) => { const e = parseEntrant(id); return e && e.model === model; }) };
    }).sort((x, y) => y.score - x.score);

    const harnesses = [...lay.harnesses].map(([harness, i]) => {
        const [lo, hi] = interval((w) => w[i]);
        return { id: `harness:${harness}`, harness, effect: pts(fitted[i]), ci_lower: lo == null ? null : pts(lo), ci_upper: hi == null ? null : pts(hi),
            games: gamesOf((id) => { const e = parseEntrant(id); return e && e.harness === harness; }) };
    }).sort((x, y) => y.effect - x.effect);

    const agents = [];
    for (const [id, e] of lay.entrants) {
        if (!e || e.kind !== 'agent') continue;
        const mi = lay.models.get(e.model);
        const hi = e.harness === NEUTRAL ? null : lay.harnesses.get(e.harness);
        const pi = e.harness === NEUTRAL ? null : lay.pairs.get(`${e.model}\u0000${e.harness}`);
        const theta = (w) => (mi == null ? 0 : w[mi]) + (hi == null ? 0 : w[hi]) + (pi == null ? 0 : w[pi]);
        const [lo, up] = interval(theta);
        agents.push({
            id, model: e.model, harness: e.harness,
            score: elo(theta(fitted)), ci_lower: lo == null ? null : elo(lo), ci_upper: up == null ? null : elo(up),
            factors: {
                model: { score: elo(mi == null ? 0 : fitted[mi]) },
                harness: { score: pts(hi == null ? 0 : fitted[hi]) },
                interaction: { score: pts(pi == null ? 0 : fitted[pi]) },
            },
        });
    }
    agents.sort((x, y) => y.score - x.score);

    const beta = Array.from({ length: covariates }, (_, k) => Math.round(fitted[lay.betaStart + k] * 1e4) / 1e4);
    return {
        models, harnesses, agents, beta, n: rows.length,
        method: `penalised conditional logit: agent = model + harness + model×harness (ridge ${ridge.model}/${ridge.harness}/${ridge.interaction}), ${bootstrap} bootstrap draws over matches, seed ${seed}; the neutral harness ${NEUTRAL} is the zero when present`,
    };
}

/** The gap between two agents split into its model, harness and interaction parts (Elo points), for a pair page. */
function splitGap(fit, a, b) {
    const A = fit.agents.find((x) => x.id === a);
    const B = fit.agents.find((x) => x.id === b);
    if (!A || !B) return null;
    const model = Math.round((A.factors.model.score - B.factors.model.score) * 10) / 10;
    const harness = Math.round((A.factors.harness.score - B.factors.harness.score) * 10) / 10;
    const interaction = Math.round((A.factors.interaction.score - B.factors.interaction.score) * 10) / 10;
    return { gap: Math.round((A.score - B.score) * 10) / 10, model, harness, interaction };
}

module.exports = { fitFactors, splitGap, parseEntrant, NEUTRAL, SCALE };

'use strict';

/**
 * Style-controlled Bradley-Terry for Bench's human votes (stage B9).
 *
 * The research (10-30) is blunt about two things: a board's rank is fragile once the whole board's uncertainty is
 * counted (an audit of 106,134 LMArena votes found only 1 of 54 neighbouring pairs to be a real ordering), and style
 * beats substance (length and formatting decide a large share of pairwise votes). So Bench does two things a plain
 * Elo ladder never does:
 *
 *   1. Style control. The same Bradley-Terry fit is made twice: once on the votes alone (the raw board, what people
 *      actually chose) and once with the style of each output as covariates (the controlled board, what the model
 *      would score if every output were written the same way). The covariates are the output's length and its
 *      markup count, the two LMArena names as covariates; the effect sizes are reported so a reader can see how much
 *      of the raw board is style.
 *
 *      The model is a conditional logit (Bradley-Terry with per-output covariates):
 *
 *          P(left wins) = sigmoid( theta_left - theta_right + SUM_k beta_k * (z_left,k - z_right,k) )
 *
 *      where theta is the model's own strength (log-odds) and z the standardised covariates of the two outputs. A tie
 *      counts as half a win. The fit is convex in theta for fixed beta, so a damped Newton direction with a
 *      backtracking line search finds the maximum; theta is centred (its mean is zero) because only differences are
 *      identified.
 *
 *   2. Bands, not places. Models whose bootstrap intervals overlap share a band, so the board says "2nd-4th" instead
 *      of pretending the third place is a fact.
 *
 * Every number here is reproducible from the open vote dump (/api/v1/datasets/votes.jsonl): the dump carries each
 * vote's outcome, the two models, the two outputs' style features and the weight the fit gave that vote, so
 * scripts/fit-ratings.js re-derives the same board from the file alone.
 *
 * The maths is Bench's own (no copied code); the shape follows the published description of style-controlled
 * Bradley-Terry so the numbers mean what a reader expects.
 */

const { percentile } = require('./lib');

/** Elo points per unit of log-odds: the usual 400 / ln(10). */
const SCALE = 400 / Math.log(10);
/** The number a centred rating sits on, so the board reads like an Elo ladder. */
const ANCHOR = 1000;
/** The covariates, in the order they are reported. */
const COVARIATES = Object.freeze(['length', 'markup']);
/** The bootstrap resamples the board's intervals come from. */
const BOOTSTRAP = 1000;
/** The seed the bootstrap uses, so a rerun gives the same intervals. */
const SEED = 20261030;

const sigmoid = (x) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : (e => e / (1 + e))(Math.exp(x)));

/** The text of an entry payload: whichever field its kind renders from. */
function contentOf(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    for (const key of ['html', 'svg', 'glsl', 'text', 'code']) {
        if (typeof p[key] === 'string' && p[key].trim()) return p[key];
    }
    return '';
}

/**
 * How much markup an output carries. Headings, bold, lists, code fences, links, table rows and HTML tags each count
 * once: the point is "how dressed up is this output", and the count has to be the same for every kind.
 */
function markupCount(text) {
    const s = String(text == null ? '' : text);
    let n = 0;
    n += (s.match(/^#{1,6}\s/gm) || []).length;
    n += (s.match(/\*\*|__/g) || []).length;
    n += (s.match(/^\s*[-*+]\s/gm) || []).length;
    n += (s.match(/^\s*\d+\.\s/gm) || []).length;
    n += (s.match(/```/g) || []).length;
    n += (s.match(/\[[^\]]*\]\([^)]*\)/g) || []).length;
    n += (s.match(/^\s*\|/gm) || []).length;
    n += (s.match(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi) || []).length;
    return n;
}

/** The style features of one output: how long it is, and how much markup it wears. */
function styleFeatures(payload) {
    const content = contentOf(payload);
    return { length: content.length, markup: markupCount(content) };
}

/** A small seedable generator, so the same votes and seed always give the same intervals. */
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

function centre(values) {
    if (!values.length) return values;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    for (let i = 0; i < values.length; i++) values[i] -= mean;
    return values;
}

/**
 * The games a fit reads: { id, a, b, outcome, fa, fb, voter?, weight? }. The outcome is 'a', 'b' or 'tie';
 * 'both_bad' says nothing about the models and is skipped.
 */
function prepare(games, { covariates = COVARIATES } = {}) {
    const list = (Array.isArray(games) ? games : [])
        .filter((g) => g && g.a && g.b && g.a !== g.b && g.outcome !== 'both_bad');
    const subjects = [...new Set(list.flatMap((g) => [g.a, g.b]))].sort();
    const index = new Map(subjects.map((s, i) => [s, i]));
    const wanted = covariates.filter((k) => k === 'length' || k === 'markup');

    // Standardise every covariate over the outputs the votes actually used.
    const stats = new Map();
    for (const key of wanted) {
        const values = [];
        for (const g of list) {
            values.push(Number((g.fa && g.fa[key]) || 0), Number((g.fb && g.fb[key]) || 0));
        }
        const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
        const variance = values.length ? values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length : 0;
        stats.set(key, { mean, sd: Math.sqrt(variance) || 1 });
    }

    // The standardised difference of each covariate, per game.
    const diffs = wanted.map((key) => {
        const st = stats.get(key);
        const out = new Float64Array(list.length);
        for (let i = 0; i < list.length; i++) {
            const g = list[i];
            const za = (Number((g.fa && g.fa[key]) || 0) - st.mean) / st.sd;
            const zb = (Number((g.fb && g.fb[key]) || 0) - st.mean) / st.sd;
            out[i] = za - zb;
        }
        return out;
    });

    // Two covariates that move together cannot be told apart, and the fit would trade them for ever: keep the first
    // and drop the one that repeats it. The board then says so instead of pretending both were measured.
    const keptKeys = [];
    const keptDiffs = [];
    const dropped = [];
    for (let j = 0; j < wanted.length; j++) {
        const clash = keptDiffs.some((other) => Math.abs(correlation(diffs[j], other)) > 0.95);
        if (clash) { dropped.push(wanted[j]); continue; }
        keptKeys.push(wanted[j]);
        keptDiffs.push(diffs[j]);
    }
    const kAll = keptKeys.length;

    const n = list.length;
    const ai = new Int32Array(n);
    const bi = new Int32Array(n);
    const score = new Float64Array(n);
    const weight = new Float64Array(n);
    const dz = new Float64Array(n * kAll);
    const ids = new Array(n);
    const voters = new Array(n);
    let kept = 0;
    for (let gi = 0; gi < list.length; gi++) {
        const g = list[gi];
        const w = Number(g.weight == null ? 1 : g.weight);
        if (!(w > 0)) continue;
        const at = kept;
        ai[at] = index.get(g.a);
        bi[at] = index.get(g.b);
        score[at] = g.outcome === 'a' ? 1 : g.outcome === 'b' ? 0 : 0.5;
        weight[at] = w;
        ids[at] = g.id == null ? null : String(g.id);
        voters[at] = g.voter == null ? null : String(g.voter);
        for (let j = 0; j < kAll; j++) dz[at * kAll + j] = keptDiffs[j][gi];
        kept += 1;
    }

    const keptStats = new Map();
    for (const key of keptKeys) keptStats.set(key, stats.get(key));
    return { ai, bi, score, weight, dz, ids, voters, count: kept, subjects, index, keys: keptKeys, stats: keptStats, dropped };
}

/** The Pearson correlation of two equal-length series. */
function correlation(a, b) {
    const n = Math.min(a.length, b.length);
    if (!n) return 0;
    let ma = 0;
    let mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let cov = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < n; i++) {
        cov += (a[i] - ma) * (b[i] - mb);
        va += (a[i] - ma) * (a[i] - ma);
        vb += (b[i] - mb) * (b[i] - mb);
    }
    if (!va || !vb) return 0;
    return cov / Math.sqrt(va * vb);
}

/**
 * The conditional-logit fit over prepared games. `order` picks which games take part (the bootstrap resamples it);
 * `use` picks which of the prepared covariates enter the logit (the raw fit uses none of them). The hot loops work on
 * typed arrays, because the bootstrap runs this thousands of times.
 */
function fitPrepared(prepared, { order = null, use = null, ridge = 0.05, betaRidge = 0.002, maxIter = 120, tol = 1e-9, warm = null, lineSearch = true } = {}) {
    const { ai, bi, score, weight, dz, subjects, keys, stats } = prepared;
    const n = subjects.length;
    const kAll = keys.length;
    const cols = (use == null ? keys : use).map((key) => keys.indexOf(key)).filter((i) => i >= 0);
    const k = cols.length;
    const picks = order || null;
    const count = picks ? picks.length : prepared.count;

    let theta = warm && warm.theta && warm.theta.length === n ? Float64Array.from(warm.theta) : new Float64Array(n);
    let beta = warm && warm.beta && warm.beta.length === k ? Float64Array.from(warm.beta) : new Float64Array(k);

    const gTheta = new Float64Array(n);
    const hTheta = new Float64Array(n);
    const gBeta = new Float64Array(k);
    const hBeta = new Float64Array(k);
    const nextTheta = new Float64Array(n);
    const nextBeta = new Float64Array(k);

    const logit = (p, th, be) => {
        let x = th[ai[p]] - th[bi[p]];
        for (let j = 0; j < k; j++) x += be[j] * dz[p * kAll + cols[j]];
        return x;
    };

    const evaluate = (th, be) => {
        let value = 0;
        for (let p = 0; p < count; p++) {
            const idx = picks ? picks[p] : p;
            const x = logit(idx, th, be);
            const ph = sigmoid(x);
            const s = score[idx];
            value += -weight[idx] * (s * Math.log(ph) + (1 - s) * Math.log(1 - ph));
        }
        for (let i = 0; i < n; i++) value += ridge * th[i] * th[i];
        for (let j = 0; j < k; j++) value += betaRidge * be[j] * be[j];
        return value;
    };

    const gradient = (th, be) => {
        gTheta.fill(0); hTheta.fill(0); gBeta.fill(0); hBeta.fill(0);
        for (let p = 0; p < count; p++) {
            const idx = picks ? picks[p] : p;
            const x = logit(idx, th, be);
            const ph = sigmoid(x);
            const s = score[idx];
            const w = weight[idx];
            const d = w * (s - ph);
            const a = ai[idx];
            const b = bi[idx];
            gTheta[a] += d;
            gTheta[b] -= d;
            const curv = w * ph * (1 - ph);
            hTheta[a] += curv;
            hTheta[b] += curv;
            for (let j = 0; j < k; j++) {
                const dzz = dz[idx * kAll + cols[j]];
                gBeta[j] += d * dzz;
                hBeta[j] += curv * dzz * dzz;
            }
        }
        for (let i = 0; i < n; i++) { gTheta[i] -= 2 * ridge * th[i]; hTheta[i] += 2 * ridge; }
        for (let j = 0; j < k; j++) { gBeta[j] -= 2 * betaRidge * be[j]; hBeta[j] += 2 * betaRidge; }
    };

    for (let iter = 0; iter < maxIter; iter++) {
        gradient(theta, beta);
        let norm = 0;
        for (let i = 0; i < n; i++) norm += gTheta[i] * gTheta[i];
        for (let j = 0; j < k; j++) norm += gBeta[j] * gBeta[j];
        norm = Math.sqrt(norm);
        if (norm < tol) break;
        // A Newton direction with a diagonal curvature, damped by a backtracking line search.
        let step = 1;
        let moved = false;
        const base = lineSearch ? evaluate(theta, beta) : null;
        for (let attempt = 0; attempt < 12; attempt++) {
            let mean = 0;
            for (let i = 0; i < n; i++) {
                const v = theta[i] + step * (gTheta[i] / Math.max(hTheta[i], 1e-9));
                nextTheta[i] = v;
                mean += v;
            }
            mean /= n;
            for (let i = 0; i < n; i++) nextTheta[i] -= mean;
            for (let j = 0; j < k; j++) nextBeta[j] = beta[j] + step * (gBeta[j] / Math.max(hBeta[j], 1e-9));
            if (!lineSearch) { theta.set(nextTheta); beta.set(nextBeta); moved = true; break; }
            const value = evaluate(nextTheta, nextBeta);
            if (value <= base - 1e-12) {
                theta.set(nextTheta); beta.set(nextBeta); moved = true; break;
            }
            step *= 0.5;
        }
        if (!moved) break;
    }

    return { theta: Array.from(theta), beta: Array.from(beta), subjects, keys, stats };
}

/**
 * How often a voter disagrees with the consensus. A voter who disagrees far too often is down-weighted: their votes
 * count a quarter (nothing at all when they disagree with almost everything), and they are never named anywhere.
 */
function voterWeights(games, fit, { minVotes = 10, disagreeAt = 0.5, hopelessAt = 0.75 } = {}) {
    const rating = new Map();
    fit.subjects.forEach((subject, i) => rating.set(subject, fit.theta[i]));
    const voters = new Map();
    for (const g of games) {
        if (!g || g.voter == null) continue;
        if (g.outcome === 'tie' || g.outcome === 'both_bad') continue;
        if (g.a === g.b) continue;
        const ra = rating.get(g.a);
        const rb = rating.get(g.b);
        if (ra == null || rb == null) continue;
        const expected = ra > rb ? 1 : ra < rb ? -1 : 0;
        const observed = g.outcome === 'a' ? 1 : -1;
        const record = voters.get(g.voter) || { count: 0, disagreement: 0 };
        record.count += 1;
        record.disagreement += expected === observed ? 0 : 1;
        voters.set(g.voter, record);
    }
    const out = new Map();
    for (const [voter, record] of voters) {
        const rate = record.count ? record.disagreement / record.count : 0;
        let weight = 1;
        let downweighted = false;
        if (record.count >= minVotes && rate >= hopelessAt) { weight = 0; downweighted = true; }
        else if (record.count >= minVotes && rate > disagreeAt) { weight = 0.25; downweighted = true; }
        out.set(voter, { count: record.count, disagreement: rate, weight, downweighted });
    }
    return out;
}

/**
 * The whole board: the raw fit, the style-controlled fit, both with bootstrap intervals, and the rank bands.
 *
 * The games are { id, a, b, outcome: 'a'|'b'|'tie', fa, fb, voter?, weight? }. The bootstrap resamples the votes and
 * gives the 2.5th and 97.5th percentile of each rating. `voteWeights` (when given) is the per-vote weight the caller
 * already computed, so the open dump and the live board agree.
 */
function fitRatings(games, {
    bootstrap = BOOTSTRAP,
    seed = SEED,
    ridge = 0.05,
    betaRidge = 0.002,
    covariates = COVARIATES,
    minVotes = 10,
    disagreeAt = 0.5,
    voteWeights = null,
} = {}) {
    const list = (Array.isArray(games) ? games : []).filter((g) => g && g.a && g.b);
    const empty = { models: [], bands: { raw: [], controlled: [] }, effects: {}, voters: { total: 0, downweighted: 0 }, votes: 0, bootstrap: 0, seed };
    if (!list.length) return empty;

    // First pass: the consensus without voter weights, so the weights can be judged against it.
    const consensus = fitPrepared(prepare(list, { covariates: [] }), { use: [], ridge });
    const weights = voterWeights(list, consensus, { minVotes, disagreeAt });
    const weighted = list.map((g) => ({
        ...g,
        weight: voteWeights && g.id != null && voteWeights.get(g.id) != null
            ? voteWeights.get(g.id)
            : g.voter != null && weights.has(g.voter) ? weights.get(g.voter).weight
                : (g.weight == null ? 1 : g.weight),
    }));

    const prepared = prepare(weighted, { covariates });
    const raw = fitPrepared(prepared, { use: [], ridge });
    const controlled = fitPrepared(prepared, { use: covariates, ridge, betaRidge });

    const counts = new Map();
    for (const g of weighted) {
        counts.set(g.a, (counts.get(g.a) || 0) + 1);
        counts.set(g.b, (counts.get(g.b) || 0) + 1);
    }

    const rawSamples = new Map();
    const ctrlSamples = new Map();
    const random = seededRandom(seed);
    const rounds = Math.max(0, Math.min(BOOTSTRAP, Number(bootstrap) || 0));
    const n = prepared.count;
    const rawIndex = new Map(raw.subjects.map((s, i) => [s, i]));
    const ctrlIndex = new Map(controlled.subjects.map((s, i) => [s, i]));
    const order = new Int32Array(n);
    for (let i = 0; i < rounds; i++) {
        for (let j = 0; j < n; j++) order[j] = Math.floor(random() * n);
        const r = fitPrepared(prepared, { order, use: [], ridge, maxIter: 60, warm: { theta: raw.theta, beta: [] } });
        const c = fitPrepared(prepared, { order, use: covariates, ridge, betaRidge, maxIter: 60, warm: { theta: controlled.theta, beta: controlled.beta } });
        for (const [subject, position] of rawIndex) {
            if (!rawSamples.has(subject)) { rawSamples.set(subject, []); ctrlSamples.set(subject, []); }
            rawSamples.get(subject).push(r.theta[position]);
            ctrlSamples.get(subject).push(c.theta[ctrlIndex.has(subject) ? ctrlIndex.get(subject) : 0]);
        }
    }

    const toRating = (theta) => ANCHOR + SCALE * theta;
    const rawTheta = new Map(raw.subjects.map((s, i) => [s, raw.theta[i]]));
    const ctrlTheta = new Map(controlled.subjects.map((s, i) => [s, controlled.theta[i]]));
    const rows = raw.subjects.map((subject) => {
        const thetaRaw = rawTheta.get(subject);
        const thetaCtrl = ctrlTheta.get(subject);
        const rawP = rawSamples.get(subject) || [];
        const ctrlP = ctrlSamples.get(subject) || [];
        return {
            model: subject,
            votes: counts.get(subject) || 0,
            raw: {
                rating: Math.round(toRating(thetaRaw) * 100) / 100,
                ci_lower: rawP.length ? Math.round(toRating(percentile(rawP, 0.025)) * 100) / 100 : Math.round(toRating(thetaRaw) * 100) / 100,
                ci_upper: rawP.length ? Math.round(toRating(percentile(rawP, 0.975)) * 100) / 100 : Math.round(toRating(thetaRaw) * 100) / 100,
            },
            controlled: {
                rating: Math.round(toRating(thetaCtrl) * 100) / 100,
                ci_lower: ctrlP.length ? Math.round(toRating(percentile(ctrlP, 0.025)) * 100) / 100 : Math.round(toRating(thetaCtrl) * 100) / 100,
                ci_upper: ctrlP.length ? Math.round(toRating(percentile(ctrlP, 0.975)) * 100) / 100 : Math.round(toRating(thetaCtrl) * 100) / 100,
            },
        };
    }).sort((x, y) => y.raw.rating - x.raw.rating || x.model.localeCompare(y.model));

    const rawBands = rankBands(rows.map((r) => ({ model: r.model, rating: r.raw.rating, ci_lower: r.raw.ci_lower, ci_upper: r.raw.ci_upper })));
    const ctrlBands = rankBands(rows.map((r) => ({ model: r.model, rating: r.controlled.rating, ci_lower: r.controlled.ci_lower, ci_upper: r.controlled.ci_upper })));
    const bandOf = (bands, model) => {
        const band = bands.find((b) => b.models.includes(model));
        return band ? band.label : null;
    };
    for (const row of rows) {
        row.raw.band = bandOf(rawBands, row.model);
        row.controlled.band = bandOf(ctrlBands, row.model);
    }

    // The effect of each style covariate, in Elo points per 1000 characters or per 10 markup marks.
    const effects = {};
    const ctrlKeys = controlled.keys;
    for (let j = 0; j < ctrlKeys.length; j++) {
        const key = ctrlKeys[j];
        const beta = controlled.beta[j] == null ? 0 : controlled.beta[j];
        const st = controlled.stats.get(key);
        const perUnit = st ? beta * SCALE / st.sd : 0;
        effects[key] = {
            beta: Math.round(beta * 1e6) / 1e6,
            elo_per_1000_chars: key === 'length' ? Math.round(perUnit * 1000 * 100) / 100 : null,
            elo_per_10_marks: key === 'markup' ? Math.round(perUnit * 10 * 100) / 100 : null,
            mean: st ? Math.round(st.mean * 100) / 100 : null,
            sd: st ? Math.round(st.sd * 100) / 100 : null,
        };
    }
    const droppedCovariates = prepared.dropped || [];

    const downweighted = [...weights.values()].filter((w) => w.downweighted).length;
    // The weight each vote carries, so the open dump can re-derive the same board from the file alone.
    const perVoteWeights = weighted.map((g) => ({ id: g.id == null ? null : String(g.id), weight: g.weight }));
    return {
        models: rows,
        vote_weights: perVoteWeights,
        bands: { raw: rawBands, controlled: ctrlBands },
        effects,
        voters: { total: weights.size, downweighted },
        dropped_covariates: droppedCovariates,
        votes: list.length,
        bootstrap: rounds,
        seed,
    };
}

/**
 * Rank bands: models whose intervals overlap share a band. The rows come in rank order; a band grows while the next
 * model's interval still overlaps the band it would join.
 */
function rankBands(rows) {
    const sorted = [...(rows || [])].filter((r) => r && r.rating != null)
        .sort((a, b) => b.rating - a.rating || String(a.model).localeCompare(String(b.model)));
    const bands = [];
    let current = null;
    sorted.forEach((row, i) => {
        const lower = row.ci_lower == null ? row.rating : row.ci_lower;
        const upper = row.ci_upper == null ? row.rating : row.ci_upper;
        if (current && lower <= current.upper && upper >= current.lower) {
            current.models.push(row.model);
            current.lower = Math.min(current.lower, lower);
            current.upper = Math.max(current.upper, upper);
            current.last = i;
        } else {
            current = { models: [row.model], lower, upper, first: i, last: i };
            bands.push(current);
        }
    });
    return bands.map((band, i) => ({
        label: bandLabel(band.first + 1, band.last + 1),
        from: band.first + 1,
        to: band.last + 1,
        models: band.models,
        index: i,
    }));
}

function ordinal(n) {
    const v = Math.round(Number(n));
    const t = v % 100;
    if (t >= 11 && t <= 13) return v + 'th';
    return v + ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th');
}

/** "2nd-4th" for a band, "1st" for a single place. */
function bandLabel(from, to) {
    if (to <= from) return ordinal(from);
    return ordinal(from) + '\u2013' + ordinal(to);
}

module.exports = {
    SCALE, ANCHOR, COVARIATES, BOOTSTRAP, SEED,
    styleFeatures, markupCount, contentOf,
    prepare, fitPrepared, voterWeights, fitRatings, rankBands, bandLabel, ordinal, seededRandom,
};

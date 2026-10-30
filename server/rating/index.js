'use strict';

/**
 * Bench's rating maths (plan 2026-10-28 §4.12). Simple, deterministic and correct enough to drop a full
 * Bradley–Terry library in behind the same interface later:
 *
 *   eloUpdate(ra, rb, outcome, k)                     one Elo exchange, returns { a, b }
 *   bradleyTerry(games, { bootstrap, seed })          refit ratings with bootstrap 95% intervals
 *   wilson(successes, n)                              Wilson 95% lower/upper on a success rate
 *   pareto(rows, { x, y })                            non-dominated frontier over quality (x↑) vs cost (y↓)
 *   costPerSolved(entries)                            total spend / solved count
 *
 * The bootstrap uses a small seedable LCG, so the same games and seed always give the same intervals.
 */

const BASE_ELO = 1000;
const K_DEFAULT = 32;

function eloUpdate(ra, rb, outcome, k = K_DEFAULT) {
    const a = Number(ra);
    const b = Number(rb);
    const K = Number(k) || K_DEFAULT;
    let sa;
    if (outcome === 'left' || outcome === 'win' || outcome === 1) sa = 1;
    else if (outcome === 'right' || outcome === 'loss' || outcome === 0) sa = 0;
    else if (outcome === 'tie' || outcome === 0.5) sa = 0.5;
    else if (outcome === 'both_bad') return { a, b };
    else return { a, b };
    const ea = 1 / (1 + 10 ** ((b - a) / 400));
    const eb = 1 - ea;
    return {
        a: Math.round((a + K * (sa - ea)) * 100) / 100,
        b: Math.round((b + K * ((1 - sa) - eb)) * 100) / 100,
    };
}

/**
 * Non-dominated sort: maximize x (quality), minimize y (cost). A row is on the frontier when no other row has
 * x >= its x and y <= its y with at least one strict. Rows are returned with `frontier: true|false`.
 */
function pareto(rows, { x = 'x', y = 'y' } = {}) {
    const list = Array.isArray(rows) ? rows.map((r) => ({ ...r })) : [];
    const out = list.map((r) => ({ ...r, frontier: true }));
    for (let i = 0; i < out.length; i++) {
        for (let j = 0; j < out.length; j++) {
            if (i === j) continue;
            const a = out[i];
            const b = out[j];
            const betterX = Number(b[x] ?? -Infinity) >= Number(a[x] ?? -Infinity);
            const betterY = Number(b[y] ?? Infinity) <= Number(a[y] ?? Infinity);
            const strict = Number(b[x] ?? -Infinity) > Number(a[x] ?? -Infinity) || Number(b[y] ?? Infinity) < Number(a[y] ?? Infinity);
            if (betterX && betterY && strict) { a.frontier = false; break; }
        }
    }
    return out;
}

/**
 * Expected cost per solved entry. `entries` are objects with a numeric `cost_usd` and a truthy `solved` flag
 * (or `outcome: 'pass'` / a positive `score`). Returns null when nothing is solved.
 */
function costPerSolved(entries) {
    const list = Array.isArray(entries) ? entries : [];
    let cost = 0;
    let solved = 0;
    for (const e of list) {
        const isSolved = Boolean(e && (e.solved || e.outcome === 'pass' || (Number(e.score) || 0) > 0));
        if (!isSolved) continue;
        cost += Number(e.cost_usd) || 0;
        solved += 1;
    }
    return solved ? Math.round((cost / solved) * 1e10) / 1e10 : null;
}

// Bradley–Terry with bootstrap intervals, voter weights, Wilson and percentiles: the tested library (lib.js, BENCH-2).
const lib = require('./lib');

// The style-controlled fit (stage B9): a conditional logit over the votes, with the length and the markup of
// each output as covariates, bootstrap intervals and rank bands.
const style = require('./style');

module.exports = {
    eloUpdate, bradleyTerry: lib.bradleyTerry, voterWeights: lib.voterWeights, wilson: lib.wilson, percentile: lib.percentile, pareto, costPerSolved, BASE_ELO, K_DEFAULT,
    style,
    fitRatings: style.fitRatings, rankBands: style.rankBands, styleFeatures: style.styleFeatures, markupCount: style.markupCount,
};

'use strict';

/**
 * The time horizon, after METR (B13). For one model, each timed task gives a human time estimate and a success rate
 * (the mean of its task scores over the runs). A two-parameter logistic fit of success on log(human minutes) gives
 * the 50% point: the task length the model "reliably does". A bootstrap over tasks gives the 90% interval.
 *
 * Before 15 timed tasks and 3 runs, no number is shown: the fit would be noise. The interval is resampled from the
 * tasks, not the runs, because the task length is what the fit is about.
 */
const { percentile } = require('../rating/lib');

const MIN_TASKS = 15;
const MIN_RUNS = 3;
const BOOTSTRAP = 500;
const SEED = 20261030;

const sigmoid = (x) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : (e => e / (1 + e))(Math.exp(x)));
const clamp = (p) => Math.min(0.999, Math.max(0.001, p));
const round = (v, p = 10) => (v == null ? null : Math.round(v * p) / p);

function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Fit intercept + slope by Newton-Raphson. `points` are { x = log(minutes), p = success 0..1, weight }.
 * No library: two parameters are two normal equations.
 */
function fitLogistic(points) {
    let b0 = 0;
    let b1 = 0;
    for (let iter = 0; iter < 80; iter++) {
        let g0 = 0; let g1 = 0;
        let h00 = 0; let h01 = 0; let h11 = 0;
        for (const point of points) {
            const w = Number.isFinite(point.weight) && point.weight > 0 ? point.weight : 1;
            const q = sigmoid(b0 + b1 * point.x);
            const r = q - point.p;
            const wt = Math.max(1e-9, q * (1 - q) * w);
            g0 += r * w;
            g1 += r * w * point.x;
            h00 += wt;
            h01 += wt * point.x;
            h11 += wt * point.x * point.x;
        }
        // A tiny ridge keeps a separable fit finite rather than throwing on a singular matrix.
        h00 += 1e-9; h11 += 1e-9;
        const det = h00 * h11 - h01 * h01;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-18) break;
        const d0 = (h11 * g0 - h01 * g1) / det;
        const d1 = (-h01 * g0 + h00 * g1) / det;
        b0 -= d0; b1 -= d1;
        if (Math.max(Math.abs(d0), Math.abs(d1)) < 1e-11) break;
    }
    return { intercept: b0, slope: b1 };
}

/** The minutes at which the fitted success is 50%, or null when the model does not improve with time. */
function horizonOf(fit) {
    if (!fit || !(fit.slope > 0) || !Number.isFinite(fit.intercept)) return null;
    return Math.exp(-fit.intercept / fit.slope);
}

function fitPoints(groups) {
    return groups.map((g) => ({
        x: Math.log(g.minutes),
        p: clamp(Number(g.success)),
        weight: g.runs || 1,
    })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.p));
}

/**
 * `groups`: [{ minutes, success (0..1 mean over runs), runs }]. `runs` is the number of distinct runs behind the
 * groups; `timedTasks` their count. Returns available:false with a reason below either gate.
 */
function estimateHorizon(groups = [], { runs = 0, timedTasks = groups.length, bootstrap = BOOTSTRAP, seed = SEED } = {}) {
    const gates = { timed_tasks: timedTasks, runs, need_tasks: MIN_TASKS, need_runs: MIN_RUNS };
    if (timedTasks < MIN_TASKS || runs < MIN_RUNS) {
        return { available: false, reason: 'not enough runs yet', ...gates };
    }
    const points = fitPoints(groups);
    if (points.length < MIN_TASKS) return { available: false, reason: 'not enough timed tasks', ...gates };
    const fit = fitLogistic(points);
    const horizon = horizonOf(fit);
    if (horizon == null || !Number.isFinite(horizon) || horizon <= 0) {
        return { available: false, reason: 'no 50% point yet', ...gates, slope: round(fit.slope, 1000) };
    }
    const random = seededRandom(seed);
    const samples = [];
    for (let i = 0; i < bootstrap; i++) {
        const resampled = [];
        for (let j = 0; j < points.length; j++) resampled.push(points[Math.floor(random() * points.length)]);
        const value = horizonOf(fitLogistic(resampled));
        if (value != null && Number.isFinite(value) && value > 0) samples.push(value);
    }
    samples.sort((a, b) => a - b);
    const lower = samples.length ? percentile(samples, 0.05) : horizon;
    const upper = samples.length ? percentile(samples, 0.95) : horizon;
    return {
        available: true,
        horizon_minutes: round(horizon, 1),
        ci_lower: round(lower, 1),
        ci_upper: round(upper, 1),
        ...gates,
        slope: round(fit.slope, 1000),
        method: 'logistic fit of success on log(human minutes); 90% bootstrap over tasks',
        bootstrap,
    };
}

module.exports = { estimateHorizon, fitLogistic, horizonOf, fitPoints, MIN_TASKS, MIN_RUNS };

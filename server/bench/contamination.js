'use strict';

/**
 * The contamination flag (B13). A model that scored much better on tasks written before its release than on tasks
 * written after it may have seen the older ones in training. "Much better" means the 90% bootstrap intervals of the
 * two medians do not overlap. Two runs on each side are needed before either interval is allowed to speak; below
 * that the answer is "not enough runs yet", never a flag.
 */
const { percentile } = require('../rating/lib');

function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const median = (values) => {
    const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!list.length) return null;
    const mid = Math.floor(list.length / 2);
    return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
};

const round = (v, p = 1000) => (v == null ? null : Math.round(v * p) / p);

/** A bootstrap percentile interval for the median of `values`. */
function medianInterval(values, { level = 0.9, bootstrap = 1000, seed = 20261030 } = {}) {
    const list = values.filter((v) => Number.isFinite(v));
    if (!list.length) return null;
    if (list.length === 1) return { median: round(list[0]), lower: round(list[0]), upper: round(list[0]), runs: 1 };
    const random = seededRandom(seed);
    const medians = [];
    for (let i = 0; i < bootstrap; i++) {
        const sample = [];
        for (let j = 0; j < list.length; j++) sample.push(list[Math.floor(random() * list.length)]);
        medians.push(median(sample));
    }
    medians.sort((a, b) => a - b);
    return {
        median: round(median(list)),
        lower: round(percentile(medians, (1 - level) / 2)),
        upper: round(percentile(medians, 1 - (1 - level) / 2)),
        runs: list.length,
    };
}

/**
 * The flag for one model. `oldScores` and `freshScores` are one score per run, for the runs that touched a task on
 * that side of the cutoff. `cutoff`/`source` come from the repo's table; without them there is no flag.
 */
function contaminationFor({ oldScores = [], freshScores = [], cutoff = null, source = null } = {}) {
    const oldRuns = oldScores.filter((v) => Number.isFinite(v));
    const freshRuns = freshScores.filter((v) => Number.isFinite(v));
    if (!cutoff) {
        return { flag: false, available: false, reason: 'no release date', old_runs: oldRuns.length, fresh_runs: freshRuns.length };
    }
    if (oldRuns.length < 2 || freshRuns.length < 2) {
        return { flag: false, available: false, reason: 'not enough runs yet', old_runs: oldRuns.length, fresh_runs: freshRuns.length, cutoff, source };
    }
    const oldSide = medianInterval(oldRuns, { seed: 20261030 });
    const freshSide = medianInterval(freshRuns, { seed: 20261031 });
    const flag = oldSide.lower > freshSide.upper;
    return {
        flag,
        available: true,
        reason: flag ? 'the old interval is above the fresh one' : 'the intervals overlap',
        cutoff,
        source,
        old: oldSide,
        fresh: freshSide,
        gap: round(oldSide.median - freshSide.median),
    };
}

module.exports = { contaminationFor, medianInterval, median, seededRandom, round };

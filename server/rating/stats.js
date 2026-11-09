'use strict';

/**
 * The OpenVibe Index and the holdout gap (plan 2026-11-09, stage B3).
 *
 * The Index is one number per model per kind, on the 0-100 scale every other Bench score uses. It is a weighted
 * mean of two kinds of evidence:
 *
 *   rating       the model's Bradley-Terry rating from the human votes, put on 0-100 by the Elo expectation
 *                against a 1000-rated opponent: 100 / (1 + 10 ** ((1000 - rating) / 400)). A 1000 rating is 50,
 *                not a made-up score of its own.
 *   benchmarks   the median verified score of the model on each public benchmark of that kind (0-100).
 *
 * The weights are published with every answer: half the Index is the rating and half is split equally between the
 * kind's public benchmarks. A model that has no score on one of them gets that benchmark's weight renormalised
 * away, so the Index is always a weighted mean of the evidence the model actually has. Fewer than two components is
 * not an Index: the answer is null, never a number from one component.
 *
 * The holdout gap is the public score minus the held-out score, points on the same 0-100 scale, with the number of
 * scored tasks on each side. A kind without held-out tasks, or a model missing one side, gets a null gap.
 */

/** The published weights: half the rating, half the objective benchmarks (split equally between them). */
const INDEX_WEIGHTS = Object.freeze({ rating: 0.5, benchmarks: 0.5 });
/** The rating the logistic is read against, so a 1000 rating is 50 points. */
const RATING_ANCHOR = 1000;

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const round = (v, places = 4) => {
    if (v == null || !Number.isFinite(Number(v))) return null;
    const factor = 10 ** places;
    return Math.round(Number(v) * factor) / factor;
};
const clamp = (v, low, high) => Math.min(high, Math.max(low, v));

function mean(values) {
    const list = (Array.isArray(values) ? values : []).map(num).filter((v) => v != null);
    return list.length ? list.reduce((sum, v) => sum + v, 0) / list.length : null;
}

function median(values) {
    const list = (Array.isArray(values) ? values : []).map(num).filter((v) => v != null).sort((a, b) => a - b);
    if (!list.length) return null;
    const middle = Math.floor(list.length / 2);
    return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

/** A Bradley-Terry rating on the 0-100 scale: the Elo expectation against a 1000-rated opponent, as points. */
function ratingScore(rating, anchor = RATING_ANCHOR) {
    const value = num(rating);
    if (value == null) return null;
    return 100 / (1 + 10 ** ((anchor - value) / 400));
}

/**
 * The Index for one model: `{ index, n_components, weight_sum, components }`.
 *
 * `benchmarks` are the kind's public benchmarks the model has a verified median score on, as
 * `{ id, label?, score, runs? }`. `benchmarkCount` is how many public benchmarks the kind has; the benchmark half
 * of the weight is split over that whole list, so a model's missing benchmarks reduce its weight sum rather than
 * silently making its one benchmark worth half the Index. When the caller does not pass it, the list's length is
 * the count (the model has every benchmark of the kind).
 */
function openvibeIndex({ rating = null, benchmarks = [], benchmarkCount = null, weights = INDEX_WEIGHTS } = {}) {
    const ratingWeight = num(weights && weights.rating);
    const benchmarkWeight = num(weights && weights.benchmarks);
    const list = (Array.isArray(benchmarks) ? benchmarks : [])
        .filter((b) => b && num(b.score) != null)
        .map((b) => ({
            id: String(b.id),
            label: b.label == null ? String(b.id) : String(b.label),
            value: clamp(num(b.score), 0, 100),
            runs: b.runs == null ? null : num(b.runs),
        }));
    const count = Math.max(list.length, Math.max(0, num(benchmarkCount) || 0));
    const perBenchmark = count ? (benchmarkWeight || 0) / count : 0;

    const components = [];
    const ratingValue = ratingScore(rating);
    if (ratingValue != null && ratingWeight != null) {
        components.push({ id: 'rating', kind: 'rating', label: 'Human rating', value: ratingValue, weight: ratingWeight, runs: null });
    }
    for (const benchmark of list) {
        components.push({ id: benchmark.id, kind: 'benchmark', label: benchmark.label, value: benchmark.value, weight: perBenchmark, runs: benchmark.runs });
    }
    const weightSum = components.reduce((sum, component) => sum + component.weight, 0);
    const value = components.length >= 2 && weightSum > 0
        ? components.reduce((sum, component) => sum + component.value * component.weight, 0) / weightSum
        : null;
    return {
        index: round(value, 2),
        n_components: components.length,
        weight_sum: round(weightSum, 6),
        benchmark_count: count,
        components: components.map((component) => ({
            ...component,
            value: round(component.value, 2),
            weight: round(component.weight, 6),
        })),
    };
}

/**
 * The holdout gap for one model: the mean score on the public tasks minus the mean on the held-out tasks, with the
 * number of scored tasks on each side. A side with no scores makes the gap null, never zero.
 */
function holdoutGap(publicScores = [], holdoutScores = []) {
    const publicList = (Array.isArray(publicScores) ? publicScores : []).map(num).filter((v) => v != null);
    const holdoutList = (Array.isArray(holdoutScores) ? holdoutScores : []).map(num).filter((v) => v != null);
    const publicScore = mean(publicList);
    const holdoutScore = mean(holdoutList);
    return {
        public_n: publicList.length,
        public_score: round(publicScore, 2),
        holdout_n: holdoutList.length,
        holdout_score: round(holdoutScore, 2),
        gap: publicScore != null && holdoutScore != null ? round(publicScore - holdoutScore, 2) : null,
    };
}

module.exports = {
    INDEX_WEIGHTS, RATING_ANCHOR,
    openvibeIndex, holdoutGap, ratingScore, mean, median,
};

'use strict';

/**
 * The frontier (spec 3, "Pick for me"): the models no other model beats on both score and cost per solved task.
 *
 * The rule is deliberately narrow, because the whole point of the pick is that it never hides a model:
 *
 *   - a model is dropped when some other model is at least as good on score AND at least as cheap per solved task,
 *     with at least one of the two strictly better (that other model dominates it);
 *   - two models that are exactly equal on both axes are a tie, and a tie keeps both (neither dominates the other);
 *   - a model with no score or no cost cannot be compared at all, so it is never on the frontier and never
 *     dominates anyone.
 *
 * Pure maths, no I/O: the tests are the proof.
 */

const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

/** True when `other` dominates `row`: at least as good on both axes, and strictly better on one. */
function dominates(other, row) {
    const os = num(other && other.score);
    const oc = num(other && other.cost);
    const rs = num(row && row.score);
    const rc = num(row && row.cost);
    if (os == null || oc == null || rs == null || rc == null) return false;
    if (!(os >= rs && oc <= rc)) return false;
    // Exactly equal on both axes is a tie, not domination: both models stay.
    return !(os === rs && oc === rc);
}

/**
 * The frontier of a list of rows. Each row needs a `score` and a `cost`; rows missing either are left out.
 * The rows that come back keep the order they came in.
 */
function frontier(rows) {
    const list = (Array.isArray(rows) ? rows : [])
        .filter((r) => r && num(r.score) != null && num(r.cost) != null)
        .map((r) => ({ ...r, score: num(r.score), cost: num(r.cost) }));
    return list.filter((row) => !list.some((other) => other !== row && dominates(other, row)));
}

module.exports = { frontier, dominates };

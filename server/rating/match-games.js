'use strict';

/**
 * bench.match@1 → the pairwise games fitFactors reads (compare-arena-ecosystem.md, 2026-11-13).
 *
 * A match has two to eight sides and any number of judgements. Each judgement becomes games between pairs of sides:
 *
 *   winner a … h      the winner beats every other side (a person, a Live poll, an implicit signal, a game)
 *   winner tie        every pair ties
 *   winner both_bad   says nothing about the order: no game
 *   scores            (tests passed, a rubric score, a game's points) every pair is decided by the higher score,
 *                     an equal score is a tie
 *
 * A judgement's weight (the voter's quality) carries into its games; a side that failed, timed out or was refused
 * still plays (it lost on its merits). The style covariates are log(1 + length) and log(1 + markdown items) of each
 * side's answer, so the fit can hold style out of the score.
 */

const COVARIATES = 2;
const styleOf = (slot) => {
    const r = (slot && slot.receipts) || {};
    return [Math.log1p(Math.max(0, Number(r.length_chars) || 0)), Math.log1p(Math.max(0, Number(r.markdown_items) || 0))];
};

function gamesOf(matches) {
    const games = [];
    for (const m of Array.isArray(matches) ? matches : []) {
        const slots = new Map((m.slots || []).map((s) => [s.slot, s]));
        if (slots.size < 2) continue;
        const letters = [...slots.keys()];
        const pairs = [];
        for (let i = 0; i < letters.length; i++) for (let j = i + 1; j < letters.length; j++) pairs.push([letters[i], letters[j]]);
        for (const j of m.judgements || []) {
            const weight = j.weight == null ? 1 : Math.max(0, Number(j.weight) || 0);
            if (!weight) continue;
            for (const [x, y] of pairs) {
                let outcome = null;
                if (j.winner === 'tie') outcome = 'tie';
                else if (j.winner && j.winner !== 'both_bad' && slots.has(j.winner)) outcome = j.winner === x ? 'a' : j.winner === y ? 'b' : null;
                else if (j.scores && Number.isFinite(Number(j.scores[x])) && Number.isFinite(Number(j.scores[y]))) {
                    const sx = Number(j.scores[x]);
                    const sy = Number(j.scores[y]);
                    outcome = sx > sy ? 'a' : sx < sy ? 'b' : 'tie';
                }
                // A winner beats every other side; two losers did not play each other.
                if (!outcome) continue;
                games.push({ a: slots.get(x).entrant, b: slots.get(y).entrant, outcome, weight, fa: styleOf(slots.get(x)), fb: styleOf(slots.get(y)), judge: j.judge });
            }
        }
    }
    return games;
}

module.exports = { gamesOf, COVARIATES };

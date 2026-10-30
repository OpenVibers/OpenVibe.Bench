'use strict';

/**
 * The board the votes make (spec 3).
 *
 * Every human pairwise vote in Bench is one game between two models. The board is fitted twice over those games:
 * once on the votes alone (raw) and once with the style of each output as covariates (controlled), so a reader can
 * see how much of the ranking is style. The intervals come from a bootstrap of the votes, and models whose
 * intervals overlap share a band.
 *
 * The board is a pure function of the votes, so it is cached on the shape of the vote set and recomputed when a
 * new vote lands. The open dump (/api/v1/datasets/votes.jsonl) carries the same weights, so the board can be
 * re-derived from the file alone.
 */

const style = require('./style');

const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));

/** The human votes, with the two models and the two styles of each vote. */
async function loadVotes(db) {
    const rows = await db.many(
        `SELECT j.id, j.at, j.kind_id, j.round_id, j.outcome, j.subject, j.question, j.answer,
            l.model AS left_model, l.style_length AS left_length, l.style_markup AS left_markup, l.payload AS left_payload,
            r.model AS right_model, r.style_length AS right_length, r.style_markup AS right_markup, r.payload AS right_payload
          FROM bench_judgements j
          JOIN bench_entries l ON l.id = (j.pair->>'left')
          JOIN bench_entries r ON r.id = (j.pair->>'right')
          WHERE j.judge = 'human_pairwise' AND j.outcome IS NOT NULL
          ORDER BY j.at, j.id`);
    const out = [];
    for (const row of rows) {
        const left = styleOf(row.left_payload, row.left_length, row.left_markup);
        const right = styleOf(row.right_payload, row.right_length, row.right_markup);
        out.push({
            id: row.id,
            at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
            kind_id: row.kind_id,
            round_id: row.round_id,
            outcome: row.outcome,
            question: row.question || null,
            answer: row.answer || null,
            voter: row.subject || null,
            a: { model: row.left_model, length: left.length, markup: left.markup },
            b: { model: row.right_model, length: right.length, markup: right.markup },
        });
    }
    return out;
}

/** The style of an output: the columns when they are there, the payload when they are not (older entries). */
function styleOf(payload, length, markup) {
    if (length != null && markup != null) return { length: num(length), markup: num(markup) };
    let p = payload;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = {}; } }
    const features = style.styleFeatures(p || {});
    return { length: length == null ? features.length : num(length), markup: markup == null ? features.markup : num(markup) };
}

/** The games the fit reads. */
function gamesOf(votes) {
    const out = [];
    for (const v of votes) {
        const outcome = v.outcome === 'left' ? 'a' : v.outcome === 'right' ? 'b' : v.outcome === 'tie' ? 'tie' : 'both_bad';
        out.push({ id: v.id, a: v.a.model, b: v.b.model, outcome, fa: v.a, fb: v.b, voter: v.voter });
    }
    return out;
}

let cached = null;

/** The board, with the fit and the per-vote weights. Cached on the shape of the vote set. */
async function board(ctx, { bootstrap = style.BOOTSTRAP, force = false } = {}) {
    const db = ctx.s.db;
    const votes = await loadVotes(db);
    const key = votes.length + ':' + (votes.length ? votes[votes.length - 1].id : '') + ':' + num(bootstrap);
    if (!force && cached && cached.key === key && Date.now() - cached.at < 5 * 60_000) return cached.value;
    const games = gamesOf(votes);
    const fit = style.fitRatings(games, { bootstrap });
    const weights = new Map((fit.vote_weights || []).map((w) => [w.id, w.weight]));
    const enriched = votes.map((v) => ({ ...v, weight: weights.has(v.id) ? weights.get(v.id) : 1 }));
    const value = { fit, votes: enriched, generated_at: new Date().toISOString() };
    cached = { key, at: Date.now(), value };
    return value;
}

/**
 * The open dump: one line per vote, with no voter id anywhere. The weight the fit gave the vote is in the line,
 * so the board can be re-derived from the file alone.
 */
function dumpJsonl(result) {
    const lines = result.votes.map((v) => JSON.stringify({
        id: v.id,
        at: v.at,
        kind_id: v.kind_id,
        round_id: v.round_id,
        left: { model: v.a.model, length: v.a.length, markup: v.a.markup },
        right: { model: v.b.model, length: v.b.length, markup: v.b.markup },
        outcome: v.outcome,
        question: v.question,
        answer: v.answer,
        weight: v.weight,
    }));
    return lines.join('\n') + (lines.length ? '\n' : '');
}

/** The board as the page and the API show it. */
function boardView(result) {
    const fit = result.fit;
    return {
        models: fit.models,
        bands: fit.bands,
        effects: fit.effects,
        dropped_covariates: fit.dropped_covariates || [],
        voters: fit.voters,
        votes: fit.votes,
        bootstrap: fit.bootstrap,
        seed: fit.seed,
        generated_at: result.generated_at,
    };
}

module.exports = { loadVotes, gamesOf, board, dumpJsonl, boardView, styleOf };

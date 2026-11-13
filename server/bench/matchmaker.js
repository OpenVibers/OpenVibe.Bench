'use strict';

/**
 * The matchmaker for Bench's pairwise votes (plan section V.2, item 11b).
 *
 * A battle used to be a coin toss: pickPair took a random finished round and put that round's first entry on side A,
 * every time. Three things were wrong with that. The sides never changed, so the position bias of the voters (the
 * first output wins more often than it should) landed in the ratings. The votes went to pairs the board was already
 * sure about, so the board learned nothing from them. And a model that had just arrived waited for luck to be asked.
 *
 * The matchmaker asks a different question: which pair is the least decided? A pair scores
 *
 *      score = p (1 - p) x (wA + wB)
 *
 * where p is the chance the board gives the first side of the pair (the Elo formula, p = 1 / (1 + 10^((rB - rA) / 400)))
 * and w is the width of each model's interval. p (1 - p) is largest when the two models are close (a coin flip: the
 * vote is worth most) and smallest when one of them is expected to win (the vote changes nothing). The widths say how
 * much the board does not know yet, so a model the board has never rated is treated as its most uncertain model and is
 * asked first, without drowning the rest of the board, because p (1 - p) still decides how close the pairing is.
 *
 * Two rules keep the battles fair (the Copilot Arena lesson). The two sides are put in a random order, and the order
 * shown is what gets recorded, so the ratings can correct for the position. And two models of one family do not meet
 * while another family is in the round: the board learns more from two different families than from two cousins.
 *
 * This module is pure. It reads a board and a list of candidate rounds and says which pair to ask about; the
 * database stays in server/bench/battles.js.
 */

/** A rating with fewer games than this is not a rating yet, so the model counts as unknown. */
const MIN_GAMES = 20;
/** The width an unknown model gets when the board says nothing at all. */
const EMPTY_WIDTH = 400;
/** Where the board is centred, so an unknown model sits in the middle of it. */
const ANCHOR = 1000;
/** Two scores within this of each other are a tie, and the tie is broken by the random source. */
const TIE = 1e-9;

/**
 * The families a model belongs to: the vendor/series stem of its id. Two models of one family are cousins, and a
 * board learns less from two cousins than from two families. The provider prefix ("openai/gpt-4o") goes first; a
 * model the table does not know is a family of its own, named after the first segment of its id.
 */
const FAMILIES = Object.freeze([
    ['openai', /^(?:gpt|o[0-9])/],
    ['anthropic', /^claude/],
    ['google', /^(?:gemini|gemma)/],
    ['deepseek', /^deepseek/],
    ['qwen', /^qwen/],
    ['meta', /^llama/],
    ['mistral', /^(?:mistral|ministral)/],
    ['xai', /^grok/],
    ['zhipu', /^glm/],
    ['moonshot', /^kimi/],
]);

const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));

/**
 * The model id without its provider prefix: "openai/gpt-4o" and "gpt-4o" are one model, not two. The prefix is
 * everything up to the last slash, so a nested route ("azure/openai/gpt-4o") is stripped too.
 */
function stemOf(model) {
    const id = String(model == null ? '' : model).trim().toLowerCase();
    const cut = id.lastIndexOf('/');
    return cut >= 0 ? id.slice(cut + 1) : id;
}

/**
 * The family of a model id: "anthropic/claude-3-5-sonnet" and "claude-3-5-sonnet" are both anthropic, "llama-3.3-70b"
 * is meta, and a model nobody has heard of ("acme-7b") is a family of its own.
 */
function familyOf(model) {
    const stem = stemOf(model);
    for (const [family, match] of FAMILIES) if (match.test(stem)) return family;
    const head = stem.split(/[-.:]/).filter(Boolean)[0];
    return head || 'unknown';
}

/** Two entries are the same model when their stems match, so "openai/gpt-4o" never meets "gpt-4o". */
function sameModel(a, b) {
    return stemOf(a) === stemOf(b);
}

/** The median of a list of numbers. */
function median(values) {
    const xs = (values || []).map(Number).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!xs.length) return null;
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** A board as a Map: model -> { rating, ci_lower, ci_upper, games }. */
function toMap(rows) {
    if (!rows) return new Map();
    if (rows instanceof Map) return rows;
    if (typeof rows !== 'object') return new Map();
    const out = new Map();
    for (const [model, row] of Object.entries(rows)) out.set(model, row);
    return out;
}

/** Does this value look like a board row (a rating with an interval) rather than a board of rows? */
function looksLikeRow(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && ('rating' in value || 'ci_lower' in value || 'ci_upper' in value);
}

/**
 * The board of one kind. The board may be a map of kind id -> board (what pickPair builds), a function that returns
 * the board of a kind, or a plain model -> row map when every candidate is of the same kind.
 */
function boardOfKind(board, kindId) {
    if (!board) return new Map();
    if (typeof board === 'function') return toMap(board(kindId));
    const key = String(kindId);
    if (board instanceof Map) {
        if (board.has(key)) return toMap(board.get(key));
        // A map of models is used as it is when it holds rows and has no entry for the kind.
        return [...board.values()].some(looksLikeRow) ? board : new Map();
    }
    if (typeof board === 'object') {
        if (Object.prototype.hasOwnProperty.call(board, key)) return toMap(board[key]);
        return Object.values(board).some(looksLikeRow) ? toMap(board) : new Map();
    }
    return new Map();
}

/**
 * What the board knows about itself: the widest interval it has (how uncertain it is about its most uncertain
 * model) and the median rating (where an unknown model sits). A board whose models are all rated is the reference;
 * a board with no rated model at all falls back to every row, and an empty board to the anchor and the empty width.
 */
function referenceOf(board) {
    const rows = [...toMap(board).values()].filter((r) => r && r.rating != null);
    const rated = rows.filter((r) => num(r.games) >= MIN_GAMES);
    const base = rated.length ? rated : rows;
    if (!base.length) return { widest: EMPTY_WIDTH, median: ANCHOR };
    let widest = 0;
    for (const row of base) widest = Math.max(widest, num(row.ci_upper) - num(row.ci_lower));
    const mid = median(base.map((r) => num(r.rating)));
    return { widest: widest > 0 ? widest : EMPTY_WIDTH, median: mid == null ? ANCHOR : mid };
}

/** The board row of a model, by its exact id or by its stem, so a prefixed id finds its own rating. */
function rowOf(board, model) {
    const map = toMap(board);
    const exact = map.get(model);
    if (exact) return exact;
    const stem = stemOf(model);
    if (!stem) return null;
    for (const [key, row] of map) if (stemOf(key) === stem) return row;
    return null;
}

/**
 * What one model looks like to the matchmaker. A model the board has never rated (no row), or one with too few
 * games to be a rating, is the board's most uncertain model: the widest interval and the median rating.
 */
function statsOf(board, model, reference) {
    const row = rowOf(board, model);
    if (!row || num(row.games) < MIN_GAMES) return { rating: reference.median, width: reference.widest };
    const rating = num(row.rating, reference.median);
    const lower = num(row.ci_lower, rating);
    const upper = num(row.ci_upper, rating);
    return { rating, width: Math.max(0, upper - lower) };
}

/** The chance the board gives the first side of a pair. */
function winChance(ratingA, ratingB) {
    return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/** How much a vote on this pair is worth: the closeness of the pairing times how much is unknown. */
function pairScore(a, b) {
    const p = winChance(a.rating, b.rating);
    return p * (1 - p) * (a.width + b.width);
}

/** The entries of a round that can be put in a battle: they have an id and a model to be rated under. */
function usableEntries(candidate) {
    const entries = candidate && Array.isArray(candidate.entries) ? candidate.entries : [];
    return entries.filter((e) => e && e.id != null && e.id !== '' && String(e.model == null ? '' : e.model).trim() !== '');
}

/**
 * The pair to ask about: { round_id, kind_id, a, b, score, swapped }, or null when there is nothing to ask.
 *
 * The candidates are [{ round_id, kind_id, entries: [{ id, model, ... }] }], the board maps model -> { rating,
 * ci_lower, ci_upper, games } for the controlled rating of that kind, and the random source breaks the ties and
 * decides which side is shown first.
 */
function choosePair({ candidates, board, random = Math.random } = {}) {
    const rand = typeof random === 'function' ? random : Math.random;
    const references = new Map();
    const scored = [];
    for (const candidate of candidates || []) {
        if (!candidate) continue;
        const entries = usableEntries(candidate);
        if (entries.length < 2) continue;
        const kindId = String(candidate.kind_id == null ? '' : candidate.kind_id);
        if (!references.has(kindId)) {
            const rows = boardOfKind(board, kindId);
            references.set(kindId, { rows, reference: referenceOf(rows) });
        }
        const { rows, reference } = references.get(kindId);
        // While another family is in the round, two models of one family do not meet.
        const families = new Set(entries.map((e) => familyOf(e.model)));
        const crossFamily = families.size > 1;
        for (let i = 0; i < entries.length; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                const x = entries[i];
                const y = entries[j];
                if (sameModel(x.model, y.model)) continue;
                if (crossFamily && familyOf(x.model) === familyOf(y.model)) continue;
                const score = pairScore(statsOf(rows, x.model, reference), statsOf(rows, y.model, reference));
                scored.push({ candidate, a: x, b: y, score });
            }
        }
    }
    if (!scored.length) return null;
    // The best score wins; the pairs within a hair of it are a tie, and the random source breaks it.
    let bestScore = -Infinity;
    for (const pair of scored) if (pair.score > bestScore) bestScore = pair.score;
    const ties = scored.filter((pair) => pair.score >= bestScore - TIE);
    const chosen = ties[Math.floor(rand() * ties.length) % ties.length];
    // The sides are put in a random order, so the position of an output does not decide the vote.
    const swapped = rand() < 0.5;
    return {
        round_id: chosen.candidate.round_id,
        kind_id: chosen.candidate.kind_id,
        a: swapped ? chosen.b : chosen.a,
        b: swapped ? chosen.a : chosen.b,
        score: chosen.score,
        swapped,
    };
}

module.exports = {
    choosePair, familyOf, sameModel, stemOf, winChance, pairScore, referenceOf, statsOf,
    MIN_GAMES, EMPTY_WIDTH, ANCHOR, FAMILIES,
};

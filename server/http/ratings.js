'use strict';

/**
 * The ratings page: the board the votes make, raw and style controlled, side by side.
 *
 * The board is a Bradley-Terry fit over the human votes with the style of each output as covariates, and every
 * rating carries a bootstrap interval. Models whose intervals overlap share a band, so the page says "2nd-4th"
 * instead of pretending the third place is a fact. The open dump next to it carries every vote without voter ids,
 * and the fit can be re-derived from that file alone.
 *
 * The board is a table, like B2's rankings: a band, a model, the style-controlled score with its interval on one
 * scale (so an overlap shows at a glance), the raw score muted, and the vote count. On a phone each row folds
 * into two lines.
 */

const express = require('express');
const { esc, raw } = require('../render/html');
const { send } = require('../render/layout');
const { board, boardView } = require('../rating/board');

const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));

/** The rounded score and its interval, as text. */
/** The score and its interval as HTML: the interval in its own span, so a phone can set it on a line of its own. */
function scoreHtml(cell) {
    if (!cell) return '—';
    const lo = cell.ci_lower == null ? null : Math.round(cell.ci_lower);
    const hi = cell.ci_upper == null ? null : Math.round(cell.ci_upper);
    return esc(Math.round(cell.rating)) + (lo == null ? '' : ' <span class="rt-ci">(' + esc(lo) + '–' + esc(hi) + ')</span>');
}

/**
 * The interval bar: one scale for the whole board (its lowest lower bound to its highest upper bound), so two
 * models that overlap show it at a glance. The numbers stay text next to it.
 */
function bar(cell, scale) {
    if (!cell || !scale || scale.max <= scale.min) return '';
    const at = (v) => Math.max(0, Math.min(100, ((v - scale.min) / (scale.max - scale.min)) * 100));
    const lo = at(cell.ci_lower == null ? cell.rating : cell.ci_lower);
    const hi = at(cell.ci_upper == null ? cell.rating : cell.ci_upper);
    const point = at(cell.rating);
    const width = Math.max(0.6, hi - lo);
    return '<svg class="rt-bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false">'
        + '<rect class="rt-bar-track" x="0" y="3" width="100" height="2" rx="1"></rect>'
        + '<rect class="rt-bar-range" x="' + lo.toFixed(2) + '" y="2.6" width="' + width.toFixed(2) + '" height="2.8" rx="1.4"></rect>'
        + '<rect class="rt-bar-point" x="' + (point - 0.7).toFixed(2) + '" y="0.6" width="1.4" height="6.8" rx="0.7"></rect>'
        + '</svg>';
}

/** One plain sentence per covariate: what the style did, in words, rounded. */
function styleSentence(key, effect) {
    const points = (v) => Math.round(Math.abs(num(v)));
    if (key === 'length') {
        const n = points(effect.elo_per_1000_chars);
        if (!n) return 'The length of an output made no difference to the votes.';
        return effect.elo_per_1000_chars < 0
            ? 'Longer outputs lost about ' + n + ' points per 1,000 characters here.'
            : 'Longer outputs won about ' + n + ' points per 1,000 characters here.';
    }
    if (key === 'markup') {
        const n = points(effect.elo_per_10_marks);
        if (!n) return 'How much markup an output wore made no difference to the votes.';
        return effect.elo_per_10_marks < 0
            ? 'More markup lost about ' + n + ' points per 10 markup marks here.'
            : 'More markup won about ' + n + ' points per 10 markup marks here.';
    }
    return '';
}

function rows(view) {
    if (!view.models.length) {
        return '<div class="bm-empty"><h1>No battles voted yet</h1>'
            + '<p>The board fills up as people vote in the battles.</p>'
            + '<p class="bm-actions"><a class="bm-btn" href="/battle">Vote in a battle</a></p></div>';
    }
    // The board is ordered by the style-controlled score: the honest one.
    const models = [...view.models].sort((a, b) => b.controlled.rating - a.controlled.rating || a.model.localeCompare(b.model));
    let min = Infinity;
    let max = -Infinity;
    for (const m of models) {
        for (const cell of [m.raw, m.controlled]) {
            if (!cell) continue;
            min = Math.min(min, num(cell.ci_lower, cell.rating));
            max = Math.max(max, num(cell.ci_upper, cell.rating));
        }
    }
    const scale = { min, max };
    const body = models.map((m) => '<tr data-model="' + esc(m.model) + '">'
        + '<td class="rt-col-band"><span class="rt-band">' + esc(m.controlled.band || m.raw.band || '') + '</span></td>'
        + '<td class="rt-col-model"><span class="rt-model">' + esc(m.model) + '</span></td>'
        + '<td class="rt-col-controlled"><span class="rt-score">' + scoreHtml(m.controlled) + '</span>'
        + bar(m.controlled, scale) + '</td>'
        + '<td class="rt-col-raw"><span class="rt-score rt-score-muted">' + scoreHtml(m.raw) + '</span>'
        + bar(m.raw, scale) + '</td>'
        + '<td class="rt-col-votes rt-num">' + esc(m.votes) + '</td>'
        + '</tr>').join('');
    return '<div class="br-table-wrap rt-wrap"><table class="br-table rt-table">'
        + '<caption class="br-sr">Models in rank bands, with the style-controlled score and its interval, the raw score and its interval, and the number of votes</caption>'
        + '<thead><tr><th scope="col">Band</th><th scope="col">Model</th><th scope="col">Style controlled</th>'
        + '<th scope="col">Raw</th><th scope="col" class="br-num">Votes</th></tr></thead>'
        + '<tbody>' + body + '</tbody></table></div>';
}

function effects(view) {
    const list = Object.entries(view.effects || {}).map(([key, e]) => styleSentence(key, e)).filter(Boolean);
    const dropped = (view.dropped_covariates || []).map((key) => key === 'markup'
        ? 'Markup moved with the length of the outputs here, so it is not counted a second time.'
        : key + ' was not counted separately.');
    const sentences = list.concat(dropped);
    if (!sentences.length) return '';
    return '<section class="rt-effects"><h2>How much of the board is style</h2>'
        + '<ul class="rt-style-list">' + sentences.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ul>'
        + '<p class="bm-fine">The raw column is what people chose; the style-controlled column is what the models would '
        + 'score if every output were written the same way. A negative effect means the style lost votes it should not '
        + 'have lost.</p>'
        + '</section>';
}

function ratingsView(view) {
    return '<section class="rt-board" data-ratings="1">'
        + '<h1>Ratings</h1>'
        + '<p class="bm-lede">Every human vote in Bench is one game between two models. The board is fitted twice: on the '
        + 'votes alone (raw) and with the style of each output as covariates (style controlled), so you can see how much '
        + 'of a rank is length and formatting.</p>'
        + (view.votes
            ? '<p class="bm-fine">' + esc(view.votes) + ' votes, '
                + esc(view.bootstrap) + ' bootstrap resamples, seed ' + esc(view.seed)
                + (view.voters && view.voters.downweighted ? ', ' + esc(view.voters.downweighted) + ' voters down-weighted (never named)' : '')
                + '</p>'
            : '')
        + rows(view)
        + effects(view)
        + '<section class="rt-data"><h2>The open data</h2>'
        + '<p class="bm-lede">Every vote is published as JSONL, without voter ids: '
        + '<a href="/api/v1/datasets/votes.jsonl">/api/v1/datasets/votes.jsonl</a>. '
        + 'The fit is reproducible from it: <code>node scripts/fit-ratings.js /tmp/votes.jsonl</code> re-derives the '
        + 'same numbers (the dump carries the weight each vote carries in the fit).</p></section>'
        + '</section>';
}

function createRatingsPages(ctx) {
    const r = express.Router();
    const { config, principal } = ctx;
    r.use(principal.middleware);
    const viewerOf = (req) => (req.principal && req.principal.kind === 'user'
        ? { kind: 'user', subject: req.principal.subject, displayName: req.principal.displayName || req.principal.username }
        : { kind: 'anonymous' });

    r.get('/', async (req, res) => {
        const result = await board(ctx);
        const view = boardView(result);
        return send(res, 200, {
            config, viewer: viewerOf(req), path: req.originalUrl,
            title: 'Ratings: raw and style controlled',
            description: 'The board the votes make: raw and style-controlled Bradley-Terry, with intervals and bands.',
            body: raw(ratingsView(view)),
        });
    });

    return r;
}

module.exports = { createRatingsPages };

'use strict';

/**
 * The ratings page: the board the votes make, raw and style controlled, side by side.
 *
 * The board is a Bradley-Terry fit over the human votes with the style of each output as covariates, and every
 * rating carries a bootstrap interval. Models whose intervals overlap share a band, so the page says "2nd-4th"
 * instead of pretending the third place is a fact. The open dump next to it carries every vote without voter ids,
 * and the fit can be re-derived from that file alone.
 */

const express = require('express');
const { esc, raw } = require('../render/html');
const { send } = require('../render/layout');
const { board, boardView } = require('../rating/board');

function interval(cell) {
    if (!cell) return '';
    const lo = cell.ci_lower == null ? '' : Math.round(cell.ci_lower);
    const hi = cell.ci_upper == null ? '' : Math.round(cell.ci_upper);
    return '<span class="rt-rating">' + esc(Math.round(cell.rating)) + '</span>'
        + '<span class="rt-ci">' + esc(lo + '–' + hi) + '</span>';
}

function rows(view) {
    if (!view.models.length) {
        return '<div class="bm-empty"><h1>No votes yet</h1><p>The board fills up as people vote in the battles.</p></div>';
    }
    const body = view.models.map((m) => '<li class="rt-row" data-model="' + esc(m.model) + '">'
        + '<div class="rt-cell rt-cell-model"><span class="rt-label">Model</span>'
        + '<span class="rt-model">' + esc(m.model) + '</span></div>'
        + '<div class="rt-cell"><span class="rt-label">Raw</span>' + interval(m.raw)
        + '<span class="rt-band">' + esc(m.raw.band || '') + '</span></div>'
        + '<div class="rt-cell"><span class="rt-label">Style controlled</span>' + interval(m.controlled)
        + '<span class="rt-band">' + esc(m.controlled.band || '') + '</span></div>'
        + '<div class="rt-cell"><span class="rt-label">Votes</span><span class="rt-votes">' + esc(m.votes) + '</span></div>'
        + '</li>').join('');
    return '<ul class="rt-list">' + body + '</ul>';
}

function effects(view) {
    const list = Object.entries(view.effects || {});
    if (!list.length) return '';
    const items = list.map(([key, e]) => '<div><dt>' + esc(key) + '</dt><dd>'
        + (e.elo_per_1000_chars != null ? esc(e.elo_per_1000_chars) + ' Elo per 1000 characters' : '')
        + (e.elo_per_1000_chars != null && e.elo_per_10_marks != null ? '<br>' : '')
        + (e.elo_per_10_marks != null ? esc(e.elo_per_10_marks) + ' Elo per 10 markup marks' : '')
        + '</dd></div>').join('');
    return '<section class="rt-effects"><h2>How much of the board is style</h2>'
        + '<dl class="br-facts">' + items + '</dl>'
        + '<p class="bm-fine">A positive number means the longer (or the more dressed up) output wins votes it did not '
        + 'earn. The controlled column removes that effect; the raw column is what people actually chose.</p>'
        + '</section>';
}

function ratingsView(view) {
    return '<section class="rt-board" data-ratings="1">'
        + '<h1>Ratings</h1>'
        + '<p class="bm-lede">Every human vote in Bench is one game between two models. The board is fitted twice: on the '
        + 'votes alone (raw) and with the style of each output as covariates (style controlled), so you can see how much '
        + 'of a rank is length and formatting.</p>'
        + '<p class="bm-fine">' + esc(view.votes) + ' votes, '
        + esc(view.bootstrap) + ' bootstrap resamples, seed ' + esc(view.seed)
        + (view.voters && view.voters.downweighted ? ', ' + esc(view.voters.downweighted) + ' voters down-weighted (never named)' : '')
        + '</p>'
        + '<div class="rt-table-wrap">' + rows(view) + '</div>'
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

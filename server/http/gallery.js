'use strict';

/**
 * The gallery (spec 1): every showcase round's outputs, live in the sandboxed render frames.
 *
 * The page is a filtered, ordered list of rounds: filter by kind, model and price; order by newest or by most
 * voted. The frames are lazy: at most six live frames run at a time, and the rest wait as a still (a screenshot
 * Bench's own job made, when there is one) until the reader asks for the live one.
 */

const express = require('express');
const { asyncRouter } = require('./router');
const renderLib = require('../bench/render');
const { kindById, SHOWCASE_KIND_IDS } = require('../kinds');
const { esc, raw } = require('../render/html');
const { send } = require('../render/layout');

const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
/** How many frames may be live at once. */
const LIVE_FRAMES = 6;

function parsePrice(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
}

/** The screenshot Bench's own job made for an entry, when it made one. */
function screenshotOf(uiCheck) {
    if (!uiCheck || typeof uiCheck !== 'object') return null;
    for (const key of ['screenshot', 'screenshot_url', 'image', 'thumb', 'thumbnail']) {
        const v = uiCheck[key];
        if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
    }
    return null;
}

async function loadGallery(ctx, { kind = 'all', model = '', price = null, order = 'new', limit = 60 } = {}) {
    const db = ctx.s.db;
    const kinds = kind && kind !== 'all' ? [String(kind)] : SHOWCASE_KIND_IDS;
    const rows = await db.many(
        `SELECT r.id, r.kind_id, r.created_at, t.prompt,
            (SELECT COUNT(*)::int FROM bench_judgements j WHERE j.round_id = r.id AND j.judge = 'human_pairwise') AS votes,
            (SELECT COUNT(*)::int FROM bench_entries e WHERE e.round_id = r.id AND e.error IS NULL) AS entries
          FROM bench_rounds r JOIN bench_tasks t ON t.id = r.task_id
          WHERE r.status = 'finished' AND r.kind_id = ANY($1::text[])
            AND ($2::text = '' OR EXISTS (SELECT 1 FROM bench_entries e WHERE e.round_id = r.id AND e.model = $2))
            AND ($3::numeric IS NULL OR EXISTS (SELECT 1 FROM bench_entries e WHERE e.round_id = r.id AND e.error IS NULL AND e.cost_usd <= $3))
          ORDER BY ${order === 'votes' ? 'votes DESC, r.created_at DESC' : 'r.created_at DESC, r.id DESC'}
          LIMIT $4`,
        [kinds, String(model || ''), price, Math.min(120, Math.max(1, num(limit, 60)))]);
    const out = [];
    for (const r of rows) {
        if (num(r.entries) < 2) continue;
        const entries = await db.many(
            'SELECT id, provider, model, cost_usd, ms, ui_check FROM bench_entries WHERE round_id = $1 AND error IS NULL ORDER BY id LIMIT 2',
            [r.id]);
        if (entries.length < 2) continue;
        const k = kindById(r.kind_id);
        out.push({
            id: r.id, kind_id: r.kind_id, kind_name: k ? k.name : r.kind_id,
            prompt: r.prompt, votes: num(r.votes), created_at: new Date(r.created_at).toISOString(),
            limit_ms: k ? renderLib.limitMsOf(k) : renderLib.DEFAULT_LIMIT_MS,
            entries: entries.map((e) => ({
                id: e.id, model: e.model, provider: e.provider, cost_usd: num(e.cost_usd), ms: num(e.ms),
                screenshot: screenshotOf(e.ui_check),
                wrapper_url: renderLib.RENDER_ORIGIN + '/render/w/' + encodeURIComponent(e.id),
            })),
        });
    }
    return out;
}

/** The kinds and models the filter offers. */
async function facets(ctx) {
    const db = ctx.s.db;
    const kinds = await db.many(
        `SELECT r.kind_id AS id, COUNT(*)::int AS n FROM bench_rounds r
         WHERE r.status = 'finished' AND r.kind_id = ANY($1::text[]) GROUP BY r.kind_id ORDER BY r.kind_id`,
        [SHOWCASE_KIND_IDS]);
    const models = await db.many(
        `SELECT e.model AS id, COUNT(*)::int AS n FROM bench_entries e JOIN bench_rounds r ON r.id = e.round_id
         WHERE r.status = 'finished' AND r.kind_id = ANY($1::text[]) AND e.model IS NOT NULL
         GROUP BY e.model ORDER BY n DESC, e.model LIMIT 40`,
        [SHOWCASE_KIND_IDS]);
    return {
        kinds: kinds.map((k) => ({ id: k.id, name: (kindById(k.id) || {}).name || k.id, count: num(k.n) })),
        models: models.map((m) => ({ id: m.id, count: num(m.n) })),
    };
}

function frame(entry, live) {
    const src = live
        ? '<iframe class="ga-frame" data-live="1" data-server="1" src="' + esc(entry.wrapper_url) + '" title="Output of ' + esc(entry.model) + '"'
        + ' sandbox="' + esc(renderLib.WRAPPER_SANDBOX) + '" referrerpolicy="no-referrer" loading="lazy"></iframe>'
        : '<button type="button" class="ga-still" data-ga-still="1" aria-label="Load the live frame">'
        + (entry.screenshot
            ? '<img src="' + esc(entry.screenshot) + '" alt="A still of the output" loading="lazy">'
            : '<span class="ga-still-note">Live frame, on tap</span>')
        + '</button>';
    return '<figure class="ga-shot" data-entry-id="' + esc(entry.id) + '" data-src="' + esc(entry.wrapper_url) + '">'
        + '<figcaption>' + esc(entry.model) + '</figcaption>' + src + '</figure>';
}

function card(round, live) {
    return '<article class="ga-card" data-round-id="' + esc(round.id) + '" data-kind="' + esc(round.kind_id) + '" data-votes="' + esc(round.votes) + '">'
        + '<h2 class="ga-prompt" data-prompt="1">' + esc(round.prompt) + '</h2>'
        + '<div class="ga-shots">' + round.entries.map((e) => frame(e, live)).join('') + '</div>'
        + '<p class="ga-meta"><span class="br-chip">' + esc(round.kind_name) + '</span>'
        + '<span class="ga-votes" data-votes="' + esc(round.votes) + '">' + esc(round.votes) + ' votes</span>'
        + '<span class="bm-fine">' + esc('$' + Math.max(...round.entries.map((e) => e.cost_usd)).toFixed(4)) + ' at most</span>'
        + '<a class="ga-link" href="/showcase/round/' + esc(round.id) + '">Open side by side</a></p>'
        + '</article>';
}

function filterBar(ctx, { kind, model, price, order }) {
    const kinds = SHOWCASE_KIND_IDS.map((id) => {
        const k = kindById(id);
        return '<option value="' + esc(id) + '"' + (kind === id ? ' selected' : '') + '>' + esc(k ? k.name : id) + '</option>';
    }).join('');
    return '<form class="ga-filters" method="get" action="/gallery" data-ga-filters="1">'
        + '<label>Kind<select name="kind"><option value="all"' + (kind === 'all' ? ' selected' : '') + '>All kinds</option>' + kinds + '</select></label>'
        + '<label>Model<input type="text" name="model" value="' + esc(model || '') + '" placeholder="model name"></label>'
        + '<label>Price at most<input type="text" inputmode="decimal" name="price" value="' + esc(price == null ? '' : String(price)) + '" placeholder="$0.05"></label>'
        + '<label>Order<select name="order">'
        + '<option value="new"' + (order !== 'votes' ? ' selected' : '') + '>Newest</option>'
        + '<option value="votes"' + (order === 'votes' ? ' selected' : '') + '>Most voted</option>'
        + '</select></label>'
        + '<button class="bm-btn bm-btn-small" type="submit">Filter</button>'
        + '</form>';
}

function galleryView(rounds, filters) {
    if (!rounds.length) {
        return '<section class="ga-gallery" data-gallery="1">'
            + '<p class="bm-lede">Every showcase round, with its outputs live in sandboxed frames.</p>'
            + '<div class="bm-empty"><h1>Nothing matches yet</h1><p>No round fits that filter. The first rounds are still generating.</p></div>'
            + '</section>';
    }
    return '<section class="ga-gallery" data-gallery="1">'
        + '<p class="bm-lede">Every showcase round, with its outputs live in sandboxed frames. At most six frames run at '
        + 'once; the rest wait for you.</p>'
        + '<div class="ga-grid">' + rounds.map((r, i) => card(r, i * 2 < LIVE_FRAMES)).join('') + '</div>'
        + '</section>';
}

function createGalleryRoutes(ctx) {
    const r = asyncRouter();
    r.get('/', async (req, res) => {
        const filters = {
            kind: typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : 'all',
            model: typeof req.query.model === 'string' ? req.query.model : '',
            price: parsePrice(req.query.price),
            order: req.query.order === 'votes' ? 'votes' : 'new',
        };
        const rounds = await loadGallery(ctx, filters);
        res.set('Cache-Control', 'public, max-age=30');
        return res.json({ count: rounds.length, filters, rounds });
    });
    r.get('/facets', async (req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        return res.json(await facets(ctx));
    });
    return r;
}

function createGalleryPages(ctx) {
    const r = express.Router();
    const { config, principal } = ctx;
    r.use(principal.middleware);
    const viewerOf = (req) => (req.principal && req.principal.kind === 'user'
        ? { kind: 'user', subject: req.principal.subject, displayName: req.principal.displayName || req.principal.username }
        : { kind: 'anonymous' });

    r.get('/', async (req, res) => {
        const filters = {
            kind: typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : 'all',
            model: typeof req.query.model === 'string' ? req.query.model : '',
            price: parsePrice(req.query.price),
            order: req.query.order === 'votes' ? 'votes' : 'new',
        };
        const rounds = await loadGallery(ctx, filters);
        const f = await facets(ctx);
        const body = '<section class="ga-head">'
            + '<h1>Gallery</h1>'
            + '<p class="bm-lede">Every showcase round, with its outputs live in sandboxed frames. Filter by kind, model '
            + 'and price; order by newest or by most voted.</p>'
            + filterBar(ctx, filters)
            + '<p class="bm-fine">' + esc(f.kinds.length + ' kinds, ' + f.models.length + ' models in the gallery') + '</p>'
            + '</section>' + galleryView(rounds, filters);
        return send(res, 200, {
            config, viewer: viewerOf(req), path: req.originalUrl,
            title: 'Gallery: every showcase round',
            description: 'Every showcase round, live in sandboxed frames. Filter by kind, model and price.',
            body: raw(body),
        });
    });

    return r;
}

module.exports = { createGalleryRoutes, createGalleryPages, loadGallery, facets, LIVE_FRAMES };

'use strict';

/**
 * The showcase surfaces (spec 4 and 5): the gallery of pairs, the live side-by-side compare page, the blind vote and
 * the stats endpoint. The API and the pages read the same data, so a page never promises something the API does
 * not answer. Blindness is the rule: a voter sees two numbered panes (A and B) and no model name until they vote.
 */

const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./same-origin');
const renderLib = require('../bench/render');
const { kindById, SHOWCASE_KIND_IDS } = require('../kinds');
const { esc, raw } = require('../render/html');
const { send } = require('../render/layout');


const num = (v, d) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));

function slotsOf(entries, revealed, kind) {
    return entries.slice(0, 2).map((e, i) => {
        const base = {
            slot: i === 0 ? 'A' : 'B',
            entry_id: e.id,
            render_url: renderLib.RENDER_ORIGIN + '/render/e/' + encodeURIComponent(e.id),
            wrapper_url: renderLib.RENDER_ORIGIN + '/render/w/' + encodeURIComponent(e.id),
            limit_ms: kind ? renderLib.limitMsOf(kind) : renderLib.DEFAULT_LIMIT_MS,
            error: e.error || null,
        };
        if (!revealed) return base;
        return Object.assign({}, base, {
            model: e.model, provider: e.provider, route: e.route || null,
            cost_usd: num(e.cost_usd), ms: num(e.ms), tokens: num(e.tokens),
        });
    });
}

async function entriesOf(db, roundId) {
    return await db.many(
        "SELECT id, provider, model, route, cost_usd, ms, tokens, error FROM bench_entries WHERE round_id = $1 AND error IS NULL ORDER BY id LIMIT 2",
        [roundId]);
}

async function voteCount(db, roundId) {
    return num(await db.value(
        "SELECT COUNT(*)::int AS n FROM bench_judgements WHERE round_id = $1 AND method = 'human_pairwise'",
        [roundId]));
}

async function loadPairs(ctx, opts) {
    const db = ctx.s.db;
    const kind = opts && opts.kind ? String(opts.kind) : 'all';
    const kinds = kind && kind !== 'all' ? [kind] : SHOWCASE_KIND_IDS;
    const limit = Math.min(100, Math.max(1, num(opts && opts.limit, 24)));
    const rows = await db.many(
        "SELECT r.id, r.kind_id, r.created_at, r.created_by, t.prompt, t.task_class FROM bench_rounds r JOIN bench_tasks t ON t.id = r.task_id WHERE r.status = 'finished' AND r.kind_id = ANY($1::text[]) ORDER BY r.created_at DESC, r.id LIMIT $2",
        [kinds, limit]);
    const out = [];
    for (const r of rows) {
        const entries = await entriesOf(db, r.id);
        if (entries.length < 2) continue;
        const k = kindById(r.kind_id);
        out.push({
            id: r.id, kind_id: r.kind_id, kind_name: k ? k.name : r.kind_id,
            prompt: r.prompt, task_class: r.task_class, created_at: r.created_at,
            votes: await voteCount(db, r.id), slots: slotsOf(entries, false, k),
        });
    }
    return out;
}

async function loadRound(ctx, id, subject) {
    const db = ctx.s.db;
    const r = await db.maybe(
        "SELECT r.*, t.prompt, t.task_class FROM bench_rounds r JOIN bench_tasks t ON t.id = r.task_id WHERE r.id = $1",
        [String(id || '')]);
    if (!r) return null;
    const entries = await entriesOf(db, r.id);
    if (entries.length < 2) {
        return { id: r.id, kind_id: r.kind_id, kind_name: r.kind_id, prompt: r.prompt, task_class: r.task_class, created_at: r.created_at, votes: 0, voted: false, revealed: false, ready: false, mode: 'script', limit_ms: renderLib.DEFAULT_LIMIT_MS, is_game: r.kind_id === 'games.play', slots: [] };
    }
    const voted = subject
        ? num(await db.value("SELECT COUNT(*)::int AS n FROM bench_judgements WHERE round_id = $1 AND subject = $2", [r.id, subject])) > 0
        : false;
    const revealed = Boolean(voted || (subject && r.created_by === subject));
    const k = kindById(r.kind_id);
    return {
        id: r.id, kind_id: r.kind_id, kind_name: k ? k.name : r.kind_id,
        prompt: r.prompt, task_class: r.task_class, created_at: r.created_at,
        votes: await voteCount(db, r.id), voted, revealed, ready: true,
        mode: k ? renderLib.modeOf(k) : 'script',
        limit_ms: k ? renderLib.limitMsOf(k) : renderLib.DEFAULT_LIMIT_MS,
        is_game: r.kind_id === 'games.play',
        slots: slotsOf(entries, revealed, k),
    };
}

async function loadStats(ctx) {
    const db = ctx.s.db;
    const ratings = await db.many(
        "SELECT kind_id, category, subject, elo, games, wins, losses, ties, win_rate, ci_lower, ci_upper, median_cost_usd, median_ms FROM bench_ratings WHERE category = 'all' ORDER BY kind_id, elo DESC");
    const costs = await db.many(
        "SELECT r.kind_id AS kind_id, e.model AS model, COUNT(*)::int AS entries,"
        + " COALESCE(SUM(e.cost_usd), 0)::numeric AS total_cost,"
        + " percentile_cont(0.5) WITHIN GROUP (ORDER BY e.cost_usd) AS median_cost,"
        + " percentile_cont(0.5) WITHIN GROUP (ORDER BY e.ms) AS median_ms,"
        + " percentile_cont(0.95) WITHIN GROUP (ORDER BY e.ms) AS p95_ms,"
        + " COALESCE(SUM(e.tokens), 0)::int AS tokens,"
        + " COUNT(*) FILTER (WHERE e.error IS NOT NULL)::int AS errors"
        + " FROM bench_entries e JOIN bench_rounds r ON r.id = e.round_id"
        + " WHERE r.kind_id = ANY($1::text[]) AND e.model IS NOT NULL"
        + " GROUP BY r.kind_id, e.model",
        [SHOWCASE_KIND_IDS]);
    const byKey = new Map();
    for (const c of costs) byKey.set(c.kind_id + '|' + c.model, c);
    const kinds = new Map();
    for (const r of ratings) {
        if (!SHOWCASE_KIND_IDS.includes(r.kind_id)) continue;
        const c = byKey.get(r.kind_id + '|' + r.subject) || {};
        const entries = num(c.entries);
        const totalCost = num(c.total_cost);
        const row = {
            kind_id: r.kind_id, model: r.subject, elo: num(r.elo, 1000),
            elo_ci_lower: r.ci_lower == null ? null : num(r.ci_lower),
            elo_ci_upper: r.ci_upper == null ? null : num(r.ci_upper),
            games: num(r.games), wins: num(r.wins), losses: num(r.losses), ties: num(r.ties),
            win_rate: num(r.win_rate), provisional: num(r.games) < 10, entries,
            total_cost_usd: Math.round(totalCost * 1e6) / 1e6,
            cost_per_entry_usd: entries ? Math.round((totalCost / entries) * 1e6) / 1e6 : null,
            median_cost_usd: c.median_cost == null ? null : num(c.median_cost),
            median_ms: c.median_ms == null ? null : num(c.median_ms),
            p95_ms: c.p95_ms == null ? null : num(c.p95_ms),
            tokens_per_entry: entries ? Math.round(num(c.tokens) / entries) : 0,
            error_rate: entries ? num(c.errors) / entries : 0,
        };
        if (!kinds.has(r.kind_id)) kinds.set(r.kind_id, []);
        kinds.get(r.kind_id).push(row);
    }
    return { kinds: [...kinds.entries()].map(([id, rows]) => ({ kind_id: id, rows })), generated_at: new Date().toISOString() };
}

function pane(slot, revealed) {
    const frame = '<iframe class="sc-pane-frame" src="' + esc(slot.wrapper_url) + '" title="Output ' + esc(slot.slot) + '"'
        + ' sandbox="' + esc(renderLib.WRAPPER_SANDBOX) + '" referrerpolicy="no-referrer" loading="lazy" data-entry-id="' + esc(slot.entry_id) + '"></iframe>';
    const facts = revealed
        ? '<dl class="sc-pane-facts" data-facts="' + esc(slot.slot) + '">'
        + '<div><dt>Model</dt><dd>' + esc(slot.model) + '</dd></div>'
        + '<div><dt>Provider</dt><dd>' + esc(slot.provider) + '</dd></div>'
        + '<div><dt>Cost</dt><dd>$' + esc(slot.cost_usd) + '</dd></div>'
        + '<div><dt>Time</dt><dd>' + esc(slot.ms) + ' ms</dd></div>'
        + '<div><dt>Tokens</dt><dd>' + esc(slot.tokens) + '</dd></div>'
        + '</dl>'
        : '';
    return '<figure class="sc-pane" data-slot="' + esc(slot.slot) + '" data-entry-id="' + esc(slot.entry_id) + '" data-limit-ms="' + esc(slot.limit_ms) + '">'
        + '<figcaption><span class="sc-pane-label">Pane ' + esc(slot.slot) + '</span>'
        + '<span class="sc-pane-clock" data-clock="' + esc(slot.slot) + '">' + esc(Math.round(slot.limit_ms / 1000)) + 's</span></figcaption>'
        + frame + facts + '</figure>';
}

function voteForm(round, signedIn) {
    if (round.revealed) {
        return '<section class="sc-vote sc-vote-done" data-vote-state="revealed">'
            + '<p>Thanks: the identities are open now.</p>'
            + '<p><a href="/showcase/round/' + esc(round.id) + '?share=1">Share this pair</a></p></section>';
    }
    if (!signedIn) {
        return '<section class="sc-vote" data-vote-state="signed-out">'
            + '<p><a href="/auth/login?next=' + encodeURIComponent('/showcase/round/' + round.id) + '">Sign in to vote</a></p></section>';
    }
    const game = round.is_game
        ? '<fieldset class="sc-vote-more"><legend>More fun</legend>'
        + '<label><input type="radio" name="more_fun" value="A"> Pane A</label>'
        + '<label><input type="radio" name="more_fun" value="B"> Pane B</label>'
        + '<label><input type="radio" name="more_fun" value="tie"> Same</label></fieldset>'
        + '<label class="sc-vote-check"><input type="checkbox" name="crashed" value="1"> One of them crashed</label>'
        : '';
    return '<form class="sc-vote" method="post" action="/showcase/round/' + esc(round.id) + '" data-vote-form="1">'
        + '<fieldset><legend>Which one wins?</legend>'
        + '<label><input type="radio" name="outcome" value="A" required> Pane A</label>'
        + '<label><input type="radio" name="outcome" value="B"> Pane B</label>'
        + '<label><input type="radio" name="outcome" value="tie"> Same</label>'
        + '<label><input type="radio" name="outcome" value="both_bad"> Both bad</label>'
        + '</fieldset>' + game
        + '<button type="submit">Cast the vote</button></form>';
}

function galleryView(pairs) {
    const cards = pairs.map((p) => '<article class="sc-pair" data-round-id="' + esc(p.id) + '" data-kind="' + esc(p.kind_id) + '" data-votes="' + esc(p.votes) + '">'
        + '<h2 class="sc-pair-prompt" data-prompt="1">' + esc(p.prompt) + '</h2>'
        + '<div class="sc-pair-slots">' + p.slots.map((s) => pane(s, false)).join('') + '</div>'
        + '<p class="sc-pair-meta"><span class="sc-kind">' + esc(p.kind_name) + '</span>'
        + '<span class="sc-votes" data-votes="' + esc(p.votes) + '">' + esc(p.votes) + ' votes</span>'
        + '<a class="sc-pair-link" href="/showcase/round/' + esc(p.id) + '">Compare side by side</a></p></article>');
    return '<section class="sc-showcase" data-showcase="pairs">'
        + '<h1>Showcase: two models, the same prompt, side by side</h1>'
        + '<p class="sc-lede">Every pair is one prompt, run on two models. The frames are live and sandboxed: no network, no cookies, and a clock.</p>'
        + (cards.length
            ? '<div class="sc-pairs">' + cards.join('') + '</div>'
            : '<p class="sc-empty">No pairs yet. The first rounds are still generating.</p>')
        + '</section>';
}

function roundView(round, signedIn) {
    const panes = round.slots.map((s) => pane(s, round.revealed)).join('');
    return '<section class="sc-showcase sc-round" data-showcase="round" data-round-id="' + esc(round.id) + '" data-kind="' + esc(round.kind_id) + '">'
        + '<h1 class="sc-round-prompt" data-prompt="1">' + esc(round.prompt) + '</h1>'
        + '<p class="sc-round-meta"><span class="sc-kind">' + esc(round.kind_name) + '</span>'
        + '<span class="sc-votes" data-votes="' + esc(round.votes) + '">' + esc(round.votes) + ' votes</span></p>'
        + '<div class="sc-round-panes" data-panes="2">' + panes + '</div>'
        + voteForm(round, signedIn)
        + '</section>';
}

function createShowcaseRoutes(ctx) {
    const r = asyncRouter();
    const { config, bench, principal } = ctx;
    r.use(express.json({ limit: '64kb' }));
    r.use(principal.middleware);
    const problem = (res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: res.req && res.req.ov });
    const subjectOf = (req) => (req.principal && req.principal.kind === 'user' ? req.principal.subject : null);

    r.get('/pairs', async (req, res) => {
        try {
            const pairs = await loadPairs(ctx, { kind: req.query.kind, limit: req.query.limit });
            res.set('Cache-Control', 'public, max-age=30');
            return res.json({ count: pairs.length, pairs });
        } catch (err) {
            ctx.log.warn('[OpenVibe.Bench] showcase pairs failed:', (err && err.message) || err);
            return problem(res, 500, 'internal.error', 'Bench could not answer. Try again in a moment.');
        }
    });

    r.get('/rounds/:id', async (req, res) => {
        try {
            const round = await loadRound(ctx, String(req.params.id || ''), subjectOf(req));
            if (!round) return problem(res, 404, 'bench.round_not_found', 'No such round.');
            res.set('Cache-Control', round.revealed ? 'public, max-age=30' : 'private, no-store');
            return res.json({ round });
        } catch (err) {
            ctx.log.warn('[OpenVibe.Bench] showcase round failed:', (err && err.message) || err);
            return problem(res, 500, 'internal.error', 'Bench could not answer. Try again in a moment.');
        }
    });

    r.post('/rounds/:id/vote', async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const subject = subjectOf(req);
        if (!subject) return problem(res, 401, 'bench.sign_in_required', 'Sign in at bench.openvibe.services to vote.');
        if (req.principal.viaSession && !sameOrigin(req, config)) {
            return problem(res, 403, 'bench.cross_site', 'A signed-in request that changes something must come from bench.openvibe.services itself.');
        }
        const map = { A: 'left', B: 'right', tie: 'tie', both_bad: 'both_bad' };
        const outcome = map[String(b.outcome || '')];
        if (!outcome) return problem(res, 422, 'bench.invalid_outcome', 'The outcome must be A, B, tie or both_bad.');
        const round = await loadRound(ctx, String(req.params.id || ''), null);
        if (!round || !round.ready) return problem(res, 404, 'bench.round_not_found', 'No such round.');
        try {
            const out = await bench.castJudgement({
                roundId: round.id,
                judge: 'human_pairwise',
                pair: { left: round.slots[0].entry_id, right: round.slots[1].entry_id },
                outcome,
                subject,
            });
            if (round.is_game && (b.more_fun || b.crashed)) {
                const moreFun = b.more_fun === 'A' ? 1 : b.more_fun === 'B' ? -1 : 0;
                await bench.castJudgement({
                    roundId: round.id,
                    judge: 'rubric',
                    judgeName: b.crashed ? 'crashed' : 'more_fun',
                    score: b.crashed ? 1 : moreFun,
                    subject,
                });
            }
            res.set('Cache-Control', 'private, no-store');
            return res.status(201).json({ judged: true, revealed: true, judgement: out.judgement });
        } catch (err) {
            if (err && err.status) return problem(res, err.status, err.code || 'bench.invalid', err.detail || 'The vote was not accepted.');
            ctx.log.warn('[OpenVibe.Bench] showcase vote failed:', (err && err.message) || err);
            return problem(res, 500, 'internal.error', 'Bench could not answer. Try again in a moment.');
        }
    });

    r.get('/stats', async (req, res) => {
        try {
            const stats = await loadStats(ctx);
            res.set('Cache-Control', 'public, max-age=60');
            return res.json(stats);
        } catch (err) {
            ctx.log.warn('[OpenVibe.Bench] showcase stats failed:', (err && err.message) || err);
            return problem(res, 500, 'internal.error', 'Bench could not answer. Try again in a moment.');
        }
    });

    return r;
}

function createShowcasePages(ctx) {
    const r = express.Router();
    const { config, principal } = ctx;
    r.use(principal.middleware);
    const viewerOf = (req) => (req.principal && req.principal.kind === 'user'
        ? { kind: 'user', subject: req.principal.subject, displayName: req.principal.displayName || req.principal.username }
        : { kind: 'anonymous' });

    r.get('/', async (req, res) => {
        const pairs = await loadPairs(ctx, { kind: req.query.kind, limit: req.query.limit });
        return send(res, 200, {
            config,
            viewer: viewerOf(req),
            title: 'Showcase: two models side by side',
            description: 'One prompt, two models, live sandboxed frames: the OpenVibe.Bench showcase.',
            body: raw(galleryView(pairs)),
        });
    });

    r.get('/round/:id', async (req, res) => {
        const subject = req.principal && req.principal.kind === 'user' ? req.principal.subject : null;
        const round = await loadRound(ctx, String(req.params.id || ''), subject);
        if (!round) {
            return send(res, 404, { config, viewer: viewerOf(req), title: 'No such round', body: raw('<section><h1>No such round</h1></section>') });
        }
        return send(res, 200, {
            config,
            viewer: viewerOf(req),
            title: 'Compare two outputs',
            description: 'Two models, one prompt, side by side.',
            body: raw(roundView(round, Boolean(subject))),
        });
    });

    r.post('/round/:id', async (req, res) => {
        const subject = req.principal && req.principal.kind === 'user' ? req.principal.subject : null;
        const round = await loadRound(ctx, String(req.params.id || ''), null);
        if (!round) return res.redirect('/showcase');
        if (!subject) return res.redirect('/auth/login?next=' + encodeURIComponent('/showcase/round/' + round.id));
        const map = { A: 'left', B: 'right', tie: 'tie', both_bad: 'both_bad' };
        const outcome = map[String((req.body && req.body.outcome) || '')];
        if (!outcome) return res.redirect('/showcase/round/' + round.id);
        try {
            await ctx.bench.castJudgement({
                roundId: round.id,
                judge: 'human_pairwise',
                pair: { left: round.slots[0].entry_id, right: round.slots[1].entry_id },
                outcome,
                subject,
            });
        } catch (err) {
            ctx.log.warn('[OpenVibe.Bench] showcase page vote failed:', (err && err.message) || err);
        }
        return res.redirect('/showcase/round/' + round.id);
    });

    return r;
}

module.exports = { createShowcaseRoutes, createShowcasePages, loadPairs, loadRound, loadStats, SHOWCASE_KIND_IDS };

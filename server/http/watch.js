'use strict';

/**
 * The watch routes (spec 6): follow and unfollow, and the Watching page.
 * Only a signed-in person may follow: the rows belong to them and are deleted with them.
 */

const express = require('express');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./same-origin');
const { send } = require('../render/layout');
const { raw } = require('../render/html');
const { watchingPage } = require('../views/watch');

const subjectOf = (req) => (req.principal && req.principal.kind === 'user' ? req.principal : null);
/** The claims of a token, read without verifying it: the id is only used to address the notice. */
function decodeClaims(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

/** The Network user id of the person, when their token carries it: the notice needs it. */
const networkUserId = (req) => {
    const principal = req.principal || {};
    const claims = principal.claims || decodeClaims(principal.token);
    const id = claims && (claims.id != null ? claims.id : claims.sub);
    const n = Number(id);
    return Number.isFinite(n) && n > 0 ? n : null;
};

function createWatchPages(ctx) {
    const r = express.Router();
    r.use(express.urlencoded({ extended: false, limit: '16kb' }));
    r.use(express.json({ limit: '64kb' }));
    r.use(ctx.principal.middleware);

    r.get('/watching', async (req, res) => {
        const principal = subjectOf(req);
        const watches = principal ? await ctx.watches.listFor(principal.subject) : [];
        const body = watchingPage(watches, { viewer: principal });
        return send(res, 200, {
            config: ctx.config,
            viewer: principal ? { kind: 'user', subject: principal.subject, displayName: principal.displayName || principal.username } : { kind: 'anonymous' },
            path: req.originalUrl,
            title: 'Watching: the benchmarks and models you follow',
            description: 'The benchmarks and models you follow, and what Bench tells you when they move.',
            body: raw(body),
        });
    });

    r.post('/watch/follow', async (req, res) => {
        if (!sameOrigin(req, ctx.config)) return res.status(403).type('text/plain').send('That request did not come from this site.');
        const principal = subjectOf(req);
        if (!principal) return res.status(401).type('text/plain').send('Sign in to follow a benchmark.');
        const body = req.body || {};
        const benchmarkId = String(body.benchmark_id || '').trim();
        const model = body.model ? String(body.model).trim() : null;
        const out = await ctx.watches.follow({
            subject: principal.subject,
            benchmarkId,
            model: model || null,
            userId: networkUserId(req),
        });
        if (!out.ok) return res.status(out.status || 400).type('text/plain').send(out.error || 'Could not follow that.');
        return res.redirect(303, String(body.back || '/watching'));
    });

    r.post('/watch/unfollow', async (req, res) => {
        if (!sameOrigin(req, ctx.config)) return res.status(403).type('text/plain').send('That request did not come from this site.');
        const principal = subjectOf(req);
        if (!principal) return res.status(401).type('text/plain').send('Sign in to stop watching.');
        const body = req.body || {};
        await ctx.watches.unfollow({ subject: principal.subject, id: String(body.id || '') });
        return res.redirect(303, String(body.back || '/watching'));
    });

    return r;
}

module.exports = { createWatchPages, networkUserId };

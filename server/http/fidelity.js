'use strict';

/**
 * Provider-fidelity routes (stage B5).
 *
 *   GET  /api/v1/fidelity                 the latest measurement of every offer (public)
 *   GET  /api/v1/fidelity/objective-set   the fixed objective set (public)
 *   POST /api/v1/fidelity/plan            the dry run: every call and its estimated cost (operator)
 *   POST /api/v1/fidelity/run             one bounded pass (operator; off unless the owner turned it on)
 *   GET  /api/v1/fidelity/status          the last pass, when it ran and what it said (operator)
 *
 * The read is public because it is the number OpenVibe.AI puts beside an offer and Report shows; it has
 * no person and no prompt answer. Planning and running spend the owner's money, so they carry the same
 * operator token as the other owner switches.
 */
const crypto = require('crypto');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { FidelityError } = require('../bench/fidelity');

function operatorToken(req) {
    const h = String(req.get('authorization') || '');
    return /^Bearer\s+\S/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : null;
}

function tokenMatches(given, expected) {
    if (!given || !expected) return false;
    const a = crypto.createHash('sha256').update(String(given), 'utf8').digest();
    const b = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createFidelityRoutes(ctx) {
    const r = asyncRouter();
    const fidelity = ctx.fidelity;
    const token = process.env.BENCH_ADMIN_TOKEN || '';

    const problem = (res, err) => {
        if (err instanceof FidelityError) return http.sendProblem(res, err.status, err.code, { detail: err.detail, ctx: res.req && res.req.ov });
        throw err;
    };
    const operator = (req, res) => {
        if (!token) { res.status(404).type('text').send('No such route.'); return false; }
        if (!tokenMatches(operatorToken(req), token)) { http.sendProblem(res, 403, 'fidelity.operator_required', { detail: 'The operator token is required.', ctx: req.ov }); return false; }
        return true;
    };

    r.get('/api/v1/fidelity', async (_req, res) => {
        const body = await fidelity.read();
        res.set('Cache-Control', 'public, max-age=60');
        return res.json(body);
    });

    r.get('/api/v1/fidelity/objective-set', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=3600');
        return res.json(fidelity.objectiveSet());
    });

    r.get('/api/v1/fidelity/status', async (req, res) => {
        if (!operator(req, res)) return;
        return res.json({ enabled: Boolean(ctx.config.bench.fidelity.enabled), objective_set: require('../bench/fidelity-set').OBJECTIVE_SET, state: await fidelity.lastState() });
    });

    r.post('/api/v1/fidelity/plan', async (req, res) => {
        if (!operator(req, res)) return;
        try { return res.json(await fidelity.plan()); } catch (err) { return problem(res, err); }
    });

    r.post('/api/v1/fidelity/run', async (req, res) => {
        if (!operator(req, res)) return;
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        try {
            if (body.dry_run === true) return res.json(await fidelity.plan());
            return res.status(201).json(await fidelity.run({ trigger: 'operator' }));
        } catch (err) { return problem(res, err); }
    });

    return r;
}

module.exports = { createFidelityRoutes, operatorToken, tokenMatches };

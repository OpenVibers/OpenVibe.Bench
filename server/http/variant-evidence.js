'use strict';

/**
 * P6: the model-variant evidence API (plan 2026-11-04, G-P6). Behind BENCH_VARIANT_EVIDENCE, off by default.
 *
 *   GET  /api/v1/variant-families                 every family, grouped by org/model
 *   GET  /api/v1/variant-families/:family         one family (URL-encoded org/model)
 *   GET  /api/v1/variant-evidence                 every exact id's evidence
 *   GET  /api/v1/variant-evidence/:exactId        one exact id (URL-encoded)
 *   POST /api/v1/variant-evidence                 record one observation
 *
 * The write is trusted provenance, not an open form. A round source needs a service token with bench.entry.create
 * and a finished round with a receipt; a run source needs a service token with bench.run.publish. A model's own
 * agent token is refused. The response carries only ids, counts and measurements: no prompt, output or payload.
 */

const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { isSelfRating, validateObservation, VariantEvidenceError, SELF_RATING } = require('../bench/variant-evidence');

function createVariantEvidenceApi(ctx) {
    const { principal, variantEvidence, config, log } = ctx;
    const r = asyncRouter();
    // D11 owner settings: the switch is read live. Off, these paths are the API's ordinary 404 and nothing is read.
    r.use((_req, _res, next) => (config.bench.variantEvidence ? next() : next('router')));

    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => (req.principal ? next() : principal.middleware(req, res, next)));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    const problem = (res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: res.req && res.req.ov });
    const invalid = (res, detail) => problem(res, 400, 'bench.invalid', detail);
    const failed = (res, err) => {
        if (err instanceof VariantEvidenceError) return problem(res, err.status, err.code, err.detail);
        log.warn('[OpenVibe.Bench] variant evidence failed:', (err && err.message) || err);
        return problem(res, 500, 'internal.error', 'Bench could not answer. Try again in a moment.');
    };

    const encoded = (id) => encodeURIComponent(String(id));

    r.get('/variant-families', async (_req, res) => {
        const families = await variantEvidence.families();
        res.set('Cache-Control', 'public, max-age=60');
        return res.json({ count: families.length, families });
    });

    r.get('/variant-families/:family', async (req, res) => {
        const family = await variantEvidence.family(String(req.params.family || ''));
        if (!family) return problem(res, 404, 'bench.variant_family_not_found', 'No such variant family.');
        res.set('Cache-Control', 'public, max-age=60');
        return res.json({ family });
    });

    r.get('/variant-evidence', async (req, res) => {
        const exactId = typeof req.query.exact_id === 'string' && req.query.exact_id ? req.query.exact_id : null;
        const family = typeof req.query.family === 'string' && req.query.family ? req.query.family : null;
        const variants = await variantEvidence.list({ family, exactId });
        res.set('Cache-Control', 'public, max-age=60');
        return res.json({ count: variants.length, variants });
    });

    r.get('/variant-evidence/:exactId', async (req, res) => {
        const evidence = await variantEvidence.get(String(req.params.exactId || ''));
        if (!evidence) return problem(res, 404, 'bench.variant_not_found', 'No evidence for that exact id.');
        res.set('Cache-Control', 'public, max-age=60');
        return res.json({ evidence });
    });

    r.post('/variant-evidence', async (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const checked = validateObservation(body, { now: ctx.s.iso() });
        if (!checked.ok) return invalid(res, checked.errors.join('; '));
        const value = checked.value;

        const p = req.principal || { kind: 'anonymous' };
        const cap = value.source_kind === 'run' ? 'bench.run.publish' : 'bench.entry.create';
        if (p.kind === 'anonymous') {
            return problem(res, 401, 'token.required', 'Send a service token with bench.entry.create (a pinned round) or bench.run.publish (a run).');
        }
        if (p.kind !== 'app') {
            return problem(res, 403, 'bench.capability_required', `This route needs the ${cap} capability on a service token.`);
        }
        if (!p.hasCapability(cap)) {
            return problem(res, 403, 'bench.capability_denied', `A service token needs ${cap} to write this evidence.`);
        }
        if (isSelfRating(p, value)) {
            return problem(res, 403, SELF_RATING, 'A model may not write evidence about itself: use a service that ran it.');
        }

        try {
            const evidence = await variantEvidence.record(value, { createdBy: p.requester });
            res.set('Location', `/api/v1/variant-evidence/${encoded(value.exact_id)}`);
            return res.status(201).json({ evidence });
        } catch (err) { return failed(res, err); }
    });

    return r;
}

module.exports = { createVariantEvidenceApi };

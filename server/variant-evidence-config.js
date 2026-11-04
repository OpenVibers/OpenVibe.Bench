'use strict';
/**
 * The `bench.variant_evidence` namespace (D11 owner settings): the switch the owner changes from
 * openvibe.network's AI tab. BENCH_VARIANT_EVIDENCE stays the pin: while it is set it wins, is read-only in the
 * summary and a write answers 409 config.pinned_in_env.
 *
 * /internal/config is openvibe-shared/config's adminRoutes, guarded by bench.config.manage (Network's service
 * token only). actor is the owner Network names in X-OV-Subject; X-OV-Fresh: 1 gates a secret or x-danger write
 * (this namespace has neither). Every activation writes one audit line with the actor and the keys, never a value.
 */
const express = require('express');
const shared = require('openvibe-shared/config');
const { capabilities, http, ids } = require('openvibe-contracts');

const SERVICE = 'bench';
const NAMESPACE = 'bench.variant_evidence';
const CAPABILITY = 'bench.config.manage';

const SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Model-variant evidence',
    description: 'The exact model ids, quants and revisions Bench has measured, and the evidence API a service publishes them through.',
    type: 'object',
    additionalProperties: false,
    required: ['enabled'],
    properties: {
        enabled: {
            type: 'boolean', title: 'Variant evidence', 'x-group': 'Bench', 'x-env': 'BENCH_VARIANT_EVIDENCE',
            description: 'Serve /api/v1/variant-families and /api/v1/variant-evidence and accept a verified round or run as provenance.',
        },
    },
};
const DEFAULTS = Object.freeze({ enabled: false });

function actor(req) {
    const named = String((req.headers && req.headers['x-ov-subject']) || '').trim();
    return ids.isSubjectId('user', named) ? { type: 'user', id: named } : null;
}

const requireFresh = (req) => String((req.headers && req.headers['x-ov-fresh']) || '') === '1';

/** principal.middleware resolves the token; this finish refuses anything that is not a service token with the capability. */
function capabilityGuard({ principal, config, log }) {
    const resolve = principal.middleware;
    return function guard(req, res, next) {
        resolve(req, res, (err) => {
            if (err) return next(err);
            const p = req.principal || {};
            if (p.kind !== 'app') return http.sendProblem(res, 403, 'capability.denied', { detail: `${CAPABILITY} is first-party; an app may not change Bench configuration`, ctx: req.ov });
            const decision = capabilities.check(p.claims, CAPABILITY);
            if (!decision.allowed) return http.sendProblem(res, 403, decision.code || 'capability.denied', { detail: decision.reason || `${CAPABILITY} not granted`, ctx: req.ov });
            req.configClaims = p.claims;
            return next();
        });
    };
}

async function create({ db, principal, config, env = process.env, log = console, onActivate = null }) {
    // BENCH_VARIANT_EVIDENCE has always accepted 1/true/yes/on; the shared store's boolean pin reads true/1.
    const storeEnv = { ...env };
    if (['1', 'true', 'yes', 'on'].includes(String(storeEnv.BENCH_VARIANT_EVIDENCE || '').trim().toLowerCase())) storeEnv.BENCH_VARIANT_EVIDENCE = '1';
    const store = await shared.createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA, defaults: DEFAULTS, env: storeEnv, log,
        onActivate: async (values) => { if (onActivate) await onActivate(values); },
        onChange: ({ namespace, keys, actor: who, revision }) => {
            log.info(`[config] ${SERVICE} ${namespace} revision ${revision} by ${who && who.id ? `${who.type}:${who.id}` : 'unknown'}: ${keys.join(', ')}`);
        },
    });
    if (env.OV_CONFIG_KEKS) {
        try { await store.reseal(); } catch (err) { log.warn(`[config] ${NAMESPACE}: reseal failed: ${(err && err.message) || err}`); }
    }
    const router = shared.adminRoutes([store], {
        basePath: '/internal/config', requireAdmin: capabilityGuard({ principal, config, log }), actor, requireFresh, log,
    });
    return {
        store, router,
        get: (key) => store.get(key),
        mount(app) { app.use('/internal/config', express.json({ limit: '128kb' })); router.mount(app); },
    };
}

module.exports = { create, SCHEMA, NAMESPACE, CAPABILITY };

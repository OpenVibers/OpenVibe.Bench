'use strict';

/**
 * The benchmark registry and the results API (spec 2026-10-30, stage B1).
 *
 *   POST   /api/v1/benchmarks              create a benchmark (a draft)
 *   PUT    /api/v1/benchmarks/:id          save a new draft
 *   POST   /api/v1/benchmarks/:id/versions freeze a version
 *   POST   /api/v1/benchmarks/:id/fork     fork a benchmark
 *   GET    /api/v1/benchmarks?kind=&tag=&q= the registry
 *   GET    /api/v1/benchmarks/:id[@version] one benchmark
 *   POST   /api/v1/runs                    publish a run
 *   GET    /api/v1/runs/:id                one run
 *   GET    /api/v1/compare?runs=a,b,c      runs side by side
 *   GET    /api/v1/rankings?benchmark=&metric=&harness=&since=
 *   GET    /api/v1/percentile?benchmark=&model=&score=
 *
 * A person's token may read the registry and publish a submitted run; a service token with bench.benchmark.write may
 * author benchmarks, and one with bench.run.publish publishes verified runs and sees the holdout tasks.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./same-origin');
const { validateBenchmark, validateRun } = require('../bench/validate');
const { createServiceTokenClient } = require('openvibe-sdk/auth');

function createRegistryApi(ctx) {
    const { config, principal, registry } = ctx;
    const fetchImpl = ctx.fetchImpl || globalThis.fetch;
    const codesTokens = config.oauth.clientSecret ? createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret, audience: 'openvibe.codes', scope: 'codes.task.start', fetch: fetchImpl,
    }) : null;
    const r = asyncRouter();

    r.use(express.json({ limit: '16mb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    const problem = (res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: res.req && res.req.ov });
    const invalid = (res, detail) => problem(res, 400, 'bench.invalid', detail);
    const failed = (res, err) => {
        if (err && err.status && err.code) return problem(res, err.status, err.code, err.detail);
        ctx.log.warn('[OpenVibe.Bench] registry API failed:', (err && err.message) || err);
        return problem(res, 500, 'internal.error', 'Bench could not answer. Try again in a moment.');
    };

    const subjectOf = (req) => (req.principal && req.principal.kind === 'user' ? req.principal.subject : null);

    /** A person (any signed-in user) or a service token with the named capability. */
    function actor(cap) {
        return (req, res, next) => {
            const p = req.principal;
            if (p.kind === 'app') {
                if (p.hasCapability(cap)) return next();
                return problem(res, 403, 'bench.capability_denied', `A service token needs ${cap}.`);
            }
            if (p.kind === 'user') {
                if (p.viaSession && req.method !== 'GET' && !sameOrigin(req, config)) {
                    return problem(res, 403, 'bench.cross_site', 'A signed-in request that changes something must come from bench.openvibe.services itself.');
                }
                return next();
            }
            return problem(res, 401, 'bench.sign_in_required', 'Sign in at bench.openvibe.services, or send a service token.');
        };
    }

    /** The caller may see the holdout tasks: the executor does (bench.run.publish), and the owner does. */
    const mayReveal = (req) => {
        const p = req.principal;
        if (p.kind === 'app' && p.hasCapability('bench.run.publish')) return true;
        return false;
    };

    // ── Benchmarks ───────────────────────────────────────────
    r.post('/benchmarks', actor('bench.benchmark.write'), async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const subject = subjectOf(req) || req.principal.requester;
        try {
            const out = await registry.createBenchmark({
                owner: subject,
                title: b.title,
                description: b.description,
                kind: b.kind,
                tags: b.tags,
                visibility: b.visibility,
                parent: b.parent || null,
                definition: b.definition || b,
                subject,
            });
            if (!out.ok) return problem(res, out.status || 400, out.code || 'bench.invalid', out.message || 'invalid benchmark');
            res.set('Location', `/api/v1/benchmarks/${out.benchmark.id}`);
            return res.status(201).json({ benchmark: out.benchmark });
        } catch (err) { return failed(res, err); }
    });

    r.put('/benchmarks/:id', actor('bench.benchmark.write'), async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const subject = subjectOf(req) || req.principal.requester;
        try {
            const out = await registry.saveDraft(String(req.params.id || ''), { definition: b.definition || b, subject });
            if (!out.ok) return problem(res, out.status || 400, out.code || 'bench.invalid', out.message || 'invalid benchmark');
            return res.json({ benchmark: out.benchmark || null, version: out.version || null, draft: out.draft || null });
        } catch (err) { return failed(res, err); }
    });

    r.post('/benchmarks/:id/versions', actor('bench.benchmark.write'), async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const subject = subjectOf(req) || req.principal.requester;
        try {
            const body = (b.definition && typeof b.definition === 'object') ? b.definition : (Array.isArray(b.tasks) ? b : null);
            const out = await registry.freezeVersion(String(req.params.id || ''), { definition: body, subject, validate: validateBenchmark });
            if (!out.ok) return problem(res, out.status || 400, out.code || 'bench.invalid', out.message || 'invalid benchmark');
            res.set('Location', `/api/v1/benchmarks/${out.benchmark.id}@${out.version.version}`);
            return res.status(201).json({ benchmark: out.benchmark, version: out.version });
        } catch (err) { return failed(res, err); }
    });

    r.post('/benchmarks/:id/fork', actor('bench.benchmark.write'), async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const subject = subjectOf(req) || req.principal.requester;
        try {
            const out = await registry.forkBenchmark(String(req.params.id || ''), {
                version: b.version == null ? null : Number(b.version),
                title: b.title || null,
                owner: subject,
                subject,
            });
            if (!out.ok) return problem(res, out.status || 400, out.code || 'bench.invalid', out.message || 'invalid benchmark');
            res.set('Location', `/api/v1/benchmarks/${out.benchmark.id}`);
            return res.status(201).json({ benchmark: out.benchmark, version: out.version, parent: out.parent });
        } catch (err) { return failed(res, err); }
    });

    r.get('/benchmarks', async (req, res) => {
        try {
            const list = await registry.listBenchmarks({
                kind: req.query.kind ? String(req.query.kind) : null,
                tag: req.query.tag ? String(req.query.tag) : null,
                q: req.query.q ? String(req.query.q) : null,
                limit: req.query.limit ? Number(req.query.limit) : 50,
            });
            res.set('Cache-Control', 'public, max-age=60');
            return res.json({ count: list.length, benchmarks: list });
        } catch (err) { return failed(res, err); }
    });

    r.get('/benchmarks/:id', async (req, res) => {
        try {
            const ref = String(req.params.id || '');
            // The holdout goes to the executor and to the benchmark's owner; to nobody else.
            let reveal = mayReveal(req);
            if (!reveal && req.principal.kind === 'user') {
                const owner = await registry.getBenchmark(ref.split('@')[0]);
                reveal = !!(owner && owner.owner === req.principal.subject);
            }
            const out = await registry.getDefinition(ref, { reveal });
            if (!out) return problem(res, 404, 'bench.benchmark_not_found', 'No such benchmark.');
            res.set('Cache-Control', 'public, max-age=60');
            return res.json({
                benchmark: out.benchmark,
                version: { ...out.version, definition: out.definition },
                definition: out.definition,
            });
        } catch (err) { return failed(res, err); }
    });

    // Hand execution to Codes, which owns the person's keys and the benchmark task lifecycle.
    r.post('/benchmarks/:id/run', actor('bench.run.publish'), async (req, res) => {
        const p = req.principal;
        if (p.kind !== 'user') return problem(res, 403, 'bench.person_required', 'Sign in as the person who will run this benchmark.');
        if (!config.codesRunUrl) return problem(res, 503, 'bench.runner_unavailable', 'Codes benchmark runs are not configured.');
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const models = Array.isArray(b.models) ? b.models : [];
        const harnesses = Array.isArray(b.harnesses) ? b.harnesses : [];
        const repeat = Number(b.repeat);
        if (!models.length || !harnesses.length || models.length > 20 || harnesses.length > 20 || !Number.isInteger(repeat) || repeat < 1 || repeat > 20) {
            return invalid(res, 'models and harnesses must be non-empty arrays (at most 20 each), and repeat must be 1–20');
        }
        const definition = await registry.getDefinition(String(req.params.id), { reveal: false });
        if (!definition) return problem(res, 404, 'bench.benchmark_not_found', 'No such benchmark.');
        const costEstimate = (definition.definition.tasks || []).length * models.length * harnesses.length * repeat
            * Number(definition.definition.limits && definition.definition.limits.usd || 0);
        if (costEstimate > 1 && b.confirm !== true) return res.status(409).json({ code: 'bench.confirm_cost', cost_estimate_usd: costEstimate, confirm_required: true });
        try {
            if (!codesTokens) return problem(res, 503, 'bench.runner_unavailable', 'Bench has no Network client credentials for Codes.');
            const codesRunApi = new URL(`/api/v1/benchmarks/${encodeURIComponent(String(req.params.id))}/run`, config.codesRunUrl).toString();
            const response = await fetchImpl(codesRunApi, {
                method: 'POST', headers: { ...(await codesTokens.authHeaders()), 'content-type': 'application/json', 'x-ov-subject': p.subject, 'x-ov-user-token': p.token },
                body: JSON.stringify({ benchmark: String(req.params.id), models, harnesses, repeat }),
                signal: AbortSignal.timeout(15000),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) return problem(res, response.status < 500 ? response.status : 502, body.code || 'bench.runner_failed', body.detail || body.message || 'Codes could not start this benchmark.');
            return res.status(202).json(body);
        } catch (err) { return failed(res, err); }
    });

    // ── Runs ─────────────────────────────────────────────────
    r.post('/runs', actor('bench.run.publish'), async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const p = req.principal;
        const subject = subjectOf(req) || p.requester;
        // A verified run comes from a service token with bench.run.publish; a person's token makes it a submitted run.
        const provenance = p.kind === 'app' && p.hasCapability('bench.run.publish') ? 'verified' : 'submitted';
        const doc = {
            id: String(b.id || ''),
            benchmark: String(b.benchmark || ''),
            benchmark_id: b.benchmark_id || null,
            benchmark_version: b.benchmark_version == null ? null : Number(b.benchmark_version),
            model: b.model,
            route: b.route || {},
            provider: b.provider,
            harness: b.harness || {},
            settings: b.settings || {},
            executor: b.executor || (provenance === 'submitted' ? { kind: 'submitted', id: subject } : { kind: 'codes', id: subject }),
            hardware: b.hardware == null ? null : b.hardware,
            tasks: Array.isArray(b.tasks) ? b.tasks : [],
            score: b.score,
            cost_usd: b.cost_usd == null ? 0 : Number(b.cost_usd),
            ms: b.ms == null ? 0 : Number(b.ms),
            tokens: b.tokens == null ? 0 : Number(b.tokens),
            provenance,
            session: b.session == null ? null : b.session,
        };
        const check = validateRun({ ...doc, id: doc.id || 'brn_00000000000000000000000000' });
        if (!check.valid) return invalid(res, check.errors.map((e) => `${e.path} ${e.message}`).join('; '));
        try {
            const out = await registry.publishRun(doc, { provenance, subject });
            if (!out.ok) return problem(res, out.status || 400, out.code || 'bench.invalid', out.message || 'invalid run');
            res.set('Location', `/api/v1/runs/${out.run.id}`);
            return res.status(201).json({ run: out.run });
        } catch (err) { return failed(res, err); }
    });

    r.get('/runs/:id', async (req, res) => {
        try {
            const run = await registry.getRun(String(req.params.id || ''));
            if (!run) return problem(res, 404, 'bench.run_not_found', 'No such run.');
            res.set('Cache-Control', 'public, max-age=60');
            return res.json({ run });
        } catch (err) { return failed(res, err); }
    });

    r.get('/compare', async (req, res) => {
        const raw = String(req.query.runs || '');
        const refs = raw.split(',').map((x) => x.trim()).filter(Boolean);
        if (!refs.length) return invalid(res, 'runs is required: ?runs=a,b,c');
        if (refs.length > 4) return invalid(res, 'at most four runs can be compared at once');
        try {
            const out = await registry.compareRuns(refs);
            if (!out) return problem(res, 404, 'bench.run_not_found', 'No such run.');
            res.set('Cache-Control', 'public, max-age=60');
            return res.json({ compare: out });
        } catch (err) { return failed(res, err); }
    });

    r.get('/rankings', async (req, res) => {
        const benchmark = req.query.benchmark ? String(req.query.benchmark) : '';
        if (!benchmark) return invalid(res, 'benchmark is required: ?benchmark=bmk_…');
        const metric = req.query.metric ? String(req.query.metric) : 'score';
        if (!['score', 'value', 'speed', 'consistency'].includes(metric)) {
            return invalid(res, 'metric is score, value, speed or consistency');
        }
        try {
            const out = await registry.rankings({
                benchmark,
                metric,
                harness: req.query.harness ? String(req.query.harness) : null,
                since: req.query.since ? String(req.query.since) : null,
                includeSubmitted: String(req.query.include_submitted || '') === 'true',
            });
            if (!out) return problem(res, 404, 'bench.benchmark_not_found', 'No such benchmark.');
            res.set('Cache-Control', 'public, max-age=60');
            return res.json({ rankings: out });
        } catch (err) { return failed(res, err); }
    });

    r.get('/percentile', async (req, res) => {
        const benchmark = req.query.benchmark ? String(req.query.benchmark) : '';
        const model = req.query.model ? String(req.query.model) : '';
        if (!benchmark) return invalid(res, 'benchmark is required: ?benchmark=bmk_…');
        if (!model) return invalid(res, 'model is required: ?model=…');
        if (req.query.score == null) return invalid(res, 'score is required: ?score=…');
        try {
            const out = await registry.percentile({ benchmark, model, score: Number(req.query.score) });
            if (!out) return problem(res, 404, 'bench.benchmark_not_found', 'No such benchmark.');
            res.set('Cache-Control', 'public, max-age=60');
            return res.json({ percentile: out });
        } catch (err) { return failed(res, err); }
    });

    return r;
}

module.exports = { createRegistryApi };

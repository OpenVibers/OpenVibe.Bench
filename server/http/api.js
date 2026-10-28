'use strict';

/**
 * /api/v1 — OpenVibe.Bench's JSON API.
 *
 *   GET    /kinds
 *   GET    /kinds/:kindId
 *   POST   /kinds/:kindId/tasks
 *   GET    /tasks/:id
 *   POST   /tasks/:id/rounds
 *   GET    /rounds/:id
 *   POST   /rounds/:id/entries        (a room submits outside entries with a service token)
 *   GET    /judgements/next
 *   POST   /rounds/:id/judgements
 *   GET    /boards/:kindId?type=elo|pareto|cost
 *   GET    /models/:model
 *   GET    /datasets/:kindId.jsonl
 *   POST   /evals
 *   GET    /evals/:id
 *   POST   /evals/:id/run
 *   GET    /evals/:id/results
 *
 * A person is the bench_at session cookie or a Network user token as a Bearer; a service sends a client-credentials
 * token with bench.* capabilities. A session write must come from bench.openvibe.services itself.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./same-origin');
const { kindById } = require('../kinds');
const { BenchError } = require('../store');

function createApi(ctx) {
    const { config, s, principal, bench } = ctx;
    const r = asyncRouter();

    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    const problem = (res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: res.req && res.req.ov });
    const invalid = (res, detail) => problem(res, 400, 'bench.invalid', detail);
    const failed = (res, err) => {
        if (err instanceof BenchError) return problem(res, err.status, err.code, err.detail);
        ctx.log.warn('[OpenVibe.Bench] API failed:', (err && err.message) || err);
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

    const requirePerson = principal.requirePerson;

    // ── Kinds ───────────────────────────────────────────────
    r.get('/kinds', async (req, res) => {
        const list = await bench.listKinds();
        res.set('Cache-Control', 'public, max-age=300');
        return res.json({ count: list.length, kinds: list });
    });

    r.get('/kinds/:kindId', async (req, res) => {
        const kind = await bench.getKind(String(req.params.kindId || ''));
        if (!kind) return problem(res, 404, 'bench.kind_not_found', 'No such kind.');
        res.set('Cache-Control', 'public, max-age=300');
        return res.json({ kind });
    });

    // ── Tasks ───────────────────────────────────────────────
    r.post('/kinds/:kindId/tasks', actor('bench.task.create'), async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const owner = subjectOf(req) || req.principal.requester;
        const out = await bench.createTask({
            kindId: String(req.params.kindId || ''),
            prompt: b.prompt,
            taskClass: b.task_class == null ? null : String(b.task_class),
            public: Boolean(b.public),
            subject: owner,
        });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'bench.invalid', out.message || 'invalid task');
        res.set('Location', `/api/v1/tasks/${out.task.id}`);
        return res.status(201).json({ task: out.task });
    });

    r.get('/tasks/:id', async (req, res) => {
        const task = await bench.getTask(String(req.params.id || ''));
        if (!task) return problem(res, 404, 'bench.task_not_found', 'No such task.');
        res.set('Cache-Control', 'public, max-age=60');
        return res.json({ task });
    });

    // ── Rounds ──────────────────────────────────────────────
    r.post('/tasks/:id/rounds', actor('bench.round.create'), async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const owner = subjectOf(req) || req.principal.requester;
        try {
            const out = await bench.createRound({
                taskId: String(req.params.id || ''),
                offers: b.offers,
                seed: b.seed,
                subject: owner,
            });
            if (!out.ok) return problem(res, out.status || 400, out.code || 'bench.invalid', out.message || 'invalid round');
            res.set('Location', `/api/v1/rounds/${out.round.id}`);
            return res.status(201).json({ round: out.round });
        } catch (err) { return failed(res, err); }
    });

    r.get('/rounds/:id', async (req, res) => {
        try {
            const round = await bench.getRound(String(req.params.id || ''), { viewerSubject: subjectOf(req) });
            if (!round) return problem(res, 404, 'bench.round_not_found', 'No such round.');
            res.set('Cache-Control', round.blind ? 'private, no-store' : 'public, max-age=60');
            return res.json({ round });
        } catch (err) { return failed(res, err); }
    });

    r.post('/rounds/:id/entries', principal.requireCapability('bench.entry.create'), async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        try {
            const entry = await bench.addEntry({
                roundId: String(req.params.id || ''),
                provider: b.provider,
                model: b.model,
                route: b.route,
                payload: b.payload,
                costUsd: b.cost_usd,
                ms: b.ms,
                tokens: b.tokens,
                error: b.error,
                uiCheck: b.ui_check,
                runId: b.run_id,
            });
            res.set('Location', `/api/v1/rounds/${String(req.params.id)}`);
            return res.status(201).json({ entry });
        } catch (err) { return failed(res, err); }
    });

    // ── Judgements ──────────────────────────────────────────
    r.get('/judgements/next', requirePerson, async (req, res) => {
        try {
            const pair = await bench.nextJudgement({ kind: String(req.query.kind || ''), subject: subjectOf(req), random: ctx.random || Math.random });
            res.set('Cache-Control', 'private, no-store');
            if (!pair) return res.json({ pair: null, detail: 'There is no round waiting for your judgement right now.' });
            return res.json(pair);
        } catch (err) { return failed(res, err); }
    });

    r.post('/rounds/:id/judgements', async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const roundId = String(req.params.id || '');
        let judge = typeof b.judge === 'string' && b.judge ? b.judge : null;
        if (!judge) {
            const round = await bench.getRound(roundId, { viewerSubject: null });
            if (!round) return problem(res, 404, 'bench.round_not_found', 'No such round.');
            judge = (kindById(round.kind_id) || {}).judge || null;
        }
        if (!judge) return invalid(res, 'judge is required');
        const isHuman = judge === 'human_pairwise' || judge === 'rubric';
        const guard = isHuman ? requirePerson : principal.requireCapability('bench.judgement.cast');
        return guard(req, res, async () => {
            try {
                const subject = isHuman ? subjectOf(req) : req.principal.requester;
                const out = await bench.castJudgement({
                    roundId, kindId: b.kind_id, judge,
                    judgeName: b.judge_name, judgeVersion: b.judge_version,
                    pair: b.pair, outcome: b.outcome, score: b.score, subject,
                });
                res.set('Cache-Control', 'private, no-store');
                return res.status(201).json(out);
            } catch (err) { return failed(res, err); }
        });
    });

    // ── Boards, models, datasets ────────────────────────────
    r.get('/boards/:kindId', async (req, res) => {
        try {
            const type = typeof req.query.type === 'string' && req.query.type ? req.query.type : 'elo';
            const board = await bench.board(String(req.params.kindId || ''), {
                type,
                category: typeof req.query.category === 'string' ? req.query.category : 'all',
                period: typeof req.query.period === 'string' ? req.query.period : 'all',
            });
            if (!board) return problem(res, 404, 'bench.kind_not_found', 'No such kind.');
            res.set('Cache-Control', 'public, max-age=30');
            return res.json({ board });
        } catch (err) { return failed(res, err); }
    });

    r.get('/models/:model', async (req, res) => {
        try {
            const out = await bench.modelSummary(String(req.params.model || ''));
            if (!out) return problem(res, 404, 'bench.model_not_found', 'No such model.');
            res.set('Cache-Control', 'public, max-age=60');
            return res.json(out);
        } catch (err) { return failed(res, err); }
    });

    r.get('/datasets/:kindId.jsonl', async (req, res) => {
        try {
            const text = await bench.datasetJsonl(String(req.params.kindId || ''));
            if (text == null) return problem(res, 404, 'bench.kind_not_found', 'No such kind.');
            res.set('Cache-Control', 'public, max-age=60');
            res.set('Content-Disposition', `attachment; filename="${String(req.params.kindId || 'bench')}-dataset.jsonl"`);
            return res.type('application/x-ndjson').send(text);
        } catch (err) { return failed(res, err); }
    });

    // ── Private evals ───────────────────────────────────────
    r.post('/evals', actor('bench.eval.manage'), async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const owner = subjectOf(req) || req.principal.requester;
        const out = await bench.createEval({ owner, kindId: b.kind_id, name: b.name, testSuite: b.test_suite });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'bench.invalid', out.message || 'invalid eval');
        res.set('Location', `/api/v1/evals/${out.eval.id}`);
        return res.status(201).json({ eval: out.eval });
    });

    r.get('/evals/:id', actor('bench.eval.manage'), async (req, res) => {
        const owner = subjectOf(req) || req.principal.requester;
        const ev = await bench.getEval(String(req.params.id || ''), { owner });
        if (!ev) return problem(res, 404, 'bench.eval_not_found', 'No such eval (or it is not yours).');
        res.set('Cache-Control', 'private, no-store');
        return res.json({ eval: ev });
    });

    r.post('/evals/:id/run', actor('bench.eval.manage'), async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const owner = subjectOf(req) || req.principal.requester;
        try {
            const run = await bench.runEval({ evalId: String(req.params.id || ''), offers: b.offers, owner });
            res.set('Cache-Control', 'private, no-store');
            return res.status(202).json({ run });
        } catch (err) { return failed(res, err); }
    });

    r.get('/evals/:id/results', actor('bench.eval.manage'), async (req, res) => {
        const owner = subjectOf(req) || req.principal.requester;
        const out = await bench.evalResults(String(req.params.id || ''), { owner });
        if (!out) return problem(res, 404, 'bench.eval_not_found', 'No such eval (or it is not yours).');
        res.set('Cache-Control', 'private, no-store');
        return res.json(out);
    });

    return r;
}

module.exports = { createApi };

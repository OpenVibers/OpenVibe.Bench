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
const { compareRuns: compareVersionRuns } = require('../bench/version-diff');
const { sameOrigin } = require('./same-origin');
const { validateBenchmark, validateRun } = require('../bench/validate');
const { canViewBenchmark } = require('../bench/registry');

function createRegistryApi(ctx) {
    const { config, principal, registry, sharing } = ctx;
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

    r.get('/share-defaults/benchmark', async (req, res) => {
        const subject = subjectOf(req);
        if (!subject) return problem(res, 401, 'bench.sign_in_required', 'Sign in to read your benchmark default.');
        return res.json({ kind: 'benchmark', audience: await sharing.defaultAudience(subject) });
    });
    r.put('/share-defaults/benchmark', express.json({ limit: '16kb' }), async (req, res) => {
        const subject = subjectOf(req);
        if (!subject) return problem(res, 401, 'bench.sign_in_required', 'Sign in to change your benchmark default.');
        if (req.principal.viaSession && !sameOrigin(req, config)) return problem(res, 403, 'bench.cross_site', 'This change must come from Bench itself.');
        const audience = String((req.body || {}).audience || '');
        if (!sharing.AUDIENCES.includes(audience)) return problem(res, 422, 'bench.invalid_audience', 'Choose a sharing audience.');
        await sharing.setDefaultAudience(subject, audience);
        const changed = req.body && req.body.apply === true ? await sharing.applyDefault(subject, audience) : 0;
        return res.json({ kind: 'benchmark', audience, changed });
    });

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

    /** The caller's view of a benchmark: its owner, or the executor that must read the tasks. */
    const viewerOf = (req) => ({
        subject: subjectOf(req),
        executor: req.principal.kind === 'app' && req.principal.hasCapability('bench.run.publish'),
    });
    // The registry's own check first (public, the owner, the executor, a shared unlisted token), then the
    // uniform share row for a benchmark that is shared with specific people (its column says private).
    const mayRead = async (req, benchmark) => {
        if (canViewBenchmark(benchmark, viewerOf(req))) return true;
        if (!ctx.sharing) return false;
        return await ctx.sharing.canView({ subject: subjectOf(req) }, benchmark.id).catch(() => false);
    };

    /** The owner, including a service token that created the benchmark, may see its held-out task text. */
    const owns = (req, benchmark) => {
        if (!benchmark) return false;
        const person = subjectOf(req);
        if (person != null && String(benchmark.owner) === String(person)) return true;
        return req.principal.kind === 'app' && String(benchmark.owner) === String(req.principal.requester);
    };
    const maySeeTaskText = async (req, id) => {
        const bm = await registry.getBenchmark(String(id || ''));
        return mayReveal(req) || owns(req, bm);
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
            const benchmark = await registry.getBenchmark(String(req.params.id || ''));
            let version = null;
            if (out.version) {
                const seen = await registry.getDefinition(`${out.version.benchmark_id}@${out.version.version}`, { reveal: await maySeeTaskText(req, req.params.id) });
                version = seen ? seen.version : null;
            }
            return res.json({ benchmark: benchmark || null, version, draft: benchmark ? benchmark.draft : null });
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
            const seen = await registry.getDefinition(`${out.benchmark.id}@${out.version.version}`, { reveal: await maySeeTaskText(req, out.benchmark.id) });
            return res.status(201).json({ benchmark: out.benchmark, version: seen ? seen.version : out.version, task_meta: seen ? seen.task_meta : [] });
        } catch (err) { return failed(res, err); }
    });

    r.post('/benchmarks/:id/fork', actor('bench.benchmark.write'), async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const subject = subjectOf(req) || req.principal.requester;
        try {
            const bm = await registry.getBenchmark(String(req.params.id || ''));
            if (!bm || !await mayRead(req, bm)) return problem(res, 404, 'bench.benchmark_not_found', 'No such benchmark.');
            const out = await registry.forkBenchmark(String(req.params.id || ''), {
                version: b.version == null ? null : Number(b.version),
                title: b.title || null,
                owner: subject,
                subject,
                reveal: mayReveal(req) || owns(req, bm),
            });
            if (!out.ok) return problem(res, out.status || 400, out.code || 'bench.invalid', out.message || 'invalid benchmark');
            res.set('Location', `/api/v1/benchmarks/${out.benchmark.id}`);
            return res.status(201).json({ benchmark: out.benchmark, version: out.version, parent: out.parent });
        } catch (err) { return failed(res, err); }
    });

    r.post('/benchmarks/:id/share', actor('bench.benchmark.write'), async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const subject = subjectOf(req) || req.principal.requester;
        try {
            const out = await registry.setVisibility(String(req.params.id || ''), { visibility: b.visibility, subject });
            if (!out.ok) return problem(res, out.status || 400, out.code || 'bench.invalid', out.message || 'invalid visibility');
            res.set('Cache-Control', 'no-store');
            return res.json({ benchmark: out.benchmark, token: out.token, share_path: out.share_path });
        } catch (err) { return failed(res, err); }
    });

    r.get('/benchmarks', async (req, res) => {
        try {
            // ?mine=1 adds the caller's own unlisted and private benchmarks; nobody else ever sees those in a list.
            const mine = req.query.mine && req.principal && req.principal.kind === 'user' ? req.principal.subject : null;
            const list = await registry.listBenchmarks({
                owner: mine,
                viewer: mine,
                kind: req.query.kind ? String(req.query.kind) : null,
                tag: req.query.tag ? String(req.query.tag) : null,
                q: req.query.q ? String(req.query.q) : null,
                limit: req.query.limit ? Number(req.query.limit) : 50,
            });
            const activity = await registry.runActivity();
            for (const b of list) {
                const a = activity.get(b.id);
                b.runs = a ? a.runs : 0;
                b.last_run = a ? a.last_run : null;
            }
            res.set('Cache-Control', mine ? 'private, no-store' : 'public, max-age=60');
            return res.json({ count: list.length, benchmarks: list });
        } catch (err) { return failed(res, err); }
    });

    r.get('/benchmarks/:id', async (req, res) => {
        try {
            const ref = String(req.params.id || '');
            const out = await registry.getDefinition(ref, { reveal: false });
            if (!out) return problem(res, 404, 'bench.benchmark_not_found', 'No such benchmark.');
            // A private benchmark answers only its owner and the executor; a shared unlisted one only its owner by
            // id (the token link is the way in). Everyone else gets a 404, not a "forbidden".
            if (!await mayRead(req, out.benchmark)) return problem(res, 404, 'bench.benchmark_not_found', 'No such benchmark.');
            const reveal = mayReveal(req) || owns(req, out.benchmark);
            let definition = out.version.definition;
            let taskMeta = out.task_meta;
            if (reveal) {
                const full = await registry.getDefinition(ref, { reveal: true });
                if (full) { definition = full.version.definition; taskMeta = full.task_meta; }
            }
            res.set('Cache-Control', out.benchmark.visibility === 'public' ? 'public, max-age=60' : 'private, no-store');
            return res.json({
                benchmark: out.benchmark,
                version: { ...out.version, definition },
                definition,
                task_meta: taskMeta,
            });
        } catch (err) { return failed(res, err); }
    });

    // Hand execution to Codes, which owns the person's keys and the benchmark task lifecycle.
    // Start the benchmark on openvibe.codes as the signed-in person: the launcher checks, estimates and asks for a
    // confirmation above $1 (server/bench/launch.js); the run form on the benchmark page uses the same one.
    r.post('/benchmarks/:id/run', actor('bench.run.publish'), async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const out = await ctx.launcher.launch({ principal: req.principal, id: req.params.id, models: b.models, harnesses: b.harnesses, repeat: b.repeat, confirm: b.confirm === true });
        if (out.status === 202 || out.status === 409) return res.status(out.status).json(out.body);
        return problem(res, out.status, out.body.code, out.body.detail);
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
            cost_usd: b.cost_usd == null ? null : Number(b.cost_usd),
            ms: b.ms == null ? null : Number(b.ms),
            tokens: b.tokens == null ? null : Number(b.tokens),
            provenance,
            session: b.session == null ? null : b.session,
        };
        const check = validateRun({ ...doc, id: doc.id || 'brn_00000000000000000000000000' });
        if (!check.valid) return invalid(res, check.errors.map((e) => `${e.path} ${e.message}`).join('; '));
        try {
            // A run may only be published on a benchmark its author may read: another person's private one is a 404.
            const bmId = String(doc.benchmark_id || doc.benchmark || '').split('@')[0];
            const bm = bmId ? await registry.getBenchmark(bmId) : null;
            if (bm && !await mayRead(req, bm)) return problem(res, 404, 'bench.benchmark_not_found', 'No such benchmark.');
            const out = await registry.publishRun(doc, { provenance, subject });
            if (!out.ok) return problem(res, out.status || 400, out.code || 'bench.invalid', out.message || 'invalid run');
            res.set('Location', `/api/v1/runs/${out.run.id}`);
            return res.status(201).json({ run: out.run });
        } catch (err) { return failed(res, err); }
    });

    // The public run list: newest first, on public benchmarks only. It is what Report's AI pages read for a
    // model's history, a benchmark's latest results and the new-results feed; a submitted run is labelled by
    // `provenance` and is not in the verified rankings.
    r.get('/runs', async (req, res) => {
        try {
            const benchmark = req.query.benchmark ? String(req.query.benchmark).slice(0, 120) : null;
            const model = req.query.model ? String(req.query.model).slice(0, 160) : null;
            const kind = req.query.kind ? String(req.query.kind).slice(0, 80) : null;
            if (kind && !require('../kinds').kindById(kind)) return problem(res, 404, 'bench.kind_not_found', 'No such kind.');
            if (benchmark) {
                const bm = await registry.getBenchmark(benchmark.split('@')[0]);
                if (!bm || !await mayRead(req, bm) || bm.visibility !== 'public') {
                    return problem(res, 404, 'bench.benchmark_not_found', 'No such public benchmark.');
                }
            }
            const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
            const offset = Math.max(0, Number(req.query.offset) || 0);
            const runs = await registry.listRuns({ benchmark, model, kind, publicOnly: true, limit, offset });
            res.set('Cache-Control', 'public, max-age=60');
            return res.json({ count: runs.length, offset, runs, last_run: runs.length ? runs[0].created_at : null });
        } catch (err) { return failed(res, err); }
    });

    // Public counts for the AI overview and method page. Nothing here is a person or an unlisted benchmark.
    r.get('/overview', async (req, res) => {
        try {
            res.set('Cache-Control', 'public, max-age=60');
            return res.json(await registry.overview());
        } catch (err) { return failed(res, err); }
    });

    // One model's public record: verified medians per benchmark, its task-level best and worst, every public run
    // newest first, and the cost and time those runs carried.
    r.get('/models/:model/summary', async (req, res) => {
        try {
            const model = String(req.params.model || '').slice(0, 160);
            if (!model) return invalid(res, 'model is required');
            const out = await registry.modelDetail(model);
            res.set('Cache-Control', 'public, max-age=60');
            return res.json(out);
        } catch (err) { return failed(res, err); }
    });

    r.get('/runs/:id', async (req, res) => {
        try {
            const run = await registry.getRun(String(req.params.id || ''));
            if (!run) return problem(res, 404, 'bench.run_not_found', 'No such run.');
            const bm = await registry.getBenchmark(run.benchmark_id);
            if (bm && !mayRead(req, bm)) return problem(res, 404, 'bench.run_not_found', 'No such run.');
            res.set('Cache-Control', bm && bm.visibility === 'public' ? 'public, max-age=60' : 'private, no-store');
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
            // One unreadable run hides itself; if none is readable the comparison does not exist.
            const allowed = [];
            let allPublic = true;
            for (const run of out.runs) {
                const bm = await registry.getBenchmark(run.benchmark_id);
                if (!bm || await mayRead(req, bm)) allowed.push(run);
                if (!bm || bm.visibility !== 'public') allPublic = false;
            }
            if (!allowed.length) return problem(res, 404, 'bench.run_not_found', 'No such run.');
            const taskIds = out.task_ids;
            allowed.forEach((run) => { for (const t of run.tasks) if (!taskIds.includes(t.task_id)) taskIds.push(t.task_id); });
            const compare = {
                runs: allowed,
                task_ids: taskIds,
                rows: taskIds.map((taskId) => ({
                    task_id: taskId,
                    scores: allowed.map((run) => {
                        const t = run.tasks.find((x) => x.task_id === taskId);
                        return t ? t.score : null;
                    }),
                })),
            };
            res.set('Cache-Control', allPublic ? 'public, max-age=60' : 'private, no-store');
            return res.json({ compare });
        } catch (err) { return failed(res, err); }
    });

    // A paired release diff: both runs must be public, verified, and on the identical frozen task set.
    r.get('/versions/diff', async (req, res) => {
        const baselineId = String(req.query.baseline || '');
        const candidateId = String(req.query.candidate || '');
        if (!baselineId || !candidateId || baselineId === candidateId) return invalid(res, 'baseline and candidate must name two distinct run ids');
        try {
            const [baseline, candidate] = await Promise.all([registry.getRun(baselineId), registry.getRun(candidateId)]);
            if (!baseline || !candidate) return problem(res, 404, 'bench.run_not_found', 'No such run.');
            const [baseBenchmark, candidateBenchmark] = await Promise.all([
                registry.getBenchmark(baseline.benchmark_id), registry.getBenchmark(candidate.benchmark_id),
            ]);
            if (!baseBenchmark || !candidateBenchmark || baseBenchmark.visibility !== 'public' || candidateBenchmark.visibility !== 'public'
                || baseline.provenance !== 'verified' || candidate.provenance !== 'verified') {
                return problem(res, 404, 'bench.run_not_found', 'No such public verified run.');
            }
            if (baseline.benchmark_id !== candidate.benchmark_id || baseline.benchmark_version !== candidate.benchmark_version) {
                return invalid(res, 'version diffs require the same public benchmark and frozen version');
            }
            const diff = compareVersionRuns(baseline, candidate);
            res.set('Cache-Control', 'public, max-age=60');
            return res.json({ diff });
        } catch (err) { return failed(res, err); }
    });

    // Hardware results are measured runs only. No speed or fit estimates are inferred from model names.
    r.get('/local/runs', async (req, res) => {
        const hardwareQuery = String(req.query.hardware || '').trim().slice(0, 120);
        if (!hardwareQuery) return invalid(res, 'hardware is required, for example ?hardware=RTX%204090');
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
        try {
            const runs = await registry.listRuns({ publicOnly: true, verifiedOnly: true, limit: 100 });
            const matching = runs.filter((run) => run.hardware && JSON.stringify(run.hardware).toLowerCase().includes(hardwareQuery.toLowerCase()));
            const bestByBenchmark = new Map();
            for (const run of runs) {
                if (run.score == null) continue;
                const key = `${run.benchmark_id}@${run.benchmark_version}`;
                bestByBenchmark.set(key, Math.max(bestByBenchmark.get(key) ?? -Infinity, Number(run.score)));
            }
            res.set('Cache-Control', 'public, max-age=60');
            return res.json({ schema: 'bench.local-runs@1', hardware_query: hardwareQuery, source: 'public verified Bench runs', count: Math.min(limit, matching.length), runs: matching.slice(0, limit).map((run) => {
                const frontier = bestByBenchmark.get(`${run.benchmark_id}@${run.benchmark_version}`);
                return {
                    id: run.id, benchmark: run.benchmark, model: run.model, hardware: run.hardware,
                    score: run.score, frontier_score: frontier == null ? null : frontier,
                    gap_to_frontier: run.score == null || frontier == null ? null : (frontier - run.score),
                    cost_usd: run.cost_usd, ms: run.ms, tokens: run.tokens,
                    aggregate_tokens_per_second: run.ms > 0 && run.tokens != null ? Number((run.tokens * 1000 / run.ms).toFixed(3)) : null,
                    created_at: run.created_at,
                };
            }) });
        } catch (err) { return failed(res, err); }
    });

    r.get('/rankings', async (req, res) => {
        const benchmark = req.query.benchmark ? String(req.query.benchmark) : '';
        if (!benchmark) return invalid(res, 'benchmark is required: ?benchmark=bmk_…');
        const metric = req.query.metric ? String(req.query.metric) : 'score';
        if (!['score', 'value', 'speed', 'consistency', 'horizon', 'tickets', 'pass_k', 'pass@k', 'pass^k'].includes(metric)) {
            return invalid(res, 'metric is score, value, speed, consistency, horizon or tickets');
        }
        try {
            const bm = await registry.getBenchmark(benchmark.split('@')[0]);
            if (!bm || !await mayRead(req, bm)) return problem(res, 404, 'bench.benchmark_not_found', 'No such benchmark.');
            const out = await registry.rankings({
                benchmark,
                metric,
                harness: req.query.harness ? String(req.query.harness) : null,
                since: req.query.since ? String(req.query.since) : null,
                includeSubmitted: String(req.query.include_submitted || '') === 'true',
                effort: req.query.effort ? String(req.query.effort).slice(0, 40) : null,
            });
            if (!out) return problem(res, 404, 'bench.benchmark_not_found', 'No such benchmark.');
            res.set('Cache-Control', bm.visibility === 'public' ? 'public, max-age=60' : 'private, no-store');
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
            const bm = await registry.getBenchmark(benchmark.split('@')[0]);
            if (!bm || !await mayRead(req, bm)) return problem(res, 404, 'bench.benchmark_not_found', 'No such benchmark.');
            const out = await registry.percentile({ benchmark, model, score: Number(req.query.score) });
            if (!out) return problem(res, 404, 'bench.benchmark_not_found', 'No such benchmark.');
            res.set('Cache-Control', bm.visibility === 'public' ? 'public, max-age=60' : 'private, no-store');
            return res.json({ percentile: out });
        } catch (err) { return failed(res, err); }
    });

    return r;
}

module.exports = { createRegistryApi };

'use strict';

/**
 * The move to OpenVibe.Report (owner, 2026-11-08): the public pages answer 301 to their Report counterparts while
 * the API keeps answering here, and the public reads Report needs (runs, overview, a model's summary) are exposed
 * with real run rows only.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const TASKS = [
    { id: 't1', prompt: 'Build a one-screen arcade game.', files: [], expected: null, holdout: false },
    { id: 't2', prompt: 'Build a snake game.', files: [], expected: null, holdout: false },
];

function definition(over = {}) {
    return {
        title: 'Playable games arena', description: 'A test set.', kind: 'games.play', tags: ['games'],
        visibility: 'public', tasks: TASKS, judges: [{ type: 'game_outcome', version: '1.0', config: {} }],
        scoring: { method: 'mean', scale: { min: 0, max: 100 } }, limits: { ms: 120000, tokens: 0, usd: 0.5 },
        matrix: { models: [], harnesses: [] }, ...over,
    };
}

function runDoc(benchmark, over = {}) {
    return {
        benchmark, model: 'model-a', provider: 'acme', route: { key: 'acme' }, harness: { name: 'codes', version: '1' },
        executor: { kind: 'codes', id: 'task_1' }, tasks: [
            { task_id: 't1', score: 80, cost_usd: 0.02, ms: 1000, tokens: 10, artifacts: [] },
            { task_id: 't2', score: 60, cost_usd: 0.03, ms: 3000, tokens: 20, artifacts: [] },
        ],
        score: 70, cost_usd: 0.05, ms: 4000, tokens: 30, ...over,
    };
}

(async () => {
    const t = await boot();
    const writer = t.network.serviceToken({ sub: 'svc:codes', audience: 'openvibe.bench', cap: ['bench.run.publish', 'bench.benchmark.write'] });
    let benchmarkId;
    let version;

    try {
        const created = await t.get('/api/v1/benchmarks', { bearer: writer, json: definition() });
        assert.strictEqual(created.status, 201, created.text);
        benchmarkId = created.json().benchmark.id;
        const frozen = await t.get(`/api/v1/benchmarks/${benchmarkId}/versions`, { bearer: writer, json: {} });
        assert.strictEqual(frozen.status, 201, frozen.text);
        version = frozen.json().version.version;
        for (const [model, score, cost] of [['model-a', 70, 0.05], ['model-b', 90, 0.10]]) {
            const made = await t.get('/api/v1/runs', { bearer: writer, json: runDoc(`${benchmarkId}@${version}`, { model, score, cost_usd: cost }) });
            assert.strictEqual(made.status, 201, made.text);
        }

        await check('public runs list newest first with the last run date', async () => {
            const r = await t.get(`/api/v1/runs?benchmark=${benchmarkId}&limit=2`);
            assert.strictEqual(r.status, 200, r.text);
            const body = r.json();
            assert.strictEqual(body.count, 2);
            assert.ok(body.last_run, 'a last run date');
            assert.deepStrictEqual(body.runs.map((x) => x.model), ['model-b', 'model-a']);
            assert.ok(body.runs.every((x) => x.provenance === 'verified'));
            const byKind = await t.get('/api/v1/runs?kind=games.play');
            assert.strictEqual(byKind.json().count, 2, 'the kind filter reads the benchmark kind');
            const byModel = await t.get('/api/v1/runs?model=model-a');
            assert.deepStrictEqual(byModel.json().runs.map((x) => x.model), ['model-a']);
        });

        await check('overview counts real public benchmarks and runs only', async () => {
            const r = await t.get('/api/v1/overview');
            assert.strictEqual(r.status, 200, r.text);
            const body = r.json();
            const mine = body.list.find((b) => b.id === benchmarkId);
            assert.ok(mine, 'the test benchmark is listed');
            assert.strictEqual(mine.runs, 2);
            assert.ok(body.runs >= 2 && body.models >= 2 && body.tasks >= 2, JSON.stringify(body));
            assert.ok(body.last_run, 'the newest run');
            assert.ok(Array.isArray(body.recent) && body.recent.length >= 2, 'recent runs');
            assert.deepStrictEqual(body.model_list.map((m) => m.model).sort(), ['model-a', 'model-b'], 'every public model with its last run');
            assert.ok(!JSON.stringify(body).includes('t2 build a snake'), 'no task prompt copied into the overview');
        });

        await check('one model summary carries its task best and worst, cost and runs', async () => {
            const r = await t.get('/api/v1/models/model-a/summary');
            assert.strictEqual(r.status, 200, r.text);
            const body = r.json();
            assert.strictEqual(body.model, 'model-a');
            assert.strictEqual(body.runs, 1);
            assert.strictEqual(body.benchmarks[0].score, 70);
            assert.strictEqual(body.total_cost_usd, 0.05);
            assert.strictEqual(body.best_task.task_id, 't1');
            assert.strictEqual(body.worst_task.task_id, 't2');
            assert.strictEqual(body.best_task.score, 80);
            assert.strictEqual(body.tasks.length, 2);
            assert.ok(body.last_run && body.recent_runs.length === 1);
        });

        await check('HTML pages answer 301 to their Report counterparts', async () => {
            const root = await t.get('/');
            assert.strictEqual(root.status, 301);
            assert.strictEqual(root.headers.get('location'), 'https://openvibe.compare/ai');
            const bench = await t.get(`/benchmarks/${benchmarkId}`);
            assert.strictEqual(bench.status, 301);
            assert.strictEqual(bench.headers.get('location'), `https://openvibe.compare/ai/${benchmarkId}`);
            const model = await t.get('/models/model-a');
            assert.strictEqual(model.status, 301);
            assert.strictEqual(model.headers.get('location'), 'https://openvibe.compare/ai/models/model-a');
            for (const [path, location] of [['/docs', 'https://openvibe.compare/ai/method'], ['/compare', 'https://openvibe.compare/ai/compare'], ['/showcase', 'https://openvibe.compare/ai'], ['/gallery', 'https://openvibe.compare/ai']]) {
                const r = await t.get(path);
                assert.strictEqual(r.status, 301, path);
                assert.strictEqual(r.headers.get('location'), location, path);
            }
            const tab = await t.get('/benchmarks?tab=pareto');
            assert.strictEqual(tab.headers.get('location'), 'https://openvibe.compare/ai?tab=pareto');
        });

        await check('the API, MCP and render origin stay on Bench (no redirect)', async () => {
            for (const path of ['/api/v1/kinds', '/api/v1/overview', `/api/v1/benchmarks/${benchmarkId}`, '/api/health']) {
                const r = await t.get(path);
                assert.strictEqual(r.status, 200, path);
                assert.ok(r.headers.get('location') == null, `${path} redirected`);
            }
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

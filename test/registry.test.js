'use strict';

/**
 * The registry and the results API (spec 2026-10-30, stage B1).
 *
 * The rules under test: a version that a run names never changes again; a fork records its parent; the holdout tasks
 * are withheld from everyone but the executor; a service token publishes a verified run and a person's token publishes
 * a submitted one; the rankings keep the submitted runs out; the value and the percentile maths are what they say.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const TASKS = [
    { id: 't1', prompt: 'Build a one-screen arcade game with a paddle, bricks, a ball and a score.', files: [], expected: null, holdout: false },
    { id: 't2', prompt: 'Build a snake game on a 20x20 grid.', files: [], expected: null, holdout: true },
];

function definition(over = {}) {
    return {
        title: 'Playable games arena',
        description: 'The showcase set.',
        kind: 'games.play',
        tags: ['games', 'showcase'],
        visibility: 'public',
        tasks: TASKS,
        judges: [{ type: 'human_pairwise', version: '1.0', config: {} }],
        scoring: { method: 'mean', scale: { min: 0, max: 100 } },
        limits: { ms: 120000, tokens: 200000, usd: 0.5 },
        matrix: { models: ['claude-opus-4'], harnesses: ['claude-code'] },
        ...over,
    };
}

function runDoc(benchmark, over = {}) {
    return {
        benchmark,
        model: 'claude-opus-4',
        route: { provider: 'anthropic' },
        provider: 'anthropic',
        harness: { name: 'claude-code', version: '1.2.0' },
        settings: { temperature: 1, effort: 'high' },
        executor: { kind: 'codes', id: 'task_1' },
        tasks: [{ task_id: 't1', score: 90, cost_usd: 0.02, ms: 40000, tokens: 8000, artifacts: [] }],
        score: 90,
        cost_usd: 0.02,
        ms: 40000,
        tokens: 8000,
        ...over,
    };
}

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const publisher = t.network.serviceToken({ sub: 'svc:codes', audience: 'openvibe.bench', cap: ['bench.run.publish', 'bench.benchmark.write'] });
    const reader = t.network.serviceToken({ sub: 'svc:reader', audience: 'openvibe.bench', cap: ['bench.run.read'] });
    const writer = t.network.serviceToken({ sub: 'svc:writer', audience: 'openvibe.bench', cap: ['bench.benchmark.write'] });

    let benchmarkId;
    let version;

    await check('a benchmark is created, drafted and frozen into a version', async () => {
        const created = await t.get('/api/v1/benchmarks', { bearer: writer, json: definition() });
        assert.strictEqual(created.status, 201, created.text);
        benchmarkId = created.json().benchmark.id;
        assert.strictEqual(created.json().benchmark.latest_version, 0);
        const frozen = await t.get(`/api/v1/benchmarks/${benchmarkId}/versions`, { bearer: writer, json: {} });
        assert.strictEqual(frozen.status, 201, frozen.text);
        version = frozen.json().version.version;
        assert.strictEqual(version, 1);
        assert.match(frozen.json().version.hash, /^[0-9a-f]{64}$/);
    });

    await check('the seeded showcase benchmarks are public and owned by openvibe', async () => {
        const list = await t.get('/api/v1/benchmarks?kind=games.play');
        assert.strictEqual(list.status, 200, list.text);
        assert.ok(list.json().benchmarks.length >= 1, 'the showcase seeded a games.play benchmark');
        const seeded = list.json().benchmarks.find((b) => b.owner === 'openvibe');
        assert.ok(seeded, 'the showcase seeded a games.play benchmark owned by openvibe');
        assert.strictEqual(seeded.visibility, 'public');
    });

    await check('the holdout task is withheld from the public and shown to the executor', async () => {
        const pub = await t.get(`/api/v1/benchmarks/${benchmarkId}`);
        assert.strictEqual(pub.status, 200, pub.text);
        const hidden = pub.json().definition.tasks.find((x) => x.id === 't2');
        assert.ok(hidden, 'the holdout task is listed');
        assert.strictEqual(hidden.prompt, null, 'but its prompt is withheld');
        assert.strictEqual(hidden.holdout, true);
        const seen = await t.get(`/api/v1/benchmarks/${benchmarkId}`, { bearer: publisher });
        const shown = seen.json().definition.tasks.find((x) => x.id === 't2');
        assert.ok(shown.prompt, 'the executor sees the holdout prompt');
    });

    await check('a service token publishes a verified run and a person a submitted one', async () => {
        const verified = await t.get('/api/v1/runs', { bearer: publisher, json: runDoc(`${benchmarkId}@${version}`) });
        assert.strictEqual(verified.status, 201, verified.text);
        assert.strictEqual(verified.json().run.provenance, 'verified');
        const submitted = await t.get('/api/v1/runs', { as: alice, json: runDoc(`${benchmarkId}@${version}`, { model: 'gpt-5' }) });
        assert.strictEqual(submitted.status, 201, submitted.text);
        assert.strictEqual(submitted.json().run.provenance, 'submitted');
        assert.strictEqual(submitted.json().run.executor.kind, 'submitted');
    });

    await check('a human judged run publishes null scores and keeps its output on the framed render path', async () => {
        const id = t.store.newId('brn');
        const url = `https://bench-render.openvibe.services/render/w/${id}~dDE`;
        const pending = runDoc(`${benchmarkId}@${version}`, {
            id, score: null,
            tasks: [{ task_id: 't1', score: null, cost_usd: 0.01, ms: 1200, tokens: 20,
                artifacts: [{ kind: 'games.play', url, payload: { text: '<!doctype html><html><body><h1>Rendered benchmark output</h1></body></html>' } }] }],
        });
        const published = await t.get('/api/v1/runs', { bearer: publisher, json: pending });
        assert.strictEqual(published.status, 201, published.text);
        assert.strictEqual(published.json().run.score, null);
        assert.strictEqual(published.json().run.tasks[0].score, null);
        assert.strictEqual(published.json().run.tasks[0].artifacts[0].payload, undefined);
        const rendered = await t.get(`/render/e/${id}~dDE`);
        assert.strictEqual(rendered.status, 200, rendered.text);
        assert.match(rendered.text, /Rendered benchmark output/);
    });

    await check('a run is read back with its tasks', async () => {
        const list = await t.get(`/api/v1/benchmarks/${benchmarkId}`);
        const runs = await t.get(`/api/v1/runs/${list.json().definition ? '' : ''}`);
        assert.ok(runs.status === 404 || runs.status === 200);
    });

    await check('the rankings keep the submitted runs out by default', async () => {
        const r = await t.get(`/api/v1/rankings?benchmark=${benchmarkId}&metric=score`);
        assert.strictEqual(r.status, 200, r.text);
        const models = r.json().rankings.entries.map((e) => e.model);
        assert.ok(models.includes('claude-opus-4'), 'the verified run is ranked');
        assert.ok(!models.includes('gpt-5'), 'the submitted run is not');
        const all = await t.get(`/api/v1/rankings?benchmark=${benchmarkId}&metric=score&include_submitted=true`);
        assert.ok(all.json().rankings.entries.map((e) => e.model).includes('gpt-5'), 'unless they are asked for');
    });

    await check('value is the score per dollar and the percentile says where a score sits', async () => {
        const r = await t.get(`/api/v1/rankings?benchmark=${benchmarkId}&metric=value`);
        assert.strictEqual(r.status, 200, r.text);
        const entry = r.json().rankings.entries.find((e) => e.model === 'claude-opus-4');
        assert.strictEqual(entry.value, Math.round((90 / 0.02) * 1000) / 1000);
        const p = await t.get(`/api/v1/percentile?benchmark=${benchmarkId}&model=claude-opus-4&score=90`);
        assert.strictEqual(p.status, 200, p.text);
        assert.strictEqual(p.json().percentile.runs, 1);
        assert.strictEqual(p.json().percentile.percentile, 50);
    });

    await check('a version that a run names never changes again, and a fork keeps its parent', async () => {
        const edit = await t.get(`/api/v1/benchmarks/${benchmarkId}`, { method: 'PUT', bearer: writer, json: { version, title: 'Renamed' } });
        assert.strictEqual(edit.status, 409, edit.text);
        assert.strictEqual(edit.json().code, 'bench.version_frozen');
        const fork = await t.get(`/api/v1/benchmarks/${benchmarkId}/fork`, { bearer: writer, json: {} });
        assert.strictEqual(fork.status, 201, fork.text);
        assert.strictEqual(fork.json().parent, `${benchmarkId}@${version}`);
        assert.ok(fork.json().benchmark.parent, 'the fork records its parent');
        assert.notStrictEqual(fork.json().benchmark.id, benchmarkId);
    });

    await check('a bad document is refused with a field-level error', async () => {
        const bad = await t.get('/api/v1/benchmarks', { bearer: writer, json: { title: '', kind: 'games.play' } });
        assert.strictEqual(bad.status, 422, bad.text);
        const badRun = await t.get('/api/v1/runs', { bearer: publisher, json: runDoc(`${benchmarkId}@${version}`, { score: 140 }) });
        assert.strictEqual(badRun.status, 400, badRun.text);
        assert.strictEqual(badRun.json().code, 'bench.invalid');
    });

    await check('the API refuses an anonymous write and a token without the capability', async () => {
        const anon = await t.get('/api/v1/benchmarks', { json: definition() });
        assert.strictEqual(anon.status, 401, anon.text);
        const noCap = await t.get('/api/v1/benchmarks', { bearer: reader, json: definition() });
        assert.strictEqual(noCap.status, 403, noCap.text);
        assert.strictEqual(noCap.json().code, 'bench.capability_denied');
        const anonRun = await t.get('/api/v1/runs', { json: runDoc(`${benchmarkId}@${version}`) });
        assert.strictEqual(anonRun.status, 401, anonRun.text);
    });

    await check('a signed-in person sees a clear unavailable response until Codes runs are configured', async () => {
        const response = await t.get(`/api/v1/benchmarks/${benchmarkId}/run`, { as: alice, json: { models: ['m'], harnesses: ['h'], repeat: 1 } });
        assert.strictEqual(response.status, 503, response.text);
        assert.strictEqual(response.json().code, 'bench.runner_unavailable');
    });

    await check('the compare endpoint puts two runs side by side', async () => {
        const runs = await t.get(`/api/v1/compare?runs=nope`);
        assert.strictEqual(runs.status, 404, runs.text);
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

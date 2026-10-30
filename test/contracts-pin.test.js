'use strict';

/**
 * The contracts pin (spec 2026-10-30, stage B1).
 *
 * Bench speaks the published shapes: openvibe-contracts v0.244.0 carries bench.benchmark@1 and bench.run@1 and the
 * three registry capabilities. These tests prove the pin is real — the package carries the shapes, Bench's own
 * capability list names only capabilities the package publishes, a frozen benchmark and a published run are the
 * published documents, and the holdout goes to the executor and to the owner and to nobody else.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { BENCH_CAPABILITIES, BENCH_SCHEMAS } = require('../server/contracts');

const TASKS = [
    { id: 't1', prompt: 'Build a one-screen arcade game with a paddle, bricks, a ball and a score.', files: [], expected: null, holdout: false },
    { id: 't2', prompt: 'Build a snake game on a 20x20 grid.', files: [], expected: null, holdout: true },
];

function definition() {
    return {
        title: 'The pinned set',
        description: 'A benchmark that must match bench.benchmark@1.',
        kind: 'games.play',
        tags: ['games'],
        visibility: 'public',
        tasks: TASKS,
        judges: [{ type: 'human_pairwise', version: '1.0', config: {} }],
        scoring: { method: 'mean', scale: { min: 0, max: 100 } },
        limits: { ms: 120000, tokens: 200000, usd: 0.5 },
        matrix: { models: ['claude-opus-4'], harnesses: ['claude-code'] },
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
    const owner = t.network.addUser('owner');
    const publisher = t.network.serviceToken({ sub: 'svc:codes', audience: 'openvibe.bench', cap: ['bench.run.publish', 'bench.benchmark.write'] });
    const writer = t.network.serviceToken({ sub: 'svc:writer', audience: 'openvibe.bench', cap: ['bench.benchmark.write'] });

    let benchmarkId;
    let version;

    await check('the pinned package carries the registry schemas and capabilities', async () => {
        assert.ok(contracts.schema('bench.benchmark@1'), 'bench.benchmark@1 is published');
        assert.ok(contracts.schema('bench.run@1'), 'bench.run@1 is published');
        assert.ok(BENCH_SCHEMAS['bench.benchmark@1'], 'Bench reads it from the package');
        assert.ok(BENCH_SCHEMAS['bench.run@1'], 'Bench reads it from the package');
        for (const cap of ['bench.benchmark.write', 'bench.run.publish', 'bench.run.read']) {
            assert.ok(BENCH_CAPABILITIES.includes(cap), `Bench grants ${cap}`);
            assert.ok(contracts.capabilities.get(cap), `the package publishes ${cap}`);
        }
    });

    await check('a frozen benchmark is a bench.benchmark@1 document', async () => {
        const created = await t.get('/api/v1/benchmarks', { bearer: writer, json: definition() });
        assert.strictEqual(created.status, 201, created.text);
        benchmarkId = created.json().benchmark.id;
        const frozen = await t.get(`/api/v1/benchmarks/${benchmarkId}/versions`, { bearer: writer, json: {} });
        assert.strictEqual(frozen.status, 201, frozen.text);
        version = frozen.json().version.version;
        contracts.assertValid('bench.benchmark@1', frozen.json().version.definition);
    });

    await check('a published run is a bench.run@1 document', async () => {
        const published = await t.get('/api/v1/runs', { bearer: publisher, json: runDoc(`${benchmarkId}@${version}`) });
        assert.strictEqual(published.status, 201, published.text);
        contracts.assertValid('bench.run@1', published.json().run.document);
        assert.strictEqual(published.json().run.document.provenance, 'verified');
        const read = await t.get(`/api/v1/runs/${published.json().run.id}`);
        assert.strictEqual(read.status, 200, read.text);
        contracts.assertValid('bench.run@1', read.json().run.document);
    });

    await check('a run that is not the published shape is refused', async () => {
        const bad = await t.get('/api/v1/runs', { bearer: publisher, json: runDoc(`${benchmarkId}@${version}`, { settings: { temperature: 9 } }) });
        assert.strictEqual(bad.status, 400, bad.text);
        assert.strictEqual(bad.json().code, 'bench.invalid');
    });

    await check('the owner sees the holdout and a stranger does not', async () => {
        const made = await t.get('/api/v1/benchmarks', { bearer: t.network.userToken(owner), json: definition() });
        assert.strictEqual(made.status, 201, made.text);
        const id = made.json().benchmark.id;
        const frozen = await t.get(`/api/v1/benchmarks/${id}/versions`, { bearer: t.network.userToken(owner), json: {} });
        assert.strictEqual(frozen.status, 201, frozen.text);

        const mine = await t.get(`/api/v1/benchmarks/${id}`, { bearer: t.network.userToken(owner) });
        const myTask = mine.json().definition.tasks.find((x) => x.id === 't2');
        assert.ok(myTask.prompt, 'the owner sees the holdout prompt');

        const theirs = await t.get(`/api/v1/benchmarks/${id}`, { bearer: t.network.userToken(alice) });
        const theirTask = theirs.json().definition.tasks.find((x) => x.id === 't2');
        assert.strictEqual(theirTask.prompt, null, 'a stranger does not');

        const public_ = await t.get(`/api/v1/benchmarks/${id}`);
        assert.strictEqual(public_.json().definition.tasks.find((x) => x.id === 't2').prompt, null, 'nobody does');
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

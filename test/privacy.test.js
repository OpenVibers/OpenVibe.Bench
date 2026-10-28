'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot({ env: { BENCH_EVALS_PER_DAY: '1', BENCH_ROUNDS_PER_DAY: '100', BENCH_ROUNDS_DAILY: '1000' } });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const entrySvc = t.network.serviceToken({ sub: 'svc:room', audience: 'openvibe.bench', cap: ['bench.entry.create'] });

    let evalId;
    let runId;

    await check('a private eval is created and run under the free daily cap', async () => {
        const created = await t.get('/api/v1/evals', { as: alice, json: { kind_id: 'vision.answer', name: 'Held-out suite', test_suite: [{ prompt: 'What is 2 + 2?' }, { prompt: 'What is 3 + 3?' }] } });
        assert.strictEqual(created.status, 201, created.text);
        evalId = created.json().eval.id;
        const run = await t.get(`/api/v1/evals/${evalId}/run`, { as: alice, json: { offers: [{ provider: 'acme', model: 'alpha-1' }] } });
        assert.strictEqual(run.status, 202, run.text);
        runId = run.json().run.id;
        assert.strictEqual(run.json().run.status, 'queued');
    });

    await check('the daily cap refuses a second run the same day', async () => {
        const run = await t.get(`/api/v1/evals/${evalId}/run`, { as: alice, json: { offers: [] } });
        assert.strictEqual(run.status, 429, run.text);
    });

    await check('another owner cannot read the eval or its results', async () => {
        const r = await t.get(`/api/v1/evals/${evalId}`, { as: bob });
        assert.strictEqual(r.status, 404, r.text);
        const results = await t.get(`/api/v1/evals/${evalId}/results`, { as: bob });
        assert.strictEqual(results.status, 404, results.text);
    });

    await check('the job runs the suite and results stay private', async () => {
        await t.tick();
        const r = await t.get(`/api/v1/evals/${evalId}/results`, { as: alice });
        assert.strictEqual(r.status, 200, r.text);
        const run = r.json().runs.find((x) => x.id === runId);
        assert.strictEqual(run.status, 'ready');
        assert.ok(Array.isArray(run.results));
        assert.strictEqual(r.json().eval.owner, alice.subject);
    });

    await check('nothing private ever appears in the open dataset', async () => {
        const r = await t.get('/api/v1/datasets/vision.answer.jsonl');
        assert.strictEqual(r.status, 200, r.text);
        const lines = r.text.trim() ? r.text.trim().split('\n').map((l) => JSON.parse(l)) : [];
        assert.ok(lines.every((line) => !line.eval_id && !line.owner && !line.subject), 'dataset line leaked private fields');
    });

    await check('a private eval never appears on a public board', async () => {
        const task = await t.get('/api/v1/kinds/vision.answer/tasks', { as: alice, json: { prompt: 'A public task.', public: true } });
        const rr = await t.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { as: alice, json: {} });
        const roundId = rr.json().round.id;
        await t.get(`/api/v1/rounds/${roundId}/entries`, { bearer: entrySvc, json: { provider: 'acme', model: 'alpha-1', payload: { answer: 'public' } } });
        await t.get(`/api/v1/rounds/${roundId}/entries`, { bearer: entrySvc, json: { provider: 'beta', model: 'beta-2', payload: { answer: 'public' } } });
        for (const type of ['elo', 'pareto', 'cost']) {
            const board = await t.get(`/api/v1/boards/vision.answer?type=${type}`);
            assert.strictEqual(board.status, 200, `${type}: ${board.text}`);
            assert.ok(board.json().board.rows.every((row) => !String(row.subject).startsWith('bev_') && row.subject !== runId), 'private eval leaked into board');
        }
    });

    await check('the open dataset has no voter id or person id anywhere', async () => {
        const r = await t.get('/api/v1/datasets/vision.answer.jsonl');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.text.includes('usr_'), false, 'dataset contains a person id');
        for (const line of r.text.trim().split('\n').map((l) => JSON.parse(l))) {
            assert.strictEqual(line.subject, undefined, 'judgement leaked a voter id');
            assert.strictEqual(line.created_by, undefined, 'task or round leaked a person id');
            assert.strictEqual(line.owner, undefined, 'eval leaked an owner id');
        }
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

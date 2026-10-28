'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot({ env: { BENCH_EVALS_PER_DAY: '1' } });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');

    let evalId;
    let runId;

    await check('a private eval is created and run under the free daily cap', async () => {
        const r = await t.get('/api/v1/evals', { as: alice, json: { kind_id: 'vision.answer', name: 'Held-out suite', test_suite: [{ prompt: 'What is 2 + 2?' }, { prompt: 'What is 3 + 3?' }] } });
        assert.strictEqual(r.status, 201, r.text);
        evalId = r.json().eval.id;
        const run = await t.get(`/api/v1/evals/${evalId}/run`, { as: alice, json: { offers: [{ provider: 'acme', model: 'alpha-1' }] } });
        assert.strictEqual(run.status, 202, run.text);
        runId = run.json().run.id;
        assert.strictEqual(run.json().run.status, 'queued');
    });

    await check('the daily cap refuses a second run the same day', async () => {
        const run = await t.get(`/api/v1/evals/${evalId}/run`, { as: alice, json: { offers: [] } });
        assert.strictEqual(run.status, 429, run.text);
    });

    await check('another owner cannot read the eval', async () => {
        const r = await t.get(`/api/v1/evals/${evalId}`, { as: bob });
        assert.strictEqual(r.status, 404, r.text);
    });

    await check('the job runs the suite and results stay private', async () => {
        await t.tick();
        const r = await t.get(`/api/v1/evals/${evalId}/results`, { as: alice });
        assert.strictEqual(r.status, 200, r.text);
        const run = r.json().runs.find((x) => x.id === runId);
        assert.strictEqual(run.status, 'ready');
        assert.ok(Array.isArray(run.results));
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

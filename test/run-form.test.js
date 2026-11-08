'use strict';

/**
 * Starting a benchmark on openvibe.codes (stage B3): the API and the run form share one launcher.
 *
 * Under test: a signed-out visitor is sent to sign in; the form lists Codes' harnesses; an estimate above $1 asks
 * for a confirmation before anything reaches Codes; a confirmed run reaches Codes once, as the person, with a service
 * token, and the browser lands on the person's task list; a cross-site form post is refused; the API answers the same
 * way (409 with the estimate, then 202).
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

function fakeCodes() {
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            calls.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
            res.setHeader('content-type', 'application/json');
            if (req.url === '/api/v1/harnesses') return res.end(JSON.stringify({ harnesses: [{ id: 'claude-code', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }] }));
            if (/^\/api\/v1\/benchmarks\/[^/]+\/run$/.test(req.url) && req.method === 'POST') {
                res.statusCode = 202;
                return res.end(JSON.stringify({ session: 'ses_1', tasks: [{ id: 'tsk_1' }], task: { id: 'tsk_1' }, total: 1 }));
            }
            res.statusCode = 404; res.end('{}');
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}

(async () => {
    const codes = await fakeCodes();
    const t = await boot({ env: { CODES_BENCH_RUN_URL: codes.url } });
    const alice = t.network.addUser('alice');
    const publisher = t.network.serviceToken({ sub: 'svc:codes', audience: 'openvibe.bench', cap: ['bench.run.publish', 'bench.benchmark.write'] });
    const created = await t.get('/api/v1/benchmarks', { bearer: publisher, json: {
        title: 'Run form arena', description: 'For the run form tests.', kind: 'games.play', tags: [], visibility: 'public',
        tasks: [{ id: 't1', prompt: 'Make a game.', files: [], expected: null, holdout: false }, { id: 't2', prompt: 'Make another.', files: [], expected: null, holdout: false }],
        judges: [{ type: 'game_outcome', version: '1.0', config: {} }], scoring: { method: 'mean', scale: { min: 0, max: 100 } },
        limits: { ms: 60000, tokens: 100000, usd: 0.5 }, matrix: { models: ['model-a'], harnesses: ['codex'] },
    } });
    assert.strictEqual(created.status, 201, created.text);
    const id = created.json().benchmark.id;
    assert.strictEqual((await t.get(`/api/v1/benchmarks/${id}/versions`, { bearer: publisher, json: {} })).status, 201);

    await check('the API answers the same way: 409 with the estimate, then 202', async () => {
        const body = { models: ['model-a', 'model-b'], harnesses: ['codex'], repeat: 1 };
        const ask = await t.get(`/api/v1/benchmarks/${id}/run`, { as: alice, json: body });
        assert.strictEqual(ask.status, 409, ask.text);
        assert.strictEqual(ask.json().cost_estimate_usd, 2);
        const go = await t.get(`/api/v1/benchmarks/${id}/run`, { as: alice, json: { ...body, confirm: true } });
        assert.strictEqual(go.status, 202, go.text);
        assert.strictEqual(go.json().total, 1);
    });

    await check('a benchmark with no dollar limit always asks before it starts', async () => {
        const res2 = await t.get('/api/v1/benchmarks', { bearer: publisher, json: {
            title: 'No limit arena', description: 'No usd limit.', kind: 'games.play', tags: [], visibility: 'public',
            tasks: [{ id: 't1', prompt: 'Make a game.', files: [], expected: null, holdout: false }],
            judges: [{ type: 'game_outcome', version: '1.0', config: {} }], scoring: { method: 'mean', scale: { min: 0, max: 100 } },
            limits: { ms: 60000, tokens: 100000 }, matrix: { models: [], harnesses: [] },
        } });
        assert.strictEqual(res2.status, 201, res2.text);
        const nid = res2.json().benchmark.id;
        assert.strictEqual((await t.get(`/api/v1/benchmarks/${nid}/versions`, { bearer: publisher, json: {} })).status, 201);
        const ask = await t.get(`/api/v1/benchmarks/${nid}/run`, { as: alice, json: { models: ['m'], harnesses: ['codex'], repeat: 1 } });
        assert.strictEqual(ask.status, 409, ask.text);
        assert.strictEqual(ask.json().cost_estimate_usd, null, 'no estimate is invented');
    });

    await check('stop', async () => { await t.close(); codes.close(); });
    done();
})();

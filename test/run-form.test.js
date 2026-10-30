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
    const form = (fields) => new URLSearchParams(fields).toString();
    const post = (fields, o = {}) => t.get(`/benchmarks/${id}/run`, { as: alice, raw: form(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' }, ...o });
    const runCalls = () => codes.calls.filter((c) => c.method === 'POST');

    await check('the benchmark page links to its run form', async () => {
        const res = await t.get(`/benchmarks/${id}`);
        assert.ok(res.text.includes(`href="/benchmarks/${id}/run">Run it yourself`), 'the button opens the form, not a bare Codes link');
    });

    await check('signed out, the form asks you to sign in', async () => {
        const res = await t.get(`/benchmarks/${id}/run`);
        assert.strictEqual(res.status, 200, res.text.slice(0, 200));
        assert.ok(res.text.includes('Sign in first'));
        assert.ok(!res.text.includes('<form class="br-form"'), 'no form for a stranger');
    });

    await check('signed in, the form lists the benchmark matrix and Codes harnesses', async () => {
        const res = await t.get(`/benchmarks/${id}/run`, { as: alice });
        assert.ok(res.text.includes('<form class="br-form"'));
        assert.ok(res.text.includes('value="model-a" checked'), 'the matrix model is picked');
        assert.ok(res.text.includes('value="claude-code"') && res.text.includes('Codex'), "Codes' harness list");
    });

    await check('an estimate above $1 asks once more and reaches nobody', async () => {
        const before = runCalls().length;
        const res = await post([['models', 'model-a'], ['more_models', 'model-b'], ['harnesses', 'codex'], ['repeat', '1']]);
        assert.strictEqual(res.status, 200, res.text.slice(0, 200));
        assert.ok(res.text.includes('may cost up to') && res.text.includes('$2.00'), '2 tasks × 2 models × $0.50');
        assert.ok(res.text.includes('name="confirm" value="1"') && res.text.includes('Confirm and start'));
        assert.strictEqual(runCalls().length, before, 'Codes was not called');
    });

    await check('a confirmed run reaches Codes once, as the person, and lands on their tasks', async () => {
        const before = runCalls().length;
        const res = await post([['models', 'model-a'], ['more_models', 'model-b'], ['harnesses', 'codex'], ['repeat', '1'], ['confirm', '1']]);
        assert.strictEqual(res.status, 303, res.text.slice(0, 200));
        assert.strictEqual(res.headers.get('location'), `${codes.url}/tasks`);
        const calls = runCalls().slice(before);
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0].body.models, ['model-a', 'model-b']);
        assert.match(String(calls[0].headers.authorization), /^Bearer /, "Bench's own service token");
        assert.ok(calls[0].headers['x-ov-subject'], 'names the person');
    });

    await check('nothing picked is said plainly', async () => {
        const res = await post([['repeat', '1']]);
        assert.strictEqual(res.status, 400);
        assert.ok(res.text.includes('non-empty lists'));
    });

    await check('a cross-site form post is refused', async () => {
        const res = await post([['models', 'model-a'], ['harnesses', 'codex'], ['repeat', '1']], { origin: 'https://evil.example' });
        assert.strictEqual(res.status, 403);
    });

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
        const before = runCalls().length;
        const ask = await t.get(`/api/v1/benchmarks/${nid}/run`, { as: alice, json: { models: ['m'], harnesses: ['codex'], repeat: 1 } });
        assert.strictEqual(ask.status, 409, ask.text);
        assert.strictEqual(ask.json().cost_estimate_usd, null, 'no estimate is invented');
        const page = await t.get(`/benchmarks/${nid}/run`, { as: alice, raw: form([['more_models', 'm'], ['harnesses', 'codex'], ['repeat', '1']]), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        assert.ok(page.text.includes('sets no dollar limit per task'), 'the form says why it asks');
        assert.strictEqual(runCalls().length, before, 'and nothing reached Codes');
    });

    await check('stop', async () => { await t.close(); codes.close(); });
    done();
})();

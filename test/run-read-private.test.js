'use strict';
/**
 * GET /api/v1/runs/:id answers a run on a private benchmark only to whoever may read the benchmark (its owner, the
 * executor, a person it is shared with). The 11-15 review found the route's async read check called without await: a
 * Promise is truthy, so `!mayRead(...)` never denied and an anonymous caller got a private run. This file keeps that
 * fixed: a stranger and an anonymous caller get the same 404 as a run that does not exist.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

function definition(visibility) {
    return {
        title: `A ${visibility} set`, description: 'Prompts that are nobody else\'s business.', kind: 'games.play', tags: [], visibility,
        tasks: [{ id: 't1', prompt: 'A private prompt: the quarterly numbers for the board.', files: [], expected: null, holdout: false }],
        judges: [{ type: 'human_pairwise', version: '1.0', config: {} }],
        scoring: { method: 'mean', scale: { min: 0, max: 100 } },
        limits: { ms: 120000, tokens: 200000, usd: 0.5 },
        matrix: { models: ['claude-opus-4'], harnesses: ['claude-code'] },
    };
}

const runDoc = (benchmark) => ({
    benchmark, model: 'claude-opus-4', route: { provider: 'anthropic' }, provider: 'anthropic',
    harness: { name: 'claude-code', version: '1.2.0' }, settings: { temperature: 1, effort: 'high' }, executor: { kind: 'codes', id: 'task_9' },
    tasks: [{ task_id: 't1', score: 80, cost_usd: 0.02, ms: 40000, tokens: 8000, artifacts: [], output: 'the private answer' }],
    score: 80, cost_usd: 0.02, ms: 40000, tokens: 8000,
});

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const publisher = t.network.serviceToken({ sub: 'svc:codes', audience: 'openvibe.bench', cap: ['bench.run.publish', 'bench.benchmark.write'] });
    const runs = {};

    await check('alice\'s private and public benchmarks each get a run from the executor', async () => {
        for (const visibility of ['private', 'public']) {
            const made = await t.get('/api/v1/benchmarks', { as: alice, json: definition(visibility) });
            assert.strictEqual(made.status, 201, made.text);
            const id = made.json().benchmark.id;
            const frozen = await t.get(`/api/v1/benchmarks/${id}/versions`, { as: alice, json: {} });
            assert.strictEqual(frozen.status, 201, frozen.text);
            const run = await t.get('/api/v1/runs', { bearer: publisher, json: runDoc(`${id}@${frozen.json().version.version}`) });
            assert.strictEqual(run.status, 201, run.text);
            runs[visibility] = run.json().run.id;
        }
    });

    await check('a private benchmark\'s run: 404 for an anonymous caller and for another person', async () => {
        const anon = await t.get(`/api/v1/runs/${runs.private}`);
        assert.strictEqual(anon.status, 404, `anonymous: ${anon.status} ${anon.text.slice(0, 200)}`);
        assert.ok(!anon.text.includes('private answer') && !anon.text.includes('quarterly numbers'), 'nothing of the run leaks');
        const stranger = await t.get(`/api/v1/runs/${runs.private}`, { as: bob });
        assert.strictEqual(stranger.status, 404, `another person: ${stranger.status}`);
        assert.strictEqual(anon.json().code, (await t.get('/api/v1/runs/brn_00000000000000000000000000')).json().code, 'the same answer as a run that does not exist');
    });

    await check('its owner and the executor read it, never cached in public', async () => {
        const own = await t.get(`/api/v1/runs/${runs.private}`, { as: alice });
        assert.strictEqual(own.status, 200, own.text);
        assert.strictEqual(own.json().run.id, runs.private);
        assert.match(String(own.headers['cache-control'] || own.headers.get?.('cache-control') || ''), /private, no-store/);
        const exec = await t.get(`/api/v1/runs/${runs.private}`, { bearer: publisher });
        assert.strictEqual(exec.status, 200, exec.text);
    });

    await check('a public benchmark\'s run stays readable by anyone', async () => {
        const anon = await t.get(`/api/v1/runs/${runs.public}`);
        assert.strictEqual(anon.status, 200, anon.text);
    });

    await check('every read check in the HTTP routes is awaited (a static guard)', async () => {
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(__dirname, '..', 'server', 'http');
        const bad = [];
        for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
            fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
                // A call of an async permission check that is not awaited is always truthy.
                if (/\bmayRead\(|\bcanView\(/.test(line) && !/await\s+(ctx\.sharing\.)?(mayRead|canView)\(/.test(line) && !/const mayRead|async \(/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
            });
        }
        assert.deepStrictEqual(bad, [], 'un-awaited read checks');
    });

    await check('stop', async () => { await t.close(); });
    done();
})().catch((e) => { console.error(e); process.exit(1); });

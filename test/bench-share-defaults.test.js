'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const prompts = ['What is 2 + 2?', 'Say hello in French.', 'Name a primary colour.', 'What is 3 × 3?', 'Finish: sun—', 'Name a planet.'];
    const make = async (user, title) => {
        const r = await t.get('/benchmarks/new', {
            as: user, method: 'POST', body: new URLSearchParams({ title, kind: 'text.answer', format: 'lines', prompts: prompts.join('\n') }).toString(),
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        assert.strictEqual(r.status, 303, r.text.slice(0, 200));
        return r.headers.get('location').split('/').pop();
    };
    const row = (id) => t.ctx.s.db.maybe("SELECT audience FROM shares WHERE service = 'bench' AND kind = 'benchmark' AND resource_id = $1", [id]);
    const put = (user, audience, apply = false) => t.get('/api/v1/share-defaults/benchmark', {
        as: user, method: 'PUT', json: { audience, apply },
    });
    try {
        await check('Only me is the default; a person can save Specific people and override one benchmark', async () => {
            const initial = await t.get('/api/v1/share-defaults/benchmark', { as: alice });
            assert.strictEqual(initial.json().audience, 'private');
            assert.strictEqual((await put(alice, 'people')).status, 200);
            const id = await make(alice, 'Named readers benchmark');
            assert.strictEqual((await row(id)).audience, 'people');
            assert.strictEqual((await t.ctx.s.db.maybe('SELECT visibility FROM bench_benchmarks WHERE id = $1', [id])).visibility, 'private');
            assert.strictEqual((await t.get(`/api/v1/benchmarks/${id}`, { as: bob })).status, 404);
            const one = await t.get(`/api/v1/benchmark/${id}/share`, {
                as: alice, method: 'PUT', json: { audience: 'public' }, headers: { 'x-requested-with': 'ov-share' },
            });
            assert.strictEqual(one.status, 200, one.text);
            assert.strictEqual((await row(id)).audience, 'public');
        });

        await check('apply to all changes only the owner’s benchmarks and removes public listings', async () => {
            const own = await make(alice, 'Apply own benchmark');
            const other = await make(bob, 'Bob benchmark');
            const changed = await put(alice, 'private', true);
            assert.strictEqual(changed.status, 200, changed.text);
            assert.ok(changed.json().changed >= 1);
            assert.strictEqual((await row(own)).audience, 'private');
            assert.strictEqual((await row(other)).audience, 'private');
            assert.ok(!(await t.get('/api/v1/benchmarks')).json().benchmarks.some((b) => b.id === own));
            assert.strictEqual((await t.get(`/api/v1/benchmarks/${own}`, { as: alice })).status, 200);
            const link = await put(alice, 'link', true);
            assert.strictEqual(link.status, 200, link.text);
            assert.strictEqual((await row(own)).audience, 'link');
            assert.strictEqual((await row(other)).audience, 'private');
        });

        await check('invalid defaults and cross-site form writes are refused', async () => {
            assert.strictEqual((await put(alice, 'nope')).status, 422);
            const bad = await t.get('/api/v1/share-defaults/benchmark', {
                as: alice, method: 'PUT', json: { audience: 'public' },
                headers: { origin: 'https://elsewhere.example' },
            });
            assert.strictEqual(bad.status, 403);
        });
    } finally { await t.close(); }
    done();
})().catch((error) => { console.error(error); process.exit(1); });

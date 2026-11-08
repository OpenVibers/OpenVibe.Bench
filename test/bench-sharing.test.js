'use strict';
/**
 * Sharing on Bench benchmarks (design 2026-11-06, VISIBILITY-EVERYWHERE step 4; openvibe-sdk/share).
 * A private benchmark is Only me; its owner can name people. The registry's own visibility (public,
 * unlisted, private) stays the column every list and sitemap reads, and the share row is the check.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const sam = t.network.addUser('sam');
    const prompts = ['What is 2 + 2?', 'Say hello in French.', 'Name a primary colour.', 'What is 3 × 3?', 'Finish: sun—', 'Name a planet.'];
    const post = (p, body, o = {}) => t.get(p, { as: alice, body: new URLSearchParams(body).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, ...o });
    const make = async (title) => {
        const res = await post('/benchmarks/new', { title, kind: 'text.answer', format: 'lines', prompts: prompts.join('\n') });
        assert.strictEqual(res.status, 303, res.text.slice(0, 200));
        return res.headers.get('location').split('/').pop();
    };
    const share = (id, o = {}) => t.get(`/api/v1/benchmark/${id}/share`, { as: alice, headers: { 'x-requested-with': 'ov-share' }, ...o });
    const putShare = (id, body) => share(id, { method: 'PUT', json: body });
    const row = async (id) => await t.ctx.s.db.maybe('SELECT * FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', ['bench', 'benchmark', id]);

    await check('a new benchmark is private and registered Only me, owned by its maker', async () => {
        const id = await make('My private prompts');
        const s = await row(id);
        assert.strictEqual(s.audience, 'private');
        assert.deepStrictEqual(s.owner_subject, { type: 'user', id: alice.subject });
        assert.strictEqual((await t.get(`/api/v1/benchmarks/${id}`, { as: alice })).status, 200);
        assert.strictEqual((await t.get(`/api/v1/benchmarks/${id}`, { as: bob })).status, 404);
    });

    await check('Specific people: the named person reads it; a stranger gets 404 and the page never leaks the title', async () => {
        const id = await make('Board pack bench');
        const put = await putShare(id, { audience: 'people', members: [{ subject: { type: 'user', id: bob.subject }, role: 'viewer' }] });
        assert.strictEqual(put.status, 200, put.text);
        assert.strictEqual(put.json().audience, 'people');
        assert.strictEqual((await t.get(`/api/v1/benchmarks/${id}`, { as: bob })).status, 200);
        const stranger = await t.get(`/api/v1/benchmarks/${id}`, { as: sam });
        assert.strictEqual(stranger.status, 404);
        assert.ok(!stranger.text.includes('Board pack bench'));
        assert.strictEqual((await t.get(`/api/v1/benchmark/${id}/share`, { as: sam })).status, 404, 'the sheet is the owner’s');
    });

    await check('Everyone publishes it into the list; Only me takes it out; the old column follows the sheet', async () => {
        const id = await make('Going public');
        assert.strictEqual((await putShare(id, { audience: 'public' })).status, 200);
        assert.strictEqual((await row(id)).audience, 'public');
        assert.strictEqual((await t.ctx.s.db.maybe('SELECT visibility FROM bench_benchmarks WHERE id = $1', [id])).visibility, 'public');
        assert.strictEqual((await t.get(`/api/v1/benchmarks/${id}`)).status, 200);
        assert.ok((await t.get('/api/v1/benchmarks')).json().benchmarks.some((b) => b.id === id), 'in the API list');
        assert.strictEqual((await putShare(id, { audience: 'private' })).status, 200);
        assert.strictEqual((await t.get(`/api/v1/benchmarks/${id}`)).status, 404);
        assert.ok(!(await t.get('/api/v1/benchmarks')).json().benchmarks.some((b) => b.id === id), 'out of the API list');
        assert.strictEqual((await t.get(`/api/v1/benchmarks/${id}`, { as: alice })).status, 200, 'the owner still reads it');
    });

    await check('the sheet lists the members to the owner, and the old form keeps the row in step', async () => {
        const id = await make('Two readers');
        await putShare(id, { audience: 'people', members: [{ subject: { type: 'user', id: sam.subject }, role: 'viewer' }] });
        const mine = await share(id);
        assert.strictEqual(mine.status, 200);
        assert.strictEqual(mine.json().members[0].username, 'sam');
        assert.strictEqual(mine.json().you.role, 'owner');
        // The API is the one way now that the HTML pages are gone; it keeps the old visibility column in step.
        assert.strictEqual((await putShare(id, { audience: 'public' })).status, 200);
        assert.strictEqual((await row(id)).audience, 'public');
        assert.strictEqual((await t.ctx.s.db.maybe('SELECT visibility FROM bench_benchmarks WHERE id = $1', [id])).visibility, 'public');
    });

    await done();
    await t.close();
})();

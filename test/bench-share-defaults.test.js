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

        await check('the owner page carries the default, "apply to all" and each Share button', async () => {
            const id = await make(alice, 'Owner page benchmark');
            const mine = await t.get('/benchmarks/mine', { as: alice });
            assert.strictEqual(mine.status, 200, mine.text.slice(0, 200));
            assert.ok(mine.text.includes('New benchmarks') && mine.text.includes('name="audience"'));
            assert.ok(mine.text.includes('Apply to all my existing benchmarks'));
            assert.ok(mine.text.includes('Owner page benchmark'));
            assert.ok(mine.text.includes(`data-kind="benchmark" data-id="${id}"`), 'the Share sheet button names the benchmark');
            assert.strictEqual((await t.get('/benchmarks/mine')).status, 302, 'signed out, the owner page signs in first');

            const saved = await t.get('/benchmarks/mine/default', {
                as: alice, method: 'POST',
                body: new URLSearchParams({ audience: 'link', apply: '1' }).toString(),
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
            });
            assert.strictEqual(saved.status, 303, saved.text);
            assert.ok(String(saved.headers.get('location')).startsWith('/benchmarks/mine?'));
            assert.strictEqual((await row(id)).audience, 'link');
            const after = await t.get(saved.headers.get('location'), { as: alice });
            assert.ok(after.text.includes('Sharing preference saved'), 'the saved notice is shown');
            assert.strictEqual((await t.get('/benchmarks/new', { as: alice })).status, 200, 'the create form stays on Bench');
        });

        await check('a public benchmark still moves to Report; a private one and a share link stay here', async () => {
            const id = await make(alice, 'Moved public benchmark');
            const madePublic = await t.get(`/benchmarks/${id}/share`, {
                as: alice, method: 'POST', body: new URLSearchParams({ visibility: 'public' }).toString(),
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
            });
            assert.strictEqual(madePublic.status, 200, madePublic.text.slice(0, 200));
            const anon = await t.get(`/benchmarks/${id}`);
            assert.strictEqual(anon.status, 301);
            assert.strictEqual(anon.headers.get('location'), `https://openvibe.compare/ai/${id}`);
            const owner = await t.get(`/benchmarks/${id}`, { as: alice });
            assert.strictEqual(owner.status, 200, 'the owner keeps the page with the Share controls');
            assert.ok(owner.text.includes('Sharing'));

            await put(alice, 'private');
            const hidden = await make(alice, 'Private benchmark');
            assert.strictEqual((await t.get(`/benchmarks/${hidden}`)).status, 404);
            assert.strictEqual((await t.get(`/benchmarks/${hidden}`, { as: bob })).status, 404);
            assert.strictEqual((await t.get(`/benchmarks/${hidden}`, { as: alice })).status, 200);

            const unlisted = await t.ctx.registry.setVisibility(hidden, { visibility: 'unlisted', subject: alice.subject });
            assert.strictEqual(unlisted.ok, true);
            const link = await t.get(unlisted.share_path);
            assert.strictEqual(link.status, 200, 'an unlisted share link opens on Bench, not Report');
            assert.ok(link.text.includes('Private benchmark'));
        });
    } finally { await t.close(); }
    done();
})().catch((error) => { console.error(error); process.exit(1); });

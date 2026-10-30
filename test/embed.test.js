'use strict';

/** The embed (B10): only that route may be framed, no cookies, and voting opens Bench in a new tab. */

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');   // the round belongs to somebody else: a battle is never your own
    const entrySvc = t.network.serviceToken({ sub: 'svc:room', audience: 'openvibe.bench', cap: ['bench.entry.create'] });

    const task = await t.get('/api/v1/kinds/games.play/tasks', { as: bob, json: { prompt: 'A game for an embed.', public: true } });
    const rr = await t.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { as: bob, json: {} });
    const roundId = rr.json().round.id;
    const e1 = await t.get(`/api/v1/rounds/${roundId}/entries`, { bearer: entrySvc, json: { provider: 'acme', model: 'alpha-1', payload: { html: '<h1>a</h1>' } } });
    const e2 = await t.get(`/api/v1/rounds/${roundId}/entries`, { bearer: entrySvc, json: { provider: 'beta', model: 'beta-2', payload: { html: '<h1>b</h1>' } } });
    assert.strictEqual(e1.status, 201, e1.text);
    assert.strictEqual(e2.status, 201, e2.text);

    // A battle needs a finished round: the job would do it, the test does it directly.
    await t.ctx.s.db.exec("UPDATE bench_rounds SET status = 'finished' WHERE id = $1", [roundId]);
    const battle = await t.get('/battle', { as: alice });
    assert.strictEqual(battle.status, 200, battle.text.slice(0, 200));
    const id = /data-battle="([^"]+)"/.exec(battle.text)[1];

    await check('the embed may be framed, and every other route may not', async () => {
        const e = await t.get('/embed/battle/' + id);
        assert.strictEqual(e.status, 200, e.text.slice(0, 200));
        assert.ok(/frame-ancestors \*/.test(e.headers.get('content-security-policy')), 'the embed may be framed: ' + e.headers.get('content-security-policy'));
        const home = await t.get('/');
        assert.ok(/frame-ancestors 'none'/.test(home.headers.get('content-security-policy')), 'the rest refuses frames: ' + home.headers.get('content-security-policy'));
        assert.strictEqual(home.headers.get('x-frame-options'), 'DENY');
    });

    await check('the embed reads and sets no cookie', async () => {
        const e = await t.get('/embed/battle/' + id);
        assert.strictEqual(e.headers.get('set-cookie'), null, 'no cookie is set');
        const home = await t.get('/');
        assert.strictEqual(home.headers.get('set-cookie'), null, 'and none on the other pages either');
    });

    await check('the embed keeps the frames sandboxed and sends the vote to a new tab', async () => {
        const e = await t.get('/embed/battle/' + id);
        assert.ok(e.text.includes('sandbox="allow-scripts allow-same-origin"'), 'the frames are sandboxed');
        assert.ok(e.text.includes('target="_blank"'), 'the vote opens a new tab');
        assert.ok(e.text.includes('rel="noopener"'), 'and it is safe');
        assert.ok(e.text.includes('noindex'), 'it is not indexed');
        assert.ok(e.text.includes('OpenVibe Bench'), 'it links back');
    });

    await check('an unknown battle is a plain 404, still framable', async () => {
        const e = await t.get('/embed/battle/bbs_nope');
        assert.strictEqual(e.status, 404);
        assert.ok(/frame-ancestors \*/.test(e.headers.get('content-security-policy')));
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

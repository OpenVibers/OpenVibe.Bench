'use strict';
const renderLib = require('../server/bench/render');

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
        // Its policy lets its own clock run and its child load (10-30: 'script-src self' blocked the clock, and the
        // header had no frame-src, so default-src 'none' refused the child frame).
        const wcsp = w.headers.get('content-security-policy') || '';
        const nonce = (/script-src 'nonce-([^']+)'/.exec(wcsp) || [])[1];
        assert.ok(nonce, 'the wrapper header names a nonce: ' + wcsp);
        assert.ok(w.text.includes('<script nonce="' + nonce + '">'), 'the clock script carries the header\'s nonce');
        assert.ok(wcsp.includes('frame-src ' + renderLib.RENDER_ORIGIN), 'the child frame may load from the render origin: ' + wcsp);
        assert.ok(w.text.includes('src="' + renderLib.RENDER_ORIGIN + '/render/e/'), 'the child loads from the render origin');
        assert.ok(!w.headers.get('x-frame-options'), 'no X-Frame-Options DENY: frame-ancestors decides');
        assert.ok(wcsp.includes('frame-ancestors https://bench.openvibe.services'), 'the showcase page may frame it');
        const ecsp = (await t.get('/render/e/' + entryA)).headers.get('content-security-policy') || '';
        assert.ok(ecsp.includes('frame-ancestors ' + renderLib.RENDER_ORIGIN), 'the wrapper on the render origin may frame the model document: ' + ecsp);
        assert.ok(!/<meta[^>]*frame-ancestors/.test(w.text), 'no frame-ancestors in a meta tag (ignored there)');
    });

    await check('built-in pages and whole pages: one nonce per script, the import map for three and its addons', async () => {
        const glsl = renderLib.modelDocument({ id: 'games.shader' }, { glsl: 'void main(){gl_FragColor=vec4(1.0);}' }, { nonce: 'N1' });
        assert.ok(!glsl.includes('__NONCE__'), 'the placeholder becomes the nonce');
        assert.ok(!/nonce="[^"]*"\s+nonce=/.test(glsl), 'no tag carries two nonces');
        assert.ok(/http-equiv="Content-Security-Policy" content="[^"]*nonce-N1/.test(glsl), 'the page\'s own CSP names the same nonce');
        const own = renderLib.modelDocument({ id: 'games.three' }, { html: '<!doctype html><html><head><title>x</title></head><body><script type="module" nonce="guess">import * as THREE from "three";</script></body></html>' }, { nonce: 'N2' });
        assert.ok(own.includes('"three/addons/":"' + renderLib.VENDOR.addons + '"'), 'a whole page gets the import map');
        assert.ok(own.includes('<script nonce="N2" type="module">') && !own.includes('guess'), 'a guessed nonce is replaced by ours');
    });

    await check('the render origin vendors three 0.170.0 for opaque-origin frames', async () => {
        const v = await t.get('/vendor/three.module.js');
        assert.strictEqual(v.status, 200);
        assert.ok(/javascript/.test(v.headers.get('content-type') || ''), v.headers.get('content-type'));
        assert.strictEqual(v.headers.get('access-control-allow-origin'), '*', 'a module script from an opaque origin is a CORS request');
        assert.strictEqual(v.headers.get('cross-origin-resource-policy'), 'cross-origin');
        assert.ok(v.text.includes("REVISION = '170'"), 'three r170');
        const a = await t.get('/vendor/three/addons/controls/OrbitControls.js');
        assert.strictEqual(a.status, 200, 'an addon');
        const bad = await t.get('/vendor/three/addons/../../package.json');
        assert.notStrictEqual(bad.status, 200, 'nothing outside examples/jsm');
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
        assert.strictEqual(renderLib.WRAPPER_SANDBOX, 'allow-scripts allow-same-origin', 'the wrapper keeps the render origin, so the model frame\'s frame-ancestors match');
        assert.ok(!renderLib.SANDBOX.includes('allow-same-origin'), 'the model output never keeps an origin');
        assert.ok(pair.slots[0].wrapper_url.startsWith(renderLib.RENDER_ORIGIN + '/render/w/'), 'the wrapper is on the render origin: ' + pair.slots[0].wrapper_url);
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

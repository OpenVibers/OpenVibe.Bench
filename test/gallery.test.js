'use strict';

/**
 * The gallery (stage B9): every round's outputs, filtered and ordered, with at most six live frames.
 */

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot({ env: { BENCH_ROUNDS_PER_DAY: '30', BENCH_ROUNDS_DAILY: '100' } });
    const alice = t.network.addUser('alice');
    const svc = t.network.serviceToken({ sub: 'svc:games', audience: 'openvibe.bench', cap: ['bench.entry.create'] });

    const make = async (kind, prompt, model, cost) => {
        const task = await t.get('/api/v1/kinds/' + kind + '/tasks', { as: alice, json: { prompt, public: true } });
        assert.strictEqual(task.status, 201, task.text);
        const rr = await t.get('/api/v1/tasks/' + task.json().task.id + '/rounds', { as: alice, json: {} });
        const roundId = rr.json().round.id;
        const e1 = await t.get('/api/v1/rounds/' + roundId + '/entries', { bearer: svc, json: { provider: 'acme', model, payload: { html: '<p>one</p>' }, cost_usd: cost } });
        const e2 = await t.get('/api/v1/rounds/' + roundId + '/entries', { bearer: svc, json: { provider: 'beta', model: model + '-b', payload: { html: '<p>two</p>' }, cost_usd: cost } });
        assert.strictEqual(e1.status, 201, e1.text);
        assert.strictEqual(e2.status, 201, e2.text);
        return roundId;
    };

    const rounds = [];
    for (let i = 0; i < 5; i++) rounds.push(await make('design.ui', 'A page, number ' + i, 'model-' + i, 0.01 * (i + 1)));
    const gameRound = await make('games.play', 'A game, one', 'gamer-1', 0.5);

    await check('the gallery lists the rounds', async () => {
        const r = await t.get('/gallery');
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(r.text.includes('data-gallery="1"'), 'the gallery');
        assert.ok(r.text.includes('A page, number 0'), 'a prompt');
        assert.ok(r.text.includes('ga-card'), 'the cards');
        assert.ok(r.text.includes('model-0'), 'the model of an entry');
    });

    await check('at most six frames are live, the rest wait for a tap', async () => {
        const r = await t.get('/gallery');
        const live = (r.text.match(/class="ga-frame"/g) || []).length;
        assert.ok(live <= 6, 'live frames: ' + live);
        assert.ok(live >= 4, 'the first cards are live: ' + live);
        assert.ok(r.text.includes('data-ga-still'), 'the stills');
        assert.ok(r.text.includes('Live frame, on tap'), 'the tap hint');
    });

    await check('the filters narrow the gallery', async () => {
        const byKind = await t.get('/gallery?kind=games.play');
        assert.ok(byKind.text.includes('A game, one'), 'the game is there');
        assert.ok(!byKind.text.includes('A page, number 0'), 'the pages are not');

        const byModel = await t.get('/gallery?model=model-2');
        assert.ok(byModel.text.includes('A page, number 2'), 'the model is there');
        assert.ok(!byModel.text.includes('A page, number 3'), 'the others are not');

        const byPrice = await t.get('/gallery?price=0.02');
        assert.ok(byPrice.text.includes('A page, number 0'), 'the cheap one is there');
        assert.ok(!byPrice.text.includes('A page, number 4'), 'the expensive one is not');
    });

    await check('the gallery orders by newest and by most voted', async () => {
        const newest = await t.get('/gallery?order=new');
        const votes = await t.get('/gallery?order=votes');
        assert.strictEqual(newest.status, 200);
        assert.strictEqual(votes.status, 200);
        const firstNewest = /data-round-id="([^"]+)"/.exec(newest.text)[1];
        const firstVotes = /data-round-id="([^"]+)"/.exec(votes.text)[1];
        assert.ok(firstNewest, 'a round in the newest order');
        assert.ok(firstVotes, 'a round in the most voted order');
        // The last round made is the newest; no votes yet, so the most-voted order falls back to the newest.
        assert.strictEqual(firstNewest, firstVotes, 'without votes both orders agree');
    });

    await check('the gallery API answers the same thing', async () => {
        const r = await t.get('/api/v1/gallery?kind=design.ui');
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(r.json().rounds.length >= 5, 'the rounds');
        assert.strictEqual(r.json().filters.kind, 'design.ui');
        const one = r.json().rounds[0];
        assert.ok(one.entries.length === 2, 'two entries');
        assert.ok(one.entries[0].wrapper_url.includes('/render/w/'), 'the sandboxed frame');
    });

    await check('an empty board says so, and offers a battle', async () => {
        const page = await t.get('/ratings');
        assert.strictEqual(page.status, 200, page.text);
        assert.ok(page.text.includes('No battles voted yet'), 'the empty board: ' + page.text.slice(0, 200));
        assert.ok(page.text.includes('Vote in a battle'), 'the button');
        assert.ok(page.text.includes('href="/battle"'), 'it goes to the battle');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

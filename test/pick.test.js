'use strict';

/**
 * The pick (B10): the frontier maths, the keyword parser, thin data greyed, and the page and the API answering the
 * same thing. No model is called anywhere in here, and nothing is charged.
 */

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { frontier } = require('../server/pick/frontier');
const { parsePick } = require('../server/pick/parser');
const { KINDS } = require('../server/kinds');

(async () => {
    await check('the frontier drops the models another model beats on score and on cost', () => {
        const rows = [
            { model: 'a', score: 90, cost: 0.02 },
            { model: 'b', score: 80, cost: 0.01 },
            { model: 'c', score: 95, cost: 0.05 },
            { model: 'd', score: 70, cost: 0.03 },
        ];
        // a beats d on score and on cost, so d is not on the frontier; b is cheaper than a, so it stays.
        assert.deepStrictEqual(frontier(rows).map((r) => r.model), ['a', 'b', 'c']);
    });

    await check('a tie keeps both models on the frontier', () => {
        const rows = [{ model: 'a', score: 90, cost: 0.02 }, { model: 'b', score: 90, cost: 0.02 }];
        assert.deepStrictEqual(frontier(rows).map((r) => r.model), ['a', 'b']);
    });

    await check('a model with no cost is never compared, and never dominates', () => {
        const rows = [{ model: 'a', score: 90, cost: 0.02 }, { model: 'b', score: 90, cost: null }];
        assert.deepStrictEqual(frontier(rows).map((r) => r.model), ['a']);
    });

    await check('the keyword parser reads the kind, the price and fast', () => {
        const p = parsePick('landing page under 2 cents, fast', { kinds: KINDS });
        assert.strictEqual(p.kind, 'design.page');
        assert.strictEqual(p.max_cost, 0.02);
        assert.strictEqual(p.fast, true);
    });

    await check('the keyword parser reads dollars, words and half a cent', () => {
        assert.strictEqual(parsePick('under $0.05', { kinds: KINDS }).max_cost, 0.05);
        assert.strictEqual(parsePick('ten cents', { kinds: KINDS }).max_cost, 0.1);
        assert.strictEqual(parsePick('half a cent', { kinds: KINDS }).max_cost, 0.005);
        assert.strictEqual(parsePick('two cents', { kinds: KINDS }).max_cost, 0.02);
    });

    await check('the keyword parser changes nothing when the words say nothing', () => {
        const p = parsePick('something nice please', { kinds: KINDS });
        assert.strictEqual(p.kind, null);
        assert.strictEqual(p.max_cost, null);
        assert.strictEqual(p.fast, false);
    });

    const t = await boot({ env: { BENCH_ROUNDS_PER_DAY: '100', BENCH_ROUNDS_DAILY: '1000' } });
    const alice = t.network.addUser('alice');
    const entrySvc = t.network.serviceToken({ sub: 'svc:room', audience: 'openvibe.bench', cap: ['bench.entry.create'] });
    const judgeSvc = t.network.serviceToken({ sub: 'svc:judge', audience: 'openvibe.bench', cap: ['bench.judgement.cast'] });

    // alpha-1 runs three times, beta-2 once: beta-2 is too thin to stand on.
    const rounds = [];
    for (let i = 0; i < 3; i++) {
        const task = await t.get('/api/v1/kinds/design.page/tasks', { as: alice, json: { prompt: 'A page ' + i, public: true } });
        const rr = await t.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { as: alice, json: {} });
        const id = rr.json().round.id;
        rounds.push(id);
        const a = await t.get(`/api/v1/rounds/${id}/entries`, { bearer: entrySvc, json: { provider: 'acme', model: 'alpha-1', payload: { html: '<h1>a</h1>' }, cost_usd: 0.01, ms: 1000 } });
        assert.strictEqual(a.status, 201, a.text);
        // beta-2 runs once only: fewer than three runs, so its numbers are too thin to stand on.
        if (i === 0) {
            const b = await t.get(`/api/v1/rounds/${id}/entries`, { bearer: entrySvc, json: { provider: 'beta', model: 'beta-2', payload: { html: '<h1>b</h1>' }, cost_usd: 0.02, ms: 4000 } });
            assert.strictEqual(b.status, 201, b.text);
            const j = await t.get(`/api/v1/rounds/${id}/judgements`, { bearer: judgeSvc, json: { judge: 'game_outcome', pair: { left: a.json().entry.id, right: b.json().entry.id }, outcome: 'left' } });
            assert.strictEqual(j.status, 201, j.text);
        }
    }

    await check('the pick page answers from the data, without JavaScript', async () => {
        const r = await t.get('/pick?kind=design.page');
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.ok(r.text.includes('method="get"'), 'the form is a GET');
        assert.ok(r.text.includes('pk-table'), 'the frontier table');
        assert.ok(r.text.includes('alpha-1'), 'the top model');
        assert.ok(r.text.includes('because no other model beats it'), 'why the top pick is first');
        assert.ok(r.text.includes('pk-card') || r.text.includes('pk-shot'), 'a sample output');
    });

    await check('a model with fewer than three runs is greyed and says so', async () => {
        const r = await t.get('/pick?kind=design.page');
        assert.ok(r.text.includes('beta-2'), 'the thin model is shown');
        assert.ok(r.text.includes('too few runs'), 'it says the data is thin');
        assert.ok(/class="pk-thin"/.test(r.text), 'and it is greyed');
    });

    await check('the API answers the same thing as the page', async () => {
        const api = await t.get('/api/v1/pick?kind=design.page');
        assert.strictEqual(api.status, 200, api.text.slice(0, 300));
        const json = api.json();
        assert.strictEqual(json.kind.id, 'design.page');
        assert.strictEqual(json.rows[0].model, 'alpha-1', 'the top pick');
        assert.ok(json.rows[0].cost_per_solved > 0, 'the cost a solved task');
        assert.ok(json.rows[0].median_ms > 0, 'the median time');
        assert.ok(json.rows[0].runs >= 3, 'the number of runs');
        assert.ok(json.why.includes('alpha-1'), 'the reason');
        assert.ok(json.also_ran.some((r) => r.model === 'beta-2' && r.thin), 'the thin model');
    });

    await check('the price control keeps the models over it out', async () => {
        const json = (await t.get('/api/v1/pick?kind=design.page&max_cost=0.005')).json();
        assert.strictEqual(json.rows.length, 0, 'nothing is under half a cent');
        const ok = (await t.get('/api/v1/pick?kind=design.page&max_cost=0.02')).json();
        assert.ok(ok.rows.some((r) => r.model === 'alpha-1'), 'alpha-1 is under two cents');
    });

    await check('fast takes its time cap from the run data', async () => {
        const json = (await t.get('/api/v1/pick?kind=design.page&fast=1')).json();
        assert.ok(json.filters.fast_cap_ms > 0, 'a cap from the run times');
        assert.ok(json.rows.every((r) => !r.median_ms || r.median_ms <= json.filters.fast_cap_ms), 'only the quick ones');
    });

    await check('the words set the controls, and the page says how it read them', async () => {
        const r = await t.get('/pick?q=' + encodeURIComponent('landing page under 2 cents, fast'));
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('design.page'), 'the kind it read');
        const json = (await t.get('/api/v1/pick?q=' + encodeURIComponent('landing page under 2 cents, fast'))).json();
        assert.strictEqual(json.controls.kind, 'design.page');
        assert.strictEqual(json.controls.max_cost, 0.02);
        assert.strictEqual(json.controls.fast, true);
        assert.ok(json.controls.notes.length >= 3, 'it says what it read');
    });

    await check('a kind with nothing in it says so, and invents nothing', async () => {
        const r = await t.get('/pick?kind=games.three');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Nothing to pick yet'), 'the empty answer');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

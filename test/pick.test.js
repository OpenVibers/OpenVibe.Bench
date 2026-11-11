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
const { compareRuns: compareVersionRuns } = require('../server/bench/version-diff');
const { estimateExchangeTask } = require('../server/pick/pick');

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

    await check('Exchange task prices use explicit input and output token budgets', () => {
        assert.strictEqual(estimateExchangeTask({ price: { in: 2, out: 4 } }, 2000, 1000), 0.008);
        assert.strictEqual(estimateExchangeTask({ price: { in: 2 } }, 2000, 1000), null);
    });

    await check('the version diff pairs identical tasks and reports a seeded confidence interval', () => {
        const baseline = { id: 'old', model: 'model@1', benchmark: 'bench@1', tasks: [
            { task_id: 'a', score: 0.5 }, { task_id: 'b', score: 0.6 }, { task_id: 'held', score: 1, held_out: true },
        ] };
        const candidate = { id: 'new', model: 'model@2', benchmark: 'bench@1', tasks: [
            { task_id: 'a', score: 0.7 }, { task_id: 'b', score: 0.6 }, { task_id: 'c', score: 0.9 },
        ] };
        const out = compareVersionRuns(baseline, candidate, { iterations: 1000 });
        assert.strictEqual(out.paired_tasks, 2, 'only common public task ids are paired');
        assert.deepStrictEqual(out.changes, { better: 1, worse: 0, unchanged: 1 });
        assert.deepStrictEqual(out.ci95, compareVersionRuns(baseline, candidate, { iterations: 1000 }).ci95, 'bootstrap is reproducible');
        assert.ok(out.ci95.lower <= out.mean_delta && out.ci95.upper >= out.mean_delta);
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

    await check('the quality floor returns only models that clear the requested score', async () => {
        const json = (await t.get('/api/v1/pick?kind=design.page&min_score=99')).json();
        assert.strictEqual(json.filters.min_score, 99);
        assert.ok(json.rows.every((r) => r.score >= 99), 'every pick clears the quality floor');
    });

    await check('the cheapest qualifying hosted offer is selected using current Exchange prices', async () => {
        const oldMarket = t.ctx.ai.market;
        t.ctx.ai.market = async () => ({ offers: [{
            model: 'alpha-1', provider: 'acme', provider_model: 'alpha-1', price: { in: 2, out: 4 }, checked_at: '2026-11-10',
        }] });
        const json = (await t.get('/api/v1/pick?kind=design.page&min_score=0&input_tokens=2000&output_tokens=1000')).json();
        t.ctx.ai.market = oldMarket;
        assert.strictEqual(json.cheapest_that_clears_quality_bar.model, 'alpha-1');
        assert.strictEqual(json.cheapest_that_clears_quality_bar.cost_usd, 0.008);
        assert.deepStrictEqual(json.price_assumptions, { input_tokens: 2000, output_tokens: 1000, exchange_price_unit: 'USD per million tokens' });
    });

    await check('fast takes its time cap from the run data', async () => {
        const json = (await t.get('/api/v1/pick?kind=design.page&fast=1')).json();
        assert.ok(json.filters.fast_cap_ms > 0, 'a cap from the run times');
        assert.ok(json.rows.every((r) => !r.median_ms || r.median_ms <= json.filters.fast_cap_ms), 'only the quick ones');
    });

    await check('the words set the controls, and the API says how it read them', async () => {
        const json = (await t.get('/api/v1/pick?q=' + encodeURIComponent('landing page under 2 cents, fast'))).json();
        assert.strictEqual(json.controls.kind, 'design.page');
        assert.strictEqual(json.controls.max_cost, 0.02);
        assert.strictEqual(json.controls.fast, true);
        assert.ok(json.controls.notes.length >= 3, 'it says what it read');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

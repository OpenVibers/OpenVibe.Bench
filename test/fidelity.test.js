'use strict';

// Provider fidelity (stage B5): the fixed objective set, the dry-run budget, one bounded pass through
// AI's generate path with a durable idempotency key per prompt, and the public read OpenVibe.AI attaches
// to an offer. The fake AI serves the market fixture and answers each prompt; no test reaches the network.
process.env.BENCH_ADMIN_TOKEN = process.env.BENCH_ADMIN_TOKEN || 'op-secret';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { OBJECTIVE_SET, ITEMS, check: checkItem } = require('../server/bench/fidelity-set');
const { createFidelity, wilson, weekOf, estimateItem } = require('../server/bench/fidelity');

const MARKET = {
    $schema: 'exchange.market@1',
    offers: [
        { model: 'acme/alpha-1', provider: 'acme', provider_model: 'acme/alpha-1', kind: 'chat', open_weights: true, routed: true, price: { in: 100, out: 200 } },
        { model: 'acme/alpha-1', provider: 'beta', provider_model: 'beta/alpha-1', kind: 'chat', open_weights: true, routed: true, price: { in: 100, out: 200 } },
        { model: 'acme/alpha-1', provider: 'gamma', provider_model: 'gamma/alpha-1', kind: 'chat', open_weights: true, routed: false, price: { in: 100, out: 200 } },
        { model: 'acme/closed-1', provider: 'acme', provider_model: 'acme/closed-1', kind: 'chat', open_weights: false, routed: true, price: { in: 100, out: 200 } },
        { model: 'acme/unpriced-1', provider: 'acme', provider_model: 'acme/unpriced-1', kind: 'chat', open_weights: true, routed: true, price: { in: null, out: null } },
    ],
};

function answer(body) {
    const prompt = String(body.prompt || '');
    if (prompt.startsWith('What is 37')) return '888';
    if (prompt.startsWith('Read this line')) return 'fra1';
    if (prompt.startsWith('Return exactly this JSON')) return '{"ok": true, "n": 3}';
    if (prompt.startsWith('Write the word aurora')) return 'aurora aurora aurora aurora';
    if (prompt.startsWith('Spell the word')) return 'desserts';
    if (prompt.startsWith('How many times')) return '4';
    if (prompt.startsWith('What is the chemical symbol')) return 'Au';
    if (prompt.startsWith('If today is Wednesday')) return 'Saturday';
    if (prompt.startsWith('Read the note')) return 'ORBIT-71';
    if (prompt.startsWith('Reply with exactly')) return 'READY';
    return 'unknown';
}

(async () => {
    let t;
    try {
        t = await boot({
            aiOptions: {
                models: [
                    { provider: 'acme', model: 'acme/alpha-1' },
                    { provider: 'beta', model: 'beta/alpha-1' },
                ],
                market: MARKET,
                // beta is a different quantization of the same model: it answers only three items right.
                textFor: (body, pick) => {
                    const right = answer(body);
                    if (pick.provider === 'beta') {
                        const prompt = String(body.prompt || '');
                        if (prompt.startsWith('What is 37')) return 'not a number';
                        if (prompt.startsWith('Read this line')) return 'fra1';
                        if (prompt.startsWith('What is the chemical symbol')) return 'Au';
                        if (prompt.startsWith('Reply with exactly')) return 'READY';
                        return 'unknown';
                    }
                    return right;
                },
            },
            env: {
                BENCH_FIDELITY: '1',
                BENCH_FIDELITY_IN_DRILL: '1',
                BENCH_FIDELITY_DAILY_CAP_USD: '1.00',
                BENCH_FIDELITY_MAX_CALLS: '30',
                BENCH_FIDELITY_MIN_ANSWERED: '3',
            },
        });

        await check('the objective set has one deterministic check per item and a version', () => {
            assert.strictEqual(OBJECTIVE_SET, 'fidelity-2026-11-09.v1');
            assert(ITEMS.length >= 8);
            assert.strictEqual(new Set(ITEMS.map((i) => i.id)).size, ITEMS.length, 'item ids are unique');
            assert(checkItem(ITEMS.find((i) => i.id === 'arithmetic'), '```\n888\n```').passed);
            assert(checkItem(ITEMS.find((i) => i.id === 'json'), '{"ok":true,"n":3}').passed);
            assert(!checkItem(ITEMS.find((i) => i.id === 'arithmetic'), 'the answer is 888').passed);
        });

        await check('the fidelity interval is a Wilson score interval', () => {
            const perfect = wilson(10, 10);
            assert.strictEqual(perfect.upper, 1);
            assert(perfect.lower > 0.6 && perfect.lower < 1);
            const none = wilson(0, 10);
            assert.strictEqual(none.lower, 0);
            assert(none.upper > 0 && none.upper < 0.4);
            assert.deepStrictEqual(wilson(0, 0), { lower: null, upper: null });
        });

        await check('the call estimate comes from the offer price and the item text', () => {
            const item = ITEMS.find((i) => i.id === 'arithmetic');
            const cost = estimateItem(item, { in: 100, out: 200 });
            assert(cost > 0 && cost < 1);
            assert.strictEqual(estimateItem(item, { in: null, out: 200 }), null);
            assert.strictEqual(weekOf(Date.parse('2026-11-11T12:00:00Z')).key, '2026-11-09');
        });

        await check('open weights, routed and priced only; the dry run lists every call', async () => {
            const r = await t.get('/api/v1/fidelity/plan', { method: 'POST', bearer: 'op-secret', json: {} });
            assert.strictEqual(r.status, 200, r.text);
            const plan = r.json();
            assert.strictEqual(plan.objective_set, OBJECTIVE_SET);
            assert.strictEqual(plan.offers.filter((o) => o.included).length, 2, 'the two enabled providers of the open-weight model');
            assert.strictEqual(plan.calls, ITEMS.length * 2);
            assert(plan.estimated_usd > 0);
            assert(plan.daily.cap_usd === 1);
            const unpriced = plan.offers.find((o) => o.provider_model === 'acme/unpriced-1');
            assert(unpriced && unpriced.included === false && /price/.test(unpriced.reason), 'an offer without a price is skipped, not guessed');
            assert(!/closed-1|gamma/.test(r.text), 'closed and unrouted offers are out');
            assert.strictEqual(t.ai.requests.filter((x) => x.path === '/api/v1/generate').length, 0, 'a dry run spends nothing');
        });

        await check('a pass answers every item through AI and scores each offer', async () => {
            const r = await t.get('/api/v1/fidelity/run', { method: 'POST', bearer: 'op-secret', json: {} });
            assert.strictEqual(r.status, 201, r.text);
            const out = r.json();
            assert.strictEqual(out.ran.length, 2);
            const acme = out.ran.find((o) => o.provider === 'acme');
            const beta = out.ran.find((o) => o.provider === 'beta');
            assert.strictEqual(acme.score, 1);
            assert.strictEqual(acme.n, ITEMS.length);
            assert.strictEqual(beta.score, 0.3);
            assert.strictEqual(beta.passed, 3);
            const generated = t.ai.requests.filter((x) => x.path === '/api/v1/generate');
            assert.strictEqual(generated.length, ITEMS.length * 2);
            assert(generated.every((x) => /^fid_[a-f0-9]{40}$/.test(x.body.idempotency_key)), 'every prompt has a durable key');
            assert(generated.every((x) => x.body.route && x.body.route.model && x.body.route.provider), 'every call is pinned to the exact offer');
            assert(generated.every((x) => x.body.temperature === 0), 'the objective set is not sampled');
        });

        await check('the public read puts score, n, interval and compared_to beside every offer', async () => {
            const r = await t.get('/api/v1/fidelity');
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
            const body = r.json();
            assert.strictEqual(body.$schema, 'exchange.fidelity@1');
            assert.strictEqual(body.offers.length, 2);
            assert.strictEqual(body.measured_on, new Date(t.ctx.s.now()).toISOString().slice(0, 10));
            for (const offer of body.offers) {
                assert.strictEqual(offer.compared_to, 'acme/alpha-1');
                assert(Number.isFinite(offer.score));
                assert.strictEqual(offer.n, ITEMS.length);
                assert(offer.interval.lower <= offer.score && offer.score <= offer.interval.upper);
                assert(offer.measured_at);
            }
            const meta = await t.get('/api/v1/fidelity/objective-set');
            assert.strictEqual(meta.status, 200);
            assert.strictEqual(meta.json().prompts.length, ITEMS.length);
        });

        await check('the operator token is required and the status names the last pass', async () => {
            assert.strictEqual((await t.get('/api/v1/fidelity/plan', { method: 'POST', json: {} })).status, 403);
            assert.strictEqual((await t.get('/api/v1/fidelity/run', { method: 'POST', bearer: 'wrong', json: {} })).status, 403);
            const status = await t.get('/api/v1/fidelity/status', { bearer: 'op-secret' });
            assert.strictEqual(status.status, 200);
            assert.strictEqual(status.json().state.last_status, 'ok');
        });

        await check('the pass is off unless the owner turns it on', async () => {
            const off = createFidelity({
                s: { db: { prepare: () => ({ get: async () => null, all: async () => [], run: async () => null }) }, now: () => Date.now(), iso: (v) => String(v), newId: () => 'fid_test' },
                ai: { market: async () => MARKET },
                config: { bench: { fidelity: { enabled: false, dailyCapUsd: 1 } } },
            });
            await assert.rejects(() => off.run(), (err) => err.code === 'fidelity.disabled' && err.status === 503);
            const plan = await off.plan();
            assert.strictEqual(plan.enabled, false);
        });
    } finally {
        if (t) await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

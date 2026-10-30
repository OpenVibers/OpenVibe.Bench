'use strict';

/**
 * The model watch (B10): the triggers, the once-a-day cap, the account data, and the notice that reaches the Network.
 */

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createWatches, mayNotify } = require('../server/watch/watch');
const { TABLES } = require('../server/identity/account-data');
const { uncovered } = require('openvibe-sdk/account-data');

const stub = { s: { db: null }, config: {}, log: { warn() {} } };

(async () => {
    await check('a score that moves by more than its own interval is worth a notice', () => {
        const w = createWatches(stub);
        const notice = w.noticeFor(
            { subject: 'usr_1', benchmark_id: 'bmk_1', model: 'alpha', benchmark_title: 'Playable games' },
            [{ model: 'alpha', rating: 1100, lower: 1060, upper: 1140 }],
            new Map(),
            new Map([['alpha', { rating: 1000 }]]),
            []);
        assert.ok(notice, 'a notice');
        assert.strictEqual(notice.kind, 'move');
        assert.ok(notice.message.includes('Playable games'), 'the benchmark is named');
        assert.ok(notice.message.includes('alpha'), 'the model is named');
        assert.ok(notice.message.includes('1000') && notice.message.includes('1100'), 'the numbers are there');
    });

    await check('a move inside the interval is not worth a notice', () => {
        const w = createWatches(stub);
        const notice = w.noticeFor(
            { subject: 'usr_1', benchmark_id: 'bmk_1', model: 'alpha', benchmark_title: 'Playable games' },
            [{ model: 'alpha', rating: 1010, lower: 990, upper: 1030 }],
            new Map(),
            new Map([['alpha', { rating: 1000 }]]),
            []);
        assert.strictEqual(notice, null, 'no notice');
    });

    await check('a model that overtakes another one is worth a notice', () => {
        const w = createWatches(stub);
        const notice = w.noticeFor(
            { subject: 'usr_1', benchmark_id: 'bmk_1', model: 'alpha', benchmark_title: 'Playable games' },
            [
                { model: 'alpha', rating: 1000, lower: 980, upper: 1020 },
                { model: 'beta', rating: 1100, lower: 1050, upper: 1150 },
            ],
            new Map(),
            new Map(),
            []);
        assert.ok(notice, 'a notice');
        assert.strictEqual(notice.kind, 'overtake');
        assert.ok(notice.message.includes('alpha') && notice.message.includes('beta'), 'both models are named');
        assert.ok(notice.message.includes('Playable games'), 'the benchmark is named');
        assert.ok(/\d/.test(notice.message), 'the numbers are there');
    });

    await check('a model the person already follows does not count as an overtake', () => {
        const w = createWatches(stub);
        const notice = w.noticeFor(
            { subject: 'usr_1', benchmark_id: 'bmk_1', model: 'alpha', benchmark_title: 'Playable games' },
            [
                { model: 'alpha', rating: 1000, lower: 980, upper: 1020 },
                { model: 'beta', rating: 1100, lower: 1050, upper: 1150 },
            ],
            new Map(),
            new Map(),
            [{ subject: 'usr_1', benchmark_id: 'bmk_1', model: 'beta' }]);
        assert.strictEqual(notice, null, 'no notice');
    });

    await check('one notice per watch per day', () => {
        assert.strictEqual(mayNotify({ last_notified_at: null }, '2026-10-30T12:00:00Z'), true);
        assert.strictEqual(mayNotify({ last_notified_at: '2026-10-30T10:00:00Z' }, '2026-10-30T12:00:00Z'), false);
        assert.strictEqual(mayNotify({ last_notified_at: '2026-10-29T23:00:00Z' }, '2026-10-30T12:00:00Z'), true);
    });

    const t = await boot();
    const alice = t.network.addUser('alice');

    const list = (await t.get('/api/v1/benchmarks')).json();
    const benchmarks = list.benchmarks || list;
    const benchmark = benchmarks[0];
    assert.ok(benchmark && benchmark.id, 'a seeded benchmark: ' + JSON.stringify(list).slice(0, 200));

    await check('the watches go into the account data and are deleted with the person', async () => {
        const row = TABLES.find((x) => x.table === 'bench_watches');
        assert.ok(row, 'bench_watches is in the account data');
        assert.strictEqual(row.subject, 'subject');
        assert.strictEqual(row.erase, 'delete');
        const left = await uncovered(t.ctx.s.db, { tables: TABLES });
        assert.ok(!left.includes('bench_watches'), 'the watches are covered: ' + JSON.stringify(left));
    });

    await check('a signed-in person may follow a benchmark, and may stop', async () => {
        const r = await t.get('/watch/follow', { as: alice, method: 'POST', json: { benchmark_id: benchmark.id, back: '/watching' } });
        assert.strictEqual(r.status, 303, r.text);
        const page = await t.get('/watching', { as: alice });
        assert.strictEqual(page.status, 200, page.text.slice(0, 200));
        assert.ok(page.text.includes(benchmark.title), 'the benchmark is listed');
        assert.ok(page.text.includes('action="/watch/unfollow"'), 'an unfollow button');
        const id = /name="id" value="([^"]+)"/.exec(page.text)[1];
        const un = await t.get('/watch/unfollow', { as: alice, method: 'POST', json: { id, back: '/watching' } });
        assert.strictEqual(un.status, 303);
        const after = await t.get('/watching', { as: alice });
        assert.ok(!after.text.includes(benchmark.title), 'the watch is gone');
    });

    await check('an anonymous visitor cannot follow anything', async () => {
        const r = await t.get('/watch/follow', { method: 'POST', origin: t.config.baseUrl, json: { benchmark_id: benchmark.id } });
        assert.strictEqual(r.status, 401, r.text);
    });

    await check('the notice reaches the Network, naming the benchmark and the numbers', async () => {
        const out = await t.ctx.watches.follow({ subject: alice.subject, benchmarkId: benchmark.id, userId: alice.id });
        assert.ok(out.ok, out.error);
        const pushed = await t.ctx.watches.notify(out.watch, {
            title: 'Bench: ' + benchmark.title,
            message: benchmark.title + ': beta (1100, 1050-1150) is now fully above alpha (1000, 980-1020).',
        });
        assert.strictEqual(pushed.sent, true, JSON.stringify(pushed));
        const last = t.network.pushes[t.network.pushes.length - 1];
        assert.ok(last, 'the Network was called');
        assert.strictEqual(last.type, 'WATCH_TRIGGERED');
        assert.ok(last.message.includes(benchmark.title), 'the benchmark is named');
        assert.ok(last.message.includes('alpha') && last.message.includes('beta'), 'both models are named');
        assert.ok(last.message.includes('1100'), 'the numbers are there');
        assert.strictEqual(last.user_id, alice.id, 'it goes to the person');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';

/**
 * The daily rounds (plan L51, step 2): one round per design kind per day, on Bench's own budget.
 */

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { DAILY_KIND_IDS, DAILY_PROMPTS } = require('../server/bench/daily-prompts');

const CLOCK = Date.parse('2026-11-01T09:00:00.000Z');
const clock = () => CLOCK;

(async () => {
    await check('the job is off until the owner turns it on, and never starts under the drill', async () => {
        const off = await boot();
        assert.strictEqual(off.ctx.daily.start(), null, 'off without BENCH_DAILY_ROUNDS');
        await off.close();

        const drill = await boot({ env: { BENCH_DAILY_ROUNDS: '1' } });
        assert.strictEqual(drill.ctx.daily.start(), null, 'off under BENCH_DRILL');
        await drill.close();
    });

    const t = await boot({
        now: clock,
        env: {
            BENCH_DAILY_ROUNDS: '1',
            BENCH_DAILY_ROUNDS_IN_DRILL: '1',
            BENCH_DAILY_ROUNDS_HOUR_UTC: '8',
            BENCH_DAILY_BUDGET_USD: '1.00',
            BENCH_DAILY_ROUND_ESTIMATE_USD: '0.05',
        },
    });

    await check('the curated list has about twenty prompts for each of the nine design kinds', async () => {
        assert.strictEqual(DAILY_KIND_IDS.length, 9, 'nine design kinds');
        for (const kind of DAILY_KIND_IDS) {
            assert.ok(DAILY_PROMPTS[kind].length >= 18, kind + ' has about twenty prompts: ' + DAILY_PROMPTS[kind].length);
            for (const prompt of DAILY_PROMPTS[kind]) {
                assert.ok(prompt.length >= 20, kind + ': a prompt is a brief');
                assert.ok(!/\b(he|she|his|her)\b/i.test(prompt), kind + ': no people in the brief');
            }
        }
    });

    let summary = null;

    await check('one round per design kind, from the curated prompts, with two models of the pool', async () => {
        summary = await t.ctx.daily.runDay({ now: CLOCK });
        assert.strictEqual(summary.created, 9, 'nine rounds: ' + JSON.stringify(summary.rounds));
        assert.strictEqual(summary.skipped, 0);

        const rows = await t.ctx.s.db.many('SELECT * FROM bench_daily_rounds ORDER BY kind_id');
        assert.strictEqual(rows.length, 9, 'one row per kind');
        for (const row of rows) {
            assert.strictEqual(row.status, 'created');
            assert.strictEqual(row.day, '2026-11-01');
            assert.ok(DAILY_PROMPTS[row.kind_id].includes(row.prompt), 'the prompt is one of the curated ones: ' + row.prompt);
            const models = Array.isArray(row.models) ? row.models : JSON.parse(row.models);
            assert.strictEqual(models.length, 2, 'two models: ' + JSON.stringify(models));
            assert.notStrictEqual(models[0].provider, models[1].provider, 'two different models: ' + JSON.stringify(models));
            const round = await t.ctx.s.db.maybe('SELECT * FROM bench_rounds WHERE id = $1', [row.round_id]);
            assert.ok(round, 'the round exists');
            assert.strictEqual(round.kind_id, row.kind_id);
            assert.strictEqual(round.created_by, 'service:bench-daily', 'the daily rounds belong to Bench');
        }
        // The prompt of a kind is the same all day, and comes from the curated list.
        assert.strictEqual(t.ctx.daily.promptFor('design.ui', '2026-11-01'), t.ctx.daily.promptFor('design.ui', '2026-11-01'));
    });

    await check('the same day never makes a second round of a kind', async () => {
        const again = await t.ctx.daily.runDay({ now: CLOCK });
        assert.strictEqual(again.created, 0, 'nothing new: ' + JSON.stringify(again.rounds));
        const rows = await t.ctx.s.db.many('SELECT COUNT(*)::int AS n FROM bench_daily_rounds');
        assert.strictEqual(rows[0].n, 9);
    });

    await check('the rounds are real rounds: two entries each, and something to judge', async () => {
        // The worker takes one queued round per pass, and there are nine of them.
        for (let i = 0; i < 12; i++) await t.tick();
        const rounds = await t.ctx.s.db.many("SELECT id, status FROM bench_rounds WHERE created_by = 'service:bench-daily'");
        assert.strictEqual(rounds.length, 9);
        for (const round of rounds) {
            assert.strictEqual(round.status, 'finished', 'the round is ready to judge');
        }
        const next = await t.get('/api/v1/judgements/next?kind=design.ui');
        assert.strictEqual(next.status, 200, next.text);
        assert.ok(next.json().left && next.json().right, 'there is something to judge');
        assert.strictEqual(next.json().left.model, undefined, 'the pair is blind');
    });

    await check('what the day spent is written down', async () => {
        await t.ctx.daily.settle('2026-11-01');
        const rows = await t.ctx.s.db.many('SELECT kind_id, estimated_usd, spent_usd FROM bench_daily_rounds ORDER BY kind_id');
        let spent = 0;
        for (const row of rows) {
            assert.ok(Number(row.spent_usd) > 0, row.kind_id + ': what it spent');
            spent += Number(row.spent_usd);
        }
        assert.ok(spent > 0, 'the day spent something');
        const state = await t.ctx.daily.budgetState('2026-11-01');
        assert.ok(Math.abs(state.spent - spent) < 1e-6, 'the budget state knows what was spent');
    });

    await check('stop', async () => { await t.close(); });

    // ── The budget ───────────────────────────────────────────────────────────
    const lean = await boot({
        now: clock,
        env: {
            BENCH_DAILY_ROUNDS: '1',
            BENCH_DAILY_BUDGET_USD: '0.001',
            BENCH_DAILY_ROUND_ESTIMATE_USD: '0.05',
        },
    });

    await check('a kind is skipped when the day\'s budget is spent', async () => {
        const out = await lean.ctx.daily.runDay({ now: CLOCK });
        assert.strictEqual(out.created, 0, 'nothing was made: ' + JSON.stringify(out.rounds));
        assert.strictEqual(out.skipped, 9);
        const rows = await lean.ctx.s.db.many('SELECT kind_id, status, skip_reason FROM bench_daily_rounds');
        assert.strictEqual(rows.length, 9);
        for (const row of rows) {
            assert.strictEqual(row.status, 'skipped');
            assert.strictEqual(row.skip_reason, 'budget', 'why it was skipped: ' + row.kind_id);
        }
        const rounds = await lean.ctx.s.db.many('SELECT COUNT(*)::int AS n FROM bench_rounds');
        assert.strictEqual(rounds[0].n, 0, 'no round was made');
    });

    await check('stop', async () => { await lean.close(); });

    done();
})();

'use strict';

/**
 * The 18+ board (stage B4): the chat.willing kind, the board API marked adult, the willingness rows
 * with n and intervals, the abliteration tax pairs, and the honest empty state when OpenVibe.AI's
 * measurements cannot be read. The fake AI serves fixed fixtures; no live call is made.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { mapRows, mapTax } = require('../server/bench/willing');

(async () => {
    await check('missing measurements remain null while measured zero remains zero', async () => {
        const row = mapRows({ rows: [{ model: 'x', refusal_ci: { lower: null, upper: null }, hedge_ci: { lower: '', upper: 1 } }] })[0];
        assert.strictEqual(row.n, null);
        assert.strictEqual(row.refusals, null);
        assert.strictEqual(row.hedges, null);
        assert.strictEqual(row.refusal_ci, null);
        assert.strictEqual(row.hedge_ci, null);
        const pair = mapTax({ rows: [{ base: {}, abliterated: {}, ci: { lower: null, upper: 0.2 } }] }).pairs[0];
        assert.strictEqual(pair.base.n, null);
        assert.strictEqual(pair.abliterated.passed, null);
        assert.strictEqual(pair.ci, null);
        const zero = mapRows({ rows: [{ n: 20, refusals: 0, hedges: 0, refusal_rate: 0, refusal_ci: { lower: 0, upper: 0.2 } }] })[0];
        assert.strictEqual(zero.refusals, 0);
        assert.strictEqual(zero.refusal_rate, 0);
        assert.deepStrictEqual(zero.refusal_ci, { lower: 0, upper: 0.2 });
    });
    const t = await boot();
    await check('the chat.willing kind is seeded with its published prompt set metadata', async () => {
        const r = await t.get('/api/v1/kinds');
        assert.strictEqual(r.status, 200, r.text);
        const kind = r.json().kinds.find((k) => k.id === 'chat.willing');
        assert.ok(kind, 'chat.willing is listed');
        assert.strictEqual(kind.schema.adult, true);
        assert.strictEqual(kind.schema.prompt_set, 'willing-2026-11-09.v1');
        assert.ok(String(kind.schema.prompt_set_url).startsWith('https://'));
        assert.ok(kind.schema.policy.floor.includes('floor.js'));
        assert.deepStrictEqual(kind.metrics, ['refusal_rate', 'hedge_rate', 'n']);
    });

    await check('the general home and benchmark selectors omit the adult measurement kind', async () => {
        for (const path of ['/', '/benchmarks/new']) {
            const r = await t.get(path);
            assert.ok(!r.text.includes('Willingness to answer (18+)'), path);
            assert.ok(!r.text.includes('value="chat.willing"'), path);
        }
    });

    await check('the default chat.willing board is the willingness board, marked adult', async () => {
        const r = await t.get('/api/v1/boards/chat.willing');
        assert.strictEqual(r.status, 200, r.text);
        const board = r.json().board;
        assert.strictEqual(board.type, 'willing');
        assert.strictEqual(board.adult, true);
        assert.strictEqual(board.kind_id, 'chat.willing');
        assert.strictEqual(board.prompt_set, 'willing-2026-11-09.v1');
        assert.strictEqual(board.prompts, 60);
        assert.strictEqual(board.rows.length, 1);
        const row = board.rows[0];
        assert.strictEqual(row.subject, 'alpha-1');
        assert.strictEqual(row.provider, 'acme');
        assert.strictEqual(row.n, 60);
        assert.strictEqual(row.refusal_rate, 0.1);
        assert.strictEqual(row.hedge_rate, 0.033333);
        assert.ok(row.refusal_ci.lower < row.refusal_rate && row.refusal_rate < row.refusal_ci.upper);
        assert.strictEqual(row.adult, true);
        assert.strictEqual(board.abliteration.pairs.length, 1);
        const pair = board.abliteration.pairs[0];
        assert.strictEqual(pair.pair_id, 'llama-3.1-8b-instruct');
        assert.strictEqual(pair.difference, -0.15);
        assert.ok(pair.ci.lower < pair.difference && pair.difference < pair.ci.upper);
        assert.ok(String(pair.source).startsWith('https://'));
        assert.strictEqual(pair.adult, true);
    });

    await check('a non-adult board still says adult: false', async () => {
        const r = await t.get('/api/v1/boards/design.page');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().board.adult, false);
        assert.strictEqual(r.json().board.type, 'elo');
    });

    await check('the 18+ board refuses a non-willingness type instead of showing a fake rating', async () => {
        const r = await t.get('/api/v1/boards/chat.willing?type=elo');
        assert.strictEqual(r.status, 422, r.text);
        assert.strictEqual(r.json().code, 'bench.board_type_unsupported');
    });

    await check('an explicit type=willing works too', async () => {
        const r = await t.get('/api/v1/boards/chat.willing?type=willing');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().board.type, 'willing');
    });

    await t.close();

    const unavailable = await boot({ aiOptions: { willingnessStatus: 503 } });
    try {
        await check('when AI cannot answer, the board keeps adult: true and invents no rows', async () => {
            const r = await unavailable.get('/api/v1/boards/chat.willing');
            assert.strictEqual(r.status, 200, r.text);
            const board = r.json().board;
            assert.strictEqual(board.adult, true);
            assert.strictEqual(board.unavailable, true);
            assert.deepStrictEqual(board.rows, []);
            assert.deepStrictEqual(board.abliteration.pairs, []);
            assert.ok(board.note);
        });
    } finally { await unavailable.close(); }

    done();
})();

'use strict';

/**
 * The matchmaker for Bench's pairwise votes (plan §V.2, item 11b).
 *
 * The maths is on purpose synthetic: a tight, lopsided pair has to lose to a wide, overlapping one, a model the
 * board has never rated has to be asked before the models the board is sure of, two models of one family must not
 * meet while another family is in the round (but must when nothing else is there), and both sides have to come up
 * about half the time. Then the same matchmaker, on a real database, has to give a person a pair they have not seen,
 * never a round of their own, and it has to record the order it showed.
 */

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { choosePair, familyOf, pairScore, statsOf, referenceOf } = require('../server/bench/matchmaker');
const { pairKey } = require('../server/bench/battles');
const { seededRandom } = require('../server/rating/style');

/** A board: model -> the controlled rating, the interval around it and the games behind it. */
const BOARD = {
    'gpt-4o': { rating: 1600, ci_lower: 1590, ci_upper: 1610, games: 120 },
    'claude-3-5-sonnet': { rating: 1000, ci_lower: 990, ci_upper: 1010, games: 120 },
    'gemini-2-5-pro': { rating: 1200, ci_lower: 1000, ci_upper: 1400, games: 90 },
    'deepseek-v3': { rating: 1180, ci_lower: 980, ci_upper: 1380, games: 90 },
};

/** The board as a Map, the way the matchmaker reads the rows of it. */
const boardMap = (board) => new Map(Object.entries(board));

/** A round of two entries, as the matchmaker is given them. */
const round = (id, models, kindId = 'design.ui') => ({
    round_id: id,
    kind_id: kindId,
    entries: models.map((model, i) => ({ id: id + '-e' + (i + 1), model })),
});

(async () => {
    await check('a tight, lopsided pair loses to a wide, overlapping one', async () => {
        const candidates = [
            round('r1', ['gpt-4o', 'claude-3-5-sonnet']),          // 600 points apart, 20 wide each
            round('r2', ['gemini-2-5-pro', 'deepseek-v3']),        // 20 points apart, 400 wide each
        ];
        const choice = choosePair({ candidates, board: BOARD, random: () => 0.5 });
        assert.ok(choice, 'a pair is chosen');
        assert.strictEqual(choice.round_id, 'r2', 'the pair the board knows least about wins');
        assert.strictEqual(choice.a.model, 'gemini-2-5-pro');
        assert.strictEqual(choice.b.model, 'deepseek-v3');
        assert.ok(choice.score > 100, 'a wide, close pair is worth a lot: ' + choice.score);
    });

    await check('a model the board has never rated is asked before two it is sure of', async () => {
        const board = {
            'gpt-4o': { rating: 1500, ci_lower: 1490, ci_upper: 1510, games: 120 },
            'claude-3-5-sonnet': { rating: 1200, ci_lower: 1190, ci_upper: 1210, games: 120 },
        };
        const candidates = [
            round('r1', ['gpt-4o', 'claude-3-5-sonnet']),          // both known
            round('r2', ['llama-4-70b', 'claude-3-5-sonnet']),      // llama-4-70b is not on the board
        ];
        const choice = choosePair({ candidates, board, random: () => 0.5 });
        assert.ok(choice, 'a pair is chosen');
        assert.strictEqual(choice.round_id, 'r2', 'the new entrant is asked first');
        assert.strictEqual(choice.a.model, 'llama-4-70b');
    });

    await check('a model with too few games counts as unknown', async () => {
        const board = {
            'gpt-4o': { rating: 1500, ci_lower: 1490, ci_upper: 1510, games: 120 },
            'claude-3-5-sonnet': { rating: 1200, ci_lower: 1190, ci_upper: 1210, games: 3 },
        };
        const candidates = [
            round('r1', ['gpt-4o', 'claude-3-5-sonnet']),
            round('r2', ['llama-4-70b', 'claude-3-5-sonnet']),
        ];
        const choice = choosePair({ candidates, board, random: () => 0.5 });
        assert.strictEqual(choice.round_id, 'r2', 'three games are not a rating: ' + choice.round_id);
    });

    await check('two models of one family do not meet while another family is in the round', async () => {
        const board = {
            'gpt-4o': { rating: 1200, ci_lower: 1190, ci_upper: 1210, games: 100 },
            'gpt-4o-mini': { rating: 1190, ci_lower: 1180, ci_upper: 1200, games: 100 },
            'claude-3-5-sonnet': { rating: 1000, ci_lower: 990, ci_upper: 1010, games: 100 },
        };
        const choice = choosePair({
            candidates: [round('r1', ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet'])],
            board,
            random: () => 0.5,
        });
        assert.ok(choice, 'a pair is chosen');
        const pair = [choice.a.model, choice.b.model].sort();
        assert.notDeepStrictEqual(pair, ['gpt-4o', 'gpt-4o-mini'], 'the two openai models do not meet');
        assert.ok(pair.includes('claude-3-5-sonnet'), 'another family does: ' + pair.join(' vs '));
    });

    await check('two models of one family do meet when nothing else is there', async () => {
        const board = {
            'gpt-4o': { rating: 1200, ci_lower: 1190, ci_upper: 1210, games: 100 },
            'gpt-4o-mini': { rating: 1190, ci_lower: 1180, ci_upper: 1200, games: 100 },
        };
        const choice = choosePair({
            candidates: [round('r2', ['gpt-4o', 'gpt-4o-mini'])],
            board,
            random: () => 0.5,
        });
        assert.ok(choice, 'a pair is chosen');
        assert.strictEqual(choice.round_id, 'r2');
        assert.deepStrictEqual([choice.a.model, choice.b.model].sort(), ['gpt-4o', 'gpt-4o-mini']);
    });

    await check('the families are the vendor stems of the model ids', async () => {
        assert.strictEqual(familyOf('openai/gpt-4o'), 'openai');
        assert.strictEqual(familyOf('gpt-4o-mini'), 'openai');
        assert.strictEqual(familyOf('o3-mini'), 'openai');
        assert.strictEqual(familyOf('anthropic/claude-3-5-sonnet'), 'anthropic');
        assert.strictEqual(familyOf('gemini-2-5-pro'), 'google');
        assert.strictEqual(familyOf('gemma-3-27b'), 'google');
        assert.strictEqual(familyOf('deepseek-v3'), 'deepseek');
        assert.strictEqual(familyOf('qwen3-max'), 'qwen');
        assert.strictEqual(familyOf('llama-3.3-70b'), 'meta');
        assert.strictEqual(familyOf('mistral-large-2407'), 'mistral');
        assert.strictEqual(familyOf('ministral-8b'), 'mistral');
        assert.strictEqual(familyOf('grok-3'), 'xai');
        assert.strictEqual(familyOf('glm-4.6'), 'zhipu');
        assert.strictEqual(familyOf('kimi-k2'), 'moonshot');
        assert.strictEqual(familyOf('acme-7b'), 'acme', 'a model nobody knows is its own family');
    });

    await check('both sides come up about half the time', async () => {
        const candidates = [round('r1', ['gpt-4o', 'claude-3-5-sonnet'])];
        const random = seededRandom(20261113);
        let first = 0;
        let second = 0;
        for (let i = 0; i < 200; i++) {
            const choice = choosePair({ candidates, board: BOARD, random });
            assert.ok(choice, 'a pair is chosen every time');
            if (choice.a.model === 'gpt-4o') first++;
            else second++;
        }
        assert.ok(first >= 80 && first <= 120, 'the first side came up ' + first + ' times out of 200');
        assert.ok(second >= 80 && second <= 120, 'the second side came up ' + second + ' times out of 200');
    });

    await check('a model never meets itself, whatever the provider prefix says', async () => {
        const choice = choosePair({
            candidates: [round('r1', ['openai/gpt-4o', 'gpt-4o'])],
            board: BOARD,
            random: () => 0.5,
        });
        assert.strictEqual(choice, null, 'the same model twice is not a battle, prefixed or not');
    });

    await check('a board that says nothing still gives a pair', async () => {
        const choice = choosePair({
            candidates: [round('r1', ['gpt-4o', 'claude-3-5-sonnet'])],
            board: {},
            random: () => 0.5,
        });
        assert.ok(choice, 'a pair is chosen');
        assert.strictEqual(choice.round_id, 'r1');
        assert.ok(choice.score > 0, 'the pair is worth asking about: ' + choice.score);
    });

    await check('the pair that is chosen is the one that was scored', async () => {
        const candidates = [round('r1', ['gemini-2-5-pro', 'deepseek-v3'])];
        const choice = choosePair({ candidates, board: BOARD, random: () => 0.5 });
        const expected = pairScore(
            statsOf(BOARD, 'gemini-2-5-pro', referenceOf(boardMap(BOARD))),
            statsOf(BOARD, 'deepseek-v3', referenceOf(boardMap(BOARD))),
        );
        assert.strictEqual(Math.abs(choice.score - expected) < 1e-9, true, 'the score is the score of the pair: ' + choice.score);
        assert.strictEqual(typeof choice.swapped, 'boolean', 'the order of the sides is reported');
        assert.deepStrictEqual([choice.a.model, choice.b.model].sort(), ['deepseek-v3', 'gemini-2-5-pro']);
    });

    await check('a round with nothing to pair is not a battle', async () => {
        const choice = choosePair({
            candidates: [round('r1', ['gpt-4o', 'gpt-4o'])],
            board: BOARD,
            random: () => 0.5,
        });
        assert.strictEqual(choice, null, 'the same model twice is not a battle');
    });

    const t = await boot();
    try {
        const alice = t.network.addUser('alice');
        const other = t.network.addUser('other');

        /** A finished round with two entries, as the database holds it. */
        const seedRound = async ({ createdBy, models, ago }) => {
            const db = t.ctx.s.db;
            const taskId = t.ctx.s.newId('btk');
            await db.exec('INSERT INTO bench_tasks (id, kind_id, prompt, created_by) VALUES ($1, $2, $3, $4)',
                [taskId, 'design.ui', 'A page, please.', createdBy]);
            const roundId = t.ctx.s.newId('brd');
            await db.exec(
                `INSERT INTO bench_rounds (id, task_id, kind_id, status, created_by, created_at, finished_at)
                 VALUES ($1, $2, 'design.ui', 'finished', $3, now() - $4::interval, now())`,
                [roundId, taskId, createdBy, ago]);
            const entries = [];
            for (const model of models) {
                const id = t.ctx.s.newId('bte');
                await db.exec(
                    `INSERT INTO bench_entries (id, round_id, provider, model, route, payload, cost_usd, ms, tokens, created_at)
                     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5::jsonb, 0, 10, 10, now())`,
                    [id, roundId, model.split('/')[0], model, JSON.stringify({ html: '<p>hi</p>' })]);
                entries.push(id);
            }
            return { roundId, entries };
        };

        const own = await seedRound({ createdBy: alice.subject, models: ['gpt-4o', 'gemini-2-5-pro'], ago: '3 minutes' });
        const older = await seedRound({ createdBy: other.subject, models: ['gpt-4o', 'claude-3-5-sonnet'], ago: '2 minutes' });
        const newer = await seedRound({ createdBy: other.subject, models: ['deepseek-v3', 'qwen3-max'], ago: '1 minute' });

        let battle;

        await check('pickPair gives the same shape as before, and never the voter\'s own round', async () => {
            battle = await t.ctx.battles.pickPair({ subject: alice.subject, kind: 'design.ui', random: () => 0 });
            assert.ok(battle, 'a pair is waiting');
            assert.match(battle.id, /^bbs_/);
            assert.strictEqual(battle.kind_id, 'design.ui');
            assert.strictEqual(battle.prompt, 'A page, please.');
            assert.strictEqual(battle.question.id, 'more_finished');
            assert.deepStrictEqual(Object.keys(battle).sort(), ['a', 'b', 'id', 'kind_id', 'prompt', 'question', 'round_id']);
            assert.deepStrictEqual(Object.keys(battle.a).sort(), ['cost_usd', 'id', 'model', 'ms', 'provider']);
            assert.ok(battle.a.model && battle.b.model, 'both sides have a model');
            assert.notStrictEqual(battle.a.id, battle.b.id, 'the two sides are two entries');
            assert.notStrictEqual(battle.round_id, own.roundId, 'never a round the voter started');
            assert.ok([older.roundId, newer.roundId].includes(battle.round_id), 'a round of somebody else: ' + battle.round_id);
        });

        await check('the order shown is the order recorded', async () => {
            const seen = await t.ctx.s.db.maybe('SELECT * FROM bench_battle_seen WHERE id = $1', [battle.id]);
            assert.ok(seen, 'the pair was recorded as seen');
            assert.strictEqual(seen.subject, alice.subject);
            assert.strictEqual(seen.a_entry, battle.a.id, 'pane A is the entry that was shown first');
            assert.strictEqual(seen.b_entry, battle.b.id);
            assert.strictEqual(seen.pair_key, pairKey(battle.a.id, battle.b.id));
            const vote = await t.ctx.battles.recordVote({ subject: alice.subject, battleId: battle.id, outcome: 'A' });
            assert.strictEqual(vote.ok, true, JSON.stringify(vote));
            const judgement = await t.ctx.s.db.maybe(
                "SELECT * FROM bench_judgements WHERE round_id = $1 AND judge = 'human_pairwise'", [battle.round_id]);
            assert.ok(judgement, 'the vote is a judgement');
            assert.strictEqual(judgement.outcome, 'left', 'the vote follows the order shown');
            assert.strictEqual(judgement.pair.left, battle.a.id);
            assert.strictEqual(judgement.pair.right, battle.b.id);
        });

        await check('a person never meets the same pair twice', async () => {
            const again = await t.ctx.battles.pickPair({ subject: alice.subject, kind: 'design.ui', random: () => 0 });
            assert.ok(again, 'there is another pair');
            assert.notStrictEqual(again.round_id, battle.round_id, 'the round that was shown is not shown again');
            assert.notStrictEqual(again.a.id, battle.a.id, 'nor the same entry again');
        });
    } finally {
        await t.close();
    }
    done();
})();

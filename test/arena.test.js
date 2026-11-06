'use strict';
/**
 * The Exchange arena: the service builds a blind round from two answers, one person votes once, the names are
 * revealed, and the vote lands in Bench as that person's own human_pairwise judgement — under the whole board,
 * the people's board, and the board for the prompt's task category.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const exchange = t.network.serviceToken({
        sub: 'svc:exchange', audience: 'openvibe.bench',
        cap: ['bench.round.create', 'bench.judgement.cast', 'bench.board.read'],
    });
    const other = t.network.serviceToken({
        sub: 'svc:other', audience: 'openvibe.bench',
        cap: ['bench.round.create', 'bench.judgement.cast'],
    });

    const ENTRIES = [
        { provider: 'deepseek', model: 'deepseek/deepseek-chat@v1', answer: 'A mutex is a lock; a semaphore is a counter.', cost_usd: 0.0001, ms: 400, tokens: 40, run_id: 'run_left' },
        { provider: 'novita', model: 'qwen/qwen3-32b@v1', answer: 'A semaphore can count; a mutex cannot.', cost_usd: 0.0002, ms: 520, tokens: 42, run_id: 'run_right' },
    ];

    let roundId;
    let pair;

    try {
        await check('the Exchange builds a blind arena round from two answers', async () => {
            const r = await t.get('/api/v1/arena/rounds', {
                bearer: exchange,
                json: { prompt: 'Explain the difference between a mutex and a semaphore', category: 'code', entries: ENTRIES },
            });
            assert.strictEqual(r.status, 201, r.text);
            const body = r.json();
            roundId = body.round.id;
            assert.match(roundId, /^brd_/);
            assert.strictEqual(body.round.status, 'finished', 'two answers finish the round');
            assert.strictEqual(body.category, 'code');
            assert.deepStrictEqual(body.entries.map((e) => e.side), ['left', 'right']);
            assert.deepStrictEqual(body.entries.map((e) => e.model), ENTRIES.map((e) => e.model));
            pair = { left: body.entries[0].id, right: body.entries[1].id };

            const open = await t.get(`/api/v1/rounds/${roundId}`);
            assert.strictEqual(open.status, 200, open.text);
            assert.strictEqual(open.json().round.blind, true, 'blind before a vote');
            assert.strictEqual(open.json().round.entries[0].model, undefined, 'no name before a vote');
        });

        await check('a service that is not Exchange cannot build or vote', async () => {
            const make = await t.get('/api/v1/arena/rounds', {
                bearer: other, json: { prompt: 'hi', category: 'chat', entries: ENTRIES },
            });
            assert.strictEqual(make.status, 403, make.text);
            const vote = await t.get(`/api/v1/arena/rounds/${roundId}/votes`, {
                bearer: other, headers: { 'x-ov-subject': bob.subject }, json: { outcome: 'left', pair },
            });
            assert.strictEqual(vote.status, 403, vote.text);
        });

        await check('the vote names the person, and the person is not the round’s creator', async () => {
            const missing = await t.get(`/api/v1/arena/rounds/${roundId}/votes`, {
                bearer: exchange, json: { outcome: 'left', pair },
            });
            assert.strictEqual(missing.status, 422, missing.text);
            const bad = await t.get(`/api/v1/arena/rounds/${roundId}/votes`, {
                bearer: exchange, headers: { 'x-ov-subject': bob.subject }, json: { outcome: 'sideways', pair },
            });
            assert.strictEqual(bad.status, 422, bad.text);
        });

        await check('the vote is a human_pairwise judgement for that person, and the names are revealed', async () => {
            const r = await t.get(`/api/v1/arena/rounds/${roundId}/votes`, {
                bearer: exchange, headers: { 'x-ov-subject': bob.subject },
                json: { outcome: 'left', pair },
            });
            assert.strictEqual(r.status, 201, r.text);
            const body = r.json();
            assert.strictEqual(body.judgement.method, 'human_pairwise');
            assert.strictEqual(body.judgement.outcome, 'left');
            assert.strictEqual(body.judgement.round_id, roundId);
            assert.ok(body.revealed && body.revealed.left.model && body.revealed.right.model, 'both names after the vote');

            const row = await t.ctx.s.db.maybe('SELECT subject, method, outcome FROM bench_judgements WHERE round_id = $1', [roundId]);
            assert.strictEqual(row.subject, bob.subject, 'the judgement belongs to the person');
            assert.strictEqual(row.method, 'human_pairwise');
            assert.strictEqual(row.outcome, 'left');

            const open = await t.get(`/api/v1/rounds/${roundId}`, { bearer: t.network.userToken(bob) });
            assert.strictEqual(open.json().round.blind, undefined, 'revealed to the person who voted');
            assert.ok(open.json().round.entries.every((e) => e.model), 'both models are named');
        });

        await check('one vote per person per round: the second is 409', async () => {
            const again = await t.get(`/api/v1/arena/rounds/${roundId}/votes`, {
                bearer: exchange, headers: { 'x-ov-subject': bob.subject },
                json: { outcome: 'right', pair },
            });
            assert.strictEqual(again.status, 409, again.text);
            assert.strictEqual(again.json().code, 'bench.already_judged');
        });

        await check('another person votes on the same round', async () => {
            const r = await t.get(`/api/v1/arena/rounds/${roundId}/votes`, {
                bearer: exchange, headers: { 'x-ov-subject': alice.subject },
                json: { outcome: 'right', pair },
            });
            assert.strictEqual(r.status, 201, r.text);
        });

        await check('the task category has its own board, beside all and people', async () => {
            const board = await t.get('/api/v1/boards/chat.arena?category=code');
            assert.strictEqual(board.status, 200, board.text);
            const out = board.json().board;
            assert.strictEqual(out.category, 'code');
            assert.strictEqual(out.rows.length, 2, 'only the models that played in this category');
            for (const row of out.rows) {
                assert.strictEqual(row.games, 2, `${row.subject} played both votes`);
                assert.ok(row.elo > 900 && row.elo < 1100, `${row.subject} has an Elo`);
            }
            const all = await t.get('/api/v1/boards/chat.arena');
            assert.strictEqual(all.json().board.category, 'all');
            const people = await t.get('/api/v1/boards/chat.arena?voters=people');
            assert.strictEqual(people.json().board.category, 'people');
        });

        await check('a vote names two entries of the round', async () => {
            const make = await t.get('/api/v1/arena/rounds', {
                bearer: exchange, json: { prompt: 'Write a haiku about rain', category: 'writing', entries: ENTRIES },
            });
            const id = make.json().round.id;
            const bad = await t.get(`/api/v1/arena/rounds/${id}/votes`, {
                bearer: exchange, headers: { 'x-ov-subject': bob.subject },
                json: { outcome: 'left', pair: { left: pair.left, right: pair.right } },
            });
            assert.strictEqual(bad.status, 422, bad.text);
            const good = await t.get(`/api/v1/arena/rounds/${id}/votes`, {
                bearer: exchange, headers: { 'x-ov-subject': bob.subject },
                json: { outcome: 'tie', pair: { left: make.json().entries[0].id, right: make.json().entries[1].id } },
            });
            assert.strictEqual(good.status, 201, good.text);
            assert.strictEqual(good.json().judgement.outcome, 'tie');
        });

        await check('a round needs two different answers', async () => {
            const one = await t.get('/api/v1/arena/rounds', {
                bearer: exchange, json: { prompt: 'hi', category: 'chat', entries: [ENTRIES[0]] },
            });
            assert.strictEqual(one.status, 422, one.text);
            const blank = await t.get('/api/v1/arena/rounds', {
                bearer: exchange, json: { prompt: 'hi', category: 'chat', entries: [{ provider: 'x', model: 'y', answer: ' ' }, ENTRIES[1]] },
            });
            assert.strictEqual(blank.status, 422, blank.text);
            const same = await t.get('/api/v1/arena/rounds', {
                bearer: exchange, json: { prompt: 'hi', category: 'chat', entries: [ENTRIES[0], { ...ENTRIES[1], model: ENTRIES[0].model }] },
            });
            assert.strictEqual(same.status, 422, same.text);
            assert.ok(same.json().detail.includes('two different models'));
        });
    } finally { await t.close(); }

    done();
})();

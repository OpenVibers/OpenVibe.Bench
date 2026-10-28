'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot({ env: { BENCH_ROUNDS_PER_DAY: '100', BENCH_ROUNDS_DAILY: '1000' } });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');

    let roundId;

    const topics = async () => (await t.ctx.s.db.many('SELECT topic, payload FROM bench_outbox ORDER BY created_at, event_id')).map((r) => r.topic);

    await check('the outbox writes bench.round.finished when a round finishes', async () => {
        const task = await t.get('/api/v1/kinds/design.page/tasks', { as: alice, json: { prompt: 'A page for a robot.', public: true } });
        const rr = await t.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { as: alice, json: {} });
        roundId = rr.json().round.id;
        await t.tick();
        assert.ok((await topics()).includes('bench.round.finished'), 'expected bench.round.finished');
    });

    await check('the outbox writes bench.judgement.recorded and bench.rating.changed for a pairwise vote', async () => {
        const pair = await t.get('/api/v1/judgements/next?kind=design.page', { as: bob });
        assert.strictEqual(pair.status, 200, pair.text);
        const vote = await t.get(`/api/v1/rounds/${roundId}/judgements`, { as: bob, json: { judge: 'human_pairwise', pair: { left: pair.json().left.id, right: pair.json().right.id }, outcome: 'left' } });
        assert.strictEqual(vote.status, 201, vote.text);
        const all = await topics();
        assert.ok(all.includes('bench.judgement.recorded'), 'expected bench.judgement.recorded');
        assert.ok(all.includes('bench.rating.changed'), 'expected bench.rating.changed');
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

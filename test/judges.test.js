'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot({ env: { BENCH_ROUNDS_PER_DAY: '100', BENCH_ROUNDS_DAILY: '1000' } });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const entrySvc = t.network.serviceToken({ sub: 'svc:room', audience: 'openvibe.bench', cap: ['bench.entry.create'] });
    const judgeSvc = t.network.serviceToken({ sub: 'svc:judge', audience: 'openvibe.bench', cap: ['bench.judgement.cast'] });

    let winRound;
    let winPair;

    async function makeRound(kindId = 'design.page', models = ['acme/alpha-1', 'beta/beta-2']) {
        const task = await t.get(`/api/v1/kinds/${kindId}/tasks`, { as: alice, json: { prompt: 'A page for a robot.', public: true } });
        assert.strictEqual(task.status, 201, task.text);
        const rr = await t.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { as: alice, json: {} });
        assert.strictEqual(rr.status, 201, rr.text);
        const roundId = rr.json().round.id;
        const ids = [];
        for (const name of models) {
            const [provider, model] = name.split('/');
            const e = await t.get(`/api/v1/rounds/${roundId}/entries`, {
                bearer: entrySvc,
                json: { provider, model, payload: { html: `<h1>${model}</h1>` } },
            });
            assert.strictEqual(e.status, 201, e.text);
            ids.push(e.json().entry.id);
        }
        return { roundId, entryIds: ids };
    }

    await check('human pairwise: a win is blind before the vote and revealed after it', async () => {
        const { roundId } = await makeRound();
        const pair = await t.get('/api/v1/judgements/next?kind=design.page', { as: bob });
        assert.strictEqual(pair.status, 200, pair.text);
        assert.strictEqual(pair.json().left.model, undefined, 'blind before the vote');
        assert.strictEqual(pair.json().right.model, undefined, 'blind before the vote');
        const vote = await t.get(`/api/v1/rounds/${roundId}/judgements`, { as: bob, json: { judge: 'human_pairwise', pair: { left: pair.json().left.id, right: pair.json().right.id }, outcome: 'left' } });
        assert.strictEqual(vote.status, 201, vote.text);
        assert.ok(vote.json().revealed.left.model, 'revealed after the vote');
        assert.ok(vote.json().revealed.right.model, 'revealed after the vote');
        winRound = roundId;
        winPair = { left: pair.json().left.id, right: pair.json().right.id };
    });

    await check('human pairwise: one vote per person per round', async () => {
        const again = await t.get(`/api/v1/rounds/${winRound}/judgements`, { as: bob, json: { judge: 'human_pairwise', pair: winPair, outcome: 'right' } });
        assert.strictEqual(again.status, 409, again.text);
    });

    await check('human pairwise: the creator cannot vote on their own round', async () => {
        const vote = await t.get(`/api/v1/rounds/${winRound}/judgements`, { as: alice, json: { judge: 'human_pairwise', pair: winPair, outcome: 'left' } });
        assert.strictEqual(vote.status, 403, vote.text);
    });

    await check('human pairwise: a tie is recorded', async () => {
        const { roundId } = await makeRound();
        const pair = await t.get('/api/v1/judgements/next?kind=design.page', { as: bob });
        const vote = await t.get(`/api/v1/rounds/${roundId}/judgements`, { as: bob, json: { judge: 'human_pairwise', pair: { left: pair.json().left.id, right: pair.json().right.id }, outcome: 'tie' } });
        assert.strictEqual(vote.status, 201, vote.text);
        assert.strictEqual(vote.json().judgement.outcome, 'tie');
    });

    await check('human pairwise: both_bad is recorded and does not change ratings', async () => {
        const { roundId } = await makeRound();
        const pair = await t.get('/api/v1/judgements/next?kind=design.page', { as: bob });
        const vote = await t.get(`/api/v1/rounds/${roundId}/judgements`, { as: bob, json: { judge: 'human_pairwise', pair: { left: pair.json().left.id, right: pair.json().right.id }, outcome: 'both_bad' } });
        assert.strictEqual(vote.status, 201, vote.text);
        assert.strictEqual(vote.json().judgement.outcome, 'both_bad');
    });

    await check('rubric: a person casts a score and outcome', async () => {
        const { roundId } = await makeRound();
        const vote = await t.get(`/api/v1/rounds/${roundId}/judgements`, { as: alice, json: { judge: 'rubric', judge_name: 'rubric-v1', judge_version: '1.0.0', score: 0.75, outcome: 'pass' } });
        assert.strictEqual(vote.status, 201, vote.text);
        assert.strictEqual(vote.json().judgement.judge, 'rubric');
        assert.strictEqual(vote.json().judgement.score, 0.75);
        assert.strictEqual(vote.json().judgement.outcome, 'pass');
    });

    await check('automatic grader: name and version are recorded', async () => {
        const { roundId } = await makeRound('vision.answer');
        const vote = await t.get(`/api/v1/rounds/${roundId}/judgements`, { bearer: judgeSvc, json: { judge: 'automatic_grader', judge_name: 'vision-grader', judge_version: 'v3.2.1', score: 1, outcome: 'pass' } });
        assert.strictEqual(vote.status, 201, vote.text);
        assert.strictEqual(vote.json().judgement.judge, 'automatic_grader');
        assert.strictEqual(vote.json().judgement.judge_name, 'vision-grader');
        assert.strictEqual(vote.json().judgement.judge_version, 'v3.2.1');
    });

    await check('test suite: name and version are recorded', async () => {
        const { roundId } = await makeRound('codes.patch');
        const vote = await t.get(`/api/v1/rounds/${roundId}/judgements`, { bearer: judgeSvc, json: { judge: 'test_suite', judge_name: 'patch-tests', judge_version: 'v2.0.0', score: 3, outcome: 'pass' } });
        assert.strictEqual(vote.status, 201, vote.text);
        assert.strictEqual(vote.json().judgement.judge, 'test_suite');
        assert.strictEqual(vote.json().judgement.judge_name, 'patch-tests');
        assert.strictEqual(vote.json().judgement.judge_version, 'v2.0.0');
    });

    await check('game outcome: a service casts a draw from a pair', async () => {
        const { roundId, entryIds } = await makeRound('games.match', ['acme/alpha-1', 'beta/beta-2']);
        const vote = await t.get(`/api/v1/rounds/${roundId}/judgements`, { bearer: judgeSvc, json: { judge: 'game_outcome', pair: { left: entryIds[0], right: entryIds[1] }, outcome: 'draw' } });
        assert.strictEqual(vote.status, 201, vote.text);
        assert.strictEqual(vote.json().judgement.judge, 'game_outcome');
        assert.strictEqual(vote.json().judgement.outcome, 'draw');
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

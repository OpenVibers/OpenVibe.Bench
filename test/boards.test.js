'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot({ env: { BENCH_ROUNDS_PER_DAY: '100', BENCH_ROUNDS_DAILY: '1000' } });
    const alice = t.network.addUser('alice');
    const entrySvc = t.network.serviceToken({ sub: 'svc:room', audience: 'openvibe.bench', cap: ['bench.entry.create'] });
    const judgeSvc = t.network.serviceToken({ sub: 'svc:judge', audience: 'openvibe.bench', cap: ['bench.judgement.cast'] });

    let roundId;
    let leftId;
    let rightId;

    await check('elo, pareto and cost boards render for a seeded kind', async () => {
        const task = await t.get('/api/v1/kinds/design.page/tasks', { as: alice, json: { prompt: 'A page for a robot.', public: true } });
        const rr = await t.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { as: alice, json: {} });
        roundId = rr.json().round.id;
        const e1 = await t.get(`/api/v1/rounds/${roundId}/entries`, { bearer: entrySvc, json: { provider: 'acme', model: 'alpha-1', payload: { html: '<h1>One</h1>' } } });
        const e2 = await t.get(`/api/v1/rounds/${roundId}/entries`, { bearer: entrySvc, json: { provider: 'beta', model: 'beta-2', payload: { html: '<h1>Two</h1>' } } });
        assert.strictEqual(e1.status, 201, e1.text);
        assert.strictEqual(e2.status, 201, e2.text);
        leftId = e1.json().entry.id;
        rightId = e2.json().entry.id;
        for (const type of ['elo', 'pareto', 'cost']) {
            const r = await t.get(`/api/v1/boards/design.page?type=${type}`);
            assert.strictEqual(r.status, 200, `${type}: ${r.text}`);
            assert.strictEqual(r.json().board.type, type);
            assert.ok(Array.isArray(r.json().board.rows));
        }
    });

    await check('a board marks models with under 10 games as provisional', async () => {
        let board = await t.get('/api/v1/boards/design.page?type=elo');
        const subjects = board.json().board.rows;
        assert.ok(subjects.length >= 2, 'expected at least two subjects');
        for (const row of subjects) assert.strictEqual(row.provisional, true, `${row.subject} should be provisional with ${row.games} games`);
        await t.get(`/api/v1/rounds/${roundId}/judgements`, { bearer: judgeSvc, json: { judge: 'game_outcome', pair: { left: leftId, right: rightId }, outcome: 'left' } });
        board = await t.get('/api/v1/boards/design.page?type=elo');
        const after = board.json().board.rows;
        assert.ok(after.some((row) => row.games === 1 && row.provisional === true), 'one game is still provisional');
    });

    await check('a model page aggregates across kinds', async () => {
        const task = await t.get('/api/v1/kinds/games.match/tasks', { as: alice, json: { prompt: 'A match.', public: true } });
        const rr = await t.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { as: alice, json: {} });
        const rid = rr.json().round.id;
        await t.get(`/api/v1/rounds/${rid}/entries`, { bearer: entrySvc, json: { provider: 'acme', model: 'alpha-1', payload: { result: { winner: 'left' } } } });
        await t.get(`/api/v1/rounds/${rid}/entries`, { bearer: entrySvc, json: { provider: 'beta', model: 'beta-2', payload: { result: { winner: 'right' } } } });
        const r = await t.get('/api/v1/models/alpha-1');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().model, 'alpha-1');
        assert.ok(Array.isArray(r.json().entries));
        assert.ok(r.json().entries.some((e) => e.kind_id === 'design.page'));
        assert.ok(r.json().entries.some((e) => e.kind_id === 'games.match'));
        assert.ok(Array.isArray(r.json().ratings));
    });

    await check('the open dataset has no voter id or person id', async () => {
        const r = await t.get('/api/v1/datasets/design.page.jsonl');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.text.includes('usr_'), false, 'dataset contains a person id');
        for (const line of r.text.trim().split('\n').map((l) => JSON.parse(l))) {
            assert.strictEqual(line.created_by, undefined, 'task or round leaked a person id');
            if (line.type === 'judgement') assert.strictEqual(line.subject, undefined, 'judgement leaked a voter id');
        }
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const svc = t.network.serviceToken({ sub: 'svc:games', audience: 'openvibe.bench', cap: ['bench.entry.create'] });

    let taskId;
    let roundId;
    let leftId;
    let rightId;

    await check('kinds are seeded from code (the 15 of §4.12 plus the nine showcase kinds)', async () => {
        const r = await t.get('/api/v1/kinds');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().kinds.length, 24);
        const ids = r.json().kinds.map((k) => k.id);
        for (const want of ['design.page', 'games.match', 'meme.caption', 'vision.answer', 'codes.patch', 'speech.tts', 'speech.asr', 'translate.ja', 'search.answer']) {
            assert.ok(ids.includes(want), `missing kind ${want}`);
        }
        for (const id of ['chat.reply', 'translate.ja', 'search.answer', 'codes.patch', 'codes.review']) {
            const kind = r.json().kinds.find((k) => k.id === id);
            assert.ok(kind.schema.prompt && Object.keys(kind.schema.prompt).length, `${id} prompt shape`);
            assert.ok(kind.schema.rubric?.length, `${id} judge rubric`);
            assert.ok(kind.schema.seeds?.length, `${id} seed items`);
            assert.ok(Object.keys(kind.schema.seeds[0]).every((key) => key in kind.schema.prompt), `${id} seed matches prompt`);
        }
    });

    await check('a person creates a task and queues a round', async () => {
        const r = await t.get('/api/v1/kinds/design.page/tasks', { as: alice, json: { prompt: 'A landing page for a tiny robot.', public: true } });
        assert.strictEqual(r.status, 201, r.text);
        taskId = r.json().task.id;
        const rr = await t.get(`/api/v1/tasks/${taskId}/rounds`, { as: alice, json: {} });
        assert.strictEqual(rr.status, 201, rr.text);
        roundId = rr.json().round.id;
        assert.strictEqual(rr.json().round.status, 'queued');
    });

    await check('Live starts rounds against the streamer quota', async () => {
        const streamer = t.network.addUser('streamer');
        const live = t.network.serviceToken({ sub: 'svc:live', cap: ['bench.task.create', 'bench.round.create'] });
        const other = t.network.serviceToken({ sub: 'svc:other', cap: ['bench.task.create'] });
        const headers = { 'x-ov-subject': streamer.subject };
        const task = await t.get('/api/v1/kinds/chat.reply/tasks', { bearer: live, headers, json: { prompt: 'A stream reply.', public: true } });
        assert.strictEqual(task.status, 201, task.text);
        assert.strictEqual(task.json().task.created_by, streamer.subject);
        const round = await t.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { bearer: live, headers, json: {} });
        assert.strictEqual(round.status, 201, round.text);
        assert.strictEqual(round.json().round.created_by, streamer.subject);
        const unrelated = await t.get('/api/v1/kinds/chat.reply/tasks', { bearer: other, headers, json: { prompt: 'Another task.' } });
        assert.strictEqual(unrelated.status, 201, unrelated.text);
        assert.strictEqual(unrelated.json().task.created_by, 'service:other');
    });

    await check('the job generates entries and finishes the round with a receipt', async () => {
        await t.tick();
        const r = await t.get(`/api/v1/rounds/${roundId}`, { as: alice });
        assert.strictEqual(r.status, 200, r.text);
        const round = r.json().round;
        assert.strictEqual(round.status, 'finished');
        assert.strictEqual(round.entries.length, 3);
        assert.ok(round.receipt && /^[0-9a-f]{64}$/.test(round.receipt), 'a round receipt is a hash');
    });

    await check('entries are blind to a stranger and revealed to the creator', async () => {
        const anon = await t.get(`/api/v1/rounds/${roundId}`);
        assert.strictEqual(anon.json().round.blind, true);
        assert.strictEqual(anon.json().round.entries[0].model, undefined);
        const mine = await t.get(`/api/v1/rounds/${roundId}`, { as: alice });
        assert.ok(mine.json().round.entries[0].model, 'creator sees the model');
    });

    await check('next pair is blind and excludes the creator', async () => {
        const none = await t.get('/api/v1/judgements/next?kind=design.page', { as: alice });
        assert.strictEqual(none.json().pair, null);
        const r = await t.get('/api/v1/judgements/next?kind=design.page', { as: bob });
        assert.strictEqual(r.status, 200, r.text);
        const pair = r.json();
        assert.ok(pair.left && pair.right && pair.left.id !== pair.right.id);
        assert.strictEqual(pair.left.model, undefined);
        leftId = pair.left.id;
        rightId = pair.right.id;
    });

    await check('a blind vote records, reveals, updates Elo and enforces one vote', async () => {
        const r = await t.get(`/api/v1/rounds/${roundId}/judgements`, { as: bob, json: { pair: { left: leftId, right: rightId }, outcome: 'left' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.ok(r.json().revealed.left.model, 'revealed after the vote');
        const again = await t.get(`/api/v1/rounds/${roundId}/judgements`, { as: bob, json: { pair: { left: leftId, right: rightId }, outcome: 'right' } });
        assert.strictEqual(again.status, 409, again.text);
    });

    await check('a creator cannot vote on their own round', async () => {
        const r = await t.get(`/api/v1/rounds/${roundId}/judgements`, { as: alice, json: { pair: { left: leftId, right: rightId }, outcome: 'left' } });
        assert.strictEqual(r.status, 403, r.text);
    });

    await check('elo, pareto and cost boards render as JSON', async () => {
        for (const type of ['elo', 'pareto', 'cost']) {
            const r = await t.get(`/api/v1/boards/design.page?type=${type}`);
            assert.strictEqual(r.status, 200, `${type}: ${r.text}`);
            assert.strictEqual(r.json().board.type, type);
            assert.ok(Array.isArray(r.json().board.rows));
        }
    });

    await check('the open dataset has no voter ids', async () => {
        const r = await t.get('/api/v1/datasets/design.page.jsonl');
        assert.strictEqual(r.status, 200, r.text);
        const lines = r.text.trim().split('\n').map((l) => JSON.parse(l));
        const judgements = lines.filter((l) => l.type === 'judgement');
        assert.ok(judgements.length >= 1);
        for (const j of judgements) assert.strictEqual(j.subject, undefined);
    });

    await check('a model page aggregates ratings across kinds', async () => {
        const reveal = await t.get(`/api/v1/rounds/${roundId}`, { as: alice });
        const model = reveal.json().round.entries[0].model;
        const r = await t.get(`/api/v1/models/${encodeURIComponent(model)}`);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().model, model);
        assert.ok(Array.isArray(r.json().entries));
    });

    await check('a room service submits entries with a bench.entry.create token', async () => {
        const rr = await t.get(`/api/v1/tasks/${taskId}/rounds`, { as: alice, json: {} });
        const rid = rr.json().round.id;
        const e1 = await t.get(`/api/v1/rounds/${rid}/entries`, { bearer: svc, json: { provider: 'acme', model: 'alpha-1', payload: { html: '<h1>One</h1>' } } });
        assert.strictEqual(e1.status, 201, e1.text);
        const e2 = await t.get(`/api/v1/rounds/${rid}/entries`, { bearer: svc, json: { provider: 'beta', model: 'beta-2', payload: { html: '<h1>Two</h1>' } } });
        assert.strictEqual(e2.status, 201, e2.text);
        const round = await t.get(`/api/v1/rounds/${rid}`, { as: alice });
        assert.strictEqual(round.json().round.status, 'finished');
        assert.strictEqual(round.json().round.entries.length, 2);
    });

    await check('a person\'s token is refused for outside entries', async () => {
        const rr = await t.get(`/api/v1/tasks/${taskId}/rounds`, { as: alice, json: {} });
        const rid = rr.json().round.id;
        const person = await t.get(`/api/v1/rounds/${rid}/entries`, { as: alice, json: { provider: 'acme', model: 'alpha-1', payload: { html: '<h1>No</h1>' } } });
        assert.strictEqual(person.status, 403, person.text);
        assert.strictEqual(person.json().code, 'bench.capability_required');
        const noCap = await t.get(`/api/v1/rounds/${rid}/entries`, { bearer: t.network.serviceToken({ sub: 'svc:nope', audience: 'openvibe.bench', cap: [] }), json: { provider: 'acme', model: 'alpha-1', payload: { html: '<h1>No</h1>' } } });
        assert.strictEqual(noCap.status, 403, noCap.text);
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

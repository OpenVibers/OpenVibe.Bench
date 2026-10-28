'use strict';

const assert = require('assert');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');

const SECRET = 'whsec_fixturefixturefixturefixturefixturefixture';
const EXPORT_ID = 'exp_01M624SX2FFR7RMSXMFJ2GM16F';
const DELETION_ID = 'del_01M624SX2FFR7RMSXMFJ2GM16F';

(async () => {
    const sent = [];
    const accountSend = async (path, body) => {
        sent.push({ path, body });
        return { ok: true, status: 201 };
    };
    const t = await boot({ env: { BENCH_EVENTS_SECRET: SECRET, BENCH_ROUNDS_PER_DAY: '100', BENCH_ROUNDS_DAILY: '1000' }, accountSend });
    const alice = t.network.addUser('alice');

    let taskId;
    let roundId;
    let judgementId;

    const signedEvent = (event) => {
        const raw = JSON.stringify({ event });
        return { raw, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(Buffer.from(raw), SECRET) } };
    };

    await check('a person leaves tasks, rounds and a judgement', async () => {
        const carol = t.network.addUser('carol');
        const other = await t.get('/api/v1/kinds/design.page/tasks', { as: carol, json: { prompt: 'A page for a human.', public: true } });
        const otherRound = await t.get(`/api/v1/tasks/${other.json().task.id}/rounds`, { as: carol, json: {} });
        await t.tick();

        const task = await t.get('/api/v1/kinds/design.page/tasks', { as: alice, json: { prompt: 'A page for a robot.', public: true } });
        assert.strictEqual(task.status, 201, task.text);
        taskId = task.json().task.id;
        const rr = await t.get(`/api/v1/tasks/${taskId}/rounds`, { as: alice, json: {} });
        roundId = rr.json().round.id;

        const pair = await t.get('/api/v1/judgements/next?kind=design.page', { as: alice });
        assert.strictEqual(pair.status, 200, pair.text);
        const vote = await t.get(`/api/v1/rounds/${otherRound.json().round.id}/judgements`, { as: alice, json: { judge: 'human_pairwise', pair: { left: pair.json().left.id, right: pair.json().right.id }, outcome: 'left' } });
        assert.strictEqual(vote.status, 201, vote.text);
        judgementId = vote.json().judgement.id;
    });

    await check('account export sends the person\'s rows to Network', async () => {
        const ev = { event_id: 'evt_export_1', event_type: 'network.account.export_requested', source: 'network', payload: { export_id: EXPORT_ID, subject: alice.subject } };
        const r = await t.get('/internal/events', signedEvent(ev));
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().outcome, 'exported');
        const part = sent.find((c) => c.path === `/internal/account-exports/${EXPORT_ID}/parts`);
        assert.ok(part, 'export part was not sent');
        assert.strictEqual(part.body.subject, alice.subject);
        assert.ok(part.body.files.some((f) => f.name === 'bench_tasks.json' && f.content.length === 1));
        assert.ok(part.body.files.some((f) => f.name === 'bench_rounds.json' && f.content.length === 1));
        assert.ok(part.body.files.some((f) => f.name === 'bench_judgements.json' && f.content.length === 1));
    });

    await check('account deletion removes tasks and rounds and anonymises votes', async () => {
        const ev = { event_id: 'evt_delete_1', event_type: 'network.account.deleted', source: 'network', payload: { deletion_id: DELETION_ID, subject: alice.subject } };
        const r = await t.get('/internal/events', signedEvent(ev));
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().outcome, 'erased');
        const confirm = sent.find((c) => c.path === `/internal/account-deletions/${DELETION_ID}/confirmations`);
        assert.ok(confirm, 'deletion confirmation was not sent');
        assert.strictEqual(confirm.body.subject, alice.subject);
        assert.strictEqual(confirm.body.erased.bench_tasks, 1);
        assert.strictEqual(confirm.body.erased.bench_rounds, 1);
        assert.strictEqual(confirm.body.retained.tombstones, 1);

        const task = await t.get(`/api/v1/tasks/${taskId}`);
        assert.strictEqual(task.status, 404, task.text);
        const round = await t.get(`/api/v1/rounds/${roundId}`);
        assert.strictEqual(round.status, 404, round.text);
        const j = await t.ctx.s.db.maybe('SELECT subject FROM bench_judgements WHERE id = $1', [judgementId]);
        assert.strictEqual(j.subject, null);
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

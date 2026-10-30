'use strict';

/**
 * The battles (stage B9): blind pairs, the rules, and a vote that works without JavaScript.
 */

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

(async () => {
    // One vote per hour for this person: the rate limit is part of the rules under test.
    const t = await boot({ env: { BENCH_BATTLE_PERSON_PER_HOUR: '1' } });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const svc = t.network.serviceToken({ sub: 'svc:games', audience: 'openvibe.bench', cap: ['bench.entry.create'] });

    // Two finished rounds, each with two entries: two battles to hand out.
    const rounds = [];
    for (const n of [1, 2]) {
        const task = await t.get('/api/v1/kinds/design.ui/tasks', { as: alice, json: { prompt: 'A dashboard, prompt ' + n + '.', public: true } });
        assert.strictEqual(task.status, 201, task.text);
        const rr = await t.get('/api/v1/tasks/' + task.json().task.id + '/rounds', { as: alice, json: {} });
        assert.strictEqual(rr.status, 201, rr.text);
        const roundId = rr.json().round.id;
        const e1 = await t.get('/api/v1/rounds/' + roundId + '/entries', { bearer: svc, json: { provider: 'acme', model: 'alpha-' + n, payload: { html: '<p>alpha ' + n + '</p>' }, cost_usd: 0.01 } });
        assert.strictEqual(e1.status, 201, e1.text);
        const e2 = await t.get('/api/v1/rounds/' + roundId + '/entries', { bearer: svc, json: { provider: 'beta', model: 'beta-' + n, payload: { html: '<p>beta ' + n + '</p>' }, cost_usd: 0.02 } });
        assert.strictEqual(e2.status, 201, e2.text);
        rounds.push({ id: roundId, a: e1.json().entry.id, b: e2.json().entry.id });
    }

    await check('an anonymous reader is asked to sign in, and sees no pair', async () => {
        const r = await t.get('/battle');
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(r.text.includes('Sign in'), 'the sign-in prompt');
        assert.ok(!r.text.includes('data-battle='), 'no pair for an anonymous reader');
    });

    await check('a signed-in person gets a blind pair', async () => {
        const r = await t.get('/battle', { as: bob });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(r.text.includes('data-battle="bbs_'), 'the battle id: ' + r.text.slice(0, 200));
        assert.ok(r.text.includes('data-slot="A"') && r.text.includes('data-slot="B"'), 'two panes');
        assert.ok(r.text.includes('Which one looks more finished?'), 'the kind\'s own question');
        assert.ok(!r.text.includes('alpha-1') && !r.text.includes('beta-1'), 'no model names before the vote');
    });

    await check('the vote is a form post that works without JavaScript', async () => {
        const page = await t.get('/battle', { as: bob });
        const battleId = /data-battle="(bbs_[^"]+)"/.exec(page.text)[1];
        const vote = await t.get('/battle', { as: bob, method: 'POST', headers: FORM, body: 'battle=' + encodeURIComponent(battleId) + '&outcome=A&answer=A' });
        assert.strictEqual(vote.status, 303, vote.text);
        assert.ok(String(vote.headers.get('location') || '').startsWith('/battle/revealed/'), 'the reveal page: ' + vote.headers.get('location'));
        const reveal = await t.get(vote.headers.get('location'), { as: bob });
        assert.strictEqual(reveal.status, 200, reveal.text);
        assert.ok(reveal.text.includes('alpha-') || reveal.text.includes('beta-'), 'the names are open after the vote');
        const row = await t.ctx.s.db.maybe("SELECT outcome, question, answer FROM bench_judgements WHERE judge = 'human_pairwise' ORDER BY at DESC LIMIT 1");
        assert.strictEqual(row.outcome, 'left');
        assert.strictEqual(row.question, 'Which one looks more finished?');
        assert.strictEqual(row.answer, 'A');
    });

    await check('a person never sees the same pair twice', async () => {
        const seen = await t.ctx.s.db.many('SELECT round_id, pair_key, voted_at FROM bench_battle_seen WHERE subject = (SELECT subject FROM bench_judgements ORDER BY at DESC LIMIT 1)');
        const pairs = new Set(seen.map((s) => s.pair_key));
        assert.strictEqual(pairs.size, seen.length, 'no pair twice: ' + JSON.stringify(seen));
        // Both rounds are used up now: there is nothing left to show this person.
        const more = await t.get('/battle', { as: bob });
        assert.strictEqual(more.status, 200, more.text);
        assert.ok(more.text.includes('No battle is waiting'), 'no pair left: ' + more.text.slice(0, 300));
    });

    await check('the rate limit stops the second vote', async () => {
        const before = await t.ctx.s.db.value("SELECT COUNT(*)::int AS n FROM bench_judgements WHERE judge = 'human_pairwise'");
        const rows = await t.ctx.s.db.many('SELECT id, round_id FROM bench_battle_seen WHERE voted_at IS NULL');
        assert.ok(rows.length >= 1, 'a pair is waiting');
        const vote = await t.get('/battle', { as: bob, method: 'POST', headers: FORM, body: 'battle=' + encodeURIComponent(rows[0].id) + '&outcome=B' });
        assert.strictEqual(vote.status, 429, vote.text);
        const after = await t.ctx.s.db.value("SELECT COUNT(*)::int AS n FROM bench_judgements WHERE judge = 'human_pairwise'");
        assert.strictEqual(after, before, 'no vote was written');
    });

    await check('an anonymous vote is refused, and a cross-site vote is refused', async () => {
        const rows = await t.ctx.s.db.many('SELECT id FROM bench_battle_seen WHERE voted_at IS NULL');
        const anon = await t.get('/battle', { method: 'POST', headers: FORM, body: 'battle=' + encodeURIComponent(rows[0].id) + '&outcome=A' });
        assert.ok(anon.status === 302 || anon.status === 303, 'the anonymous vote is sent to sign in: ' + anon.status);
        assert.ok(String(anon.headers.get('location') || '').startsWith('/auth/login'), 'to the sign-in page');
        const cross = await t.get('/battle', { as: bob, method: 'POST', headers: FORM, origin: 'https://evil.example', body: 'battle=' + encodeURIComponent(rows[0].id) + '&outcome=A' });
        assert.strictEqual(cross.status, 403, cross.text);
    });

    await check('the ratings board counts the battle vote, and the open data has no voter ids', async () => {
        const page = await t.get('/ratings', { as: bob });
        assert.strictEqual(page.status, 200, page.text);
        assert.ok(page.text.includes('Raw') && page.text.includes('Style controlled'), 'both columns');
        assert.ok(page.text.includes('alpha-'), 'a model on the board');

        const dump = await t.get('/api/v1/datasets/votes.jsonl');
        assert.strictEqual(dump.status, 200, dump.text);
        const lines = dump.text.trim().split('\n').filter(Boolean);
        assert.ok(lines.length >= 1, 'the dump has the vote');
        const subject = await t.ctx.s.db.value("SELECT subject FROM bench_judgements WHERE judge = 'human_pairwise' LIMIT 1");
        for (const line of lines) {
            const v = JSON.parse(line);
            assert.ok(v.left && v.right && v.outcome, 'a vote line: ' + line);
            assert.ok(!('subject' in v) && !('voter' in v) && !('user' in v), 'no voter id in the line: ' + line);
            assert.ok(!line.includes(subject), 'the voter is nowhere in the dump');
        }
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

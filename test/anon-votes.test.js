'use strict';

/**
 * Signed-out voting (plan L51, step 1): the anonymous voter, the relay, and every cap.
 *
 * The caps are read from the environment, so each group of rules gets its own Bench with only that cap low.
 */

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const SAME = { secFetchSite: 'same-origin' };

/** A round with two entries: two things to judge. */
async function makeRound(t, alice, svc, n, owner) {
    const task = await t.get('/api/v1/kinds/design.ui/tasks', { as: alice, json: { prompt: 'A dashboard, prompt ' + n + '.', public: true } });
    assert.strictEqual(task.status, 201, task.text);
    const rr = await t.get('/api/v1/tasks/' + task.json().task.id + '/rounds', { as: alice, json: {} });
    assert.strictEqual(rr.status, 201, rr.text);
    const roundId = rr.json().round.id;
    const e1 = await t.get('/api/v1/rounds/' + roundId + '/entries', { bearer: svc, json: { provider: 'acme', model: 'alpha-' + n, payload: { html: '<p>a</p>' }, cost_usd: 0.01 } });
    const e2 = await t.get('/api/v1/rounds/' + roundId + '/entries', { bearer: svc, json: { provider: 'beta', model: 'beta-' + n, payload: { html: '<p>b</p>' }, cost_usd: 0.02 } });
    assert.strictEqual(e1.status, 201, e1.text);
    assert.strictEqual(e2.status, 201, e2.text);
    return { id: roundId, a: e1.json().entry.id, b: e2.json().entry.id };
}

/** The cookie Bench hands a visitor who has not signed in. */
function cookieOf(res) {
    const raw = res.headers.get('set-cookie') || '';
    const first = String(raw).split(';')[0];
    return first.includes('=') ? first : '';
}

(async () => {
    // ── The voter: one cookie, one vote per round, a cap a day ──────────────
    const t = await boot({
        env: {
            BENCH_ROUNDS_PER_DAY: '20',
            BENCH_ANON_VOTER_PER_DAY: '2',
            BENCH_ANON_IP_PER_DAY: '1000',
            BENCH_ANON_RELAY_PER_DAY: '1000',
            BENCH_ANON_GLOBAL_PER_DAY: '1000',
            BENCH_ANON_RELAY_SERVICES: 'design',
        },
    });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const svc = t.network.serviceToken({ sub: 'svc:games', audience: 'openvibe.bench', cap: ['bench.entry.create'] });
    const design = t.network.serviceToken({
        sub: 'svc:design', audience: 'openvibe.bench',
        cap: ['bench.task.create', 'bench.round.create', 'bench.judgement.cast'],
    });
    const rounds = [];
    for (const n of [1, 2, 3]) rounds.push(await makeRound(t, alice, svc, n));

    let anonCookie = '';
    let anonSubject = '';

    await check('the next-pair route answers an anonymous voter and hands out a signed cookie', async () => {
        const r = await t.get('/api/v1/judgements/next?kind=design.ui');
        assert.strictEqual(r.status, 200, r.text);
        anonCookie = cookieOf(r);
        assert.ok(anonCookie.startsWith('bench_anon='), 'the voter cookie: ' + anonCookie);
        assert.ok(/HttpOnly/i.test(r.headers.get('set-cookie') || ''), 'the cookie is httpOnly');
        assert.ok(r.json().left && r.json().right, 'a pair');
        assert.strictEqual(r.json().left.model, undefined, 'blind before the vote');
        assert.strictEqual(r.json().right.model, undefined, 'blind before the vote');
    });

    await check('a signed-out visitor votes through the cookie, and the pair opens after the vote', async () => {
        const before = await t.get('/api/v1/showcase/rounds/' + rounds[0].id, { cookie: anonCookie });
        assert.strictEqual(before.status, 200, before.text);
        assert.strictEqual(before.json().round.revealed, false, 'blind before the vote');

        const vote = await t.get('/api/v1/showcase/rounds/' + rounds[0].id + '/vote', {
            method: 'POST', cookie: anonCookie, json: { outcome: 'A' }, ...SAME,
        });
        assert.strictEqual(vote.status, 201, vote.text);
        assert.strictEqual(vote.json().judged, true);
        assert.strictEqual(vote.json().revealed, true, 'the pair is open after the vote');

        const after = await t.get('/api/v1/showcase/rounds/' + rounds[0].id, { cookie: anonCookie });
        assert.strictEqual(after.json().round.revealed, true, 'the pair is open for the voter who judged it');
        assert.ok(after.json().round.slots[0].model, 'the names are there for the voter who judged it');
    });

    await check('the judgement is stored as an anonymous vote, with a hash and never the id', async () => {
        const row = await t.ctx.s.db.maybe("SELECT voter_kind, subject FROM bench_judgements WHERE judge = 'human_pairwise' ORDER BY at DESC LIMIT 1");
        assert.strictEqual(row.voter_kind, 'anon');
        assert.ok(String(row.subject).startsWith('anon_'), 'the subject is the hash of the opaque id: ' + row.subject);
        assert.ok(!String(row.subject).includes('bench_anon'), 'the cookie value is never stored');
        anonSubject = row.subject;
        // The open dataset never carries a voter id.
        const dataset = await t.get('/api/v1/datasets/design.ui.jsonl');
        assert.strictEqual(dataset.status, 200, dataset.text);
        assert.ok(!dataset.text.includes(anonSubject), 'the dataset carries no voter hash');
        assert.ok(!dataset.text.includes('anon_'), 'the dataset carries no anonymous voter');
    });

    await check('the same anonymous voter never judges the same round twice', async () => {
        const again = await t.get('/api/v1/showcase/rounds/' + rounds[0].id + '/vote', {
            method: 'POST', cookie: anonCookie, json: { outcome: 'B' }, ...SAME,
        });
        assert.strictEqual(again.status, 409, again.text);
        assert.strictEqual(again.json().code, 'bench.already_judged', again.text);
    });

    await check('the next-pair route never hands back a round the voter judged, and 204 when none is left', async () => {
        const more = await t.get('/api/v1/judgements/next?kind=design.ui', { cookie: anonCookie });
        assert.strictEqual(more.status, 200, more.text);
        assert.notStrictEqual(more.json().round.id, rounds[0].id, 'a round they have not judged');
        const vote = await t.get('/api/v1/showcase/rounds/' + rounds[1].id + '/vote', {
            method: 'POST', cookie: anonCookie, json: { outcome: 'A' }, ...SAME,
        });
        assert.strictEqual(vote.status, 201, vote.text);
        const none = await t.get('/api/v1/judgements/next?kind=design.svg', { cookie: anonCookie });
        assert.strictEqual(none.status, 204, none.text);
        assert.strictEqual(none.text, '', 'no body with 204');
    });

    await check('over the daily cap: 429 bench.limit_anon, and a plain reason', async () => {
        const over = await t.get('/api/v1/showcase/rounds/' + rounds[2].id + '/vote', {
            method: 'POST', cookie: anonCookie, json: { outcome: 'A' }, ...SAME,
        });
        assert.strictEqual(over.status, 429, over.text);
        assert.strictEqual(over.json().code, 'bench.limit_anon', over.text);
        assert.strictEqual(over.json().detail, 'Sign in to keep voting today', over.text);
        const counted = await t.ctx.s.db.value("SELECT COUNT(*)::int AS n FROM bench_judgements WHERE voter_kind = 'anon' AND subject = $1", [anonSubject]);
        assert.strictEqual(counted, 2, 'the refused vote was not counted');
    });

    await check("Bench's own page votes without signing in", async () => {
        const page = await t.get('/showcase/round/' + rounds[2].id);
        assert.strictEqual(page.status, 200, page.text);
        const cookie = cookieOf(page);
        assert.ok(cookie.startsWith('bench_anon='), 'the page hands out the voter cookie');
        assert.ok(page.text.includes('data-vote-form="1"'), 'the signed-out visitor gets the form');
        assert.ok(!page.text.includes('Sign in to vote'), 'not the sign-in prompt');
        const vote = await t.get('/showcase/round/' + rounds[2].id, {
            method: 'POST', cookie, headers: FORM, body: 'outcome=A', ...SAME,
        });
        assert.strictEqual(vote.status, 302, vote.text);
        const row = await t.ctx.s.db.maybe("SELECT voter_kind FROM bench_judgements WHERE round_id = $1 ORDER BY at DESC LIMIT 1", [rounds[2].id]);
        assert.strictEqual(row.voter_kind, 'anon', 'the page vote is an anonymous vote');
    });

    await check('a board says how many votes of each kind of voter it holds', async () => {
        const person = await t.get('/api/v1/showcase/rounds/' + rounds[0].id, { as: bob });
        assert.strictEqual(person.status, 200, person.text);
        const bobVote = await t.get('/api/v1/rounds/' + rounds[0].id + '/judgements', {
            as: bob, json: { judge: 'human_pairwise', pair: { left: rounds[0].a, right: rounds[0].b }, outcome: 'left' },
        });
        assert.strictEqual(bobVote.status, 201, bobVote.text);

        const counted = await t.ctx.s.db.many("SELECT voter_kind, COUNT(*)::int AS n FROM bench_judgements WHERE judge = 'human_pairwise' GROUP BY 1");
        const byKind = new Map(counted.map((row) => [row.voter_kind, row.n]));
        const all = await t.get('/api/v1/boards/design.ui');
        assert.strictEqual(all.status, 200, all.text);
        assert.ok(all.json().board.voters, 'the board counts its voters');
        assert.strictEqual(all.json().board.voters.anon, byKind.get('anon'), 'the anonymous votes: ' + JSON.stringify(all.json().board.voters));
        assert.strictEqual(all.json().board.voters.person, byKind.get('person'), 'the signed-in votes: ' + JSON.stringify(all.json().board.voters));
        assert.strictEqual(all.json().board.voters.person, 1, 'one signed-in vote');

        const people = await t.get('/api/v1/boards/design.ui?voters=people');
        assert.strictEqual(people.status, 200, people.text);
        assert.strictEqual(people.json().board.category, 'people');
        // Every vote is a game for both models, so the games of a board are twice its votes.
        const peopleGames = people.json().board.rows.reduce((n, row) => n + row.games, 0);
        assert.strictEqual(peopleGames, byKind.get('person') * 2, 'the signed-in vote alone: ' + JSON.stringify(people.json().board.rows));

        const anon = await t.get('/api/v1/boards/design.ui?voters=anon');
        assert.strictEqual(anon.status, 200, anon.text);
        assert.strictEqual(anon.json().board.category, 'anon');
        const anonGames = anon.json().board.rows.reduce((n, row) => n + row.games, 0);
        assert.strictEqual(anonGames, byKind.get('anon') * 2, 'the anonymous votes alone: ' + JSON.stringify(anon.json().board.rows));
        assert.ok(anonGames > peopleGames, 'the anonymous votes are counted apart from the signed-in ones');
    });

    await check('a signed-in person still gets the pair they have not judged', async () => {
        const r = await t.get('/api/v1/judgements/next?kind=design.ui', { as: bob });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(r.json().left && r.json().right);
    });

    await check('stop', async () => { await t.close(); });

    // ── The relay and the address ────────────────────────────────────────────
    const t2 = await boot({
        env: {
            BENCH_ROUNDS_PER_DAY: '20',
            BENCH_ANON_VOTER_PER_DAY: '1000',
            BENCH_ANON_IP_PER_DAY: '2',
            BENCH_ANON_RELAY_PER_DAY: '1',
            BENCH_ANON_GLOBAL_PER_DAY: '1000',
            BENCH_ANON_RELAY_SERVICES: 'design',
        },
    });
    const alice2 = t2.network.addUser('alice');
    const svc2 = t2.network.serviceToken({ sub: 'svc:games', audience: 'openvibe.bench', cap: ['bench.entry.create'] });
    const design2 = t2.network.serviceToken({
        sub: 'svc:design', audience: 'openvibe.bench',
        cap: ['bench.task.create', 'bench.round.create', 'bench.judgement.cast'],
    });
    const other2 = t2.network.serviceToken({
        sub: 'svc:other', audience: 'openvibe.bench',
        cap: ['bench.task.create', 'bench.round.create', 'bench.judgement.cast'],
    });
    const rounds2 = [];
    for (const n of [1, 2, 3, 4]) rounds2.push(await makeRound(t2, alice2, svc2, n));

    await check('a service on the allow-list relays an anonymous vote', async () => {
        const r = await t2.get('/api/v1/rounds/' + rounds2[0].id + '/judgements', {
            bearer: design2,
            headers: { 'x-ov-voter': 'anon:visitor-one' },
            json: { pair: { left: rounds2[0].a, right: rounds2[0].b }, outcome: 'left' },
        });
        assert.strictEqual(r.status, 201, r.text);
        assert.ok(r.json().revealed.left.model, 'the names open after the vote');
        const row = await t2.ctx.s.db.maybe("SELECT voter_kind, subject FROM bench_judgements WHERE round_id = $1 ORDER BY at DESC LIMIT 1", [rounds2[0].id]);
        assert.strictEqual(row.voter_kind, 'anon');
        assert.ok(!String(row.subject).includes('visitor-one'), 'the opaque id is never stored: ' + row.subject);
    });

    await check('the relay gets a blind pair for the anonymous voter it names', async () => {
        const r = await t2.get('/api/v1/judgements/next?kind=design.ui', {
            bearer: design2, headers: { 'x-ov-voter': 'anon:visitor-two' },
        });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(r.json().left && r.json().right);
        assert.strictEqual(r.json().left.model, undefined, 'blind before the vote');
        assert.ok(r.json().round.id, 'the round it names');
    });

    await check('a service that is not on the allow-list may not relay', async () => {
        const r = await t2.get('/api/v1/rounds/' + rounds2[1].id + '/judgements', {
            bearer: other2,
            headers: { 'x-ov-voter': 'anon:visitor-three' },
            json: { pair: { left: rounds2[1].a, right: rounds2[1].b }, outcome: 'left' },
        });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json().code, 'bench.relay_not_allowed', r.text);
    });

    await check('a service token without bench.judgement.cast may not relay', async () => {
        const weak = t2.network.serviceToken({ sub: 'svc:design', audience: 'openvibe.bench', cap: ['bench.board.read'] });
        const r = await t2.get('/api/v1/rounds/' + rounds2[1].id + '/judgements', {
            bearer: weak,
            headers: { 'x-ov-voter': 'anon:visitor-four' },
            json: { pair: { left: rounds2[1].a, right: rounds2[1].b }, outcome: 'left' },
        });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json().code, 'bench.capability_denied', r.text);
    });

    await check('the relay never sees a round it started itself', async () => {
        const task = await t2.get('/api/v1/kinds/design.ui/tasks', { bearer: design2, json: { prompt: 'The relay\'s own round.', public: true } });
        assert.strictEqual(task.status, 201, task.text);
        const rr = await t2.get('/api/v1/tasks/' + task.json().task.id + '/rounds', { bearer: design2, json: {} });
        const own = rr.json().round.id;
        const e1 = await t2.get('/api/v1/rounds/' + own + '/entries', { bearer: svc2, json: { provider: 'acme', model: 'alpha-own', payload: { html: '<p>a</p>' } } });
        const e2 = await t2.get('/api/v1/rounds/' + own + '/entries', { bearer: svc2, json: { provider: 'beta', model: 'beta-own', payload: { html: '<p>b</p>' } } });
        const vote = await t2.get('/api/v1/rounds/' + own + '/judgements', {
            bearer: design2,
            headers: { 'x-ov-voter': 'anon:visitor-five' },
            json: { pair: { left: e1.json().entry.id, right: e2.json().entry.id }, outcome: 'left' },
        });
        assert.strictEqual(vote.status, 403, vote.text);
        assert.strictEqual(vote.json().code, 'bench.creator_cannot_vote', vote.text);
    });

    await check('the relay has a daily total of its own', async () => {
        const over = await t2.get('/api/v1/rounds/' + rounds2[1].id + '/judgements', {
            bearer: design2,
            headers: { 'x-ov-voter': 'anon:visitor-six' },
            json: { pair: { left: rounds2[1].a, right: rounds2[1].b }, outcome: 'left' },
        });
        assert.strictEqual(over.status, 429, over.text);
        assert.strictEqual(over.json().code, 'bench.limit_anon', over.text);
        assert.strictEqual(over.json().detail, 'Sign in to keep voting today', over.text);
    });

    await check('the per-address cap: the same address has one budget, another address has its own', async () => {
        const first = await t2.get('/api/v1/judgements/next?kind=design.ui');
        const c1 = cookieOf(first);
        const v1 = await t2.get('/api/v1/showcase/rounds/' + rounds2[1].id + '/vote', {
            method: 'POST', cookie: c1, json: { outcome: 'A' }, ...SAME,
        });
        assert.strictEqual(v1.status, 201, v1.text);

        const second = await t2.get('/api/v1/judgements/next?kind=design.ui');
        const c2 = cookieOf(second);
        const v2 = await t2.get('/api/v1/showcase/rounds/' + rounds2[2].id + '/vote', {
            method: 'POST', cookie: c2, json: { outcome: 'A' }, ...SAME,
        });
        assert.strictEqual(v2.status, 201, v2.text);

        // The third visitor from the same address is over the address budget.
        const third = await t2.get('/api/v1/judgements/next?kind=design.ui');
        const c3 = cookieOf(third);
        const v3 = await t2.get('/api/v1/showcase/rounds/' + rounds2[3].id + '/vote', {
            method: 'POST', cookie: c3, json: { outcome: 'A' }, ...SAME,
        });
        assert.strictEqual(v3.status, 429, v3.text);
        assert.strictEqual(v3.json().code, 'bench.limit_anon', v3.text);

        // Another address has its own budget.
        const other = await t2.get('/api/v1/judgements/next?kind=design.ui', { headers: { 'x-forwarded-for': '203.0.113.9' } });
        const c4 = cookieOf(other);
        const v4 = await t2.get('/api/v1/showcase/rounds/' + rounds2[3].id + '/vote', {
            method: 'POST', cookie: c4, json: { outcome: 'A' }, headers: { 'x-forwarded-for': '203.0.113.9' }, ...SAME,
        });
        assert.strictEqual(v4.status, 201, v4.text);

        // The address itself is never written down: only a salted hash of it.
        const rows = await t2.ctx.s.db.many("SELECT key FROM bench_anon_counters WHERE scope = 'ip'");
        assert.ok(rows.length >= 2, 'the address counters');
        for (const row of rows) {
            assert.ok(!row.key.includes('203.0.113.9') && !row.key.includes('127.0.0.1'), 'no address in the counters: ' + row.key);
            assert.ok(/^[0-9a-f]{64}$/.test(row.key), 'a hash: ' + row.key);
        }
    });

    await check('stop', async () => { await t2.close(); });

    // ── The site-wide cap ────────────────────────────────────────────────────
    const t3 = await boot({
        env: {
            BENCH_ROUNDS_PER_DAY: '20',
            BENCH_ANON_VOTER_PER_DAY: '1000',
            BENCH_ANON_IP_PER_DAY: '1000',
            BENCH_ANON_RELAY_PER_DAY: '1000',
            BENCH_ANON_GLOBAL_PER_DAY: '2',
        },
    });
    const alice3 = t3.network.addUser('alice');
    const svc3 = t3.network.serviceToken({ sub: 'svc:games', audience: 'openvibe.bench', cap: ['bench.entry.create'] });
    const rounds3 = [];
    for (const n of [1, 2, 3]) rounds3.push(await makeRound(t3, alice3, svc3, n));

    await check('over the site-wide cap every anonymous vote is refused', async () => {
        for (const [i, ip] of ['198.51.100.1', '198.51.100.2'].entries()) {
            const next = await t3.get('/api/v1/judgements/next?kind=design.ui', { headers: { 'x-forwarded-for': ip } });
            const cookie = cookieOf(next);
            const vote = await t3.get('/api/v1/showcase/rounds/' + rounds3[i].id + '/vote', {
                method: 'POST', cookie, json: { outcome: 'A' }, headers: { 'x-forwarded-for': ip }, ...SAME,
            });
            assert.strictEqual(vote.status, 201, vote.text);
        }
        const next = await t3.get('/api/v1/judgements/next?kind=design.ui', { headers: { 'x-forwarded-for': '198.51.100.3' } });
        const cookie = cookieOf(next);
        const over = await t3.get('/api/v1/showcase/rounds/' + rounds3[2].id + '/vote', {
            method: 'POST', cookie, json: { outcome: 'A' }, headers: { 'x-forwarded-for': '198.51.100.3' }, ...SAME,
        });
        assert.strictEqual(over.status, 429, over.text);
        assert.strictEqual(over.json().code, 'bench.limit_anon', over.text);
        assert.strictEqual(over.json().detail, 'Sign in to keep voting today', over.text);
    });

    await check('stop', async () => { await t3.close(); });

    // The address hash is salted per day, and the old counters go.
    let now = Date.parse('2026-11-01T09:00:00.000Z');
    const t4 = await boot({
        now: () => now,
        env: { BENCH_ROUNDS_PER_DAY: '20', BENCH_ANON_IP_PER_DAY: '1000', BENCH_ANON_GLOBAL_PER_DAY: '1000' },
    });
    const alice4 = t4.network.addUser('alice');
    const svc4 = t4.network.serviceToken({ sub: 'svc:games', audience: 'openvibe.bench', cap: ['bench.entry.create'] });
    const rounds4 = [];
    for (const n of [1, 2]) rounds4.push(await makeRound(t4, alice4, svc4, n));

    await check('the hash of an address is salted per day, so two days cannot be linked', async () => {
        const first = await t4.get('/api/v1/judgements/next?kind=design.ui');
        const v1 = await t4.get('/api/v1/showcase/rounds/' + rounds4[0].id + '/vote', {
            method: 'POST', cookie: cookieOf(first), json: { outcome: 'A' }, ...SAME,
        });
        assert.strictEqual(v1.status, 201, v1.text);

        now = Date.parse('2026-11-02T09:00:00.000Z');
        const second = await t4.get('/api/v1/judgements/next?kind=design.ui');
        const v2 = await t4.get('/api/v1/showcase/rounds/' + rounds4[1].id + '/vote', {
            method: 'POST', cookie: cookieOf(second), json: { outcome: 'A' }, ...SAME,
        });
        assert.strictEqual(v2.status, 201, v2.text);

        const rows = await t4.ctx.s.db.many("SELECT key, day FROM bench_anon_counters WHERE scope = 'ip' ORDER BY day");
        assert.strictEqual(rows.length, 2, 'two days, two rows: ' + JSON.stringify(rows));
        assert.notStrictEqual(rows[0].key, rows[1].key, 'the salt moves with the day');
        assert.strictEqual(rows[0].day, '2026-11-01');
        assert.strictEqual(rows[1].day, '2026-11-02');
    });

    await check('the old counters are dropped after their week', async () => {
        now = Date.parse('2026-11-20T09:00:00.000Z');
        await t4.ctx.anon.prune();
        const rows = await t4.ctx.s.db.many('SELECT COUNT(*)::int AS n FROM bench_anon_counters');
        assert.strictEqual(rows[0].n, 0, 'the old rows are gone');
    });

    await check('stop', async () => { await t4.close(); });

    done();
})();

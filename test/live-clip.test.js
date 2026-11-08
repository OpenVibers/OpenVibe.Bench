'use strict';
/**
 * live.clip (item 151, C19): OpenVibe.Live's AI clip picks, judged blind against another policy's. Typed clip and
 * abstention entries, the policy pinned on each entry, only Live submits, the playback only for a voter and never
 * after it expires, never on a public board, list, gallery, dataset or vote dump, never filled by Bench's AI, and the
 * cost and accept rate per policy (both_bad counts against both).
 *   node test/live-clip.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot({ env: { BENCH_ROUNDS_PER_DAY: '100', BENCH_ROUNDS_DAILY: '1000' } });
    const voter = t.network.addUser('voter');
    const voter2 = t.network.addUser('voter2');
    const CAPS = ['bench.task.create', 'bench.round.create', 'bench.entry.create'];
    // Live's token is granted the recordings it may cut clips from (the `ns` claim): the namespace of a recording
    // is `rec:<recording_id>`, and a wildcard covers the recordings it names.
    const live = t.network.serviceToken({ sub: 'svc:live', audience: 'openvibe.bench', cap: CAPS, ns: ['rec:vod_*'] });
    const other = t.network.serviceToken({ sub: 'svc:room', audience: 'openvibe.bench', cap: CAPS, ns: ['rec:vod_*'] });
    const soon = () => new Date(Date.now() + 3600_000).toISOString();
    const clip = (version, extra = {}) => ({
        source: { recording_id: 'vod_5021', start_ms: 60_000, end_ms: 90_000, language: 'ja', genre: 'irl' },
        playback: { url: `https://media.openvibe.media/p/${version}.mp4?sig=x`, expires_at: soon() },
        policy: { selector: 'moment-picker', version, models: ['qwen3-vl-4b'] },
        title: 'The cat walks onto the keyboard',
        ...extra,
    });
    let roundId;

    async function newRound(token = live) {
        const task = await t.get('/api/v1/kinds/live.clip/tasks', { bearer: token, json: { prompt: 'vod_5021 30:00-45:00', public: true } });
        if (task.status !== 201) return { status: task.status, text: task.text };
        assert.strictEqual(task.json().task.public, false, 'a private kind\'s task is never public');
        const rr = await t.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { bearer: token, json: {} });
        assert.strictEqual(rr.status, 201, rr.text);
        return { status: 201, id: rr.json().round.id };
    }

    await check('only Live makes live.clip tasks, rounds and entries', async () => {
        assert.strictEqual((await newRound(other)).status, 403);
        const r = await newRound();
        assert.strictEqual(r.status, 201, r.text);
        roundId = r.id;
        const e = await t.get(`/api/v1/rounds/${roundId}/entries`, { bearer: other, json: { payload: clip('v1'), cost_usd: 0.002 } });
        assert.strictEqual(e.status, 403);
    });

    await check('typed entries: a clip and an abstention; the bad ones refused; the policy pinned on the entry', async () => {
        const bad = [
            clip('v1', { source: { recording_id: 'vod_5021', start_ms: 90_000, end_ms: 60_000 } }),
            clip('v1', { source: { recording_id: 'vod_5021', start_ms: 0, end_ms: 2_000 } }),
            clip('v1', { playback: { url: 'http://insecure.example/x.mp4', expires_at: soon() } }),
            clip('v1', { playback: { url: 'https://media.openvibe.media/p.mp4', expires_at: new Date(Date.now() - 1000).toISOString() } }),
            clip('v1', { policy: { selector: 'moment-picker' } }),
            { source: { recording_id: 'vod_5021', start_ms: 0, end_ms: 1 }, policy: { selector: 's', version: 'v2' }, abstained: true },
        ];
        for (const payload of bad) {
            const r = await t.get(`/api/v1/rounds/${roundId}/entries`, { bearer: live, json: { payload } });
            assert.strictEqual(r.status, 422, JSON.stringify(payload).slice(0, 120));
        }
        const a = await t.get(`/api/v1/rounds/${roundId}/entries`, { bearer: live, json: { payload: clip('v1', { extra: 'dropped' }), cost_usd: 0.002 } });
        assert.strictEqual(a.status, 201, a.text);
        assert.strictEqual(a.json().entry.payload.extra, undefined, 'only the typed fields are kept');
        const b = await t.get(`/api/v1/rounds/${roundId}/entries`, { bearer: live, json: { payload: { source: { recording_id: 'vod_5021', start_ms: 0, end_ms: 1000 }, policy: { selector: 'moment-picker', version: 'v2', models: ['smolvlm2-500m'] }, abstained: true, reason: 'Nothing happened worth a clip.' }, cost_usd: 0.0005 } });
        assert.strictEqual(b.status, 201, b.text);
        const row = await t.ctx.s.db.one('SELECT route, model FROM bench_entries WHERE id = $1', [a.json().entry.id]);
        assert.deepStrictEqual(row.route.policy, { selector: 'moment-picker', version: 'v1', models: ['qwen3-vl-4b'] });
        assert.strictEqual(row.model, 'qwen3-vl-4b');
    });

    await check('a submitter may only submit for a recording its token is granted', async () => {
        // Live's token holds `rec:vod_*`: the recordings whose id starts with `vod_`. A clip of another recording
        // (one this token was never granted) is refused, and so is a token that names no recording at all.
        const r = await newRound();
        const foreign = await t.get(`/api/v1/rounds/${r.id}/entries`, { bearer: live, json: { payload: clip('v1', { source: { recording_id: 'clip_99', start_ms: 60_000, end_ms: 90_000 } }) } });
        assert.strictEqual(foreign.status, 403, foreign.text);
        assert.strictEqual(foreign.json().code, 'bench.clip_source_denied');
        const none = t.network.serviceToken({ sub: 'svc:live', audience: 'openvibe.bench', cap: CAPS, ns: [] });
        const noNs = await t.get(`/api/v1/rounds/${r.id}/entries`, { bearer: none, json: { payload: clip('v1') } });
        assert.strictEqual(noNs.status, 403, 'a token granted no recording is authorised for none');
        assert.strictEqual(noNs.json().code, 'bench.clip_source_denied');
        const one = t.network.serviceToken({ sub: 'svc:live', audience: 'openvibe.bench', cap: CAPS, ns: ['rec:vod_5021'] });
        const exact = await t.get(`/api/v1/rounds/${r.id}/entries`, { bearer: one, json: { payload: clip('v1') } });
        assert.strictEqual(exact.status, 201, exact.text);
        const otherRec = await t.get(`/api/v1/rounds/${r.id}/entries`, { bearer: one, json: { payload: clip('v1', { source: { recording_id: 'vod_5022', start_ms: 60_000, end_ms: 90_000 } }) } });
        assert.strictEqual(otherRec.status, 403, 'granted one recording, not another');
        // An abstention names its recording too, so it is refused the same way.
        const abstain = await t.get(`/api/v1/rounds/${r.id}/entries`, { bearer: one, json: { payload: { source: { recording_id: 'vod_5022', start_ms: 0, end_ms: 1000 }, policy: { selector: 'moment-picker', version: 'v1', models: [] }, abstained: true, reason: 'Nothing worth clipping here.' } } });
        assert.strictEqual(abstain.status, 403, 'an abstention of another recording is refused as well');
        // The refused entries left nothing behind.
        const rows = await t.ctx.s.db.many('SELECT id FROM bench_entries WHERE round_id = $1', [r.id]);
        assert.strictEqual(rows.length, 1, 'only the authorised entry was stored');
    });

    await check('the playback is for a voter only: not in a round read, not after it expires', async () => {
        const anon = await t.get(`/api/v1/rounds/${roundId}`);
        assert.strictEqual(anon.status, 404, 'a private round is not readable by just anyone');
        const asLive = await t.get(`/api/v1/rounds/${roundId}`, { bearer: live });
        assert.strictEqual(asLive.status, 200, asLive.text);
        assert.ok(asLive.json().round.entries.length === 2 && asLive.json().round.entries.every((e) => !e.payload.playback), 'no playback in a round read');
        const pair = await t.get('/api/v1/judgements/next?kind=live.clip', { as: voter });
        assert.strictEqual(pair.status, 200, pair.text);
        const sides = [pair.json().left, pair.json().right];
        assert.ok(sides.some((sd) => sd.payload.playback && sd.payload.playback.url.startsWith('https://')), 'the voter sees the clip');
        await t.ctx.s.db.exec("UPDATE bench_entries SET payload = jsonb_set(payload, '{playback,expires_at}', to_jsonb('2020-01-01T00:00:00.000Z'::text)) WHERE round_id = $1 AND payload ? 'playback'", [roundId]);
        const later = await t.get('/api/v1/judgements/next?kind=live.clip', { as: voter2 });
        const ls = [later.json().left, later.json().right];
        assert.ok(ls.every((sd) => !sd.payload.playback), 'never after it expires');
        assert.ok(ls.some((sd) => sd.payload.playback_expired === true));
        const anonNext = await t.get('/api/v1/judgements/next?kind=live.clip');
        assert.ok([401, 403].includes(anonNext.status), `anonymous voting on a private kind is refused (${anonNext.status})`);
    });

    await check('cost and accept rate per policy; both_bad counts against both', async () => {
        const pair = await t.get('/api/v1/judgements/next?kind=live.clip', { as: voter });
        const p = pair.json();
        const entries = await t.ctx.s.db.many('SELECT id, payload FROM bench_entries WHERE round_id = $1', [roundId]);
        const v1 = entries.find((e) => e.payload.policy.version === 'v1').id;
        const winnerSide = p.left.id === v1 ? 'left' : 'right';
        const vote = await t.get(`/api/v1/rounds/${roundId}/judgements`, { as: voter, json: { judge: 'human_pairwise', pair: { left: p.left.id, right: p.right.id }, outcome: winnerSide } });
        assert.strictEqual(vote.status, 201, vote.text);
        const p2 = (await t.get('/api/v1/judgements/next?kind=live.clip', { as: voter2 })).json();
        const vote2 = await t.get(`/api/v1/rounds/${roundId}/judgements`, { as: voter2, json: { judge: 'human_pairwise', pair: { left: p2.left.id, right: p2.right.id }, outcome: 'both_bad' } });
        assert.strictEqual(vote2.status, 201, vote2.text);
        const r = await t.get('/api/v1/kinds/live.clip/policies', { bearer: live });
        assert.strictEqual(r.status, 200, r.text);
        const by = Object.fromEntries(r.json().policies.map((x) => [x.policy, x]));
        assert.deepStrictEqual([by['moment-picker@v1'].votes, by['moment-picker@v1'].wins, by['moment-picker@v1'].both_bad, by['moment-picker@v1'].accept_rate], [2, 1, 1, 0.5]);
        assert.deepStrictEqual([by['moment-picker@v2'].votes, by['moment-picker@v2'].losses, by['moment-picker@v2'].both_bad, by['moment-picker@v2'].abstained, by['moment-picker@v2'].accept_rate], [2, 1, 1, 1, 0]);
        assert.strictEqual(by['moment-picker@v1'].cost_usd, 0.002);
        assert.strictEqual((await t.get('/api/v1/kinds/live.clip/policies', { bearer: other })).status, 403, 'Live\'s results are Live\'s');
    });

    await check('never public: the kind list, the board, the dataset, the vote dump, the gallery; never filled by Bench\'s AI', async () => {
        const kinds = (await t.get('/api/v1/kinds')).json().kinds.map((k) => k.id);
        assert.ok(!kinds.includes('live.clip'));
        assert.strictEqual((await t.get('/api/v1/boards/live.clip')).status, 404);
        assert.strictEqual((await t.get('/api/v1/datasets/live.clip.jsonl')).status, 404);
        const votes = await t.get('/api/v1/datasets/votes.jsonl');
        assert.ok(!votes.text.includes('live.clip'), 'no live.clip vote in the dump');
        const gallery = await t.get('/api/v1/showcase/rounds?kind=live.clip');
        if (gallery.status === 200) assert.ok(!gallery.text.includes(roundId), 'not in the gallery');
        const queued = await newRound();
        const claimed = await t.ctx.s.db.maybe("SELECT * FROM bench_rounds WHERE status = 'queued' AND NOT (kind_id = ANY($1::text[])) AND id = $2", [['live.clip'], queued.id]);
        assert.strictEqual(claimed, null, 'the job runner never claims it');
    });

    await check('a live.clip round spends no AI: it skips the daily round limits and counts against none', async () => {
        const quota = await boot({ env: { BENCH_ROUNDS_PER_DAY: '1', BENCH_ROUNDS_DAILY: '1' } });
        const liveSvc = quota.network.serviceToken({ sub: 'svc:live', audience: 'openvibe.bench', cap: CAPS, ns: ['rec:vod_*'] });
        for (let i = 0; i < 4; i++) {
            const task = await quota.get('/api/v1/kinds/live.clip/tasks', { bearer: liveSvc, json: { prompt: `stretch ${i}` } });
            const rr = await quota.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { bearer: liveSvc, json: {} });
            assert.strictEqual(rr.status, 201, `round ${i}: ${rr.text}`);
        }
        const person = quota.network.addUser('quota-person');
        const t2 = await quota.get('/api/v1/kinds/design.page/tasks', { as: person, json: { prompt: 'A page.' } });
        const r2 = await quota.get(`/api/v1/tasks/${t2.json().task.id}/rounds`, { as: person, json: {} });
        assert.strictEqual(r2.status, 201, 'a person\'s round still fits: the clip rounds took none of the site\'s budget');
        await quota.close();
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';

const assert = require('assert');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { uncovered } = require('openvibe-sdk/account-data');
const { boot, check, done } = require('./helpers/boot');
const accountDataLib = require('../server/identity/account-data');

const SECRET = 'whsec_fixturefixturefixturefixturefixturefixture';
const EXPORT_ID = 'exp_01M624SX2FFR7RMSXMFJ2GM16F';
const DELETION_ID = 'del_01M624SX2FFR7RMSXMFJ2GM16F';
// The ids the schema checks: a ULID (26 characters of Crockford's alphabet) behind the table's prefix.
const ulid = (prefix, tail = 'AAA') => `${prefix}_01JZ${'0'.repeat(19)}${tail}`;

(async () => {
    const sent = [];
    const accountSend = async (path, body) => {
        sent.push({ path, body });
        return { ok: true, status: 201 };
    };
    const t = await boot({ env: { BENCH_EVENTS_SECRET: SECRET, BENCH_ROUNDS_PER_DAY: '100', BENCH_ROUNDS_DAILY: '1000' }, accountSend });
    const alice = t.network.addUser('alice');
    const carol = t.network.addUser('carol');
    const db = t.ctx.s.db;

    let taskId;
    let roundId;
    let judgementId;
    let sharedBenchmark;
    let lonelyBenchmark;
    let privateBenchmark;
    let sharedPromptBenchmark;

    const signedEvent = (event) => {
        const raw = JSON.stringify({ event });
        return { raw, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(Buffer.from(raw), SECRET) } };
    };

    await check('the guard: every table with a person column is covered or exempted with a reason', async () => {
        const missing = await uncovered(db, {
            tables: [...accountDataLib.TABLES, ...accountDataLib.GUARDED],
            exempt: {
                account_data_events: 'the ledger of the requests themselves: which export and deletion Bench applied',
                bench_ratings: 'the ratings are an aggregate over the models: the subject column names a model, not a person',
            },
        });
        assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);
    });

    await check('a person leaves tasks, rounds and a judgement', async () => {
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

    await check('a person owns benchmarks, runs, watches and the pairs they have seen', async () => {
        // A benchmark other people ran: it stays, without them, when they go.
        sharedBenchmark = ulid('bmk', 'AAA');
        lonelyBenchmark = ulid('bmk', 'AAB');
        for (const [id, owner] of [[sharedBenchmark, alice.subject], [lonelyBenchmark, alice.subject]]) {
            await db.exec(`INSERT INTO bench_benchmarks (id, owner, title, kind, visibility, created_by, created_at, updated_at)
                VALUES ($1, $2, 'A benchmark', 'design.page', 'unlisted', $2, now(), now())`, [id, owner]);
            await db.exec(`INSERT INTO bench_benchmark_versions (benchmark_id, version, definition, hash, created_by, created_at)
                VALUES ($1, 1, '{"kind":"design.page"}', $2, $3, now())`, [id, 'a'.repeat(64), owner]);
        }
        // Her own prompts: a private benchmark with a service-run on it. Both go with her.
        privateBenchmark = ulid('bmk', 'AAC');
        await db.exec(`INSERT INTO bench_benchmarks (id, owner, title, kind, visibility, share_token_hash, created_by, created_at, updated_at)
            VALUES ($1, $2, 'Private prompts', 'text.answer', 'private', $3, $2, now(), now())`, [privateBenchmark, alice.subject, 'b'.repeat(64)]);
        await db.exec(`INSERT INTO bench_benchmark_versions (benchmark_id, version, definition, hash, created_by, created_at)
            VALUES ($1, 1, $2::jsonb, $3, $4, now())`, [privateBenchmark, JSON.stringify({ kind: 'text.answer', tasks: [{ id: 't1', prompt: 'A very private prompt ZEBRA', holdout: false }] }), 'c'.repeat(64), alice.subject]);
        await db.exec(`INSERT INTO bench_runs (id, benchmark_id, benchmark_version, model, provider, provenance, created_by, created_at)
            VALUES ($1, $2, 1, 'model-private', 'acme', 'verified', 'svc:private-exec', now())`, [ulid('brn', 'AAC'), privateBenchmark]);
        // A prompt benchmark she shared: it still goes with her, because the prompts are hers.
        sharedPromptBenchmark = ulid('bmk', 'AAD');
        await db.exec(`INSERT INTO bench_benchmarks (id, owner, title, kind, visibility, tags, share_token_hash, created_by, created_at, updated_at)
            VALUES ($1, $2, 'Shared prompts', 'text.answer', 'unlisted', '["your-prompts"]'::jsonb, $3, $2, now(), now())`, [sharedPromptBenchmark, alice.subject, 'd'.repeat(64)]);
        await db.exec(`INSERT INTO bench_benchmark_versions (benchmark_id, version, definition, hash, created_by, created_at)
            VALUES ($1, 1, $2::jsonb, $3, $4, now())`, [sharedPromptBenchmark, JSON.stringify({ kind: 'text.answer', tasks: [{ id: 't1', prompt: 'A shared private prompt ZEBRA', holdout: false }] }), 'e'.repeat(64), alice.subject]);
        await db.exec(`INSERT INTO bench_runs (id, benchmark_id, benchmark_version, model, provider, provenance, created_by, created_at)
            VALUES ($1, $2, 1, 'model-shared', 'acme', 'verified', $3, now())`, [ulid('brn', 'AAD'), sharedPromptBenchmark, carol.subject]);
        // Her run on the benchmark, and Carol's run on the same one.
        await db.exec(`INSERT INTO bench_runs (id, benchmark_id, benchmark_version, model, provider, provenance, created_by, created_at)
            VALUES ($1, $2, 1, 'model-a', 'openai', 'submitted', $3, now())`, [ulid('brn', 'AAA'), sharedBenchmark, alice.subject]);
        await db.exec(`INSERT INTO bench_runs (id, benchmark_id, benchmark_version, model, provider, provenance, created_by, created_at)
            VALUES ($1, $2, 1, 'model-b', 'openai', 'submitted', $3, now())`, [ulid('brn', 'AAB'), sharedBenchmark, carol.subject]);
        // A pair she has seen.
        await db.exec(`INSERT INTO bench_battle_seen (id, subject, pair_key, round_id, kind_id, a_entry, b_entry, at)
            VALUES ($1, $2, 'a|b', $3, 'design.page', 'bte_1', 'bte_2', now())`, [ulid('bbs', 'AAA'), alice.subject, roundId]);
        // The watches table arrives with the watches; when it is there, her watch is hers.
        if (await db.value("SELECT to_regclass('bench_watches') IS NOT NULL")) {
            await db.exec(`INSERT INTO bench_watches (id, subject, benchmark_id, created_at) VALUES ($1, $2, $3, now())`, [ulid('bwa', 'AAA'), alice.subject, lonelyBenchmark]);
        }
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
        assert.ok(part.body.files.some((f) => f.name === 'bench_runs.json' && f.content.length === 1));
        assert.ok(part.body.files.some((f) => f.name === 'bench_battle_seen.json' && f.content.length === 1));
        const benchmarks = part.body.files.find((f) => f.name === 'benchmarks.json');
        assert.ok(benchmarks && benchmarks.content.length === 4, 'her benchmarks are in the part');
        const versions = part.body.files.find((f) => f.name === 'benchmark_versions.json');
        assert.ok(versions && versions.content.length === 4, 'the versions of her benchmarks are in the part');
        assert.ok(JSON.stringify(versions).includes('A very private prompt ZEBRA'), 'her private prompts are in her export');
        assert.ok(JSON.stringify(versions).includes('A shared private prompt ZEBRA'), 'her shared prompts are in her export');
        const privateRuns = part.body.files.find((f) => f.name === 'benchmark_runs.json');
        assert.ok(privateRuns && privateRuns.content.length === 2, 'the runs on her prompt benchmarks are in her export');
        assert.ok(privateRuns.content.some((r) => r.model === 'model-private'));
        assert.ok(privateRuns.content.some((r) => r.model === 'model-shared'));
        assert.ok(!JSON.stringify(part.body).includes(carol.subject), 'nobody else\'s rows');
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
        assert.strictEqual(confirm.body.erased.bench_runs, 3, 'her run and the runs on her prompt benchmarks are gone');
        assert.strictEqual(confirm.body.erased.bench_benchmarks, 3, 'the benchmark nobody else ran and both prompt benchmarks are gone');
        assert.strictEqual(confirm.body.erased.bench_battle_seen, 1, 'the pairs she had seen are gone');
        // Three rows stay without her: her judgement, the benchmark other people ran and its frozen version.
        assert.strictEqual(confirm.body.retained.tombstones, 3, 'her judgement, the benchmark others ran and its version stay');

        const task = await t.get(`/api/v1/tasks/${taskId}`);
        assert.strictEqual(task.status, 404, task.text);
        const round = await t.get(`/api/v1/rounds/${roundId}`);
        assert.strictEqual(round.status, 404, round.text);
        const j = await db.maybe('SELECT subject FROM bench_judgements WHERE id = $1', [judgementId]);
        assert.strictEqual(j.subject, null);
        // The benchmark other people ran stays, without her; their run stays too.
        const kept = await db.maybe('SELECT owner, created_by FROM bench_benchmarks WHERE id = $1', [sharedBenchmark]);
        assert.strictEqual(kept.owner, 'deleted');
        assert.strictEqual(kept.created_by, 'deleted');
        assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM bench_runs WHERE benchmark_id = $1', [sharedBenchmark])), 1, 'Carol\'s run is still there');
        assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM bench_benchmarks WHERE id = $1', [lonelyBenchmark])), 0, 'the benchmark nobody ran is gone');
        assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM bench_benchmarks WHERE id = $1', [privateBenchmark])), 0, 'the private benchmark is gone');
        assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM bench_benchmark_versions WHERE benchmark_id = $1', [privateBenchmark])), 0, 'its prompts go with it');
        assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM bench_runs WHERE benchmark_id = $1', [privateBenchmark])), 0, 'the run on it is gone too');
        assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM bench_benchmarks WHERE id = $1', [sharedPromptBenchmark])), 0, 'a shared prompt benchmark goes too');
        assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM bench_benchmark_versions WHERE benchmark_id = $1', [sharedPromptBenchmark])), 0, 'its shared prompts go with it');
        assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM bench_runs WHERE benchmark_id = $1', [sharedPromptBenchmark])), 0, 'its run goes too');
        if (await db.value("SELECT to_regclass('bench_watches') IS NOT NULL")) {
            assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM bench_watches WHERE subject = $1', [alice.subject])), 0, 'her watch is gone');
        }
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

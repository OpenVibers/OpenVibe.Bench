'use strict';

/**
 * P6 model-variant evidence (plan 2026-11-04, G-P6): exact ids group into a family across quants and revisions;
 * the quant and revision are optional; sparse evidence stays sparse; a write needs a pinned round or an
 * authenticated run; a model never writes its own evidence; the flag off leaves no route and no write.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');
const configLib = require('../server/config');
const { parseExactId, groupFamilies } = require('../server/bench/variant-evidence');
const { createVariantEvidenceApi } = require('../server/http/variant-evidence');

const EXACT = 'qwen/qwen3-9b-abliterated:q4_k_m@3f2a1c9';
const FAMILY = 'qwen/qwen3-9b-abliterated';

function row(over = {}) {
    return {
        id: 'bve_00000000000000000000000000',
        exact_id: EXACT,
        family: FAMILY,
        quant: 'q4_k_m',
        revision: '3f2a1c9',
        source_kind: 'round',
        source_id: 'brd_00000000000000000000000000',
        provenance: { kind: 'round', id: 'brd_00000000000000000000000000', receipt: 'a'.repeat(64) },
        measured_at: '2026-11-04T10:00:00.000Z',
        sample_count: 4,
        success_count: 3,
        timeout_count: 1,
        ttft_p50_ms: 210,
        ttft_p95_ms: 480,
        prefill_tokens_per_s: 1420,
        decode_tokens_per_s: 86.5,
        cold_start_ms: 5300,
        created_by: 'service:codes',
        created_at: '2026-11-04T10:00:01.000Z',
        ...over,
    };
}

(async () => {
    await check('the flag is off by default and the route factory exists only for the on path', async () => {
        assert.strictEqual(configLib.load({ NODE_ENV: 'test' }).bench.variantEvidence, false);
        assert.strictEqual(configLib.load({ NODE_ENV: 'test', BENCH_VARIANT_EVIDENCE: '1' }).bench.variantEvidence, true);
        assert.strictEqual(typeof createVariantEvidenceApi, 'function');
    });

    await check('the exact id parses the family, quant and revision, each optional', async () => {
        const full = parseExactId(EXACT);
        assert.strictEqual(full.ok, true);
        assert.strictEqual(full.value.family, FAMILY);
        assert.strictEqual(full.value.quant, 'q4_k_m');
        assert.strictEqual(full.value.revision, '3f2a1c9');
        const bare = parseExactId('qwen/qwen3-9b');
        assert.strictEqual(bare.ok, true);
        assert.strictEqual(bare.value.family, 'qwen/qwen3-9b');
        assert.strictEqual(bare.value.quant, null);
        assert.strictEqual(bare.value.revision, null);
        const quantOnly = parseExactId('qwen/qwen3-9b:q8_0');
        assert.strictEqual(quantOnly.value.quant, 'q8_0');
        assert.strictEqual(quantOnly.value.revision, null);
        const revisionOnly = parseExactId('qwen/qwen3-9b@main');
        assert.strictEqual(revisionOnly.value.quant, null);
        assert.strictEqual(revisionOnly.value.revision, 'main');
        for (const bad of ['qwen', 'qwen/', '/qwen3', 'qwen/qwen3@', 'qwen/qwen3:q4:extra', 'qwen/qwen3@a@b', 'qwen/qwen 3']) {
            assert.strictEqual(parseExactId(bad).ok, false, bad);
        }
    });

    await check('the family groups every quant and revision of one org/model, with its own counts', async () => {
        const families = groupFamilies([
            row(),
            row({ id: 'bve_11111111111111111111111111', exact_id: 'qwen/qwen3-9b-abliterated:q8_0@rev2', quant: 'q8_0', revision: 'rev2', sample_count: 20, success_count: 20, timeout_count: 0 }),
            row({ id: 'bve_22222222222222222222222222', exact_id: 'other/model:q4@main', family: 'other/model', quant: 'q4', revision: 'main', sample_count: 1, success_count: null }),
        ]);
        assert.strictEqual(families.length, 2);
        const qwen = families.find((f) => f.family === FAMILY);
        assert.ok(qwen);
        assert.strictEqual(qwen.variants.length, 2);
        assert.deepStrictEqual(qwen.quants, ['q4_k_m', 'q8_0']);
        assert.deepStrictEqual(qwen.revisions, ['3f2a1c9', 'rev2']);
        assert.strictEqual(qwen.sample_count, 24);
        const q4 = qwen.variants.find((v) => v.quant === 'q4_k_m');
        assert.strictEqual(q4.sample_count, 4);
        assert.strictEqual(q4.sparse, true);
        assert.strictEqual(q4.success_rate, 0.75);
        assert.strictEqual(q4.metrics.ttft_p95_ms, 480);
    });

    const t = await boot({ env: { BENCH_VARIANT_EVIDENCE: '1' } });
    const alice = t.network.addUser('alice');
    const roundWriter = t.network.serviceToken({ sub: 'svc:codes', audience: 'openvibe.bench', cap: ['bench.entry.create'] });
    const publishers = t.network.serviceToken({ sub: 'svc:codes', audience: 'openvibe.bench', cap: ['bench.entry.create', 'bench.run.publish', 'bench.benchmark.write'] });
    const wrongCap = t.network.serviceToken({ sub: 'svc:reader', audience: 'openvibe.bench', cap: ['bench.round.read'] });
    const secret = 'ZZ-PRIVATE-PROMPT-DO-NOT-STORE';
    const secretOutput = 'ZZ-PRIVATE-OUTPUT-DO-NOT-STORE';

    let finishedRound;
    let benchmarkId;
    let verifiedRunId;

    await check('a person starts a round and the job pins it with a receipt', async () => {
        const task = await t.get('/api/v1/kinds/design.page/tasks', { as: alice, json: { prompt: `A landing page for a tiny robot. ${secret}`, public: true } });
        assert.strictEqual(task.status, 201, task.text);
        const queued = await t.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { as: alice, json: {} });
        assert.strictEqual(queued.status, 201, queued.text);
        await t.tick();
        const round = await t.get(`/api/v1/rounds/${queued.json().round.id}`, { as: alice });
        assert.strictEqual(round.json().round.status, 'finished');
        assert.ok(round.json().round.receipt);
        finishedRound = round.json().round;
    });

    await check('a pinned-round write records the typed numbers', async () => {
        const written = await t.get('/api/v1/variant-evidence', {
            bearer: roundWriter,
            json: {
                exact_id: EXACT,
                source: { kind: 'round', id: finishedRound.id },
                sample_count: 4,
                ttft_p50_ms: 210,
                ttft_p95_ms: 480,
                prefill_tokens_per_s: 1420,
                decode_tokens_per_s: 86.5,
                cold_start_ms: 5300,
                success_count: 3,
                timeout_count: 1,
                measured_at: '2026-11-04T10:00:00.000Z',
                // A caller may send these; they are ignored and never stored.
                prompt: secret,
                output: secretOutput,
            },
        });
        assert.strictEqual(written.status, 201, written.text);
        const ev = written.json().evidence;
        assert.strictEqual(ev.exact_id, EXACT);
        assert.strictEqual(ev.family, FAMILY);
        assert.strictEqual(ev.sample_count, 4);
        assert.strictEqual(ev.success_rate, 0.75);
        assert.strictEqual(ev.timeout_rate, 0.25);
        assert.strictEqual(ev.metrics.ttft_p50_ms, 210);
        assert.strictEqual(ev.provenance.kind, 'round');
        assert.strictEqual(ev.provenance.receipt, finishedRound.receipt);
        assert.strictEqual(ev.sparse, true);
        assert.strictEqual(ev.confidence.level, 'sparse');
        assert.strictEqual(ev.confidence.success_rate.estimate, 0.75);
    });

    await check('a sparse exact id stays sparse and is never filled from its family', async () => {
        const dense = await t.get('/api/v1/variant-evidence', {
            bearer: roundWriter,
            json: {
                exact_id: 'qwen/qwen3-9b-abliterated:q8_0@rev2',
                source: { kind: 'round', id: finishedRound.id },
                sample_count: 50,
                success_count: 49,
                timeout_count: 1,
                ttft_p50_ms: 150,
                ttft_p95_ms: 300,
                prefill_tokens_per_s: 2000,
                decode_tokens_per_s: 120,
            },
        });
        assert.strictEqual(dense.status, 201, dense.text);
        const family = await t.get(`/api/v1/variant-families/${encodeURIComponent(FAMILY)}`);
        assert.strictEqual(family.status, 200, family.text);
        const variants = family.json().family.variants;
        assert.strictEqual(variants.length, 2);
        const q4 = variants.find((v) => v.exact_id === EXACT);
        assert.strictEqual(q4.sample_count, 4);
        assert.strictEqual(q4.sparse, true);
        assert.strictEqual(q4.metrics.decode_tokens_per_s, 86.5);
        const q8 = variants.find((v) => v.exact_id.includes('q8_0'));
        assert.strictEqual(q8.sample_count, 50);
        assert.strictEqual(q8.sparse, false);
        assert.strictEqual(q8.confidence.level, 'moderate');

        const one = await t.get(`/api/v1/variant-evidence/${encodeURIComponent(EXACT)}`);
        assert.strictEqual(one.status, 200, one.text);
        assert.strictEqual(one.json().evidence.sample_count, 4);
        assert.strictEqual(one.json().evidence.metrics.decode_tokens_per_s, 86.5);
    });

    await check('the family index groups one org/model and hides no sparse variant', async () => {
        const list = await t.get('/api/v1/variant-families');
        assert.strictEqual(list.status, 200, list.text);
        const qwen = list.json().families.find((f) => f.family === FAMILY);
        assert.ok(qwen);
        assert.strictEqual(qwen.variants.length, 2);
        assert.strictEqual(qwen.sample_count, 54);
        const all = await t.get(`/api/v1/variant-evidence?family=${encodeURIComponent(FAMILY)}`);
        assert.strictEqual(all.status, 200, all.text);
        assert.strictEqual(all.json().count, 2);
    });

    await check('nothing in the evidence rows or the read API carries the private prompt or output', async () => {
        const rows = await t.ctx.s.db.many('SELECT * FROM bench_variant_evidence');
        const stored = JSON.stringify(rows);
        assert.ok(!stored.includes(secret), 'the prompt was stored in the evidence rows');
        assert.ok(!stored.includes(secretOutput), 'the output was stored in the evidence rows');
        const read = await t.get(`/api/v1/variant-evidence/${encodeURIComponent(EXACT)}`);
        assert.ok(!read.text.includes(secret));
        assert.ok(!read.text.includes(secretOutput));
        for (const key of ['prompt', 'output', 'payload', 'transcript']) assert.ok(!(key in read.json().evidence), key);
    });

    await check('an unauthenticated write is refused and a person is not a provenance writer', async () => {
        const anon = await t.get('/api/v1/variant-evidence', { json: { exact_id: EXACT, source: { kind: 'round', id: finishedRound.id }, sample_count: 1 } });
        assert.strictEqual(anon.status, 401, anon.text);
        const person = await t.get('/api/v1/variant-evidence', { as: alice, json: { exact_id: EXACT, source: { kind: 'round', id: finishedRound.id }, sample_count: 1 } });
        assert.strictEqual(person.status, 403, person.text);
        const noCap = await t.get('/api/v1/variant-evidence', { bearer: wrongCap, json: { exact_id: EXACT, source: { kind: 'round', id: finishedRound.id }, sample_count: 1 } });
        assert.strictEqual(noCap.status, 403, noCap.text);
    });

    await check('a queued round is not pinned provenance', async () => {
        const task = await t.get('/api/v1/kinds/design.page/tasks', { as: alice, json: { prompt: 'A second page.', public: true } });
        const queued = await t.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { as: alice, json: {} });
        const written = await t.get('/api/v1/variant-evidence', {
            bearer: roundWriter,
            json: { exact_id: 'qwen/qwen3-9b@queued', source: { kind: 'round', id: queued.json().round.id }, sample_count: 1 },
        });
        assert.strictEqual(written.status, 409, written.text);
        assert.strictEqual(written.json().code, 'bench.round_not_pinned');
    });

    await check('a model agent may not write evidence about itself', async () => {
        // A service token whose identity claims the model it would measure: the sub is a valid service sub, and the
        // model claim is what names the model. Bench refuses it even though the capability is present.
        const now = Math.floor(Date.now() / 1000);
        const self = t.network.signJwt({
            iss: t.network.issuer(), sub: 'svc:model-runner', actor_type: 'service', aud: ['openvibe.bench'],
            cap: ['bench.entry.create'], ns: [], model: FAMILY, iat: now, exp: now + 300, jti: crypto.randomUUID(),
        });
        const written = await t.get('/api/v1/variant-evidence', {
            bearer: self,
            json: { exact_id: EXACT, source: { kind: 'round', id: finishedRound.id }, sample_count: 2, success_count: 2 },
        });
        assert.strictEqual(written.status, 403, written.text);
        assert.strictEqual(written.json().code, 'bench.self_rating');
    });

    await check('an authenticated verified run is provenance too', async () => {
        const definition = {
            title: 'Variant evidence run', description: 'A run for the P6 evidence path.', kind: 'games.play',
            tags: ['evidence'], visibility: 'public',
            tasks: [{ id: 't1', prompt: 'Play the game.', files: [], expected: null, holdout: false }],
            judges: [{ type: 'human_pairwise', version: '1.0', config: {} }],
            scoring: { method: 'mean', scale: { min: 0, max: 100 } },
            limits: { ms: 120000, tokens: 200000, usd: 0.5 },
            matrix: { models: ['acme/model'], harnesses: ['run'] },
        };
        const created = await t.get('/api/v1/benchmarks', { bearer: publishers, json: definition });
        assert.strictEqual(created.status, 201, created.text);
        benchmarkId = created.json().benchmark.id;
        const frozen = await t.get(`/api/v1/benchmarks/${benchmarkId}/versions`, { bearer: publishers, json: {} });
        assert.strictEqual(frozen.status, 201, frozen.text);
        const run = await t.get('/api/v1/runs', {
            bearer: publishers,
            json: {
                benchmark: `${benchmarkId}@1`,
                model: 'acme/model:q4@rev9',
                route: { provider: 'acme' }, provider: 'acme',
                harness: { name: 'run', version: '1.0' },
                settings: {}, executor: { kind: 'run', id: 'job_00000000000000000000000000' },
                tasks: [{ task_id: 't1', score: 90, cost_usd: 0.01, ms: 1000, tokens: 100, artifacts: [] }],
                score: 90, cost_usd: 0.01, ms: 1000, tokens: 100,
            },
        });
        assert.strictEqual(run.status, 201, run.text);
        verifiedRunId = run.json().run.id;
        const written = await t.get('/api/v1/variant-evidence', {
            bearer: publishers,
            json: {
                exact_id: 'acme/model:q4@rev9',
                source: { kind: 'run', id: verifiedRunId },
                sample_count: 12, success_count: 12, timeout_count: 0,
                ttft_p50_ms: 90, ttft_p95_ms: 140, prefill_tokens_per_s: 900, decode_tokens_per_s: 70,
                measured_at: '2026-11-04T11:00:00.000Z',
            },
        });
        assert.strictEqual(written.status, 201, written.text);
        assert.strictEqual(written.json().evidence.provenance.kind, 'run');
        assert.strictEqual(written.json().evidence.provenance.verified, true);
        assert.strictEqual(written.json().evidence.provenance.bench_run_id, verifiedRunId);
        assert.strictEqual(written.json().evidence.confidence.level, 'low');
    });

    await check('an authenticated Run job id is recorded as run provenance', async () => {
        const jobId = 'job_01JZ0000000000000000000000';
        const written = await t.get('/api/v1/variant-evidence', {
            bearer: publishers,
            json: {
                exact_id: 'acme/model:q8_0@rev10',
                source: { kind: 'run', id: jobId },
                sample_count: 30, success_count: 30, timeout_count: 0,
                ttft_p50_ms: 80, ttft_p95_ms: 120,
            },
        });
        assert.strictEqual(written.status, 201, written.text);
        assert.strictEqual(written.json().evidence.provenance.kind, 'run');
        assert.strictEqual(written.json().evidence.provenance.id, jobId);
        assert.strictEqual(written.json().evidence.provenance.executor, 'run');
        assert.strictEqual(written.json().evidence.provenance.verified, false);
    });

    await check('a submitted run is not evidence, and a missing source is a 404', async () => {
        const submitted = await t.get('/api/v1/runs', {
            as: alice,
            json: {
                benchmark: `${benchmarkId}@1`, model: 'acme/model:q4@rev9',
                route: { provider: 'acme' }, provider: 'acme', harness: { name: 'run', version: '1.0' },
                settings: {}, tasks: [{ task_id: 't1', score: 80, cost_usd: 0.01, ms: 1000, tokens: 100, artifacts: [] }],
                score: 80, cost_usd: 0.01, ms: 1000, tokens: 100,
            },
        });
        assert.strictEqual(submitted.status, 201, submitted.text);
        const refused = await t.get('/api/v1/variant-evidence', {
            bearer: publishers,
            json: { exact_id: 'acme/model:q4@rev9', source: { kind: 'run', id: submitted.json().run.id }, sample_count: 5 },
        });
        assert.strictEqual(refused.status, 409, refused.text);
        assert.strictEqual(refused.json().code, 'bench.run_not_verified');
        const missing = await t.get('/api/v1/variant-evidence', {
            bearer: roundWriter,
            json: { exact_id: 'acme/model:q4@rev9', source: { kind: 'round', id: 'brd_00000000000000000000000000' }, sample_count: 5 },
        });
        assert.strictEqual(missing.status, 404, missing.text);
        assert.strictEqual(missing.json().code, 'bench.round_not_found');
    });

    await t.close();

    const off = await boot();
    await check('the flag off leaves the routes absent and the rest of Bench unchanged', async () => {
        assert.strictEqual(off.config.bench.variantEvidence, false);
        const families = await off.get('/api/v1/variant-families');
        assert.strictEqual(families.status, 404, families.text);
        assert.strictEqual(families.json().code, 'route.not_found');
        const writer = off.network.serviceToken({ sub: 'svc:codes', audience: 'openvibe.bench', cap: ['bench.entry.create'] });
        const write = await off.get('/api/v1/variant-evidence', { bearer: writer, json: { exact_id: EXACT, source: { kind: 'round', id: 'brd_00000000000000000000000000' }, sample_count: 1 } });
        assert.strictEqual(write.status, 404, write.text);
        const kinds = await off.get('/api/v1/kinds');
        assert.strictEqual(kinds.status, 200, kinds.text);
    });
    await off.close();

    done();
})();

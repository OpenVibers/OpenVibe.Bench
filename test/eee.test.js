'use strict';

/**
 * Every Eval Ever (B2): importing the EEE datastore as external results, the licence gate, the resumable weekly
 * sync, the exporter of Bench's own runs as EEE, and the routes that serve both.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');
const eeeLib = require('../server/bench/eee');
const { createEeeSync } = require('../server/bench/eee-sync');
require('../server/http/eee');

// The operator routes read the token from the environment at mount time (as server/http/mirror.js does).
process.env.BENCH_ADMIN_TOKEN = process.env.BENCH_ADMIN_TOKEN || 'op-secret';

const FIX = path.join(__dirname, 'fixtures', 'eee');
const record = () => JSON.parse(fs.readFileSync(path.join(FIX, 'record.json'), 'utf8'));

function definition(over = {}) {
    return {
        title: 'EEE export benchmark',
        description: 'A public benchmark for the exporter.',
        kind: 'text.answer',
        tags: ['test'],
        visibility: 'public',
        tasks: [
            { id: 't1', prompt: 'One.', files: [], expected: null, holdout: false },
            { id: 't2', prompt: 'Two.', files: [], expected: null, holdout: false },
        ],
        judges: [],
        scoring: { method: 'mean', scale: { min: 0, max: 100 } },
        limits: {},
        matrix: {},
        ...over,
    };
}

(async () => {
    // ── the join rule and the licence gate ───────────────────────────────────────────────────────────────────
    await check('a model name drops the maker prefix but keeps its version; the family is separate', () => {
        assert.strictEqual(eeeLib.bareModel('openai/gpt-5-nano-2025-08-07'), 'gpt-5-nano-2025-08-07');
        assert.strictEqual(eeeLib.modelFamilyOf('openai/gpt-5-nano-2025-08-07'), 'gpt-5-nano');
        assert.strictEqual(eeeLib.bareModel('anthropic/claude-3-7-sonnet-20250219'), 'claude-3-7-sonnet-20250219');
        assert.strictEqual(eeeLib.modelFamilyOf('anthropic/claude-3-7-sonnet-20250219'), 'claude-3-7-sonnet');
        assert.strictEqual(eeeLib.bareModel('meta-llama/Llama-3.1-8B-Instruct'), 'llama-3.1-8b-instruct');
        assert.strictEqual(eeeLib.bareModel('gpt-4o-latest'), 'gpt-4o-latest');
        assert.strictEqual(eeeLib.modelFamilyOf('gpt-4o-latest'), 'gpt-4o');
        assert.strictEqual(eeeLib.bareModel('openai/gpt-5-nano'), 'gpt-5-nano');
    });

    await check('a licence that forbids redistribution is refused, a stated open one is kept', () => {
        assert.ok(eeeLib.allowsRedistribution('MIT'));
        assert.ok(eeeLib.allowsRedistribution('apache-2.0'));
        assert.ok(eeeLib.allowsRedistribution('cc-by-4.0'));
        assert.ok(eeeLib.allowsRedistribution('cc-by-nc-4.0'));
        assert.ok(!eeeLib.allowsRedistribution('All rights reserved'));
        assert.ok(!eeeLib.allowsRedistribution('proprietary'));
        assert.ok(!eeeLib.allowsRedistribution('research only'));
        assert.ok(!eeeLib.allowsRedistribution('unknown'));
        assert.ok(!eeeLib.allowsRedistribution(''));
    });

    await check('one EEE record is read into its results, with provenance and the join name', () => {
        const doc = record();
        // A licence the datastore card actually stated applies to a record that states none of its own.
        const parsed = eeeLib.normalizeRecord(doc, { path: 'data/IFEval/x.json', fallbackLicence: 'MIT' });
        assert.strictEqual(parsed.record.eee_id, doc.evaluation_id);
        assert.strictEqual(parsed.record.source_type, 'documentation');
        assert.strictEqual(parsed.record.model, 'llama-pro-8b-instruct');
        assert.strictEqual(parsed.record.model_family, 'llama-pro-8b-instruct');
        assert.strictEqual(parsed.record.model_raw, 'TencentARC/LLaMA-Pro-8B-Instruct');
        assert.strictEqual(parsed.record.developer, 'TencentARC');
        assert.strictEqual(parsed.results.length, 6);
        const ifeval = parsed.results.find((r) => r.task === 'IFEval');
        assert.ok(ifeval, 'IFEval is there');
        assert.strictEqual(ifeval.score, 0.4486);
        assert.strictEqual(ifeval.metric_name, 'score');
        assert.match(ifeval.source_url, /^https:\/\//);
        assert.strictEqual(parsed.record.licence, 'MIT', 'the read datastore card licence is the fallback');
        assert.strictEqual(parsed.record.licence_read, true);
        assert.strictEqual(parsed.record.republishable, true);
    });

    await check('a record that states a non-redistributable licence is dropped, and the reason is recorded', () => {
        const doc = record();
        doc.source_metadata.additional_details = { license: 'All rights reserved' };
        const parsed = eeeLib.normalizeRecord(doc);
        assert.strictEqual(parsed.results.length, 6);
        assert.ok(parsed.results.every((r) => r.dropped === 'licence'), 'every result is dropped for licence');
    });

    await check('few-shot, task version, seed and the harness are kept when the record states them', () => {
        const doc = record();
        doc.eval_library = { name: 'inspect_ai', version: '0.3.75' };
        doc.evaluation_results[0].source_data.additional_details = { task_version: '2', num_fewshot: 5 };
        doc.evaluation_results[0].generation_config = { generation_args: { temperature: 0.2, seed: 7 } };
        const parsed = eeeLib.normalizeRecord(doc);
        const first = parsed.results[0];
        assert.strictEqual(parsed.record.harness_name, 'inspect_ai');
        assert.strictEqual(parsed.record.harness_version, '0.3.75');
        assert.strictEqual(first.task_version, '2');
        assert.strictEqual(first.few_shot, 5);
        assert.strictEqual(first.seed, '7');
    });

    await check('the weekly job starts only when the owner turns it on', async () => {
        const settings = { intervalMs: 60_000, filesPerRun: 1, recordsPerRun: 1 };
        const off = createEeeSync({
            eee: { sync: async () => ({ status: 'finished' }) },
            config: { drill: true, bench: { eee: { ...settings, enabled: true, enabledInDrill: false } } },
            log: { warn() {} },
        });
        assert.strictEqual(off.start(), null, 'never under the drill');
        const on = createEeeSync({
            eee: { sync: async () => ({ status: 'finished' }) },
            config: { drill: true, bench: { eee: { ...settings, enabled: true, enabledInDrill: true } } },
            log: { warn() {} },
        });
        assert.ok(on.start(), 'a timer when it is allowed');
        on.stop();
    });

    const t = await boot({ env: { BENCH_ADMIN_TOKEN: 'op-secret' } });
    // A public benchmark with one verified run, for the exporter.
    const made = await t.ctx.registry.createBenchmark({
        owner: 'openvibe', title: 'EEE export benchmark', kind: 'text.answer', visibility: 'public', subject: 'openvibe',
    });
    assert.ok(made.ok, made.message);
    const frozen = await t.ctx.registry.freezeVersion(made.benchmark.id, { definition: definition(), subject: 'openvibe' });
    assert.ok(frozen.ok, frozen.message);
    const published = await t.ctx.registry.publishRun({
        benchmark: `${made.benchmark.id}@${frozen.version.version}`,
        model: 'openai/gpt-5-nano-2025-08-07', provider: 'openai',
        route: { provider: 'openai', model: 'openai/gpt-5-nano' },
        harness: { name: 'lm-evaluation-harness', version: '0.4.2' },
        settings: { temperature: 0, seed: '7', few_shot: 5 },
        tasks: [
            { task_id: 't1', score: 80, cost_usd: 0.01, ms: 1000, tokens: 100, artifacts: [] },
            { task_id: 't2', score: 60, cost_usd: 0.02, ms: 2000, tokens: 200, transcript_url: 'https://example.test/t2' },
        ],
        score: 70, cost_usd: 0.03, ms: 3000, tokens: 300,
    }, { provenance: 'verified', subject: 'service:codes' });
    assert.ok(published.ok, published.message);

    await check('the imported record lands as external rows, deduped, with external: true', async () => {
        const eee = t.ctx.eee;
        const doc = record();
        const first = await eee.storeRecord(doc, { path: 'data/IFEval/x.json', readAt: t.ctx.s.iso() });
        assert.strictEqual(first.read, 6);
        assert.strictEqual(first.kept, 6);
        const again = await eee.storeRecord(doc, { path: 'data/IFEval/x.json', readAt: t.ctx.s.iso() });
        assert.strictEqual(again.kept, 6, 'the second store updates the same rows');
        assert.strictEqual(await eee.countRecords(), 6, 'no duplicate rows');

        const rows = await eee.listRecords({ task: 'IFEval' });
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].external, true);
        assert.strictEqual(rows[0].licence, null, 'no card was read, so no licence is claimed');
        assert.strictEqual(rows[0].licence_label, 'Licence unknown');
        assert.strictEqual(rows[0].republishable, false);
        assert.strictEqual(rows[0].source_type, 'documentation');
        assert.strictEqual(rows[0].model, 'llama-pro-8b-instruct');
        assert.ok(rows[0].provenance.source_metadata, 'the record provenance travels with it');
    });

    await check('the external records are served as JSON, marked external, and never rated', async () => {
        const out = await t.get('/api/v1/external/records?task=IFEval');
        assert.strictEqual(out.status, 200, out.text.slice(0, 200));
        const body = out.json();
        assert.strictEqual(body.external, true);
        assert.strictEqual(body.total, 1);
        assert.strictEqual(body.records[0].external, true);
        assert.strictEqual(body.records[0].score, 0.4486);
        // Not in the ratings: nothing external is a Bench run.
        const rated = await t.ctx.s.db.maybe("SELECT COUNT(*)::int AS n FROM bench_runs WHERE model = 'llama-pro-8b-instruct'");
        assert.strictEqual(rated.n, 0, 'an external record never becomes a Bench run');
    });

    await check('a public Bench run is exported as an EEE evaluation_run record', async () => {
        const records = await t.ctx.eee.exportRecords({ limit: 10 });
        const mine = records.find((r) => r.evaluation_id === `openvibe-bench/${published.run.id}`);
        assert.ok(mine, 'the run is there');
        assert.strictEqual(mine.schema_version, '0.3.0');
        assert.strictEqual(mine.source_metadata.source_type, 'evaluation_run');
        assert.strictEqual(mine.source_metadata.source_name, 'OpenVibe.Bench');
        assert.strictEqual(mine.eval_library.name, 'lm-evaluation-harness');
        assert.strictEqual(mine.eval_library.version, '0.4.2');
        assert.strictEqual(mine.model_info.name, 'openai/gpt-5-nano-2025-08-07');
        assert.strictEqual(mine.evaluation_results.length, 1);
        assert.strictEqual(mine.evaluation_results[0].score_details.score, 70);
        assert.strictEqual(mine.evaluation_results[0].score_details.uncertainty.num_samples, 2);
        assert.strictEqual(mine.evaluation_results[0].metric_config.min_score, 0);
        assert.strictEqual(mine.evaluation_results[0].metric_config.max_score, 100);
        assert.ok(mine.evaluation_results[0].source_data.additional_details.samples_url, 'the per-sample URL is named');
        assert.ok(!('extra' in mine), 'no top-level key outside the EEE schema');
        // It is importable as EEE too: the round trip is the schema check a test can make without a validator.
        const back = t.ctx.eee.normalizeRecord(mine);
        assert.strictEqual(back.results.length, 1);
        assert.strictEqual(back.record.model, 'gpt-5-nano-2025-08-07', 'the export keeps the version');
        assert.strictEqual(back.record.model_family, 'gpt-5-nano');
    });

    await check('a public run with no score is not exported as a zero', async () => {
        const pending = await t.ctx.registry.publishRun({
            benchmark: `${made.benchmark.id}@${frozen.version.version}`,
            model: 'openai/gpt-5-nano-2026-09', provider: 'openai',
            route: {},
            harness: { name: 'lm-evaluation-harness', version: '0.4.2' },
            settings: {},
            tasks: [{ task_id: 't1', score: null, cost_usd: null, ms: null, tokens: null, artifacts: [] }],
            score: null, cost_usd: null, ms: null, tokens: null,
        }, { provenance: 'verified', subject: 'service:codes' });
        assert.ok(pending.ok, pending.message);
        const records = await t.ctx.eee.exportRecords({ limit: 100 });
        assert.ok(!records.some((r) => r.evaluation_id === `openvibe-bench/${pending.run.id}`), 'no false 0');
        assert.ok(records.every((r) => r.evaluation_results[0].score_details.score != null), 'every exported score was measured');
    });

    await check('the EEE dataset is served as paged JSONL, and the samples as their own JSONL', async () => {
        const out = await t.get('/api/v1/datasets/eee?limit=10');
        assert.strictEqual(out.status, 200, out.text.slice(0, 200));
        assert.match(String(out.headers.get('content-type')), /ndjson/);
        const total = Number(out.headers.get('x-total-count'));
        assert.ok(total >= 1, 'there is at least the one public run');
        const lines = out.text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        assert.ok(lines.some((r) => r.evaluation_id === `openvibe-bench/${published.run.id}`));
        assert.ok(lines.every((r) => r.source_metadata.source_type === 'evaluation_run'));

        const page = await t.get('/api/v1/datasets/eee?limit=1&offset=1');
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.trim().split('\n').filter(Boolean).length <= 1, 'the page is bounded');

        // The .jsonl twin is not read as the kind "eee" (the kind dataset route is mounted after this one).
        const twin = await t.get('/api/v1/datasets/eee.jsonl?limit=1');
        assert.strictEqual(twin.status, 200, twin.text.slice(0, 200));
        assert.match(String(twin.headers.get('content-type')), /ndjson/);

        const samples = await t.get(`/api/v1/datasets/eee/runs/${published.run.id}.samples.jsonl`);
        assert.strictEqual(samples.status, 200, samples.text.slice(0, 200));
        const rows = samples.text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[0].model_id, 'openai/gpt-5-nano-2025-08-07');
        assert.ok(rows.some((r) => r.transcript_url === 'https://example.test/t2'));
    });

    await check('the sync is the operator\'s route only', async () => {
        const anon = await t.get('/api/v1/admin/eee/sync', { method: 'POST', json: {} });
        assert.strictEqual(anon.status, 403, anon.text.slice(0, 120));
    });

    // ── the weekly sync: bounded, resumable, and the licence gate counted ───────────────────────────────────────
    await check('a bounded sync resumes from its cursor and counts what it dropped for licence', async () => {
        const good = record();
        const bad = record();
        bad.evaluation_id = 'hfopenllm_v2/TencentARC_LLaMA-Pro-8B-Instruct/1770682499.0';
        bad.source_metadata = { ...bad.source_metadata, additional_details: { license: 'All rights reserved' } };
        const files = {
            'data/IFEval/a/good.json': good,
            'data/IFEval/a/bad.json': bad,
        };
        const fetchImpl = async (url) => {
            const text = String(url);
            const ok = (body, type = 'json') => ({
                ok: true, status: 200,
                json: async () => (type === 'json' ? body : JSON.parse(body)),
                text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
            });
            if (text.endsWith('/README.md')) return ok('license: mit');
            if (text.includes('/tree/main/data?recursive=false')) return ok([{ type: 'directory', path: 'data/IFEval' }]);
            if (text.includes('/tree/main/data/IFEval?recursive=true')) {
                return ok(Object.keys(files).map((p) => ({ type: 'file', path: p })));
            }
            for (const [p, doc] of Object.entries(files)) if (text.endsWith('/' + p)) return ok(doc);
            return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
        };
        const eee = eeeLib.createEee({ s: t.ctx.s, registry: t.ctx.registry, fetchImpl, log: { warn() {} }, config: t.ctx.config });

        const first = await eee.sync({ maxFiles: 1, maxRecords: 100 });
        assert.strictEqual(first.status, 'running', 'one file is one pass');
        assert.strictEqual(first.files_seen, 1);
        assert.strictEqual(first.records_kept, 0, 'the first file (a/bad.json) is dropped for its licence');
        assert.strictEqual(first.dropped_licence, 6);
        assert.deepStrictEqual(first.cursor, { collection: 0, file: 1 });

        const second = await eee.sync({ maxFiles: 1, maxRecords: 100 });
        assert.strictEqual(second.id, first.id, 'it resumes the same sync');
        assert.strictEqual(second.files_seen, 2);
        assert.strictEqual(second.dropped_licence, 6, 'the bad record is counted, not stored');
        assert.strictEqual(second.records_kept, 6, 'the good record lands');
        assert.strictEqual(second.status, 'finished');
        assert.ok(second.dropped_reason && Object.keys(second.dropped_reason).some((k) => /licence/.test(k)), 'the reason is kept');
    });

    await t.close();
    done();
})().catch((err) => {
    process.stderr.write('The test file failed: ' + ((err && err.stack) || err) + '\n');
    process.exit(1);
});

'use strict';

/**
 * Importing results people bring themselves (B12): the four tools, the limits, the privacy, the account data
 * and the mirror's own rules.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');
const { uncovered } = require('openvibe-sdk/account-data');
const accountDataLib = require('../server/identity/account-data');
const importers = require('../server/bench/importers');
const limits = require('../server/bench/importers/limits');
const { matchSuite } = require('../server/bench/suites');
const { createMirror } = require('../server/bench/mirror');

const FIX = path.join(__dirname, 'fixtures', 'imports');
const read = (name) => fs.readFileSync(path.join(FIX, name));

/** A zip with the parts stored (not deflated), so the reader is tested on a real archive. */
function zipOf(parts) {
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const part of parts) {
        const name = Buffer.from(part.name, 'utf8');
        const data = Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, 'utf8');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt32LE(0, 10);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        chunks.push(local, name, data);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(0, 8);
        entry.writeUInt16LE(0, 10);
        entry.writeUInt32LE(0, 12);
        entry.writeUInt32LE(data.length, 20);
        entry.writeUInt32LE(data.length, 24);
        entry.writeUInt16LE(name.length, 28);
        entry.writeUInt16LE(0, 30);
        entry.writeUInt16LE(0, 32);
        entry.writeUInt16LE(0, 34);
        entry.writeUInt16LE(0, 36);
        entry.writeUInt32LE(0, 38);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, name);
        offset += local.length + name.length + data.length;
    }
    const centralBuffer = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(parts.length, 8);
    end.writeUInt16LE(parts.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, centralBuffer, end]);
}


/**
 * A zip that lies: each part really inflates to 'size' bytes, but the directory says it is a kilobyte.
 * This is the bomb the cap has to catch: the memory is bounded by what is really unpacked, not by the claim.
 */
function bombZip(parts) {
    const zlib = require('zlib');
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const part of parts) {
        const name = Buffer.from(part.name, 'utf8');
        const raw = Buffer.alloc(part.size, 0x61);
        const deflated = zlib.deflateRawSync(raw, { level: 9 });
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(0, 10);
        local.writeUInt32LE(0, 14);
        local.writeUInt32LE(deflated.length, 18);
        local.writeUInt32LE(part.declared, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        chunks.push(local, name, deflated);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(0, 8);
        entry.writeUInt16LE(8, 10);
        entry.writeUInt32LE(0, 12);
        entry.writeUInt32LE(0, 16);
        entry.writeUInt32LE(deflated.length, 20);
        entry.writeUInt32LE(part.declared, 24);
        entry.writeUInt16LE(name.length, 28);
        entry.writeUInt16LE(0, 30);
        entry.writeUInt16LE(0, 32);
        entry.writeUInt16LE(0, 34);
        entry.writeUInt16LE(0, 36);
        entry.writeUInt32LE(0, 38);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, name);
        offset += local.length + name.length + deflated.length;
    }
    const centralBuffer = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(parts.length, 8);
    end.writeUInt16LE(parts.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, centralBuffer, end]);
}

/** A multipart body with one file part, the way a browser sends it. */
function multipart(filename, bytes) {
    const boundary = '----b12fixture';
    const head = Buffer.from(
        '--' + boundary + '\r\n'
        + 'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n'
        + 'Content-Type: application/octet-stream\r\n\r\n', 'utf8');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8');
    return { body: Buffer.concat([head, bytes, tail]), type: 'multipart/form-data; boundary=' + boundary };
}

(async () => {
    // ── the parsers, on the published shapes ─────────────────────────────────────────────────────────────────
    await check('the Inspect log is read: the model, its score and its tasks', () => {
        const out = importers.parse(read('inspect-log.json'), { filename: 'log.json' });
        assert.strictEqual(out.tool, 'inspect');
        assert.strictEqual(out.toolVersion, '0.3.286');
        assert.strictEqual(out.models.length, 1);
        assert.strictEqual(out.models[0].model, 'openai/gpt-4o');
        assert.strictEqual(out.models[0].provider, 'openai');
        assert.ok(Math.abs(out.models[0].score - 66.6666) < 0.01, 'the score is out of 100: ' + out.models[0].score);
        assert.strictEqual(out.models[0].tasks.length, 3);
        assert.strictEqual(out.models[0].cost_usd, 0.42);
        assert.strictEqual(out.suite.name, 'mmlu');
    });

    await check('an .eval zip is opened in memory', () => {
        const zip = zipOf([{ name: 'logs/2026-10-01.json', data: read('inspect-log.json') }]);
        const out = importers.parse(zip, { filename: 'run.eval' });
        assert.strictEqual(out.tool, 'inspect');
        assert.strictEqual(out.models[0].model, 'openai/gpt-4o');
    });

    await check('the Harbor results are read: one model, the reward of every trial', () => {
        const out = importers.parse(read('harbor-results.json'), { filename: 'results.json' });
        assert.strictEqual(out.tool, 'harbor');
        assert.strictEqual(out.models.length, 1);
        assert.strictEqual(out.models[0].model, 'claude-sonnet-4');
        assert.strictEqual(out.models[0].provider, 'anthropic');
        assert.strictEqual(out.models[0].tasks.length, 2);
        assert.strictEqual(out.models[0].tasks[0].score, 100);
        assert.strictEqual(out.models[0].tasks[1].score, 0);
    });

    await check('the lm-evaluation-harness results are read: the model and its subtasks', () => {
        const out = importers.parse(read('lm-eval-results.json'), { filename: 'results.json' });
        assert.strictEqual(out.tool, 'lm-eval');
        assert.strictEqual(out.models[0].model, 'meta-llama/Llama-3-8B');
        assert.strictEqual(out.models[0].tasks.length, 2);
        assert.strictEqual(out.suite.name, 'mmlu');
    });

    await check('the promptfoo results are read: one run per provider', () => {
        const out = importers.parse(read('promptfoo-output.json'), { filename: 'output.json' });
        assert.strictEqual(out.tool, 'promptfoo');
        assert.strictEqual(out.models.length, 2);
        const gpt = out.models.find((m) => m.model === 'openai:gpt-4o');
        assert.ok(gpt, 'the openai run is there');
        assert.strictEqual(gpt.tasks.length, 2);
        assert.strictEqual(gpt.cost_usd, 0.007);
    });

    // ── the limits ─────────────────────────────────────────────────────────────────────────────────────────
    await check('a file over 20 MB is refused', () => {
        assert.throws(() => importers.parse(Buffer.alloc(20 * 1024 * 1024 + 1)), /20 MB|too large/i);
    });

    await check('a zip that claims more than it holds is refused', () => {
        const zip = zipOf([{ name: 'logs/x.json', data: read('inspect-log.json') }]);
        // Say the entry unpacks to 200 MB: a bomb, and it is refused before anything is inflated.
        const centralAt = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        zip.writeUInt32LE(200 * 1024 * 1024, centralAt + 24);
        assert.throws(() => limits.readZip(zip), /100 MB|unpacks/i);
    });


    await check('a zip that lies about its size is refused at the real cap, and the memory stays bounded', () => {
        const rssBefore = process.memoryUsage().rss;
        const zip = bombZip([
            { name: 'logs/one.json', size: 60 * 1024 * 1024, declared: 1024 },
            { name: 'logs/two.json', size: 60 * 1024 * 1024, declared: 1024 },
        ]);
        let caught = null;
        try {
            limits.jsonPartsOfZip(zip);
        } catch (err) {
            caught = err;
        }
        assert.ok(caught, 'the bomb is refused');
        assert.strictEqual(caught.code, 'bench.import_unpacks_too_much');
        assert.strictEqual(caught.status, 413);
        assert.ok(caught.inflated <= limits.MAX_DECOMPRESSED_BYTES,
            'the bytes really unpacked stay under the cap: ' + caught.inflated);
        const grew = process.memoryUsage().rss - rssBefore;
        assert.ok(grew < 250 * 1024 * 1024, 'the memory stayed bounded: ' + Math.round(grew / 1048576) + ' MB');
    });

    await check('the operator token is compared in constant time', () => {
        const { tokenMatches } = require('../server/http/mirror');
        assert.ok(tokenMatches('secret', 'secret'));
        assert.ok(!tokenMatches('secrat', 'secret'));
        assert.ok(!tokenMatches('secret', 'secre'));
        assert.ok(!tokenMatches('', 'secret'));
        assert.ok(!tokenMatches('secret', ''));
        assert.ok(!tokenMatches(null, 'secret'));
    });

    await check('a JSON that nests too deeply is refused', () => {
        const deep = '['.repeat(80) + ']'.repeat(80);
        assert.throws(() => limits.parseJson(deep), /deeply/i);
    });

    await check('a file that is none of ours is refused', () => {
        assert.throws(() => importers.parse(Buffer.from('{"hello":"world"}')), /do not know/i);
    });

    // ── the suites ───────────────────────────────────────────────────────────────────────────────────────
    await check('a known suite is matched by its name', () => {
        assert.ok(matchSuite('MMLU'));
        assert.strictEqual(matchSuite('MMLU').key, 'mmlu');
        assert.ok(matchSuite('gsm8k'));
        assert.ok(matchSuite('HumanEval'));
        assert.strictEqual(matchSuite('my own prompts'), null);
    });

    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');

    await check('the upload form sends a visitor who is not signed in to the sign-in', async () => {
        const out = await t.get('/imports');
        assert.strictEqual(out.status, 303, out.text.slice(0, 200));
        assert.ok(/\/auth\/login\?next=%2Fimports/.test(String(out.headers.get('location'))),
            'it goes to the sign-in and comes back: ' + out.headers.get('location'));
    });

    await check('the upload form is there for a signed-in person', async () => {
        const out = await t.get('/imports', { as: t.network.addUser('signer') });
        assert.strictEqual(out.status, 200, out.text.slice(0, 200));
        assert.ok(/Import a results file/.test(out.text), 'the page says what it is');
        assert.ok(/Inspect AI/.test(out.text) && /Harbor/.test(out.text), 'it names the tools it reads');
    });

    let importId = null;
    let runId = null;
    let benchmarkId = null;

    await check('an upload becomes a preview, and then submitted runs', async () => {
        const up = multipart('inspect-log.json', read('inspect-log.json'));
        const posted = await t.get('/imports', { as: alice, method: 'POST', headers: { 'content-type': up.type }, raw: up.body });
        assert.strictEqual(posted.status, 303, posted.text.slice(0, 300));
        importId = String(posted.headers.get('location') || '').split('/').pop();
        assert.ok(importId, 'the upload has an id');

        const preview = await t.get('/imports/' + importId, { as: alice });
        assert.strictEqual(preview.status, 200, preview.text.slice(0, 200));
        assert.ok(/1 model/.test(preview.text), 'the preview says what it holds: ' + preview.text.slice(0, 200));
        assert.ok(/from inspect 0\.3\.286/.test(preview.text), 'and which tool it came from');

        const done = await t.get('/imports/' + importId + '/confirm', { as: alice, method: 'POST' });
        assert.strictEqual(done.status, 303, done.text.slice(0, 300));
        benchmarkId = String(done.headers.get('location') || '').split('/').pop();

        const runs = await t.ctx.registry.listRuns({ benchmark: benchmarkId });
        assert.strictEqual(runs.length, 1);
        runId = runs[0].id;
        assert.strictEqual(runs[0].provenance, 'submitted', 'an imported run is never verified');
        assert.strictEqual(runs[0].source.kind, 'import');
        assert.strictEqual(runs[0].source.tool, 'inspect');
        assert.strictEqual(runs[0].source.tool_version, '0.3.286');
        const full = await t.ctx.registry.getRun(runId);
        assert.strictEqual(full.tasks.length, 3, 'the per-task scores came with it');
        assert.strictEqual(runs[0].harness.name, 'inspect-ai');
    });

    await check('the run page says where it came from', async () => {
        const page = await t.get('/runs/' + runId, { as: alice });
        assert.strictEqual(page.status, 200, page.text.slice(0, 200));
        assert.ok(/Imported from inspect 0\.3\.286/.test(page.text), 'the label is there');
    });

    await check('the file stays private to its owner', async () => {
        const mine = await t.get('/imports/' + importId + '/file', { as: alice });
        assert.strictEqual(mine.status, 200);
        assert.ok(mine.buffer.length > 0);
        const theirs = await t.get('/imports/' + importId + '/file', { as: bob });
        assert.strictEqual(theirs.status, 404, 'another person may not read the file');
        const other = await t.get('/imports/' + importId, { as: bob });
        assert.strictEqual(other.status, 404, 'nor see the preview');
    });

    await check('the uploads are in the account data, and the guard is happy', async () => {
        const row = accountDataLib.TABLES.find((x) => x.table === 'bench_imports');
        assert.ok(row, 'bench_imports is in the account data');
        assert.strictEqual(row.subject, 'owner');
        assert.strictEqual(row.erase, 'delete');
        const missing = await uncovered(t.ctx.s.db, {
            tables: [...accountDataLib.TABLES, ...accountDataLib.GUARDED],
            exempt: {
                account_data_events: 'the ledger of the requests themselves',
                bench_ratings: 'the ratings are an aggregate over the models',
            },
        });
        assert.deepStrictEqual(missing, [], 'a table with a person column is neither covered nor exempted: ' + missing.join(', '));
    });

    // ── the mirror ───────────────────────────────────────────────────────────────────────────────────────
    await check('the mirror reads a source under its licence, and never lands the same row twice', async () => {
        const licence = '                                 Apache License\n                           Version 2.0, January 2004\n';
        const table = [{
            title: 'MMLU',
            header: [
                { value: 'Model', metadata: {} },
                { value: 'EM', metadata: { metric: 'EM', run_group: 'MMLU' } },
            ],
            rows: [
                [{ value: 'Phi-3 (14B)' }, { value: 0.675 }],
                [{ value: 'Llama-3 (8B)' }, { value: 0.51 }],
            ],
        }];
        const fetchImpl = async (url) => {
            const text = String(url);
            if (text.includes('/LICENSE')) return { ok: true, status: 200, text: async () => licence, json: async () => ({}) };
            if (text.includes('/groups/')) return { ok: true, status: 200, text: async () => JSON.stringify(table), json: async () => table };
            return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
        };
        const mirror = createMirror({ s: t.ctx.s, registry: t.ctx.registry, fetchImpl, log: { warn() {} } });
        const looked = await mirror.preview('helm', { group: 'mmlu', release: 'v1.13.0' });
        assert.ok(looked.ok, 'the source cleared: ' + JSON.stringify(looked).slice(0, 200));
        assert.strictEqual(looked.licence, 'Apache-2.0');
        assert.strictEqual(looked.count, 2);

        const applied = await mirror.apply('helm', { group: 'mmlu', release: 'v1.13.0' });
        assert.ok(applied.ok);
        assert.strictEqual(applied.written.length, 2);
        const runs = await t.ctx.registry.listRuns({ benchmark: applied.written[0].benchmark });
        assert.strictEqual(runs.length, 2, 'one mirrored run per model');
        const mirrored = runs.find((r) => r.model === 'Phi-3 (14B)');
        assert.ok(mirrored, 'the mirrored run is there');
        assert.strictEqual(mirrored.provenance, 'submitted', 'a mirrored run is never verified');
        assert.strictEqual(mirrored.source.kind, 'mirror');
        assert.strictEqual(mirrored.source.licence, 'Apache-2.0');
        assert.ok(mirrored.source.source_url, 'it says where it came from');

        const again = await mirror.apply('helm', { group: 'mmlu', release: 'v1.13.0' });
        assert.strictEqual(again.written.length, 0, 'the same model, version and source do not land twice');
        assert.ok(again.skipped.some((x) => x.why === 'already mirrored'));
    });

    await check('a source whose licence cannot be read is not imported', async () => {
        const fetchImpl = async () => ({ ok: false, status: 401, text: async () => '', json: async () => ({}) });
        const mirror = createMirror({ s: t.ctx.s, registry: t.ctx.registry, fetchImpl, log: { warn() {} } });
        const looked = await mirror.preview('helm', { group: 'mmlu' });
        assert.ok(!looked.ok, 'it does not clear');
        assert.ok(/licence/.test(looked.reason), looked.reason);
    });

    await t.close();
    done();
})().catch((err) => {
    process.stderr.write('The test file failed: ' + ((err && err.stack) || err) + '\n');
    process.exit(1);
});

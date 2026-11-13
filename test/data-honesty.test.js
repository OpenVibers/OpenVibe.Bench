'use strict';

/**
 * Data honesty (plan 2026-11-13 §X): an unread licence is unknown, a measurement a harness did not record stays
 * null, and a model id keeps its version. One check per fix, with its fixture.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');
const eeeLib = require('../server/bench/eee');
const importers = require('../server/bench/importers');

const EEE_FIX = path.join(__dirname, 'fixtures', 'eee');
const IMPORT_FIX = path.join(__dirname, 'fixtures', 'imports');
const record = () => JSON.parse(fs.readFileSync(path.join(EEE_FIX, 'record.json'), 'utf8'));
const importFixture = (name) => fs.readFileSync(path.join(IMPORT_FIX, name));

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

(async () => {
    // ── 1. a licence that cannot be read is unknown, not MIT ─────────────────────────────────────────────────────
    await check('an unreadable licence is unknown, with a reason, and is never republishable', async () => {
        const offline = await eeeLib.datastoreLicence(async () => { throw new Error('offline'); });
        assert.strictEqual(offline.licence, null, 'no guessed MIT');
        assert.strictEqual(offline.read, false);
        assert.match(offline.reason, /could not be read/);

        const withoutCard = await eeeLib.datastoreLicence(async () => ({ ok: true, status: 200, text: async () => '# no licence line here' }));
        assert.strictEqual(withoutCard.licence, null);
        assert.strictEqual(withoutCard.read, false);
        assert.match(withoutCard.reason, /states no licence/);

        const read = await eeeLib.datastoreLicence(async () => ({ ok: true, status: 200, text: async () => 'license: mit' }));
        assert.strictEqual(read.licence, 'mit');
        assert.strictEqual(read.read, true);

        const doc = clone(record());
        doc.evaluation_id = 'data-honesty/unknown-licence';
        const parsed = eeeLib.normalizeRecord(doc, { fallbackLicenceReason: 'the dataset card could not be read' });
        assert.strictEqual(parsed.record.licence, null);
        assert.strictEqual(parsed.record.licence_source, 'unknown');
        assert.strictEqual(parsed.record.licence_read, false);
        assert.strictEqual(parsed.record.republishable, false);
        assert.match(parsed.record.licence_reason, /could not be read/);
        assert.strictEqual(parsed.results.length, 6, 'an unknown licence does not drop the record');
        assert.ok(parsed.results.every((r) => r.licence === null && r.republishable === false));

        // A licence the record itself states still applies even when the card could not be read.
        const stated = clone(record());
        stated.source_metadata.additional_details = { license: 'MIT' };
        const statedParsed = eeeLib.normalizeRecord(stated, { fallbackLicenceReason: 'the dataset card could not be read' });
        assert.strictEqual(statedParsed.record.licence, 'MIT');
        assert.strictEqual(statedParsed.record.licence_source, 'record');
        assert.strictEqual(statedParsed.record.licence_read, true);
        assert.strictEqual(statedParsed.record.republishable, true);
    });

    const t = await boot();
    const alice = t.network.addUser('alice');

    await check('the unknown licence is stored as null, labelled, and not cleared for republication', async () => {
        const doc = clone(record());
        doc.evaluation_id = 'data-honesty/unknown-licence-stored';
        doc.model_info.id = 'acme/Model-X-2026-08';
        const counts = await t.ctx.eee.storeRecord(doc, { fallbackLicence: null, fallbackLicenceReason: 'the dataset card could not be read' });
        assert.strictEqual(counts.kept, 6);

        const row = await t.ctx.s.db.maybe('SELECT licence, licence_source, licence_read, republishable, licence_reason FROM bench_eee_records WHERE eee_id = $1 LIMIT 1', [doc.evaluation_id]);
        assert.strictEqual(row.licence, null, 'null in storage');
        assert.strictEqual(row.licence_source, 'unknown');
        assert.strictEqual(row.licence_read, false);
        assert.strictEqual(row.republishable, false);
        assert.match(row.licence_reason, /could not be read/);

        const rows = await t.ctx.eee.listRecords({ task: 'IFEval' });
        const wire = rows.find((r) => r.eee_id === doc.evaluation_id);
        assert.strictEqual(wire.licence, null);
        assert.strictEqual(wire.licence_label, 'Licence unknown');
        assert.strictEqual(wire.republishable, false);
        const publicRows = await t.ctx.eee.listRecords({ task: 'IFEval', republishableOnly: true });
        assert.ok(!publicRows.some((r) => r.eee_id === doc.evaluation_id), 'never in a republishable read');
    });

    // ── 2. a missing measurement stays missing, never 0 ─────────────────────────────────────────────────────────
    await check('an import row with a missing score and a missing cost stays null, and its average skips it', async () => {
        const parsed = importers.parse(importFixture('promptfoo-missing-measurements.json'), { filename: 'output.json' });
        assert.strictEqual(parsed.tool, 'promptfoo');
        const openai = parsed.models.find((m) => m.model === 'openai:gpt-5.1-2026-08');
        const anthropic = parsed.models.find((m) => m.model === 'anthropic:claude-opus-5-5');
        assert.ok(openai && anthropic);
        assert.strictEqual(openai.score, 100, 'one measured score is the mean, not 100/3');
        assert.strictEqual(openai.score_n, 1);
        assert.strictEqual(openai.task_count, 3);
        assert.strictEqual(anthropic.score, null);
        assert.strictEqual(anthropic.score_n, 0);
        assert.strictEqual(anthropic.cost_usd, null);
        assert.strictEqual(anthropic.tokens, null);

        const upload = await t.ctx.imports.store({
            owner: alice.subject, subject: alice.subject, filename: 'promptfoo-missing-measurements.json',
            bytes: importFixture('promptfoo-missing-measurements.json'),
        });
        const summaryOpenai = upload.summary.models.find((m) => m.model === 'openai:gpt-5.1-2026-08');
        const summaryAnthropic = upload.summary.models.find((m) => m.model === 'anthropic:claude-opus-5-5');
        assert.strictEqual(summaryOpenai.score, 100);
        assert.strictEqual(summaryOpenai.scored_tasks, 1);
        assert.strictEqual(summaryOpenai.task_count, 3);
        assert.strictEqual(summaryAnthropic.score, null);
        assert.strictEqual(summaryAnthropic.cost_usd, null);
        assert.strictEqual(summaryAnthropic.tokens, null);

        const imported = await t.ctx.imports.commit(upload.id, { subject: alice.subject });
        assert.ok(imported.ok, imported.message);
        const runs = await t.ctx.registry.listRuns({ benchmark: imported.benchmark.id, limit: 10 });
        assert.strictEqual(runs.length, 2);
        const nullRun = runs.find((r) => r.model === 'anthropic:claude-opus-5-5');
        const measuredRun = runs.find((r) => r.model === 'openai:gpt-5.1-2026-08');
        assert.ok(nullRun && measuredRun);

        assert.strictEqual(nullRun.score, null);
        assert.strictEqual(nullRun.cost_usd, null, 'cost null in storage/API');
        assert.strictEqual(nullRun.ms, null, 'time null, not 0');
        assert.strictEqual(nullRun.tokens, null, 'tokens null, not 0');
        assert.strictEqual(nullRun.document.score, null);
        assert.strictEqual(nullRun.document.cost_usd, null);
        const fullNull = await t.ctx.registry.getRun(nullRun.id);
        assert.strictEqual(fullNull.document.tasks[0].cost_usd, null);
        assert.strictEqual(fullNull.tasks[0].score, null);
        assert.strictEqual(fullNull.tasks[0].cost_usd, null);
        assert.strictEqual(fullNull.tasks[0].ms, null);
        assert.strictEqual(fullNull.tasks[0].tokens, null);

        assert.strictEqual(measuredRun.score, 100);
        assert.strictEqual(measuredRun.cost_usd, 0.02);
        assert.strictEqual(measuredRun.ms, null, 'the file did not measure time');
        assert.strictEqual(measuredRun.tokens, 1000);
        assert.strictEqual(measuredRun.document.cost_usd, 0.02);
        assert.strictEqual(measuredRun.document.ms, null);

        const board = await t.ctx.registry.rankings({ benchmark: nullRun.benchmark, includeSubmitted: true });
        assert.ok(board && Array.isArray(board.entries));
        const nullEntry = board.entries.find((e) => e.model === 'anthropic:claude-opus-5-5');
        assert.strictEqual(nullEntry.score, null, 'a board cell with no score says null');
        assert.strictEqual(nullEntry.score_n, 0);
        assert.strictEqual(nullEntry.cost_usd, null);
        assert.strictEqual(nullEntry.cost_n, 0);
        assert.strictEqual(nullEntry.cost_per_solved, null);
        const measuredEntry = board.entries.find((e) => e.model === 'openai:gpt-5.1-2026-08');
        assert.strictEqual(measuredEntry.score, 100);
        assert.strictEqual(measuredEntry.score_n, 1);
        assert.strictEqual(measuredEntry.ms, null);
        assert.strictEqual(measuredEntry.speed, null);
    });

    // ── 3. the model join keeps the version; the family is separate ─────────────────────────────────────────────
    await check('two versions of one model family are two rows and one family', async () => {
        const first = clone(record());
        first.evaluation_id = 'data-honesty/gpt-5.1-2026-08';
        first.model_info = { ...first.model_info, id: 'openai/gpt-5.1-2026-08', name: 'GPT-5.1 2026-08', developer: 'openai' };
        const second = clone(first);
        second.evaluation_id = 'data-honesty/gpt-5.1-2026-09';
        second.model_info = { ...second.model_info, id: 'openai/gpt-5.1-2026-09', name: 'GPT-5.1 2026-09' };

        assert.strictEqual(eeeLib.bareModel(first.model_info.id), 'gpt-5.1-2026-08');
        assert.strictEqual(eeeLib.modelFamilyOf(first.model_info.id), 'gpt-5.1');
        assert.strictEqual(eeeLib.modelFamilyOf(second.model_info.id), 'gpt-5.1');

        const storedFirst = await t.ctx.eee.storeRecord(first, { fallbackLicence: 'MIT' });
        const storedSecond = await t.ctx.eee.storeRecord(second, { fallbackLicence: 'MIT' });
        assert.strictEqual(storedFirst.kept, 6);
        assert.strictEqual(storedSecond.kept, 6);

        const familyRows = await t.ctx.eee.listRecords({ family: 'gpt-5.1', task: 'IFEval' });
        assert.strictEqual(familyRows.length, 2, 'the family reads both versions');
        assert.deepStrictEqual(familyRows.map((r) => r.model).sort(), ['gpt-5.1-2026-08', 'gpt-5.1-2026-09']);
        assert.ok(familyRows.every((r) => r.model_family === 'gpt-5.1'));

        const oneVersion = await t.ctx.eee.listRecords({ model: 'gpt-5.1-2026-08', task: 'IFEval' });
        assert.strictEqual(oneVersion.length, 1, 'a version is not another version');
        assert.strictEqual(oneVersion[0].model, 'gpt-5.1-2026-08');
        assert.strictEqual(oneVersion[0].model_family, 'gpt-5.1');
        assert.strictEqual(oneVersion[0].model_raw, 'openai/gpt-5.1-2026-08');
        assert.strictEqual(await t.ctx.eee.countRecords({ family: 'gpt-5.1' }), 12);
    });

    await t.close();
    done();
})().catch((err) => {
    process.stderr.write('The test file failed: ' + ((err && err.stack) || err) + '\n');
    process.exit(1);
});

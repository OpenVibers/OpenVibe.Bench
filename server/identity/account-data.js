'use strict';

/**
 * Account export and deletion → Bench (ADR-033; openvibe-sdk/account-data). What Bench holds about a person:
 *
 *   theirs, and gone        the tasks and rounds they started, the private evals they own, the runs they
 *                            submitted, a private benchmark with its prompts and every run on it, the pairs they
 *                            have seen and the benchmarks they watch
 *   theirs, and kept        a judgement they cast stays (it sits under somebody else's round, so the round and
 *                            the ratings keep their place) and loses the person; a benchmark other people ran
 *                            stays as a tombstone, so their runs keep theirs
 *   not theirs              the ratings (an aggregate over the models: the subject column names a model, not a
 *                            person), the entries (a model's output) and the receipts of the requests themselves
 *
 * A benchmark and its frozen versions are the person's, but other people's runs hang under them, so what happens
 * to them depends on what else is there: a private benchmark (a person's own prompts) goes with its versions and
 * every run on it, wherever it was shared; a public or unlisted benchmark nobody else ran goes too; one others ran
 * stays as a tombstone, so their runs keep their place. extraErase decides that, and GUARDED names the tables the
 * guard needs to know about.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

// The tombstone a row keeps when it stays without its person: the column holds an id (usr_…, prj_…, a service),
// so the tombstone is a marker, not a null.
const TOMBSTONE = 'deleted';

const TABLES = [
    { table: 'bench_judgements', subject: 'subject', file: 'bench_judgements.json', erase: { anonymize: {} } },
    // The pairs they have seen go before the rounds: a seen pair hangs under a round, so the round's own deletion
    // would take it and the count would miss it. The rounds go before the tasks, which they point at.
    { table: 'bench_battle_seen', subject: 'subject', file: 'bench_battle_seen.json', erase: 'delete' },
    { table: 'bench_rounds', subject: 'created_by', file: 'bench_rounds.json', erase: 'delete' },
    { table: 'bench_tasks', subject: 'created_by', file: 'bench_tasks.json', erase: 'delete' },
    { table: 'bench_evals', subject: 'owner', file: 'bench_evals.json', erase: 'delete' },
    // The runs they submitted and the benchmarks they watch: theirs, so they go.
    { table: 'bench_runs', subject: 'created_by', file: 'bench_runs.json', erase: 'delete' },
    { table: 'bench_watches', subject: 'subject', file: 'bench_watches.json', erase: 'delete' },
    // The results files they brought (B12): theirs, so they go with them. The bytes hang off the row and go with it.
    { table: 'bench_imports', subject: 'owner', file: 'bench_imports.json', erase: 'delete' },
];

// The tables the map cannot say on its own: a benchmark and its versions are theirs, but other people's runs hang
// under them. extraErase decides; the guard needs the names.
const GUARDED = ['bench_benchmarks', 'bench_benchmark_versions'];

/** The benchmarks of the person: what they own and what they wrote, with their versions and their private runs. */
async function extraExport(db, subject) {
    const files = [];
    const benchmarks = await db.many(`SELECT id, owner, title, description, kind, tags, visibility, parent, latest_version, draft, created_by, created_at, updated_at
        FROM bench_benchmarks WHERE owner = $1 OR created_by = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (benchmarks.length) files.push({ name: 'benchmarks.json', content: benchmarks });
    const versions = await db.many(`SELECT benchmark_id, version, definition, hash, created_by, created_at FROM bench_benchmark_versions
        WHERE created_by = $1 OR benchmark_id IN (SELECT id FROM bench_benchmarks WHERE owner = $1) ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (versions.length) files.push({ name: 'benchmark_versions.json', content: versions });
    // A run on the person's own prompt benchmark is part of their data even when a service executed and published
    // it, and even if the set was shared.
    const runs = await db.many(`SELECT id, benchmark_id, benchmark_version, model, route, provider, harness, settings, hardware,
            score, cost_usd, ms, tokens, provenance, session, created_at
        FROM bench_runs WHERE benchmark_id IN (
            SELECT id FROM bench_benchmarks WHERE owner = $1
             AND (visibility = 'private' OR tags @> '["your-prompts"]'::jsonb))
        ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (runs.length) files.push({ name: 'benchmark_runs.json', content: runs });
    // The files they uploaded: the bytes are theirs too, so the export carries them.
    const uploads = await db.many(`SELECT f.import_id, i.filename, i.sha256, i.size, encode(f.content, 'base64') AS content_base64
        FROM bench_import_files f JOIN bench_imports i ON i.id = f.import_id
        WHERE i.owner = $1 OR i.created_by = $1 ORDER BY i.created_at DESC LIMIT 5000`, [subject]);
    if (uploads.length) files.push({ name: 'import_files.json', content: uploads });
    return files;
}

async function extraErase(t, subjects, counts) {
    // A private benchmark, or one made from the person's own pasted prompts (tagged your-prompts), is nothing but
    // their text: it goes with its versions and every run on it, wherever it was shared. A public or unlisted
    // benchmark another person ran stays as a tombstone, so their runs keep their place.
    const owned = await t.many('SELECT id, visibility, tags FROM bench_benchmarks WHERE owner = ANY($1::text[])', [subjects]);
    const tagsOf = (row) => {
        let tags = row.tags;
        if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = []; } }
        return Array.isArray(tags) ? tags : [];
    };
    const deleteIds = owned.filter((r) => r.visibility === 'private' || tagsOf(r).includes('your-prompts')).map((r) => r.id);
    if (deleteIds.length) {
        counts.add(counts.erased, 'bench_runs', await t.exec('DELETE FROM bench_runs WHERE benchmark_id = ANY($1::text[])', [deleteIds]));
        counts.add(counts.erased, 'bench_benchmarks', await t.exec('DELETE FROM bench_benchmarks WHERE id = ANY($1::text[])', [deleteIds]));
    }
    const kept = [];
    for (const row of owned) {
        if (deleteIds.includes(row.id)) continue;
        const runs = Number(await t.value('SELECT count(*)::int FROM bench_runs WHERE benchmark_id = $1', [row.id])) || 0;
        if (runs) { kept.push(row.id); continue; }
        counts.add(counts.erased, 'bench_benchmarks', await t.exec('DELETE FROM bench_benchmarks WHERE id = $1', [row.id]));
    }
    if (kept.length) {
        counts.add(counts.retained, 'tombstones', await t.exec('UPDATE bench_benchmarks SET owner = $2, created_by = $2, share_token_hash = NULL WHERE id = ANY($1::text[])', [kept, TOMBSTONE]));
    }
    // The benchmarks of somebody else that the person wrote: the definition stays, the person leaves it.
    counts.add(counts.retained, 'tombstones', await t.exec('UPDATE bench_benchmarks SET created_by = $2 WHERE created_by = ANY($1::text[])', [subjects, TOMBSTONE]));
    // The versions: those of the benchmarks that stay lose their author, those of somebody else's benchmark stay.
    counts.add(counts.retained, 'tombstones', await t.exec('UPDATE bench_benchmark_versions SET created_by = $2 WHERE created_by = ANY($1::text[])', [subjects, TOMBSTONE]));
}

function create({ db, log = console } = {}) {
    return createAccountData({
        db,
        service: 'bench',
        tables: TABLES,
        extraExport,
        extraErase,
        note: 'Bench exports your tasks, rounds, judgements, private evals, benchmarks and their prompts, the runs on your private benchmarks, watched benchmarks and the pairs you have seen; the public dataset is anonymous and a rating never names a person.',
        log,
    });
}

module.exports = { create, TABLES, GUARDED, TOPICS };

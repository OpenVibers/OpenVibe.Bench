'use strict';

/**
 * Account export and deletion → Bench (ADR-033; openvibe-sdk/account-data). What Bench holds about a person:
 *
 *   theirs, and gone        the tasks and rounds they started, the private evals they own, the runs they
 *                            submitted, the pairs they have seen and the benchmarks they watch
 *   theirs, and kept        a judgement they cast stays (it sits under somebody else's round, so the round and
 *                            the ratings keep their place) and loses the person; a benchmark other people ran
 *                            stays as a tombstone, so their runs keep theirs
 *   not theirs              the ratings (an aggregate over the models: the subject column names a model, not a
 *                            person), the entries (a model's output) and the receipts of the requests themselves
 *
 * A benchmark and its frozen versions are the person's, but other people's runs hang under them, so what happens
 * to them depends on what else is there: a benchmark nobody else ran goes with its versions, one others ran stays
 * as a tombstone. extraErase decides that, and GUARDED names the tables the guard needs to know about.
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
];

// The tables the map cannot say on its own: a benchmark and its versions are theirs, but other people's runs hang
// under them. extraErase decides; the guard needs the names.
const GUARDED = ['bench_benchmarks', 'bench_benchmark_versions'];

/** The benchmarks of the person: what they own and what they wrote, with their versions. */
async function extraExport(db, subject) {
    const files = [];
    const benchmarks = await db.many(`SELECT id, owner, title, description, kind, tags, visibility, parent, latest_version, draft, created_by, created_at, updated_at
        FROM bench_benchmarks WHERE owner = $1 OR created_by = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (benchmarks.length) files.push({ name: 'benchmarks.json', content: benchmarks });
    const versions = await db.many(`SELECT benchmark_id, version, definition, hash, created_by, created_at FROM bench_benchmark_versions
        WHERE created_by = $1 OR benchmark_id IN (SELECT id FROM bench_benchmarks WHERE owner = $1) ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (versions.length) files.push({ name: 'benchmark_versions.json', content: versions });
    return files;
}

async function extraErase(t, subjects, counts) {
    // The benchmarks the person owns. One nobody else ran goes with its versions; one others ran stays as a
    // tombstone, so their runs keep their place.
    const ids = (await t.many('SELECT id FROM bench_benchmarks WHERE owner = ANY($1::text[])', [subjects])).map((r) => r.id);
    const kept = [];
    for (const id of ids) {
        const runs = Number(await t.value('SELECT count(*)::int FROM bench_runs WHERE benchmark_id = $1', [id])) || 0;
        if (runs) { kept.push(id); continue; }
        counts.add(counts.erased, 'bench_benchmarks', await t.exec('DELETE FROM bench_benchmarks WHERE id = $1', [id]));
    }
    if (kept.length) {
        counts.add(counts.retained, 'tombstones', await t.exec('UPDATE bench_benchmarks SET owner = $2, created_by = $2 WHERE id = ANY($1::text[])', [kept, TOMBSTONE]));
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
        note: 'Bench exports your tasks, rounds, judgements, private evals, runs, watched benchmarks and the pairs you have seen; the public dataset is anonymous and a rating never names a person.',
        log,
    });
}

module.exports = { create, TABLES, GUARDED, TOPICS };

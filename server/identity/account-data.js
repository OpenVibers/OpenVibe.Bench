'use strict';

/**
 * Account export and deletion → Bench (ADR-033; openvibe-sdk/account-data). The rows a person owns are the tasks
 * and rounds they started, the judgements they cast and the private evals they own. Ratings are aggregate and name
 * no person, so they stay; a public dataset judgement never carries a voter id.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    { table: 'bench_judgements', subject: 'subject', file: 'bench_judgements.json', erase: { anonymize: {} } },
    { table: 'bench_rounds', subject: 'created_by', file: 'bench_rounds.json', erase: 'delete' },
    { table: 'bench_tasks', subject: 'created_by', file: 'bench_tasks.json', erase: 'delete' },
    { table: 'bench_evals', subject: 'owner', file: 'bench_evals.json', erase: 'delete' },
    { table: 'bench_watches', subject: 'subject', file: 'bench_watches.json', erase: 'delete' },
];

function create({ db, log = console } = {}) {
    return createAccountData({
        db,
        service: 'bench',
        tables: TABLES,
        note: 'Bench exports your tasks, rounds, judgements and private evals; the public dataset is anonymous and a rating never names a person.',
        log,
    });
}

module.exports = { create, TABLES, TOPICS };

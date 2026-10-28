'use strict';
/**
 * A migrated database for one test run (ADR-035), from openvibe-sdk/testing: PGlite by default; with
 * BENCH_TEST_STORE=pg the PostgreSQL + PgBouncer containers.
 */
const { createTestDb, pgAvailable } = require('openvibe-sdk/testing');
const { MIGRATIONS } = require('../../server/db');

const testDb = ({ store = process.env.BENCH_TEST_STORE || 'pglite', max = 4 } = {}) => createTestDb({ migrations: MIGRATIONS, store, service: 'bench', max });

module.exports = { testDb, pgAvailable };

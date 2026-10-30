'use strict';

/**
 * Bench's Contracts surface.
 *
 * openvibe-contracts v0.244.0 carries the bench.* schemas and the registry capabilities, so the service reads them
 * from the package: the published shapes are the only ones, and a pin bump is the only way they move. The list of
 * names below is checked at load time, so a wrong pin fails at boot with a clear message instead of answering with
 * a shape nobody published.
 *
 * The nine capabilities Bench has always had stay listed (the showcase kinds, rounds, entries, judgements and the
 * board), and the three the registry added join them: bench.benchmark.write, bench.run.publish and bench.run.read.
 */

const { schema, capabilities } = require('openvibe-contracts');

/** Every bench.* schema the published package must carry. */
const PUBLISHED_SCHEMAS = Object.freeze([
    'bench.kind@1',
    'bench.task@1',
    'bench.round@1',
    'bench.entry@1',
    'bench.judgement@1',
    'bench.rating@1',
    'bench.benchmark@1',
    'bench.run@1',
]);

/** The capabilities Bench's own tokens carry. */
const BENCH_CAPABILITIES = Object.freeze([
    'bench.kind.read',
    'bench.task.create',
    'bench.round.create',
    'bench.round.read',
    'bench.entry.create',
    'bench.judgement.cast',
    'bench.board.read',
    'bench.dataset.read',
    'bench.eval.manage',
    'bench.benchmark.write',
    'bench.run.publish',
    'bench.run.read',
]);

const BENCH_EVENTS = Object.freeze([
    'bench.round.finished',
    'bench.judgement.recorded',
    'bench.rating.changed',
]);

function published(name) {
    try {
        return schema(name) || null;
    } catch {
        return null;
    }
}

const BENCH_SCHEMAS = Object.freeze(PUBLISHED_SCHEMAS.reduce((acc, name) => {
    const s = published(name);
    if (s) acc[name] = s;
    return acc;
}, {}));

const MISSING = PUBLISHED_SCHEMAS.filter((name) => !BENCH_SCHEMAS[name]);
if (MISSING.length) {
    throw new Error(`openvibe-contracts does not carry ${MISSING.join(', ')}. Pin the release that publishes them.`);
}

// Every capability Bench hands out must be one the published package knows, so a token is never granted a name no
// service can rely on.
const UNKNOWN_CAPABILITIES = BENCH_CAPABILITIES.filter((cap) => {
    try {
        return !capabilities.get(cap);
    } catch {
        return true;
    }
});
if (UNKNOWN_CAPABILITIES.length) {
    throw new Error(`openvibe-contracts does not publish ${UNKNOWN_CAPABILITIES.join(', ')}.`);
}

module.exports = { BENCH_CAPABILITIES, BENCH_EVENTS, BENCH_SCHEMAS, PUBLISHED_SCHEMAS };

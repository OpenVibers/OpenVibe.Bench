'use strict';

/**
 * The showcase benchmarks (spec 2026-10-30, stage B1, item 4).
 *
 * The ten showcase prompts are seeded as one public benchmark per kind, owned by "openvibe", so the pages that come
 * next (B2) have real content to render: a benchmark, its tasks, its judges and a version to run against.
 *
 * Seeding is idempotent: a benchmark with the same title and kind is left alone, so a restart never makes a second
 * copy. Nothing here holds a credential and nothing is scored: the benchmarks are the prompts and the rules.
 */
const { SHOWCASE_TASKS } = require('./seed-tasks');
const { kindById } = require('../kinds');

const OWNER = 'openvibe';

function groupByKind() {
    const groups = new Map();
    for (const t of SHOWCASE_TASKS) {
        if (!groups.has(t.kind)) groups.set(t.kind, []);
        groups.get(t.kind).push(t);
    }
    return groups;
}

function titleFor(kind) {
    const k = kindById(kind);
    return k ? k.name : `${kind} benchmark`;
}

/** The tasks of a kind, with the ids a run names them by. */
function tasksFor(list) {
    return list.map((t, i) => ({
        id: `t${i + 1}`,
        prompt: t.prompt,
        files: [],
        expected: null,
        holdout: false,
    }));
}

/** The judges of a kind: the kind's own judge, plus the others its schema names. */
function judgesFor(kind) {
    const k = kindById(kind);
    const list = (k && k.schema && Array.isArray(k.schema.judges) && k.schema.judges.length) ? k.schema.judges : [k ? k.judge : 'human_pairwise'];
    return list.map((type) => ({ type, version: '1.0', config: {} }));
}

function limitsFor(kind) {
    const k = kindById(kind);
    const ms = k && k.schema && k.schema.limit_ms ? Number(k.schema.limit_ms) : null;
    return ms ? { ms, tokens: 0, usd: 0 } : { ms: 0, tokens: 0, usd: 0 };
}

/**
 * Seed one public benchmark per kind. Returns what it made.
 */
async function seedBenchmarks(s, registry, opts = {}) {
    const subject = (opts && opts.subject) || OWNER;
    const made = [];
    for (const [kind, list] of groupByKind()) {
        const title = titleFor(kind);
        const existing = await s.db.maybe(
            'SELECT id FROM bench_benchmarks WHERE title = $1 AND kind = $2 LIMIT 1',
            [title, kind]);
        if (existing) continue;
        const created = await registry.createBenchmark({
            owner: OWNER,
            title,
            description: `The ${kind} showcase set: ${list.length} task${list.length === 1 ? '' : 's'} from the OpenVibe.Bench showcase.`,
            kind,
            tags: [kind.split('.')[0], 'showcase'],
            visibility: 'public',
            parent: null,
            definition: {
                title,
                kind,
                tags: [kind.split('.')[0], 'showcase'],
                visibility: 'public',
                tasks: tasksFor(list),
                judges: judgesFor(kind),
                scoring: { method: 'mean', scale: { min: 0, max: 100 } },
                limits: limitsFor(kind),
                matrix: { models: [], harnesses: [] },
            },
            subject,
        });
        if (!created || !created.ok) continue;
        const frozen = await registry.freezeVersion(created.benchmark.id, {
            definition: created.benchmark.draft,
            subject,
        });
        if (!frozen || !frozen.ok) continue;
        made.push({ id: created.benchmark.id, kind, version: frozen.version.version });
    }
    return made;
}

module.exports = { seedBenchmarks, OWNER, SHOWCASE_TASKS };

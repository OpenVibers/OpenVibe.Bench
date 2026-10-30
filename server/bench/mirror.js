'use strict';

/**
 * Mirroring standard results (B12).
 *
 * A mirror is an operator's job: it reads a published leaderboard from an open source and writes it into Bench
 * with its provenance. Two rules hold it together:
 *
 *   the licence   a source is read only when its licence allows the reuse, and the licence (with its text and
 *                 where it was read) travels with every row it brings
 *   the label     a mirrored run is never verified: it is submitted, and it says where it came from
 *
 * The same model, benchmark version and source never land twice: bench_mirror_runs holds one row for each, with a
 * unique index over the three.
 */
const { matchSuite, suiteTag, IMPORT_TAG } = require('./suites');

const MIRROR_TAG = 'mirrored';

const SOURCES = {
    helm: {
        key: 'helm',
        title: 'HELM',
        base: 'https://storage.googleapis.com/crfm-helm-public',
        page: 'https://www.helm.ai/',
        licence: 'Apache-2.0',
        licence_url: 'https://github.com/stanford-crfm/helm/blob/main/LICENSE',
        attribution: 'HELM (Stanford Center for Research on Foundation Models), stanford-crfm/helm',
    },
    'open-llm-leaderboard': {
        key: 'open-llm-leaderboard',
        title: 'Open LLM Leaderboard',
        base: 'https://huggingface.co/datasets/open-llm-leaderboard/open_llm_leaderboard',
        page: 'https://huggingface.co/datasets/open-llm-leaderboard/open_llm_leaderboard',
        licence: '',
        licence_url: 'https://huggingface.co/datasets/open-llm-leaderboard/open_llm_leaderboard',
        attribution: 'Open LLM Leaderboard (Hugging Face)',
    },
};

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * The licence of a source, read at the moment of the import. A source whose licence cannot be read does not
 * clear, and nothing of it is imported.
 */
async function checkLicence(source, { fetchImpl = globalThis.fetch } = {}) {
    if (source.key === 'helm') {
        const url = 'https://raw.githubusercontent.com/stanford-crfm/helm/main/LICENSE';
        const res = await fetchImpl(url);
        if (!res.ok) return { cleared: false, reason: 'the licence file could not be read (' + res.status + ')' };
        const text = await res.text();
        const line = text.split('\n').map((l) => l.trim()).find((l) => /Apache License/i.test(l)) || '';
        if (!line) return { cleared: false, reason: 'the licence file names no licence I recognise' };
        return { cleared: true, licence: 'Apache-2.0', licence_url: url, quote: line };
    }
    if (source.key === 'open-llm-leaderboard') {
        const url = 'https://huggingface.co/datasets/open-llm-leaderboard/open_llm_leaderboard/raw/main/README.md';
        const res = await fetchImpl(url);
        if (!res.ok) return { cleared: false, reason: 'the dataset card could not be read (' + res.status + ')' };
        const text = await res.text();
        const line = text.split('\n').map((l) => l.trim()).find((l) => /^license:\s*/i.test(l)) || '';
        if (!line) return { cleared: false, reason: 'the dataset card states no licence' };
        const licence = line.replace(/^license:\s*/i, '').replace(/^["']|["']$/g, '').trim();
        return { cleared: true, licence, licence_url: url, quote: line };
    }
    return { cleared: false, reason: 'no licence is known for this source' };
}

/** The rows of a HELM group table: one per model, with the score of the group. */
function helmRows(table, { group, release }) {
    const out = [];
    const tables = Array.isArray(table) ? table : [table];
    for (const one of tables) {
        if (!one || !Array.isArray(one.header) || !Array.isArray(one.rows)) continue;
        const header = one.header;
        const wanted = ['EM', 'Accuracy', 'exact_match', 'Normalized accuracy', 'acc'];
        let index = -1;
        for (const name of wanted) {
            const at = header.findIndex((h) => h && h.metadata && String(h.metadata.metric || '') === name);
            if (at > 0) { index = at; break; }
        }
        if (index < 0) continue;
        for (const row of one.rows) {
            if (!Array.isArray(row) || !row.length) continue;
            const model = row[0] && row[0].value != null ? String(row[0].value) : '';
            const score = num(row[index] && row[index].value);
            if (!model || score == null) continue;
            const group_ = (one.header[index] && one.header[index].metadata && one.header[index].metadata.run_group) || group;
            out.push({
                benchmark: group_,
                benchmark_version: release,
                model,
                score: score * 100,
                task_id: String(group_).toLowerCase().replace(/[^a-z0-9]+/g, '_'),
                source_url: sourceUrlHelm(group, release),
            });
        }
    }
    return out;
}

function sourceUrlHelm(group, release) {
    return 'https://storage.googleapis.com/crfm-helm-public/lite/benchmark_output/releases/' + release + '/groups/' + group + '.json';
}

/** Read a HELM group: the leaderboard table of one scenario group of one release. */
async function loadHelm(source, { fetchImpl = globalThis.fetch, suite = 'lite', release = 'v1.13.0', group = 'mmlu' } = {}) {
    const url = source.base + '/' + suite + '/benchmark_output/releases/' + release + '/groups/' + group + '.json';
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error('the source answered ' + res.status + ' for ' + url);
    const table = await res.json();
    return { url, rows: helmRows(table, { group, release }) };
}

/** Read the Open LLM Leaderboard dataset: one row per model and task. */
async function loadOpenLlmLeaderboard(source, { fetchImpl = globalThis.fetch, limit = 200 } = {}) {
    const rows = [];
    const configsUrl = 'https://datasets-server.huggingface.co/splits?dataset=' + encodeURIComponent('open-llm-leaderboard/open_llm_leaderboard');
    const res = await fetchImpl(configsUrl);
    if (!res.ok) throw new Error('the source answered ' + res.status + ' for the dataset splits');
    const splits = await res.json();
    const configs = (splits.splits || []).slice(0, 6);
    for (const config of configs) {
        const url = 'https://datasets-server.huggingface.co/rows?dataset='
            + encodeURIComponent('open-llm-leaderboard/open_llm_leaderboard')
            + '&config=' + encodeURIComponent(config.config) + '&split=' + encodeURIComponent(config.split)
            + '&offset=0&length=' + Math.max(1, Math.min(100, limit));
        const r2 = await fetchImpl(url);
        if (!r2.ok) continue;
        const body = await r2.json();
        for (const item of body.rows || []) {
            const row = item.row || {};
            const model = row.model_name || row.model || row.Model || row.model_full_name;
            const score = num(row.accuracy != null ? row.accuracy : row.acc != null ? row.acc : row.score);
            if (!model || score == null) continue;
            rows.push({
                benchmark: config.config,
                benchmark_version: 'leaderboard',
                model: String(model),
                score: score * 100,
                task_id: String(config.config),
                source_url: source.page,
            });
        }
    }
    return { url: source.page, rows };
}

/**
 * The mirror: read the sources, work out what they would bring, and (only when asked) write it.
 * Every mirrored run is submitted and carries the source, its licence and the day it was read.
 */
function createMirror({ s, registry, fetchImpl = globalThis.fetch, log = console } = {}) {
    const db = s.db;

    /** What a source would bring, without writing anything. */
    async function preview(sourceKey, options = {}) {
        const source = SOURCES[sourceKey];
        if (!source) return { ok: false, error: 'No such source.' };
        const licence = await checkLicence(source, { fetchImpl });
        if (!licence.cleared) {
            return { ok: false, source: source.key, blocked: true, reason: 'the licence does not clear: ' + licence.reason };
        }
        let loaded;
        try {
            loaded = source.key === 'helm'
                ? await loadHelm(source, { fetchImpl, ...options })
                : await loadOpenLlmLeaderboard(source, { fetchImpl, ...options });
        } catch (err) {
            return { ok: false, source: source.key, blocked: true, reason: (err && err.message) || 'the source could not be read' };
        }
        return {
            ok: true,
            source: source.key,
            title: source.title,
            url: loaded.url,
            licence: licence.licence,
            licence_url: licence.licence_url,
            licence_quote: licence.quote,
            attribution: source.attribution,
            rows: loaded.rows,
            count: loaded.rows.length,
        };
    }

    /** The benchmark a mirrored group becomes: one per source and group, public, so anybody can read it. */
    async function benchmarkFor(row, { source, licence }) {
        const suite = matchSuite(row.benchmark);
        const tags = [MIRROR_TAG, IMPORT_TAG].concat(suite ? [suiteTag(suite.key)] : []);
        const tag = 'mirror:' + source.key + ':' + String(row.benchmark).toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const list = await registry.listBenchmarks({ tag, limit: 20 });
        const found = list.find((b) => Array.isArray(b.tags) && b.tags.includes(tag));
        if (found) return found;
        const made = await registry.createBenchmark({
            owner: 'openvibe',
            title: (suite ? suite.title : row.benchmark) + ' (' + source.title + ')',
            description: 'Mirrored from ' + source.title + '. Licence: ' + licence.licence + '. ' + source.attribution + '.',
            kind: 'text.answer',
            tags: tags.concat([tag]),
            visibility: 'public',
            subject: 'openvibe',
        });
        if (!made.ok) throw new Error(made.message || 'the benchmark could not be made');
        return made.benchmark;
    }

    /** Write the rows: one mirrored run per model, benchmark version and source; the same one never lands twice. */
    async function apply(sourceKey, options = {}) {
        const looked = await preview(sourceKey, options);
        if (!looked.ok) return looked;
        const source = SOURCES[sourceKey];
        const readAt = s.iso();
        const written = [];
        const skipped = [];
        for (const row of looked.rows) {
            const benchmark = await benchmarkFor(row, { source, licence: looked.licence });
            const definition = {
                title: benchmark.title,
                description: benchmark.description,
                kind: benchmark.kind,
                tags: benchmark.tags || [],
                visibility: 'public',
                tasks: [{ id: row.task_id, prompt: 'Mirrored result: ' + row.benchmark + '.', holdout: false }],
                judges: [],
                scoring: { method: 'mean', scale: { min: 0, max: 100 } },
                limits: {},
                matrix: {},
            };
            const latest = await registry.latestVersion(benchmark.id);
            const known = latest && latest.definition
                ? new Set((latest.definition.tasks || []).map((t) => String(t.id)))
                : new Set();
            let version;
            if (latest && known.has(row.task_id)) {
                version = latest.version;
            } else {
                const frozen = await registry.freezeVersion(benchmark.id, { definition, subject: 'openvibe' });
                if (!frozen.ok) { skipped.push({ model: row.model, why: frozen.message }); continue; }
                version = frozen.version.version;
            }
            const prior = await db.maybe(
                'SELECT id FROM bench_mirror_runs WHERE source_key = $1 AND benchmark_id = $2 AND benchmark_version = $3 AND model = $4',
                [source.key, benchmark.id, version, row.model],
            );
            if (prior) { skipped.push({ model: row.model, why: 'already mirrored' }); continue; }
            const published = await registry.publishRun({
                benchmark: benchmark.id + '@' + version,
                model: String(row.model).slice(0, 160),
                provider: source.key,
                route: {},
                harness: { name: source.title, version: String(row.benchmark_version || 'published') },
                settings: {},
                tasks: [{ task_id: row.task_id, score: row.score, cost_usd: 0, ms: 0, tokens: 0, artifacts: [] }],
                score: row.score,
                cost_usd: 0,
                ms: 0,
                tokens: 0,
                source: {
                    kind: 'mirror',
                    source_key: source.key,
                    source_url: row.source_url,
                    licence: looked.licence,
                    licence_url: looked.licence_url,
                    attribution: looked.attribution,
                    read_at: readAt,
                },
            }, { provenance: 'submitted', subject: 'openvibe' });
            if (!published.ok) { skipped.push({ model: row.model, why: published.message }); continue; }
            await db.exec(
                `INSERT INTO bench_mirror_runs (id, source_key, source_url, licence, licence_url, read_at, benchmark_id, benchmark_version, model, run_id)
                 VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10)`,
                [s.newId('bmr'), source.key, row.source_url, looked.licence, looked.licence_url, readAt,
                    benchmark.id, version, row.model, published.run.id],
            );
            written.push({ model: row.model, benchmark: benchmark.id, run: published.run.id, score: row.score });
        }
        await db.exec(
            `INSERT INTO bench_mirror_reads (id, source_key, source_url, licence, licence_url, attribution, read_at, rows)
             VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)
             ON CONFLICT (source_key, source_url) DO UPDATE SET read_at = EXCLUDED.read_at, rows = EXCLUDED.rows`,
            [s.newId('bmr'), source.key, looked.url, looked.licence, looked.licence_url, looked.attribution, readAt, written.length],
        );
        return { ok: true, source: source.key, licence: looked.licence, licence_url: looked.licence_url, written, skipped, read_at: readAt };
    }

    return { preview, apply, SOURCES, checkLicence, MIRROR_TAG };
}

module.exports = { createMirror, SOURCES, checkLicence, MIRROR_TAG };

'use strict';

/**
 * Importing results a person already has (B12).
 *
 * A person brings a file from Inspect AI, Harbor, the lm-evaluation-harness or promptfoo. The file becomes:
 *
 *   a benchmark  matched to a suite Bench knows (MMLU, GSM8K, HumanEval, ...) when the file names one, and a
 *                private benchmark of their own otherwise
 *   runs         one per model in the file, always submitted (never verified: nobody re-ran them), with the
 *                per-task scores the file carries, the harness and its version, the date and the cost
 *
 * The uploaded file stays the owner's own: private until they share the benchmark it became.
 */
const crypto = require('crypto');
const { ImportError, MAX_UPLOAD_BYTES } = require('./importers/limits');
const importers = require('./importers');
const { matchSuite, suiteTag, IMPORT_TAG } = require('./suites');
const { validateBenchmark } = require('./validate');

const MAX_MODELS = 200;
const MAX_TASKS_PER_MODEL = 10000;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const num = (v, d = 0) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

/** The name of the file, without any path: a name is never a path here. */
function safeFilename(name) {
    const raw = String(name == null ? '' : name);
    const base = raw.split(/[\\/]/).pop() || '';
    return base.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 160) || 'results';
}

function createImports({ s, registry, log = console }) {
    const db = s.db;

    const wireImport = (row) => {
        if (!row) return null;
        const summary = typeof row.summary === 'string' ? JSON.parse(row.summary) : (row.summary || {});
        return {
            id: row.id,
            owner: row.owner,
            tool: row.tool,
            tool_version: row.tool_version,
            filename: row.filename,
            sha256: row.sha256,
            size: num(row.size),
            status: row.status,
            summary,
            benchmark_id: row.benchmark_id || null,
            run_ids: Array.isArray(row.run_ids) ? row.run_ids : [],
            created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        };
    };

    /** Read the file, work out which tool wrote it, and keep it (and what it says) for the preview. */
    async function store({ owner, subject, filename, bytes, tool = null }) {
        const subjectId = String(subject || owner || '');
        if (!subjectId) throw new ImportError(401, 'bench.import_signed_in', 'Sign in to bring your own results.');
        const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
        if (!buf.length) throw new ImportError(422, 'bench.import_empty', 'That file is empty.');
        if (buf.length > MAX_UPLOAD_BYTES) {
            throw new ImportError(413, 'bench.import_too_large', 'That file is larger than 20 MB.');
        }
        let parsed;
        try {
            parsed = importers.parse(buf, { filename: safeFilename(filename), tool });
        } catch (err) {
            if (err instanceof ImportError) throw err;
            throw new ImportError(422, 'bench.import_unreadable', (err && err.message) || 'I could not read that file.');
        }
        const models = (parsed.models || []).slice(0, MAX_MODELS);
        for (const model of models) {
            if ((model.tasks || []).length > MAX_TASKS_PER_MODEL) {
                throw new ImportError(413, 'bench.import_too_many_tasks', 'That file holds more tasks than I can import.');
            }
        }
        const id = s.newId('bim');
        const name = safeFilename(filename);
        const summary = {
            tool: parsed.tool,
            tool_version: parsed.toolVersion,
            harness: parsed.harness,
            date: parsed.date,
            suite: parsed.suite || null,
            models: models.map((m) => ({
                model: m.model,
                provider: m.provider,
                score: m.score == null ? null : num(m.score),
                cost_usd: m.cost_usd == null ? null : num(m.cost_usd),
                tokens: m.tokens == null ? null : num(m.tokens),
                tasks: (m.tasks || []).map((t) => ({ task_id: String(t.task_id), score: t.score == null ? null : num(t.score) })),
            })),
        };
        await db.exec(
            `INSERT INTO bench_imports (id, owner, tool, tool_version, filename, sha256, size, status, summary, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'preview', $8::jsonb, $9, $10::timestamptz)`,
            [id, subjectId, parsed.tool, String(parsed.toolVersion || ''), name, sha256(buf), buf.length,
                JSON.stringify(summary), subjectId, s.iso()],
        );
        await db.exec('INSERT INTO bench_import_files (import_id, content, size) VALUES ($1, $2, $3)', [id, buf, buf.length]);
        return get(id);
    }

    async function get(id) {
        return wireImport(await db.maybe('SELECT * FROM bench_imports WHERE id = $1', [String(id || '')]));
    }

    /** The imports of a person, newest first. */
    async function listFor(owner, { limit = 20 } = {}) {
        const rows = await db.many(
            'SELECT * FROM bench_imports WHERE owner = $1 ORDER BY created_at DESC LIMIT $2',
            [String(owner || ''), Math.max(1, Math.min(100, num(limit, 20)))],
        );
        return rows.map(wireImport);
    }

    /** The task ids of an import: every task any model in the file scored. */
    function taskIdsOf(summary) {
        const ids = [];
        for (const model of summary.models || []) {
            for (const task of model.tasks || []) {
                if (!ids.includes(task.task_id)) ids.push(task.task_id);
            }
        }
        return ids;
    }

    /** The benchmark an import becomes: the one of a suite Bench knows, or a new private one. */
    async function benchmarkFor(summary, { subject }) {
        const suite = summary.suite ? matchSuite(summary.suite.name) : null;
        const tag = suite ? suiteTag(suite.key) : null;
        if (tag) {
            const list = await registry.listBenchmarks({ tag, owner: subject, limit: 50 });
            const found = list.find((b) => Array.isArray(b.tags) && b.tags.includes(tag));
            if (found) return { benchmark: found, suite, matched: true };
        }
        const title = suite
            ? suite.title
            : (summary.suite && summary.suite.name) || (importers.TOOL_LABELS[summary.tool] + ' results');
        const toolLabel = importers.TOOL_LABELS[summary.tool] || summary.tool;
        const made = await registry.createBenchmark({
            owner: subject,
            title,
            description: 'Imported from ' + toolLabel + ' ' + (summary.tool_version || '') + '.',
            kind: 'text.answer',
            tags: [IMPORT_TAG].concat(tag ? [tag] : []),
            visibility: 'private',
            subject,
        });
        if (!made.ok) throw new ImportError(made.status || 422, made.code || 'bench.import_failed', made.message || 'The benchmark could not be made.');
        return { benchmark: made.benchmark, suite, matched: false };
    }

    /** The version the runs hang on: one that has the tasks, or a new one frozen with them. */
    async function versionFor(benchmark, summary, { subject, toolLabel }) {
        const taskIds = taskIdsOf(summary);
        const latest = await registry.latestVersion(benchmark.id);
        if (latest && latest.definition) {
            const known = new Set((latest.definition.tasks || []).map((t) => String(t.id)));
            if (taskIds.length && taskIds.every((id) => known.has(id))) return latest.version;
        }
        const title = benchmark.title;
        const definition = {
            title,
            description: benchmark.description || ('Imported from ' + toolLabel + '.'),
            kind: benchmark.kind,
            tags: benchmark.tags || [],
            visibility: 'unlisted',
            tasks: taskIds.map((id) => ({
                id,
                prompt: 'Imported task ' + id + '. The file carried the score, not the prompt.',
                holdout: false,
            })),
            judges: [],
            scoring: { method: 'mean', scale: { min: 0, max: 100 } },
            limits: {},
            matrix: {},
        };
        const frozen = await registry.freezeVersion(benchmark.id, { definition, subject, validate: validateBenchmark });
        if (!frozen.ok) throw new ImportError(frozen.status || 422, frozen.code || 'bench.import_failed', frozen.message || 'The benchmark could not be frozen.');
        return frozen.version.version;
    }

    /** Turn the upload into runs: one per model, always submitted. */
    async function commit(id, { subject }) {
        const row = await get(id);
        if (!row) throw new ImportError(404, 'bench.import_not_found', 'No such upload.');
        if (String(row.owner) !== String(subject)) throw new ImportError(404, 'bench.import_not_found', 'No such upload.');
        if (row.status === 'imported') {
            const benchmark = row.benchmark_id ? await registry.getBenchmark(row.benchmark_id) : null;
            return { ok: true, benchmark, runs: row.run_ids.map((rid) => ({ id: rid })), already: true };
        }
        const summary = row.summary || {};
        const toolLabel = importers.TOOL_LABELS[summary.tool] || summary.tool;
        const { benchmark } = await benchmarkFor(summary, { subject });
        const version = await versionFor(benchmark, summary, { subject, toolLabel });
        const known = new Set(taskIdsOf(summary));
        const runIds = [];
        for (const model of summary.models || []) {
            const tasks = (model.tasks || [])
                .filter((t) => known.has(t.task_id))
                .map((t) => ({ task_id: t.task_id, score: t.score == null ? null : num(t.score), cost_usd: 0, ms: 0, tokens: 0, artifacts: [] }));
            if (!tasks.length) continue;
            const published = await registry.publishRun({
                benchmark: benchmark.id + '@' + version,
                model: String(model.model || 'unknown').slice(0, 160),
                provider: String(model.provider || 'unknown').slice(0, 160),
                route: {},
                harness: summary.harness || { name: toolLabel, version: summary.tool_version || 'unknown' },
                settings: {},
                tasks,
                score: model.score == null ? null : num(model.score),
                cost_usd: num(model.cost_usd),
                ms: 0,
                tokens: num(model.tokens),
                source: {
                    kind: 'import',
                    tool: summary.tool,
                    tool_version: summary.tool_version || '',
                    import_id: row.id,
                    filename: row.filename,
                    date: summary.date || null,
                },
            }, { provenance: 'submitted', subject });
            if (!published.ok) {
                log.warn('[OpenVibe.Bench] an imported run was refused:', published.code || '', published.message || '');
                continue;
            }
            runIds.push(published.run.id);
        }
        await db.exec(
            "UPDATE bench_imports SET status = 'imported', benchmark_id = $1, run_ids = $2::jsonb WHERE id = $3",
            [benchmark.id, JSON.stringify(runIds), row.id],
        );
        return { ok: true, benchmark, runs: runIds.map((rid) => ({ id: rid })), import: await get(row.id) };
    }

    /**
     * The uploaded file itself. The owner may always read it. Once the benchmark it became is public, anyone may;
     * an unlisted benchmark shares it with the people its link reaches.
     */
    async function file(id, { subject = null, shareToken = null } = {}) {
        const row = await db.maybe('SELECT * FROM bench_imports WHERE id = $1', [String(id || '')]);
        if (!row) return null;
        const owner = subject != null && String(row.owner) === String(subject);
        if (!owner) {
            const benchmark = row.benchmark_id ? await registry.getBenchmark(row.benchmark_id) : null;
            let allowed = Boolean(benchmark && benchmark.visibility === 'public');
            if (!allowed && benchmark && benchmark.visibility === 'unlisted' && benchmark.shared && shareToken) {
                const shared = await registry.findShared(String(shareToken));
                allowed = Boolean(shared && shared.id === benchmark.id);
            }
            if (!allowed) return null;
        }
        const content = await db.maybe('SELECT content, size FROM bench_import_files WHERE import_id = $1', [row.id]);
        if (!content) return null;
        return {
            import: wireImport(row),
            content: content.content,
            filename: row.filename || 'results',
            size: num(content.size),
        };
    }

    return { store, get, listFor, commit, file, taskIdsOf };
}

module.exports = { createImports, safeFilename, MAX_MODELS, MAX_TASKS_PER_MODEL };

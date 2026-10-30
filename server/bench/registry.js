'use strict';

/**
 * The benchmark registry and the results database (spec 2026-10-30, stage B1).
 *
 * A benchmark is owned, versioned and forkable. Its working copy is a draft; freezing it writes an immutable version
 * (the JSON definition plus its hash). A version that a run names never changes again — the rule is enforced here,
 * not by convention: a write that would change it is refused.
 *
 * A run is one result: a benchmark version × a model × a harness × settings × who ran it. Its provenance says who ran
 * it: verified (an executor did) or submitted (posted through the API with no executor). Submitted runs are badged and
 * kept out of the default rankings.
 *
 * Nothing here holds a credential: a run records which account paid, never a key.
 */
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const { contractRun, checkContract, VISIBILITIES } = require('./validate');
const { rankBands } = require('../rating/style');

const num = (v, d = 0) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));
const refusal = (status, code, message) => ({ ok: false, status, code, message });

class RegistryError extends Error {
    constructor(status, code, detail) {
        super(detail);
        this.name = 'RegistryError';
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}

/** The canonical form of a definition: the keys Bench knows, in one order, so the hash is stable. */
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
        return out;
    }
    return value;
}

function hashDefinition(definition) {
    return crypto.createHash('sha256').update(JSON.stringify(canonical(definition)), 'utf8').digest('hex');
}

const json = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
    return v;
};

/** A share token: 256 random bits in base64url (43 characters), never guessable. */
function newShareToken() {
    return crypto.randomBytes(32).toString('base64url');
}

/** Only the SHA-256 of a share token is stored, so a database read never yields a working link. */
function shareTokenHash(token) {
    return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

/** Constant-time check of a token against the stored hash: lengths first, then timingSafeEqual. */
function shareTokenMatches(token, storedHash) {
    if (!storedHash) return false;
    const got = Buffer.from(shareTokenHash(token), 'hex');
    const want = Buffer.from(String(storedHash), 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * Who may read a benchmark. Public is for everyone; private is its owner (and the executor, which needs the tasks
 * to run them); unlisted is reachable by id as it always was, but a shared unlisted benchmark is token-only: its
 * id alone no longer opens it.
 */
function canViewBenchmark(benchmark, { subject = null, executor = false } = {}) {
    if (!benchmark) return false;
    const owner = subject != null && String(benchmark.owner) === String(subject);
    if (benchmark.visibility === 'public') return true;
    if (benchmark.visibility === 'private') return owner || executor;
    if (benchmark.visibility === 'unlisted' && benchmark.shared) return owner || executor;
    return true;
}

function wireBenchmark(row) {
    if (!row) return null;
    return {
        id: row.id,
        owner: row.owner,
        title: row.title,
        description: row.description || '',
        kind: row.kind,
        tags: Array.isArray(json(row.tags, [])) ? json(row.tags, []) : [],
        visibility: row.visibility,
        // Whether an unlisted share link exists. The token itself is never in a wire object or a page source.
        shared: Boolean(row.share_token_hash),
        parent: row.parent || null,
        latest_version: num(row.latest_version),
        draft: json(row.draft, null),
        created_by: row.created_by,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
    };
}

function wireVersion(row) {
    if (!row) return null;
    return {
        benchmark_id: row.benchmark_id,
        version: num(row.version),
        definition: json(row.definition, {}),
        hash: row.hash,
        created_by: row.created_by,
        created_at: iso(row.created_at),
    };
}

function wireRun(row, tasks = null) {
    if (!row) return null;
    const out = {
        id: row.id,
        benchmark: `${row.benchmark_id}@${num(row.benchmark_version)}`,
        benchmark_id: row.benchmark_id,
        benchmark_version: num(row.benchmark_version),
        model: row.model,
        route: json(row.route, {}),
        provider: row.provider,
        harness: json(row.harness, {}),
        settings: json(row.settings, {}),
        executor: json(row.executor, {}),
        hardware: json(row.hardware, null),
        score: row.score == null ? null : num(row.score),
        cost_usd: num(row.cost_usd),
        ms: num(row.ms),
        tokens: num(row.tokens),
        provenance: row.provenance,
        // Where the run came from: an upload, or a mirror's source with its licence. It is Bench's own field:
        // the published bench.run document closes its shape to the contract, so this sits beside it.
        source: json(row.source, {}),
        session: row.session || null,
        created_by: row.created_by,
        created_at: iso(row.created_at),
    };
    if (tasks) out.tasks = tasks;
    // The published bench.run@1 document: what a caller reads back is what the contract says.
    out.document = contractRun({
        id: out.id,
        benchmark: out.benchmark,
        model: out.model,
        route: out.route,
        provider: out.provider,
        harness: out.harness,
        settings: out.settings,
        executor: out.executor,
        hardware: out.hardware,
        tasks: tasks || [],
        score: out.score,
        cost_usd: out.cost_usd,
        ms: out.ms,
        tokens: out.tokens,
        provenance: out.provenance,
    }, out.created_at);
    return out;
}

function wireTask(row) {
    if (!row) return null;
    return {
        task_id: row.task_id,
        score: row.score == null ? null : num(row.score),
        cost_usd: num(row.cost_usd),
        ms: num(row.ms),
        tokens: num(row.tokens),
        artifacts: (Array.isArray(json(row.artifacts, [])) ? json(row.artifacts, []) : []).map((a) => ({ kind: a.kind, url: a.url })).filter((a) => a.url),
        transcript_url: row.transcript_url || null,
    };
}

/** The median of a list of numbers. */
function median(values) {
    const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!list.length) return null;
    const mid = Math.floor(list.length / 2);
    return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/** "bmk_x@2" → { id, version }; "bmk_x" → { id, version: null } (the newest frozen one). */
function parseRef(ref) {
    const text = String(ref || '').trim();
    const at = text.lastIndexOf('@');
    if (at > 0) {
        const version = Number(text.slice(at + 1));
        if (!Number.isInteger(version) || version < 1) return null;
        return { id: text.slice(0, at), version };
    }
    return { id: text, version: null };
}

function createRegistry(s, { log = console } = {}) {
    const db = s.db;

    // ── Benchmarks ───────────────────────────────────────────
    async function createBenchmark({ owner, title, description = '', kind, tags = [], visibility = 'unlisted', parent = null, definition = null, subject }) {
        const text = String(title == null ? '' : title).trim();
        if (!text) return refusal(422, 'bench.title_required', 'A benchmark needs a title.');
        if (text.length > 160) return refusal(422, 'bench.title_too_long', 'The title must be at most 160 characters.');
        const kindId = String(kind == null ? '' : kind).trim();
        if (!kindId) return refusal(422, 'bench.kind_required', 'A benchmark needs a kind.');
        const vis = String(visibility || 'unlisted');
        if (!VISIBILITIES.includes(vis)) return refusal(422, 'bench.invalid_visibility', `visibility is ${VISIBILITIES.join(', ')}.`);
        const list = (Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 32);
        const id = s.newId('bmk');
        const row = await db.maybe(
            `INSERT INTO bench_benchmarks (id, owner, title, description, kind, tags, visibility, parent, latest_version, draft, created_by, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 0, $9::jsonb, $10, $11::timestamptz, $11::timestamptz)
             RETURNING *`,
            [id, String(owner || 'openvibe'), text, String(description || '').slice(0, 4000), kindId,
                JSON.stringify(list), vis, parent || null, JSON.stringify(definition || {}), String(subject || owner || 'openvibe'), s.iso()],
        );
        return { ok: true, benchmark: wireBenchmark(row) };
    }

    /** The working copy: what a later freeze would publish. */
    async function getBenchmark(id) {
        return wireBenchmark(await db.maybe('SELECT * FROM bench_benchmarks WHERE id = $1', [String(id || '')]));
    }

    async function getVersion(benchmarkId, version) {
        return wireVersion(await db.maybe(
            'SELECT * FROM bench_benchmark_versions WHERE benchmark_id = $1 AND version = $2',
            [String(benchmarkId || ''), num(version)]));
    }

    /** The newest frozen version of a benchmark. */
    async function latestVersion(benchmarkId) {
        return wireVersion(await db.maybe(
            'SELECT * FROM bench_benchmark_versions WHERE benchmark_id = $1 ORDER BY version DESC LIMIT 1',
            [String(benchmarkId || '')]));
    }

    /**
     * The definition of a benchmark, at a version or at its newest frozen one. Holdout tasks are withheld unless the
     * caller holds bench.run.publish: the executor may see them, everyone else may not.
     */
    async function getDefinition(idOrRef, { reveal = false } = {}) {
        const ref = parseRef(idOrRef);
        if (!ref) return null;
        const benchmark = await getBenchmark(ref.id);
        if (!benchmark) return null;
        const version = ref.version != null
            ? await getVersion(ref.id, ref.version)
            : await latestVersion(ref.id);
        if (!version) return null;
        const definition = { ...version.definition };
        if (!reveal && Array.isArray(definition.tasks)) {
            definition.tasks = definition.tasks.map((t) => (t && t.holdout ? { ...t, prompt: null, expected: null, files: null, holdout: true } : t));
        }
        return { benchmark, version: { ...version, definition }, definition };
    }

    /** Save a new draft. A version named in the body is edited in place, and only while no run names it. */
    async function saveDraft(id, { definition = {}, subject }) {
        const benchmark = await getBenchmark(id);
        if (!benchmark) return refusal(404, 'bench.benchmark_not_found', 'No such benchmark.');
        const version = definition.version == null ? null : num(definition.version);
        if (version != null) {
            const row = await getVersion(benchmark.id, version);
            if (!row) return refusal(404, 'bench.version_not_found', 'No such version.');
            const used = num(await db.value('SELECT COUNT(*)::int AS n FROM bench_runs WHERE benchmark_id = $1 AND benchmark_version = $2', [benchmark.id, version]));
            if (used > 0) {
                return refusal(409, 'bench.version_frozen', 'A version that a run names never changes again. Fork the benchmark instead.');
            }
            const next = { ...row.definition, ...definition, version };
            await db.exec(
                'UPDATE bench_benchmark_versions SET definition = $1::jsonb, hash = $2 WHERE benchmark_id = $3 AND version = $4',
                [JSON.stringify(next), hashDefinition(next), benchmark.id, version]);
            await db.exec('UPDATE bench_benchmarks SET updated_at = $1::timestamptz WHERE id = $2', [s.iso(), benchmark.id]);
            return { ok: true, version: await getVersion(benchmark.id, version) };
        }
        const draft = { ...(benchmark.draft || {}), ...definition };
        await db.exec('UPDATE bench_benchmarks SET draft = $1::jsonb, updated_at = $2::timestamptz WHERE id = $3',
            [JSON.stringify(draft), s.iso(), benchmark.id]);
        return { ok: true, draft };
    }

    /** Freeze the working copy (or a body definition) into the next immutable version. */
    async function freezeVersion(id, { definition = null, subject, validate = null }) {
        const benchmark = await getBenchmark(id);
        if (!benchmark) return refusal(404, 'bench.benchmark_not_found', 'No such benchmark.');
        const source = definition || benchmark.draft || {};
        const version = benchmark.latest_version + 1;
        // The published contract knows public and unlisted only. A private benchmark is frozen as unlisted (the
        // stricter form); the row's own visibility is what every access check reads, so its prompts stay private.
        const frozenVisibility = benchmark.visibility === 'public' ? 'public' : 'unlisted';
        const doc = {
            id: benchmark.id,
            owner: benchmark.owner,
            title: source.title || benchmark.title,
            description: source.description == null ? benchmark.description : source.description,
            kind: source.kind || benchmark.kind,
            tags: Array.isArray(source.tags) ? source.tags : benchmark.tags,
            visibility: frozenVisibility,
            version,
            parent: benchmark.parent,
            tasks: Array.isArray(source.tasks) ? source.tasks : [],
            judges: Array.isArray(source.judges) ? source.judges : [],
            scoring: source.scoring || { method: 'mean', scale: { min: 0, max: 100 } },
            limits: source.limits || {},
            matrix: source.matrix || {},
            created_at: s.iso(),
        };
        if (!doc.tasks.length) return refusal(422, 'bench.no_tasks', 'A benchmark needs at least one task before it can be frozen.');
        if (validate) {
            const check = validate(doc);
            if (!check.valid) {
                return refusal(422, 'bench.invalid_definition', check.errors.map((e) => `${e.path} ${e.message}`).join('; '));
            }
        }
        await db.exec(
            `INSERT INTO bench_benchmark_versions (benchmark_id, version, definition, hash, created_by, created_at)
             VALUES ($1, $2, $3::jsonb, $4, $5, $6::timestamptz)
             ON CONFLICT (benchmark_id, version) DO NOTHING`,
            [benchmark.id, version, JSON.stringify(doc), hashDefinition(doc), String(subject || benchmark.created_by), s.iso()]);
        await db.exec('UPDATE bench_benchmarks SET latest_version = $1, updated_at = $2::timestamptz WHERE id = $3',
            [version, s.iso(), benchmark.id]);
        return { ok: true, version: await getVersion(benchmark.id, version), benchmark: await getBenchmark(benchmark.id) };
    }

    /** A fork: a new benchmark of its own that records the parent it came from. */
    async function forkBenchmark(id, { version = null, title = null, owner, subject }) {
        const source = await getDefinition(id, { reveal: true });
        if (!source) return refusal(404, 'bench.benchmark_not_found', 'No such benchmark.');
        const parent = `${source.benchmark.id}@${source.version.version}`;
        const definition = {
            ...source.definition,
            id: null,
            version: 0,
            parent,
            title: title || `${source.definition.title || source.benchmark.title} (fork)`,
            tasks: Array.isArray(source.definition.tasks) ? source.definition.tasks : [],
            created_at: null,
        };
        const made = await createBenchmark({
            owner: owner || subject,
            title: definition.title,
            description: definition.description,
            kind: definition.kind,
            tags: definition.tags,
            visibility: definition.visibility,
            parent,
            definition,
            subject,
        });
        if (!made.ok) return made;
        const frozen = await freezeVersion(made.benchmark.id, { definition: { ...definition, version: 1 }, subject });
        if (!frozen.ok) return frozen;
        return { ok: true, benchmark: await getBenchmark(made.benchmark.id), version: frozen.version, parent };
    }

    /**
     * Share or unshare a benchmark. The owner chooses:
     *   private   only they see it; no link works
     *   unlisted  a new random link works, and nothing lists it
     *   public    it is in the lists, the sitemap and the open data
     * The raw token is returned once, on the call that makes the link; only its hash is stored. Every change replaces
     * the old token, so a link from a previous share stops working.
     */
    async function setVisibility(id, { visibility, subject }) {
        const benchmark = await getBenchmark(id);
        if (!benchmark) return refusal(404, 'bench.benchmark_not_found', 'No such benchmark.');
        if (String(benchmark.owner) !== String(subject)) return refusal(404, 'bench.benchmark_not_found', 'No such benchmark.');
        const vis = String(visibility || '').trim();
        if (!VISIBILITIES.includes(vis)) return refusal(422, 'bench.invalid_visibility', `visibility is ${VISIBILITIES.join(', ')}.`);
        const token = vis === 'unlisted' ? newShareToken() : null;
        const row = await db.maybe(
            `UPDATE bench_benchmarks SET visibility = $1, share_token_hash = $2, updated_at = $3::timestamptz
             WHERE id = $4 RETURNING *`,
            [vis, token ? shareTokenHash(token) : null, s.iso(), benchmark.id]);
        return {
            ok: true,
            benchmark: wireBenchmark(row),
            token,
            share_path: token ? `/b/${token}` : null,
        };
    }

    /** The benchmark an unlisted link names, checked in constant time. A private or public row has no token. */
    async function findShared(token) {
        const text = String(token || '');
        if (!/^[A-Za-z0-9_-]{20,120}$/.test(text)) return null;
        const hash = shareTokenHash(text);
        const row = await db.maybe(
            "SELECT * FROM bench_benchmarks WHERE share_token_hash = $1 AND visibility = 'unlisted'",
            [hash]);
        if (!row || !shareTokenMatches(text, row.share_token_hash)) return null;
        return wireBenchmark(row);
    }

    /**
     * The open data for the registry: every public benchmark, its visible tasks, and every run published under it.
     * Nothing private or unlisted is ever read here; a person id (created_by, the executor's id) is left out, and a
     * holdout task keeps its prompt to the executor.
     */
    async function publicDatasetLines() {
        const benchmarks = await listBenchmarks({ limit: 200 });
        const lines = [];
        for (const benchmark of benchmarks) {
            if (benchmark.visibility !== 'public') continue;
            const version = await latestVersion(benchmark.id);
            if (!version) continue;
            const definition = version.definition || {};
            lines.push(JSON.stringify({
                type: 'benchmark', id: benchmark.id, title: benchmark.title, description: benchmark.description,
                kind: benchmark.kind, tags: benchmark.tags, version: version.version, parent: benchmark.parent,
                created_at: benchmark.created_at,
            }));
            for (const task of (definition.tasks || [])) {
                if (!task || task.holdout) continue;
                const item = { type: 'benchmark_task', benchmark: `${benchmark.id}@${version.version}`, id: task.id, prompt: task.prompt };
                if (task.expected != null) item.expected = task.expected;
                lines.push(JSON.stringify(item));
            }
            const runs = await db.many(
                'SELECT * FROM bench_runs WHERE benchmark_id = $1 AND benchmark_version = $2 ORDER BY created_at, id',
                [benchmark.id, version.version]);
            for (const row of runs) {
                const run = wireRun(row);
                lines.push(JSON.stringify({
                    type: 'benchmark_run', benchmark: run.benchmark, model: run.model, route: run.route,
                    provider: run.provider, harness: run.harness, settings: run.settings, hardware: run.hardware,
                    score: run.score, cost_usd: run.cost_usd, ms: run.ms, tokens: run.tokens,
                    provenance: run.provenance, session: run.session, created_at: run.created_at,
                }));
            }
        }
        return lines.length ? `${lines.join('\n')}\n` : '';
    }

    /** The registry list: by kind, by tag, or by a search over the title and the description. */
    /**
     * Benchmarks for a listing: the public ones, plus every one the `owner` owns when one is named. Unlisted and
     * private benchmarks are never listed to anyone else (an unlisted one is reachable by its id; a private one only
     * by its owner and the executor).
     */
    async function listBenchmarks({ kind = null, tag = null, q = null, limit = 50, owner = null } = {}) {
        const where = [];
        const params = [];
        if (owner) { params.push(String(owner)); where.push(`(visibility = 'public' OR owner = $${params.length})`); }
        else where.push("visibility = 'public'");
        if (kind) { params.push(String(kind)); where.push(`kind = $${params.length}`); }
        if (tag) { params.push(JSON.stringify([String(tag)])); where.push(`tags @> $${params.length}::jsonb`); }
        if (q) {
            params.push(`%${String(q).toLowerCase()}%`);
            where.push(`(lower(title) LIKE $${params.length} OR lower(description) LIKE $${params.length})`);
        }
        const sql = `SELECT * FROM bench_benchmarks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                     ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(200, num(limit, 50)))}`;
        const rows = await db.many(sql, params);
        return rows.map(wireBenchmark);
    }

    // ── Runs ─────────────────────────────────────────────────
    /**
     * Publish a run. A service token with bench.run.publish makes a verified run; a person's token makes a submitted
     * run, which is badged and kept out of the default rankings.
     */
    async function publishRun(doc, { provenance, subject }) {
        if (doc.id) {
            const prior = await getRun(String(doc.id));
            if (prior) {
                if (prior.benchmark === String(doc.benchmark) && prior.model === String(doc.model) && prior.session === (doc.session || null)) {
                    return { ok: true, run: prior };
                }
                return refusal(409, 'bench.run_id_conflict', 'That run id already names a different result.');
            }
        }
        const benchmarkId = String(doc.benchmark_id || (doc.benchmark || '').split('@')[0] || '');
        const version = num(doc.benchmark_version || (doc.benchmark || '').split('@')[1]);
        const versionRow = await getVersion(benchmarkId, version);
        if (!versionRow) return refusal(404, 'bench.version_not_found', 'No such benchmark version.');
        const benchmark = await getBenchmark(benchmarkId);
        if (!benchmark) return refusal(404, 'bench.benchmark_not_found', 'No such benchmark.');
        const model = String(doc.model || '').trim();
        if (!model) return refusal(422, 'bench.model_required', 'A run names the model it ran.');
        const provider = String(doc.provider || '').trim();
        if (!provider) return refusal(422, 'bench.provider_required', 'A run names the provider that served the model.');
        const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
        if (!tasks.length) return refusal(422, 'bench.no_tasks', 'A run carries at least one task result.');
        const known = new Set((versionRow.definition.tasks || []).map((t) => String(t.id)));
        for (const t of tasks) {
            if (!known.has(String(t.task_id))) {
                return refusal(422, 'bench.unknown_task', `This benchmark version has no task "${t.task_id}".`);
            }
        }
        // A submitted run has no executor: whatever the body says, the provenance decides.
        const executorKind = provenance === 'submitted' ? 'submitted' : String((doc.executor && doc.executor.kind) || 'codes');
        const executor = { kind: executorKind, id: String((doc.executor && doc.executor.id) || subject || 'unknown') };
        const id = String(doc.id || s.newId('brn'));
        // The published contract has the last word: a run that is not a bench.run@1 document is refused.
        const contract = contractRun({
            ...doc,
            id,
            benchmark: `${benchmarkId}@${version}`,
            executor,
            tasks,
            score: doc.score == null ? null : num(doc.score, 0),
            cost_usd: num(doc.cost_usd, 0),
            ms: num(doc.ms, 0),
            tokens: num(doc.tokens, 0),
            provenance,
        }, s.iso());
        const contractCheck = checkContract('bench.run@2', contract);
        if (!contractCheck.valid) {
            return refusal(400, 'bench.invalid', contractCheck.errors.map((e) => e.message).join('; '));
        }
        const score = doc.score == null ? null : num(doc.score, 0);
        const cost = num(doc.cost_usd, 0);
        const ms = num(doc.ms, 0);
        const tokens = num(doc.tokens, 0);
        await db.tx(async () => {
            await db.exec(
                `INSERT INTO bench_runs (id, benchmark_id, benchmark_version, model, route, provider, harness, settings, executor,
                     hardware, score, cost_usd, ms, tokens, provenance, source, session, created_by, created_at)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19::timestamptz)`,
                [id, benchmarkId, version, model, JSON.stringify(doc.route || {}), provider,
                    JSON.stringify(doc.harness || {}), JSON.stringify(doc.settings || {}), JSON.stringify(executor),
                    doc.hardware == null ? null : JSON.stringify(doc.hardware), score, cost, ms, tokens, provenance,
                    JSON.stringify(doc.source || {}),
                    doc.session == null ? null : String(doc.session).slice(0, 120), String(subject || 'unknown'), s.iso()],
            );
            for (const t of tasks) {
                await db.exec(
                    `INSERT INTO bench_run_tasks (id, run_id, task_id, score, cost_usd, ms, tokens, artifacts, transcript_url, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz)`,
                    [s.newId('brt'), id, String(t.task_id), t.score == null ? null : num(t.score), num(t.cost_usd), num(t.ms), num(t.tokens),
                        JSON.stringify(Array.isArray(t.artifacts) ? t.artifacts : []), t.transcript_url == null ? null : String(t.transcript_url), s.iso()],
                );
            }
        });
        return { ok: true, run: await getRun(id) };
    }

    async function getRun(id) {
        const row = await db.maybe('SELECT * FROM bench_runs WHERE id = $1', [String(id || '')]);
        if (!row) return null;
        const tasks = (await db.many('SELECT * FROM bench_run_tasks WHERE run_id = $1 ORDER BY created_at, id', [row.id])).map(wireTask);
        return wireRun(row, tasks);
    }

    /** Side by side: the same tasks, the same columns, so two runs can be read against each other. */
    async function compareRuns(refs) {
        const runs = [];
        for (const ref of refs) {
            const run = await getRun(ref);
            if (run) runs.push(run);
        }
        if (!runs.length) return null;
        const taskIds = [];
        for (const run of runs) {
            for (const t of run.tasks) if (!taskIds.includes(t.task_id)) taskIds.push(t.task_id);
        }
        return {
            runs,
            task_ids: taskIds,
            rows: taskIds.map((taskId) => ({
                task_id: taskId,
                scores: runs.map((run) => {
                    const t = run.tasks.find((x) => x.task_id === taskId);
                    return t ? t.score : null;
                }),
            })),
        };
    }

    /**
     * The rankings for a benchmark. Verified runs only unless the caller asks for the submitted ones.
     *   score        the median score of a model
     *   value        the median score per dollar
     *   speed        the median score per minute
     *   consistency  the spread of a model's scores inside one session (the lower, the steadier)
     */
    async function rankings({ benchmark, metric = 'score', harness = null, since = null, includeSubmitted = false }) {
        const ref = parseRef(benchmark);
        if (!ref) return null;
        const versions = await db.many(
            'SELECT version FROM bench_benchmark_versions WHERE benchmark_id = $1 ORDER BY version DESC',
            [ref.id]);
        const wanted = ref.version != null ? [ref.version] : versions.map((v) => num(v.version));
        if (!wanted.length) return null;
        const params = [ref.id, wanted];
        let sql = `SELECT * FROM bench_runs WHERE benchmark_id = $1 AND benchmark_version = ANY($2::int[])`;
        if (!includeSubmitted) sql += " AND provenance = 'verified'";
        // Each filter takes the next placeholder: `since` alone is $3, not $4.
        if (harness) { params.push(String(harness)); sql += ` AND harness->>'name' = $${params.length}`; }
        if (since) { params.push(String(since)); sql += ` AND created_at >= $${params.length}::timestamptz`; }
        const rows = await db.many(sql, params);
        const byModel = new Map();
        for (const row of rows) {
            const run = wireRun(row);
            if (!byModel.has(run.model)) byModel.set(run.model, []);
            byModel.get(run.model).push(run);
        }
        const entries = [];
        for (const [model, list] of byModel) {
            const scores = list.map((r) => r.score);
            const cleanScores = scores.filter((v) => v != null);
            const costs = list.map((r) => r.cost_usd);
            const times = list.map((r) => r.ms);
            const medScore = median(scores);
            const medCost = median(costs);
            const medMs = median(times);
            const sessions = new Map();
            for (const r of list) {
                if (r.score == null) continue;
                const key = r.session || 'default';
                if (!sessions.has(key)) sessions.set(key, []);
                sessions.get(key).push(r.score);
            }
            const spreads = [...sessions.values()].filter((v) => v.length > 1).map((v) => Math.max(...v) - Math.min(...v));
            const entry = {
                model,
                runs: list.length,
                score: medScore == null ? null : Math.round(medScore * 1000) / 1000,
                cost_usd: medCost == null ? null : Math.round(medCost * 1e6) / 1e6,
                ms: medMs == null ? null : Math.round(medMs),
                value: medScore != null && medCost ? Math.round((medScore / medCost) * 1000) / 1000 : null,
                speed: medScore != null && medMs ? Math.round((medScore / (medMs / 60000)) * 1000) / 1000 : null,
                consistency: spreads.length ? Math.round(median(spreads) * 1000) / 1000 : null,
                sessions: sessions.size,
                // What the runs actually did, and the value metric of the rules: cost per solved task = the cost
                // of an attempt divided by the success rate (the median score / 100).
                min_score: cleanScores.length ? Math.min(...cleanScores) : null,
                max_score: cleanScores.length ? Math.max(...cleanScores) : null,
                spread: cleanScores.length ? Math.round((Math.max(...cleanScores) - Math.min(...cleanScores)) * 1000) / 1000 : null,
                cost_per_solved: medScore > 0 && medCost > 0 ? Math.round((medCost / (medScore / 100)) * 1e6) / 1e6 : null,
            };
            entries.push(entry);
        }
        const key = { score: 'score', value: 'value', speed: 'speed', consistency: 'consistency' }[metric];
        if (!key) return null;
        const ascending = metric === 'consistency';
        entries.sort((a, b) => {
            const av = a[key]; const bv = b[key];
            if (av == null && bv == null) return a.model.localeCompare(b.model);
            if (av == null) return 1;
            if (bv == null) return -1;
            if (av === bv) return a.model.localeCompare(b.model);
            return ascending ? av - bv : bv - av;
        });
        // Ranks are bands, not places: models whose score intervals overlap share a band. The interval is the
        // run-to-run spread here (a private set has too few runs for a bootstrap to say more).
        if (metric === 'score') {
            const bands = rankBands(entries.filter((e) => e.score != null).map((e) => ({
                model: e.model,
                rating: e.score,
                ci_lower: e.min_score == null ? e.score : e.min_score,
                ci_upper: e.max_score == null ? e.score : e.max_score,
            })));
            const bandOf = new Map();
            for (const band of bands) for (const model of band.models) bandOf.set(model, band);
            for (const e of entries) {
                const band = bandOf.get(e.model);
                e.band = band ? band.label : null;
                e.band_from = band ? band.from : null;
                e.band_to = band ? band.to : null;
            }
        }
        return { benchmark: ref.id, metric, entries };
    }

    /** Where a score sits among a model's runs on a benchmark: the percentile, 0-100. */
    async function percentile({ benchmark, model, score }) {
        const ref = parseRef(benchmark);
        if (!ref || !model) return null;
        const params = [ref.id];
        let sql = "SELECT score FROM bench_runs WHERE benchmark_id = $1 AND model = $2 AND provenance = 'verified'";
        params.push(String(model));
        if (ref.version != null) { params.push(ref.version); sql += ' AND benchmark_version = $3'; }
        const rows = await db.many(sql, params);
        const scores = rows.filter((r) => r.score != null).map((r) => num(r.score));
        if (!scores.length) return { benchmark: ref.id, model: String(model), runs: 0, percentile: null, score: num(score) };
        const value = num(score);
        const below = scores.filter((v) => v < value).length;
        const equal = scores.filter((v) => v === value).length;
        const pct = Math.round(((below + equal / 2) / scores.length) * 1000) / 10;
        return {
            benchmark: ref.id,
            model: String(model),
            runs: scores.length,
            score: value,
            percentile: pct,
            median: Math.round(median(scores) * 1000) / 1000,
            best: Math.max(...scores),
            worst: Math.min(...scores),
        };
    }

    /**
     * Runs, newest first, for the pages: a benchmark's latest runs, a model's, or one person's. Without tasks: a list
     * row needs the totals only. Submitted runs are listed (and labelled) unless `verifiedOnly`.
     */
    /** How many runs each benchmark has, verified and submitted: the listing's counts. */
    async function runCounts() {
        const rows = await db.many('SELECT benchmark_id, COUNT(*)::int AS n FROM bench_runs GROUP BY benchmark_id');
        return new Map(rows.map((r) => [r.benchmark_id, num(r.n)]));
    }

    async function listRuns({ benchmark = null, model = null, createdBy = null, verifiedOnly = false, publicOnly = false, limit = 20 } = {}) {
        const where = [];
        const params = [];
        const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };
        if (benchmark) {
            const ref = parseRef(benchmark);
            if (!ref) return [];
            add('benchmark_id = ?', ref.id);
            if (ref.version != null) add('benchmark_version = ?', ref.version);
        }
        if (model) add('model = ?', String(model));
        if (createdBy) add('created_by = ?', String(createdBy));
        if (verifiedOnly) where.push("provenance = 'verified'");
        // A listing across benchmarks (a model's page) shows the public benchmarks' runs only.
        if (publicOnly) where.push("benchmark_id IN (SELECT id FROM bench_benchmarks WHERE visibility = 'public')");
        params.push(Math.min(100, Math.max(1, Number(limit) || 20)));
        const rows = await db.many(
            `SELECT * FROM bench_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
            params);
        return rows.map((row) => wireRun(row));
    }

    /**
     * One model across every public benchmark it ran: per benchmark, its verified runs, the median score, cost and time, and
     * the spread between its best and worst run. The model page reads this.
     */
    async function modelSummary(model) {
        const rows = await db.many(
            "SELECT benchmark_id, score, cost_usd, ms FROM bench_runs WHERE model = $1 AND provenance = 'verified'"
            + " AND benchmark_id IN (SELECT id FROM bench_benchmarks WHERE visibility = 'public')",
            [String(model || '')]);
        const byBenchmark = new Map();
        for (const row of rows) {
            if (!byBenchmark.has(row.benchmark_id)) byBenchmark.set(row.benchmark_id, []);
            byBenchmark.get(row.benchmark_id).push(row);
        }
        const round = (v, p) => (v == null ? null : Math.round(v * p) / p);
        const out = [];
        for (const [benchmarkId, list] of byBenchmark) {
            const scores = list.map((r) => num(r.score));
            const b = await getBenchmark(benchmarkId);
            out.push({
                benchmark_id: benchmarkId,
                title: b ? b.title : benchmarkId,
                kind: b ? b.kind : null,
                runs: list.length,
                score: round(median(scores), 1000),
                best: Math.max(...scores),
                worst: Math.min(...scores),
                cost_usd: round(median(list.map((r) => num(r.cost_usd))), 1e6),
                ms: round(median(list.map((r) => num(r.ms))), 1),
            });
        }
        out.sort((a, b) => b.runs - a.runs || a.title.localeCompare(b.title));
        return { model: String(model || ''), runs: rows.length, benchmarks: out };
    }

    return {
        createBenchmark, getBenchmark, getVersion, latestVersion, getDefinition, saveDraft, freezeVersion,
        forkBenchmark, setVisibility, findShared, publicDatasetLines,
        listBenchmarks, publishRun, getRun, compareRuns, rankings, percentile, listRuns, modelSummary, runCounts,
    };
}

module.exports = {
    createRegistry, RegistryError, hashDefinition, canonical, median, parseRef,
    canViewBenchmark, shareTokenHash, shareTokenMatches, newShareToken,
};

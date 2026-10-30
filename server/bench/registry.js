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
const { isHeldOut, addedOn, humanMinutes, humanMinutesSource } = require('./task-meta');
const { cutoffFor } = require('./model-cutoffs');
const { contaminationFor } = require('./contamination');
const { estimateHorizon } = require('./horizon');

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

/**
 * The published bench.benchmark@1 task shape closes its properties, so the B13 fields (added_on, held_out,
 * human_minutes and its source) live in bench_task_meta beside the frozen definition. These two helpers keep the
 * stored document valid and put the fields back on Bench's own read path.
 */
function contractTask(task) {
    const t = task && typeof task === 'object' ? task : {};
    const out = {
        id: String(t.id == null ? '' : t.id),
        prompt: String(t.prompt == null ? '' : t.prompt),
        files: Array.isArray(t.files) ? t.files : [],
        expected: t.expected === undefined ? null : t.expected,
        holdout: isHeldOut(t),
    };
    return out;
}

function taskMetaOf(task) {
    return {
        added_on: addedOn(task),
        held_out: isHeldOut(task),
        human_minutes: humanMinutes(task),
        human_minutes_source: humanMinutesSource(task),
    };
}

function mergeTaskMeta(definition, metaRows) {
    if (!Array.isArray(definition.tasks) || !metaRows) return definition;
    const byTask = new Map();
    for (const row of metaRows) byTask.set(String(row.task_id), row);
    return {
        ...definition,
        tasks: definition.tasks.map((task) => {
            const meta = byTask.get(String(task && task.id));
            if (!meta) return task;
            const out = { ...task };
            if (meta.added_on) out.added_on = String(meta.added_on).slice(0, 10);
            if (meta.held_out) { out.holdout = true; out.held_out = true; }
            if (meta.human_minutes != null) out.human_minutes = num(meta.human_minutes);
            if (meta.human_minutes_source) out.human_minutes_source = meta.human_minutes_source;
            return out;
        }),
    };
}

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

/** A working copy whose held-out prompts stay on the server, even in a listing that carries the draft. */
function wireDraft(value) {
    const draft = json(value, null);
    if (!draft || !Array.isArray(draft.tasks)) return draft;
    return {
        ...draft,
        tasks: draft.tasks.map((t) => (t && isHeldOut(t) ? { ...t, prompt: null, expected: null, files: null } : t)),
    };
}

function wireBenchmark(row, { revealDraft = false } = {}) {
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
        draft: revealDraft ? json(row.draft, null) : wireDraft(row.draft),
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
    const out = {
        task_id: row.task_id,
        score: row.score == null ? null : num(row.score),
        cost_usd: num(row.cost_usd),
        ms: num(row.ms),
        tokens: num(row.tokens),
        artifacts: (Array.isArray(json(row.artifacts, [])) ? json(row.artifacts, []) : []).map((a) => ({ kind: a.kind, url: a.url })).filter((a) => a.url),
        transcript_url: row.transcript_url || null,
    };
    if (row.added_on) out.added_on = String(row.added_on).slice(0, 10);
    if (row.held_out) out.held_out = true;
    if (row.human_minutes != null) {
        out.human_minutes = num(row.human_minutes);
        if (row.human_minutes_source) out.human_minutes_source = row.human_minutes_source;
    }
    return out;
}

/** The median of a list of numbers. */
function median(values) {
    const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!list.length) return null;
    const mid = Math.floor(list.length / 2);
    return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * A `since` value: "YYYY-MM" (a monthly fresh set), "YYYY-MM-DD", or a full timestamp (the B2 form, still accepted).
 * The cutoff is the first instant of the month/day. The label is what a page says beside the board.
 */
function parseSince(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    let m = /^(\d{4})-(\d{2})$/.exec(text);
    if (m) {
        const month = Number(m[2]);
        if (month < 1 || month > 12) return null;
        const cutoff = `${m[1]}-${m[2]}-01`;
        return { text, cutoff, month: `${m[1]}-${m[2]}`, timestamp: `${cutoff}T00:00:00.000Z`, label: `${MONTH_NAMES[month - 1]} ${m[1]}` };
    }
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (m) {
        const month = Number(m[2]);
        if (month < 1 || month > 12) return null;
        const cutoff = text.slice(0, 10);
        if (Number.isNaN(Date.parse(`${cutoff}T00:00:00Z`))) return null;
        return { text, cutoff, month: `${m[1]}-${m[2]}`, timestamp: `${cutoff}T00:00:00.000Z`, label: `${MONTH_NAMES[month - 1]} ${m[1]}` };
    }
    const stamp = Date.parse(text);
    if (Number.isNaN(stamp)) return null;
    const d = new Date(stamp);
    const month = d.getUTCMonth();
    const cutoff = d.toISOString().slice(0, 10);
    return { text, cutoff, month: cutoff.slice(0, 7), timestamp: d.toISOString(), label: `${MONTH_NAMES[month]} ${d.getUTCFullYear()}` };
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
        return { ok: true, benchmark: await getBenchmark(id, { revealDraft: true }) };
    }

    /** The working copy: what a later freeze would publish. The draft's held-out prompts stay inside unless asked. */
    async function getBenchmark(id, { revealDraft = false } = {}) {
        return wireBenchmark(await db.maybe('SELECT * FROM bench_benchmarks WHERE id = $1', [String(id || '')]), { revealDraft });
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

    /** The B13 metadata of the named versions, as rows keyed by version and task id. */
    async function loadTaskMeta(benchmarkId, versions) {
        if (!versions.length) return [];
        return db.many(
            `SELECT * FROM bench_task_meta WHERE benchmark_id = $1 AND benchmark_version = ANY($2::int[])
             ORDER BY benchmark_version, task_id`,
            [String(benchmarkId), versions.map(num)]);
    }

    /** The metadata map the rankings and the horizon read: stored metadata plus the base task's own holdout flag. */
    function taskMetaMap(versions, definitions, metaRows) {
        const out = new Map();
        for (const version of versions) {
            const definition = definitions.get(num(version)) || {};
            for (const task of (definition.tasks || [])) {
                if (!task || task.id == null) continue;
                out.set(`${num(version)}:${String(task.id)}`, {
                    added_on: addedOn(task), held_out: isHeldOut(task),
                    human_minutes: humanMinutes(task), human_minutes_source: humanMinutesSource(task),
                });
            }
        }
        for (const row of metaRows) {
            const key = `${num(row.benchmark_version)}:${String(row.task_id)}`;
            out.set(key, {
                added_on: row.added_on ? String(row.added_on).slice(0, 10) : null,
                held_out: Boolean(row.held_out),
                human_minutes: row.human_minutes == null ? null : num(row.human_minutes),
                human_minutes_source: row.human_minutes_source || null,
            });
        }
        return out;
    }

    /**
     * The definition of a benchmark, at a version or at its newest frozen one. Holdout tasks are withheld unless the
     * caller holds bench.run.publish: the executor may see them, everyone else may not.
     *
     * `version.definition` stays the closed contract document. `definition` is Bench's own view, with the B13 task
     * fields merged back in; `task_meta` is the same metadata without any prompt. A page reads `definition`.
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
        const metaRows = await loadTaskMeta(ref.id, [version.version]);
        const base = { ...version.definition };
        const merged = mergeTaskMeta(base, metaRows);
        const hide = (definition) => {
            if (reveal || !Array.isArray(definition.tasks)) return definition;
            return {
                ...definition,
                tasks: definition.tasks.map((t) => (t && isHeldOut(t) ? { ...t, prompt: null, expected: null, files: null, holdout: true, held_out: true } : t)),
            };
        };
        return {
            benchmark,
            version: { ...version, definition: hide(base) },
            definition: hide(merged),
            task_meta: metaRows.map((row) => ({
                task_id: row.task_id,
                added_on: row.added_on ? String(row.added_on).slice(0, 10) : null,
                held_out: Boolean(row.held_out),
                human_minutes: row.human_minutes == null ? null : num(row.human_minutes),
                human_minutes_source: row.human_minutes_source || null,
            })),
        };
    }

    /** Write the B13 metadata of a version's tasks. The definition itself stays contract-shaped. */
    async function replaceTaskMeta(benchmarkId, version, tasks) {
        await db.exec('DELETE FROM bench_task_meta WHERE benchmark_id = $1 AND benchmark_version = $2', [String(benchmarkId), num(version)]);
        for (const task of tasks) {
            const meta = taskMetaOf(task);
            if (!meta.added_on && !meta.held_out && meta.human_minutes == null && !meta.human_minutes_source) continue;
            await db.exec(
                `INSERT INTO bench_task_meta (benchmark_id, benchmark_version, task_id, added_on, held_out, human_minutes, human_minutes_source)
                 VALUES ($1, $2, $3, $4::date, $5, $6, $7)
                 ON CONFLICT (benchmark_id, benchmark_version, task_id)
                 DO UPDATE SET added_on = EXCLUDED.added_on, held_out = EXCLUDED.held_out,
                     human_minutes = EXCLUDED.human_minutes, human_minutes_source = EXCLUDED.human_minutes_source`,
                [String(benchmarkId), num(version), String(task.id), meta.added_on, meta.held_out, meta.human_minutes, meta.human_minutes_source]);
        }
    }

    /** Save a new draft. A version named in the body is edited in place, and only while no run names it. */
    async function saveDraft(id, { definition = {}, subject }) {
        const benchmark = await getBenchmark(id, { revealDraft: true });
        if (!benchmark) return refusal(404, 'bench.benchmark_not_found', 'No such benchmark.');
        const version = definition.version == null ? null : num(definition.version);
        if (version != null) {
            const row = await getVersion(benchmark.id, version);
            if (!row) return refusal(404, 'bench.version_not_found', 'No such version.');
            const used = num(await db.value('SELECT COUNT(*)::int AS n FROM bench_runs WHERE benchmark_id = $1 AND benchmark_version = $2', [benchmark.id, version]));
            if (used > 0) {
                return refusal(409, 'bench.version_frozen', 'A version that a run names never changes again. Fork the benchmark instead.');
            }
            const tasks = Array.isArray(definition.tasks) ? definition.tasks : null;
            // A caller that read the contract-shaped definition has no B13 fields; keep the stored metadata for a
            // task it leaves unchanged rather than erasing a date or a time on every edit.
            const priorMeta = new Map((await loadTaskMeta(benchmark.id, [version])).map((m) => [String(m.task_id), m]));
            const mergedTasks = tasks ? tasks.map((task) => {
                const meta = priorMeta.get(String(task && task.id));
                if (!meta) return task;
                const out = { ...task };
                if (out.added_on == null && meta.added_on) out.added_on = String(meta.added_on).slice(0, 10);
                if (out.held_out == null && out.holdout == null && meta.held_out) out.held_out = true;
                if (out.human_minutes == null && meta.human_minutes != null) {
                    out.human_minutes = num(meta.human_minutes);
                    if (meta.human_minutes_source) out.human_minutes_source = meta.human_minutes_source;
                }
                return out;
            }) : null;
            const next = {
                ...row.definition,
                ...definition,
                version,
                ...(mergedTasks ? { tasks: mergedTasks.map(contractTask) } : {}),
            };
            await db.exec(
                'UPDATE bench_benchmark_versions SET definition = $1::jsonb, hash = $2 WHERE benchmark_id = $3 AND version = $4',
                [JSON.stringify(next), hashDefinition(next), benchmark.id, version]);
            if (mergedTasks) await replaceTaskMeta(benchmark.id, version, mergedTasks);
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
        const benchmark = await getBenchmark(id, { revealDraft: true });
        if (!benchmark) return refusal(404, 'bench.benchmark_not_found', 'No such benchmark.');
        const source = definition || benchmark.draft || {};
        const rawTasks = Array.isArray(source.tasks) ? source.tasks : [];
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
            tasks: rawTasks.map(contractTask),
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
        await replaceTaskMeta(benchmark.id, version, rawTasks);
        await db.exec('UPDATE bench_benchmarks SET latest_version = $1, updated_at = $2::timestamptz WHERE id = $3',
            [version, s.iso(), benchmark.id]);
        return { ok: true, version: await getVersion(benchmark.id, version), benchmark: await getBenchmark(benchmark.id) };
    }

    /** A fork: a new benchmark of its own that records the parent it came from. */
    async function forkBenchmark(id, { version = null, title = null, owner, subject, reveal = true }) {
        const ref = version == null ? String(id || '') : `${String(id || '')}@${num(version)}`;
        const source = await getDefinition(ref, { reveal });
        if (!source) return refusal(404, 'bench.benchmark_not_found', 'No such benchmark.');
        // A held-out prompt only goes to its owner or the executor. A fork by anyone else is refused rather than
        // copied with a blank prompt: the text never has to leave the server to make the copy.
        if (!reveal && source.definition.tasks.some((t) => isHeldOut(t))) {
            return refusal(403, 'bench.holdout_fork_refused', 'This benchmark has held-out tasks; only its owner or the executor can fork it.');
        }
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
            const metaRows = await loadTaskMeta(benchmark.id, [version.version]);
            const definition = mergeTaskMeta(version.definition || {}, metaRows);
            lines.push(JSON.stringify({
                type: 'benchmark', id: benchmark.id, title: benchmark.title, description: benchmark.description,
                kind: benchmark.kind, tags: benchmark.tags, version: version.version, parent: benchmark.parent,
                created_at: benchmark.created_at,
            }));
            const estimates = await estimateMedians(benchmark.id, [version.version]);
            for (const task of (definition.tasks || [])) {
                if (!task || isHeldOut(task)) continue;
                const item = { type: 'benchmark_task', benchmark: `${benchmark.id}@${version.version}`, id: task.id, prompt: task.prompt };
                if (task.expected != null) item.expected = task.expected;
                if (addedOn(task)) item.added_on = addedOn(task);
                const timed = taskMinutes(task, `${num(version.version)}:${String(task.id)}`, estimates);
                if (timed) {
                    item.human_minutes = timed.minutes;
                    item.human_minutes_source = timed.source;
                }
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
    async function listBenchmarks({ kind = null, tag = null, q = null, limit = 50, owner = null, viewer = null } = {}) {
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
        return rows.map((row) => wireBenchmark(row, { revealDraft: viewer != null && String(row.owner) === String(viewer) }));
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
        const metaRows = await loadTaskMeta(benchmarkId, [version]);
        const mergedDefinition = mergeTaskMeta(versionRow.definition, metaRows);
        const taskMetaById = new Map((mergedDefinition.tasks || []).map((t) => [String(t.id), t]));
        for (const t of tasks) {
            if (!taskMetaById.has(String(t.task_id))) {
                return refusal(422, 'bench.unknown_task', `This benchmark version has no task "${t.task_id}".`);
            }
        }
        // A held-out task is scored only by the executor (a verified run). A submitted run, including an import or
        // a mirrored result, may name the task, but its score is dropped before anything is stored.
        const storedTasks = tasks.map((t) => {
            const meta = taskMetaById.get(String(t.task_id)) || {};
            return provenance === 'submitted' && isHeldOut(meta) ? { ...t, score: null } : t;
        });
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
            tasks: storedTasks,
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
            for (const t of storedTasks) {
                const meta = taskMetaById.get(String(t.task_id)) || {};
                await db.exec(
                    `INSERT INTO bench_run_tasks (id, run_id, task_id, score, cost_usd, ms, tokens, artifacts, transcript_url,
                         added_on, held_out, human_minutes, human_minutes_source, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::date, $11, $12, $13, $14::timestamptz)`,
                    [s.newId('brt'), id, String(t.task_id), t.score == null ? null : num(t.score), num(t.cost_usd), num(t.ms), num(t.tokens),
                        JSON.stringify(Array.isArray(t.artifacts) ? t.artifacts : []), t.transcript_url == null ? null : String(t.transcript_url),
                        addedOn(meta), isHeldOut(meta), humanMinutes(meta), humanMinutesSource(meta), s.iso()],
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

    /** Median of each task's editor estimates, when at least three people have entered one. */
    async function estimateMedians(benchmarkId, versions) {
        const out = new Map();
        if (!versions.length) return out;
        const rows = await db.many(
            `SELECT benchmark_version, task_id, minutes FROM bench_task_estimates
             WHERE benchmark_id = $1 AND benchmark_version = ANY($2::int[])`,
            [String(benchmarkId), versions]);
        const grouped = new Map();
        for (const row of rows) {
            const key = `${num(row.benchmark_version)}:${String(row.task_id)}`;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(num(row.minutes));
        }
        for (const [key, list] of grouped) {
            if (list.length >= 3) out.set(key, { median: median(list), count: list.length });
        }
        return out;
    }

    /** The minutes of a task: the author's own estimate first, else the median of three editors. */
    function taskMinutes(task, key, estimates) {
        const author = humanMinutes(task);
        if (author != null) return { minutes: author, source: humanMinutesSource(task) || 'benchmark author' };
        const estimate = estimates.get(key);
        if (estimate) return { minutes: estimate.median, source: `median of ${estimate.count} editor estimates` };
        return null;
    }

    /**
     * The rankings for a benchmark. Verified runs only unless the caller asks for the submitted ones.
     *   score        the median score of a model
     *   value        the median score per dollar
     *   speed        the median score per minute
     *   consistency  the spread of a model's scores inside one session (the lower, the steadier)
     *   horizon      the 50% human-time horizon (minutes; higher is better)
     *
     * `since` is a monthly fresh set: with dated tasks, only the tasks added on or after that month are scored.
     * An older benchmark whose tasks carry no dates keeps the B2 meaning (runs created since the date), so nothing
     * that worked before stops working. Each entry also carries the contamination flag and the time horizon when
     * there is enough data for either.
     */
    async function rankings({ benchmark, metric = 'score', harness = null, since = null, includeSubmitted = false }) {
        const ref = parseRef(benchmark);
        if (!ref) return null;
        const versions = await db.many(
            'SELECT version FROM bench_benchmark_versions WHERE benchmark_id = $1 ORDER BY version DESC',
            [ref.id]);
        const wanted = ref.version != null ? [ref.version] : versions.map((v) => num(v.version));
        if (!wanted.length) return null;
        const definitions = new Map();
        for (const version of wanted) {
            const row = await getVersion(ref.id, version);
            if (row) definitions.set(num(version), row.definition || {});
        }
        if (!definitions.size) return null;

        const sinceParsed = since ? parseSince(since) : null;
        const metaRows = await loadTaskMeta(ref.id, wanted);
        const metaByKey = taskMetaMap(wanted, definitions, metaRows);
        const datedTasks = [...metaByKey.values()].filter((meta) => meta.added_on);
        const taskBasis = Boolean(sinceParsed && datedTasks.length);
        const selected = new Set();
        if (taskBasis) {
            for (const [key, meta] of metaByKey) {
                if (meta.added_on && meta.added_on >= sinceParsed.cutoff) selected.add(key);
            }
        }

        const params = [ref.id, wanted];
        let sql = `SELECT * FROM bench_runs WHERE benchmark_id = $1 AND benchmark_version = ANY($2::int[])`;
        if (!includeSubmitted) sql += " AND provenance = 'verified'";
        // Each filter takes the next placeholder: `since` alone is $3, not $4.
        if (harness) { params.push(String(harness)); sql += ` AND harness->>'name' = $${params.length}`; }
        if (sinceParsed && !taskBasis) {
            params.push(sinceParsed.timestamp);
            sql += ` AND created_at >= $${params.length}::timestamptz`;
        }
        const rows = await db.many(sql, params);
        const runIds = rows.map((row) => String(row.id));
        const taskRows = runIds.length
            ? await db.many('SELECT * FROM bench_run_tasks WHERE run_id = ANY($1::text[]) ORDER BY created_at, id', [runIds])
            : [];
        const tasksByRun = new Map();
        for (const row of taskRows) {
            if (!tasksByRun.has(row.run_id)) tasksByRun.set(row.run_id, []);
            tasksByRun.get(row.run_id).push(row);
        }
        const estimates = await estimateMedians(ref.id, wanted);

        /** The score and totals of one run, over the selected tasks when a monthly set is asked for. */
        function subsetOf(run) {
            if (!taskBasis) {
                return { score: run.score, cost_usd: run.cost_usd, ms: run.ms, tokens: run.tokens };
            }
            const picked = (tasksByRun.get(run.id) || []).filter((row) => {
                if (row.score == null) return false;
                return selected.has(`${num(run.benchmark_version)}:${String(row.task_id)}`);
            });
            if (!picked.length) return null;
            return {
                score: picked.reduce((n, row) => n + num(row.score), 0) / picked.length,
                cost_usd: picked.reduce((n, row) => n + num(row.cost_usd), 0),
                ms: picked.reduce((n, row) => n + num(row.ms), 0),
                tokens: picked.reduce((n, row) => n + num(row.tokens), 0),
            };
        }

        /** The contamination flag: per run, the mean of its old tasks and of its fresh tasks. */
        function contaminationOf(model, list) {
            const cutoff = cutoffFor(model);
            if (!cutoff) return contaminationFor({ cutoff: null });
            const oldScores = [];
            const freshScores = [];
            for (const run of list) {
                let oldSum = 0; let oldN = 0; let freshSum = 0; let freshN = 0;
                for (const row of tasksByRun.get(run.id) || []) {
                    if (row.score == null) continue;
                    const meta = metaByKey.get(`${num(run.benchmark_version)}:${String(row.task_id)}`) || {};
                    const day = row.added_on ? String(row.added_on).slice(0, 10) : (meta.added_on || null);
                    if (!day) continue;
                    if (day < cutoff.cutoff) { oldSum += num(row.score); oldN++; }
                    else { freshSum += num(row.score); freshN++; }
                }
                if (oldN) oldScores.push(oldSum / oldN);
                if (freshN) freshScores.push(freshSum / freshN);
            }
            return contaminationFor({ oldScores, freshScores, cutoff: cutoff.cutoff, source: cutoff.source });
        }

        /** The time horizon of one model over the runs in scope. */
        function horizonOfModel(list) {
            const groups = new Map();
            let timedRuns = 0;
            for (const run of list) {
                let touched = false;
                for (const row of tasksByRun.get(run.id) || []) {
                    if (row.score == null) continue;
                    const version = num(run.benchmark_version);
                    const key = `${version}:${String(row.task_id)}`;
                    const meta = metaByKey.get(key) || {};
                    const timed = taskMinutes(meta, key, estimates);
                    if (!timed) continue;
                    if (!groups.has(key)) groups.set(key, { minutes: timed.minutes, source: timed.source, scores: [] });
                    groups.get(key).scores.push(num(row.score));
                    touched = true;
                }
                if (touched) timedRuns++;
            }
            const taskGroups = [...groups.values()].map((g) => ({
                minutes: g.minutes,
                success: g.scores.reduce((n, v) => n + v, 0) / g.scores.length / 100,
                runs: g.scores.length,
                source: g.source,
            }));
            return estimateHorizon(taskGroups, { runs: timedRuns, timedTasks: taskGroups.length });
        }

        const byModel = new Map();
        for (const row of rows) {
            const run = wireRun(row);
            const subset = subsetOf(run);
            if (sinceParsed && taskBasis && !subset) continue;
            if (!byModel.has(run.model)) byModel.set(run.model, []);
            byModel.get(run.model).push({ run, subset });
        }
        const entries = [];
        for (const [model, list] of byModel) {
            const scores = list.map((item) => item.subset && item.subset.score);
            const cleanScores = scores.filter((v) => v != null);
            const costs = list.map((item) => (item.subset ? item.subset.cost_usd : null));
            const times = list.map((item) => (item.subset ? item.subset.ms : null));
            const medScore = median(scores);
            const medCost = median(costs);
            const medMs = median(times);
            const sessions = new Map();
            for (const item of list) {
                if (!item.subset || item.subset.score == null) continue;
                const key = item.run.session || 'default';
                if (!sessions.has(key)) sessions.set(key, []);
                sessions.get(key).push(item.subset.score);
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
                contamination: contaminationOf(model, list.map((item) => item.run)),
                horizon: horizonOfModel(list.map((item) => item.run)),
            };
            entries.push(entry);
        }
        const valueOf = (entry) => {
            if (metric === 'horizon') return entry.horizon && entry.horizon.available ? entry.horizon.horizon_minutes : null;
            return entry[{ score: 'score', value: 'value', speed: 'speed', consistency: 'consistency' }[metric]];
        };
        if (!['score', 'value', 'speed', 'consistency', 'horizon'].includes(metric)) return null;
        const ascending = metric === 'consistency';
        entries.sort((a, b) => {
            const av = valueOf(a); const bv = valueOf(b);
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
        return {
            benchmark: ref.id,
            metric,
            since: sinceParsed ? { month: sinceParsed.month, label: sinceParsed.label, basis: taskBasis ? 'tasks' : 'runs' } : null,
            entries,
        };
    }

    // ── Human-time estimates (B13) ───────────────────────────
    const ESTIMATES_PER_HOUR = 30;

    async function taskEstimateSummary(benchmarkId, version, taskId) {
        const rows = await db.many(
            `SELECT minutes FROM bench_task_estimates
             WHERE benchmark_id = $1 AND benchmark_version = $2 AND task_id = $3 ORDER BY created_at`,
            [String(benchmarkId), num(version), String(taskId)]);
        const values = rows.map((row) => num(row.minutes));
        return {
            count: values.length,
            needed: Math.max(0, 3 - values.length),
            median: values.length >= 3 ? Math.round(median(values) * 10) / 10 : null,
            values,
        };
    }

    /**
     * One editor's estimate on a task. A person has one estimate per task; a later entry replaces it. More than
     * thirty entries an hour from one person is refused, so a script cannot flood the median.
     */
    async function addTaskEstimate({ benchmarkId, version, taskId, minutes, subject }) {
        if (!subject) return refusal(401, 'bench.sign_in_required', 'Sign in to estimate a task.');
        const value = Number(minutes);
        if (!Number.isFinite(value) || value <= 0 || value > 100000) {
            return refusal(422, 'bench.invalid_minutes', 'The estimate must be a positive number of minutes.');
        }
        const versionRow = await getVersion(benchmarkId, version);
        if (!versionRow) return refusal(404, 'bench.version_not_found', 'No such benchmark version.');
        const task = (versionRow.definition.tasks || []).find((t) => String(t.id) === String(taskId));
        if (!task) return refusal(404, 'bench.task_not_found', 'No such task.');
        const recent = num(await db.value(
            `SELECT COUNT(*)::int AS n FROM bench_task_estimates
             WHERE subject = $1 AND created_at >= now() - interval '1 hour'`, [String(subject)]));
        if (recent >= ESTIMATES_PER_HOUR) {
            return refusal(429, 'bench.estimate_rate_limited', 'Too many estimates in an hour. Try again later.');
        }
        const row = await db.maybe(
            `INSERT INTO bench_task_estimates (id, benchmark_id, benchmark_version, task_id, subject, minutes, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
             ON CONFLICT (benchmark_id, benchmark_version, task_id, subject)
             DO UPDATE SET minutes = EXCLUDED.minutes, created_at = EXCLUDED.created_at
             RETURNING *`,
            [s.newId('bte'), String(benchmarkId), num(version), String(taskId), String(subject), Math.round(value * 10) / 10, s.iso()]);
        return { ok: true, estimate: { task_id: String(taskId), minutes: num(row.minutes), created_at: iso(row.created_at) }, summary: await taskEstimateSummary(benchmarkId, version, taskId) };
    }

    /** The time horizon of one model over every timed task it ran on a public benchmark. */
    async function modelHorizon(model) {
        const rows = await db.many(
            `SELECT id, benchmark_id, benchmark_version FROM bench_runs
             WHERE model = $1 AND provenance = 'verified'
               AND benchmark_id IN (SELECT id FROM bench_benchmarks WHERE visibility = 'public')`,
            [String(model || '')]);
        if (!rows.length) return estimateHorizon([], { runs: 0, timedTasks: 0 });
        const definitions = new Map();
        for (const row of rows) {
            const key = `${row.benchmark_id}:${num(row.benchmark_version)}`;
            if (!definitions.has(key)) {
                const versionRow = await getVersion(row.benchmark_id, row.benchmark_version);
                definitions.set(key, versionRow ? versionRow.definition : null);
            }
        }
        const metaRows = await db.many(
            `SELECT m.* FROM bench_task_meta m JOIN bench_benchmarks b ON b.id = m.benchmark_id
             WHERE b.visibility = 'public'`);
        const metaByKey = new Map(metaRows.map((row) => [`${row.benchmark_id}:${num(row.benchmark_version)}:${String(row.task_id)}`, {
            added_on: row.added_on ? String(row.added_on).slice(0, 10) : null,
            held_out: Boolean(row.held_out),
            human_minutes: row.human_minutes == null ? null : num(row.human_minutes),
            human_minutes_source: row.human_minutes_source || null,
        }]));
        const estimates = new Map();
        const estimateRows = await db.many(
            `SELECT e.benchmark_id, e.benchmark_version, e.task_id, e.minutes
             FROM bench_task_estimates e JOIN bench_benchmarks b ON b.id = e.benchmark_id
             WHERE b.visibility = 'public'`);
        const byTask = new Map();
        for (const row of estimateRows) {
            const key = `${row.benchmark_id}:${num(row.benchmark_version)}:${String(row.task_id)}`;
            if (!byTask.has(key)) byTask.set(key, []);
            byTask.get(key).push(num(row.minutes));
        }
        for (const [key, list] of byTask) if (list.length >= 3) estimates.set(key, { median: median(list), count: list.length });

        const tasks = await db.many(
            'SELECT * FROM bench_run_tasks WHERE run_id = ANY($1::text[]) ORDER BY created_at, id',
            [rows.map((row) => String(row.id))]);
        const groups = new Map();
        const runIds = new Set();
        const metaOf = (benchmarkId, version, taskId) => {
            const definition = definitions.get(`${benchmarkId}:${num(version)}`);
            return ((definition && definition.tasks) || []).find((t) => String(t.id) === String(taskId)) || {};
        };
        for (const row of tasks) {
            if (row.score == null) continue;
            const run = rows.find((r) => String(r.id) === String(row.run_id));
            if (!run) continue;
            const key = `${run.benchmark_id}:${num(run.benchmark_version)}:${String(row.task_id)}`;
            const meta = metaByKey.get(key) || metaOf(run.benchmark_id, run.benchmark_version, row.task_id);
            const timed = taskMinutes(meta, key, estimates);
            if (!timed) continue;
            if (!groups.has(key)) groups.set(key, { minutes: timed.minutes, source: timed.source, scores: [] });
            groups.get(key).scores.push(num(row.score));
            runIds.add(String(row.run_id));
        }
        const taskGroups = [...groups.values()].map((g) => ({
            minutes: g.minutes,
            success: g.scores.reduce((n, v) => n + v, 0) / g.scores.length / 100,
            runs: g.scores.length,
            source: g.source,
        }));
        return estimateHorizon(taskGroups, { runs: runIds.size, timedTasks: taskGroups.length });
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
        taskEstimateSummary, addTaskEstimate, modelHorizon,
    };
}

module.exports = {
    createRegistry, RegistryError, hashDefinition, canonical, median, parseRef, parseSince,
    canViewBenchmark, shareTokenHash, shareTokenMatches, newShareToken,
};

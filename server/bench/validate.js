'use strict';

/**
 * What a benchmark and a run must look like before Bench stores them.
 *
 * The shapes are the released contracts (bench.benchmark@1 and bench.run@1, openvibe-contracts v0.244.0). Bench keeps
 * its own copy of the rules so the service can refuse a bad document before it reaches the database, and so a
 * caller gets a field-level error instead of a stack trace.
 *
 * The rules mirror the contract's: the same required fields, the same enums, the same ranges.
 */

const { assertValid } = require('openvibe-contracts');

const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const num = (v, d = 0) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

/** The contract's id patterns. */
const BENCHMARK_ID = /^bmk_[0-9A-HJKMNP-TV-Z]{26}$/;
const RUN_ID = /^brn_[0-9A-HJKMNP-TV-Z]{26}$/;
const BENCHMARK_REF = /^bmk_[0-9A-HJKMNP-TV-Z]{26}@[0-9]+$/;

const VISIBILITIES = ['public', 'unlisted'];
const SCORING_METHODS = ['mean', 'weighted', 'pass_rate', 'sum'];
const EXECUTOR_KINDS = ['codes', 'run', 'node', 'submitted'];
const PROVENANCES = ['verified', 'submitted'];

class Errors {
    constructor() { this.list = []; }
    add(path, message) { this.list.push({ path, message }); return this; }
    get valid() { return this.list.length === 0; }
    get detail() { return this.list.map((e) => `${e.path} ${e.message}`).join('; '); }
}

function validateBenchmark(doc) {
    const e = new Errors();
    if (!isObj(doc)) return { valid: false, errors: [{ path: '/', message: 'must be an object' }] };
    if (!isStr(doc.id) || !BENCHMARK_ID.test(doc.id)) e.add('/id', 'must be a benchmark id (bmk_…)');
    if (!isStr(doc.owner) || !doc.owner.trim()) e.add('/owner', 'is required');
    if (!isStr(doc.title) || !doc.title.trim() || doc.title.length > 160) e.add('/title', 'must be 1-160 characters');
    if (!isStr(doc.kind) || !doc.kind.trim()) e.add('/kind', 'is required');
    if (!Array.isArray(doc.tags) || doc.tags.length > 32) e.add('/tags', 'must be an array of at most 32 tags');
    if (!VISIBILITIES.includes(doc.visibility)) e.add('/visibility', 'is public or unlisted');
    if (!isNum(doc.version) || doc.version < 1) e.add('/version', 'must be a positive integer');
    if (doc.parent != null && !isStr(doc.parent)) e.add('/parent', 'must be a string or null');
    if (!Array.isArray(doc.tasks)) e.add('/tasks', 'must be an array');
    else {
        doc.tasks.forEach((t, i) => {
            if (!isObj(t)) { e.add(`/tasks/${i}`, 'must be an object'); return; }
            if (!isStr(t.id) || !t.id.trim()) e.add(`/tasks/${i}/id`, 'is required');
            if (!isStr(t.prompt) || !t.prompt.trim()) e.add(`/tasks/${i}/prompt`, 'is required');
            if (typeof t.holdout !== 'boolean') e.add(`/tasks/${i}/holdout`, 'must be true or false');
        });
    }
    if (!Array.isArray(doc.judges)) e.add('/judges', 'must be an array');
    else {
        doc.judges.forEach((j, i) => {
            if (!isObj(j)) { e.add(`/judges/${i}`, 'must be an object'); return; }
            if (!isStr(j.type) || !j.type.trim()) e.add(`/judges/${i}/type`, 'is required');
            if (!isStr(j.version) || !j.version.trim()) e.add(`/judges/${i}/version`, 'is required');
            if (!isObj(j.config)) e.add(`/judges/${i}/config`, 'must be an object');
        });
    }
    if (!isObj(doc.scoring)) e.add('/scoring', 'must be an object');
    else {
        if (!SCORING_METHODS.includes(doc.scoring.method)) e.add('/scoring/method', `must be one of ${SCORING_METHODS.join(', ')}`);
        if (!isObj(doc.scoring.scale)) e.add('/scoring/scale', 'must be an object');
    }
    if (!isObj(doc.limits)) e.add('/limits', 'must be an object');
    if (!isObj(doc.matrix)) e.add('/matrix', 'must be an object');
    return { valid: e.valid, errors: e.list };
}

function validateRun(doc) {
    const e = new Errors();
    if (!isObj(doc)) return { valid: false, errors: [{ path: '/', message: 'must be an object' }] };
    if (!isStr(doc.id) || !RUN_ID.test(doc.id)) e.add('/id', 'must be a run id (brn_…)');
    if (!isStr(doc.benchmark) || !BENCHMARK_REF.test(doc.benchmark)) e.add('/benchmark', 'must be a benchmark id@version');
    if (!isStr(doc.model) || !doc.model.trim()) e.add('/model', 'is required');
    if (!isStr(doc.provider) || !doc.provider.trim()) e.add('/provider', 'is required');
    if (!isObj(doc.route)) e.add('/route', 'must be an object');
    if (!isObj(doc.harness) || !isStr(doc.harness.name) || !isStr(doc.harness.version)) e.add('/harness', 'needs a name and a version');
    if (!isObj(doc.settings)) e.add('/settings', 'must be an object');
    if (!isObj(doc.executor)) e.add('/executor', 'must be an object');
    else if (!EXECUTOR_KINDS.includes(doc.executor.kind)) e.add('/executor/kind', `must be one of ${EXECUTOR_KINDS.join(', ')}`);
    if (!Array.isArray(doc.tasks)) e.add('/tasks', 'must be an array');
    else {
        doc.tasks.forEach((t, i) => {
            if (!isObj(t)) { e.add(`/tasks/${i}`, 'must be an object'); return; }
            if (!isStr(t.task_id) || !t.task_id.trim()) e.add(`/tasks/${i}/task_id`, 'is required');
            if (!isNum(t.score) || t.score < 0 || t.score > 100) e.add(`/tasks/${i}/score`, 'must be 0-100');
            if (!isNum(t.cost_usd) || t.cost_usd < 0) e.add(`/tasks/${i}/cost_usd`, 'must be 0 or more');
            if (!isNum(t.ms) || t.ms < 0) e.add(`/tasks/${i}/ms`, 'must be 0 or more');
            if (!isNum(t.tokens) || t.tokens < 0) e.add(`/tasks/${i}/tokens`, 'must be 0 or more');
            if (!Array.isArray(t.artifacts)) e.add(`/tasks/${i}/artifacts`, 'must be an array');
        });
    }
    if (!isNum(doc.score) || doc.score < 0 || doc.score > 100) e.add('/score', 'must be 0-100');
    if (!isNum(doc.cost_usd) || doc.cost_usd < 0) e.add('/cost_usd', 'must be 0 or more');
    if (!isNum(doc.ms) || doc.ms < 0) e.add('/ms', 'must be 0 or more');
    if (!isNum(doc.tokens) || doc.tokens < 0) e.add('/tokens', 'must be 0 or more');
    if (!PROVENANCES.includes(doc.provenance)) e.add('/provenance', 'must be verified or submitted');
    return { valid: e.valid, errors: e.list };
}


/**
 * The bench.run@1 document for a run Bench is about to store: exactly the published shape, nothing else. The extra
 * fields Bench keeps for itself (the benchmark id and version, the session) stay in the database, not in the
 * contract, so what a caller reads back is what the contract says.
 */
function contractRun(doc, createdAt) {
    const harness = (doc.harness && typeof doc.harness === 'object') ? doc.harness : {};
    const settings = (doc.settings && typeof doc.settings === 'object') ? doc.settings : {};
    const executor = (doc.executor && typeof doc.executor === 'object') ? doc.executor : {};
    const tasks = (Array.isArray(doc.tasks) ? doc.tasks : []).map((t) => {
        const out = {
            task_id: String(t.task_id || ''),
            score: num(t.score),
            cost_usd: num(t.cost_usd),
            ms: Math.round(num(t.ms)),
            tokens: Math.round(num(t.tokens)),
            artifacts: (Array.isArray(t.artifacts) ? t.artifacts : [])
                .map((a) => ({ kind: String(a.kind || 'file'), url: String(a.url || '') }))
                .filter((a) => a.url),
        };
        if (t.transcript_url) out.transcript_url = String(t.transcript_url);
        return out;
    });
    const out = {
        id: String(doc.id || ''),
        benchmark: String(doc.benchmark || ''),
        model: String(doc.model || ''),
        route: (doc.route && typeof doc.route === 'object') ? doc.route : {},
        provider: String(doc.provider || ''),
        harness: { name: String(harness.name || ''), version: String(harness.version || '') },
        settings: {
            temperature: settings.temperature == null ? null : Number(settings.temperature),
            effort: settings.effort == null ? null : String(settings.effort),
        },
        executor: { kind: String(executor.kind || ''), id: String(executor.id || '') },
        tasks,
        score: num(doc.score),
        cost_usd: num(doc.cost_usd),
        ms: Math.round(num(doc.ms)),
        tokens: Math.round(num(doc.tokens)),
        provenance: String(doc.provenance || ''),
        created_at: createdAt || new Date().toISOString(),
    };
    if (doc.hardware != null) out.hardware = doc.hardware;
    return out;
}

/** The published contract has the last word: a document that does not match it is refused. */
function checkContract(name, doc) {
    try {
        assertValid(name, doc);
        return { valid: true, errors: [] };
    } catch (err) {
        return { valid: false, errors: [{ path: '/', message: (err && err.message) || `does not match ${name}` }] };
    }
}

module.exports = { validateBenchmark, validateRun, contractRun, checkContract, Errors, BENCHMARK_ID, RUN_ID, BENCHMARK_REF, VISIBILITIES, EXECUTOR_KINDS, PROVENANCES };

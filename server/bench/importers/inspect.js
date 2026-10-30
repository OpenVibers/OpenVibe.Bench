'use strict';

/**
 * Inspect AI (inspect_ai) results: the .eval log (a zip of the log directory) or its JSON log.
 *
 * The JSON log of inspect_ai 0.3.x is an EvalLog: eval (the task, the model, the samples), results (the scores of
 * the scorers), stats (the model usage, with the cost) and reductions (the per-sample scores). Nothing in it is
 * executed: it is read as JSON and nothing else.
 */
const { parseJson, asText, jsonPartsOfZip } = require('./limits');

const TOOL = 'inspect';

function isZip(buffer) {
    return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);
}

/** The log inside the file: a zip (an .eval) or the JSON log itself. */
function readLog(bytes) {
    if (isZip(bytes)) {
        const parts = jsonPartsOfZip(bytes);
        for (const part of parts) {
            const doc = parseJson(asText(part.data), { what: 'the log' });
            if (doc && typeof doc === 'object' && doc.eval) return doc;
        }
        const doc = parseJson(asText(parts[0].data), { what: 'the log' });
        return doc;
    }
    return parseJson(asText(bytes), { what: 'the log' });
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** The overall score: the first scorer's accuracy, or the first metric that is not an error bar. */
function overallScore(results) {
    const scores = results && Array.isArray(results.scores) ? results.scores : [];
    for (const score of scores) {
        const metrics = score && score.metrics ? score.metrics : {};
        if (metrics.accuracy && num(metrics.accuracy.value) != null) return num(metrics.accuracy.value);
    }
    for (const score of scores) {
        const metrics = score && score.metrics ? score.metrics : {};
        for (const [name, metric] of Object.entries(metrics)) {
            if (/stderr|error|nan/i.test(name)) continue;
            if (num(metric && metric.value) != null) return num(metric.value);
        }
    }
    return null;
}

/** The per-sample scores: the reductions of the log, or the samples themselves. */
function taskScores(doc) {
    const out = [];
    const reductions = doc && doc.reductions ? doc.reductions : null;
    const samples = reductions && Array.isArray(reductions.samples) ? reductions.samples : null;
    if (samples) {
        for (const row of samples) {
            if (!row || typeof row !== 'object') continue;
            const value = num(row.value);
            if (value == null) continue;
            out.push({ task_id: String(row.sample_id != null ? row.sample_id : row.id), score: value * 100 });
        }
        if (out.length) return out;
    }
    const list = doc && Array.isArray(doc.samples) ? doc.samples : [];
    for (const sample of list) {
        if (!sample || typeof sample !== 'object') continue;
        const scores = sample.scores && typeof sample.scores === 'object' ? sample.scores : {};
        let value = null;
        for (const entry of Object.values(scores)) {
            const inner = entry && typeof entry === 'object' ? entry : {};
            if (num(inner.value) != null) { value = num(inner.value); break; }
            if (num(inner.accuracy) != null) { value = num(inner.accuracy); break; }
        }
        if (value == null) continue;
        out.push({ task_id: String(sample.id != null ? sample.id : sample.sample_id), score: value * 100 });
    }
    return out;
}

/** The cost the log carries: the model usage of the run. */
function costOf(doc) {
    const stats = doc && doc.stats ? doc.stats : {};
    const usage = stats.model_usage && typeof stats.model_usage === 'object' ? stats.model_usage : {};
    let total = 0;
    let found = false;
    const add = (v) => {
        const n = num(v);
        if (n != null) { total += n; found = true; }
    };
    for (const entry of Object.values(usage)) {
        if (entry == null) continue;
        if (typeof entry === 'number') { add(entry); continue; }
        if (typeof entry === 'object') {
            add(entry.cost);
            add(entry.total_cost);
        }
    }
    if (!found) {
        add(stats.total_cost);
        add(stats.cost);
    }
    return found ? total : null;
}

function parse(bytes) {
    const doc = readLog(bytes);
    if (!looksLike(doc)) throw new Error('That file is not an Inspect AI log.');
    const evalSpec = doc && doc.eval ? doc.eval : {};
    const model = String(evalSpec.model || '').trim();
    const provider = model.includes('/')
        ? model.split('/')[0]
        : String(evalSpec.model_api || evalSpec.provider || 'inspect');
    const version = String(doc.version || evalSpec.eval_version || '').trim();
    const score = overallScore(doc.results);
    const tasks = taskScores(doc);
    const stats = doc.stats && typeof doc.stats === 'object' ? doc.stats : {};
    const date = stats.started_at || evalSpec.created || doc.created_at || null;
    return {
        tool: TOOL,
        toolVersion: version || 'unknown',
        harness: { name: 'inspect-ai', version: version || 'unknown' },
        date: date ? new Date(date).toISOString() : null,
        suite: evalSpec.task ? { name: String(evalSpec.task), version: evalSpec.task_version == null ? null : String(evalSpec.task_version) } : null,
        models: [{
            model: model || 'unknown',
            provider: provider || 'inspect',
            score: score == null ? null : score * 100,
            cost_usd: costOf(doc),
            tasks,
        }],
    };
}

function looksLike(doc) {
    return Boolean(doc && typeof doc === 'object' && doc.eval && typeof doc.eval === 'object' && (doc.eval.model || doc.eval.task));
}

module.exports = { TOOL, parse, looksLike, readLog, isZip };

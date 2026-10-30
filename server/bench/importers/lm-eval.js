'use strict';

/**
 * EleutherAI lm-evaluation-harness results: the results.json that lm_eval writes.
 *
 * The file is { results: { <task>: { "acc,none": 0.61, "acc_stderr,none": 0.006, ... } }, configs: { <task>: {...} },
 * versions: { <task>: 0 }, "n-shot": {...}, higher_is_better: {...} }. One config is one model, so one model here is
 * one run; every task of the file is a task of that run.
 */
const { parseJson, asText } = require('./limits');

const TOOL = 'lm-eval';
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

const METRIC_ORDER = ['acc,none', 'acc_norm,none', 'exact_match,none', 'normalized_accuracy,none', 'f1,none', 'acc', 'acc_norm', 'exact_match'];
const BACKENDS = {
    hf: 'huggingface', 'huggingface': 'huggingface', openai: 'openai', 'openai-chat-completions': 'openai',
    anthropic: 'anthropic', 'anthropic-chat': 'anthropic', google: 'google', 'gemini': 'google', mistral: 'mistral',
    local: 'local', 'local-completions': 'local', dummy: 'dummy',
};

/** The metric of a result that means "how good was it", skipping the error bars and the losses. */
function metricOf(entry, higherIsBetter) {
    if (!entry || typeof entry !== 'object') return null;
    for (const key of METRIC_ORDER) {
        if (num(entry[key]) != null) return { metric: key, value: num(entry[key]) };
    }
    for (const [key, value] of Object.entries(entry)) {
        if (/stderr|stderr|nan|perplexity|word_perplexity|byte_perplexity|bits_per_byte/i.test(key)) continue;
        const n = num(value);
        if (n == null) continue;
        if (higherIsBetter && higherIsBetter[key] === false) continue;
        return { metric: key, value: n };
    }
    return null;
}

/** The subtasks of a task, when the harness wrote them down (MMLU's 57 subjects). */
function subtasksOf(results, task, entry) {
    const out = [];
    if (entry && entry.acc_by_task && typeof entry.acc_by_task === 'object') {
        for (const [name, value] of Object.entries(entry.acc_by_task)) {
            const n = num(value);
            if (n != null) out.push({ task_id: task + '/' + name, score: n * 100 });
        }
        if (out.length) return out;
    }
    const grouped = results[task + '_subtasks'] || results[task + '_groups'];
    if (grouped && typeof grouped === 'object') {
        for (const [name, sub] of Object.entries(grouped)) {
            const m = metricOf(sub, null);
            if (m) out.push({ task_id: task + '/' + name, score: m.value * 100 });
        }
        if (out.length) return out;
    }
    return out;
}

function modelOf(config) {
    const args = (config && config.model_args) || {};
    const name = args.model_name || args.pretrained || args.model || args.name || (config && config.model) || '';
    const backend = (config && config.model) || '';
    return { name: String(name || '').trim(), backend: String(backend || '').trim() };
}

function providerOf(name, backend) {
    const key = String(backend || '').toLowerCase();
    if (BACKENDS[key]) return BACKENDS[key];
    if (name.includes('/')) return name.split('/')[0];
    return key || 'lm-eval';
}

function parse(bytes) {
    const doc = parseJson(asText(bytes), { what: 'the results' });
    const results = doc && doc.results && typeof doc.results === 'object' && !Array.isArray(doc.results) ? doc.results : null;
    if (!results) throw new Error('That file has no results.');
    // The harness's own markers: its results file always carries the configs and the versions of the tasks.
    if (!doc.configs && !doc.versions && !doc['n-shot'] && !doc.higher_is_better) {
        throw new Error('That file is not an lm-evaluation-harness results file.');
    }
    const configs = doc.configs && typeof doc.configs === 'object' ? doc.configs : {};
    const versions = doc.versions && typeof doc.versions === 'object' ? doc.versions : {};
    const higher = doc.higher_is_better && typeof doc.higher_is_better === 'object' ? doc.higher_is_better : {};

    const tasks = [];
    let suiteName = null;
    let suiteVersion = null;
    for (const [task, entry] of Object.entries(results)) {
        if (task.endsWith('_subtasks') || task.endsWith('_groups')) continue;
        const subtasks = subtasksOf(results, task, entry);
        if (subtasks.length) {
            for (const t of subtasks) tasks.push(t);
        } else {
            const m = metricOf(entry, higher);
            if (m) tasks.push({ task_id: task, score: m.value * 100 });
        }
        if (!suiteName) { suiteName = task; suiteVersion = versions[task] == null ? null : String(versions[task]); }
    }
    if (Object.keys(results).filter((t) => !t.endsWith('_subtasks') && !t.endsWith('_groups')).length > 1) {
        suiteName = null;   // a file with many tasks is a mixed file: it becomes its own private benchmark
    }
    if (!tasks.length) throw new Error('That file holds no scores I can read.');

    const config = configs[suiteName] || configs[Object.keys(configs)[0]] || doc.config || {};
    const { name, backend } = modelOf(config);
    const provider = providerOf(name, backend);
    const model = name || backend || 'unknown';
    const overall = tasks.reduce((n, t) => n + t.score, 0) / tasks.length;
    const version = String(doc.harness_version || doc.lm_eval_version || doc.version || '').trim();
    return {
        tool: TOOL,
        toolVersion: version || 'unknown',
        harness: { name: 'lm-evaluation-harness', version: version || 'unknown' },
        date: doc.created_at || doc.date || null,
        suite: suiteName ? { name: suiteName, version: suiteVersion } : null,
        models: [{
            model,
            provider,
            score: overall,
            cost_usd: num(doc.cost_usd),
            tasks,
        }],
    };
}

function looksLike(doc) {
    if (!doc || typeof doc !== 'object') return false;
    if (!doc.results || typeof doc.results !== 'object' || Array.isArray(doc.results)) return false;
    if (doc.configs || doc.versions || doc['n-shot'] || doc.higher_is_better) return true;
    const keys = Object.keys(doc.results);
    return keys.length > 0 && keys.every((k) => doc.results[k] && typeof doc.results[k] === 'object');
}

module.exports = { TOOL, parse, looksLike };

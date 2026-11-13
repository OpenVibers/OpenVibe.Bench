'use strict';

/**
 * Hugging Face lighteval results: the `results_<model>.json` that `lighteval` writes.
 *
 * The file is { config_general, results, versions, config_tasks }. `results` maps a task key
 * ("arc:challenge|25" — the task, then the few-shot count) to its metrics. `config_tasks` names the task, its HF
 * dataset and its metric (and whether a higher score is better). One file is one model, so one model here is one run;
 * every task key is a task of that run, with its own few-shot and task version.
 */
const { parseJson, asText } = require('./limits');

const TOOL = 'lighteval';
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

const METRIC_ORDER = ['acc', 'exact_match', 'acc_norm', 'f1', 'pass@1', 'quasi_exact_match', 'accuracy', 'em'];

/** The metric of a task that means "how good was it", skipping its error bar. */
function metricOf(entry) {
    if (!entry || typeof entry !== 'object') return null;
    for (const key of METRIC_ORDER) {
        if (num(entry[key]) != null) return { metric: key, value: num(entry[key]) };
    }
    for (const [key, value] of Object.entries(entry)) {
        if (/_stderr$|stderr|std_err/i.test(key)) continue;
        const n = num(value);
        if (n != null) return { metric: key, value: n };
    }
    return null;
}

/** "arc:challenge|25" -> { task: "arc:challenge", fewShot: 25 }. */
function keyOf(key) {
    const text = String(key || '');
    const parts = text.split('|');
    return { task: parts[0].trim(), fewShot: num(parts[1]) };
}

function parse(bytes) {
    const doc = parseJson(asText(bytes), { what: 'the results' });
    const results = doc && doc.results && typeof doc.results === 'object' && !Array.isArray(doc.results) ? doc.results : null;
    if (!results) throw new Error('That file has no results.');
    const general = (doc.config_general && typeof doc.config_general === 'object') ? doc.config_general : {};
    const taskConfigs = (doc.config_tasks && typeof doc.config_tasks === 'object') ? doc.config_tasks : {};
    const versions = (doc.versions && typeof doc.versions === 'object') ? doc.versions : {};
    const model = String(general.model_name || (general.model_config && general.model_config.model_name) || doc.model_name || '').trim();
    if (!model) throw new Error('That file names no model.');

    const tasks = [];
    for (const [key, entry] of Object.entries(results)) {
        const metric = metricOf(entry);
        if (!metric) continue;
        const { task, fewShot } = keyOf(key);
        const config = taskConfigs[key] || taskConfigs[task] || {};
        const taskVersion = versions[key] != null ? versions[key] : (versions[task] != null ? versions[task] : null);
        tasks.push({
            task_id: task || key,
            score: metric.value * 100,
            metric: metric.metric,
            few_shot: fewShot,
            task_version: taskVersion == null ? null : String(taskVersion),
            hf_repo: config.hf_repo ? String(config.hf_repo) : null,
            higher_is_better: config.metrics && Array.isArray(config.metrics) && config.metrics[0]
                ? Boolean(config.metrics[0].higher_is_better)
                : null,
        });
    }
    if (!tasks.length) throw new Error('That file holds no scores I can read.');

    const provider = model.includes('/') ? model.split('/')[0] : 'lighteval';
    const version = String(general.lighteval_sha || general.lighteval_version || doc.version || '').trim();
    const seed = general.model_config && general.model_config.generation_parameters
        ? general.model_config.generation_parameters.seed
        : null;
    const overall = tasks.reduce((n, t) => n + t.score, 0) / tasks.length;
    const distinct = [...new Set(tasks.map((t) => t.task_id))];
    return {
        tool: TOOL,
        toolVersion: version || 'unknown',
        harness: { name: 'lighteval', version: version || 'unknown' },
        date: general.pretty_timestamp || general.date || null,
        suite: distinct.length === 1 ? { name: distinct[0], version: tasks[0].task_version } : null,
        models: [{
            model,
            provider,
            score: overall,
            score_n: tasks.length,
            cost_usd: null,
            seed: seed == null ? null : String(seed),
            few_shot: tasks.length && tasks[0].few_shot != null ? tasks[0].few_shot : null,
            tasks,
        }],
    };
}

function looksLike(doc) {
    if (!doc || typeof doc !== 'object') return false;
    if (!doc.results || typeof doc.results !== 'object' || Array.isArray(doc.results)) return false;
    return Boolean(doc.config_general || doc.config_tasks);
}

module.exports = { TOOL, parse, looksLike, metricOf };

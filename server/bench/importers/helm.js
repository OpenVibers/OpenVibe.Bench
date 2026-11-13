'use strict';

/**
 * Stanford HELM results: a run's `stats.json` together with its `run_spec.json`.
 *
 * HELM writes one run directory per (scenario, method, model). `stats.json` is a list of stat objects — each has a
 * `name` ({ name, split, perturbation? }) and a `mean` — and `run_spec.json` says which model, scenario and method
 * produced them. This importer accepts the two together, either as { stats, run_spec } or as one document whose
 * top level is the run spec and whose `stats` key holds the list. One model here is one run; the run's scenario is
 * the task, the adapter's `max_train_instances` the few-shot.
 */
const { parseJson, asText } = require('./limits');

const TOOL = 'helm';
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

const METRIC_ORDER = ['quasi_exact_match', 'exact_match', 'accuracy', 'quasi_prefix_exact_match', 'prefix_exact_match', 'f1', 'bleu', 'score'];

function statsOf(doc) {
    if (Array.isArray(doc)) return { stats: doc, runSpec: {} };
    if (!doc || typeof doc !== 'object') return { stats: null, runSpec: {} };
    const runSpec = doc.run_spec && typeof doc.run_spec === 'object' ? doc.run_spec : doc;
    const stats = Array.isArray(doc.stats) ? doc.stats : (Array.isArray(doc) ? doc : null);
    return { stats, runSpec };
}

/** The headline metric: the first in the preference list, from a plain split before a perturbed one. */
function metricOf(stats) {
    const usable = (stats || []).filter((s) => s && s.name && typeof s.name === 'object' && num(s.mean) != null);
    if (!usable.length) return null;
    const plain = usable.filter((s) => !s.name.perturbation);
    const splits = (list) => {
        const wanted = list.filter((s) => s.name.split === 'valid' || s.name.split === 'test' || s.name.split == null);
        return wanted.length ? wanted : list;
    };
    const pool = splits(plain.length ? plain : usable);
    for (const name of METRIC_ORDER) {
        const found = pool.find((s) => String(s.name.name) === name);
        if (found) return { metric: name, value: num(found.mean) };
    }
    const first = pool[0];
    return { metric: String(first.name.name || 'score'), value: num(first.mean) };
}

function parse(bytes) {
    const doc = parseJson(asText(bytes), { what: 'the results' });
    const { stats, runSpec } = statsOf(doc);
    if (!Array.isArray(stats) || !stats.length) throw new Error('That file holds no HELM stats.');
    const adapter = (runSpec.adapter_spec && typeof runSpec.adapter_spec === 'object') ? runSpec.adapter_spec : {};
    const model = String(adapter.model || runSpec.model || '').trim();
    if (!model) throw new Error('That file has no run spec naming the model.');
    const metric = metricOf(stats);
    if (!metric) throw new Error('That file holds no scores I can read.');
    const scenario = runSpec.scenario_spec && typeof runSpec.scenario_spec === 'object' ? runSpec.scenario_spec : {};
    const args = (scenario.args && typeof scenario.args === 'object') ? scenario.args : {};
    const groups = Array.isArray(runSpec.groups) ? runSpec.groups : [];
    const task = String(args.dataset || groups[0] || String(runSpec.name || '').split(':')[0] || 'helm').trim();
    const deployment = String(adapter.model_deployment || '');
    const provider = deployment.includes('/') ? deployment.split('/')[0] : (model.includes('/') ? model.split('/')[0] : 'helm');
    const version = String(runSpec.helm_version || doc.helm_version || runSpec.version || '').trim();
    const score = metric.value <= 1 ? metric.value * 100 : metric.value;
    const taskVersion = String(runSpec.version || doc.version || '').trim();
    const seed = adapter.seed != null ? adapter.seed : adapter.random_seed;
    return {
        tool: TOOL,
        toolVersion: version || 'unknown',
        harness: { name: 'helm', version: version || 'unknown' },
        date: runSpec.date || doc.date || null,
        suite: { name: task, version: taskVersion || null },
        models: [{
            model,
            provider: provider || 'helm',
            score,
            score_n: 1,
            cost_usd: null,
            seed: seed == null ? null : String(seed),
            few_shot: num(adapter.max_train_instances),
            tasks: [{
                task_id: task,
                score,
                metric: metric.metric,
                few_shot: num(adapter.max_train_instances),
                task_version: taskVersion || null,
                higher_is_better: !/loss|perplexity|latency|runtime/i.test(metric.metric),
            }],
        }],
    };
}

function looksLike(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
    if (!Array.isArray(doc.stats) || !doc.stats.length) return false;
    const first = doc.stats[0];
    return Boolean(first && first.name && typeof first.name === 'object' && ('mean' in first || 'count' in first));
}

module.exports = { TOOL, parse, looksLike, metricOf };

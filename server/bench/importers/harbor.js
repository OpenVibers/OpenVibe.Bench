'use strict';

/**
 * Harbor (harbor-framework/harbor) results: the results.json of a job.
 *
 * A Harbor job result (src/harbor/models/job/result.py) is { id, started_at, finished_at, n_total_trials, stats,
 * trial_results }. Every trial carries the agent that ran it (agent_info.model_info.name is the model) and the
 * verifier's reward (verifier_result.reward), so one model here is one agent over a set of tasks.
 */
const { parseJson, asText } = require('./limits');

const TOOL = 'harbor';
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function trialsOf(doc) {
    if (Array.isArray(doc)) return doc;
    if (doc && Array.isArray(doc.trial_results)) return doc.trial_results;
    if (doc && Array.isArray(doc.trials)) return doc.trials;
    return [];
}

function agentOf(trial) {
    const agent = (trial && trial.agent_info) || (trial && trial.agent) || {};
    const model = (agent.model_info && agent.model_info.name) || agent.model || trial.model || '';
    const provider = (agent.model_info && agent.model_info.provider) || agent.provider || 'harbor';
    return { model: String(model || '').trim(), provider: String(provider || 'harbor').trim(), agent: agent };
}

function rewardOf(trial) {
    const verifier = trial && (trial.verifier_result || trial.verifier || trial.rewards || {});
    const value = num(verifier && (verifier.reward != null ? verifier.reward : verifier.score != null ? verifier.score : verifier.value));
    return value == null ? null : value;
}

function parse(bytes) {
    const doc = parseJson(asText(bytes), { what: 'the results' });
    const trials = trialsOf(doc);
    if (!trials.length) throw new Error('That file holds no trials.');
    const stats = (doc && doc.stats) || {};
    const byModel = new Map();
    for (const trial of trials) {
        const { model, provider, agent } = agentOf(trial);
        const key = model + '|' + provider;
        if (!byModel.has(key)) {
            byModel.set(key, {
                model: model || 'unknown',
                provider: provider || 'harbor',
                score: null,
                cost_usd: 0,
                hasCost: false,
                tasks: [],
                agentName: String(agent.name || ''),
                agentVersion: String(agent.version || ''),
            });
        }
        const row = byModel.get(key);
        const reward = rewardOf(trial);
        const taskId = String((trial && (trial.task_id || trial.task_name || trial.name)) || ('trial-' + row.tasks.length));
        row.tasks.push({ task_id: taskId, score: reward == null ? null : reward * 100 });
        const cost = num(trial && (trial.cost_usd != null ? trial.cost_usd : trial.cost));
        if (cost != null) { row.cost_usd += cost; row.hasCost = true; }
        if (reward != null) row.score = row.score == null ? reward * 100 : (row.score + reward * 100) / 2;
    }
    const models = [...byModel.values()].map((row) => ({
        model: row.model,
        provider: row.provider,
        score: row.score,
        cost_usd: row.hasCost ? row.cost_usd : null,
        tasks: row.tasks,
    }));
    const totalCost = num(stats.cost_usd != null ? stats.cost_usd : stats.total_cost);
    if (totalCost != null && models.length === 1) models[0].cost_usd = totalCost;
    const date = doc.started_at || (doc.stats && doc.stats.started_at) || doc.created_at || null;
    const version = String((doc && (doc.harbor_version || doc.version)) || (stats.harness_version) || '').trim();
    const agentVersion = models.length && models[0] ? '' : '';
    return {
        tool: TOOL,
        toolVersion: version || 'unknown',
        harness: { name: 'harbor', version: version || 'unknown' },
        date: date ? new Date(date).toISOString() : null,
        suite: null,
        models,
    };
}

function looksLike(doc) {
    if (!doc || typeof doc !== 'object') return false;
    if (Array.isArray(doc.trial_results)) return true;
    if (doc.n_total_trials != null && doc.stats) return true;
    return false;
}

module.exports = { TOOL, parse, looksLike };

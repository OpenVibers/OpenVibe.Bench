'use strict';

/**
 * promptfoo results: the JSON that "promptfoo eval -o output.json" writes.
 *
 * The file is { version, timestamp, results, stats }. The results are either the rows of the run (one row per test
 * case, each with the provider that answered and the score it got) or the newer shape, where results.outputs holds
 * one entry per provider with its metrics. Both are read; each row becomes a task.
 */
const { parseJson, asText } = require('./limits');

const TOOL = 'promptfoo';
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function providerIdOf(row) {
    const p = row && (row.provider != null ? row.provider : row.providerId != null ? row.providerId : row.target);
    if (p == null) return 'promptfoo';
    if (typeof p === 'string') return p;
    if (typeof p === 'object') return String(p.id || p.label || p.name || 'promptfoo');
    return 'promptfoo';
}

/** "openai:gpt-4o" -> provider "openai", model "openai:gpt-4o". */
function splitProvider(id) {
    const at = id.indexOf(':');
    if (at <= 0) return { provider: 'promptfoo', model: id };
    return { provider: id.slice(0, at), model: id };
}

function scoreOf(row) {
    const grading = row && row.gradingResult;
    if (grading && num(grading.score) != null) return num(grading.score);
    if (num(row && row.score) != null) return num(row.score);
    if (row && typeof row.success === 'boolean') return row.success ? 1 : 0;
    return null;
}

function costOf(row) {
    const response = (row && row.response) || {};
    const c = num(response.cost != null ? response.cost : row && row.cost);
    return c;
}

function tokensOf(row) {
    const response = (row && row.response) || {};
    const usage = response.tokenUsage || response.tokens || null;
    if (!usage || typeof usage !== 'object') return null;
    return num(usage.total != null ? usage.total : usage.total_tokens);
}

function rowId(row, index) {
    if (row && row.id != null) return String(row.id);
    if (row && row.testIdx != null) return 'test-' + row.testIdx;
    if (row && row.testCase && row.testCase.vars) return 'vars-' + index;
    return 'case-' + index;
}

function parse(bytes) {
    const doc = parseJson(asText(bytes), { what: 'the results' });
    const results = doc && doc.results != null ? doc.results : null;
    if (!results) throw new Error('That file has no results.');

    const rows = [];
    if (Array.isArray(results)) {
        rows.push(...results);
    } else if (Array.isArray(results.outputs)) {
        // The newer shape: one entry per provider, with the test results inside it.
        results.outputs.forEach((output, index) => {
            const cases = Array.isArray(output.tests) ? output.tests : Array.isArray(output.testCases) ? output.testCases : [];
            if (cases.length) {
                for (const c of cases) rows.push({ ...c, provider: output.provider, id: (c && c.id) || 'case-' + index });
            } else {
                const named = output.metrics && output.metrics.namedScores ? output.metrics.namedScores : {};
                const score = num(output.score) != null ? num(output.score)
                    : (Object.values(named).map(num).find((v) => v != null) != null ? Object.values(named).map(num).find((v) => v != null) : null);
                rows.push({
                    id: output.id != null ? String(output.id) : 'output-' + index,
                    provider: output.provider,
                    score: score == null ? null : score,
                    gradingResult: null,
                });
            }
        });
    } else {
        throw new Error('That file has no results I can read.');
    }
    if (!rows.length) throw new Error('That file holds no results I can read.');

    const byProvider = new Map();
    for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const id = providerIdOf(row);
        const { provider, model } = splitProvider(id);
        if (!byProvider.has(id)) {
            byProvider.set(id, { model, provider, score: null, cost_usd: 0, hasCost: false, tokens: 0, hasTokens: false, tasks: [] });
        }
        const entry = byProvider.get(id);
        const score = scoreOf(row);
        entry.tasks.push({ task_id: rowId(row, i), score: score == null ? null : score * 100 });
        const cost = costOf(row);
        if (cost != null) { entry.cost_usd += cost; entry.hasCost = true; }
        const tokens = tokensOf(row);
        if (tokens != null) { entry.tokens += tokens; entry.hasTokens = true; }
    }

    const models = [...byProvider.values()].map((entry) => {
        const scored = entry.tasks.filter((t) => t.score != null);
        return {
            model: entry.model,
            provider: entry.provider,
            score: scored.length ? scored.reduce((n, t) => n + t.score, 0) / scored.length : null,
            cost_usd: entry.hasCost ? entry.cost_usd : null,
            tokens: entry.hasTokens ? entry.tokens : null,
            tasks: entry.tasks,
        };
    });
    const version = String(doc.promptfoo_version || doc.tool_version || doc.promptfooVersion || '').trim();
    const date = doc.timestamp || doc.created_at || null;
    return {
        tool: TOOL,
        toolVersion: version || 'unknown',
        harness: { name: 'promptfoo', version: version || 'unknown' },
        date: date ? new Date(date).toISOString() : null,
        suite: null,
        models,
    };
}

function looksLike(doc) {
    if (!doc || typeof doc !== 'object') return false;
    if (Array.isArray(doc.results)) return true;
    if (doc.results && Array.isArray(doc.results.outputs)) return true;
    if (doc.results && typeof doc.results === 'object' && (doc.results.stats || doc.results.prompts)) return true;
    return false;
}

module.exports = { TOOL, parse, looksLike };

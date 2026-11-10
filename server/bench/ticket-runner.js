'use strict';

/**
 * The AL8 gate's runner: a whole ticket over 3 to 5 trials per model and effort, then one row per model and effort.
 *
 * Two rules are code here, not advice:
 *
 *   1. It never runs by itself. Without `run: true` (the CLI's `--run`) it returns the plan and makes no call, so
 *      no timer, scheduler or page start can spend money.
 *   2. It runs only on the cheap lanes unless the caller widens them on purpose: `deepseek-flash` and the local
 *      model (`local`). Anything else is refused before the first trial.
 *
 * The executor is injected. It receives one ticket trial and answers with what the check said:
 *
 *   execute({ ticket, model, effort, trial, session }) → { passed, cost_usd, ms, tokens, check_output }
 *
 * `scripts/ticket-executor.js` is the local implementation (an OpenVibe.Codes agent in a fresh checkout); a Codes
 * benchmark runner can implement the same shape. Because the check patch is applied by the executor after the
 * agent stops, the agent never grades its own copy of the test.
 */
const tickets = require('./tickets');

const PROVIDERS = Object.freeze({ 'deepseek-flash': 'deepseek', local: 'local' });

/** The plan a run would follow: which models, how many trials, which tickets. No money moves. */
function plan(suite, { models, trials, effort = 'high' } = {}) {
    const list = Array.isArray(models) && models.length ? models.map((m) => String(m)) : (suite.models || tickets.DEFAULT_MODELS).map((m) => String(m));
    const k = trials == null ? suite.trials : Number(trials);
    return {
        suite: suite.suite,
        models: list,
        trials: k,
        effort: effort == null ? 'high' : String(effort),
        tickets: (suite.tickets || []).map((t) => ({ id: t.id, check: t.check && t.check.value })),
        calls: list.length * (suite.tickets || []).length * k,
    };
}

/**
 * Run the suite, or say what it would do. `execute` is required only when `run` is true. Returns the trial runs
 * (ready for POST /api/v1/runs) and the gate table (the same rows the results API computes).
 */
async function runSuite({ suite, execute = null, run = false, models = null, trials = null, effort = 'high', session = null, now = () => new Date() } = {}) {
    const checked = tickets.validateSuite(suite);
    if (!checked.valid) return { ok: false, code: 'bench.ticket_suite_invalid', detail: checked.detail };
    const thePlan = plan(suite, { models, trials, effort });
    if (thePlan.models.some((m) => !tickets.DEFAULT_MODELS.includes(m))) {
        return { ok: false, code: 'bench.ticket_model_not_allowed', detail: `the gate runs only on ${tickets.DEFAULT_MODELS.join(' and ')} unless a person widens it` };
    }
    if (!Number.isInteger(thePlan.trials) || thePlan.trials < tickets.TRIAL_MIN || thePlan.trials > tickets.TRIAL_MAX) {
        return { ok: false, code: 'bench.ticket_trials', detail: `trials must be ${tickets.TRIAL_MIN}-${tickets.TRIAL_MAX}` };
    }
    if (!run) return { ok: true, ran: false, plan: thePlan };
    if (typeof execute !== 'function') return { ok: false, code: 'bench.ticket_executor_missing', detail: 'a run needs an executor' };

    const sessionId = session || `ticket-${thePlan.suite}-${now().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
    const runs = [];
    const tasksByRun = new Map();
    for (const model of thePlan.models) {
        for (let trial = 1; trial <= thePlan.trials; trial++) {
            const results = [];
            for (const ticket of suite.tickets) {
                let out;
                try {
                    out = await execute({ ticket, model, effort: thePlan.effort, trial, session: sessionId });
                } catch (err) {
                    out = { passed: false, error: (err && err.message) || String(err), cost_usd: 0, ms: 0, tokens: 0, check_output: '' };
                }
                out = out && typeof out === 'object' ? out : { passed: false };
                results.push({
                    task_id: ticket.id,
                    score: out.passed === true ? 100 : 0,
                    cost_usd: Number.isFinite(Number(out.cost_usd)) ? Number(out.cost_usd) : 0,
                    ms: Number.isFinite(Number(out.ms)) ? Math.max(0, Math.round(Number(out.ms))) : 0,
                    tokens: Number.isFinite(Number(out.tokens)) ? Math.max(0, Math.round(Number(out.tokens))) : 0,
                    artifacts: [{ kind: 'check', passed: out.passed === true, output: String(out.check_output == null ? '' : out.check_output).slice(0, 2000) }],
                    ...(out.transcript_url ? { transcript_url: String(out.transcript_url).slice(0, 500) } : {}),
                });
            }
            const cost = results.reduce((n, r) => n + r.cost_usd, 0);
            const ms = results.reduce((n, r) => n + r.ms, 0);
            const tokens = results.reduce((n, r) => n + r.tokens, 0);
            const score = results.length ? results.reduce((n, r) => n + r.score, 0) / results.length : 0;
            const runDoc = {
                model,
                provider: PROVIDERS[model] || 'unknown',
                route: { requested: model, ran: model, effort: thePlan.effort },
                harness: { name: 'openvibe-codes', version: '0.4.0' },
                settings: { effort: thePlan.effort },
                executor: { kind: 'codes', id: 'bench-ticket-suite' },
                session: sessionId,
                tasks: results,
                score: Math.round(score * 1000) / 1000,
                cost_usd: Math.round(cost * 1e6) / 1e6,
                ms,
                tokens,
                created_at: now().toISOString(),
            };
            tasksByRun.set(`trial-${runs.length + 1}`, results.map((r) => ({ task_id: r.task_id, score: r.score, cost_usd: r.cost_usd, ms: r.ms, tokens: r.tokens })));
            runs.push(runDoc);
        }
    }
    // The table is computed from the same shape the database will store, so a published run reads back identically.
    const scored = require('./tickets').scoreRuns(runs.map((r, i) => ({ ...r, id: `trial-${i + 1}`, created_at: now().toISOString() })), tasksByRun, { effort: thePlan.effort });
    return { ok: true, ran: true, session: sessionId, plan: thePlan, runs, table: scored.entries };
}

module.exports = { PROVIDERS, plan, runSuite };

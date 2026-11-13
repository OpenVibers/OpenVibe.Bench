'use strict';

/**
 * Whole-ticket benchmarks (AL8, plan 2026-11-10): a ticket is a goal, its check and a budget, drawn from a real
 * merged pull request. The worker gets the goal; the check runs only after it stops, so a test added by the pull
 * request measures the work instead of the worker's copy of it.
 *
 * The goal and check are AL1's `agent.goal@1` shape (Contracts 0.389.0, still in review when this landed): the
 * goal is the condition in words, the check is a command, a URL assertion or a rubric, and the budget bounds the
 * tokens, turns and active minutes a trial may spend (the local executor in scripts/ticket-executor.js enforces
 * turns and active minutes; a token cap is carried for executors that can stop on usage). This module defines the
 * suite file Bench reads and the scoring every run is judged by; the runner that spends money lives in
 * server/bench/ticket-runner.js.
 *
 * A suite is `bench.codes-ticket-suite@1`:
 *
 *   {
 *     "format": "bench.codes-ticket-suite@1",
 *     "suite": "openvibe-merged-2026-11",
 *     "title": "Twelve merged OpenVibe tickets",
 *     "kind": "codes.ticket",
 *     "models": ["deepseek-flash", "local"],
 *     "trials": 3,
 *     "tickets": [{
 *       "id": "actor-390-prompt-prefix",
 *       "goal": "The coding agent's request prefix stays byte-identical …",
 *       "check": { "kind": "command", "value": "node test/runtime-prompt-prefix.test.js" },
 *       "budget": { "tokens": 80000, "turns": 40, "active_minutes": 8 },
 *       "no_progress_limit": 4,
 *       "fixture": {
 *         "repo": "https://github.com/OpenVibers/OpenVibe.Actor",
 *         "ref": "<the merge commit's parent>",
 *         "check_patch": "<unified diff of the pull request's test files>",
 *         "check_timeout_ms": 180000
 *       },
 *       "source": { "repository": "OpenVibers/OpenVibe.Actor", "pull_request": 390,
 *                   "merge_commit": "…", "merged_at": "2026-11-10T…" }
 *     }]
 *   }
 *
 * Only `deepseek-flash` and `local` are allowed by default: the gate is meant to run often and must not spend on
 * the dear models. A suite runs only when a caller says `--run`; nothing here is scheduled.
 */

const TRIAL_MIN = 3;
const TRIAL_MAX = 5;
const FORMAT = 'bench.codes-ticket-suite@1';
const KIND = 'codes.ticket';
const DEFAULT_MODELS = Object.freeze(['deepseek-flash', 'local']);
const CHECK_KINDS = Object.freeze(['command', 'url', 'rubric']);
const REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const num = (v, d = 0) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
/** A measurement a run did not record is null, never 0. */
const numOrNull = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
/** The sum of measurements, or null when any part is unmeasured. */
function sumMeasured(values) {
    const list = Array.isArray(values) ? values : [];
    if (!list.length) return null;
    let total = 0;
    for (const value of list) {
        const n = numOrNull(value);
        if (n == null) return null;
        total += n;
    }
    return total;
}

class Problems {
    constructor() { this.list = []; }
    add(path, message) { this.list.push({ path, message }); return this; }
    get valid() { return this.list.length === 0; }
    get detail() { return this.list.map((e) => `${e.path} ${e.message}`).join('; '); }
}

/** AL1's goal and check: the goal in words, a typed check, optional budgets and a no-progress limit. */
function validateGoal(goal, path = '') {
    const e = new Problems();
    if (!isObj(goal)) return e.add(path || '/', 'must be an object');
    if (!isStr(goal.goal) || !goal.goal.trim() || goal.goal.length > 4000) e.add(`${path}/goal`, 'must be 1-4000 characters');
    if (!isObj(goal.check)) e.add(`${path}/check`, 'must be an object');
    else {
        if (!CHECK_KINDS.includes(goal.check.kind)) e.add(`${path}/check/kind`, `must be one of ${CHECK_KINDS.join(', ')}`);
        if (!isStr(goal.check.value) || !goal.check.value.trim() || goal.check.value.length > 4000) e.add(`${path}/check/value`, 'must be 1-4000 characters');
    }
    if (goal.budget != null) {
        if (!isObj(goal.budget)) e.add(`${path}/budget`, 'must be an object');
        else {
            for (const key of ['tokens', 'turns', 'active_minutes']) {
                if (goal.budget[key] != null && (!Number.isInteger(goal.budget[key]) || goal.budget[key] < 1)) e.add(`${path}/budget/${key}`, 'must be a positive integer');
            }
            if (!Object.keys(goal.budget).some((k) => ['tokens', 'turns', 'active_minutes'].includes(k))) e.add(`${path}/budget`, 'needs tokens, turns or active_minutes');
        }
    }
    if (goal.no_progress_limit != null && (!Number.isInteger(goal.no_progress_limit) || goal.no_progress_limit < 1 || goal.no_progress_limit > 20)) {
        e.add(`${path}/no_progress_limit`, 'must be an integer 1-20');
    }
    return e;
}

/** One ticket in a suite: the AL1 goal and check, plus where the base checkout comes from and how it is graded. */
function validateTicket(ticket, path = '') {
    const e = new Problems();
    if (!isObj(ticket)) return e.add(path || '/', 'must be an object');
    if (!isStr(ticket.id) || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(ticket.id)) e.add(`${path}/id`, 'must be 2-80 lowercase letters, digits and dashes');
    const goal = validateGoal(ticket, path);
    for (const p of goal.list) e.add(p.path, p.message);
    if (!isObj(ticket.fixture)) e.add(`${path}/fixture`, 'must be an object');
    else {
        if (!isStr(ticket.fixture.repo) || !REPO.test(ticket.fixture.repo)) e.add(`${path}/fixture/repo`, 'must be an https GitHub repository URL');
        if (!isStr(ticket.fixture.ref) || !SHA.test(ticket.fixture.ref)) e.add(`${path}/fixture/ref`, 'must be a 40-character commit sha');
        if (!isStr(ticket.fixture.check_patch) || !ticket.fixture.check_patch.trim()) e.add(`${path}/fixture/check_patch`, 'must be the unified diff the check is applied from');
        if (ticket.fixture.check_timeout_ms != null && (!Number.isInteger(ticket.fixture.check_timeout_ms) || ticket.fixture.check_timeout_ms < 1000 || ticket.fixture.check_timeout_ms > 900000)) {
            e.add(`${path}/fixture/check_timeout_ms`, 'must be 1000-900000 milliseconds');
        }
        if (ticket.check && ticket.check.kind === 'command' && !ticket.fixture.check_patch.trim().startsWith('diff --git ') && !ticket.fixture.check_patch.trim().startsWith('--- ')) {
            e.add(`${path}/fixture/check_patch`, 'must be a unified diff (diff --git …)');
        }
    }
    if (!isObj(ticket.source)) e.add(`${path}/source`, 'must be an object');
    else {
        if (!isStr(ticket.source.repository) || !/^OpenVibers\/[A-Za-z0-9_.-]+$/.test(ticket.source.repository)) e.add(`${path}/source/repository`, 'must be an OpenVibers/Repo name');
        if (!Number.isInteger(ticket.source.pull_request) || ticket.source.pull_request < 1) e.add(`${path}/source/pull_request`, 'must be a positive pull request number');
        if (!isStr(ticket.source.merge_commit) || !SHA.test(ticket.source.merge_commit)) e.add(`${path}/source/merge_commit`, 'must be a 40-character commit sha');
    }
    return e;
}

/** The whole suite file, checked before a single model call is made. */
function validateSuite(doc) {
    const e = new Problems();
    if (!isObj(doc)) return e.add('/', 'must be an object');
    if (doc.format !== FORMAT) e.add('/format', `must be ${FORMAT}`);
    if (!isStr(doc.suite) || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(doc.suite)) e.add('/suite', 'must be 2-80 lowercase letters, digits and dashes');
    if (!isStr(doc.title) || !doc.title.trim() || doc.title.length > 160) e.add('/title', 'must be 1-160 characters');
    if (doc.kind != null && doc.kind !== KIND) e.add('/kind', `must be ${KIND}`);
    if (doc.models != null) {
        if (!Array.isArray(doc.models) || !doc.models.length) e.add('/models', 'must be a non-empty array');
        else doc.models.forEach((m, i) => {
            if (!isStr(m) || !m.trim()) e.add(`/models/${i}`, 'must be a model id');
            else if (!DEFAULT_MODELS.includes(m)) e.add(`/models/${i}`, `only ${DEFAULT_MODELS.join(' and ')} may run by default`);
        });
    }
    if (!Number.isInteger(doc.trials) || doc.trials < TRIAL_MIN || doc.trials > TRIAL_MAX) e.add('/trials', `must be an integer ${TRIAL_MIN}-${TRIAL_MAX}`);
    if (!Array.isArray(doc.tickets) || !doc.tickets.length) e.add('/tickets', 'must be a non-empty array');
    else {
        const ids = new Set();
        doc.tickets.forEach((ticket, i) => {
            const one = validateTicket(ticket, `/tickets/${i}`);
            for (const p of one.list) e.add(p.path, p.message);
            if (isObj(ticket) && isStr(ticket.id)) {
                if (ids.has(ticket.id)) e.add(`/tickets/${i}/id`, 'is used twice');
                ids.add(ticket.id);
            }
        });
    }
    return { valid: e.valid, errors: e.list };
}

/** The benchmark definition a suite freezes: one task per ticket, the check kept as the task's expected result. */
function benchmarkDefinition(suite, { owner = 'openvibe', visibility = 'unlisted' } = {}) {
    const tickets = Array.isArray(suite.tickets) ? suite.tickets : [];
    return {
        owner,
        title: String(suite.title || suite.suite || 'Ticket suite').slice(0, 160),
        description: String(suite.description || 'A whole ticket: a goal and its check, scored over repeated trials.').slice(0, 4000),
        kind: KIND,
        tags: ['tickets', 'gate', `suite:${suite.suite}`],
        visibility,
        tasks: tickets.map((t) => ({
            id: t.id,
            prompt: String(t.goal).slice(0, 8000),
            // The check patch is withheld from readers: only the executor (bench.run.publish) and the owner see it.
            holdout: true,
            files: [{
                kind: 'codes.ticket',
                repo: t.fixture.repo,
                ref: t.fixture.ref,
                goal: t.goal,
                check: t.check,
                budget: t.budget || {},
                no_progress_limit: t.no_progress_limit == null ? 5 : t.no_progress_limit,
            }],
            expected: {
                passed: true,
                check: t.check,
                check_patch: t.fixture.check_patch,
                check_timeout_ms: t.fixture.check_timeout_ms == null ? 180000 : t.fixture.check_timeout_ms,
                source: t.source,
            },
        })),
        judges: [{ type: 'test_suite', version: 'codes.ticket@1', config: { pass_score: 100, trials: suite.trials, check: 'the task check exits 0 after its test patch is applied' } }],
        scoring: { method: 'pass_rate', scale: { min: 0, max: 100 }, aggregate: 'mean' },
        limits: { ms: tickets.reduce((n, t) => n + num(t.fixture && t.fixture.check_timeout_ms, 180000), 0) },
        matrix: { models: Array.isArray(suite.models) && suite.models.length ? [...suite.models] : [...DEFAULT_MODELS], harnesses: ['openvibe-codes'] },
    };
}

/** One ticket's trials: how many ran, how many passed, and whether every one passed. */
function scoreTicket(trials) {
    const list = Array.isArray(trials) ? trials.filter((t) => t && t.score != null) : [];
    const n = list.length;
    const passes = list.filter((t) => num(t.score) > 0).length;
    const cost = sumMeasured(list.map((t) => t.cost_usd));
    const ms = sumMeasured(list.map((t) => t.ms));
    const tokens = sumMeasured(list.map((t) => t.tokens));
    return {
        trials: n,
        passes,
        pass_at_1: n ? passes / n : null,
        pass_at_k: n ? passes === n : false,
        cost_usd: cost == null ? null : Math.round(cost * 1e6) / 1e6,
        cost_n: list.filter((t) => numOrNull(t.cost_usd) != null).length,
        ms: ms == null ? null : Math.round(ms),
        ms_n: list.filter((t) => numOrNull(t.ms) != null).length,
        tokens: tokens == null ? null : Math.round(tokens),
        tokens_n: list.filter((t) => numOrNull(t.tokens) != null).length,
    };
}

/**
 * The gate's table: one row per model and effort, from runs whose tasks are ticket results (100 = the check
 * passed, 0 = it did not).
 *
 *   pass@1        the share of all (ticket, trial) pairs that passed
 *   pass^k        the share of tickets whose every one of k trials passed (the customer-facing number: a 75%
 *                 per-trial agent passes three in a row about 42% of the time)
 *   cost per solved  every trial's cost, divided by the tickets solved at least once, so a flaky ticket is
 *                 charged for its failures and can be told from a model that never solves it
 *
 * `k` is the smallest number of trials any ticket got; a ticket with fewer trials than k cannot pass^k. A group
 * with fewer than three trials says so (`insufficient_trials`) instead of pretending to be a gate result.
 */
function scoreRuns(runs, tasksByRun, { effort = null } = {}) {
    const groups = new Map();
    for (const run of runs) {
        if (!run) continue;
        const runEffort = run.settings && run.settings.effort != null ? String(run.settings.effort) : null;
        if (effort != null && String(effort) !== (runEffort == null ? 'default' : runEffort)) continue;
        const key = `${String(run.model)}\u0000${runEffort == null ? 'default' : runEffort}`;
        if (!groups.has(key)) groups.set(key, { model: String(run.model), effort: runEffort, trialsByTicket: new Map(), runs: 0, costs: [], times: [], tokenCounts: [], session: run.session || null });
        const group = groups.get(key);
        group.runs++;
        group.costs.push(numOrNull(run.cost_usd));
        group.times.push(numOrNull(run.ms));
        group.tokenCounts.push(numOrNull(run.tokens));
        if (!group.last_run || String(run.created_at || '') > group.last_run) group.last_run = String(run.created_at || '');
        for (const task of tasksByRun.get(run.id) || []) {
            if (task.score == null) continue;
            const id = String(task.task_id);
            if (!group.trialsByTicket.has(id)) group.trialsByTicket.set(id, []);
            group.trialsByTicket.get(id).push({
                score: num(task.score), cost_usd: numOrNull(task.cost_usd), ms: numOrNull(task.ms),
                tokens: numOrNull(task.tokens), run: run.id,
            });
        }
    }
    const entries = [];
    for (const group of groups.values()) {
        const perTicket = [...group.trialsByTicket.entries()].map(([id, trials]) => ({ task_id: id, ...scoreTicket(trials) }));
        const k = perTicket.reduce((n, t) => Math.min(n, t.trials), Infinity);
        const kk = Number.isFinite(k) ? k : 0;
        const totalPairs = perTicket.reduce((n, t) => n + t.trials, 0);
        const passedPairs = perTicket.reduce((n, t) => n + t.passes, 0);
        const fullyPassed = perTicket.filter((t) => t.trials >= kk && t.pass_at_k).length;
        const solved = perTicket.filter((t) => t.passes > 0).length;
        const cost = sumMeasured(group.costs);
        const ms = sumMeasured(group.times);
        const tokens = sumMeasured(group.tokenCounts);
        entries.push({
            model: group.model,
            effort: group.effort,
            runs: group.runs,
            trials: group.runs,
            task_trials: totalPairs,
            tickets: perTicket.length,
            k: kk,
            pass_at_1: totalPairs ? Math.round((passedPairs / totalPairs) * 1e6) / 1e6 : null,
            pass_at_k: perTicket.length ? Math.round((fullyPassed / perTicket.length) * 1e6) / 1e6 : null,
            solved,
            cost_usd: cost == null ? null : Math.round(cost * 1e6) / 1e6,
            cost_n: group.costs.filter((v) => v != null).length,
            cost_per_solved: solved && cost != null ? Math.round((cost / solved) * 1e6) / 1e6 : null,
            ms: ms == null ? null : Math.round(ms),
            ms_n: group.times.filter((v) => v != null).length,
            tokens: tokens == null ? null : Math.round(tokens),
            tokens_n: group.tokenCounts.filter((v) => v != null).length,
            insufficient_trials: kk < TRIAL_MIN,
            per_ticket: perTicket.map((t) => ({
                task_id: t.task_id,
                trials: t.trials,
                passes: t.passes,
                pass_at_1: t.pass_at_1 == null ? null : Math.round(t.pass_at_1 * 1e6) / 1e6,
                pass_at_k: t.pass_at_k,
                cost_usd: t.cost_usd,
                cost_n: t.cost_n,
            })).sort((a, b) => a.task_id.localeCompare(b.task_id)),
            last_run: group.last_run || null,
        });
    }
    entries.sort((a, b) => (b.pass_at_1 == null ? -1 : b.pass_at_1) - (a.pass_at_1 == null ? -1 : a.pass_at_1)
        || (a.cost_per_solved == null ? Infinity : a.cost_per_solved) - (b.cost_per_solved == null ? Infinity : b.cost_per_solved)
        || a.model.localeCompare(b.model)
        || String(a.effort || '').localeCompare(String(b.effort || '')));
    return { metric: 'tickets', entries };
}

module.exports = {
    FORMAT, KIND, TRIAL_MIN, TRIAL_MAX, DEFAULT_MODELS, CHECK_KINDS,
    validateGoal, validateTicket, validateSuite, benchmarkDefinition, scoreTicket, scoreRuns,
};

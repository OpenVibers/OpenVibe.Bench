'use strict';

/**
 * The AL8 gate (plan 2026-11-10): the codes.ticket kind, the suite file, the trial maths and the results API that
 * reads pass@1, pass^k and cost per solved by model and effort. The runner's money rule is tested here too: it
 * makes no call without `run: true` and refuses every model but deepseek-flash and the local one.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');
const tickets = require('../server/bench/tickets');
const runner = require('../server/bench/ticket-runner');
const cli = require('../scripts/ticket-suite');
const executor = require('../scripts/ticket-executor');
const { createRegistryApi } = require('../server/http/registry');
const { kindById } = require('../server/kinds');

/** One ticket in the committed shape, with a one-line check patch. */
function ticketDoc(id, prompt = 'The example test passes.') {
    return {
        id,
        goal: prompt,
        check: { kind: 'command', value: `node test/${id}.test.js` },
        budget: { tokens: 20000, turns: 10, active_minutes: 3 },
        no_progress_limit: 3,
        fixture: { repo: 'https://github.com/OpenVibers/OpenVibe.Bench', ref: '0'.repeat(40), check_patch: 'diff --git a/test/x b/test/x\n', check_timeout_ms: 60000 },
        source: { repository: 'OpenVibers/OpenVibe.Bench', pull_request: 1, merge_commit: '0'.repeat(40) },
    };
}

/** A two-ticket suite in the committed shape. */
function kitchen(over = {}) {
    return { format: tickets.FORMAT, suite: 'kitchen-suite', title: 'Kitchen suite', kind: 'codes.ticket', models: ['deepseek-flash'], trials: 3, tickets: [ticketDoc('alpha'), ticketDoc('beta')], ...over };
}

(async () => {
    const t = await boot();
    const writer = t.network.serviceToken({ sub: 'svc:codes', audience: 'openvibe.bench', cap: ['bench.benchmark.write', 'bench.run.publish'] });

    await check('the results API is the registry route and codes.ticket is a kind', async () => {
        assert.strictEqual(typeof createRegistryApi, 'function', 'the registry route is mounted');
        const kind = kindById('codes.ticket');
        assert.ok(kind, 'the kind is registered');
        assert.strictEqual(kind.judge, 'test_suite');
        assert.deepStrictEqual(kind.metrics, ['pass_at_1', 'pass_at_k', 'cost_per_solved']);
        assert.strictEqual(kind.schema.trials.min, 3);
        assert.strictEqual(kind.schema.trials.max, 5);
        assert.ok(kind.schema.goal.check, 'the AL1 goal and check shape');
    });

    await check('a suite is checked before it runs', async () => {
        assert.ok(tickets.validateSuite(kitchen()).valid, 'the kitchen suite is valid');
        assert.ok(!tickets.validateSuite(kitchen({ trials: 2 })).valid, 'two trials is not a gate');
        assert.ok(!tickets.validateSuite(kitchen({ trials: 6 })).valid, 'six trials is not a gate');
        assert.ok(!tickets.validateSuite(kitchen({ models: ['claude-opus-4'] })).valid, 'a dear model is not the default gate');
        const badCheck = kitchen();
        badCheck.tickets[0].check = { kind: 'vibes', value: 'it feels right' };
        assert.ok(!tickets.validateSuite(badCheck).valid, 'a check has a known kind');
        const twice = kitchen();
        twice.tickets[1].id = twice.tickets[0].id;
        assert.ok(!tickets.validateSuite(twice).valid, 'two tickets cannot share an id');
    });

    await check('a suite in the committed fixture is valid and holds twelve real tickets', async () => {
        const file = path.join(__dirname, '..', 'fixtures', 'codes.ticket', 'openvibe-merged-2026-11.json');
        const suite = JSON.parse(fs.readFileSync(file, 'utf8'));
        const checked = tickets.validateSuite(suite);
        assert.ok(checked.valid, checked.detail);
        assert.strictEqual(suite.tickets.length, 12);
        for (const ticket of suite.tickets) {
            assert.strictEqual(ticket.check.kind, 'command');
            assert.match(ticket.fixture.check_patch, /^diff --git /);
            assert.match(ticket.source.repository, /^OpenVibers\//);
        }
    });

    await check('the benchmark task carries AL1 goal, check, budget and the grading patch', async () => {
        const definition = tickets.benchmarkDefinition(kitchen());
        assert.strictEqual(definition.kind, 'codes.ticket');
        assert.strictEqual(definition.tasks.length, 2);
        const task = definition.tasks[0];
        assert.strictEqual(task.prompt, 'The example test passes.');
        assert.strictEqual(task.holdout, true);
        assert.strictEqual(task.files[0].goal, 'The example test passes.');
        assert.strictEqual(task.files[0].check.kind, 'command');
        assert.strictEqual(task.files[0].budget.turns, 10);
        assert.ok(task.expected.check_patch.startsWith('diff --git '));
    });

    await check('the runner makes no call without --run, and refuses a dear model before one', async () => {
        let calls = 0;
        const plan = await runner.runSuite({ suite: kitchen(), execute: () => { calls++; } });
        assert.strictEqual(plan.ok, true);
        assert.strictEqual(plan.ran, false);
        assert.strictEqual(calls, 0);
        const refused = await runner.runSuite({ suite: kitchen(), run: true, models: ['claude-opus-4'], execute: () => { calls++; } });
        assert.strictEqual(refused.ok, false);
        assert.strictEqual(refused.code, 'bench.ticket_model_not_allowed');
        assert.strictEqual(calls, 0);
        const short = await runner.runSuite({ suite: kitchen(), run: true, trials: 2, execute: () => { calls++; } });
        assert.strictEqual(short.ok, false);
        assert.strictEqual(short.code, 'bench.ticket_trials');
        assert.strictEqual(calls, 0);
    });

    await check('the executor prompt carries the goal and check but never the test patch', async () => {
        const ticket = kitchen().tickets[0];
        const prompt = executor.promptFor({ ticket, workspace: '/tmp/example' });
        assert.ok(prompt.includes(ticket.goal), 'the goal is in the prompt');
        assert.ok(prompt.includes(ticket.check.value), 'the check is in the prompt');
        assert.ok(!prompt.includes(ticket.fixture.check_patch.split('\n')[0]), 'the test patch is never shown to the agent');
        assert.match(prompt, /Do not add or edit anything under test\//);
    });

    await check('the command line prints the plan and parses the safe flags', async () => {
        const args = cli.parseArgs(['--run', '--trials', '3', '--models', 'deepseek-flash,local', '--effort', 'high']);
        assert.strictEqual(args.run, true);
        assert.strictEqual(args.trials, '3');
        assert.strictEqual(args.models, 'deepseek-flash,local');
        const lines = cli.tableLines([{ model: 'deepseek-flash', effort: 'high', k: 3, pass_at_1: 0.888889, pass_at_k: 0.666667, cost_per_solved: 0.298567 }]);
        assert.match(lines[0], /pass@1 0\.889/);
        assert.match(lines[0], /pass\^3 0\.667/);
        assert.match(lines[0], /cost per solved \$0\.2986/);
    });

    await check('three trials make a table of pass@1, pass^3 and cost per solved', async () => {
        const out = await runner.runSuite({
            suite: kitchen(), run: true, trials: 3, models: ['deepseek-flash'],
            execute: ({ ticket, trial, model }) => ({ passed: ticket.id === 'alpha' || trial === 1, cost_usd: model === 'deepseek-flash' ? 0.001 : 0, ms: 5, tokens: 7, check_output: 'ok' }),
        });
        assert.strictEqual(out.ok, true);
        assert.strictEqual(out.runs.length, 3, 'one run per trial');
        assert.strictEqual(out.runs[0].settings.effort, 'high');
        assert.strictEqual(out.runs[0].provider, 'deepseek');
        assert.strictEqual(out.runs[0].tasks.length, 2);
        const row = out.table.find((e) => e.model === 'deepseek-flash' && e.effort === 'high');
        assert.ok(row, 'the table has the model and effort');
        assert.strictEqual(row.k, 3);
        assert.strictEqual(row.pass_at_1, 0.666667);
        assert.strictEqual(row.pass_at_k, 0.5);
        assert.strictEqual(row.cost_usd, 0.006);
        assert.strictEqual(row.cost_per_solved, 0.003);
        assert.strictEqual(row.insufficient_trials, false);
    });

    await check('pass@1 and pass^k are read from the results API, by model and effort', async () => {
        const definition = tickets.benchmarkDefinition(kitchen({ tickets: ['alpha', 'beta', 'gamma', 'delta'].map((id) => ticketDoc(id)) }));
        const created = await t.get('/api/v1/benchmarks', { bearer: writer, json: definition });
        assert.strictEqual(created.status, 201, created.text);
        const id = created.json().benchmark.id;
        const frozen = await t.get(`/api/v1/benchmarks/${id}/versions`, { bearer: writer, json: {} });
        assert.strictEqual(frozen.status, 201, frozen.text);
        const benchmark = `${id}@${frozen.json().version.version}`;
        const trial = (scores, { effort = 'high' } = {}) => {
            const tasks = scores.map(([task_id, score]) => ({ task_id, score, cost_usd: 0.001, ms: 100, tokens: 10, artifacts: [] }));
            return {
                benchmark, model: 'deepseek-flash', provider: 'deepseek',
                route: { requested: 'deepseek-flash', ran: 'deepseek-flash', effort },
                harness: { name: 'openvibe-codes', version: '0.4.0' }, settings: { effort },
                executor: { kind: 'codes', id: 'test' }, session: 'gate-test',
                tasks, score: tasks.reduce((n, x) => n + x.score, 0) / tasks.length,
                cost_usd: tasks.reduce((n, x) => n + x.cost_usd, 0), ms: tasks.length * 100, tokens: tasks.length * 10,
            };
        };
        // alpha passes every trial, beta two of three, gamma one, delta none.
        const trials = [
            trial([['alpha', 100], ['beta', 100], ['gamma', 100], ['delta', 0]]),
            trial([['alpha', 100], ['beta', 100], ['gamma', 0], ['delta', 0]]),
            trial([['alpha', 100], ['beta', 0], ['gamma', 0], ['delta', 0]]),
        ];
        for (const body of trials) {
            const made = await t.get('/api/v1/runs', { bearer: writer, json: body });
            assert.strictEqual(made.status, 201, made.text);
        }
        // A one-trial low-effort run is read, but it is not a gate result.
        const low = await t.get('/api/v1/runs', { bearer: writer, json: trial([['alpha', 100]], { effort: 'low' }) });
        assert.strictEqual(low.status, 201, low.text);
        const read = await t.get(`/api/v1/rankings?benchmark=${encodeURIComponent(benchmark)}&metric=tickets&effort=high`, { bearer: writer });
        assert.strictEqual(read.status, 200, read.text);
        const row = read.json().rankings.entries.find((e) => e.model === 'deepseek-flash' && e.effort === 'high');
        assert.ok(row, 'the entry names the model and effort');
        assert.strictEqual(row.k, 3);
        assert.strictEqual(row.trials, 3, 'three trial runs');
        assert.strictEqual(row.task_trials, 12, 'four tickets x three trials');
        assert.strictEqual(row.tickets, 4);
        assert.strictEqual(row.pass_at_1, 0.5);
        assert.strictEqual(row.pass_at_k, 0.25);
        assert.ok(Math.abs(row.cost_per_solved - 0.004) < 1e-9, 'every trial cost, divided by the three solved tickets');
        assert.strictEqual(row.per_ticket.find((x) => x.task_id === 'alpha').pass_at_k, true);
        assert.strictEqual(row.per_ticket.find((x) => x.task_id === 'delta').pass_at_k, false);
        const alias = await t.get(`/api/v1/rankings?benchmark=${encodeURIComponent(benchmark)}&metric=pass_k`, { bearer: writer });
        assert.strictEqual(alias.status, 200, alias.text);
        assert.strictEqual(alias.json().rankings.metric, 'tickets');
        const other = await t.get(`/api/v1/rankings?benchmark=${encodeURIComponent(benchmark)}&metric=tickets&effort=low`, { bearer: writer });
        assert.strictEqual(other.status, 200, other.text);
        assert.strictEqual(other.json().rankings.entries.length, 1, 'the low-effort group is its own row');
        assert.strictEqual(other.json().rankings.entries[0].k, 1);
        assert.strictEqual(other.json().rankings.entries[0].insufficient_trials, true, 'one trial is not a gate result');
        const wrong = await t.get(`/api/v1/rankings?benchmark=${encodeURIComponent(benchmark)}&metric=sideways`, { bearer: writer });
        assert.strictEqual(wrong.status, 400, wrong.text);
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

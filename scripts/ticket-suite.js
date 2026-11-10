#!/usr/bin/env node
'use strict';

/**
 * The AL8 gate, from the command line. It reads a suite file (bench.codes-ticket-suite@1), checks it, and — only
 * when the caller passes `--run` — runs every ticket over 3 to 5 trials on deepseek-flash and the local model,
 * publishes one run per trial and reads the table back from the results API.
 *
 *   node scripts/ticket-suite.js                         # the plan: no call, no cost
 *   node scripts/ticket-suite.js --run --trials 3 \
 *     --models deepseek-flash --effort high \
 *     --publish https://bench.openvibe.services --token "$BENCH_SERVICE_TOKEN"
 *
 * There is no timer and no schedule: a suite runs when a person runs this command.
 *
 * The executor is a command that takes one JSON trial on stdin and answers one JSON result line (the default is
 * scripts/ticket-executor.js). `--benchmark bmk_…` reuses a frozen suite instead of creating a new one; a new run
 * of an old benchmark is what makes pass^k comparable over time.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const tickets = require('../server/bench/tickets');
const runner = require('../server/bench/ticket-runner');

const ROOT = path.join(__dirname, '..');
const DEFAULT_SUITE = path.join(ROOT, 'fixtures', 'codes.ticket', 'openvibe-merged-2026-11.json');

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) { out._.push(arg); continue; }
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next == null || next.startsWith('--')) out[key] = true;
        else { out[key] = next; i++; }
    }
    return out;
}

function list(value, fallback) {
    if (value == null || value === true) return fallback;
    return String(value).split(',').map((x) => x.trim()).filter(Boolean);
}

/** A stable line the report quotes: pass@1, pass^k and cost per solved for each model and effort. */
function tableLines(entries) {
    return entries.map((e) => `${e.model} · effort ${e.effort || 'default'} · trials ${e.k} · pass@1 ${e.pass_at_1 == null ? '—' : e.pass_at_1.toFixed(3)} · pass^${e.k} ${e.pass_at_k == null ? '—' : e.pass_at_k.toFixed(3)} · cost per solved ${e.cost_per_solved == null ? '—' : '$' + e.cost_per_solved.toFixed(4)}${e.insufficient_trials ? ' (fewer than 3 trials: not a gate result)' : ''}`);
}

async function callJson(base, pathname, { method = 'GET', body, token } = {}) {
    const response = await fetch(new URL(pathname, base), {
        method,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* a problem document may not be JSON */ }
    if (!response.ok) throw new Error(`${method} ${pathname} answered HTTP ${response.status}: ${(json && (json.detail || json.code)) || text.slice(0, 300)}`);
    return json;
}

/** Create and freeze a benchmark for the suite, or reuse one the caller names. */
async function ensureBenchmark(base, token, suite, reuse, log) {
    if (reuse) {
        const found = await callJson(base, `/api/v1/benchmarks/${encodeURIComponent(reuse)}`, { token });
        const benchmark = found.benchmark || found;
        const version = benchmark.latest_version || (found.version && found.version.version);
        if (!version) throw new Error(`${reuse} has no frozen version`);
        log(`reusing ${benchmark.id}@${version}`);
        return { id: benchmark.id, version };
    }
    const definition = tickets.benchmarkDefinition(suite);
    const made = await callJson(base, '/api/v1/benchmarks', {
        method: 'POST', token,
        body: { title: definition.title, description: definition.description, kind: definition.kind, tags: definition.tags, visibility: 'unlisted', definition },
    });
    const id = made.benchmark.id;
    const frozen = await callJson(base, `/api/v1/benchmarks/${encodeURIComponent(id)}/versions`, { method: 'POST', token, body: {} });
    log(`created ${id}@${frozen.version.version}`);
    return { id, version: frozen.version.version };
}

/** One trial through the executor command; its stdout's last JSON line is the result. */
function executeWith(command, input, logPath) {
    return new Promise((resolve) => {
        const child = spawn('bash', ['-lc', command], { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.stdin.end(JSON.stringify(input));
        const timer = setTimeout(() => child.kill('SIGKILL'), 30 * 60 * 1000);
        child.on('close', () => {
            clearTimeout(timer);
            if (logPath) fs.writeFileSync(logPath, err.slice(-20000));
            const lines = out.trim().split('\n').filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
                try { return resolve(JSON.parse(lines[i])); } catch { /* earlier lines are not the result */ }
            }
            resolve({ passed: false, cost_usd: 0, ms: 0, tokens: 0, check_output: `the executor printed no result: ${out.slice(-500)} ${err.slice(-500)}` });
        });
        child.on('error', (error) => { clearTimeout(timer); resolve({ passed: false, cost_usd: 0, ms: 0, tokens: 0, check_output: error.message }); });
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const suitePath = path.resolve(String(args.suite || DEFAULT_SUITE));
    if (!fs.existsSync(suitePath)) throw new Error(`no suite file at ${suitePath}`);
    const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
    const checked = tickets.validateSuite(suite);
    if (!checked.valid) throw new Error(`the suite is not valid: ${checked.detail}`);
    const models = list(args.models, suite.models || tickets.DEFAULT_MODELS);
    const trials = args.trials == null ? suite.trials : Number(args.trials);
    const effort = args.effort == null ? 'high' : String(args.effort);
    const plan = runner.plan(suite, { models, trials, effort });

    process.stdout.write(`suite ${suite.suite}: ${plan.tickets.length} tickets × ${plan.models.join(', ')} × ${plan.trials} trials = ${plan.calls} calls, effort ${plan.effort}\n`);
    for (const ticket of plan.tickets) process.stdout.write(`  ${ticket.id}: ${ticket.check}\n`);

    if (!args.run) {
        process.stdout.write('not run: pass --run to spend money on these trials\n');
        return;
    }
    if (args.publish && !args.token) throw new Error('--publish needs --token (or BENCH_SERVICE_TOKEN)');
    const base = args.publish ? String(args.publish).replace(/\/+$/, '') : null;
    const token = args.token && args.token !== true ? String(args.token) : process.env.BENCH_SERVICE_TOKEN;
    const log = (message) => process.stderr.write(`[ticket-suite] ${message}\n`);
    const benchmark = base ? await ensureBenchmark(base, token, suite, args.benchmark, log) : null;
    const workdir = path.resolve(String(args.workdir || path.join(os.tmpdir(), `bench-tickets-${suite.suite}`)));
    const logDir = args['log-dir'] ? path.resolve(String(args['log-dir'])) : null;
    if (logDir) fs.mkdirSync(logDir, { recursive: true });
    const executor = String(args.executor || `node ${JSON.stringify(path.join(__dirname, 'ticket-executor.js'))}`);

    const out = await runner.runSuite({
        suite, models, trials, effort, run: true,
        execute: async ({ ticket, model, trial, session }) => {
            const workspace = path.join(workdir, ticket.id);
            const logPath = logDir ? path.join(logDir, `${ticket.id}-${model.replace(/[^a-z0-9.-]/gi, '_')}-${trial}.log`) : null;
            log(`${ticket.id} · ${model} · trial ${trial}/${plan.trials}`);
            return executeWith(executor, { ticket, model, effort, trial, session, workspace, log_path: logPath }, logPath);
        },
    });
    if (!out.ok) throw new Error(`${out.code}: ${out.detail}`);

    let published = [];
    if (base) {
        for (const run of out.runs) {
            const made = await callJson(base, '/api/v1/runs', { method: 'POST', token, body: { ...run, benchmark: `${benchmark.id}@${benchmark.version}`, benchmark_id: benchmark.id, benchmark_version: benchmark.version } });
            published.push(made.run.id);
        }
        log(`published ${published.length} runs on ${benchmark.id}@${benchmark.version}`);
    }
    let table = out.table;
    if (base) {
        const read = await callJson(base, `/api/v1/rankings?benchmark=${encodeURIComponent(benchmark.id + '@' + benchmark.version)}&metric=tickets&effort=${encodeURIComponent(effort)}`, { token });
        table = read.rankings.entries;
    }
    const report = { suite: suite.suite, session: out.session, benchmark, effort, models, trials: plan.trials, runs: published, table };
    if (args.out) fs.writeFileSync(path.resolve(String(args.out)), JSON.stringify(report, null, 2));
    for (const line of tableLines(table)) process.stdout.write(line + '\n');
}

if (require.main === module) {
    main().catch((err) => { process.stderr.write(`[ticket-suite] ${err.message}\n`); process.exitCode = 1; });
}

module.exports = { parseArgs, tableLines, ensureBenchmark, executeWith };

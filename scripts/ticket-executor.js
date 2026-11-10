'use strict';

/**
 * The local executor for one ticket trial (AL8). It is called by scripts/ticket-suite.js (or by the real-run
 * harness) with one JSON document on stdin:
 *
 *   { ticket, model, effort, trial, session, workspace, log_path? }
 *
 * It prepares a fresh checkout at the ticket's base commit, runs an OpenVibe.Codes agent on the goal, restores
 * everything under test/ (so the agent cannot grade itself), applies the pull request's test patch and runs the
 * check. It prints one JSON line on stdout:
 *
 *   { passed, cost_usd, ms, tokens, turns, check_output, model, effort, workspace }
 *
 * Environment: `DEEPSEEK_API_KEY` for deepseek-flash; `OPENVIBE_CODES_DIR` for the harness (default
 * ~/openvibe/work/OpenVibe.Codes); `OPENVIBE_CODES_BASE_URL` (and `OPENVIBE_CODES_MODEL`) for the local model;
 * `OPENVIBE_REPO_CACHE` to clone from a local mirror instead of GitHub. Nothing here prints a secret: the agent's
 * events are consumed, its cost and tokens only are reported, and its log goes to log_path when one is named.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const MAX_OUTPUT = 4000;

function sh(cmd, args, cwd, { timeout = 300000, env = process.env } = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const add = (d) => { out = (out + d.toString()).slice(-MAX_OUTPUT); };
        child.stdout.on('data', add); child.stderr.on('data', add);
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
        child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out }); });
        child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, code: -1, out: err.message }); });
    });
}

function git(args, cwd) {
    try { return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] }) }; }
    catch (err) { return { ok: false, out: String((err.stderr || err.stdout || err.message)).slice(-800) }; }
}

/** Where a repo's local clone cache lives, when one is configured. */
function cachedRepo(url, cache) {
    if (!cache) return null;
    const name = String(url).replace(/\.git$/, '').split('/').slice(-2).join('/');
    for (const candidate of [path.join(cache, name), path.join(cache, `${name}.git`)]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

/** The checkout at the ticket's base commit: cloned once, reset before every trial, dependencies installed once. */
async function prepare(input) {
    const workspace = input.workspace || fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ticket-'));
    const ref = input.ticket.fixture.ref;
    const fresh = !fs.existsSync(path.join(workspace, '.git'));
    if (fresh) {
        fs.mkdirSync(workspace, { recursive: true });
        const cache = cachedRepo(input.ticket.fixture.repo, process.env.OPENVIBE_REPO_CACHE);
        const clone = cache
            ? await sh('git', ['clone', '--shared', '-q', cache, workspace], path.dirname(workspace))
            : await sh('git', ['clone', '--filter=blob:none', '-q', input.ticket.fixture.repo, workspace], path.dirname(workspace));
        if (!clone.ok) throw new Error(`clone failed: ${clone.out}`);
    }
    const checkout = git(['checkout', '-q', ref], workspace);
    if (!checkout.ok) {
        const fetched = git(['fetch', '-q', 'origin', ref], workspace);
        if (!fetched.ok) throw new Error(`checkout ${ref} failed: ${checkout.out}`);
        const again = git(['checkout', '-q', ref], workspace);
        if (!again.ok) throw new Error(`checkout ${ref} failed: ${again.out}`);
    }
    git(['reset', '--hard', '-q', ref], workspace);
    git(['clean', '-fdq', '-e', 'node_modules'], workspace);
    if (!fs.existsSync(path.join(workspace, 'node_modules'))) {
        const installed = await sh('npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline'], workspace, { timeout: 600000 });
        if (!installed.ok) throw new Error(`npm ci failed: ${installed.out.slice(-600)}`);
    }
    return { workspace, fresh };
}

/** The prompt one agent gets: the goal, its check and the budget. The test patch is never in it. */
function promptFor(input) {
    const ticket = input.ticket;
    const budget = ticket.budget || {};
    return [
        `Work in the repository in ${input.workspace}. Its base commit is ${ticket.fixture.ref}.`,
        '',
        'The goal:',
        ticket.goal,
        '',
        `The check: ${ticket.check.kind} — ${ticket.check.value}`,
        budget.turns ? `Turn budget: ${budget.turns}.` : '',
        budget.active_minutes ? `Time budget: about ${budget.active_minutes} minutes.` : '',
        '',
        'Do not add or edit anything under test/: the graded tests are applied after you stop, and your copy of them is discarded.',
        'Do not run the full suite (npm test or node test/run.js): run at most one focused test file, or node --check on the files you changed.',
        'Make the smallest change in the code the goal names, and end with a short summary.',
    ].filter((line) => line !== '').join('\n');
}

/** Run one OpenVibe.Codes agent on the ticket. Returns cost, tokens, turns and the final text. */
async function runAgent(input, workspace) {
    const codesDir = process.env.OPENVIBE_CODES_DIR || path.join(os.homedir(), 'openvibe', 'work', 'OpenVibe.Codes');
    let createHarness;
    try { ({ createHarness } = require(path.join(codesDir, 'harness'))); }
    catch (err) { throw new Error(`the OpenVibe.Codes harness is not readable at ${codesDir}: ${err.message}`); }
    const model = String(input.model);
    const agent = model === 'local' ? 'openai-compatible' : 'deepseek';
    const modelName = model === 'local' ? (process.env.OPENVIBE_CODES_MODEL || null) : model;
    const budget = input.ticket.budget || {};
    const harness = createHarness({ env: process.env });
    const run = harness.run({
        prompt: promptFor(input),
        agent,
        model: modelName,
        cwd: workspace,
        permission: 'full',
        handoff: false,
        maxTurns: Math.max(1, Number(budget.turns) || 30),
        maxAttempts: 1,
        stallMs: 4 * 60 * 1000,
    });
    // A hard wall clock: the harness's quiet timer cancels a model call but a command's grandchild can hold its
    // pipe open forever, so one trial is never allowed to outlive its budget. The agent's own spend still counts.
    const deadlineMs = Math.max(60_000, Math.min(8 * 60_000, Number(budget.active_minutes || 8) * 60_000));
    const consumer = (async () => {
        let result = null;
        for await (const event of run) {
            if (event.type === 'result') result = event;
            if (input.log_path) fs.appendFileSync(input.log_path, JSON.stringify({ type: event.type, subtype: event.subtype || null, text: event.result || (event.message && event.message.content && event.message.content[0] && event.message.content[0].text) || null }) + '\n');
        }
        const usage = (result && result.usage) || {};
        return {
            cost_usd: result ? Number(result.total_cost_usd) || 0 : 0,
            tokens: (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0),
            turns: result ? Number(result.num_turns) || 0 : 0,
            ok: Boolean(result && !result.is_error),
            text: result ? String(result.result || '') : '',
        };
    })();
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timed_out: true }), deadlineMs); timer.unref?.(); });
    const agentResult = await Promise.race([consumer, timeout]);
    clearTimeout(timer);
    if (agentResult.timed_out) {
        try { run.cancel(); } catch { /* the run is already gone */ }
        return { cost_usd: 0, tokens: 0, turns: 0, ok: false, text: `the agent did not finish within ${Math.round(deadlineMs / 60000)} minutes` };
    }
    return agentResult;
}

/** Restore test/, apply the pull request's test patch, run the check. The only place a trial can pass. */
async function grade(input, workspace) {
    git(['checkout', '--', 'test'], workspace);
    git(['clean', '-fdq', 'test'], workspace);
    const patchFile = path.join(workspace, '.bench-check.patch');
    fs.writeFileSync(patchFile, input.ticket.fixture.check_patch);
    const applied = await sh('git', ['apply', '--whitespace=nowarn', '.bench-check.patch'], workspace);
    fs.rmSync(patchFile, { force: true });
    if (!applied.ok) return { passed: false, check_output: `the check patch did not apply: ${applied.out}` };
    const timeout = Number(input.ticket.fixture.check_timeout_ms) || 180000;
    const check = await sh('bash', ['-lc', input.ticket.check.value], workspace, { timeout });
    return { passed: check.ok, check_output: check.out };
}

async function main(raw) {
    const input = JSON.parse(raw);
    const started = Date.now();
    const { workspace } = await prepare(input);
    let agent;
    try { agent = await runAgent(input, workspace); }
    catch (err) { agent = { cost_usd: 0, tokens: 0, turns: 0, ok: false, text: err.message }; }
    // A test command (a URL check and a rubric are graded by a person, not this executor) still needs a workspace.
    const graded = input.ticket.check.kind === 'command' ? await grade(input, workspace) : { passed: false, check_output: `a ${input.ticket.check.kind} check is not graded by the local executor` };
    return {
        passed: graded.passed,
        cost_usd: Math.round(agent.cost_usd * 1e6) / 1e6,
        ms: Date.now() - started,
        tokens: agent.tokens,
        turns: agent.turns,
        agent_ok: agent.ok,
        agent_text: agent.text.slice(0, 2000),
        check_output: String(graded.check_output || '').slice(-MAX_OUTPUT),
        model: input.model,
        effort: input.effort,
        workspace,
    };
}

if (require.main === module) {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { raw += d; });
    process.stdin.on('end', () => {
        main(raw).then((out) => {
            process.stdout.write(JSON.stringify(out) + '\n');
            // A timed-out agent may leave a child holding a pipe: the result is out, so the process may stop.
            setTimeout(() => process.exit(0), 250).unref();
        }, (err) => {
            process.stdout.write(JSON.stringify({ passed: false, cost_usd: 0, ms: 0, tokens: 0, check_output: String(err && err.message || err).slice(0, 2000) }) + '\n');
            setTimeout(() => process.exit(1), 250).unref();
        });
    });
}

module.exports = { main, prepare, promptFor, grade, cachedRepo };

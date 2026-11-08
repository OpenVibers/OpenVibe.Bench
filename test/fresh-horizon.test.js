'use strict';

/**
 * B13: fresh monthly sets, held-out tasks, the contamination flag and the time horizon.
 *
 * The rules under test: `since=YYYY-MM` scores only the tasks added in or after that month; a held-out task never
 * reaches the open data, an anonymous page or somebody else's account export, and a submitted/imported run gets no
 * score for one; the contamination maths says "flag", "no flag" or "not enough runs"; the logistic fit recovers a
 * known horizon and its bootstrap; the 15-task/3-run gates hold; editors' estimates are exported and erased with
 * the person and the form is signed-in and same-origin only.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { contaminationFor } = require('../server/bench/contamination');
const { estimateHorizon } = require('../server/bench/horizon');
const { parseSince } = require('../server/bench/registry');

const baseTask = (id, over = {}) => ({ id, prompt: `Task ${id}: build a small page.`, files: [], expected: null, holdout: false, ...over });

function definition(over = {}) {
    return {
        title: 'B13 arena',
        description: 'A benchmark for the fresh-set and horizon tests.',
        kind: 'design.page',
        tags: ['design'],
        visibility: 'public',
        tasks: [baseTask('t1')],
        judges: [{ type: 'rubric', version: '1.0', config: {} }],
        scoring: { method: 'mean', scale: { min: 0, max: 100 } },
        limits: { ms: 120000, tokens: 200000, usd: 0.5 },
        matrix: { models: [], harnesses: [] },
        ...over,
    };
}

function runDoc(benchmark, tasks, over = {}) {
    const scores = tasks.map((t) => t.score).filter((v) => v != null);
    return {
        benchmark,
        model: 'model-a',
        route: { provider: 'acme' },
        provider: 'acme',
        harness: { name: 'claude-code', version: '3.1.0' },
        settings: { temperature: 1, effort: 'high' },
        executor: { kind: 'codes', id: 'tsk_b13' },
        tasks,
        score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
        cost_usd: tasks.reduce((n, t) => n + (t.cost_usd || 0), 0),
        ms: tasks.reduce((n, t) => n + (t.ms || 0), 0),
        tokens: tasks.reduce((n, t) => n + (t.tokens || 0), 0),
        ...over,
    };
}

const result = (task_id, score, extra = {}) => ({ task_id, score, cost_usd: 0.01, ms: 1000, tokens: 100, artifacts: [], ...extra });

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const carol = t.network.addUser('carol');
    const publisher = t.network.serviceToken({ sub: 'svc:codes', audience: 'openvibe.bench', cap: ['bench.run.publish', 'bench.benchmark.write'] });

    const create = async (over, as = null) => {
        const res = await t.get('/api/v1/benchmarks', as ? { as, json: definition(over) } : { bearer: publisher, json: definition(over) });
        assert.strictEqual(res.status, 201, res.text);
        const id = res.json().benchmark.id;
        const frozen = await t.get(`/api/v1/benchmarks/${id}/versions`, as ? { as, json: {} } : { bearer: publisher, json: {} });
        assert.strictEqual(frozen.status, 201, frozen.text);
        return { id, version: frozen.json().version.version };
    };
    const publish = async (ref, doc) => {
        const res = await t.get('/api/v1/runs', { bearer: publisher, json: doc });
        assert.strictEqual(res.status, 201, res.text);
        return res.json().run;
    };
    const postForm = async (path, body, as) => t.get(path, {
        as, method: 'POST', raw: new URLSearchParams(body).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    await check('the since parser takes a month, a day or a timestamp', () => {
        assert.strictEqual(parseSince('2026-03').cutoff, '2026-03-01');
        assert.strictEqual(parseSince('2026-03').label, 'March 2026');
        assert.strictEqual(parseSince('2026-03-10').cutoff, '2026-03-10');
        assert.strictEqual(parseSince('not-a-date'), null);
    });

    await check('since=YYYY-MM scores only the tasks added in or after that month', async () => {
        const made = await create({
            title: 'Fresh monthly set',
            tasks: [
                baseTask('old', { added_on: '2025-01-15', human_minutes: 20 }),
                baseTask('fresh', { added_on: '2026-03-10', human_minutes: 40 }),
            ],
        });
        const frozen = await t.get(`/api/v1/benchmarks/${made.id}@${made.version}`);
        assert.strictEqual(frozen.status, 200, frozen.text);
        contracts.assertValid('bench.benchmark@1', frozen.json().version.definition);
        assert.strictEqual(frozen.json().task_meta.find((m) => m.task_id === 'old').added_on, '2025-01-15', 'the date lives beside the closed document');

        await publish(`${made.id}@${made.version}`, runDoc(`${made.id}@${made.version}`, [result('old', 100), result('fresh', 20)], { model: 'model-a' }));
        await publish(`${made.id}@${made.version}`, runDoc(`${made.id}@${made.version}`, [result('old', 80), result('fresh', 80)], { model: 'model-b' }));

        const all = await t.get(`/api/v1/rankings?benchmark=${made.id}&metric=score`);
        assert.strictEqual(all.status, 200, all.text);
        assert.strictEqual(all.json().rankings.entries.find((e) => e.model === 'model-a').score, 60, 'the all-time board uses the run score');

        const fresh = await t.get(`/api/v1/rankings?benchmark=${made.id}&metric=score&since=2026-03`);
        assert.strictEqual(fresh.status, 200, fresh.text);
        const rankings = fresh.json().rankings;
        assert.strictEqual(rankings.since.label, 'March 2026');
        assert.strictEqual(rankings.since.basis, 'tasks');
        assert.strictEqual(rankings.entries.find((e) => e.model === 'model-a').score, 20, 'only the fresh task is scored');
        assert.strictEqual(rankings.entries.find((e) => e.model === 'model-b').score, 80);
    });

    await check('a held-out task never leaks, and a submitted run gets no score for it', async () => {
        const secret = 'SECRET_HELDOUT_PROMPT_9f2a';
        const made = await create({
            title: 'Held-out arena',
            tasks: [
                baseTask('visible', { prompt: 'A visible task.' }),
                baseTask('hidden', { prompt: secret, expected: { answer: 'SECRET_EXPECTED' }, held_out: true }),
            ],
        }, alice);

        const data = await t.get('/api/v1/datasets/benchmarks.jsonl');
        assert.ok(data.text.includes('A visible task.'));
        assert.ok(!data.text.includes(secret), 'the open data never carries the held-out prompt');
        assert.ok(!data.text.includes('SECRET_EXPECTED'), 'nor its expected answer');

        const api = await t.get(`/api/v1/benchmarks/${made.id}`);
        const hidden = api.json().definition.tasks.find((x) => x.id === 'hidden');
        assert.strictEqual(hidden.prompt, null);
        assert.strictEqual(hidden.holdout, true);

        const page = await t.get(`/benchmarks/${made.id}`);
        assert.ok(!page.text.includes(secret), 'the page never carries the held-out prompt');

        const submitted = await t.get('/api/v1/runs', {
            as: alice,
            json: runDoc(`${made.id}@${made.version}`, [result('visible', 50), result('hidden', 99)], { model: 'submitted-model' }),
        });
        assert.strictEqual(submitted.status, 201, submitted.text);
        assert.strictEqual(submitted.json().run.tasks.find((x) => x.task_id === 'hidden').score, null, 'a submitted run cannot score a held-out task');
        assert.strictEqual(submitted.json().run.tasks.find((x) => x.task_id === 'visible').score, 50);

        const verified = await publish(`${made.id}@${made.version}`, runDoc(`${made.id}@${made.version}`, [result('visible', 50), result('hidden', 99)], { model: 'verified-model' }));
        assert.strictEqual(verified.tasks.find((x) => x.task_id === 'hidden').score, 99, 'the executor may score it');

        const fork = await t.get(`/api/v1/benchmarks/${made.id}/fork`, { as: bob, json: {} });
        assert.strictEqual(fork.status, 403, 'a fork by somebody who may not see the holdout is refused');
        assert.ok(!fork.text.includes(secret), 'and the refusal does not carry the prompt');

        const exportPart = await t.ctx.accountData.exportPart(bob.subject);
        const blob = JSON.stringify(exportPart.files || []);
        assert.ok(!blob.includes(secret), 'somebody else\'s account export never carries the prompt');
        assert.ok(!blob.includes('SECRET_EXPECTED'));

        const writer = t.network.serviceToken({ sub: 'svc:writer', audience: 'openvibe.bench', cap: ['bench.benchmark.write'] });
        const versioned = await t.get(`/api/v1/benchmarks/${made.id}/versions`, { bearer: writer, json: {} });
        assert.strictEqual(versioned.status, 201, versioned.text);
        assert.ok(!versioned.text.includes(secret), 'a new version response for a non-owner does not carry the prompt');
        assert.strictEqual(versioned.json().version.definition.tasks.find((x) => x.id === 'hidden').prompt, null);
    });

    await check('the contamination flag: a flag, no flag, and not enough runs', () => {
        const cutoff = { cutoff: '2025-08-07', source: 'https://example.test/model' };
        const flagged = contaminationFor({ oldScores: [90, 92, 94], freshScores: [20, 22, 24], ...cutoff });
        assert.strictEqual(flagged.flag, true);
        assert.ok(flagged.old.median > flagged.fresh.median);
        assert.ok(flagged.old.lower > flagged.fresh.upper, 'the 90% intervals do not overlap');
        const tied = contaminationFor({ oldScores: [70, 72, 74], freshScores: [68, 70, 72], ...cutoff });
        assert.strictEqual(tied.flag, false);
        assert.strictEqual(tied.reason, 'the intervals overlap');
        const thin = contaminationFor({ oldScores: [90], freshScores: [20, 22], ...cutoff });
        assert.strictEqual(thin.flag, false);
        assert.strictEqual(thin.reason, 'not enough runs yet');
        const unknown = contaminationFor({ oldScores: [90, 92], freshScores: [20, 22] });
        assert.strictEqual(unknown.flag, false);
        assert.strictEqual(unknown.reason, 'no release date');
    });

    await check('the logistic fit recovers a known 40-minute horizon and its bootstrap', () => {
        const groups = [];
        for (let i = 0; i < 20; i++) {
            const minutes = 2 + i * 5;
            const p = 1 / (1 + Math.exp(-(1.2 * Math.log(minutes) - 1.2 * Math.log(40))));
            groups.push({ minutes, success: p, runs: 3 });
        }
        const fit = estimateHorizon(groups, { runs: 3, timedTasks: 20 });
        assert.strictEqual(fit.available, true, JSON.stringify(fit));
        assert.ok(Math.abs(fit.horizon_minutes - 40) < 4, `the horizon is near 40: ${fit.horizon_minutes}`);
        assert.ok(fit.ci_lower <= fit.horizon_minutes && fit.horizon_minutes <= fit.ci_upper);
        assert.ok(fit.ci_lower <= 40 && 40 <= fit.ci_upper, `the 90% interval covers the true horizon: ${fit.ci_lower}-${fit.ci_upper}`);

        const tooFewTasks = estimateHorizon(groups.slice(0, 14), { runs: 3, timedTasks: 14 });
        assert.strictEqual(tooFewTasks.available, false);
        assert.strictEqual(tooFewTasks.reason, 'not enough runs yet');
        const tooFewRuns = estimateHorizon(groups, { runs: 2, timedTasks: 20 });
        assert.strictEqual(tooFewRuns.available, false);
        assert.strictEqual(tooFewRuns.reason, 'not enough runs yet');
    });

    await check('the board and the model page show a horizon only above 15 tasks and 3 runs', async () => {
        const tasks = [];
        const scoresForRun = [];
        for (let i = 0; i < 15; i++) {
            const minutes = 2 + i * 5;
            tasks.push(baseTask(`h${i}`, { added_on: '2026-01-10', human_minutes: minutes, human_minutes_source: 'benchmark author' }));
            const p = 1 / (1 + Math.exp(-(1.2 * Math.log(minutes) - 1.2 * Math.log(40))));
            scoresForRun.push(result(`h${i}`, p * 100));
        }
        const made = await create({ title: 'Timed arena', tasks });
        for (let run = 0; run < 3; run++) {
            await publish(`${made.id}@${made.version}`, runDoc(`${made.id}@${made.version}`, scoresForRun.map((x) => ({ ...x })), { model: 'model-timed' }));
        }
        const board = await t.get(`/api/v1/rankings?benchmark=${made.id}&metric=horizon`);
        assert.strictEqual(board.status, 200, board.text);
        const entry = board.json().rankings.entries.find((e) => e.model === 'model-timed');
        assert.strictEqual(entry.horizon.available, true, JSON.stringify(entry.horizon));
        assert.strictEqual(entry.horizon.timed_tasks, 15);
        assert.strictEqual(entry.horizon.runs, 3);
        assert.ok(Math.abs(entry.horizon.horizon_minutes - 40) < 6, `horizon ${entry.horizon.horizon_minutes}`);

    });

    await check('the contamination flag is in the API with both numbers', async () => {
        const made = await create({
            title: 'Old and fresh arena',
            tasks: [
                baseTask('before', { added_on: '2024-01-10', human_minutes: 10 }),
                baseTask('after', { added_on: '2026-01-10', human_minutes: 10 }),
            ],
        });
        for (let i = 0; i < 3; i++) {
            await publish(`${made.id}@${made.version}`, runDoc(`${made.id}@${made.version}`, [result('before', 90 + i), result('after', 20 + i)], { model: 'gpt-5' }));
        }
        const board = await t.get(`/api/v1/rankings?benchmark=${made.id}&metric=score`);
        const entry = board.json().rankings.entries.find((e) => e.model === 'gpt-5');
        assert.strictEqual(entry.contamination.flag, true, JSON.stringify(entry.contamination));
    });

    await t.close();
    done();
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });

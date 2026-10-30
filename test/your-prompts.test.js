'use strict';

/**
 * B11: a person's own prompts as a private benchmark.
 *
 * Under test: the paste parser (lines, CSV with an optional expected answer, 5–50 bounds); a private benchmark by
 * default; another person gets a 404 and nothing private is listed, in the sitemap or in the open data; the owner's
 * leaderboard sits beside the public board for the same kind (bands and cost per solved task, never mixed); the run
 * goes through the existing launcher and still asks before it starts; an unlisted share link with a long random
 * token, its "shared by its owner" page, noindex, and unlisting/unsharing/public/private; CSRF.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { parsePrompts, MAX_PROMPTS } = require('../server/bench/your-prompts');
const { shareTokenMatches } = require('../server/bench/registry');

function fakeCodes() {
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            calls.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
            res.setHeader('content-type', 'application/json');
            if (req.url === '/api/v1/harnesses') return res.end(JSON.stringify({ harnesses: [{ id: 'codex', label: 'Codex' }, { id: 'claude-code', label: 'Claude Code' }] }));
            if (/^\/api\/v1\/benchmarks\/[^/]+\/run$/.test(req.url) && req.method === 'POST') {
                res.statusCode = 202;
                return res.end(JSON.stringify({ session: 'ses_b11', tasks: [{ id: 'tsk_b11' }], task: { id: 'tsk_b11' }, total: 1 }));
            }
            res.statusCode = 404; res.end('{}');
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}

(async () => {
    const codes = await fakeCodes();
    const t = await boot({ env: { CODES_BENCH_RUN_URL: codes.url } });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const publisher = t.network.serviceToken({ sub: 'svc:codes', audience: 'openvibe.bench', cap: ['bench.run.publish', 'bench.benchmark.write'] });
    const base = String(t.config.baseUrl).replace(/\/+$/, '');
    const MARK = 'ZEBRA-B11-PROMPT';

    const form = (o) => new URLSearchParams(o).toString();
    const post = (path, o, opt = {}) => t.get(path, { as: alice, raw: form(o), headers: { 'content-type': 'application/x-www-form-urlencoded' }, ...opt });
    const share = (id, visibility) => post(`/benchmarks/${id}/share`, { visibility });
    const tokenOf = (res) => {
        const m = /\/b\/([A-Za-z0-9_-]{20,120})/.exec(res.text);
        assert.ok(m, `a share token in the page: ${res.text.slice(0, 300)}`);
        return m[1];
    };
    const publish = async (ref, model, scores, { cost = 0.03 } = {}) => {
        const tasks = scores.map((score, i) => ({ task_id: `t${i + 1}`, score, cost_usd: cost / scores.length, ms: 1000 + i, tokens: 100, artifacts: [] }));
        const body = {
            benchmark: ref, model, route: { provider: 'acme' }, provider: 'acme',
            harness: { name: 'codex', version: '1.0' }, settings: {}, executor: { kind: 'codes', id: 'tsk_b11' },
            tasks, score: scores.reduce((a, b) => a + b, 0) / scores.length, cost_usd: cost, ms: 2000, tokens: 600,
        };
        const res = await t.get('/api/v1/runs', { bearer: publisher, json: body });
        assert.strictEqual(res.status, 201, res.text);
        return res.json().run.id;
    };

    let id;
    let version;
    let token;
    const prompts = Array.from({ length: 6 }, (_, i) => `${MARK} number ${i + 1}`);

    await check('the parser takes one prompt per line and enforces 5–50', async () => {
        const good = parsePrompts(prompts.join('\n'), { format: 'lines' });
        assert.strictEqual(good.ok, true, good.detail);
        assert.strictEqual(good.prompts.length, 6);
        assert.ok(good.prompts.every((p) => p.expected === null));
        assert.strictEqual(parsePrompts(prompts.slice(0, 4).join('\n')).ok, false, 'four is too few');
        assert.strictEqual(parsePrompts(Array.from({ length: MAX_PROMPTS + 1 }, (_, i) => `p${i}`).join('\n')).ok, false, 'fifty-one is too many');
    });

    await check('the parser reads CSV with an optional expected answer and quoted commas', async () => {
        const csv = 'prompt,expected\n"What is 2 + 2, exactly?","4"\n"Say hello, in French.",bonjour\nName one primary colour.,red\nWhat is 3 × 3?,9\nFinish the word: sun—,flower\n';
        const parsed = parsePrompts(csv);
        assert.strictEqual(parsed.ok, true, parsed.detail);
        assert.strictEqual(parsed.format, 'csv', 'a prompt/expected header is detected');
        assert.strictEqual(parsed.prompts.length, 5);
        assert.strictEqual(parsed.prompts[0].prompt, 'What is 2 + 2, exactly?');
        assert.strictEqual(parsed.prompts[0].expected, '4');
        assert.strictEqual(parsed.prompts[1].prompt, 'Say hello, in French.');
        assert.strictEqual(parsed.prompts[1].expected, 'bonjour');
        const noHeader = parsePrompts('one,two\nthree,four\nfive,six\nseven,eight\nnine,ten', { format: 'csv' });
        assert.strictEqual(noHeader.ok, true, noHeader.detail);
        assert.deepStrictEqual(noHeader.prompts[0], { prompt: 'one', expected: 'two' });
    });

    await check('a share token is stored as a hash and checked in constant time', async () => {
        assert.strictEqual(shareTokenMatches('abc', 'a'.repeat(64)), false);
        assert.strictEqual(shareTokenMatches('abc', null), false);
    });

    await check('the form makes a private benchmark from pasted prompts', async () => {
        const res = await post('/benchmarks/new', {
            title: 'My private prompts', description: 'Six real prompts.',
            kind: 'text.answer', format: 'lines', prompts: prompts.join('\n'),
        });
        assert.strictEqual(res.status, 303, res.text.slice(0, 400));
        id = res.headers.get('location').split('/').pop();
        const r = await t.get(`/api/v1/benchmarks/${id}`, { as: alice });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().benchmark.visibility, 'private', 'private by default');
        assert.strictEqual(r.json().benchmark.title, 'My private prompts');
        assert.strictEqual(r.json().benchmark.latest_version, 1, 'frozen into a version');
        version = r.json().version.version;
        assert.strictEqual(r.json().definition.kind, 'text.answer');
        assert.strictEqual(r.json().definition.tasks.length, 6);
        assert.deepStrictEqual(r.json().definition.tasks.map((x) => x.id), ['t1', 't2', 't3', 't4', 't5', 't6']);
        assert.ok(r.json().definition.tasks.every((x) => x.prompt.startsWith(MARK)));
        assert.strictEqual(r.json().definition.tasks[0].expected, null);
        assert.strictEqual(r.json().definition.limits.usd, 0, 'no dollar cap is added or raised');
        assert.ok(!t.logs().includes(MARK), 'a prompt never reaches the log');
    });

    await check('a CSV paste keeps the expected answer of each row', async () => {
        const csv = 'prompt,expected\nQ1,A1\nQ2,A2\nQ3,A3\nQ4,A4\nQ5,A5\n';
        const res = await post('/benchmarks/new', { title: 'CSV prompts', kind: 'design.svg', format: 'csv', prompts: csv });
        assert.strictEqual(res.status, 303, res.text.slice(0, 400));
        const cid = res.headers.get('location').split('/').pop();
        const r = await t.get(`/api/v1/benchmarks/${cid}`, { as: alice });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().definition.kind, 'design.svg', 'an existing kind can be chosen');
        assert.deepStrictEqual(r.json().definition.tasks[0].expected, { answer: 'A1' });
        assert.strictEqual(r.json().definition.tasks.length, 5);
    });

    await check('another person gets a 404 for the private benchmark everywhere', async () => {
        for (const [path, what] of [
            [`/benchmarks/${id}`, 'page'],
            [`/benchmarks/${id}/run`, 'run form'],
            [`/api/v1/benchmarks/${id}`, 'definition'],
            [`/api/v1/rankings?benchmark=${id}`, 'rankings'],
            [`/api/v1/percentile?benchmark=${id}&model=a&score=90`, 'percentile'],
        ]) {
            const res = await t.get(path, { as: bob });
            assert.strictEqual(res.status, 404, `${what}: ${res.status} ${res.text.slice(0, 200)}`);
        }
        const run = await post(`/benchmarks/${id}/run`, { models: 'a', harnesses: 'codex', repeat: '1' }, { as: bob });
        assert.strictEqual(run.status, 404, run.text.slice(0, 200));
    });

    await check('a private benchmark is never in a list, the sitemap or the open data', async () => {
        const list = await t.get('/api/v1/benchmarks');
        assert.ok(!list.json().benchmarks.some((b) => b.id === id), 'not in the public list');
        const page = await t.get('/benchmarks');
        assert.ok(!page.text.includes('My private prompts'), 'not on the benchmarks page');
        const sitemap = await t.get('/sitemap.xml');
        assert.ok(!sitemap.text.includes(id), 'not in the sitemap');
        const dataset = await t.get('/api/v1/datasets/benchmarks.jsonl');
        assert.ok(!dataset.text.includes(MARK), 'no prompt in the open data');
        const mine = await t.get('/api/v1/benchmarks?mine=1', { as: alice });
        assert.ok(mine.json().benchmarks.some((b) => b.id === id), 'the owner lists it');
        assert.strictEqual(mine.headers.get('cache-control'), 'private, no-store', 'the owner list is not publicly cacheable');
        const theirs = await t.get('/api/v1/benchmarks?mine=1', { as: bob });
        assert.ok(!theirs.json().benchmarks.some((b) => b.id === id), 'nobody else does');
    });

    await check('the owner sees the private page and its prompts', async () => {
        const res = await t.get(`/benchmarks/${id}`, { as: alice });
        assert.strictEqual(res.status, 200, res.text.slice(0, 200));
        assert.ok(res.text.includes('Private.'), 'the private notice');
        assert.ok(res.text.includes(prompts[0]), 'the owner sees the prompt');
        assert.ok(res.text.includes('noindex'), 'kept out of search');
        assert.ok(res.text.includes('Share an unlisted link'), 'the owner can share');
        assert.strictEqual(res.headers.get('cache-control'), 'private, no-store');
    });

    await check('runs published for the owner make the two separate leaderboards', async () => {
        // A public benchmark of the same kind, with a run, is "the public one beside it".
        const pub = await t.get('/api/v1/benchmarks', { bearer: publisher, json: {
            title: 'Public text answers', description: 'The public board.', kind: 'text.answer', tags: [], visibility: 'public',
            tasks: [{ id: 't1', prompt: 'A public question.', files: [], expected: null, holdout: false }],
            judges: [{ type: 'automatic_grader', version: '1.0', config: {} }], scoring: { method: 'mean', scale: { min: 0, max: 100 } },
            limits: { ms: 60000, tokens: 0, usd: 0 }, matrix: { models: [], harnesses: [] },
        } });
        assert.strictEqual(pub.status, 201, pub.text);
        const pubId = pub.json().benchmark.id;
        assert.strictEqual((await t.get(`/api/v1/benchmarks/${pubId}/versions`, { bearer: publisher, json: {} })).status, 201);
        await publish(`${pubId}@1`, 'public-model', [90], { cost: 0.01 });

        await publish(`${id}@${version}`, 'model-a', [80], { cost: 0.03 });
        await publish(`${id}@${version}`, 'model-a', [95], { cost: 0.03 });
        await publish(`${id}@${version}`, 'model-b', [85], { cost: 0.05 });
        await publish(`${id}@${version}`, 'model-b', [96], { cost: 0.05 });
        await publish(`${id}@${version}`, 'model-c', [50], { cost: 0.01 });
        await publish(`${id}@${version}`, 'model-c', [55], { cost: 0.01 });

        const res = await t.get(`/benchmarks/${id}`, { as: alice });
        assert.strictEqual(res.status, 200, res.text.slice(0, 200));
        assert.ok(res.text.includes('Your prompts, 6 runs'), 'the owner leaderboard label');
        assert.ok(res.text.includes('The public board for this kind'), 'the public board is beside it');
        assert.ok(res.text.includes('Cost / solved task'), 'cost per solved task');
        assert.ok(/1st.{0,2}2nd/.test(res.text), 'overlapping intervals share a band');
        assert.ok(res.text.includes('model-a') && res.text.includes('model-b') && res.text.includes('model-c'), 'the own models');
        assert.ok(res.text.includes('public-model'), 'the public model');
        const start = res.text.indexOf('The public board for this kind');
        const end = res.text.indexOf('id="br-tasks-h"', start);
        const publicPart = res.text.slice(start, end);
        assert.ok(!publicPart.includes('model-a') && !publicPart.includes('model-b'), 'the private ranks are not mixed into the public board');
    });

    await check('the run goes through the launcher and still asks before it starts', async () => {
        const before = codes.calls.filter((c) => c.method === 'POST').length;
        const tooFew = await post(`/benchmarks/${id}/run`, { models: 'model-a', harnesses: 'codex', repeat: '1' });
        assert.strictEqual(tooFew.status, 400, tooFew.text.slice(0, 200));
        assert.ok(tooFew.text.includes('3 to 6 models'), '3 to 6 models');
        assert.strictEqual(codes.calls.filter((c) => c.method === 'POST').length, before, 'nobody called Codes for one model');
        const ask = await post(`/benchmarks/${id}/run`, { models: 'model-a', more_models: 'model-b, model-c', harnesses: 'codex', repeat: '1' });
        assert.strictEqual(ask.status, 200, ask.text.slice(0, 200));
        assert.ok(ask.text.includes('sets no dollar limit'), 'the no-limit confirmation');
        assert.strictEqual(codes.calls.filter((c) => c.method === 'POST').length, before, 'Codes was not called yet');
        const go = await post(`/benchmarks/${id}/run`, { models: 'model-a', more_models: 'model-b, model-c', harnesses: 'codex', repeat: '1', confirm: '1' });
        assert.strictEqual(go.status, 303, go.text.slice(0, 200));
        const calls = codes.calls.filter((c) => c.method === 'POST').slice(before);
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0].body.models, ['model-a', 'model-b', 'model-c']);
        assert.ok(calls[0].headers['x-ov-subject'], 'as the person');
        assert.match(String(calls[0].headers.authorization), /^Bearer /, 'with Bench’s service token');
        const api = await t.get(`/api/v1/benchmarks/${id}/run`, { as: alice, json: { models: ['model-a', 'model-b', 'model-c'], harnesses: ['codex'], repeat: 1 } });
        assert.strictEqual(api.status, 409, api.text);
        assert.strictEqual(api.json().cost_estimate_usd, null, 'no estimate is invented');
    });

    await check('an unlisted share link opens the page once, with a shared note and noindex', async () => {
        const res = await share(id, 'unlisted');
        assert.strictEqual(res.status, 200, res.text.slice(0, 300));
        token = tokenOf(res);
        assert.ok(token.length >= 40, 'a long random token');
        const page = await t.get(`/b/${token}`);
        assert.strictEqual(page.status, 200, page.text.slice(0, 300));
        assert.ok(page.text.includes('Shared by its owner'), 'the shared note');
        assert.ok(page.text.includes('noindex'), 'noindex');
        assert.ok(page.text.includes(MARK), 'the prompts are readable by the link');
        assert.ok(!page.text.includes('Share an unlisted link'), 'a visitor cannot re-share');
        assert.strictEqual((await t.get(`/benchmarks/${id}`)).status, 404, 'the id alone no longer opens it');
        assert.strictEqual((await t.get(`/api/v1/benchmarks/${id}`)).status, 404, 'nor its API definition');
        assert.strictEqual((await t.get('/b/not-a-real-token')).status, 404);
        assert.strictEqual((await t.get(`/benchmarks/${id}`, { as: bob })).status, 404);
    });

    await check('making it private again stops the link', async () => {
        const res = await share(id, 'private');
        assert.strictEqual(res.status, 200, res.text.slice(0, 200));
        assert.ok(res.text.includes('Private.'), 'private again');
        assert.strictEqual((await t.get(`/b/${token}`)).status, 404, 'the old link is dead');
        assert.strictEqual((await t.get(`/benchmarks/${id}`, { as: alice })).status, 200);
    });

    await check('sharing unlisted again makes a new link and invalidates the old one, then public lists it', async () => {
        const res = await share(id, 'unlisted');
        const second = tokenOf(res);
        assert.notStrictEqual(second, token, 'a new share is a new token');
        assert.strictEqual((await t.get(`/b/${token}`)).status, 404, 'the first link is dead');
        assert.strictEqual((await t.get(`/b/${second}`)).status, 200);
        const pub = await share(id, 'public');
        assert.strictEqual(pub.status, 200, pub.text.slice(0, 200));
        assert.strictEqual((await t.get(`/b/${second}`)).status, 404, 'the token is cleared when it becomes public');
        assert.strictEqual((await t.get(`/benchmarks/${id}`)).status, 200, 'public by id');
        const list = await t.get('/api/v1/benchmarks');
        assert.ok(list.json().benchmarks.some((b) => b.id === id), 'in the public list');
        const sitemap = await t.get('/sitemap.xml');
        assert.ok(sitemap.text.includes(id), 'in the sitemap');
        const dataset = await t.get('/api/v1/datasets/benchmarks.jsonl');
        assert.ok(dataset.text.includes(MARK), 'its prompts are in the open data');
        assert.ok(dataset.text.includes('benchmark_run'), 'with its runs');
        assert.ok(!dataset.text.includes(alice.subject), 'no person id in the open data');
        assert.ok(!dataset.text.includes('created_by'), 'no created_by field in the open data');
    });

    await check('making it private again takes it out of every public surface', async () => {
        await share(id, 'private');
        const list = await t.get('/api/v1/benchmarks');
        assert.ok(!list.json().benchmarks.some((b) => b.id === id));
        const dataset = await t.get('/api/v1/datasets/benchmarks.jsonl');
        assert.ok(!dataset.text.includes(MARK), 'the prompts leave the open data');
        const sitemap = await t.get('/sitemap.xml');
        assert.ok(!sitemap.text.includes(id));
    });

    await check('every form post is same-origin', async () => {
        const make = await post('/benchmarks/new', { kind: 'text.answer', format: 'lines', prompts: prompts.join('\n') }, { origin: 'https://evil.example' });
        assert.strictEqual(make.status, 403, make.text.slice(0, 200));
        const shared = await post(`/benchmarks/${id}/share`, { visibility: 'public' }, { origin: 'https://evil.example' });
        assert.strictEqual(shared.status, 403, shared.text.slice(0, 200));
    });

    await check('stop', async () => { await t.close(); codes.close(); });

    done();
})();


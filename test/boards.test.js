'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot({ env: { BENCH_ROUNDS_PER_DAY: '100', BENCH_ROUNDS_DAILY: '1000' } });
    const alice = t.network.addUser('alice');
    const entrySvc = t.network.serviceToken({ sub: 'svc:room', audience: 'openvibe.bench', cap: ['bench.entry.create'] });
    const judgeSvc = t.network.serviceToken({ sub: 'svc:judge', audience: 'openvibe.bench', cap: ['bench.judgement.cast'] });

    let roundId;
    let leftId;
    let rightId;

    await check('elo, pareto and cost boards render for a seeded kind', async () => {
        const task = await t.get('/api/v1/kinds/design.page/tasks', { as: alice, json: { prompt: 'A page for a robot.', public: true } });
        const rr = await t.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { as: alice, json: {} });
        roundId = rr.json().round.id;
        const e1 = await t.get(`/api/v1/rounds/${roundId}/entries`, { bearer: entrySvc, json: { provider: 'acme', model: 'alpha-1', payload: { html: '<h1>One</h1>' } } });
        const e2 = await t.get(`/api/v1/rounds/${roundId}/entries`, { bearer: entrySvc, json: { provider: 'beta', model: 'beta-2', payload: { html: '<h1>Two</h1>' } } });
        assert.strictEqual(e1.status, 201, e1.text);
        assert.strictEqual(e2.status, 201, e2.text);
        leftId = e1.json().entry.id;
        rightId = e2.json().entry.id;
        for (const type of ['elo', 'pareto', 'cost']) {
            const r = await t.get(`/api/v1/boards/design.page?type=${type}`);
            assert.strictEqual(r.status, 200, `${type}: ${r.text}`);
            assert.strictEqual(r.json().board.type, type);
            assert.ok(Array.isArray(r.json().board.rows));
        }
    });

    await check('a board marks models with under 10 games as provisional', async () => {
        let board = await t.get('/api/v1/boards/design.page?type=elo');
        const subjects = board.json().board.rows;
        assert.ok(subjects.length >= 2, 'expected at least two subjects');
        for (const row of subjects) assert.strictEqual(row.provisional, true, `${row.subject} should be provisional with ${row.games} games`);
        await t.get(`/api/v1/rounds/${roundId}/judgements`, { bearer: judgeSvc, json: { judge: 'game_outcome', pair: { left: leftId, right: rightId }, outcome: 'left' } });
        board = await t.get('/api/v1/boards/design.page?type=elo');
        const after = board.json().board.rows;
        assert.ok(after.some((row) => row.games === 1 && row.provisional === true), 'one game is still provisional');
    });

    await check('every elo board carries 95% rank intervals from the bootstrap', async () => {
        const board = (await t.get('/api/v1/boards/design.page?type=elo')).json().board;
        assert.ok(board.rows.length >= 2);
        for (const row of board.rows) {
            assert.ok(Number.isInteger(row.rank) && row.rank >= 1 && row.rank <= board.rows.length, `${row.subject} rank`);
            assert.ok(Number.isInteger(row.rank_lo) && row.rank_lo >= 1, `${row.subject} rank_lo`);
            assert.ok(Number.isInteger(row.rank_hi) && row.rank_hi <= board.rows.length, `${row.subject} rank_hi`);
            assert.ok(row.rank_lo <= row.rank_hi, `${row.subject} interval is ordered`);
            assert.ok(row.ci_lower != null && row.ci_upper != null, `${row.subject} rating interval`);
        }
        const exported = (await t.get('/api/v1/datasets/design.page.jsonl')).text.trim().split('\n').map(JSON.parse);
        for (const row of board.rows) {
            const saved = exported.find((entry) => entry.type === 'rating' && entry.category === 'all' && entry.subject === row.subject);
            for (const field of ['elo', 'games', 'ci_lower', 'ci_upper', 'rank', 'rank_lo', 'rank_hi']) {
                assert.strictEqual(saved[field], row[field], `dataset ${row.subject} ${field} matches the board`);
            }
        }
        assert.ok(board.index.rows.every((row) => row.index === null), 'a rating alone is never an Index');
        assert.strictEqual(board.holdout.available, false, 'this kind has no held-out tasks');
        assert.deepStrictEqual(board.holdout.rows, []);
    });

    // A category board: a task class with at least 30 games earns one; 29 does not.
    async function roundForCategory(category) {
        const task = await t.get('/api/v1/kinds/design.page/tasks', { as: alice, json: { prompt: 'A ' + category + ' page.', public: true, task_class: category } });
        const rr = await t.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { as: alice, json: {} });
        const id = rr.json().round.id;
        const a = await t.get(`/api/v1/rounds/${id}/entries`, { bearer: entrySvc, json: { provider: 'acme', model: 'alpha-1', payload: { html: '<h1>a</h1>' } } });
        const b = await t.get(`/api/v1/rounds/${id}/entries`, { bearer: entrySvc, json: { provider: 'beta', model: 'beta-2', payload: { html: '<h1>b</h1>' } } });
        return { roundId: id, left: a.json().entry.id, right: b.json().entry.id };
    }

    async function seedGames(round, count, offset = 0) {
        for (let i = offset; i < offset + count; i++) {
            await t.ctx.s.db.exec(
                `INSERT INTO bench_judgements (id, round_id, kind_id, judge, method, pair, outcome, subject, voter_kind)
                 VALUES ($1, $2, 'design.page', 'human_pairwise', 'human_pairwise', $3::jsonb, $4, $5, 'person')`,
                [t.store.newId('bju'), round.roundId, JSON.stringify({ left: round.left, right: round.right }), i % 2 ? 'left' : 'right', 'usr_seed_' + i],
            );
        }
    }

    await check('shared ratings withhold nineteen games and agree with the fitted board at twenty', async () => {
        const before = await t.get('/api/v1/ratings/design.page');
        assert.strictEqual(before.status, 200, before.text);
        assert.deepStrictEqual(before.json().board.rows, []);
        assert.strictEqual(before.json().board.minimum_samples, 20);
        assert.strictEqual(before.headers.get('access-control-allow-origin'), '*');
        assert.strictEqual(before.headers.get('cache-control'), 'public, max-age=60');
        const round = await roundForCategory('ratings-floor');
        await seedGames(round, 19);
        assert.deepStrictEqual((await t.get('/api/v1/ratings/design.page?category=ratings-floor')).json().board.rows, []);
        await seedGames(round, 1, 19);
        const result = await t.get('/api/v1/ratings/design.page?category=ratings-floor');
        const rows = result.json().board.rows;
        assert.strictEqual(rows.length, 2);
        assert.ok(rows.every((row) => row.games === 20));
        const board = (await t.get('/api/v1/boards/design.page?category=ratings-floor')).json().board;
        for (const row of rows) {
            const fitted = board.rows.find((x) => x.subject === row.subject);
            for (const field of ['elo', 'games', 'ci_lower', 'ci_upper', 'rank', 'rank_lo', 'rank_hi']) assert.strictEqual(row[field], fitted[field], field);
        }
        assert.ok(!result.text.includes('usr_') && !result.text.includes('prompt') && !result.text.includes('html'));
        const all = (await t.get('/api/v1/ratings/design.page')).json().board.rows;
        const model = (await t.get('/api/v1/models/alpha-1')).json();
        assert.deepStrictEqual(model.ratings.find((row) => row.kind_id === 'design.page'), all.find((row) => row.subject === 'alpha-1'));
        assert.strictEqual(model.ratings_minimum_samples, 20);
        assert.strictEqual((await t.get('/api/v1/ratings/chat.willing')).status, 404);
        assert.strictEqual((await t.get('/api/v1/ratings/design.page?category=a&category=b')).status, 400);
        assert.strictEqual((await t.get('/api/v1/ratings/design.page?category=a%20b')).status, 422);
        const options = await t.get('/api/v1/ratings/design.page', { method: 'OPTIONS', headers: { Origin: 'https://example.test', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'traceparent,x-openvibe-request-id,content-type' } });
        assert.strictEqual(options.status, 204);
        const allowed = options.headers.get('access-control-allow-headers').toLowerCase().split(/,\s*/);
        for (const header of ['traceparent', 'x-openvibe-request-id', 'content-type']) assert(allowed.includes(header), header);
        const doc = (await t.get('/openapi.json')).json();
        assert.ok(doc.paths['/api/v1/ratings/{kindId}'].get);
    });

    await check('a category board appears at 30 games and not at 29', async () => {
        const arcade = await roundForCategory('arcade');
        const writing = await roundForCategory('writing');
        await seedGames(writing, 29);
        const selfOnly = await roundForCategory('self-only');
        await seedGames(selfOnly, 30);
        await t.ctx.s.db.exec('UPDATE bench_entries SET model = $1 WHERE id = $2', ['alpha-1', selfOnly.right]);
        let board = (await t.get('/api/v1/boards/design.page?type=elo')).json().board;
        assert.strictEqual(board.categories.length, 0, '29 games is below the floor: ' + JSON.stringify(board.categories));
        await seedGames(arcade, 30);
        board = (await t.get('/api/v1/boards/design.page?type=elo')).json().board;
        const category = board.categories.find((c) => c.category === 'arcade');
        assert.ok(category, 'the 30-game category has a board');
        assert.strictEqual(category.games, 30);
        assert.ok(category.rows.every((row) => row.games > 0), 'only models that played are listed');
        assert.ok(category.rows.every((row) => Number.isInteger(row.rank_lo) && row.rank_lo <= row.rank_hi), 'the category board has rank intervals');
        assert.strictEqual(board.categories.find((c) => c.category === 'writing'), undefined, '29 games is still out');
        // The filtered board answers for one category alone.
        const one = (await t.get('/api/v1/boards/design.page?category=arcade')).json().board;
        assert.strictEqual(one.category, 'arcade');
        assert.strictEqual(one.rows.reduce((n, row) => n + row.games, 0), 60, '30 games are 60 model-games');
    });

    await check('the OpenVibe Index needs two components and publishes its weights', async () => {
        const definition = {
            title: 'Design pages', description: 'The B3 index fixture.', kind: 'design.page', tags: [], visibility: 'public',
            tasks: [
                { id: 't1', prompt: 'A public page.', files: [], expected: null, holdout: false },
                { id: 't2', prompt: 'A held-out page.', files: [], expected: null, holdout: true },
            ],
            judges: [{ type: 'human_pairwise', version: '1.0', config: {} }],
            scoring: { method: 'mean', scale: { min: 0, max: 100 } },
            limits: { ms: 10000, tokens: 10000, usd: 1 },
            matrix: { models: ['alpha-1'], harnesses: ['fixture'] },
        };
        const writer = t.network.serviceToken({ sub: 'svc:fixture', audience: 'openvibe.bench', cap: ['bench.benchmark.write', 'bench.run.publish'] });
        const created = await t.get('/api/v1/benchmarks', { bearer: writer, json: definition });
        assert.strictEqual(created.status, 201, created.text);
        const benchmarkId = created.json().benchmark.id;
        const frozen = await t.get(`/api/v1/benchmarks/${benchmarkId}/versions`, { bearer: writer, json: {} });
        assert.strictEqual(frozen.status, 201, frozen.text);
        const run = await t.get('/api/v1/runs', {
            bearer: writer,
            json: {
                benchmark: `${benchmarkId}@1`, model: 'alpha-1', route: { provider: 'acme' }, provider: 'acme',
                harness: { name: 'fixture', version: '1' }, settings: {}, executor: { kind: 'codes', id: 'fixture' },
                tasks: [
                    { task_id: 't1', score: 90, cost_usd: 0.01, ms: 100, tokens: 10, artifacts: [] },
                    { task_id: 't2', score: 60, cost_usd: 0.01, ms: 100, tokens: 10, artifacts: [] },
                ],
                score: 75, cost_usd: 0.02, ms: 200, tokens: 20,
            },
        });
        assert.strictEqual(run.status, 201, run.text);

        const board = (await t.get('/api/v1/boards/design.page?type=elo')).json().board;
        assert.deepStrictEqual(board.index.weights, { rating: 0.5, benchmarks: 0.5 });
        assert.strictEqual(board.index.benchmark_count, 1);
        assert.strictEqual(board.index.benchmarks[0].weight, 0.5);
        const alpha = board.index.rows.find((row) => row.subject === 'alpha-1');
        const beta = board.index.rows.find((row) => row.subject === 'beta-2');
        assert.ok(alpha, 'the rated model is in the index');
        assert.strictEqual(alpha.n_components, 2, 'rating + one benchmark: ' + JSON.stringify(alpha.components));
        assert.ok(typeof alpha.index === 'number' && alpha.index >= 0 && alpha.index <= 100, 'the index is 0-100');
        assert.ok(alpha.components.some((c) => c.kind === 'rating') && alpha.components.some((c) => c.kind === 'benchmark'), 'both kinds of component are named');
        assert.strictEqual(beta.index, null, 'a single component is never an index');
        assert.strictEqual(beta.n_components, 1);

        assert.strictEqual(board.holdout.available, true);
        const gap = board.holdout.rows.find((row) => row.subject === 'alpha-1');
        assert.deepStrictEqual(gap, { subject: 'alpha-1', public_n: 1, public_score: 90, holdout_n: 1, holdout_score: 60, gap: 30 });

        const dataset = (await t.get('/api/v1/datasets/design.page.jsonl')).text.trim().split('\n').map((line) => JSON.parse(line));
        assert.ok(dataset.some((line) => line.type === 'index' && line.weights.rating === 0.5), 'the dataset carries the index');
        assert.ok(dataset.some((line) => line.type === 'holdout' && line.rows.some((row) => row.gap === 30)), 'the dataset carries the holdout gap');
        assert.ok(dataset.some((line) => line.type === 'category' && line.category === 'arcade'), 'the dataset carries the category board');
        assert.ok(dataset.some((line) => line.type === 'rating' && line.rank_lo !== null), 'the dataset carries the rank interval');
    });


    await check('a model page aggregates across kinds', async () => {
        const task = await t.get('/api/v1/kinds/games.match/tasks', { as: alice, json: { prompt: 'A match.', public: true } });
        const rr = await t.get(`/api/v1/tasks/${task.json().task.id}/rounds`, { as: alice, json: {} });
        const rid = rr.json().round.id;
        await t.get(`/api/v1/rounds/${rid}/entries`, { bearer: entrySvc, json: { provider: 'acme', model: 'alpha-1', payload: { result: { winner: 'left' } } } });
        await t.get(`/api/v1/rounds/${rid}/entries`, { bearer: entrySvc, json: { provider: 'beta', model: 'beta-2', payload: { result: { winner: 'right' } } } });
        const r = await t.get('/api/v1/models/alpha-1');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().model, 'alpha-1');
        assert.ok(Array.isArray(r.json().entries));
        assert.ok(r.json().entries.some((e) => e.kind_id === 'design.page'));
        assert.ok(r.json().entries.some((e) => e.kind_id === 'games.match'));
        assert.ok(Array.isArray(r.json().ratings));
    });

    await check('the open dataset has no voter id or person id', async () => {
        const r = await t.get('/api/v1/datasets/design.page.jsonl');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.text.includes('usr_'), false, 'dataset contains a person id');
        for (const line of r.text.trim().split('\n').map((l) => JSON.parse(l))) {
            assert.strictEqual(line.created_by, undefined, 'task or round leaked a person id');
            if (line.type === 'judgement') assert.strictEqual(line.subject, undefined, 'judgement leaked a voter id');
        }
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

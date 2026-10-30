'use strict';

/**
 * The results pages (stage B2) and the rules they rest on.
 *
 * Under test: every page renders from the registry's own data (benchmarks, a benchmark with its rankings and value
 * chart, a run, compare, a model); dynamic text is escaped; an unlisted benchmark is reachable by its id but listed
 * to nobody but its owner, and its runs stay off a model's page; the rankings'
 * `since` and `harness` filters work on their own; the value chart marks the frontier and only the frontier.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const results = require('../server/views/results');

const TASKS = [
    { id: 't1', prompt: 'Build a one-screen arcade game with a paddle, bricks, a ball and a score.', files: [], expected: null, holdout: false },
    { id: 't2', prompt: 'A held-out snake game.', files: [], expected: null, holdout: true },
];

function definition(over = {}) {
    return {
        title: 'Pages test arena',
        description: 'A benchmark for the page tests.',
        kind: 'games.play',
        tags: ['games'],
        visibility: 'public',
        tasks: TASKS,
        judges: [{ type: 'game_outcome', version: '1.0', config: {} }],
        scoring: { method: 'mean', scale: { min: 0, max: 100 } },
        limits: { ms: 120000, tokens: 200000, usd: 0.5 },
        matrix: { models: ['model-a'], harnesses: ['claude-code'] },
        ...over,
    };
}

function runDoc(benchmark, over = {}) {
    return {
        benchmark,
        model: 'model-a',
        route: { provider: 'acme' },
        provider: 'acme',
        harness: { name: 'claude-code', version: '3.1.0' },
        settings: { temperature: 1, effort: 'high' },
        executor: { kind: 'codes', id: 'tsk_pages' },
        tasks: [
            { task_id: 't1', score: 80, cost_usd: 0.01, ms: 30000, tokens: 5000, artifacts: [{ kind: 'html', url: 'https://bench-render.openvibe.services/render/w/ent_pages' }] },
            { task_id: 't2', score: 60, cost_usd: 0.01, ms: 30000, tokens: 5000, artifacts: [] },
        ],
        score: 70,
        cost_usd: 0.02,
        ms: 60000,
        tokens: 10000,
        ...over,
    };
}

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const publisher = t.network.serviceToken({ sub: 'svc:codes', audience: 'openvibe.bench', cap: ['bench.run.publish', 'bench.benchmark.write'] });

    const create = async (over, as) => {
        const res = await t.get('/api/v1/benchmarks', as ? { as, json: definition(over) } : { bearer: publisher, json: definition(over) });
        assert.strictEqual(res.status, 201, res.text);
        const id = res.json().benchmark.id;
        const frozen = await t.get(`/api/v1/benchmarks/${id}/versions`, as ? { as, json: {} } : { bearer: publisher, json: {} });
        assert.strictEqual(frozen.status, 201, frozen.text);
        return { id, version: frozen.json().version.version };
    };
    const publish = async (ref, over) => {
        const res = await t.get('/api/v1/runs', { bearer: publisher, json: runDoc(ref, over) });
        assert.strictEqual(res.status, 201, res.text);
        return res.json().run.id;
    };

    const pub = await create({ title: 'Pages <script>alert(1)</script> arena' });
    const cheap = await publish(`${pub.id}@${pub.version}`, { model: 'model-cheap', score: 60, cost_usd: 0.002 });
    const best = await publish(`${pub.id}@${pub.version}`, { model: 'model-best', score: 90, cost_usd: 0.05 });
    await publish(`${pub.id}@${pub.version}`, { model: 'model-worse', score: 55, cost_usd: 0.04, harness: { name: 'opencode', version: '1.4.2' } });
    const priv = await create({ title: 'Alice unlisted prompts', visibility: 'unlisted' }, alice);
    await publish(`${priv.id}@${priv.version}`, { model: 'model-best', score: 12, cost_usd: 0.01 });
    const privatePage = await create({ title: 'Alice private prompts', visibility: 'private', tags: ['your-prompts'] }, alice);
    await publish(`${privatePage.id}@${privatePage.version}`, { model: 'model-best', score: 77, cost_usd: 0.01 });

    await check('the benchmarks page lists the public benchmarks and escapes their titles', async () => {
        const res = await t.get('/benchmarks');
        assert.strictEqual(res.status, 200, res.text.slice(0, 300));
        assert.ok(res.text.includes('Pages &lt;script&gt;alert(1)&lt;/script&gt; arena'), 'the title is escaped');
        assert.ok(!res.text.includes('<script>alert(1)</script>'), 'never raw');
        assert.ok(!res.text.includes('Alice unlisted prompts'), 'an unlisted benchmark is not listed');
    });

    await check('a benchmark page shows its rankings, its value chart and its runs', async () => {
        const res = await t.get(`/benchmarks/${pub.id}`);
        assert.strictEqual(res.status, 200, res.text.slice(0, 300));
        assert.ok(res.text.includes('id="br-rank"'), 'the rankings section');
        assert.ok(res.text.includes('class="br-chart"'), 'the value chart');
        for (const m of ['model-best', 'model-cheap', 'model-worse']) assert.ok(res.text.includes(m), `${m} is ranked`);
        assert.ok(res.text.includes('Held out'), 'the holdout task is counted, its prompt is not shown');
        assert.ok(!res.text.includes('A held-out snake game.'), 'the holdout prompt never reaches the page');
        const value = await t.get(`/benchmarks/${pub.id}?metric=value`);
        assert.ok(value.text.includes('aria-current="page"') && value.text.includes('/ $'), 'the value tab is current and shows score per dollar');
    });

    await check('the phone sections are chips, one per section, with Rankings picked first', async () => {
        const res = await t.get(`/benchmarks/${pub.id}`);
        const chips = [...res.text.matchAll(/<input type="radio" name="br-view" id="br-view-([a-z]+)" value="[a-z]+"( checked)?>/g)];
        assert.deepStrictEqual(chips.map((m) => m[1]), ['rank', 'tasks', 'runs'], 'one chip per section, in order');
        assert.deepStrictEqual(chips.filter((m) => m[2]).map((m) => m[1]), ['rank'], 'Rankings is picked first');
        assert.match(res.text, /<div class="br-sections">[\s\S]*id="br-rank"[\s\S]*id="br-tasks"[\s\S]*id="br-runs"[\s\S]*<\/div>/, 'every section stays in the page');
        const css = await t.get('/css/bench.css');
        assert.ok(css.text.includes('@supports selector(:has(*))'), 'the chips are gated on :has()');
        assert.ok(css.text.includes('.br-sections:has(#br-view-rank:checked) #br-rank'), 'Rankings shows when picked');
        assert.ok(css.text.includes('.br-sections:has(#br-view-tasks:checked) #br-tasks'), 'Tasks shows when picked');
        assert.ok(css.text.includes('.br-sections:has(#br-view-runs:checked) #br-runs'), 'Runs shows when picked');
    });

    await check('badges and embeds are one closed details on a public page, and absent on a private one', async () => {
        const pubPage = await t.get(`/benchmarks/${pub.id}`);
        assert.ok(pubPage.text.includes('<details class="br-usethis-details">'), 'one details');
        assert.ok(!pubPage.text.includes('<details class="br-usethis-details" open'), 'closed by default');
        assert.ok(pubPage.text.includes('Badges and embeds'), 'the summary');
        assert.ok(pubPage.text.includes('model-best'), 'the models are inside');
        const mine = await t.get(`/benchmarks/${privatePage.id}`, { as: alice });
        assert.strictEqual(mine.status, 200, mine.text.slice(0, 200));
        assert.ok(!mine.text.includes('Badges and embeds'), 'no badge section on a private benchmark');
        assert.ok(!mine.text.includes('br-usethis'), 'no use-this markup at all');
        const badge = await t.get(`/badge/${privatePage.id}/model-best.svg`);
        assert.strictEqual(badge.status, 404, badge.text.slice(0, 200));
        assert.ok(badge.text.includes('private benchmark'), 'the badge says why');
    });

    await check('a run page shows the environment, the score, the provenance and the outputs', async () => {
        const res = await t.get(`/runs/${best}`);
        assert.strictEqual(res.status, 200, res.text.slice(0, 300));
        assert.ok(res.text.includes('model-best'));
        assert.ok(res.text.includes('Verified'), 'the provenance badge');
        assert.ok(res.text.includes('claude-code 3.1.0'), 'the harness and its version');
        assert.ok(res.text.includes('src="https://bench-render.openvibe.services/render/w/ent_pages"'), 'an output from the render origin is framed');
        assert.ok(res.text.includes('sandbox="'), 'and sandboxed');
        assert.ok(res.text.includes('A held-out task'), 'a holdout task keeps its prompt hidden on the run page too');
        assert.strictEqual((await t.get('/runs/brn_nope')).status, 404);
    });

    await check('compare puts runs side by side and marks the best in each row', async () => {
        const res = await t.get(`/compare?runs=${best},${cheap}`);
        assert.strictEqual(res.status, 200, res.text.slice(0, 300));
        assert.ok(res.text.includes('model-best vs model-cheap'));
        assert.ok(res.text.includes('is-best'), 'a best value is marked');
        assert.strictEqual((await t.get('/compare')).status, 200, 'an empty compare explains itself');
    });

    await check('a model page shows the public benchmarks only', async () => {
        const res = await t.get('/models/model-best');
        assert.strictEqual(res.status, 200, res.text.slice(0, 300));
        assert.ok(res.text.includes('Pages &lt;script&gt;'), 'its public benchmark');
        assert.ok(!res.text.includes('Alice unlisted prompts'), 'never an unlisted benchmark, not even its title');
        assert.strictEqual((await t.get('/models/nobody-ran-this')).status, 404);
    });

    await check('an unlisted benchmark is reachable by its id and listed to nobody but its owner', async () => {
        assert.strictEqual((await t.get(`/api/v1/benchmarks/${priv.id}`)).status, 200, 'reachable by id');
        const page = await t.get(`/benchmarks/${priv.id}`);
        assert.strictEqual(page.status, 200, 'its page too');
        assert.ok(page.text.includes('noindex'), 'but kept out of search engines');
        const list = await t.get('/api/v1/benchmarks');
        assert.ok(!list.json().benchmarks.some((b) => b.id === priv.id), 'never in the public list');
        const mine = await t.get('/api/v1/benchmarks?mine=1', { as: alice });
        assert.ok(mine.json().benchmarks.some((b) => b.id === priv.id), 'the owner lists it with ?mine=1');
        const theirs = await t.get('/api/v1/benchmarks?mine=1', { as: bob });
        assert.ok(!theirs.json().benchmarks.some((b) => b.id === priv.id), 'nobody else does');
    });

    await check('the rankings filter by since alone and by harness name', async () => {
        const since = await t.get(`/api/v1/rankings?benchmark=${pub.id}&metric=score&since=2000-01-01T00:00:00Z`);
        assert.strictEqual(since.status, 200, since.text);
        assert.strictEqual(since.json().rankings.entries.length, 3, '`since` without `harness` is its own placeholder');
        const harness = await t.get(`/api/v1/rankings?benchmark=${pub.id}&metric=score&harness=opencode`);
        assert.strictEqual(harness.status, 200, harness.text);
        assert.deepStrictEqual(harness.json().rankings.entries.map((e) => e.model), ['model-worse'], 'the harness name matches');
    });

    await check('the value chart marks the frontier and only the frontier', () => {
        const svg = String(results.valueChart([
            { model: 'cheap', score: 60, cost_usd: 0.002 },
            { model: 'best', score: 90, cost_usd: 0.05 },
            { model: 'dominated', score: 55, cost_usd: 0.04 },
        ]));
        const front = [...svg.matchAll(/<g class="br-dot( is-front)?">.*?<text[^>]*>([^<]+)<\/text>/g)].map((m) => [m[2], Boolean(m[1])]);
        const by = Object.fromEntries(front);
        assert.strictEqual(by.cheap, true);
        assert.strictEqual(by.best, true);
        assert.strictEqual(by.dominated, false, 'a model both dearer and worse than another is off the frontier');
        assert.ok(String(results.valueChart([])).includes('fills in with the first verified runs'), 'the empty chart says so');
    });

    await check('the render origin asks Cloudflare not to rewrite its frames', async () => {
        const res = await t.get('/render/w/ent_nope');
        assert.match(String(res.headers.get('cache-control')), /no-transform/);
    });

    await check('the showcase page names itself: its canonical URL and its navbar link', async () => {
        const res = await t.get('/showcase');
        assert.strictEqual(res.status, 200, res.text.slice(0, 300));
        assert.match(res.text, /rel="canonical" href="https:\/\/bench\.openvibe\.services\/showcase"/, 'canonical is the showcase, not the home');
        const nav = JSON.parse(res.text.match(/window\.__OV_PAGE = (\{.*?\});/)[1]);
        const active = nav.navbar.links.filter((l) => l.active).map((l) => l.label);
        assert.deepStrictEqual(active, ['Showcase'], 'only Showcase is current');
    });

    await check('stop', async () => { await t.close(); });
    done();
})();

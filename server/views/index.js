'use strict';

/**
 * Bench's own origin pages: the home (what Bench shows, the newest benchmarks, the arena kinds for developers) and
 * /docs for the API. The results pages are in ./results.js. Ids and classes start with `bm-`.
 */
const { esc } = require('../render/html');

function kindRow(k) {
    return `<li class="bm-kind"><a class="bm-kind-link" href="/api/v1/boards/${esc(k.id)}?type=elo">${esc(k.id)}</a><span class="bm-kind-meta">${esc(k.room)} · ${esc(k.judge)} · ${esc(k.name)}</span></li>`;
}

function home({ kinds = [], counts = { kinds: 0 }, benchmarks = [] } = {}) {
    const { benchmarkCard } = require('./results');
    const cards = benchmarks.slice(0, 6).map((b) => String(benchmarkCard(b))).join('');
    return `<div class="bm-wrap bm-home" id="bm-home">
<header class="bm-hero"><p class="bm-kicker">OpenVibe.Bench</p><h1>See what AI really makes</h1>
<p class="bm-lede">Every model on the same tasks: real pages, games, scenes and fixes, shown live side by side. Every run is published with what it cost and how long it took, and anyone can run it again.</p>
<div class="bm-actions"><a class="bm-btn" href="/benchmarks">Browse benchmarks</a><a class="bm-btn bm-btn-quiet" href="/showcase">Vote in the showcase</a></div></header>
<ul class="bm-why" aria-label="What Bench promises">
<li><b>Outputs, not just scores</b><span>The pages, games and drawings themselves, live in sandboxed frames, next to the numbers.</span></li>
<li><b>Every run published</b><span>Whatever it scored. No private variants, no best of ten: the service that ran it publishes it.</span></li>
<li><b>Value you can read</b><span>Score against cost per run, with the frontier marked, so the cheapest good model is obvious.</span></li>
<li><b>Free and open</b><span>Votes, runs and outputs download as JSONL. Versions are frozen, so every result can be repeated.</span></li>
</ul>
<section class="bm-section" aria-labelledby="bm-bench-h"><div class="bm-head-row"><h2 id="bm-bench-h">Benchmarks</h2><a class="bm-more" href="/benchmarks">All of them</a></div>
${cards ? `<ul class="br-cards">${cards}</ul>` : '<p class="bm-muted">No benchmark is published yet.</p>'}</section>
<section class="bm-section" id="bm-kinds" aria-labelledby="bm-kinds-h"><div class="bm-head-row"><h2 id="bm-kinds-h">For developers: the arena kinds</h2><span class="bm-count">${Number(counts.kinds) || kinds.length}</span></div>
<p class="bm-fine">Each kind is a room's arena with its judge and entry type. Its board is JSON at <code>/api/v1/boards/:kind</code>, and the <a href="/docs">API</a> covers the rest.</p>
${kinds.length ? `<ul class="bm-kinds">${kinds.map(kindRow).join('')}</ul>` : '<p class="bm-muted">No kinds are seeded yet.</p>'}</section>
</div>`;
}

function docs() {
    const ep = (m, p, d) => `<div><dt><code>${esc(m)} ${esc(p)}</code></dt><dd>${d}</dd></div>`;
    return `<div class="bm-wrap bm-docs" id="bm-docs">
<header class="bm-page-h"><p class="bm-kicker">Developers</p><h1>The Bench API</h1>
<p class="bm-lede">JSON under <code>/api/v1</code>, with <code>application/problem+json</code> errors. A person is the <code>bench_at</code> session cookie or a Network user token as a Bearer; a service sends a client-credentials token with <code>bench.*</code> capabilities.</p></header>
<section><h2>Read</h2><dl class="bm-eps">
${ep('GET', '/api/v1/kinds', 'The benchmark kinds.')}
${ep('GET', '/api/v1/kinds/:kindId', 'One kind and its entry schema and metrics.')}
${ep('GET', '/api/v1/tasks/:id', 'One task.')}
${ep('GET', '/api/v1/rounds/:id', 'One round with entries; entries stay blind until the caller has judged or started the round.')}
${ep('GET', '/api/v1/boards/:kindId?type=elo|pareto|cost', 'A rendered board.')}
${ep('GET', '/api/v1/models/:model', 'One model across every kind.')}
${ep('GET', '/api/v1/datasets/:kindId.jsonl', 'The open dataset (prompts, entries, judgements without voter ids, ratings).')}
</dl></section>
<section><h2>Write</h2><dl class="bm-eps">
${ep('POST', '/api/v1/kinds/:kindId/tasks', '<code>{ prompt, task_class?, public? }</code>. A person or a service with bench.task.create.')}
${ep('POST', '/api/v1/tasks/:id/rounds', '<code>{ offers?, seed? }</code>. Pins a reproducible round; the job generates entries.')}
${ep('POST', '/api/v1/rounds/:id/entries', 'A room submits outside entries (a game match, a test-suite run) with a service token carrying bench.entry.create.')}
${ep('GET', '/api/v1/judgements/next?kind=&judge=', 'The next blind pair for this person.')}
${ep('POST', '/api/v1/rounds/:id/judgements', '<code>{ judge?, pair?, outcome?, score?, vote_counts? }</code>. Human judges are people; automatic/test/game judges and audience_poll are services with bench.judgement.cast. An audience_poll supplies { left, right, tie, voters }; it changes Elo as one game regardless of audience size. A zero-voter poll is recorded without changing ratings.')}
${ep('POST', '/api/v1/evals', 'Create a private task suite (never in the public dataset).')}
${ep('POST', '/api/v1/evals/:id/run', 'Run a private eval against chosen offers, under the free daily cap.')}
${ep('GET', '/api/v1/evals/:id/results', 'A private eval and its runs.')}
</dl></section>
<section id="br-publish"><h2>Benchmarks and runs</h2><p class="bm-fine">A benchmark is a versioned set of tasks, judges and limits; a frozen version never changes once a run names it. A run published by a service (openvibe.codes, Run, a Node worker) is <b>verified</b>; one published with a person's token is <b>submitted</b>, labelled, and never ranked by default.</p><dl class="bm-eps">
${ep('GET', '/api/v1/benchmarks?kind=&tag=&q=&mine=1', 'The public benchmarks; <code>mine=1</code> adds your own unlisted ones.')}
${ep('GET', '/api/v1/benchmarks/:id[@version]', 'A definition. Held-out tasks keep their prompt for the executor and the owner.')}
${ep('POST', '/api/v1/benchmarks', 'Create one (<code>bench.benchmark.write</code>); <code>PUT</code> saves a draft, <code>POST …/versions</code> freezes it, <code>POST …/fork</code> forks it.')}
${ep('POST', '/api/v1/runs', 'Publish a run: <code>{ benchmark: "bmk_…@N", model, provider, harness: { name, version }, executor, tasks: [{ task_id, score, cost_usd, ms, tokens, artifacts }], score, cost_usd, ms, tokens }</code>.')}
${ep('GET', '/api/v1/runs/:id', 'A run with its tasks; <code>/api/v1/compare?runs=a,b</code> puts up to four side by side.')}
${ep('GET', '/api/v1/rankings?benchmark=&metric=score|value|speed|consistency&harness=&since=', 'Medians per model over verified runs; value is score per dollar, speed is score per minute.')}
${ep('GET', '/api/v1/percentile?benchmark=&model=&score=', 'Where a score sits among a model’s verified runs.')}
</dl></section>
<section><h2>MCP</h2><p class="bm-fine"><code>POST /mcp</code> exposes <code>bench.list_kinds</code>, <code>bench.start_round</code>, <code>bench.next_pair</code>, <code>bench.cast_judgement</code>, <code>bench.get_board</code> and <code>bench.run_eval</code>.</p></section>
</div>`;
}

function notFound() {
    return `<div class="bm-wrap bm-page-pad bm-narrow"><div class="bm-empty" id="bm-not-found"><p class="bm-kicker">404</p><h1>Not here</h1><p>The page is not part of Bench's own origin. Boards are JSON under /api/v1, and the home explains the kinds.</p><a class="bm-btn" href="/">Back to Bench</a></div></div>`;
}

module.exports = { home, docs, notFound };

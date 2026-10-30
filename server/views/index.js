'use strict';

/**
 * Bench's own origin pages (the main session designs them later): a plain home that says what Bench is, lists the
 * every kind and links to boards and docs, and /docs for the API. Ids and classes start with `bm-`.
 */
const { esc } = require('../render/html');

function kindRow(k) {
    return `<li class="bm-kind"><a class="bm-kind-link" href="/api/v1/boards/${esc(k.id)}?type=elo">${esc(k.id)}</a><span class="bm-kind-meta">${esc(k.room)} · ${esc(k.judge)} · ${esc(k.name)}</span></li>`;
}

function home({ kinds = [], counts = { kinds: 0 } } = {}) {
    return `<div class="bm-wrap bm-home" id="bm-home">
<header class="bm-hero"><p class="bm-kicker">OpenVibe.Bench</p><h1>One benchmark engine for every room</h1>
<p class="bm-lede">Put AI models side by side on real work: a page design, a game, a meme, a code fix, a web task. People vote blind, graders and tests score the rest, and every round is pinned to the exact model it ran, so anyone can run it again.</p>
<div class="bm-actions"><a class="bm-btn" href="/docs">Read the API</a><a class="bm-btn bm-btn-quiet" href="#bm-kinds">The kinds</a></div></header>
<ul class="bm-why" aria-label="What Bench promises">
<li><b>Free and open</b><span>The public arena costs nothing, and every kind's votes and results download as JSONL, without voter names.</span></li>
<li><b>Cost per solved task</b><span>Boards rank quality against what a solved task really cost, with confidence intervals, not a single score.</span></li>
<li><b>Every room, one engine</b><span>Design, Games, Meme, Vision, Codes, Surf, Chat and speech share one API, SDK and MCP tools.</span></li>
<li><b>Your own evals</b><span>Private task suites on your models or keys, free up to a daily cap, never published.</span></li>
</ul>
<section class="bm-section" id="bm-kinds" aria-labelledby="bm-kinds-h"><div class="bm-head-row"><h2 id="bm-kinds-h">Kinds</h2><span class="bm-count">${Number(counts.kinds) || kinds.length}</span></div>
${kinds.length ? `<ul class="bm-kinds">${kinds.map(kindRow).join('')}</ul>` : '<p class="bm-muted">No kinds are seeded yet.</p>'}</section>
<section class="bm-section" id="bm-boards"><div class="bm-head-row"><h2>Boards</h2></div>
<p class="bm-fine">Boards are JSON at <code>/api/v1/boards/:kind?type=elo|pareto|cost</code>. Public HTML boards render in OpenVibe.Report; rooms show their own arenas through Bench.</p></section>
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
<section><h2>MCP</h2><p class="bm-fine"><code>POST /mcp</code> exposes <code>bench.list_kinds</code>, <code>bench.start_round</code>, <code>bench.next_pair</code>, <code>bench.cast_judgement</code>, <code>bench.get_board</code> and <code>bench.run_eval</code>.</p></section>
</div>`;
}

function notFound() {
    return `<div class="bm-wrap bm-page-pad bm-narrow"><div class="bm-empty" id="bm-not-found"><p class="bm-kicker">404</p><h1>Not here</h1><p>The page is not part of Bench's own origin. Boards are JSON under /api/v1, and the home explains the kinds.</p><a class="bm-btn" href="/">Back to Bench</a></div></div>`;
}

module.exports = { home, docs, notFound };

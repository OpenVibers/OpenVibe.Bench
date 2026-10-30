'use strict';

/**
 * The results pages (stage B2): the benchmark list, a benchmark with its rankings and value chart, a run (Geekbench
 * style: the environment, the score, where it sits, each task and its outputs), compare, and a model across
 * benchmarks. Server-rendered and complete without JavaScript. Everything dynamic goes through html`` (escaped).
 * Ids and classes start with `br-`.
 */
const { html, raw, render } = require('../render/html');
const renderLib = require('../bench/render');

const MEDIA_ORIGIN = 'https://openvibe.media';

// ---- numbers -------------------------------------------------------------------------------------------------

const fmtScore = (v) => (v == null ? '—' : (Math.round(Number(v) * 10) / 10).toFixed(1).replace(/\.0$/, ''));
function fmtUsd(v) {
    if (v == null) return '—';
    const n = Number(v);
    if (n === 0) return '$0';
    if (n < 0.01) return `$${n.toPrecision(2)}`;
    return `$${n.toFixed(2)}`;
}
function fmtMs(v) {
    if (v == null) return '—';
    const s = Number(v) / 1000;
    if (s < 1) return `${Math.round(Number(v))} ms`;
    if (s < 90) return `${Math.round(s * 10) / 10} s`;
    return `${Math.round(s / 6) / 10} min`;
}
function fmtTokens(v) {
    if (v == null) return '—';
    const n = Number(v);
    if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
    if (n >= 1e3) return `${Math.round(n / 100) / 10}K`;
    return String(n);
}
const fmtDate = (iso) => (iso ? html`<time datetime="${iso}">${String(iso).slice(0, 10)}</time>` : '—');
function ordinal(n) {
    const v = Math.round(Number(n));
    const t = v % 100;
    if (t >= 11 && t <= 13) return `${v}th`;
    return `${v}${({ 1: 'st', 2: 'nd', 3: 'rd' })[v % 10] || 'th'}`;
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- links ---------------------------------------------------------------------------------------------------

const benchmarkHref = (id) => `/benchmarks/${encodeURIComponent(id)}`;
const runHref = (id) => `/runs/${encodeURIComponent(id)}`;
const modelHref = (m) => `/models/${encodeURIComponent(m)}`;
const compareHref = (ids) => `/compare?runs=${ids.map(encodeURIComponent).join(',')}`;

// ---- small pieces --------------------------------------------------------------------------------------------

const kindChip = (kind) => (kind ? html`<span class="br-chip br-mono">${kind}</span>` : '');

function provenance(p) {
    return p === 'verified'
        ? html`<span class="br-prov is-verified" title="Run by openvibe.codes, Run or a Node worker, and published by that service">Verified</span>`
        : html`<span class="br-prov is-submitted" title="Published by a person; nobody re-ran it">Submitted</span>`;
}

/** A score out of 100 with a thin bar under it. */
function scoreBar(score, { big = false } = {}) {
    const pct = score == null ? 0 : Math.max(0, Math.min(100, Number(score)));
    return html`<span class="br-score${big ? ' is-big' : ''}"><span class="br-score-n">${fmtScore(score)}</span><span class="br-score-of">/100</span><span class="br-bar" aria-hidden="true"><span style="width:${pct.toFixed(1)}%"></span></span></span>`;
}

function empty(title, text, action = '') {
    return html`<div class="br-empty"><p class="br-empty-t">${title}</p><p>${text}</p>${action}</div>`;
}

function harnessLabel(h) {
    if (!h || !h.name) return '—';
    return h.version ? `${h.name} ${h.version}` : h.name;
}

// ---- the value chart -----------------------------------------------------------------------------------------

/**
 * Score against cost per run, one dot per model, cost on a log scale. The frontier joins the models nobody beats on
 * both at once (no other model is cheaper and better). Drawn as SVG on the server; the table under it carries the
 * same numbers for screen readers.
 */
function valueChart(entries) {
    const W = 880; const H = 320; const L = 44; const R = 16; const T = 14; const B = 40;
    const pts = entries.filter((e) => e.score != null && e.cost_usd != null && e.cost_usd > 0);
    const grid = [0, 25, 50, 75, 100].map((y) => {
        const py = T + (H - T - B) * (1 - y / 100);
        return html`<line class="br-grid" x1="${L}" x2="${W - R}" y1="${py}" y2="${py}"/><text class="br-axis" x="${L - 8}" y="${py + 4}" text-anchor="end">${y}</text>`;
    });
    if (!pts.length) {
        return html`<figure class="br-chart" aria-label="Score against cost: no verified runs yet"><svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">${grid}<text class="br-axis" x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle">Cost per run (log scale)</text><text class="br-chart-empty" x="${(L + W - R) / 2}" y="${(T + H - B) / 2}" text-anchor="middle">The chart fills in with the first verified runs</text></svg></figure>`;
    }
    const costs = pts.map((p) => Math.log10(p.cost_usd));
    let lo = Math.floor(Math.min(...costs)); let hi = Math.ceil(Math.max(...costs));
    if (hi === lo) { lo -= 1; hi += 1; }
    const x = (c) => L + (W - L - R) * ((Math.log10(c) - lo) / (hi - lo));
    const y = (s) => T + (H - T - B) * (1 - s / 100);
    const ticks = [];
    for (let e = lo; e <= hi; e++) {
        const px = L + (W - L - R) * ((e - lo) / (hi - lo));
        ticks.push(html`<text class="br-axis" x="${px}" y="${H - B + 18}" text-anchor="middle">${fmtUsd(10 ** e)}</text>`);
    }
    // The frontier: walk from the cheapest up, keeping each model that scores higher than every cheaper one.
    const sorted = [...pts].sort((a, b) => a.cost_usd - b.cost_usd || b.score - a.score);
    const frontier = [];
    let best = -Infinity;
    for (const p of sorted) if (p.score > best) { frontier.push(p); best = p.score; }
    const onFrontier = new Set(frontier.map((p) => p.model));
    let path = '';
    frontier.forEach((p, i) => {
        const px = x(p.cost_usd).toFixed(1); const py = y(p.score).toFixed(1);
        if (i === 0) path += `M${px} ${py}`;
        else path += ` H${px} V${py}`;
    });
    // Labels sit beside their dot; one that would overlap a label already placed moves down (or up) by a line.
    const placed = [];
    const labelY = (px, py, anchor) => {
        const w = 7 * 22; const x0 = anchor === 'end' ? px - w : px; let ly = py + 4;
        for (let tries = 0; tries < 6; tries++) {
            const hit = placed.find((b) => Math.abs(b.y - ly) < 13 && x0 < b.x0 + b.w && b.x0 < x0 + w);
            if (!hit) break;
            ly = hit.y + (ly >= hit.y ? 13 : -13);
        }
        placed.push({ x0, w, y: ly });
        return ly;
    };
    const dots = [...pts].sort((a, b) => b.score - a.score).map((p) => {
        const px = x(p.cost_usd); const py = y(p.score);
        const anchor = px > W - 180 ? 'end' : 'start';
        const dx = anchor === 'end' ? -9 : 9;
        const ly = labelY(px + dx, py, anchor);
        return html`<g class="br-dot${onFrontier.has(p.model) ? ' is-front' : ''}"><circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="5"><title>${p.model}: ${fmtScore(p.score)} for ${fmtUsd(p.cost_usd)} a run</title></circle><text x="${(px + dx).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}">${p.model}</text></g>`;
    });
    return html`<figure class="br-chart" aria-label="Score against cost per run; the line is the frontier"><svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">${grid}${ticks}<text class="br-axis" x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">Cost per run (log scale)</text>${path ? raw(`<path class="br-front" d="${path}"/>`) : ''}${dots}</svg><figcaption>Up is better, left is cheaper. The line joins the models no other model beats on both.</figcaption></figure>`;
}

// ---- the rankings table --------------------------------------------------------------------------------------

const METRICS = [
    { id: 'score', label: 'Score' },
    { id: 'value', label: 'Value', hint: 'score per dollar' },
    { id: 'speed', label: 'Speed', hint: 'score per minute' },
    { id: 'consistency', label: 'Steadiness', hint: 'spread inside a session, lower is steadier' },
];

function metricTabs(base, current) {
    return html`<nav class="br-tabs" aria-label="Rank by">${METRICS.map((m) => html`<a class="br-tab" href="${base}?metric=${m.id}#br-rank"${m.id === current ? raw(' aria-current="page"') : ''}${m.hint ? raw(` title="${m.hint}"`) : ''}>${m.label}</a>`)}</nav>`;
}

function rankingsTable(entries, metric) {
    if (!entries.length) return '';
    const col = { value: (e) => (e.value == null ? '—' : `${fmtScore(e.value)} / $`), speed: (e) => (e.speed == null ? '—' : `${fmtScore(e.speed)} / min`), consistency: (e) => (e.consistency == null ? '—' : `±${fmtScore(e.consistency)}`) }[metric];
    return html`<div class="br-table-wrap"><table class="br-table"><thead><tr><th scope="col">#</th><th scope="col">Model</th><th scope="col">Score</th>${col ? html`<th scope="col">${METRICS.find((m) => m.id === metric).label}</th>` : ''}<th scope="col" class="br-num">Cost / run</th><th scope="col" class="br-num">Time</th><th scope="col" class="br-num">Runs</th></tr></thead><tbody>${entries.map((e, i) => html`<tr><td class="br-rank">${i + 1}</td><td><a class="br-model" href="${modelHref(e.model)}">${e.model}</a></td><td>${scoreBar(e.score)}</td>${col ? html`<td class="br-num">${col(e)}</td>` : ''}<td class="br-num">${fmtUsd(e.cost_usd)}</td><td class="br-num">${fmtMs(e.ms)}</td><td class="br-num">${e.runs}</td></tr>`)}</tbody></table></div>`;
}

// ---- runs list -----------------------------------------------------------------------------------------------

function runsList(runs, { showBenchmark = false, titles = {} } = {}) {
    if (!runs.length) return '';
    return html`<ul class="br-runs">${runs.map((r) => html`<li class="br-run"><a class="br-run-link" href="${runHref(r.id)}"><span class="br-run-main"><span class="br-run-model">${r.model}</span><span class="br-run-sub">${showBenchmark ? html`${titles[r.benchmark_id] || r.benchmark_id} · ` : ''}${harnessLabel(r.harness)} · ${fmtDate(r.created_at)}</span></span>${scoreBar(r.score)}</a>${provenance(r.provenance)}</li>`)}</ul>`;
}

// ---- outputs -------------------------------------------------------------------------------------------------

/** An output: a live frame when it is ours to frame (the render origin), a picture from Media, else a plain link. */
function artifact(a, label) {
    const url = String(a.url || '');
    if (url.startsWith(`${renderLib.RENDER_ORIGIN}/render/`)) {
        return html`<figure class="br-out"><iframe class="br-out-frame" src="${url}" title="${label}" sandbox="${renderLib.WRAPPER_SANDBOX}" referrerpolicy="no-referrer" loading="lazy"></iframe><figcaption>${a.kind}</figcaption></figure>`;
    }
    if (url.startsWith(`${MEDIA_ORIGIN}/`) && /^(image|screenshot|png|jpeg|webp)$/i.test(String(a.kind))) {
        return html`<figure class="br-out"><img class="br-out-img" src="${url}" alt="${label}" loading="lazy"><figcaption>${a.kind}</figcaption></figure>`;
    }
    if (/^https:\/\//.test(url)) return html`<a class="br-out-link" href="${url}" rel="noopener nofollow ugc">${a.kind}: ${url.replace(/^https:\/\//, '').slice(0, 60)}</a>`;
    return html`<span class="br-out-link">${a.kind}</span>`;
}

// ---- pages ---------------------------------------------------------------------------------------------------

function benchmarksIndex({ benchmarks = [], kinds = [], kind = null, q = '' } = {}) {
    const families = [...new Set(kinds.map((k) => String(k).split('.')[0]))].sort();
    const chip = (label, value) => {
        const on = (value || null) === (kind || null);
        const href = value ? `/benchmarks?kind=${encodeURIComponent(value)}` : '/benchmarks';
        return html`<a class="br-filter" href="${href}"${on ? raw(' aria-current="page"') : ''}>${label}</a>`;
    };
    return html`<div class="bm-wrap br" id="br-benchmarks">
<header class="bm-page-h"><p class="bm-kicker">Benchmarks</p><h1>Benchmarks anyone can run again</h1>
<p class="bm-lede">Each one is a versioned set of tasks with its judges and limits. A version never changes once a run names it, so every score here can be repeated.</p></header>
<form class="br-search" method="get" action="/benchmarks" role="search"><label class="br-sr" for="br-q">Search benchmarks</label><input id="br-q" name="q" type="search" value="${q}" placeholder="Search by title, tag or kind" autocomplete="off">${kind ? html`<input type="hidden" name="kind" value="${kind}">` : ''}<button class="bm-btn bm-btn-small" type="submit">Search</button></form>
<nav class="br-filters" aria-label="Filter by family">${chip('All', null)}${families.map((f) => chip(f, f))}</nav>
${benchmarks.length ? html`<ul class="br-cards">${benchmarks.map(benchmarkCard)}</ul>` : empty('No benchmark matches', q ? 'Try a shorter search, or clear the filter.' : 'None are published yet.', html`<a class="bm-btn bm-btn-quiet bm-btn-small" href="/benchmarks">Show all</a>`)}
</div>`;
}

function benchmarkCard(b) {
    const tasks = ((b.draft && b.draft.tasks) || []).length;
    return html`<li class="br-card"><a class="br-card-link" href="${benchmarkHref(b.id)}"><span class="br-card-top">${kindChip(b.kind)}<span class="br-card-v">v${b.latest_version || 0}</span></span><span class="br-card-title">${b.title}</span><span class="br-card-desc">${b.description}</span><span class="br-card-foot">${plural(tasks, 'task')}${b.runs != null ? html` · ${plural(b.runs, 'run')}` : ''}${b.parent ? ' · a fork' : ''}</span></a></li>`;
}

function benchmarkPage({ benchmark, definition, version, rankings, metric = 'score', runs = [], codesRunUrl = null }) {
    const d = definition || {};
    const tasks = Array.isArray(d.tasks) ? d.tasks : [];
    const shown = tasks.filter((t) => !t.holdout && t.prompt);
    const hidden = tasks.length - shown.length;
    const judges = Array.isArray(d.judges) ? d.judges : [];
    const limits = d.limits || {};
    const entries = (rankings && rankings.entries) || [];
    const base = benchmarkHref(benchmark.id);
    const runYourself = codesRunUrl
        ? html`<a class="bm-btn" href="${codesRunUrl}?benchmark=${encodeURIComponent(`${benchmark.id}@${version || benchmark.latest_version}`)}">Run it yourself</a>`
        : html`<a class="bm-btn bm-btn-quiet" href="/docs#br-publish">Publish a run</a>`;
    return html`<div class="bm-wrap br" id="br-benchmark">
<nav class="br-crumbs" aria-label="Breadcrumb"><a href="/benchmarks">Benchmarks</a><span aria-hidden="true">/</span><span>${benchmark.title}</span></nav>
<header class="br-head"><div class="br-head-main"><p class="br-head-meta">${kindChip(benchmark.kind)}<span>v${version || benchmark.latest_version || 0}</span><span>by ${benchmark.owner}</span>${benchmark.parent ? html`<a href="${benchmarkHref(benchmark.parent)}">forked</a>` : ''}</p>
<h1>${benchmark.title}</h1>${benchmark.description ? html`<p class="bm-lede">${benchmark.description}</p>` : ''}</div>
<div class="br-head-act">${runYourself}<p class="br-fine">${codesRunUrl ? 'On openvibe.codes, with your own keys. The result is published here.' : 'Running it on openvibe.codes with your own keys is coming. Today a run is published through the API.'}</p></div></header>
<dl class="br-facts"><div><dt>Tasks</dt><dd>${tasks.length}${hidden ? html` <span class="br-fine">(${hidden} hidden)</span>` : ''}</dd></div><div><dt>Judged by</dt><dd>${judges.length ? judges.map((j) => String(j.type).replace(/_/g, ' ')).join(', ') : '—'}</dd></div><div><dt>Limits</dt><dd>${[limits.ms ? fmtMs(limits.ms) : null, limits.tokens ? `${fmtTokens(limits.tokens)} tokens` : null, limits.usd ? fmtUsd(limits.usd) : null].filter(Boolean).join(' · ') || '—'}</dd></div><div><dt>Verified runs</dt><dd>${entries.reduce((n, e) => n + e.runs, 0)}</dd></div></dl>
<section class="bm-section" id="br-rank" aria-labelledby="br-rank-h"><div class="bm-head-row"><h2 id="br-rank-h">Rankings</h2>${metricTabs(base, metric)}</div>
${valueChart(entries)}
${entries.length ? rankingsTable(entries, metric) : empty('No verified runs yet', 'A run counts here once openvibe.codes, Run or a Node worker ran it and published it. Submitted runs are listed below but never ranked.')}
</section>
<section class="bm-section" aria-labelledby="br-tasks-h"><div class="bm-head-row"><h2 id="br-tasks-h">Tasks</h2><span class="bm-count">${tasks.length}</span></div>
<ol class="br-tasks">${shown.map((t) => html`<li class="br-task"><span class="br-task-id br-mono">${t.id}</span><p>${t.prompt}</p></li>`)}${hidden ? html`<li class="br-task is-hidden"><span class="br-task-id br-mono">${plural(hidden, 'task')}</span><p>Held out: only the executor sees ${hidden === 1 ? 'it' : 'them'}, so nobody can tune for the answer.</p></li>` : ''}</ol></section>
<section class="bm-section" aria-labelledby="br-latest-h"><div class="bm-head-row"><h2 id="br-latest-h">Latest runs</h2>${runs.length > 1 ? html`<a class="bm-more" href="${compareHref(runs.slice(0, 2).map((r) => r.id))}">Compare the newest two</a>` : ''}</div>
${runs.length ? runsList(runs) : empty('No runs yet', 'The first run shows up here, verified or submitted.')}</section>
<p class="br-fine br-api">The same data as JSON: <a href="/api/v1/benchmarks/${encodeURIComponent(benchmark.id)}">definition</a> · <a href="/api/v1/rankings?benchmark=${encodeURIComponent(benchmark.id)}&amp;metric=${metric}">rankings</a></p>
</div>`;
}

function runPage({ run, benchmark, definition, pct }) {
    const tasksDef = new Map(((definition && definition.tasks) || []).map((t) => [t.id, t]));
    const env = [
        ['Model', html`<a href="${modelHref(run.model)}">${run.model}</a>`],
        ['Provider', run.provider || '—'],
        ['Route', run.route && Object.keys(run.route).length ? Object.entries(run.route).map(([k, v]) => `${k} ${v}`).join(' · ') : '—'],
        ['Harness', harnessLabel(run.harness)],
        ['Settings', [run.settings && run.settings.effort ? `effort ${run.settings.effort}` : null, run.settings && run.settings.temperature != null ? `temperature ${run.settings.temperature}` : null].filter(Boolean).join(' · ') || 'defaults'],
        ['Ran on', run.executor ? ({ codes: 'openvibe.codes', run: 'OpenVibe.Run', node: 'a Node worker', submitted: 'not re-run' })[run.executor.kind] || run.executor.kind : '—'],
        ['Hardware', run.hardware ? Object.entries(run.hardware).map(([k, v]) => `${k} ${v}`).join(' · ') : '—'],
        ['Benchmark', html`<a href="${benchmarkHref(run.benchmark_id)}">${benchmark ? benchmark.title : run.benchmark_id}</a> <span class="br-fine">v${run.benchmark_version}</span>`],
    ];
    const pctLine = pct && pct.runs > 1 && pct.percentile != null
        ? html`<div class="br-pct"><div class="br-pct-strip" aria-hidden="true"><span style="left:${Math.max(0, Math.min(100, pct.percentile)).toFixed(1)}%"></span></div><p><b>${ordinal(pct.percentile)} percentile</b> of ${pct.runs} verified runs of ${run.model} on this benchmark. Median ${fmtScore(pct.median)}, best ${fmtScore(pct.best)}.</p></div>`
        : html`<p class="br-fine">Where it sits shows once ${run.model} has more verified runs here.</p>`;
    return html`<div class="bm-wrap br" id="br-run">
<nav class="br-crumbs" aria-label="Breadcrumb"><a href="/benchmarks">Benchmarks</a><span aria-hidden="true">/</span><a href="${benchmarkHref(run.benchmark_id)}">${benchmark ? benchmark.title : run.benchmark_id}</a><span aria-hidden="true">/</span><span class="br-mono">${run.id}</span></nav>
<header class="br-head br-run-head"><div class="br-head-main"><p class="br-head-meta">${provenance(run.provenance)}<span>${fmtDate(run.created_at)}</span></p><h1>${run.model}</h1><p class="bm-lede">on ${benchmark ? benchmark.title : run.benchmark_id}, through ${harnessLabel(run.harness)}</p></div>
<div class="br-head-score">${scoreBar(run.score, { big: true })}<dl class="br-totals"><div><dt>Cost</dt><dd>${fmtUsd(run.cost_usd)}</dd></div><div><dt>Time</dt><dd>${fmtMs(run.ms)}</dd></div><div><dt>Tokens</dt><dd>${fmtTokens(run.tokens)}</dd></div></dl></div></header>
${pctLine}
<section class="bm-section" aria-labelledby="br-env-h"><h2 id="br-env-h">Environment</h2><dl class="br-env">${env.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl></section>
<section class="bm-section" aria-labelledby="br-pt-h"><div class="bm-head-row"><h2 id="br-pt-h">Tasks</h2><span class="bm-count">${(run.tasks || []).length}</span></div>
${(run.tasks || []).length ? html`<ol class="br-ptasks">${run.tasks.map((t) => {
        const def = tasksDef.get(t.task_id);
        const prompt = def && def.prompt && !def.holdout ? def.prompt : 'A held-out task: its prompt stays with the executor.';
        return html`<li class="br-ptask"><div class="br-ptask-head"><span class="br-task-id br-mono">${t.task_id}</span>${scoreBar(t.score)}<span class="br-ptask-meta">${fmtUsd(t.cost_usd)} · ${fmtMs(t.ms)} · ${fmtTokens(t.tokens)} tokens</span></div><p class="br-ptask-prompt">${prompt}</p>${t.artifacts && t.artifacts.length ? html`<div class="br-outs">${t.artifacts.map((a, i) => artifact(a, `${t.task_id} output ${i + 1}`))}</div>` : ''}${t.transcript_url && /^https:\/\//.test(t.transcript_url) ? html`<a class="bm-more" href="${t.transcript_url}" rel="noopener nofollow">Transcript</a>` : ''}</li>`;
    })}</ol>` : empty('No task results', 'This run published its totals only.')}</section>
<section class="bm-section br-again" aria-labelledby="br-again-h"><h2 id="br-again-h">Again</h2><p class="br-fine">The benchmark version is frozen, so this run can be repeated exactly: the same tasks, the same judges.</p><div class="bm-actions"><a class="bm-btn bm-btn-quiet" href="${benchmarkHref(run.benchmark_id)}">See every model on it</a><a class="bm-btn bm-btn-quiet" href="/api/v1/runs/${encodeURIComponent(run.id)}">The run as JSON</a></div></section>
</div>`;
}

function comparePage({ cmp, titles = {} }) {
    if (!cmp) {
        return html`<div class="bm-wrap br" id="br-compare"><header class="bm-page-h"><p class="bm-kicker">Compare</p><h1>Compare runs</h1><p class="bm-lede">Open a benchmark, then compare two to four of its runs: the same tasks side by side, with their scores, cost, time and outputs.</p></header>${empty('Nothing to compare', 'Add runs with ?runs=run_a,run_b, or pick them from a benchmark.', html`<a class="bm-btn bm-btn-small" href="/benchmarks">Benchmarks</a>`)}</div>`;
    }
    const { runs, rows } = cmp;
    const best = (vals, hi = true) => { const v = vals.filter((x) => x != null); return v.length ? (hi ? Math.max(...v) : Math.min(...v)) : null; };
    const cell = (v, b, f) => html`<td class="br-num${v != null && v === b ? ' is-best' : ''}">${f(v)}</td>`;
    const line = (label, vals, f, hi = true) => { const b = best(vals, hi); return html`<tr><th scope="row">${label}</th>${vals.map((v) => cell(v, b, f))}</tr>`; };
    return html`<div class="bm-wrap br" id="br-compare">
<header class="bm-page-h"><p class="bm-kicker">Compare</p><h1>${runs.map((r) => r.model).join(' vs ')}</h1><p class="bm-lede">${[...new Set(runs.map((r) => titles[r.benchmark_id] || r.benchmark_id))].join(', ')}. The best value in each row is marked.</p></header>
<div class="br-table-wrap"><table class="br-table br-cmp"><thead><tr><th scope="col"><span class="br-sr">Measure</span></th>${runs.map((r) => html`<th scope="col"><a href="${runHref(r.id)}">${r.model}</a><span class="br-cmp-sub">${harnessLabel(r.harness)}</span>${provenance(r.provenance)}</th>`)}</tr></thead><tbody>
${line('Score', runs.map((r) => r.score), fmtScore)}${line('Cost', runs.map((r) => r.cost_usd), fmtUsd, false)}${line('Time', runs.map((r) => r.ms), fmtMs, false)}${line('Tokens', runs.map((r) => r.tokens), fmtTokens, false)}
${rows.map((row) => line(html`<span class="br-mono">${row.task_id}</span>`, row.scores, fmtScore))}
</tbody></table></div>
${rows.some((row) => runs.some((r) => ((r.tasks.find((t) => t.task_id === row.task_id) || {}).artifacts || []).length)) ? html`<section class="bm-section" aria-labelledby="br-cmp-out-h"><h2 id="br-cmp-out-h">Outputs side by side</h2>${rows.map((row) => html`<div class="br-cmp-row"><p class="br-task-id br-mono">${row.task_id}</p><div class="br-cmp-outs" style="--n:${runs.length}">${runs.map((r) => {
        const t = r.tasks.find((x) => x.task_id === row.task_id);
        const a = t && t.artifacts && t.artifacts[0];
        return html`<div class="br-cmp-out"><p class="br-cmp-sub">${r.model}</p>${a ? artifact(a, `${r.model} ${row.task_id}`) : html`<p class="br-fine">No output</p>`}</div>`;
    })}</div></div>`)}</section>` : ''}
</div>`;
}

function modelPage({ model, summary, runs = [], titles = {} }) {
    const rows = (summary && summary.benchmarks) || [];
    return html`<div class="bm-wrap br" id="br-model">
<nav class="br-crumbs" aria-label="Breadcrumb"><a href="/benchmarks">Benchmarks</a><span aria-hidden="true">/</span><span>Models</span></nav>
<header class="bm-page-h"><p class="bm-kicker">Model</p><h1 class="br-mono-h">${model}</h1><p class="bm-lede">${summary && summary.runs ? `${plural(summary.runs, 'verified run')} across ${plural(rows.length, 'benchmark')}.` : 'No verified runs yet.'}</p></header>
<section class="bm-section" aria-labelledby="br-mb-h"><h2 id="br-mb-h">By benchmark</h2>
${rows.length ? html`<div class="br-table-wrap"><table class="br-table"><thead><tr><th scope="col">Benchmark</th><th scope="col">Median</th><th scope="col" class="br-num">Spread</th><th scope="col" class="br-num">Cost / run</th><th scope="col" class="br-num">Time</th><th scope="col" class="br-num">Runs</th></tr></thead><tbody>${rows.map((b) => html`<tr><td><a href="${benchmarkHref(b.benchmark_id)}">${b.title}</a> ${kindChip(b.kind)}</td><td>${scoreBar(b.score)}</td><td class="br-num">${b.runs > 1 ? `${fmtScore(b.worst)}–${fmtScore(b.best)}` : '—'}</td><td class="br-num">${fmtUsd(b.cost_usd)}</td><td class="br-num">${fmtMs(b.ms)}</td><td class="br-num">${b.runs}</td></tr>`)}</tbody></table></div>` : empty('Nothing measured yet', 'This model shows up here after its first verified run.', html`<a class="bm-btn bm-btn-small" href="/benchmarks">Pick a benchmark</a>`)}</section>
${runs.length ? html`<section class="bm-section" aria-labelledby="br-mr-h"><h2 id="br-mr-h">Latest runs</h2>${runsList(runs, { showBenchmark: true, titles })}</section>` : ''}
</div>`;
}

module.exports = {
    benchmarksIndex, benchmarkPage, runPage, comparePage, modelPage, valueChart, METRICS,
    fmtScore, fmtUsd, fmtMs, fmtTokens, ordinal, benchmarkCard, render,
};

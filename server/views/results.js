'use strict';

/**
 * The results pages (stage B2): the benchmark list, a benchmark with its rankings and value chart, a run (Geekbench
 * style: the environment, the score, where it sits, each task and its outputs), compare, and a model across
 * benchmarks. Server-rendered and complete without JavaScript. Everything dynamic goes through html`` (escaped).
 * Ids and classes start with `br-`.
 */
const { html, raw, render } = require('../render/html');
const { benchmarkUseThis, modelUseThis } = require('./usethis');
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
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabel(month) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
    if (!m) return String(month || '');
    return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
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

function provenance(p, source = null) {
    const badge = p === 'verified'
        ? html`<span class="br-prov is-verified" title="Run by openvibe.codes, Run or a Node worker, and published by that service">Verified</span>`
        : html`<span class="br-prov is-submitted" title="Published by a person; nobody re-ran it">Submitted</span>`;
    const kind = source && typeof source === 'object' ? source.kind : null;
    if (kind === 'import') {
        const tool = String(source.tool || 'a tool');
        const version = String(source.tool_version || '');
        return html`${badge}<span class="br-prov is-imported" title="Imported from ${tool} ${version}: the file was read, never re-run">Imported from ${tool}${version ? ' ' + version : ''}</span>`;
    }
    if (kind === 'mirror') {
        const url = String(source.source_url || '');
        const licence = String(source.licence || '');
        return html`${badge}<span class="br-prov is-mirrored" title="Mirrored from ${url}${licence ? ' (' + licence + ')' : ''}: a published result, never re-run">Mirrored</span>`;
    }
    return badge;
}

/** Where a run came from, in a line of its own: an upload with its file, or a mirror with its source. */
function sourceLine(run) {
    const source = run && run.source && typeof run.source === 'object' ? run.source : null;
    if (!source) return '';
    if (source.kind === 'import') {
        const tool = String(source.tool || 'a tool');
        const version = String(source.tool_version || '');
        const file = source.import_id ? html` · <a href="/imports/${encodeURIComponent(source.import_id)}/file">the original file</a>` : '';
        const said = source.date ? html` · the file says ${fmtDate(source.date)}` : '';
        return html`<p class="br-fine">Imported from ${tool}${version ? ' ' + version : ''}${said}. The original file is the owner's, and stays private until they share it${file}.</p>`;
    }
    if (source.kind === 'mirror') {
        const read = source.read_at ? html` · read ${fmtDate(source.read_at)}` : '';
        return html`<p class="br-fine br-source">Mirrored from <a href="${String(source.source_url || '')}" rel="nofollow noopener">${String(source.source_url || 'the source')}</a>${source.licence ? ' · ' + source.licence : ''}${read}. A published result, never re-run here.</p>`;
    }
    return '';
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
    { id: 'horizon', label: 'Horizon', hint: 'the human-length task the model does 50% of the time, after METR' },
];

function fmtMinutes(v) {
    if (v == null) return '—';
    const n = Number(v);
    if (n < 1) return `${Math.round(n * 60)} s`;
    if (n < 90) return `${Math.round(n * 10) / 10} min`;
    return `${Math.round(n / 6) / 10} h`;
}

/** The 50% time horizon, with its bootstrap interval; never a number below the gates. */
function horizonText(h) {
    if (!h || !h.available) return '—';
    return `${fmtMinutes(h.horizon_minutes)} (${fmtMinutes(h.ci_lower)}–${fmtMinutes(h.ci_upper)})`;
}

function horizonLine(h) {
    if (!h) return '';
    if (h.available) {
        return html`<p class="br-horizon"><b>Time horizon:</b> reliably does about ${fmtMinutes(h.horizon_minutes)} tasks. 90% interval ${fmtMinutes(h.ci_lower)}–${fmtMinutes(h.ci_upper)}, from ${plural(h.timed_tasks, 'timed task')} and ${plural(h.runs, 'run')}.</p>`;
    }
    return html`<p class="br-fine br-horizon">Time horizon: not enough runs yet (needs ${h.need_tasks || 15} timed tasks and ${h.need_runs || 3} runs).</p>`;
}

/** The contamination badge, with both numbers and their bands. Only a real flag is ever shown. */
function contaminationList(entries) {
    const flagged = entries.filter((e) => e.contamination && e.contamination.flag);
    if (!flagged.length) return '';
    return html`<ul class="br-contams">${flagged.map((e) => {
        const c = e.contamination;
        return html`<li class="br-contam"><b>${e.model}</b> — Did much better on older tasks: possibly seen in training. Older tasks ${fmtScore(c.old.median)} (${fmtScore(c.old.lower)}–${fmtScore(c.old.upper)}), fresh tasks ${fmtScore(c.fresh.median)} (${fmtScore(c.fresh.lower)}–${fmtScore(c.fresh.upper)}). Release cutoff ${c.cutoff}${c.source ? html` · <a href="${c.source}" rel="nofollow noopener">source</a>` : ''}.</li>`;
    })}</ul>`;
}

function metricTabs(base, current) {
    return html`<nav class="br-tabs" aria-label="Rank by">${METRICS.map((m) => html`<a class="br-tab" href="${base}?metric=${m.id}#br-rank"${m.id === current ? raw(' aria-current="page"') : ''}${m.hint ? raw(` title="${m.hint}"`) : ''}>${m.label}</a>`)}</nav>`;
}

function rankingsTable(entries, metric) {
    if (!entries.length) return '';
    const col = {
        value: (e) => (e.value == null ? '—' : `${fmtScore(e.value)} / $`),
        speed: (e) => (e.speed == null ? '—' : `${fmtScore(e.speed)} / min`),
        consistency: (e) => (e.consistency == null ? '—' : `±${fmtScore(e.consistency)}`),
    }[metric];
    const bands = metric === 'score' && entries.some((e) => e.band);
    const isHorizon = metric === 'horizon';
    const showHorizon = isHorizon || entries.some((e) => e.horizon && (e.horizon.available || e.horizon.timed_tasks > 0));
    const metricLabel = METRICS.find((m) => m.id === metric).label;
    return html`<div class="br-table-wrap"><table class="br-table br-rank-table"><thead><tr><th scope="col">#</th>${bands ? html`<th scope="col">Band</th>` : ''}<th scope="col">Model</th><th scope="col">Score</th>${col && !isHorizon ? html`<th scope="col">${metricLabel}</th>` : ''}${showHorizon ? html`<th scope="col" class="br-num"><a href="?metric=horizon#br-rank"${isHorizon ? raw(' aria-current="page"') : ''}>Horizon</a></th>` : ''}<th scope="col" class="br-num">Cost / run</th><th scope="col" class="br-num">Time</th><th scope="col" class="br-num">Runs</th></tr></thead><tbody>${entries.map((e, i) => html`<tr><td class="br-rank">${i + 1}</td>${bands ? html`<td class="br-c-band"><span class="rt-band">${e.band || '—'}</span></td>` : ''}<td class="br-c-model"><a class="br-model" href="${modelHref(e.model)}">${e.model}</a>${e.contamination && e.contamination.flag ? html`<span class="br-contam-chip" title="Did much better on older tasks: possibly seen in training">possibly seen in training</span>` : ''}</td><td class="br-c-score">${scoreBar(e.score)}</td>${col && !isHorizon ? html`<td class="br-num br-c-metric" data-label="${metricLabel}">${col(e)}</td>` : ''}${showHorizon ? html`<td class="br-num br-c-horizon" data-label="horizon" title="${e.horizon && e.horizon.available ? `${e.horizon.timed_tasks} timed tasks, ${e.horizon.runs} runs` : 'not enough runs yet'}">${horizonText(e.horizon)}</td>` : ''}<td class="br-num br-c-cost" data-label="cost/run">${fmtUsd(e.cost_usd)}</td><td class="br-num br-c-time" data-label="time">${fmtMs(e.ms)}</td><td class="br-num br-c-runs" data-label="runs">${e.runs}</td></tr>`)}</tbody></table></div>${contaminationList(entries)}`;
}

/**
 * One leaderboard in the same `br-` table language for a person's own prompts and the public board beside it.
 * Bands are the overlapping score intervals (2nd–4th, not a fake third place); the cost is per solved task, the
 * rules' value metric (the median cost of an attempt divided by the success rate).
 */
function promptLeaderboard(entries, { emptyText = 'No runs yet.', caption = 'Models in rank bands, with their score, cost per solved task and run count' } = {}) {
    if (!entries.length) return html`<div class="bm-empty"><p>${emptyText}</p></div>`;
    return html`<div class="br-table-wrap"><table class="br-table rt-table br-prompt-table">
<caption class="br-sr">${caption}</caption>
<thead><tr><th scope="col">Band</th><th scope="col">Model</th><th scope="col">Score</th><th scope="col" class="br-num">Cost / solved task</th><th scope="col" class="br-num">Runs</th></tr></thead>
<tbody>${entries.map((e) => html`<tr data-model="${e.model}"><td class="rt-col-band"><span class="rt-band">${e.band || '—'}</span></td><td class="rt-col-model"><a class="rt-model br-model" href="${modelHref(e.model)}">${e.model}</a></td><td class="rt-col-controlled">${scoreBar(e.score)}${e.spread ? html`<span class="br-fine br-spread">${fmtScore(e.min_score)}–${fmtScore(e.max_score)} over ${plural(e.runs, 'run')}</span>` : ''}</td><td class="rt-col-raw br-num rt-prompt-cost">${e.cost_per_solved == null ? '—' : fmtUsd(e.cost_per_solved)}</td><td class="rt-col-votes br-num">${e.runs}</td></tr>`)}</tbody></table></div>`;
}

/** The owner's leaderboard beside the public one for the same kind; the two are never mixed. */
function promptBoards({ ownEntries = [], publicBoard = null, ownRuns = 0, visibility = 'private' }) {
    const mineLabel = `Your prompts, ${ownRuns} ${ownRuns === 1 ? 'run' : 'runs'}`;
    const publicEntries = (publicBoard && publicBoard.entries) || [];
    return html`<section class="bm-section br-your-prompts" id="br-rank" aria-labelledby="br-yours-h">
<div class="br-duo">
<section class="br-duo-pane" aria-labelledby="br-yours-h">
<div class="bm-head-row"><h2 id="br-yours-h">${mineLabel}</h2><span class="br-chip br-vis">${visibility}</span></div>
<p class="br-fine">Your own tasks, your runs. This board is never mixed into the public ranks.</p>
${ownEntries.length ? valueChart(ownEntries) : ''}
${promptLeaderboard(ownEntries, { emptyText: 'No runs yet. Start it on 3 to 6 models; every run lands here, whatever it scores.' })}
</section>
<section class="br-duo-pane" aria-labelledby="br-public-h">
<div class="br-fold br-public-details"><input class="br-fold-toggle" type="checkbox" id="br-public-open"><label class="br-fold-h" for="br-public-open"><h2 id="br-public-h">The public board for this kind</h2><span class="br-fold-mark" aria-hidden="true"></span></label>
<div class="br-fold-body">
${publicBoard && publicBoard.benchmark ? html`<p class="br-fine"><a href="${benchmarkHref(publicBoard.benchmark.id)}">${publicBoard.benchmark.title}</a></p>` : ''}
<p class="br-fine">Other people's runs of the public set, ranked the same way. Your prompts are not in it.</p>
${publicEntries.length
        ? promptLeaderboard(publicEntries, { emptyText: '' })
        : empty('No public board yet', 'No public benchmark of this kind has verified runs yet, so there is nothing to stand beside. Your own board still counts your runs.')}
</div></div>
</section>
</div>
</section>`;
}

// ---- runs list -----------------------------------------------------------------------------------------------

function runsList(runs, { showBenchmark = false, titles = {} } = {}) {
    if (!runs.length) return '';
    return html`<ul class="br-runs">${runs.map((r) => html`<li class="br-run"><a class="br-run-link" href="${runHref(r.id)}"><span class="br-run-main"><span class="br-run-model">${r.model}</span><span class="br-run-sub">${showBenchmark ? html`${titles[r.benchmark_id] || r.benchmark_id} · ` : ''}${harnessLabel(r.harness)} · ${fmtDate(r.created_at)}</span></span>${scoreBar(r.score)}</a>${provenance(r.provenance, r.source)}</li>`)}</ul>`;
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

function benchmarksIndex({ benchmarks = [], kinds = [], kind = null, q = '', mine = [], signedIn = false } = {}) {
    const families = [...new Set(kinds.map((k) => String(k).split('.')[0]))].sort();
    const chip = (label, value) => {
        const on = (value || null) === (kind || null);
        const href = value ? `/benchmarks?kind=${encodeURIComponent(value)}` : '/benchmarks';
        return html`<a class="br-filter" href="${href}"${on ? raw(' aria-current="page"') : ''}>${label}</a>`;
    };
    const own = mine.length
        ? html`<section class="bm-section br-mine" aria-labelledby="br-mine-h"><div class="bm-head-row"><h2 id="br-mine-h">Your benchmarks</h2><span class="bm-count">${mine.length}</span></div>
<p class="br-fine">Private ones are yours alone. An unlisted one opens with its share link; a public one is listed below.</p>
<ul class="br-cards">${mine.map(benchmarkCard)}</ul></section>`
        : '';
    return html`<div class="bm-wrap br" id="br-benchmarks">
<header class="bm-page-h"><div class="bm-head-row"><div><p class="bm-kicker">Benchmarks</p><h1>Benchmarks anyone can run again</h1>
<p class="bm-lede">Each one is a versioned set of tasks with its judges and limits. A version never changes once a run names it, so every score here can be repeated.</p></div><a class="bm-btn" href="/benchmarks/new">Make your own</a></div></header>
<form class="br-search" method="get" action="/benchmarks" role="search"><label class="br-sr" for="br-q">Search benchmarks</label><input id="br-q" name="q" type="search" value="${q}" placeholder="Search by title, tag or kind" autocomplete="off">${kind ? html`<input type="hidden" name="kind" value="${kind}">` : ''}<button class="bm-btn bm-btn-small" type="submit">Search</button></form>
<nav class="br-filters" aria-label="Filter by family">${chip('All', null)}${families.map((f) => chip(f, f))}</nav>
${own}
${signedIn ? '' : html`<p class="br-fine br-mine-hint">Signed in, you can paste 5 to 50 of your own prompts as a private benchmark: <a href="/benchmarks/new">make your own</a>.</p>`}
${benchmarks.length ? html`<ul class="br-cards">${benchmarks.map(benchmarkCard)}</ul>` : empty('No benchmark matches', q ? 'Try a shorter search, or clear the filter.' : 'None are published yet.', html`<a class="bm-btn bm-btn-quiet bm-btn-small" href="/benchmarks">Show all</a>`)}
</div>`;
}

function benchmarkCard(b) {
    const tasks = ((b.draft && b.draft.tasks) || []).length;
    const vis = b.visibility && b.visibility !== 'public'
        ? html`<span class="br-chip br-vis">${b.visibility === 'private' ? 'private' : 'unlisted'}</span>`
        : '';
    return html`<li class="br-card"><a class="br-card-link" href="${benchmarkHref(b.id)}"><span class="br-card-top">${kindChip(b.kind)}<span class="br-card-v">v${b.latest_version || 0}</span>${vis}</span><span class="br-card-title">${b.title}</span><span class="br-card-desc">${b.description}</span><span class="br-card-foot">${plural(tasks, 'task')}${b.runs != null ? html` · ${plural(b.runs, 'run')}` : ''}${b.parent ? ' · a fork' : ''}</span></a></li>`;
}

/** The owner's sharing controls: private, an unlisted link, or public. Plain form posts, no JavaScript. */
function shareBox({ benchmark, shareUrl = null, error = null }) {
    const visibility = benchmark.visibility || 'private';
    const note = visibility === 'private'
        ? 'Private: only you can see this benchmark and its prompts. No link works.'
        : visibility === 'unlisted'
            ? 'Unlisted: anyone with the link can see it. It is not in any list, search, sitemap or the open data.'
            : 'Public: it is in the benchmark list, the sitemap and the open data, with every run published.';
    return html`<section class="bm-section br-share" id="br-share" aria-labelledby="br-share-h">
<div class="br-fold br-share-details"><input class="br-fold-toggle" type="checkbox" id="br-share-open"><label class="br-fold-h" for="br-share-open"><h2 id="br-share-h">Sharing</h2><span class="br-chip br-vis">${visibility}</span><span class="br-fold-mark" aria-hidden="true"></span></label>
<div class="br-fold-body">
<p class="br-fine">${note}</p>
${error ? html`<div class="bm-note is-bad" role="alert">${error}</div>` : ''}
${shareUrl ? html`<div class="bm-note br-share-now" role="status"><p>Your unlisted link is ready. It is shown once; copy it now. Share it again for a new link; the old one stops working.</p><label class="br-field"><span>The link</span><input class="br-share-link" type="text" readonly value="${shareUrl}" onfocus="this.select()"></label></div>` : ''}
<form class="br-share-form" method="post" action="/benchmarks/${encodeURIComponent(benchmark.id)}/share">
<button class="bm-btn" type="submit" name="visibility" value="unlisted">${visibility === 'unlisted' ? 'New unlisted link' : 'Share an unlisted link'}</button>
<button class="bm-btn bm-btn-quiet" type="submit" name="visibility" value="public">Publish public</button>
<button class="bm-btn bm-btn-quiet" type="submit" name="visibility" value="private">Make private</button>
</form>
<p class="br-fine">A person with the unlisted link can read the prompts and the runs. Only you can start a run on it.</p>
</div></div>
</section>`;
}

/** The new-benchmark form: 5–50 pasted prompts, one per line or CSV with an optional expected answer. */
function newBenchmarkPage({ kinds = [], values = {}, error = null, signedIn = false, loginUrl = '/auth/login' }) {
    const head = html`<nav class="br-crumbs" aria-label="Breadcrumb"><a href="/benchmarks">Benchmarks</a><span aria-hidden="true">/</span><span>Make your own</span></nav>
<header class="bm-page-h"><p class="bm-kicker">Your prompts</p><h1>Make a benchmark from your own prompts</h1>
<p class="bm-lede">Paste 5 to 50 prompts you really use. They become the tasks of a private benchmark: no model is called and nothing is charged until you run it on openvibe.codes.</p></header>`;
    if (!signedIn) {
        return html`<div class="bm-wrap br bm-narrow" id="br-new">${head}${empty('Sign in first', 'A benchmark of your own is attached to your account, so the prompts can be exported or deleted with you.', html`<a class="bm-btn bm-btn-small" href="${loginUrl}">Sign in with OpenVibe</a>`)}</div>`;
    }
    const kindList = [...kinds].sort((a, b) => (a.id === 'text.answer' ? -1 : b.id === 'text.answer' ? 1 : String(a.name || a.id).localeCompare(String(b.name || b.id))));
    const kind = values.kind || 'text.answer';
    const format = values.format || 'auto';
    return html`<div class="bm-wrap br bm-narrow" id="br-new">${head}
${error ? html`<div class="bm-note is-bad" role="alert">${error}</div>` : ''}
<form class="br-form br-new-form" method="post" action="/benchmarks/new">
<label class="br-field"><span>Name (optional)</span><input name="title" type="text" maxlength="160" value="${values.title || ''}" placeholder="Your prompts, e.g. the support replies I really send" autocomplete="off"></label>
<label class="br-field"><span>Description (optional)</span><textarea name="description" rows="3" maxlength="4000" placeholder="What these prompts are for.">${values.description || ''}</textarea></label>
<label class="br-field"><span>Kind</span><select name="kind">${kindList.map((k) => html`<option value="${k.id}"${k.id === kind ? raw(' selected') : ''}>${k.name || k.id}${k.id === 'text.answer' ? ' (a plain text answer)' : ''}</option>`)}</select></label>
<fieldset class="br-paste"><legend>Your prompts</legend>
<label class="br-field"><span>Format</span><select name="format">
<option value="auto"${format === 'auto' ? raw(' selected') : ''}>Auto-detect</option>
<option value="lines"${format === 'lines' ? raw(' selected') : ''}>One prompt per line</option>
<option value="csv"${format === 'csv' ? raw(' selected') : ''}>CSV: prompt, expected answer (optional)</option>
</select></label>
<label class="br-field"><span>Paste 5 to 50 prompts</span><textarea class="br-prompts" name="prompts" rows="12" required placeholder="Write a haiku about rain.\nExplain a database index to a new developer.\nWhat is 17 × 24?">${values.prompts || ''}</textarea></label>
<p class="br-fine">One per line, or CSV with an optional expected answer in the second column. A quoted field may hold commas. The benchmark is private by default; you can share a link or publish it after it exists.</p>
</fieldset>
<div class="bm-actions"><button class="bm-btn" type="submit">Make my benchmark</button><a class="bm-btn bm-btn-quiet" href="/benchmarks">Cancel</a></div>
</form>
<p class="br-fine">The prompts are never logged. They are exported and deleted with your account, like the rest of your data, and they are only in a public page if you publish the benchmark.</p>
</div>`;
}

function benchmarkPage({ benchmark, definition, version, rankings, metric = 'score', runs = [], codesRunUrl = null, viewer = null, baseUrl = '', ownBoards = null, share = null, shared = false, owner = false, since = null, allTimeEntries = null }) {
    const d = definition || {};
    const tasks = Array.isArray(d.tasks) ? d.tasks : [];
    const freshSets = [...new Set(tasks.map((t) => (t && t.added_on ? String(t.added_on).slice(0, 7) : null)).filter(Boolean))].sort().reverse();
    const shown = tasks.filter((t) => !t.holdout && t.prompt);
    const hidden = tasks.length - shown.length;
    const judges = Array.isArray(d.judges) ? d.judges : [];
    const limits = d.limits || {};
    const entries = (rankings && rankings.entries) || [];
    const base = benchmarkHref(benchmark.id);
    const canRun = Boolean(codesRunUrl) && !shared;
    const runYourself = shared
        ? ''
        : canRun
            ? html`<a class="bm-btn" href="${benchmarkHref(benchmark.id)}/run">Run it yourself</a>`
            : html`<a class="bm-btn bm-btn-quiet" href="/docs#br-publish">Publish a run</a>`;
    const byline = owner ? 'by you' : shared ? 'by its owner' : `by ${benchmark.owner}`;
    const privateNote = benchmark.visibility === 'private'
        ? html`<div class="bm-note br-private" role="status"><b>Private.</b> Only you can see this benchmark and its prompts. It is not in any list, search or the open data.</div>`
        : shared
            ? html`<div class="bm-note br-shared" role="status"><b>Shared by its owner.</b> This page is not in any list or search engine. The link can stop working if the owner makes it private.</div>`
            : '';
    return html`<div class="bm-wrap br" id="br-benchmark">
<nav class="br-crumbs" aria-label="Breadcrumb"><a href="/benchmarks">Benchmarks</a><span aria-hidden="true">/</span><span>${benchmark.title}</span></nav>
<header class="br-head"><div class="br-head-main"><p class="br-head-meta">${kindChip(benchmark.kind)}<span>v${version || benchmark.latest_version || 0}</span><span>${byline}</span>${benchmark.visibility !== 'public' ? html`<span class="br-chip br-vis">${benchmark.visibility}</span>` : ''}${benchmark.parent ? html`<a href="${benchmarkHref(benchmark.parent)}">forked</a>` : ''}</p>
<h1>${benchmark.title}</h1>${benchmark.description ? html`<p class="bm-lede">${benchmark.description}</p>` : ''}</div>
<div class="br-head-act">${runYourself}<p class="br-fine">${canRun ? 'On openvibe.codes, with your own keys or the free pool through OpenVibe.AI. The result is published here.' : codesRunUrl ? 'Only the owner starts runs on this benchmark. Its results are readable here.' : 'Running it on openvibe.codes with your own keys is coming. Today a run is published through the API.'}</p></div></header>
${privateNote}
<dl class="br-facts"><div><dt>Tasks</dt><dd>${tasks.length}${hidden ? html` <span class="br-fine">(${hidden} hidden)</span>` : ''}</dd></div><div><dt>Judged by</dt><dd>${judges.length ? judges.map((j) => String(j.type).replace(/_/g, ' ')).join(', ') : '—'}</dd></div><div><dt>Limits</dt><dd>${[limits.ms ? fmtMs(limits.ms) : null, limits.tokens ? `${fmtTokens(limits.tokens)} tokens` : null, limits.usd ? fmtUsd(limits.usd) : null].filter(Boolean).join(' · ') || '—'}</dd></div><div><dt>Verified runs</dt><dd>${entries.reduce((n, e) => n + e.runs, 0)}</dd></div></dl>
${owner ? shareBox({ benchmark, shareUrl: share && share.shareUrl, error: share && share.error }) : ''}
<div class="br-sections">
<div class="br-sec-pick" role="radiogroup" aria-label="Benchmark sections">
<input type="radio" name="br-view" id="br-view-rank" value="rank" checked><label for="br-view-rank">Rankings</label>
<input type="radio" name="br-view" id="br-view-tasks" value="tasks"><label for="br-view-tasks">Tasks</label>
<input type="radio" name="br-view" id="br-view-runs" value="runs"><label for="br-view-runs">Runs</label>
</div>
${ownBoards
        ? promptBoards(ownBoards)
        : html`<section class="bm-section" id="br-rank" aria-labelledby="br-rank-h"><div class="bm-head-row"><h2 id="br-rank-h">Rankings</h2>${metricTabs(base, metric)}</div>
${since ? html`<p class="br-since-note" role="status"><b>On tasks since ${since.label}</b>${since.basis === 'runs' ? ' (this benchmark’s tasks carry no dates, so it filters by run date)' : ''}. <a href="${base}?metric=${metric}#br-rank">All-time board</a></p>` : ''}
<form class="br-since" method="get" action="${base}#br-rank"><input type="hidden" name="metric" value="${metric}"><label class="br-field"><span>Fresh set: on tasks since</span><input type="month" name="since" value="${since ? since.month : ''}"></label><button class="bm-btn bm-btn-small" type="submit">Show</button></form>
${freshSets.length ? html`<p class="br-fine br-fresh-sets">Fresh sets: ${freshSets.map((month, i) => html`${i ? ' · ' : ''}<a href="${base}?metric=${metric}&amp;since=${encodeURIComponent(month)}#br-rank">${monthLabel(month)}</a>`)}. Pick one to score only the tasks added that month or later.</p>` : ''}
${valueChart(entries)}
${entries.length ? rankingsTable(entries, metric) : empty(since ? 'No tasks in that fresh set yet' : 'No verified runs yet', since ? 'No run here scored a task added on or after that month. Pick an earlier month, or see the all-time board.' : 'A run counts here once openvibe.codes, Run or a Node worker ran it and published it. Submitted runs are listed below but never ranked.')}
${since && allTimeEntries && allTimeEntries.length ? html`<details class="br-fold br-alltime"><summary>All-time board</summary>${rankingsTable(allTimeEntries, metric)}</details>` : ''}
</section>`}
<section class="bm-section" id="br-tasks" aria-labelledby="br-tasks-h"><div class="bm-head-row"><h2 id="br-tasks-h">Tasks</h2><span class="bm-count">${tasks.length}</span></div>
<ol class="br-tasks">${shown.map((t, i) => {
        const added = t.added_on ? String(t.added_on).slice(0, 10) : null;
        const mins = t.human_minutes == null ? null : Number(t.human_minutes);
        return html`<li class="br-task"><span class="br-task-n">${i + 1}</span><a class="br-task-id br-mono" href="${benchmarkHref(benchmark.id)}/tasks/${encodeURIComponent(t.id)}">${t.id}</a><p>${t.prompt}</p>${t.expected && t.expected.answer ? html`<p class="br-fine br-task-expected">Expected: ${String(t.expected.answer).slice(0, 300)}</p>` : ''}<p class="br-task-meta">${added ? html`<span class="br-chip">added ${added}</span>` : ''}${mins ? html`<span class="br-chip">${fmtMinutes(mins)} human estimate</span>` : ''}</p></li>`;
    })}${hidden ? html`<li class="br-task is-hidden"><span class="br-task-id br-mono">${plural(hidden, 'task')}</span><p>Held out: only the executor sees ${hidden === 1 ? 'it' : 'them'}, so nobody can tune for the answer.</p></li>` : ''}</ol></section>
<section class="bm-section" id="br-runs" aria-labelledby="br-latest-h"><div class="bm-head-row"><h2 id="br-latest-h">Latest runs</h2>${runs.length > 1 ? html`<a class="bm-more" href="${compareHref(runs.slice(0, 2).map((r) => r.id))}">Compare the newest two</a>` : ''}</div>
${runs.length ? runsList(runs) : empty('No runs yet', 'The first run shows up here, verified or submitted.')}</section>
</div>
${benchmark.visibility === 'private' ? '' : benchmarkUseThis({ baseUrl, benchmark, entries, viewer })}
<p class="br-fine br-api">The same data as JSON: <a href="/api/v1/benchmarks/${encodeURIComponent(benchmark.id)}">definition</a> · <a href="/api/v1/rankings?benchmark=${encodeURIComponent(benchmark.id)}&amp;metric=${metric}">rankings</a></p>
</div>`;
}

/**
 * One task: its prompt, when it was added, its human-time estimate and (for a signed-in editor) the form that adds
 * one. The median of three distinct people becomes the task's time. A held-out task keeps its prompt on the server.
 */
function taskPage({ benchmark, version, task, estimates = { count: 0, needed: 3, median: null }, signedIn = false, loginUrl = '/auth/login', error = null, status = null }) {
    const held = Boolean(task && (task.holdout || task.held_out));
    const added = task && task.added_on ? String(task.added_on).slice(0, 10) : null;
    const author = task && task.human_minutes != null ? Number(task.human_minutes) : null;
    const source = task && task.human_minutes_source ? String(task.human_minutes_source) : (author ? 'benchmark author' : null);
    const timed = author != null ? { minutes: author, source } : (estimates.count >= 3 ? { minutes: estimates.median, source: `median of ${estimates.count} editor estimates` } : null);
    return html`<div class="bm-wrap br bm-narrow" id="br-task-page">
<nav class="br-crumbs" aria-label="Breadcrumb"><a href="/benchmarks">Benchmarks</a><span aria-hidden="true">/</span><a href="${benchmarkHref(benchmark.id)}">${benchmark.title}</a><span aria-hidden="true">/</span><span class="br-mono">${task ? task.id : 'task'}</span></nav>
<header class="bm-page-h"><p class="bm-kicker">Task ${task ? task.id : ''} · v${version || benchmark.latest_version || 0}</p><h1>${benchmark.title}</h1><p class="bm-lede">${held ? 'Held-out task: its prompt stays on the server, for the executor only.' : (task && task.prompt) || ''}</p></header>
${error ? html`<div class="bm-note is-bad" role="alert">${error}</div>` : ''}
${held ? html`<div class="bm-note" role="status"><b>Held out.</b> The prompt and expected answer never leave the server. Editors can still give it a human-time estimate.</div>` : ''}
<dl class="br-facts"><div><dt>Added</dt><dd>${added || 'not dated'}</dd></div><div><dt>Human time</dt><dd>${timed ? `${fmtMinutes(timed.minutes)} · ${timed.source}` : 'not enough estimates yet'}</dd></div><div><dt>Editors</dt><dd>${estimates.count} ${estimates.count === 1 ? 'estimate' : 'estimates'}${estimates.count < 3 ? `, ${3 - estimates.count} more for a median` : ''}</dd></div></dl>
${estimates.count >= 3 ? html`<p class="br-fine">The task time is the median of ${estimates.count} signed-in editors’ estimates: <b>${fmtMinutes(estimates.median)}</b>. It is shown here, in the open data and in the time-horizon fit.</p>` : html`<p class="br-fine">The median of three distinct people’s estimates becomes this task’s human time. No individual estimate is published.</p>`}
${signedIn
        ? html`<form class="br-form br-estimate" method="post" action="${benchmarkHref(benchmark.id)}/tasks/${encodeURIComponent(task ? task.id : '')}/estimates">
<input type="hidden" name="version" value="${version || benchmark.latest_version || 1}">
<label class="br-field"><span>Your estimate, in minutes</span><input name="minutes" type="number" min="1" max="100000" step="1" required inputmode="numeric" placeholder="e.g. 40"></label>
<div class="bm-actions"><button class="bm-btn" type="submit">${estimates.count ? 'Replace my estimate' : 'Add my estimate'}</button><a class="bm-btn bm-btn-quiet" href="${benchmarkHref(benchmark.id)}">Back to the benchmark</a></div>
</form>`
        : empty('Sign in to estimate', 'A human-time estimate is attached to your account, exported and deleted with it.', html`<a class="bm-btn bm-btn-small" href="${loginUrl}">Sign in with OpenVibe</a>`)}
</div>`;
}

/**
 * The run form: pick the models, the harnesses and how many times, see what it may cost, start it on openvibe.codes
 * with your own keys. A plain form (it works without JavaScript); the estimate above $1 asks once more.
 */
function runForm({ benchmark, definition, version, signedIn, harnesses = [], suggested = [], picked = null, confirm = null, error = null, loginUrl }) {
    const d = definition || {};
    const tasks = Array.isArray(d.tasks) ? d.tasks.length : 0;
    const usd = Number(d.limits && d.limits.usd) || 0;
    const matrix = d.matrix || {};
    const harnessList = harnesses.length ? harnesses.slice() : (matrix.harnesses || []).map((id) => ({ id, label: id }));
    // Nothing chosen yet: the benchmark's own matrix, else the first harness, so the form starts one tap from ready.
    const p = picked || { models: matrix.models || [], harnesses: (matrix.harnesses || []).length ? matrix.harnesses : harnessList.slice(0, 1).map((h) => h.id), repeat: 1 };
    // Models: the matrix, the ones already ranked here (verified runs), and whatever was typed.
    const modelList = [...new Set([...(matrix.models || []), ...suggested, ...p.models])].slice(0, 16);
    for (const id of p.harnesses) if (!harnessList.some((h) => h.id === id)) harnessList.push({ id, label: id });
    const base = benchmarkHref(benchmark.id);
    const head = html`<nav class="br-crumbs" aria-label="Breadcrumb"><a href="/benchmarks">Benchmarks</a><span aria-hidden="true">/</span><a href="${base}">${benchmark.title}</a><span aria-hidden="true">/</span><span>Run it</span></nav>
<header class="bm-page-h"><p class="bm-kicker">Run it yourself</p><h1>${benchmark.title}</h1><p class="bm-lede">Pick 3 to 6 models. openvibe.codes runs every task on each model and harness, with your own keys through OpenVibe.AI or the free pool, and publishes each run here as verified, whatever it scores.</p></header>`;
    if (!signedIn) {
        return html`<div class="bm-wrap br bm-narrow" id="br-run-form">${head}${empty('Sign in first', 'A run uses your own provider keys, or the free pool, through OpenVibe.AI on openvibe.codes, so it starts as you.', html`<a class="bm-btn bm-btn-small" href="${loginUrl}">Sign in with OpenVibe</a>`)}</div>`;
    }
    const check = (name, value, label, on) => html`<label class="br-check"><input type="checkbox" name="${name}" value="${value}"${on ? raw(' checked') : ''}><span>${label}</span></label>`;
    return html`<div class="bm-wrap br bm-narrow" id="br-run-form">${head}
${error ? html`<div class="bm-note is-bad" role="alert">${error}</div>` : ''}
${confirm === 'unknown' ? html`<div class="bm-note" role="status">This benchmark sets no dollar limit per task, so what it costs depends on the models you pick. It runs on your own keys or the free pool, through OpenVibe.AI. Check the choices below, then confirm.</div>` : confirm != null ? html`<div class="bm-note" role="status">This run may cost up to <b>${fmtUsd(confirm)}</b> on your own keys. Check the choices below, then confirm.</div>` : ''}
<form class="br-form" method="post" action="${base}/run" data-tasks="${tasks}" data-usd="${usd}">
<fieldset><legend>Models</legend>${modelList.length ? html`<div class="br-checks">${modelList.map((m) => check('models', m, m, p.models.includes(m)))}</div>` : ''}
<label class="br-field"><span>${modelList.length ? 'More models, separated by commas' : 'Models, separated by commas (3 to 6)'}</span><input name="more_models" type="text" autocomplete="off" placeholder="deepseek-v4.1-flash, kimi-k3"></label></fieldset>
<fieldset><legend>Harnesses</legend><div class="br-checks">${harnessList.map((h) => check('harnesses', h.id, h.label, p.harnesses.includes(h.id)))}</div></fieldset>
<label class="br-field"><span>Runs of each</span><select name="repeat">${[1, 2, 3, 5].map((n) => html`<option value="${n}"${n === Number(p.repeat) ? raw(' selected') : ''}>${n === 1 ? 'Once' : `${n} times (shows how steady it is)`}</option>`)}</select></label>
<p class="br-fine" data-estimate>${usd > 0 ? `${tasks} ${tasks === 1 ? 'task' : 'tasks'} × your picks × runs, at up to ${fmtUsd(usd)} a task. Over $1 asks you once more.` : `${tasks} ${tasks === 1 ? 'task' : 'tasks'} × your picks × runs. This benchmark sets no dollar limit per task, so you confirm before it starts.`}</p>
${confirm != null ? html`<input type="hidden" name="confirm" value="1">` : ''}
<div class="bm-actions"><button class="bm-btn" type="submit">${confirm != null ? 'Confirm and start' : 'Start on openvibe.codes'}</button><a class="bm-btn bm-btn-quiet" href="${base}">Back</a></div>
</form>
<p class="br-fine">Version v${version || benchmark.latest_version || 0}, frozen: these runs can be compared with every other run of it.</p>
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
<header class="br-head br-run-head"><div class="br-head-main"><p class="br-head-meta">${provenance(run.provenance, run.source)}<span>${fmtDate(run.created_at)}</span></p><h1>${run.model}</h1><p class="bm-lede">on ${benchmark ? benchmark.title : run.benchmark_id}, through ${harnessLabel(run.harness)}</p></div>
<div class="br-head-score">${scoreBar(run.score, { big: true })}<dl class="br-totals"><div><dt>Cost</dt><dd>${fmtUsd(run.cost_usd)}</dd></div><div><dt>Time</dt><dd>${fmtMs(run.ms)}</dd></div><div><dt>Tokens</dt><dd>${fmtTokens(run.tokens)}</dd></div></dl></div></header>
${pctLine}
${sourceLine(run)}
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
<div class="br-table-wrap"><table class="br-table br-cmp"><thead><tr><th scope="col"><span class="br-sr">Measure</span></th>${runs.map((r) => html`<th scope="col"><a href="${runHref(r.id)}">${r.model}</a><span class="br-cmp-sub">${harnessLabel(r.harness)}</span>${provenance(r.provenance, r.source)}</th>`)}</tr></thead><tbody>
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

function modelPage({ model, summary, runs = [], titles = {}, viewer = null, baseUrl = '', horizon = null }) {
    const rows = (summary && summary.benchmarks) || [];
    return html`<div class="bm-wrap br" id="br-model">
<nav class="br-crumbs" aria-label="Breadcrumb"><a href="/benchmarks">Benchmarks</a><span aria-hidden="true">/</span><span>Models</span></nav>
<header class="bm-page-h"><p class="bm-kicker">Model</p><h1 class="br-mono-h">${model}</h1><p class="bm-lede">${summary && summary.runs ? `${plural(summary.runs, 'verified run')} across ${plural(rows.length, 'benchmark')}.` : 'No verified runs yet.'}</p>${horizonLine(horizon)}</header>
<section class="bm-section" aria-labelledby="br-mb-h"><h2 id="br-mb-h">By benchmark</h2>
${rows.length ? html`<div class="br-table-wrap"><table class="br-table"><thead><tr><th scope="col">Benchmark</th><th scope="col">Median</th><th scope="col" class="br-num">Spread</th><th scope="col" class="br-num">Cost / run</th><th scope="col" class="br-num">Time</th><th scope="col" class="br-num">Runs</th></tr></thead><tbody>${rows.map((b) => html`<tr><td><a href="${benchmarkHref(b.benchmark_id)}">${b.title}</a> ${kindChip(b.kind)}</td><td>${scoreBar(b.score)}</td><td class="br-num">${b.runs > 1 ? `${fmtScore(b.worst)}–${fmtScore(b.best)}` : '—'}</td><td class="br-num">${fmtUsd(b.cost_usd)}</td><td class="br-num">${fmtMs(b.ms)}</td><td class="br-num">${b.runs}</td></tr>`)}</tbody></table></div>` : empty('Nothing measured yet', 'This model shows up here after its first verified run.', html`<a class="bm-btn bm-btn-small" href="/benchmarks">Pick a benchmark</a>`)}</section>
${runs.length ? html`<section class="bm-section" aria-labelledby="br-mr-h"><h2 id="br-mr-h">Latest runs</h2>${runsList(runs, { showBenchmark: true, titles })}</section>` : ''}
${modelUseThis({ baseUrl, model, rows, viewer })}
</div>`;
}

module.exports = {
    benchmarksIndex, benchmarkPage, newBenchmarkPage, promptLeaderboard, promptBoards, shareBox,
    runForm, runPage, comparePage, modelPage, taskPage, valueChart, METRICS,
    fmtMinutes, horizonText, horizonLine,
    fmtScore, fmtUsd, fmtMs, fmtTokens, ordinal, benchmarkCard, render,
};

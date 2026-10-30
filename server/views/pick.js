'use strict';

/**
 * The pick page (spec 3): plain controls, then the frontier as a table, then one sample output per model.
 * The page works without JavaScript: the form is a GET, and the words in the free-text box are read on the server.
 */

const { html, raw } = require('../render/html');
const { frame } = require('../http/gallery');
const { PRICE_STEPS } = require('../pick/pick');
const { KINDS } = require('../kinds');

const cents = (v) => (v == null ? '—' : (Math.round(v * 10000) / 100) + '¢');
const msText = (v) => (v == null ? '—' : v >= 1000 ? (Math.round(v / 100) / 10) + 's' : Math.round(v) + 'ms');

function pickForm(controls) {
    const kinds = KINDS.map((k) => html`<option value="${k.id}"${k.id === controls.kind ? ' selected' : ''}>${k.name}</option>`);
    const prices = [html`<option value=""${controls.max_cost == null ? ' selected' : ''}>Any price</option>`].concat(
        PRICE_STEPS.map((p) => html`<option value="${p.value}"${controls.max_cost != null && Math.abs(controls.max_cost - p.value) < 1e-9 ? ' selected' : ''}>${p.label}</option>`));
    return html`<form class="pk-form" method="get" action="/pick" data-pk-form="1">
<label>Kind<select name="kind">${kinds}</select></label>
<label>Top price per solved task<select name="max_cost">${prices}</select></label>
<label class="pk-check"><input type="checkbox" name="fast" value="1"${controls.fast ? ' checked' : ''}> Fast</label>
<label class="pk-words">Or say it in words<input type="text" name="q" value="${controls.q || ''}" placeholder="landing page under 2 cents, fast"></label>
<button class="bm-btn" type="submit">Pick</button>
</form>`;
}

function pickTable(a) {
    if (!a.rows.length) {
        return html`<div class="bm-empty"><h1>Nothing to pick yet</h1><p>${a.counts.models
            ? 'No model on this frontier has both a score and a cost per solved task yet, so there is no answer to give. Nothing is guessed here.'
            : 'No model has run this kind yet, so there is nothing to compare. The answer appears as soon as runs are published.'}</p></div>`;
    }
    const rows = a.rows.map((r) => html`<tr class="${r.thin ? 'pk-thin' : ''}">
<td><a class="br-model" href="/models/${r.model}">${r.model}</a></td>
<td><span class="pk-score">${r.score}</span> <span class="pk-band">${r.band ? 'band ' + r.band : 'no band yet'}</span></td>
<td class="br-num">${cents(r.cost_per_solved)}</td>
<td class="br-num">${msText(r.median_ms)}</td>
<td class="br-num">${r.runs}${r.thin ? html` <span class="pk-thin-note">too few runs</span>` : ''}</td>
</tr>`);
    return html`<div class="br-table-wrap"><table class="br-table pk-table"><thead><tr>
<th scope="col">Model</th><th scope="col">Score</th><th scope="col" class="br-num">Cost per solved task</th>
<th scope="col" class="br-num">Median time</th><th scope="col" class="br-num">Runs</th>
</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function pickSamples(a) {
    const withSample = a.rows.filter((r) => r.sample);
    if (!withSample.length) return '';
    return html`<section class="bm-section" aria-labelledby="pk-samples-h"><h2 id="pk-samples-h">One output each</h2>
<p class="bm-fine">The newest published output of every model on the frontier, live in its sandboxed frame.</p>
<div class="pk-samples">${withSample.map((r) => html`<article class="pk-card">
<h3 class="pk-card-h">${r.model}</h3>
<div class="pk-shot">${raw(frame(r.sample, !r.sample.screenshot))}</div>
<p class="bm-fine pk-prompt">${r.sample.prompt}</p>
</article>`)}</div></section>`;
}

function pickPage(a) {
    const notes = (a.controls.notes || []).length
        ? html`<p class="pk-notes bm-fine">Read from the words: ${a.controls.notes.join('; ')}.</p>`
        : '';
    const thin = a.rows.filter((r) => r.thin).length;
    const thinNote = thin
        ? html`<p class="pk-thin-note bm-fine">${thin} model${thin === 1 ? '' : 's'} on this frontier have fewer than ${a.filters.min_runs} runs. Their numbers are shown greyed, because that is all the data there is.</p>`
        : '';
    const fastNote = a.filters.fast && a.filters.fast_cap_ms != null
        ? html`<p class="bm-fine">Fast: a median time of ${msText(a.filters.fast_cap_ms)} a task or under, the middle of the run times.</p>`
        : '';
    const also = (a.also_ran || []).length ? html`<section class="bm-section" aria-labelledby="pk-also-h"><h2 id="pk-also-h">Also ran this kind</h2>
<ul class="pk-also">${(a.also_ran || []).map((r) => html`<li class="${r.thin ? 'pk-thin' : ''}"><b>${r.model}</b> · score ${r.score} · ${cents(r.cost_per_solved)} a solved task · ${r.runs} run${r.runs === 1 ? '' : 's'}${r.thin ? ' — too few runs to stand on, so these numbers are greyed' : ' — another model is at least as good on score and at least as cheap'}</li>`)}</ul>
</section>` : '';
    return html`<div class="bm-wrap pk" id="pk-pick">
<header class="bm-page-h"><p class="bm-kicker">OpenVibe.Bench</p><h1>Pick for me</h1>
<p class="bm-lede">Say the job with plain controls. No model is called and nothing is charged: the answer comes from the runs Bench has published.</p></header>
${pickForm(a.controls)}
<p class="bm-fine">The free-text box is read by a plain parser, never by a model. It only sets the three controls above.</p>
${notes}
<section class="bm-section pk-answer" aria-labelledby="pk-answer-h">
<h2 id="pk-answer-h">The frontier for ${a.kind.name}</h2>
<p class="pk-why">${a.why}</p>
${fastNote}
${pickTable(a)}
${thinNote}
</section>
${also}
${pickSamples(a)}
</div>`;
}

module.exports = { pickPage, pickForm, pickTable, pickSamples };

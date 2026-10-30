'use strict';

/**
 * "Use this" (spec 3): the copy boxes. A benchmark and a model page carry the badge's Markdown and HTML; the battle
 * page carries the embed's iframe snippet. The boxes are plain textareas, so copying works without JavaScript.
 */

const { html } = require('../render/html');

/** The badge's URL for a benchmark and a model. */
function badgeUrl(baseUrl, benchmarkId, model) {
    return String(baseUrl || '').replace(/\/+$/, '') + '/badge/' + encodeURIComponent(benchmarkId) + '/' + encodeURIComponent(model) + '.svg';
}

/** The Markdown and the HTML of the badge. */
function badgeSnippets(baseUrl, benchmarkId, model, title) {
    const url = badgeUrl(baseUrl, benchmarkId, model);
    const alt = (title ? title + ' on OpenVibe Bench' : 'OpenVibe Bench') + ' badge';
    return { markdown: '![' + alt + '](' + url + ')', html: '<img src="' + url + '" alt="' + alt + '">' };
}

/** The embed's snippet: an iframe that may be framed by other sites. */
function embedSnippets(baseUrl, battleId, title) {
    const url = String(baseUrl || '').replace(/\/+$/, '') + '/embed/battle/' + encodeURIComponent(battleId);
    const name = title || 'OpenVibe Bench battle';
    return {
        markdown: '[' + name + '](' + url + ')',
        html: '<iframe src="' + url + '" width="100%" height="560" style="border:0" loading="lazy" title="' + name + '"></iframe>',
    };
}

/** A copy box: one textarea per snippet. */
function copyBox({ heading, pairs }) {
    return html`<div class="br-usethis-box"><h3 class="br-usethis-h">${heading}</h3>
${pairs.map((p) => html`<label class="br-usethis-row"><span class="br-fine">${p.label}</span><textarea readonly rows="2" aria-label="${p.label}">${p.value}</textarea></label>`)}
</div>`;
}

/** The follow form: a plain POST, so it works without JavaScript. */
function followForm({ benchmarkId, model = null, back = '/watching', signedIn = false }) {
    if (!signedIn) return html`<p class="br-fine">Sign in to follow this, and Bench will tell you when it moves.</p>`;
    return html`<form class="br-follow" method="post" action="/watch/follow">
<input type="hidden" name="benchmark_id" value="${benchmarkId}">
${model ? html`<input type="hidden" name="model" value="${model}">` : ''}
<input type="hidden" name="back" value="${back}">
<button class="bm-btn bm-btn-small" type="submit">${model ? 'Follow this model' : 'Follow this benchmark'}</button>
</form>`;
}

/** The benchmark page: a badge for each model it ranks, and the follow button. */
function benchmarkUseThis({ baseUrl, benchmark, entries = [], viewer = null, back = '' }) {
    const boxes = entries.slice(0, 4).map((e) => {
        const s = badgeSnippets(baseUrl, benchmark.id, e.model, benchmark.title);
        return copyBox({ heading: e.model, pairs: [{ label: 'Markdown', value: s.markdown }, { label: 'HTML', value: s.html }] });
    });
    // Closed by default: the badge snippets are useful, but they are not the page's reason to exist.
    return html`<section class="bm-section br-usethis" aria-labelledby="br-use-h"><details class="br-usethis-details"><summary><h2 id="br-use-h">Badges and embeds</h2></summary>
<p class="br-fine">A badge for your README, and a watch that tells you when this benchmark moves.</p>
${boxes}
${followForm({ benchmarkId: benchmark.id, back: back || ('/benchmarks/' + benchmark.id), signedIn: Boolean(viewer && viewer.kind === 'user') })}
</details></section>`;
}

/** The model page: a badge for each benchmark the model ran, and a watch for each. */
function modelUseThis({ baseUrl, model, rows = [], viewer = null, back = '' }) {
    const boxes = rows.slice(0, 4).map((b) => {
        const s = badgeSnippets(baseUrl, b.benchmark_id, model, b.title);
        return html`<div class="br-usethis-box"><h3 class="br-usethis-h">${b.title}</h3>
<label class="br-usethis-row"><span class="br-fine">Markdown</span><textarea readonly rows="2" aria-label="Markdown">${s.markdown}</textarea></label>
<label class="br-usethis-row"><span class="br-fine">HTML</span><textarea readonly rows="2" aria-label="HTML">${s.html}</textarea></label>
${followForm({ benchmarkId: b.benchmark_id, model, back: back || ('/models/' + encodeURIComponent(model)), signedIn: Boolean(viewer && viewer.kind === 'user') })}
</div>`;
    });
    return html`<section class="bm-section" aria-labelledby="br-use-h"><h2 id="br-use-h">Use this</h2>
<p class="br-fine">A badge for your README, and a watch for each benchmark this model ran.</p>
${boxes}
</section>`;
}

/** The battle page: the embed's iframe snippet. */
function battleUseThis({ baseUrl, battle, title }) {
    const s = embedSnippets(baseUrl, battle.id, title);
    return html`<section class="bm-section br-usethis" aria-labelledby="br-use-h"><h2 id="br-use-h">Use this</h2>
<p class="br-fine">An embed of this battle for another site. It may be framed; voting opens Bench in a new tab.</p>
<label class="br-usethis-row"><span class="br-fine">HTML</span><textarea readonly rows="3" aria-label="HTML">${s.html}</textarea></label>
</section>`;
}

module.exports = { badgeUrl, badgeSnippets, embedSnippets, copyBox, followForm, benchmarkUseThis, modelUseThis, battleUseThis };

'use strict';

/**
 * The Watching page (spec 6): the benchmarks and models a person follows, with an unfollow button on each.
 * The buttons are plain forms, so the page works without JavaScript.
 */

const { html } = require('../render/html');

function watchingPage(watches, { viewer = null } = {}) {
    const items = watches.map((w) => html`<li class="wk-item">
<div class="wk-what"><b>${w.benchmark_title || w.benchmark_id}</b>
${w.model ? html`<span class="br-chip">${w.model}</span>` : html`<span class="br-chip">the whole benchmark</span>`}
<span class="bm-fine">followed since ${String(w.created_at || '').slice(0, 10)}</span></div>
<form method="post" action="/watch/unfollow" class="wk-form">
<input type="hidden" name="id" value="${w.id}">
<button class="bm-btn bm-btn-quiet bm-btn-small" type="submit">Unfollow</button>
</form>
</li>`);
    return html`<div class="bm-wrap wk" id="wk-watching">
<header class="bm-page-h"><p class="bm-kicker">OpenVibe.Bench</p><h1>Watching</h1>
<p class="bm-lede">The benchmarks and models you follow. When a score moves by more than its own interval, or a model overtakes another one, Bench tells the Network and the notice lands in your Action Center. One notice a day per watch.</p></header>
${viewer && viewer.kind === 'user' ? '' : html`<p class="bm-fine"><a class="bm-btn bm-btn-small" href="/auth/login?next=%2Fwatching">Sign in with OpenVibe</a> to follow a benchmark or a model.</p>`}
${watches.length ? html`<ul class="wk-list">${items}</ul>` : html`<div class="bm-empty"><h1>Nothing followed yet</h1><p>Follow a benchmark from its page, or a model on a benchmark from the model's page.</p></div>`}
</div>`;
}

module.exports = { watchingPage };

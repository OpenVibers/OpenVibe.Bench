'use strict';

/**
 * The pages of an import (B12): the upload form and the preview. Both are plain forms: they work without
 * JavaScript, they are narrow enough for a phone, and they say plainly what will happen.
 */
const { html, raw } = require('../render/html');

const TOOLS = [
    { key: 'inspect', label: 'Inspect AI', hint: 'an .eval log (a zip) or its JSON log' },
    { key: 'harbor', label: 'Harbor', hint: 'the results.json of a Harbor job' },
    { key: 'lm-eval', label: 'lm-evaluation-harness', hint: 'the results.json of a run' },
    { key: 'promptfoo', label: 'promptfoo', hint: 'the output.json of promptfoo eval -o' },
];

const fmtDate = (v) => {
    if (!v) return '';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

function uploadPage({ signedIn = false, loginUrl = '/auth/login', error = null, imports = [] } = {}) {
    const head = html`<nav class="br-crumbs" aria-label="Breadcrumb"><a href="/benchmarks">Benchmarks</a><span aria-hidden="true">/</span><span>Bring your results</span></nav>
<header class="bm-page-h"><p class="bm-kicker">Bring your results</p><h1>Import a results file</h1><p class="bm-lede">Run your evals with the tools you already use, then bring the file here. Every run it holds becomes a submitted run: Bench never calls them verified, because nobody re-ran them.</p></header>`;
    if (!signedIn) {
        return html`<div class="bm-wrap br bm-narrow" id="br-import">${head}<div class="br-note" role="alert">Sign in first: the file is your own, and it stays yours until you share it.</div><p><a class="bm-btn" href="${loginUrl}">Sign in with OpenVibe</a></p></div>`;
    }
    const rows = imports.map((i) => html`<li class="br-import-row"><a href="/imports/${encodeURIComponent(i.id)}">${i.filename || 'results'}</a><span class="br-fine">${i.tool} ${i.tool_version} · ${fmtDate(i.created_at)} · ${i.status === 'imported' ? 'imported' : 'waiting for you'}</span></li>`);
    return html`<div class="bm-wrap br bm-narrow" id="br-import">${head}
${error ? html`<div class="br-note is-bad" role="alert">${error}</div>` : ''}
<form method="post" action="/imports" enctype="multipart/form-data" class="bm-form">
    <p class="bm-field"><label for="br-file">The results file</label>
    <input id="br-file" name="file" type="file" accept=".json,.eval,application/json,application/zip" required></p>
    <p class="bm-field"><label for="br-tool">Which tool wrote it</label>
    <select id="br-tool" name="tool">
        <option value="">Let me see (I will work it out)</option>
        ${TOOLS.map((t) => html`<option value="${t.key}">${t.label} — ${t.hint}</option>`)}
    </select></p>
    <p class="br-fine">Up to 20 MB. A zip is opened in memory and never unpacked onto the disk, and nothing inside it is ever run.</p>
    <p><button class="bm-btn" type="submit">Read the file</button></p>
</form>
${rows.length ? html`<section class="bm-section"><h2>Your uploads</h2><ul class="br-imports">${rows}</ul></section>` : ''}
</div>`;
}

function previewPage({ imp, benchmark = null, error = null } = {}) {
    const summary = imp.summary || {};
    const models = summary.models || [];
    const taskCount = (imp.summary && imp.summary.models || []).reduce((n, m) => n + ((m.tasks || []).length), 0);
    const suite = summary.suite ? summary.suite.name : null;
    const head = html`<nav class="br-crumbs" aria-label="Breadcrumb"><a href="/imports">Bring your results</a><span aria-hidden="true">/</span><span>Preview</span></nav>
<header class="bm-page-h"><p class="bm-kicker">Preview</p><h1>${models.length} model${models.length === 1 ? '' : 's'}, ${taskCount} task${taskCount === 1 ? '' : 's'}, from ${imp.tool} ${imp.tool_version}</h1><p class="bm-lede">Import? Every run below is submitted, not verified, and says which tool it came from.</p></header>`;
    const list = models.map((m) => html`<li><b>${m.model}</b><span class="br-fine">${m.score == null ? '' : ' · score ' + Math.round(m.score)} · ${(m.tasks || []).length} task${(m.tasks || []).length === 1 ? '' : 's'}${m.cost_usd ? ' · $' + m.cost_usd : ''}</span></li>`);
    return html`<div class="bm-wrap br bm-narrow" id="br-import-preview">${head}
${error ? html`<div class="br-note is-bad" role="alert">${error}</div>` : ''}
<ul class="br-plain">${list}</ul>
<dl class="br-env"><div><dt>File</dt><dd>${imp.filename}</dd></div><div><dt>Tool</dt><dd>${imp.tool} ${imp.tool_version}</dd></div><div><dt>Suite</dt><dd>${suite || 'none named'}</dd></div><div><dt>Date in the file</dt><dd>${fmtDate(summary.date) || 'not stated'}</dd></div></dl>
${suite ? html`<p class="br-fine">Bench knows this suite: the runs join its benchmark. Otherwise this becomes a private benchmark of your own, which you can share later.</p>` : html`<p class="br-fine">This becomes a private benchmark of your own, which you can share later.</p>`}
<form method="post" action="/imports/${encodeURIComponent(imp.id)}/confirm" class="bm-form">
    <p><button class="bm-btn" type="submit">Import these runs</button></p>
</form>
<p class="br-fine"><a href="/imports">Cancel</a></p>
</div>`;
}

module.exports = { uploadPage, previewPage, TOOLS };

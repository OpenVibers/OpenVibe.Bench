'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): one or two screens, app-like.
 *
 *   foldBlock()  a part a reader rarely needs: closed on a phone, where the title row opens it, and open where there
 *                is room, where it looks like the section it replaces. A checkbox and a label, no script: the part
 *                stays in the page for the crawlers, and a browser without CSS shows it as it was.
 *   pickBlock()  several blocks of the same kind; on a phone every pane is shown, stacked, each with its own heading,
 *                and the chips are a row of links that jump to a pane (the owner's rule, 2026-10-31: never hide
 *                content to shorten). A wider screen shows the panes as before, with no chips.
 *
 * The CSS for both lives in the site's own stylesheet.
 */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A piece of markup as a string: a plain string, or the raw html a template returned. */
const str = (v) => (v && typeof v === 'object' && typeof v.s === 'string') ? v.s : String(v == null ? '' : v);

/**
 * A fold. The head is the heading the block had (an <h2>, so it stays a heading on a phone too); the html is what it
 * holds. `bare` is for a part that keeps its own heading in the body: where there is room the title row gives way to
 * it, so the part looks exactly as it did.
 *
 *   foldBlock({ id, head, html, bare })
 */
/**
 * What a fold holds, counted, for its line ("7 questions", "latest 5", "3 items"): a folded part still says how much
 * is behind it (the owner's rule, 2026-10-31: folds show their count). The 11-01 pass missed this checkbox fold.
 */
function foldMeta(body, cls = '') {
    const s = typeof body === 'string' ? body : String((body && (body.s || body.html || body.value)) || body || '');
    const n = (re) => (s.match(re) || []).length;
    const shipped = /data-ov-shipped="list"[^>]*?data-limit="(\d+)"|data-limit="(\d+)"[^>]*?data-ov-shipped="list"/.exec(s);
    const q = n(/<details[\s>]/g), li = n(/<li[\s>]/g), a = n(/<a\s/g);
    const text = shipped ? `latest ${shipped[1] || shipped[2]}` : q > 1 ? `${q} questions` : li > 1 ? `${li} items` : a > 1 ? `${a} links` : '';
    return text ? `<span${cls ? ` class="${cls}"` : ''}>${text}</span>` : '';
}

function foldBlock({ id, head, html, bare = false }) {
    const key = `fold-${esc(id)}`;
    return `<div class="fold${bare ? ' fold-bare' : ''}" id="${key}">`
        + `<input class="fold-toggle" type="checkbox" id="${key}-open">`
        + `<label class="fold-h" for="${key}-open">${str(head)}${foldMeta(str(html), 'fold-n')}<span class="fold-mark" aria-hidden="true"></span></label>`
        + `<div class="fold-body">${str(html)}</div></div>`;
}

/**
 * A pick block. The panes are the page's own blocks; each one keeps its heading on a wide screen, and on a phone every
 * pane is shown, stacked, each with its own heading, with a row of link chips that jump to a pane.
 *
 *   pickBlock({ key, label, head, panes })   panes: [{ id, label, html }]
 */
function pickBlock({ key, label, head = '', panes }) {
    if (!panes.length) return '';
    const chips = panes.map((p) => {
        const paneId = `pp-${esc(key)}-${esc(p.id)}`;
        return `<a class="pick-chip" href="#${paneId}">${esc(p.label)}</a>`;
    }).join('');
    const body = panes.map((p) => `<div class="pick-pane" id="pp-${esc(key)}-${esc(p.id)}">${str(p.html)}</div>`).join('');
    return `<div class="pick" id="pick-${esc(key)}"><div class="pick-bar"><div class="pick-head"><h2>${esc(head || label)}</h2></div><nav class="pick-row" aria-label="${esc(label)}">${chips}</nav></div><div class="pick-body">${body}</div></div>`;
}

module.exports = { foldBlock, pickBlock };

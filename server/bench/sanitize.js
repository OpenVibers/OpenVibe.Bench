'use strict';

/**
 * Generated HTML safety (kept from the Design Arena and generalised: Bench stores model output as text and never
 * puts it in its own document). Two layers:
 *
 *   1. sanitizeHtml(): strip <script>, on* attributes, javascript: URLs and navigation tags before storing.
 *   2. iframeHtml(): render only inside `<iframe sandbox srcdoc="…">` with no scripts and a CSP that blocks
 *      every network fetch.
 */

const MAX_BYTES = 200 * 1024;
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const attrEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function urlLooksLikeScript(raw) {
    const decoded = String(raw)
        .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&colon;?/gi, ':').replace(/&tab;?/gi, '\t').replace(/&newline;?/gi, '\n');
    return /javascript\s*:/i.test(decoded.replace(/[\s\u0000-\u001f]+/g, ''));
}

function tagEnd(s, start) {
    let quote = null;
    for (let i = start + 1; i < s.length; i++) {
        const c = s[i];
        if (quote) { if (c === quote) quote = null; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') return i;
    }
    return -1;
}

function sanitizeTag(tag) {
    let t = tag;
    t = t.replace(/([\s/])on[a-z0-9_:.-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
    t = t.replace(/\s(on[a-z0-9_:.-]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    t = t.replace(/(\b(?:href|src|action|formaction|xlink:href|poster|background|data)\s*=\s*)((?:"[^"]*"|'[^']*'|[^\s>]+))/gi,
        (m, name, value) => (urlLooksLikeScript(value) ? `${name}"#"` : m));
    return t;
}

function sanitizeTags(s) {
    let out = '';
    let i = 0;
    while (i < s.length) {
        const lt = s.indexOf('<', i);
        if (lt === -1) { out += s.slice(i); break; }
        out += s.slice(i, lt);
        const next = s[lt + 1] || '';
        if (!/[a-z/]/i.test(next)) { out += '<'; i = lt + 1; continue; }
        const end = tagEnd(s, lt);
        if (end === -1) { out += s.slice(lt); break; }
        out += sanitizeTag(s.slice(lt, end + 1));
        i = end + 1;
    }
    return out;
}

function truncateBytes(s, maxBytes) {
    if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
    const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes);
    let out = buf.toString('utf8');
    if (out.endsWith('\uFFFD')) out = out.slice(0, -1);
    return out;
}

function sanitizeHtml(input, { maxBytes = MAX_BYTES } = {}) {
    let s = input == null ? '' : String(input);
    s = s.replace(/\u0000/g, '');
    s = truncateBytes(s, maxBytes);
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    for (let i = 0; i < 4; i++) {
        const before = s;
        s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
        s = s.replace(/<script\b[^>]*\/\s*>/gi, '');
        if (s === before) break;
    }
    s = s.replace(/<\/?script\b[^>]*>/gi, '');
    s = s.replace(/<(\/?)(script)\b/gi, '&lt;$1$2');
    s = s.replace(/<base\b[^>]*>/gi, '');
    s = s.replace(/<meta\b[^>]*http-equiv\s*=\s*(?:"refresh"|'refresh'|refresh)[^>]*>/gi, '');
    s = s.replace(/<\/?(?:iframe|object|embed|applet)\b[^>]*>/gi, '');
    s = sanitizeTags(s);
    s = s.replace(/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, 'blocked:');
    if (/<script/i.test(s)) s = s.replace(/<(\/?)(script)/gi, '&lt;$1$2');
    return truncateBytes(s, maxBytes);
}

function frameDocument(html) {
    return `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
        + `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
        + `<style>html,body{margin:0;min-height:100%;background:#fff;}img{max-width:100%;height:auto;}</style>`
        + sanitizeHtml(html);
}

function iframeHtml({ html = '', width = 390, height = 844, title = 'A generated output', id = null, className = '' } = {}) {
    const w = Math.max(1, Math.round(Number(width) || 390));
    const h = Math.max(1, Math.round(Number(height) || 844));
    return `<iframe${id ? ` id="${esc(id)}"` : ''} class="bm-frame${className ? ` ${esc(className)}` : ''}"`
        + ` title="${esc(title)}" width="${w}" height="${h}" data-width="${w}"`
        + ` sandbox="" loading="lazy" referrerpolicy="no-referrer"`
        + ` srcdoc="${attrEscape(frameDocument(html))}"></iframe>`;
}

module.exports = { sanitizeHtml, frameDocument, iframeHtml, truncateBytes, MAX_BYTES, CSP, attrEscape, urlLooksLikeScript };

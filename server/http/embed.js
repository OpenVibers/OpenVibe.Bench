'use strict';

/**
 * The battle embed (spec 3): /embed/battle/:id
 *
 * A page of one battle that another site may frame. Only this route may be framed: every other route keeps refusing
 * frames. The page reads and writes no cookie, the outputs stay in their sandboxed frames, and voting opens Bench in
 * a new tab: the widget itself never posts anything.
 */

const express = require('express');
const { esc } = require('../render/html');
const renderLib = require('../bench/render');
const { kindById } = require('../kinds');

/**
 * The style of the embed page. It stands alone on someone else's site, so it takes no theme of ours: the visitor's
 * own light or dark setting paints it through the browser's system colours, which adapt by themselves.
 */
const STYLE = [
    ':root{color-scheme:light dark;--em-bg:Canvas;--em-text:CanvasText;--em-muted:GrayText;--em-line:color-mix(in srgb,CanvasText 22%,transparent);--em-panel:color-mix(in srgb,CanvasText 6%,Canvas);--em-fill:Highlight;--em-on:HighlightText}',
    'body{margin:0;background:var(--em-bg);color:var(--em-text);font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:12px}',
    '.em-wrap{display:grid;gap:10px;max-width:900px;margin:0 auto}',
    '.em-h{font-size:.95rem;font-weight:700;margin:0;overflow-wrap:anywhere}',
    '.em-p{font-size:.86rem;margin:0;color:var(--em-muted);line-height:1.5}',
    '.em-panes{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))}',
    '.em-pane{margin:0;border:1px solid var(--em-line);border-radius:12px;overflow:hidden;background:var(--em-panel)}',
    '.em-pane iframe{display:block;width:100%;aspect-ratio:16/10;height:auto;border:0}',
    '.em-cap{font-size:.78rem;padding:6px 8px;margin:0;color:var(--em-muted);font-weight:600;overflow-wrap:anywhere}',
    '.em-links{display:flex;flex-wrap:wrap;gap:10px;align-items:center}',
    '.em-link{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;border-radius:999px;background:var(--em-fill);color:var(--em-on);font-weight:700;font-size:.86rem;text-decoration:none}',
    '.em-back{font-size:.78rem;color:var(--em-muted);text-decoration:none}',
    '.em-link:focus-visible,.em-back:focus-visible{outline:2px solid var(--em-fill);outline-offset:2px}',
].join('');

/** The question a battle asks, which is an object on the battle and a string on an old one. */
function questionText(question, kind) {
    if (typeof question === 'string' && question) return question;
    if (question && typeof question.text === 'string' && question.text) return question.text;
    return kind ? 'Two ' + kind.name + ' outputs, side by side.' : 'Two outputs, side by side.';
}

const pane = (entry, label) => '<figure class="em-pane">'
    + '<iframe src="' + esc(renderLib.RENDER_ORIGIN + '/render/w/' + encodeURIComponent(entry.id)) + '"'
    + ' title="' + esc(label + ' output') + '" sandbox="' + esc(renderLib.WRAPPER_SANDBOX) + '"'
    + ' referrerpolicy="no-referrer" loading="lazy"></iframe>'
    + '<figcaption class="em-cap">' + esc(label) + '</figcaption></figure>';

/** The embed page for one battle. */
function embedHtml(battle, { baseUrl }) {
    const kind = kindById(battle.kind_id);
    const label = (e) => String(e.model || 'model');
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<meta name="robots" content="noindex, nofollow">'
        + '<title>' + esc((kind ? kind.name : battle.kind_id) + ' — OpenVibe Bench') + '</title>'
        + '<style>' + STYLE + '</style></head><body><div class="em-wrap">'
        + '<h1 class="em-h">' + esc(battle.prompt || (kind ? kind.name : battle.kind_id)) + '</h1>'
        + '<p class="em-p">' + esc(questionText(battle.question, kind)) + '</p>'
        + '<div class="em-panes">' + pane(battle.a, label(battle.a)) + pane(battle.b, label(battle.b)) + '</div>'
        + '<div class="em-links">'
        + '<a class="em-link" href="' + esc(baseUrl + '/battle') + '" target="_blank" rel="noopener">Vote on OpenVibe Bench</a>'
        + '<a class="em-back" href="' + esc(baseUrl + '/battle/revealed/' + battle.id) + '" target="_blank" rel="noopener">OpenVibe Bench</a>'
        + '</div></div></body></html>';
}

function createEmbedRoutes(ctx) {
    const r = express.Router();
    r.get('/battle/:id', async (req, res) => {
        const battle = await ctx.battles.battleOf(String(req.params.id || ''));
        if (!battle) {
            res.status(404);
            res.set('Content-Type', 'text/html; charset=utf-8');
            res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors *");
            res.set('X-Content-Type-Options', 'nosniff');
            res.removeHeader('X-Frame-Options');
            return res.send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow">'
                + '<title>No such battle</title><style>' + STYLE + '</style></head><body><div class="em-wrap">'
                + '<h1 class="em-h">No such battle</h1><p class="em-p">This battle is not here.</p></div></body></html>');
        }
        const baseUrl = ctx.config.baseUrl || 'https://bench.openvibe.services';
        res.status(200);
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-src " + renderLib.RENDER_ORIGIN
            + "; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors *");
        res.set('X-Content-Type-Options', 'nosniff');
        res.removeHeader('X-Frame-Options');
        res.set('Cache-Control', 'public, max-age=60');
        return res.send(embedHtml(battle, { baseUrl }));
    });
    return r;
}

module.exports = { createEmbedRoutes, embedHtml };

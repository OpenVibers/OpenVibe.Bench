'use strict';

/**
 * The Bench pages live on OpenVibe.Compare (11-13, the owner: every AI comparison and leaderboard is Compare's; from
 * 11-08 they were Report's AI section, which now forwards to Compare). Every public HTML page answers one permanent
 * redirect to its Compare counterpart (the same /ai paths); the API, MCP, render origin, badges, embeds, sign-in, legal pages
 * and static assets stay here. A redirect keeps its query string only where Compare reads one (`?tab=`).
 *
 *   /                         → /ai
 *   /benchmarks               → /ai
 *   /benchmarks/<id>          → /ai/<id> when it is public and the viewer is not its owner; otherwise the page
 *                               stays here, because Compare reads only Bench's public API (a private benchmark,
 *                               a named reader and a share link have no Report page).
 *   /models/<model>           → /ai/models/<model>
 *   /compare                  → /ai/compare
 *   /docs                     → /ai/method
 *   /showcase, /gallery, …    → /ai
 *
 * The owner's pages stay here: /benchmarks/mine (the default audience and the person's own list), /benchmarks/new,
 * an unlisted share link (/b/<token>), and the noindex task and run pages.
 */

const DEFAULT_COMPARE = 'https://openvibe.compare';
const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Paths that are machine endpoints, frames or not pages of the old Bench site: never redirected. */
const KEEP = [/^\/render(?:\/|$)/, /^\/vendor(?:\/|$)/, /^\/badge(?:\/|$)/, /^\/embed(?:\/|$)/,
    /^\/api(?:\/|$)/, /^\/mcp(?:\/|$)/, /^\/auth(?:\/|$)/, /^\/shared(?:\/|$)/, /^\/\.well-known(?:\/|$)/,
    /^\/metrics(?:\/|$)/, /^\/release(?:\.json|-metrics)?(?:\/|$)/, /^\/robots\.txt$/, /^\/sitemap\.xml$/,
    /^\/favicon\.ico$/, /^\/assets(?:\/|$)/,
    // The owner's pages and the pages Compare cannot render: the person's list and default, the create form, an
    // unlisted share link, and the noindex task/run pages. /benchmarks/<id> itself is decided by its page route.
    /^\/benchmarks\/mine(?:\/|$)/, /^\/benchmarks\/new(?:\/|$)/,
    /^\/benchmarks\/[^/]+\/(?:run|tasks\/[^/]+)(?:\/|$)/, /^\/b\/[^/]+$/];

function targetFor(pathname, compareUrl) {
    const base = String(compareUrl || DEFAULT_COMPARE).replace(/\/+$/, '');
    const p = String(pathname || '/');
    if (p === '/' || p === '') return `${base}/ai`;
    if (p === '/docs' || p === '/docs/') return `${base}/ai/method`;
    if (p === '/compare' || p === '/compare/') return `${base}/ai/compare`;
    if (p === '/benchmarks' || p === '/benchmarks/') return `${base}/ai`;
    // A benchmark's own page decides: public pages redirect from the route (which knows the viewer and the
    // benchmark's owner), while a private benchmark, a named reader and an unlisted link stay on Bench.
    const bench = /^\/benchmarks\/([^/]+)\/.+$/.exec(p);
    if (bench) return `${base}/ai/${encodeURIComponent(decode(bench[1]))}`;
    const model = /^\/models\/(.+)$/.exec(p);
    if (model) return `${base}/ai/models/${encodeURIComponent(decode(model[1]))}`;
    if (/^\/(?:showcase|gallery|pick|battle|ratings)(?:\/|$)/.test(p)) return `${base}/ai`;
    if (/^\/runs\/[^/]+$/.test(p)) return `${base}/ai`;
    if (p === '/llms.txt' || p === '/llms-full.txt') return `${base}${p}`;
    // A Markdown twin of a public benchmark page follows the page to Report. The detail page itself is decided by
    // its route (an owner or a named reader keeps it); its twin is a signed-out render, so it stays public-only.
    const benchTwin = /^\/benchmarks\/([^/]+)\.md$/.exec(p);
    if (benchTwin) return `${base}/ai/${encodeURIComponent(decode(benchTwin[1]))}.md`;
    // A Markdown twin of a moved page: its Report twin is the moved page's own twin. An unknown twin is still a 404.
    if (p.endsWith('.md')) {
        const page = p === '/index.md' ? '/' : p.slice(0, -3);
        const moved = targetFor(page, compareUrl);
        return moved ? `${moved}.md` : null;
    }
    return null;
}

function createCompareRedirects({ compareUrl = DEFAULT_COMPARE } = {}) {
    return function compareRedirect(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (KEEP.some((re) => re.test(req.path))) return next();
        const target = targetFor(req.path, compareUrl);
        if (!target) return next();
        // ?tab= is the one query Compare's AI board reads from the old links; everything else is dropped.
        const tab = req.query && typeof req.query.tab === 'string' && /^(elo|pareto|cost)$/.test(req.query.tab) ? `?tab=${req.query.tab}` : '';
        res.set('Cache-Control', 'public, max-age=3600');
        return res.redirect(301, target + tab);
    };
}

module.exports = { createCompareRedirects, targetFor, DEFAULT_COMPARE };

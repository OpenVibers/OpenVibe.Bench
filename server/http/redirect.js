'use strict';

/**
 * The Bench pages moved into OpenVibe.Report's AI section (owner, 2026-11-08). Every public HTML page answers a
 * permanent redirect to its Report counterpart; the API, MCP, render origin, badges, embeds, sign-in, legal pages
 * and static assets stay here. A redirect keeps its query string only where Report reads one (`?tab=`).
 *
 *   /                         → /ai
 *   /benchmarks               → /ai
 *   /benchmarks/<id>[/…]      → /ai/<id>
 *   /models/<model>           → /ai/models/<model>
 *   /compare                  → /ai/compare
 *   /docs                     → /ai/method
 *   /showcase, /gallery, …    → /ai
 */

const DEFAULT_REPORT = 'https://openvibe.report';
const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Paths that are machine endpoints, frames or not pages of the old Bench site: never redirected. */
const KEEP = [/^\/render(?:\/|$)/, /^\/vendor(?:\/|$)/, /^\/badge(?:\/|$)/, /^\/embed(?:\/|$)/,
    /^\/api(?:\/|$)/, /^\/mcp(?:\/|$)/, /^\/auth(?:\/|$)/, /^\/shared(?:\/|$)/, /^\/\.well-known(?:\/|$)/,
    /^\/metrics(?:\/|$)/, /^\/release(?:\.json|-metrics)?(?:\/|$)/, /^\/robots\.txt$/, /^\/sitemap\.xml$/,
    /^\/favicon\.ico$/, /^\/assets(?:\/|$)/];

function targetFor(pathname, reportUrl) {
    const base = String(reportUrl || DEFAULT_REPORT).replace(/\/+$/, '');
    const p = String(pathname || '/');
    if (p === '/' || p === '') return `${base}/ai`;
    if (p === '/docs' || p === '/docs/') return `${base}/ai/method`;
    if (p === '/compare' || p === '/compare/') return `${base}/ai/compare`;
    if (p === '/benchmarks' || p === '/benchmarks/') return `${base}/ai`;
    if (p === '/benchmarks/new' || p === '/benchmarks/new/') return `${base}/ai`;
    const bench = /^\/benchmarks\/([^/]+)(?:\/.*)?$/.exec(p);
    if (bench) return `${base}/ai/${encodeURIComponent(decode(bench[1]))}`;
    const model = /^\/models\/(.+)$/.exec(p);
    if (model) return `${base}/ai/models/${encodeURIComponent(decode(model[1]))}`;
    if (/^\/(?:showcase|gallery|pick|battle|ratings)(?:\/|$)/.test(p)) return `${base}/ai`;
    if (/^\/b\/[^/]+$/.test(p)) return `${base}/ai`;
    if (/^\/runs\/[^/]+$/.test(p)) return `${base}/ai`;
    if (p === '/llms.txt' || p === '/llms-full.txt') return `${base}${p}`;
    // A Markdown twin of a moved page: its Report twin is the moved page's own twin. An unknown twin is still a 404.
    if (p.endsWith('.md')) {
        const page = p === '/index.md' ? '/' : p.slice(0, -3);
        const moved = targetFor(page, reportUrl);
        return moved ? `${moved}.md` : null;
    }
    return null;
}

function createReportRedirects({ reportUrl = DEFAULT_REPORT } = {}) {
    return function reportRedirect(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (KEEP.some((re) => re.test(req.path))) return next();
        const target = targetFor(req.path, reportUrl);
        if (!target) return next();
        // ?tab= is the one query Report's AI board reads from the old links; everything else is dropped.
        const tab = req.query && typeof req.query.tab === 'string' && /^(elo|pareto|cost)$/.test(req.query.tab) ? `?tab=${req.query.tab}` : '';
        res.set('Cache-Control', 'public, max-age=3600');
        return res.redirect(301, target + tab);
    };
}

module.exports = { createReportRedirects, targetFor, DEFAULT_REPORT };

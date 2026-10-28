'use strict';

/**
 * Crawl artifacts for bench.openvibe.services. Sign-in, the API and the internal route are not for crawlers.
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.Bench';
const DESCRIPTION = 'OpenVibe.Bench is one AI benchmark and comparison engine for every room: blind votes, rubrics, graders, test suites and game outcomes, with reproducible pinned rounds and an open dataset per kind.';
const DISALLOW = ['/auth/', '/api/', '/internal', '/metrics', '/mcp'];

function dayOf(ts) {
    const m = String(ts == null ? '' : ts).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function siteUpdated() {
    try { return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated); } catch { return null; }
}

function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

const PAGES = [
    { path: '/', changefreq: 'daily', priority: 1.0, title: 'OpenVibe.Bench home', text: 'One benchmark engine for every room: the kinds, boards and open dataset.' },
    { path: '/docs', changefreq: 'weekly', priority: 0.6, title: 'The Bench API', text: 'The Bench JSON API, boards, dataset and MCP tools.' },
];

function createDiscoveryRoutes(ctx) {
    const { config } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# bench.openvibe.services: boards and datasets are JSON; sign-in, the API and the internal route are not for crawlers.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: DESCRIPTION,
            details: 'GET /api/v1/kinds lists the fifteen benchmark kinds. GET /api/v1/boards/:kind?type=elo|pareto|cost renders a board as JSON. GET /api/v1/datasets/:kind.jsonl is the open dataset without voter ids. POST /mcp is the Model Context Protocol endpoint.',
            sections: [
                { title: 'Start here', links: [{ title: SITE_NAME, url: abs('/') }, { title: 'The API', url: abs('/docs') }] },
                { title: 'Machine-readable', links: [{ title: 'Kinds (JSON)', url: abs('/api/v1/kinds') }, { title: 'Sitemap', url: abs('/sitemap.xml') }, { title: 'Release metadata (JSON)', url: abs('/release.json') }] },
            ],
        }));
    });

    r.get('/llms-full.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'The Bench home and its API docs.',
            base: site,
            maxBytes: 256 * 1024,
            sections: [{ title: 'Pages', pages: PAGES.map((p) => ({ url: p.path, title: p.title, text: p.text })) }],
        }));
    });

    r.get('/sitemap.xml', (_req, res) => {
        const lastmod = siteUpdated();
        const urls = PAGES.map((p) => ({ loc: abs(p.path), ...(lastmod ? { lastmod } : {}), changefreq: p.changefreq, priority: p.priority }));
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, PAGES, DESCRIPTION, SITE_NAME };

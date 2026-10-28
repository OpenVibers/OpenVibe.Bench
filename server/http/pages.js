'use strict';

/**
 * Bench's server-rendered pages: a plain home and the API docs. Public boards are JSON only (Report renders their
 * HTML later).
 */
const express = require('express');
const seo = require('openvibe-shared/seo');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { raw } = require('../render/html');
const { send } = require('../render/layout');
const views = require('../views');

const PUBLIC_CACHE = 'public, max-age=60';

function createPageRoutes(ctx) {
    const { config, bench } = ctx;
    const r = asyncRouter();
    const base = () => String(config.baseUrl).replace(/\/+$/, '');
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });

    r.get('/', async (req, res) => {
        const kinds = await bench.listKinds();
        return page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: null,
            description: 'OpenVibe.Bench is one AI benchmark and comparison engine for every room: blind votes, rubrics, graders, test suites and game outcomes, with reproducible pinned rounds and an open dataset per kind.',
            jsonLd: homeJsonLd(config),
            body: raw(views.home({ kinds, counts: { kinds: kinds.length } })),
        });
    });

    r.get('/docs', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: 'The Bench API',
        description: 'The Bench JSON API, the boards, the open dataset and the MCP tools.',
        jsonLd: [seo.jsonLd.webPage({ name: 'The Bench API', url: `${base()}/docs`, description: 'The Bench JSON API, the boards, the open dataset and the MCP tools.', siteUrl: base() })],
        body: raw(views.docs()),
    }));

    r.use(createDiscoveryRoutes(ctx));

    return r;
}

module.exports = { createPageRoutes };

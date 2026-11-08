'use strict';

/**
 * OpenVibe.Bench — Express app factory; server/index.js listens, tests build their own instance with a temporary
 * database and a mock Network/AI.
 *
 *   /, /docs                                            the pages (http/pages.js)
 *   /api/v1/*                                           the API (http/api.js)
 *   /mcp                                                the MCP endpoint (mcp.js)
 *   /auth/*                                             Network SSO with PKCE (auth/sso.js)
 *   /internal/events                                    ADR-033 account export/deletion
 *   /api/health, /api/ready, /release.json, /metrics    machine endpoints
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');

const configLib = require('./config');
const { openStore } = require('./db');
const { createKeyStore } = require('./auth/keys');
const { createSso } = require('./auth/sso');
const { createPrincipal } = require('./http/principal');
const createVariantEvidenceConfig = require('./variant-evidence-config').create;
const { createApi } = require('./http/api');
const { createRegistryApi } = require('./http/registry');
const { createVariantEvidenceApi } = require('./http/variant-evidence');
const { createPageRoutes } = require('./http/pages');
const { createShowcaseRoutes, createShowcasePages } = require('./http/showcase');
const { createArenaRoutes } = require('./http/arena');
const { createGalleryRoutes, createGalleryPages } = require('./http/gallery');
const { createPickPages, createPickRoutes } = require('./http/pick');
const { createBadgeRoutes } = require('./http/badge');
const { createEmbedRoutes } = require('./http/embed');
const { createWatchPages } = require('./http/watch');
const { createWatches } = require('./watch/watch');
const { createBattles } = require('./bench/battles');
const { createAnon } = require('./bench/anon');
const { createDailyRounds } = require('./bench/daily');
const { createBattlePages } = require('./http/battle');
const { createRatingsPages } = require('./http/ratings');
const { createRenderRoutes } = require('./http/render');
const { seedShowcaseTasks } = require('./bench/seed-tasks');
const { createRegistry } = require('./bench/registry');
const { createLauncher } = require('./bench/launch');
const { seedBenchmarks } = require('./bench/seed-benchmarks');
const { createServiceReadiness } = require('./observability');
const { assetVersion, send } = require('./render/layout');
const { raw } = require('./render/html');

const accountDataLib = require('./identity/account-data');
const { createStore } = require('./store');
const { createBenchAi } = require('./bench/ai');
const { createBenchJobs } = require('./bench/jobs');
const { createPublisher } = require('./events/publisher');
const { mcpRouter } = require('./mcp');
const protectedResource = require('./http/protected-resource');
const { createNetworkSender } = require('openvibe-sdk/account-data');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;
const { createHttpTelemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink } = require('openvibe-sdk/telemetry');

/**
 * opts: config, store, bench, benchAi, accountSend, telemetrySink, fetchImpl, log, now, random.
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const s = opts.store || await openStore(config, { now: opts.now, log });

    const keys = createKeyStore({ config, fetchImpl, log });
    const sso = createSso({ config, keys, fetchImpl, now: opts.now || (() => Date.now()), log });
    const principal = createPrincipal({ config, keys });
    // D11 owner settings (bench.variant_evidence): the switch is read through the store, env pins winning.
    const evidenceConfig = await createVariantEvidenceConfig({ db: s.db, principal, config, env: opts.env || process.env, log });
    Object.defineProperty(config.bench, 'variantEvidence', { enumerable: true, configurable: true, get: () => evidenceConfig.get('enabled') });

    const bench = opts.bench || createStore(s, { config, log, random: opts.random });
    const { createSharing, describeRef } = require('./sharing');
    const sharing = opts.sharing || createSharing({ db: s.db, config, fetchImpl, log });
    const registry = opts.registry || createRegistry(s, { log, sharing });
    // B12: bringing your own results, and the operator's mirror.
    const imports = require('./bench/imports').createImports({ s, registry, log });
    const mirror = require('./bench/mirror').createMirror({ s, registry, fetchImpl, log });
    const ai = opts.benchAi || createBenchAi({ config, fetchImpl, log });
    const jobs = createBenchJobs({ s, bench, ai, config, log });
    // The signed-out voter (the cookie, the relay header and the daily caps) and the daily rounds job.
    const anon = createAnon({ s, config, log });
    const daily = createDailyRounds({ s, bench, ai, config, anon, log });
    const publisher = createPublisher({ config, s, fetchImpl, log });

    await bench.seedKinds();
    try { await seedShowcaseTasks(s, bench); } catch (err) { log.warn('[OpenVibe.Bench] showcase tasks not seeded:', (err && err.message) || err); }
    try { await seedBenchmarks(s, registry); } catch (err) { log.warn('[OpenVibe.Bench] showcase benchmarks not seeded:', (err && err.message) || err); }

    const accountData = accountDataLib.create({ db: s.db, log });
    const accountSend = opts.accountSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : async () => { throw new Error('OV_OAUTH_CLIENT_SECRET is not set: Bench cannot answer account events'); });

    const launcher = createLauncher({ config, registry, fetchImpl: fetchImpl || globalThis.fetch, log });
    // P6: model-variant evidence. Constructed always so the owner switch applies live; its API returns 404 while off.
    const variantEvidence = require('./bench/variant-evidence').createVariantEvidence({ s, log });
    const ctx = {
        config, s, keys, sso, principal, bench, registry, launcher, ai, jobs, publisher, accountData, accountSend, log, fetchImpl,
        anon, daily, variantEvidence, evidenceConfig, sharing,
        imports, mirror,
        random: opts.random || Math.random,
    };

    const app = express();
    // GET /openapi.json (SEO-3): this service's public API as OpenAPI 3.1, generated from the contracts
    // (openvibe-contracts); the operations they mark internal-only are left out.
    app.get('/openapi.json', (_req, res) => {
        const doc = require('openvibe-contracts').openapi.document('bench');
        if (!doc) return res.status(404).type('text/plain').send('No API document.');
        const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);
        const paths = {};
        for (const [p, item] of Object.entries(doc.paths || {})) {
            const kept = {};
            for (const [k, op] of Object.entries(item || {})) {
                if (!METHODS.has(k)) { kept[k] = op; continue; }
                const vis = [].concat((op && op['x-openvibe-visibility']) || []);
                if (vis.length && vis.every((v) => v === 'internal')) continue;
                kept[k] = op;
            }
            if (Object.keys(kept).some((k) => METHODS.has(k))) paths[p] = kept;
        }
        res.set('Cache-Control', 'public, max-age=3600').set('Access-Control-Allow-Origin', '*').json({ ...doc, paths });
    });
    // /.well-known/agent.json (openvibe-shared/agent-layer, SEO-2): what this site serves, for agents.
    require('openvibe-shared/agent-layer').mount(app, { descriptor: require('./agent-descriptor') });
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'bench', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'bench', release: release.release });
    app.locals.metrics = metrics.registry;
    ctx.telemetry = createHttpTelemetry({ service: 'bench', sink: opts.telemetrySink || createPgTelemetrySink({ db: s.db, log }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
    app.use(ctx.telemetry.middleware());
    app.locals.ctx = ctx;
    ctx.watches = createWatches(ctx);
    ctx.battles = createBattles(ctx);
    // Where the ratings are refitted, the watches are checked: a score that moved by more than its own interval, or
    // a model that overtook another one, is worth one notice.
    s.onRatingsChanged = async (kindId, models) => {
        try { await ctx.watches.check(kindId, { models }); } catch (err) {
            log.warn('[OpenVibe.Bench] watch check failed: ' + (err && err.message ? err.message : err));
        }
    };

    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;

    evidenceConfig.mount(app);

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // cdnjs: hls.js for a live.clip battle's HLS clips (server/http/battle.js), loaded only when a clip needs it.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com', 'https://cdnjs.cloudflare.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://openvibe.chat', 'https://cloudflareinsights.com', 'https://openvibe.events', 'https://openvibe.media'],
                // A live.clip battle plays its two clips from OpenVibe.Media (signed links; HLS through blob: sources).
                mediaSrc: ["'self'", 'https://openvibe.media', 'blob:'],
                frameSrc: ["'self'", 'https://openvibe.network', require('./bench/render').RENDER_ORIGIN],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    // ── Badges and embeds: no session, no cookies, before the cookie parser ──
    app.use('/badge', createBadgeRoutes(ctx));
    app.use('/embed', createEmbedRoutes(ctx));
    app.use(cookieParser());

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-bench', name: 'OpenVibe.Bench', version: VERSION }));
    release.mount(app, { registry: metrics.registry });
    const readiness = createServiceReadiness({ s, config, release: release.release, valkey, sso });
    app.get('/api/ready', readiness.handler);

    // ── Who is signed in ────────────────────────────────────
    app.use(sso.middleware());

    // ── Sign-in ─────────────────────────────────────────────
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', sso.routes());

    // ── OpenVibe.Events → this service (loopback only) ──────
    app.use('/internal/events', accountData.consumer({
        secrets: config.events.secrets,
        send: accountSend,
        now: s.now,
        onEvent: async (ev) => `ignored:${ev.event_type}`,
    }));

    // ── Static assets ───────────────────────────────────────
    app.use('/shared', require('openvibe-shared/serve').handler());
    // Terms, Privacy and DMCA in this site's own words (openvibe-shared/legal, profile 'service'; 11-03: the footer's
    // legal links answered 404 here). The facts must match the code: change both together.
    const legal = require('openvibe-shared/legal');
    app.get(legal.PATHS, legal.handler({
        "host": "bench.openvibe.services",
        "name": "Bench.OpenVibe.Services",
        "id": "bench",
        "service": "bench",
        "profile": "service",
        "what": "The shared AI benchmark and comparison engine: kinds, pinned rounds, blind judgements, elo/pareto/cost boards, an open dataset per kind and private evals.",
        "makes": [
                "the evaluations you run and their results",
                "your judgements in blind comparisons, which count toward the public boards"
        ],
        "ai": true
    }));
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── API and MCP ─────────────────────────────────────────
    app.use('/api/v1', rateLimit({ windowMs: 60_000, limit: Number(process.env.BENCH_API_RATE_LIMIT_PER_MIN) || 240, standardHeaders: true, legacyHeaders: false, handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }) }));
    // ── /api/v1/<kind>/<id>/share — the uniform share API (openvibe-sdk/share) ────
    {
        const shareApi = express.Router();
        shareApi.use(ctx.principal.middleware);
        shareApi.use(sharing.shares.router({
            service: 'bench',
            authenticate: (req) => sharing.shareViewer(req.viewer),
            describe: describeRef(s.db, config),
        }));
        const SHARE_PATH = /^\/api\/v1\/(?:shared-with-me$|share\/people$|[^/]+\/[^/]+\/share(?:\/|$))/;
        app.use((req, res, next) => (SHARE_PATH.test(req.path) ? shareApi(req, res, next) : next()));
    }
    app.use('/api/v1', createApi(ctx));
    app.use('/api/v1', createRegistryApi(ctx));
    app.use('/api/v1', createVariantEvidenceApi(ctx));
    app.use('/api/v1/showcase', createShowcaseRoutes(ctx));
    app.use('/api/v1/arena', createArenaRoutes(ctx));
    app.use('/api/v1/gallery', createGalleryRoutes(ctx));
    app.use('/api/v1', createPickRoutes(ctx));
    app.use(require('./http/mirror').createMirrorRoutes(ctx));
    app.use(mcpRouter(ctx));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── RFC 9728: the MCP endpoint's protected-resource metadata ──
    // The document a client reads to learn that openvibe.network signs the tokens /mcp accepts, and the URL the
    // 401 challenge names (server/http/protected-resource.js).
    app.get('/.well-known/oauth-protected-resource', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=3600');
        res.json(protectedResource.document(config));
    });

    // ── Pages ───────────────────────────────────────────────
    // The public pages moved to OpenVibe.Report's AI section (2026-11-08). The API, MCP, render, badge and embed
    // routes above stay; an HTML page is a 301 to its Report counterpart.
    app.use(require('./http/redirect').createReportRedirects({ reportUrl: config.reportUrl }));
    app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.BENCH_RATE_LIMIT_PER_MIN) || 300, standardHeaders: true, legacyHeaders: false }));
    app.use('/render', createRenderRoutes(ctx));
    app.use('/vendor', require('./http/vendor').createVendorRoutes());
    app.use('/showcase', createShowcasePages(ctx));
    app.use('/gallery', createGalleryPages(ctx));
    app.use('/pick', createPickPages(ctx));
    app.use(createWatchPages(ctx));
    app.use('/battle', createBattlePages(ctx));
    app.use('/ratings', createRatingsPages(ctx));
    app.use(require('./http/imports').createImportRoutes(ctx));
    const pageRoutes = createPageRoutes(ctx);
    // The Markdown twins of the public pages, and the head link and Link: header that name them (SEO-1,
    // server/agent-twins.js): a twin is the page rendered signed out.
    require('./agent-twins').mountTwins(app, { router: pageRoutes, descriptor: require('./agent-descriptor'), baseUrl: ctx.config.baseUrl });
    app.use(pageRoutes);
    app.use((req, res) => send(res, 404, {
        viewer: req.viewer, config, path: req.originalUrl, title: 'Not found',
        body: raw(require('./views').notFound()),
    }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[OpenVibe.Bench]', err && err.message ? err.message.slice(0, 300) : err);
        if (res.headersSent) return;
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (err && err.type === 'entity.parse.failed') return contracts.http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return req.path.startsWith('/api/') ? contracts.http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov }) : res.status(413).type('text/plain').send('That request was too large.');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };

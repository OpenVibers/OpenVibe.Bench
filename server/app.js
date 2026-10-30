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
const { createApi } = require('./http/api');
const { createRegistryApi } = require('./http/registry');
const { createPageRoutes } = require('./http/pages');
const { createShowcaseRoutes, createShowcasePages } = require('./http/showcase');
const { createGalleryRoutes, createGalleryPages } = require('./http/gallery');
const { createPickPages, createPickRoutes } = require('./http/pick');
const { createBadgeRoutes } = require('./http/badge');
const { createEmbedRoutes } = require('./http/embed');
const { createWatchPages } = require('./http/watch');
const { createWatches } = require('./watch/watch');
const { createBattles } = require('./bench/battles');
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

    const bench = opts.bench || createStore(s, { config, log, random: opts.random });
    const registry = opts.registry || createRegistry(s, { log });
    const ai = opts.benchAi || createBenchAi({ config, fetchImpl, log });
    const jobs = createBenchJobs({ s, bench, ai, config, log });
    const publisher = createPublisher({ config, s, fetchImpl, log });

    await bench.seedKinds();
    try { await seedShowcaseTasks(s, bench); } catch (err) { log.warn('[OpenVibe.Bench] showcase tasks not seeded:', (err && err.message) || err); }
    try { await seedBenchmarks(s, registry); } catch (err) { log.warn('[OpenVibe.Bench] showcase benchmarks not seeded:', (err && err.message) || err); }

    const accountData = accountDataLib.create({ db: s.db, log });
    const accountSend = opts.accountSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : async () => { throw new Error('OV_OAUTH_CLIENT_SECRET is not set: Bench cannot answer account events'); });

    const launcher = createLauncher({ config, registry, fetchImpl: fetchImpl || globalThis.fetch, log });
    const ctx = {
        config, s, keys, sso, principal, bench, registry, launcher, ai, jobs, publisher, accountData, accountSend, log, fetchImpl,
        random: opts.random || Math.random,
    };

    const app = express();
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

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://cloudflareinsights.com', 'https://openvibe.events'],
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
    app.use('/api/v1', createApi(ctx));
    app.use('/api/v1', createRegistryApi(ctx));
    app.use('/api/v1/showcase', createShowcaseRoutes(ctx));
    app.use('/api/v1/gallery', createGalleryRoutes(ctx));
    app.use('/api/v1', createPickRoutes(ctx));
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
    app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.BENCH_RATE_LIMIT_PER_MIN) || 300, standardHeaders: true, legacyHeaders: false }));
    app.use('/render', createRenderRoutes(ctx));
    app.use('/vendor', require('./http/vendor').createVendorRoutes());
    app.use('/showcase', createShowcasePages(ctx));
    app.use('/gallery', createGalleryPages(ctx));
    app.use('/pick', createPickPages(ctx));
    app.use(createWatchPages(ctx));
    app.use('/battle', createBattlePages(ctx));
    app.use('/ratings', createRatingsPages(ctx));
    app.use(createPageRoutes(ctx));
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

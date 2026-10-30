'use strict';

/**
 * OpenVibe.Bench configuration. Every value comes from the environment (production: /etc/openvibe/bench.env).
 * Only environment variable NAMES appear in code and docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 5230);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://bench.openvibe.services' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'bench',
        name: 'OpenVibe.Bench',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        // "Run it yourself" on a benchmark page opens this openvibe.codes page (stage B3); unset, the page offers the API.
        codesRunUrl: env.CODES_BENCH_RUN_URL ? trim(env.CODES_BENCH_RUN_URL) : null,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        drill: env.BENCH_DRILL === '1' || env.BENCH_DRILL === 'true',
        limits: {
            minute: Math.max(1, int(env.BENCH_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.BENCH_LIMITS_HOUR, 3000)),
        },

        // PostgreSQL (ADR-035). DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.BENCH_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:bench:' },

        // OpenVibe.Network: SSO and its JWKS.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        audience: env.BENCH_AUDIENCE || 'openvibe.bench',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'bench',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // OpenVibe.Events → this service's outbox delivery and ADR-033 account export/deletion.
        events: {
            secrets: String(env.BENCH_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter(Boolean),
            url: trim(env.BENCH_EVENTS_URL || env.EVENTS_URL || ''),
            endpoint: env.BENCH_EVENTS_ENDPOINT || '',
            intervalMs: Math.max(500, int(env.BENCH_EVENTS_INTERVAL_MS, 5000)),
            scope: env.BENCH_EVENTS_SCOPE || 'events.event.publish',
        },

        // OpenVibe.AI: the generate operation. Bench asks Network for a client-credentials token (audience
        // openvibe.ai, scope ai.run.create; Network grants the ai.generate namespace). Generation is picked up
        // by the job loop, never by the request that creates a round.
        ai: {
            url: trim(env.OV_AI_INTERNAL_URL || 'http://127.0.0.1:4700'),
            audience: env.BENCH_AI_AUDIENCE || 'openvibe.ai',
            scope: env.BENCH_AI_SCOPE || 'ai.run.create',
            waitMs: Math.max(1000, int(env.BENCH_AI_WAIT_MS, 55_000)),
            timeoutMs: Math.max(1000, int(env.BENCH_AI_TIMEOUT_MS, 120_000)),
            pollMs: Math.max(100, int(env.BENCH_AI_POLL_MS, 1500)),
            models: String(env.BENCH_MODELS || '').split(',').map((x) => x.trim()).filter(Boolean),
            maxHtmlBytes: 200 * 1024,
        },

        // Bench budgets and jobs.
        bench: {
            roundsPerDay: Math.max(1, int(env.BENCH_ROUNDS_PER_DAY, 3)),
            roundsDaily: Math.max(1, int(env.BENCH_ROUNDS_DAILY, 20)),
            intervalMs: Math.max(250, int(env.BENCH_JOB_INTERVAL_MS, 1500)),
            pollMs: Math.max(250, int(env.BENCH_POLL_MS, 20_000)),
            maxPrompt: Math.max(20, int(env.BENCH_MAX_PROMPT, 4000)),
            evalsPerDay: Math.max(1, int(env.BENCH_EVALS_PER_DAY, 20)),
            provisionalGames: Math.max(1, int(env.BENCH_PROVISIONAL_GAMES, 10)),
        },
    };
}

module.exports = { load };

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
const float = (v, def) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : def);
const bool = (v, def) => (v == null || v === '' ? def : (v === '1' || v === 'true' || v === 'yes' || v === 'on'));

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
            // Battles: how many votes one person and one network may cast.
            battlePersonPerHour: Math.max(1, int(env.BENCH_BATTLE_PERSON_PER_HOUR, 30)),
            battlePersonPerDay: Math.max(1, int(env.BENCH_BATTLE_PERSON_PER_DAY, 200)),
            battleNetworkPerHour: Math.max(1, int(env.BENCH_BATTLE_NETWORK_PER_HOUR, 120)),
            battleNetworkPerDay: Math.max(1, int(env.BENCH_BATTLE_NETWORK_PER_DAY, 1000)),

            // Signed-out voting (plan L51 step 1). The caps are per UTC day and every one of them answers
            // 429 bench.limit_anon with the same plain detail: sign in to keep voting today.
            anon: {
                enabled: bool(env.BENCH_ANON_ENABLED, true),
                // Per anonymous voter per day.
                voterPerDay: Math.max(1, int(env.BENCH_ANON_VOTER_PER_DAY, 30)),
                // Per address per day. Bench keeps only a salted hash of the address, salted per day.
                ipPerDay: Math.max(1, int(env.BENCH_ANON_IP_PER_DAY, 60)),
                // Per relaying service per day.
                relayPerDay: Math.max(1, int(env.BENCH_ANON_RELAY_PER_DAY, 3000)),
                // Every anonymous vote on the site, per day.
                globalPerDay: Math.max(1, int(env.BENCH_ANON_GLOBAL_PER_DAY, 20000)),
                // The first-party services that may relay an anonymous voter (X-OV-Voter).
                relayServices: String(env.BENCH_ANON_RELAY_SERVICES || 'design').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
                // The secret the voter cookie is signed with and the voter id is hashed with. Empty falls back to
                // the OAuth client secret, and then to a per-process secret (which resets the caps on a restart).
                secret: String(env.BENCH_ANON_SECRET || '').trim(),
                cookieName: String(env.BENCH_ANON_COOKIE || 'bench_anon').trim() || 'bench_anon',
                cookieDays: Math.max(1, int(env.BENCH_ANON_COOKIE_DAYS, 180)),
            },
            // The daily rounds (plan L51 step 2): one round per design kind per day, so there is always
            // something to judge. Off until the owner turns it on in production.
            daily: {
                enabled: bool(env.BENCH_DAILY_ROUNDS, false),
                // The job never starts under BENCH_DRILL unless this is set too (the tests use it).
                enabledInDrill: bool(env.BENCH_DAILY_ROUNDS_IN_DRILL, false),
                // The one UTC hour the day's rounds are made.
                hourUtc: Math.min(23, Math.max(0, int(env.BENCH_DAILY_ROUNDS_HOUR_UTC, 8))),
                // What the day's rounds may cost, in US dollars.
                budgetUsd: Math.max(0, float(env.BENCH_DAILY_BUDGET_USD, 1.00)),
                // What one round is assumed to cost, until the real cost of the models is known.
                estimateUsd: Math.max(0, float(env.BENCH_DAILY_ROUND_ESTIMATE_USD, 0.05)),
                // How often the job looks at the clock.
                pollMs: Math.max(30_000, int(env.BENCH_DAILY_POLL_MS, 300_000)),
            },
        },
    };
}

module.exports = { load };

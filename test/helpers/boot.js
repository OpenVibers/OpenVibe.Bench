'use strict';
// Many requests per test file: the per-address limits would answer 429 part-way.
process.env.BENCH_RATE_LIMIT_PER_MIN = process.env.BENCH_RATE_LIMIT_PER_MIN || '100000';
process.env.BENCH_API_RATE_LIMIT_PER_MIN = process.env.BENCH_API_RATE_LIMIT_PER_MIN || '100000';
process.env.BENCH_LIMITS_MINUTE = process.env.BENCH_LIMITS_MINUTE || '100000';
process.env.BENCH_LIMITS_HOUR = process.env.BENCH_LIMITS_HOUR || '100000';
/**
 * Boots OpenVibe.Bench on a temp database with a mock Network and a fake AI, captures log lines, and returns a
 * small HTTP client. Every test file gets its own process, database, Network, AI and app.
 */
const http = require('http');
const { startNetwork } = require('./network');
const { startAi } = require('./ai');

async function boot(opts = {}) {
    const network = await startNetwork(opts.network || {});
    const ai = opts.ai || await startAi(opts.aiOptions || {});
    const env = {
        NODE_ENV: 'test', PORT: '0', BASE_URL: 'https://bench.openvibe.services', TRUST_PROXY: '1',
        OV_NETWORK_URL: network.url, OV_NETWORK_INTERNAL_URL: network.url, OV_NETWORK_ISSUER: network.url,
        OV_OAUTH_CLIENT_ID: 'bench', OV_OAUTH_CLIENT_SECRET: 'bench-secret', COOKIE_SECURE: 'false',
        OV_AI_INTERNAL_URL: ai.url,
        BENCH_DRILL: '1',
        BENCH_AI_POLL_MS: '10', BENCH_AI_WAIT_MS: '5000', BENCH_JOB_INTERVAL_MS: '100000',
        ...(opts.env || {}),
    };
    for (const [k, v] of Object.entries(opts.env || {})) if (v === null) delete env[k];

    const logLines = [];
    const log = {
        log: (...a) => logLines.push(a.map(String).join(' ')),
        info: (...a) => logLines.push(a.map(String).join(' ')),
        warn: (...a) => logLines.push(a.map(String).join(' ')),
        error: (...a) => logLines.push(a.map(String).join(' ')),
    };

    const configLib = require('../../server/config');
    const { createApp } = require('../../server/app');
    const { createStore } = require('../../server/db');
    const config = configLib.load(env);
    const testdb = opts.store ? null : await require('./db').testDb({ store: opts.testStore });
    const store = opts.store || createStore(testdb.db, { now: opts.now });
    const built = await createApp({ config, store, benchAi: opts.benchAi, log, now: opts.now, accountSend: opts.accountSend, random: opts.random, telemetrySink: opts.telemetrySink });
    await built.ctx.keys.ensure();
    const server = await new Promise((resolve) => { const s = http.createServer(built.app); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const signIn = (user) => `bench_at=${network.userToken(user)}`;

    async function get(p, o = {}) {
        const headers = { ...(o.headers || {}) };
        if (o.as) headers.cookie = [signIn(o.as), headers.cookie].filter(Boolean).join('; ');
        if (o.cookie) headers.cookie = o.cookie;
        if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
        let body = o.body;
        if (o.raw !== undefined) { body = o.raw; }
        else if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
        const method = o.method || (body ? 'POST' : 'GET');
        if (o.as && method !== 'GET' && method !== 'HEAD' && !headers.origin && !headers['sec-fetch-site']) headers.origin = config.baseUrl;
        if (o.origin) headers.origin = o.origin;
        if (o.secFetchSite) headers['sec-fetch-site'] = o.secFetchSite;
        const res = await fetch(base + p, { method, headers, body, redirect: 'manual' });
        const buf = Buffer.from(await res.arrayBuffer());
        const text = buf.toString('utf8');
        return { status: res.status, headers: res.headers, text, buffer: buf, json() { return JSON.parse(text); } };
    }

    async function dbDump() {
        const db = built.ctx.s.db;
        const tables = (await db.many("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()")).map((r) => r.name);
        return (await Promise.all(tables.map(async (tname) => JSON.stringify(await db.many(`SELECT * FROM "${tname}"`))))).join('\n');
    }

    return {
        base, network, ai, config, ctx: built.ctx, store: built.ctx.s, get, signIn, dbDump,
        tick: () => built.ctx.jobs.tick(),
        logs: () => logLines.join('\n'),
        async close() {
            built.ctx.jobs.stop();
            built.ctx.publisher.stop();
            await new Promise((r) => server.close(r));
            built.ctx.keys.client.stop();
            await built.ctx.telemetry.stop().catch(() => {});
            if (testdb) await testdb.close();
            await network.close();
            if (!opts.ai) await ai.close();
        },
    };
}

let failures = 0;
async function check(name, fn) {
    try {
        await fn();
        process.stdout.write(`  ✓ ${name}\n`);
    } catch (e) {
        failures++;
        process.stdout.write(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 10).join('\n      ')}\n`);
    }
}
function done() {
    process.stdout.write(failures ? `\n${failures} failed\n` : '\nall passed\n');
    process.exit(failures ? 1 : 0);
}

module.exports = { boot, check, done };

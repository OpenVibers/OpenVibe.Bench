'use strict';

/**
 * OpenVibe.Bench — process entry. `node server/index.js` listens on PORT (5230) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { startTelemetryRetention } = require('openvibe-sdk/telemetry');
const { startSubscriptions } = require('openvibe-sdk/account-data');

function createLifecycle({ server, ctx, exit, signals, timers = [], extra = [] }) {
    return gracefulStop({
        name: 'OpenVibe.Bench', server, deadlineExitCode: 0, exit, signals, deadlineMs: 10_000,
        close: [
            () => { for (const t of timers) clearInterval(t); },
            () => ctx.keys.client.stop(),
            () => ctx.jobs.stop(),
            () => ctx.daily.stop(),
            () => ctx.publisher.stop(),
            async () => { clearInterval(ctx.telemetryTick); if (ctx.retention) await ctx.retention.stop(); if (ctx.telemetry) await ctx.telemetry.stop(); },
            () => ctx.s.close(),
            ...extra,
        ],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    // Socket activation (2026-10-31): systemd's .socket unit holds the listener across restarts, so a deploy
    // queues requests in the kernel instead of answering 502. Without the socket unit, the usual listen.
    const socketActivated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
    const server = app.listen(...(socketActivated ? [{ fd: 3 }] : [config.port, config.host]), () => {
        console.log(`[OpenVibe.Bench] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.s.db.store})`);
        ctx.keys.ensure().catch(() => {});
    });
    server.keepAliveTimeout = 65_000;
    ctx.retention = startTelemetryRetention({ db: ctx.s.db, log: ctx.log || console, olderThanDays: 14 });
    ctx.telemetryTick = setInterval(() => { ctx.telemetry.flush().catch(() => {}); }, 60_000);
    ctx.telemetryTick.unref();
    ctx.keys.client.start();

    // Jobs: rounds and private eval runs. Off under BENCH_DRILL; tests call tick().
    ctx.jobs.start();
    // The daily rounds (one per design kind per day). Off until BENCH_DAILY_ROUNDS is on; never under the drill.
    ctx.daily.start();
    // Outbox publisher → OpenVibe.Events.
    ctx.publisher.start();

    const subs = config.drill ? null : startSubscriptions({
        eventsUrl: config.events.url,
        endpoint: config.events.endpoint || `http://127.0.0.1:${config.port}/internal/events`,
        secret: config.events.secrets[0] || '',
        networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        log: ctx.log || console,
    });
    const extra = [() => { if (subs) subs.stop(); }];
    createLifecycle({ server, ctx, extra });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[OpenVibe.Bench] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };

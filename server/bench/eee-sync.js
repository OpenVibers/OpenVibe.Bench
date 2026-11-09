'use strict';

/**
 * The weekly Every Eval Ever import (B2). It is the same shape as Bench's other workers: a timer, one async pass at
 * a time, and the pass itself is bounded and resumable (server/bench/eee.js `sync`). Off until the owner turns
 * BENCH_EEE_SYNC on; never under BENCH_DRILL unless BENCH_EEE_SYNC_IN_DRILL says so too.
 */
function createEeeSync({ eee, config, log = console }) {
    let timer = null;
    let running = false;
    let stopped = false;
    const settings = config.bench.eee;

    async function tick() {
        if (running || stopped) return null;
        running = true;
        try {
            return await eee.sync({ maxFiles: settings.filesPerRun, maxRecords: settings.recordsPerRun });
        } catch (err) {
            log.warn('[OpenVibe.Bench] the EEE sync failed:', (err && err.message) || err);
            return null;
        } finally {
            running = false;
        }
    }

    function start() {
        if (timer || stopped || !settings.enabled) return null;
        if (config.drill && !settings.enabledInDrill) return null;
        const run = () => tick().catch((err) => log.warn('[OpenVibe.Bench] EEE job:', (err && err.message) || err));
        timer = setInterval(run, settings.intervalMs);
        if (timer.unref) timer.unref();
        run();
        return timer;
    }

    function stop() {
        stopped = true;
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { tick, start, stop, get running() { return running; } };
}

module.exports = { createEeeSync };

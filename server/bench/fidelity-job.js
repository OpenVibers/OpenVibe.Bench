'use strict';

/**
 * The weekly provider-fidelity pass (stage B5). Off by default: the owner turns it on with BENCH_FIDELITY=1.
 * The pass is due-based (the last pass is a row in the database), so the several deploys Bench gets in a
 * week do not reset its clock. A pass that is already running is never started twice.
 */
function createFidelityJob({ fidelity, config, log = console }) {
    let timer = null;
    let running = false;

    async function tick() {
        if (!config.bench.fidelity.enabled) return null;
        if (config.drill && !config.bench.fidelity.enabledInDrill) return null;
        if (running) return null;
        running = true;
        try {
            if (!(await fidelity.due())) return null;
            return await fidelity.run({ trigger: 'weekly' });
        } catch (err) {
            log.warn('[OpenVibe.Bench] fidelity job:', (err && (err.detail || err.message)) || err);
            return null;
        } finally {
            running = false;
        }
    }

    function start() {
        if (timer || !config.bench.fidelity.enabled) return null;
        const run = () => tick().catch((err) => log.warn('[OpenVibe.Bench] fidelity job:', (err && err.message) || err));
        timer = setInterval(run, config.bench.fidelity.tickMs);
        if (timer.unref) timer.unref();
        return timer;
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { tick, start, stop };
}

module.exports = { createFidelityJob };

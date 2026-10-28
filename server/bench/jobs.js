'use strict';

/**
 * Bench's generation workers. A round (or private eval run) is created as `queued`; this loop claims it, asks
 * OpenVibe.AI for outputs, stores each with its reported provider/model/cost/time/tokens, and marks it `finished`
 * (at least two usable entries) or `failed`. The loop starts in server/index.js and never under BENCH_DRILL=1;
 * tests call tick() explicitly.
 */
const ERROR_MAX = 500;

function createBenchJobs({ s, bench, ai, config, log = console }) {
    let timer = null;
    let running = false;
    let stopped = false;

    async function claimRound() {
        return await s.tx(async () => {
            const r = await s.db.maybe("SELECT * FROM bench_rounds WHERE status = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE");
            if (!r) return null;
            await s.db.exec("UPDATE bench_rounds SET status = 'running' WHERE id = $1", [r.id]);
            return { ...r, status: 'running' };
        });
    }

    async function generateRound(round) {
        const task = await bench.getTask(round.task_id);
        if (!task) throw new Error(`round ${round.id} has no task`);
        const kind = await bench.getKind(round.kind_id);
        if (!kind) throw new Error(`round ${round.id} has no kind`);
        let plan;
        try {
            plan = round.offers && round.offers.length
                ? { slots: round.offers, pool_fallback: round.offers.length < 3 }
                : (typeof ai.slotPlan === 'function' ? await ai.slotPlan() : { slots: await ai.slots(), pool_fallback: false });
        } catch (err) {
            log.warn('[OpenVibe.Bench] AI slots unavailable:', (err && err.message) || err);
            plan = { slots: [{ provider: 'ai', model: null }], pool_fallback: true };
        }
        const slots = (Array.isArray(plan.slots) ? plan.slots : []).slice(0, 3);
        while (slots.length < 3) slots.push({ provider: 'ai', model: null });
        let ok = 0;
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i] || { provider: 'ai', model: null };
            try {
                const out = await ai.generate({ prompt: task.prompt, kind: kind.entry, slot, roundId: round.id, index: i });
                await bench.addEntry({
                    roundId: round.id, provider: out.provider, model: out.model,
                    route: { provider: out.provider, model: out.model },
                    payload: out.payload, costUsd: out.cost_usd, ms: out.ms, tokens: out.tokens,
                    uiCheck: out.ui_check, runId: out.run_id,
                });
                ok++;
            } catch (err) {
                const detail = String((err && (err.detail || err.message)) || err).slice(0, ERROR_MAX);
                log.warn(`[OpenVibe.Bench] round ${round.id} output ${i} failed:`, detail);
                await bench.addEntry({
                    roundId: round.id,
                    provider: String((slot && slot.provider) || 'ai').slice(0,80),
                    model: String((slot && slot.model) || 'unknown').slice(0,120),
                    route: { provider: slot && slot.provider, model: slot && slot.model },
                    payload: {}, error: detail,
                });
            }
        }
        if (ok < 2) await s.db.exec("UPDATE bench_rounds SET status = 'failed' WHERE id = $1", [round.id]);
        return ok;
    }

    async function tickRound() {
        const round = await claimRound();
        if (!round) return null;
        try {
            await generateRound(round);
            return await bench.getRound(round.id);
        } catch (err) {
            log.warn('[OpenVibe.Bench] round job failed:', (err && err.message) || err);
            await s.db.exec("UPDATE bench_rounds SET status = 'failed' WHERE id = $1", [round.id]).catch(() => {});
            throw err;
        }
    }

    async function claimEvalRun() {
        return await s.tx(async () => {
            const r = await s.db.maybe("SELECT * FROM bench_eval_runs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE");
            if (!r) return null;
            await s.db.exec("UPDATE bench_eval_runs SET status = 'running' WHERE id = $1", [r.id]);
            return { ...r, status: 'running' };
        });
    }

    async function generateEvalRun(run) {
        const ev = await bench.getEval(run.eval_id, { owner: null });
        if (!ev) throw new Error(`eval run ${run.id} has no eval`);
        const results = [];
        for (const task of (ev.test_suite || [])) {
            const offer = (run.offers && run.offers[0]) || { provider: 'ai', model: null };
            try {
                const out = await ai.generate({ prompt: String(task.prompt || task), kind: (await bench.getKind(ev.kind_id)).entry, slot: offer, roundId: run.id, index: results.length });
                results.push({ task: String(task.prompt || task).slice(0, 500), offer, provider: out.provider, model: out.model, payload: out.payload, cost_usd: out.cost_usd, ms: out.ms });
            } catch (err) {
                results.push({ task: String(task.prompt || task).slice(0, 500), offer, error: String((err && (err.detail || err.message)) || err).slice(0, ERROR_MAX) });
            }
        }
        await s.db.exec("UPDATE bench_eval_runs SET status = 'ready', results = $1::jsonb, finished_at = $2::timestamptz WHERE id = $3",
            [JSON.stringify(results), s.iso(), run.id]);
        return results.length;
    }

    async function tickEval() {
        const run = await claimEvalRun();
        if (!run) return null;
        try {
            return await generateEvalRun(run);
        } catch (err) {
            log.warn('[OpenVibe.Bench] eval run failed:', (err && err.message) || err);
            await s.db.exec("UPDATE bench_eval_runs SET status = 'failed' WHERE id = $1", [run.id]).catch(() => {});
            throw err;
        }
    }

    /** One worker pass: one queued round, then one queued eval run. */
    async function tick() {
        if (running || stopped) return null;
        running = true;
        try {
            const round = await tickRound();
            const evalRun = await tickEval();
            return { round, evalRun };
        } finally {
            running = false;
        }
    }

    function start() {
        if (timer || stopped || config.drill) return null;
        const run = () => tick().catch((err) => log.warn('[OpenVibe.Bench] job:', (err && err.message) || err));
        timer = setInterval(run, config.bench.intervalMs);
        if (timer.unref) timer.unref();
        run();
        return timer;
    }

    function stop() {
        stopped = true;
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { tick, tickRound, tickEval, start, stop, claimRound, claimEvalRun, generateRound, generateEvalRun, get running() { return running; } };
}

module.exports = { createBenchJobs };

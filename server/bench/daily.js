'use strict';

/**
 * The daily rounds (plan L51, step 2): one round per design kind per day, so there is always something to judge.
 *
 * The job is off until the owner turns it on (BENCH_DAILY_ROUNDS), it runs at one fixed UTC hour
 * (BENCH_DAILY_ROUNDS_HOUR_UTC) and it spends Bench's own budget (BENCH_DAILY_BUDGET_USD, one US dollar a day by
 * default). A kind whose share of the budget is gone is skipped, and what it spent is written down, so the owner can
 * see what the day's rounds cost. The two models of every round come from the pool the ordinary rounds already use.
 *
 * Nothing here starts under BENCH_DRILL (the drill and the tests), unless the drill explicitly allows it
 * (BENCH_DAILY_ROUNDS_IN_DRILL). The tests call runDay() with a clock of their own instead.
 */

const crypto = require('crypto');
const { DAILY_KIND_IDS, DAILY_PROMPTS } = require('./daily-prompts');

/** The owner of the daily rounds. It is a service, not a person: no person can judge or create them. */
const SUBJECT = 'service:bench-daily';

const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));

function createDailyRounds({ s, bench, ai, config, log = console }) {
    const db = s.db;
    let timer = null;
    let stopped = false;
    let running = false;

    const cfg = () => (config && config.bench && config.bench.daily) || {};
    const dayOf = (now) => new Date(now == null ? s.now() : now).toISOString().slice(0, 10);

    /** The prompt of the day for a kind: the same one all day, a different one tomorrow. */
    function promptFor(kindId, day) {
        const list = DAILY_PROMPTS[kindId] || [];
        if (!list.length) return null;
        const h = crypto.createHash('sha256').update(`${day}|${kindId}`).digest();
        return list[h.readUInt32BE(0) % list.length];
    }

    /** The two models of the pool the ordinary rounds use. */
    async function modelsOfPool() {
        let list = [];
        try {
            if (typeof ai.slotPlan === 'function') {
                const plan = await ai.slotPlan();
                list = plan && Array.isArray(plan.slots) ? plan.slots : [];
            }
        } catch (err) {
            log.warn('[OpenVibe.Bench] daily rounds: the model pool is unavailable:', (err && err.message) || err);
        }
        if (list.length < 2) {
            try { list = await ai.offeredModels(); } catch { list = []; }
        }
        const out = [];
        const seen = new Set();
        for (const one of list) {
            const provider = String((one && one.provider) || '').trim();
            const model = one && one.model != null ? String(one.model) : null;
            if (!provider) continue;
            const key = provider + '|' + (model || '');
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ provider, model });
            if (out.length === 2) break;
        }
        return out;
    }

    /** What one round is assumed to cost: the configured estimate, or what these models really cost. */
    async function estimateFor(models) {
        const base = num(cfg().estimateUsd, 0.05);
        const names = models.map((m) => m.model).filter(Boolean);
        if (!names.length) return base;
        const avg = num(await db.value(
            `SELECT COALESCE(AVG(cost_usd), 0)::numeric AS n FROM bench_entries
             WHERE model = ANY($1::text[]) AND created_at >= $2::timestamptz`,
            [names, new Date(s.now() - 7 * 86_400_000).toISOString()],
        ));
        return Math.max(base, Math.round(avg * models.length * 1e6) / 1e6);
    }

    /** What the day has cost: what was really spent, plus what is still running. */
    async function budgetState(day) {
        const rows = await db.many('SELECT * FROM bench_daily_rounds WHERE day = $1', [day]);
        let spent = 0;
        let reserved = 0;
        for (const row of rows) {
            if (String(row.status) === 'skipped' || String(row.status) === 'failed') continue;
            if (row.spent_usd == null) reserved += num(row.estimated_usd);
            else spent += num(row.spent_usd);
        }
        return { spent, reserved, rows };
    }

    /** What the day's rounds really cost, once their entries are in. */
    async function settle(day) {
        const rows = await db.many(
            "SELECT * FROM bench_daily_rounds WHERE day = $1 AND status = 'created' AND spent_usd IS NULL",
            [day],
        );
        for (const row of rows) {
            if (!row.round_id) continue;
            const usable = num(await db.value(
                'SELECT COUNT(*)::int AS n FROM bench_entries WHERE round_id = $1 AND error IS NULL', [row.round_id]));
            if (usable < 2) continue;
            const spent = num(await db.value(
                'SELECT COALESCE(SUM(cost_usd), 0)::numeric AS n FROM bench_entries WHERE round_id = $1', [row.round_id]));
            await db.exec('UPDATE bench_daily_rounds SET spent_usd = $1 WHERE id = $2', [spent, row.id]);
        }
    }

    async function record({ day, kindId, prompt, models, estimated, status, reason = null, taskId = null, roundId = null }) {
        const id = s.newId('bdr');
        await db.exec(
            `INSERT INTO bench_daily_rounds (id, day, kind_id, prompt, models, task_id, round_id, estimated_usd, spent_usd, status, skip_reason, created_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12::timestamptz)
             ON CONFLICT (day, kind_id) DO NOTHING`,
            [id, day, kindId, prompt || null, JSON.stringify(models || []), taskId, roundId, estimated,
                status === 'skipped' ? 0 : null, status, reason ? String(reason).slice(0, 200) : null, s.iso()],
        );
        return id;
    }

    /**
     * One day of rounds: one per design kind, unless the day's budget is spent. A kind that already has a row for
     * today is left alone, so the job can be run again without making a second round of the same kind.
     */
    async function runDay({ now = s.now() } = {}) {
        const day = dayOf(now);
        const budget = num(cfg().budgetUsd, 1);
        await settle(day);
        const made = [];
        for (const kindId of DAILY_KIND_IDS) {
            const done = await db.maybe('SELECT id FROM bench_daily_rounds WHERE day = $1 AND kind_id = $2', [day, kindId]);
            if (done) continue;
            const prompt = promptFor(kindId, day);
            if (!prompt) continue;
            const models = await modelsOfPool();
            if (models.length < 2) {
                await record({ day, kindId, prompt, models, estimated: 0, status: 'skipped', reason: 'no_models' });
                made.push({ kind_id: kindId, status: 'skipped', reason: 'no_models' });
                continue;
            }
            const estimate = await estimateFor(models);
            const state = await budgetState(day);
            if (state.spent + state.reserved + estimate > budget) {
                await record({ day, kindId, prompt, models, estimated: estimate, status: 'skipped', reason: 'budget' });
                made.push({ kind_id: kindId, status: 'skipped', reason: 'budget' });
                continue;
            }
            try {
                const task = await bench.createTask({ kindId, prompt, taskClass: 'daily', public: true, subject: SUBJECT });
                if (!task.ok) throw new Error(task.message || 'the task was refused');
                const round = await bench.createRound({ taskId: task.task.id, offers: models, subject: SUBJECT, bypassQuota: true });
                if (!round.ok) throw new Error(round.message || 'the round was refused');
                await record({
                    day, kindId, prompt, models, estimated: estimate, status: 'created',
                    taskId: task.task.id, roundId: round.round.id,
                });
                made.push({ kind_id: kindId, status: 'created', round_id: round.round.id, estimated_usd: estimate });
            } catch (err) {
                log.warn('[OpenVibe.Bench] daily round failed:', (err && err.message) || err);
                await record({
                    day, kindId, prompt, models, estimated: estimate, status: 'failed',
                    reason: String((err && err.message) || err),
                });
                made.push({ kind_id: kindId, status: 'failed' });
            }
        }
        const state = await budgetState(day);
        const summary = {
            day, budget_usd: budget, spent_usd: state.spent, reserved_usd: state.reserved,
            created: made.filter((m) => m.status === 'created').length,
            skipped: made.filter((m) => m.status === 'skipped').length,
            rounds: made,
        };
        log.info(`[OpenVibe.Bench] daily rounds ${day}: ${summary.created} created, ${summary.skipped} skipped, $${state.spent.toFixed(4)} spent of $${budget.toFixed(2)}.`);
        return summary;
    }

    /** One pass of the job: after the day's hour, and only if the day has no rounds yet. */
    async function tick() {
        if (running || stopped) return null;
        running = true;
        try {
            const now = s.now();
            const day = dayOf(now);
            const hour = new Date(now).getUTCHours();
            if (hour < num(cfg().hourUtc, 8)) return null;
            const rows = num(await db.value('SELECT COUNT(*)::int AS n FROM bench_daily_rounds WHERE day = $1', [day]));
            if (rows >= DAILY_KIND_IDS.length) {
                await settle(day);
                return null;
            }
            return await runDay({ now });
        } finally {
            running = false;
        }
    }

    /** The job starts only when the owner turns it on, and never under the drill unless the drill allows it. */
    function start() {
        if (timer || stopped) return null;
        if (!cfg().enabled) return null;
        if (config && config.drill && !cfg().enabledInDrill) return null;
        const run = () => tick().catch((err) => log.warn('[OpenVibe.Bench] daily rounds:', (err && err.message) || err));
        timer = setInterval(run, num(cfg().pollMs, 300_000));
        if (timer.unref) timer.unref();
        run();
        return timer;
    }

    function stop() {
        stopped = true;
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { start, stop, tick, runDay, settle, promptFor, modelsOfPool, budgetState, dayOf, SUBJECT };
}

module.exports = { createDailyRounds, SUBJECT };

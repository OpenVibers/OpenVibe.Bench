'use strict';

/**
 * Seed the showcase gallery: one round per seeded showcase task, each with two cheap, different model
 * offers pinned from OpenVibe.AI's own router. The rounds are created 'queued'; Bench's job loop claims
 * them and generates the entries through OpenVibe.AI.
 *
 * Run it as the service user, with the service's own environment (never printed):
 *
 *   sudo systemd-run --wait --pipe --uid=ubuntu --gid=ubuntu \
 *     --property=EnvironmentFile=/etc/openvibe/bench.env \
 *     --working-directory=/opt/openvibe.bench /usr/bin/env node scripts/seed-showcase-rounds.js
 *
 * No cap is raised. The store's daily budgets (per creator and per site) are respected: the script walks
 * through a few seeding creators so a full gallery fits under the per-creator budget, and it stops and
 * says so when a budget is spent.
 */

const { load } = require('../server/config');
const { openStore } = require('../server/db');
const { createStore } = require('../server/store');
const { createBenchAi } = require('../server/bench/ai');

const OFFER_COUNT = 2;
const CREATORS = ['showcase:s2:1', 'showcase:s2:2', 'showcase:s2:3', 'showcase:s2:4'];

function dayStart(now) {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
}

async function main() {
    const config = load();
    const s = await openStore(config, { log: console });
    const bench = createStore(s, { config, log: console });
    const ai = createBenchAi({ config, log: console });

    const offered = await ai.offeredModels();
    const offers = offered.slice(0, OFFER_COUNT);
    if (offers.length < OFFER_COUNT) {
        console.error('AI offers fewer than ' + OFFER_COUNT + ' models; nothing seeded.');
        await s.close();
        return 1;
    }
    console.log('pinned offers:', offers.map((o) => o.provider + '/' + o.model).join(' vs '));

    const tasks = await s.db.many(
        "SELECT id, kind_id, prompt FROM bench_tasks WHERE created_by = 'showcase:seed' ORDER BY created_at, id",
    );
    const start = dayStart(s.now());
    let made = 0;
    let skipped = 0;
    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const existing = await s.db.maybe(
            'SELECT id FROM bench_rounds WHERE task_id = $1 AND created_at >= $2::timestamptz LIMIT 1',
            [task.id, start],
        );
        if (existing) { skipped++; console.log('task ' + task.id + ' (' + task.kind_id + '): round ' + existing.id + ' already exists'); continue; }
        const subject = CREATORS[i % CREATORS.length];
        try {
            const out = await bench.createRound({ taskId: task.id, offers, seed: 0, subject });
            if (!out.ok) { console.error('task ' + task.id + ': ' + (out.code || 'refused') + ' ' + (out.message || '')); continue; }
            made++;
            console.log('task ' + task.id + ' (' + task.kind_id + '): round ' + out.round.id + ' status ' + out.round.status);
        } catch (err) {
            console.error('task ' + task.id + ' (' + task.kind_id + '): ' + (err && (err.code + ' ' + err.detail || err.message)));
            if (err && err.code === 'bench.limit_person') continue;
            if (err && err.code === 'bench.limit_site') break;
        }
    }
    const siteUsed = Number(await s.db.value("SELECT COUNT(*)::int AS n FROM bench_rounds WHERE created_at >= $1::timestamptz", [start])) || 0;
    console.log('seeded ' + made + ' rounds, skipped ' + skipped + ' (' + tasks.length + ' tasks; site rounds today ' + siteUsed + '/' + config.bench.roundsDaily + ')');
    await s.close();
    return 0;
}

main().then((code) => process.exit(code || 0)).catch((err) => { console.error(err && err.message ? err.message : err); process.exit(1); });

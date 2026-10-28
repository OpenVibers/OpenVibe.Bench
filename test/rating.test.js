'use strict';

const assert = require('assert');
const rating = require('../server/rating');
const { check, done } = require('./helpers/boot');

let failures = 0;
async function t(name, fn) {
    try { await fn(); process.stdout.write(`  ✓ ${name}\n`); }
    catch (e) { failures++; process.stdout.write(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')}\n`); }
}

(async () => {
    await t('eloUpdate: a win moves rating up and the loser down', () => {
        const out = rating.eloUpdate(1000, 1000, 'left', 32);
        assert.ok(out.a > 1000);
        assert.ok(out.b < 1000);
        assert.strictEqual(Math.round((out.a - 1000) * 100) / 100, 16);
    });

    await t('eloUpdate: a tie converges, both_bad leaves both unchanged', () => {
        const tie = rating.eloUpdate(1000, 1000, 'tie', 32);
        assert.strictEqual(tie.a, 1000);
        assert.strictEqual(tie.b, 1000);
        assert.deepStrictEqual(rating.eloUpdate(1200, 900, 'both_bad'), { a: 1200, b: 900 });
    });

    await t('wilson: perfect and empty samples have the right bounds', () => {
        const full = rating.wilson(10, 10);
        assert.strictEqual(full.p, 1);
        assert.ok(full.lower > 0.5 && full.lower < 1);
        assert.ok(full.upper > full.lower);
        const empty = rating.wilson(0, 0);
        assert.deepStrictEqual(empty, { p: 0, lower: 0, upper: 0 });
    });

    await t('pareto: the cheap-and-good frontier is marked', () => {
        const rows = [
            { name: 'best', x: 0.9, y: 0.1 },
            { name: 'dominated', x: 0.5, y: 0.5 },
            { name: 'cheap-low', x: 0.4, y: 0.05 },
        ];
        const out = rating.pareto(rows, { x: 'x', y: 'y' });
        assert.strictEqual(out.find((r) => r.name === 'best').frontier, true);
        assert.strictEqual(out.find((r) => r.name === 'dominated').frontier, false);
        assert.strictEqual(out.find((r) => r.name === 'cheap-low').frontier, true);
    });

    await t('costPerSolved: sums solved spend only', () => {
        const entries = [
            { cost_usd: 0.1, solved: true },
            { cost_usd: 0.2, solved: true },
            { cost_usd: 0.3, solved: false },
        ];
        assert.strictEqual(rating.costPerSolved(entries), 0.15);
        assert.strictEqual(rating.costPerSolved([{ cost_usd: 0.5, solved: false }]), null);
    });

    await t('bradleyTerry: deterministic, sorted, with games and bootstrap intervals', () => {
        const games = [
            { a: 'm1', b: 'm2', outcome: 'a' },
            { a: 'm1', b: 'm2', outcome: 'a' },
            { a: 'm1', b: 'm2', outcome: 'b' },
            { a: 'm2', b: 'm3', outcome: 'a' },
        ];
        const rows = rating.bradleyTerry(games, { bootstrap: 200, seed: 7 });
        assert.strictEqual(rows.length, 3);
        assert.ok(rows[0].rating > rows[1].rating);
        assert.strictEqual(rows.find((r) => r.subject === 'm1').games, 3);
        assert.ok(rows.every((r) => Number.isFinite(r.ci_lower) && Number.isFinite(r.ci_upper)));
        const again = rating.bradleyTerry(games, { bootstrap: 200, seed: 7 });
        assert.deepStrictEqual(rows, again);
    });

    if (failures) { process.stdout.write(`\n${failures} failed\n`); process.exit(1); }
    process.stdout.write('\nall passed\n');
    process.exit(0);
})();

'use strict';

/**
 * The style-controlled ratings (stage B9).
 *
 * These are the maths, on purpose synthetic: a fit that recovers known strengths, a fit that takes a planted
 * length bias back out, and bands that follow the intervals.
 */

const assert = require('assert');
const style = require('../server/rating/style');
const { check, done } = require('./helpers/boot');

/** A small generator with a seed, so the synthetic votes are the same every run. */
function rng(seed) {
    let st = seed >>> 0;
    return () => {
        st = (st * 1664525 + 1013904223) >>> 0;
        return st / 4294967296;
    };
}

(async () => {
    await check('a fit recovers known strengths', async () => {
        const random = rng(11);
        const truth = [['alpha', 0.6], ['beta', 0.0], ['gamma', -0.5]];
        const games = [];
        for (let i = 0; i < 900; i++) {
            const x = truth[Math.floor(random() * truth.length)];
            const y = truth[Math.floor(random() * truth.length)];
            if (x === y) continue;
            const p = 1 / (1 + Math.exp(-(x[1] - y[1])));
            games.push({
                id: 'g' + i, a: x[0], b: y[0], outcome: random() < p ? 'a' : 'b',
                fa: { length: 100, markup: 2 }, fb: { length: 100, markup: 2 },
            });
        }
        const fit = style.fitRatings(games, { bootstrap: 120 });
        const byModel = new Map(fit.models.map((m) => [m.model, m]));
        const scale = 400 / Math.log(10);
        for (const [model, theta] of truth) {
            const expected = 1000 + scale * theta;
            const got = byModel.get(model).raw.rating;
            assert.ok(Math.abs(got - expected) < 40, model + ': expected ' + expected.toFixed(1) + ', got ' + got.toFixed(1));
        }
    });

    await check('the style control takes a planted length bias back out', async () => {
        const random = rng(23);
        // Two equally good models, but voters prefer the longer output.
        const games = [];
        for (let i = 0; i < 400; i++) {
            const longA = random() < 0.6;
            const la = longA ? 3000 + Math.floor(random() * 2000) : 800 + Math.floor(random() * 600);
            const lb = longA ? 900 + Math.floor(random() * 700) : 2800 + Math.floor(random() * 2000);
            const p = 1 / (1 + Math.exp(-(la - lb) / 900));
            games.push({
                id: 'g' + i, a: 'alpha', b: 'beta', outcome: random() < p ? 'a' : 'b',
                fa: { length: la, markup: Math.round(la / 120) }, fb: { length: lb, markup: Math.round(lb / 120) },
            });
        }
        const fit = style.fitRatings(games, { bootstrap: 120 });
        const raw = new Map(fit.models.map((m) => [m.model, m.raw.rating]));
        const controlled = new Map(fit.models.map((m) => [m.model, m.controlled.rating]));
        // The raw board says one model is clearly better; the controlled board does not.
        assert.ok(Math.abs(raw.get('alpha') - raw.get('beta')) > 30, 'the raw board is biased: ' + raw.get('alpha') + ' vs ' + raw.get('beta'));
        assert.ok(Math.abs(controlled.get('alpha') - controlled.get('beta')) < 30, 'the controlled board is even: ' + controlled.get('alpha') + ' vs ' + controlled.get('beta'));
        assert.ok(Math.abs(controlled.get('alpha') - controlled.get('beta')) < Math.abs(raw.get('alpha') - raw.get('beta')), 'the control shrinks the gap');
        assert.ok(fit.effects.length && fit.effects.length.beta > 0, 'the length effect is positive: ' + JSON.stringify(fit.effects.length));
    });

    await check('the bands follow the intervals', async () => {
        const rows = [
            { model: 'a', rating: 1100, ci_lower: 1090, ci_upper: 1110 },
            { model: 'b', rating: 1080, ci_lower: 1040, ci_upper: 1105 },   // overlaps a
            { model: 'c', rating: 1000, ci_lower: 960, ci_upper: 1040 },    // overlaps b, not a
            { model: 'd', rating: 900, ci_lower: 880, ci_upper: 920 },      // alone
        ];
        const bands = style.rankBands(rows);
        assert.strictEqual(bands.length, 2, JSON.stringify(bands));
        assert.strictEqual(bands[0].label, '1st–3rd', bands[0].label);
        assert.deepStrictEqual(bands[0].models, ['a', 'b', 'c']);
        assert.strictEqual(bands[1].label, '4th', bands[1].label);
        assert.deepStrictEqual(bands[1].models, ['d']);
        assert.strictEqual(style.bandLabel(2, 4), '2nd–4th');
        assert.strictEqual(style.bandLabel(1, 1), '1st');
    });

    await check('the style features count length and markup', async () => {
        const f = style.styleFeatures({ html: '<h1>Title</h1><p><strong>bold</strong></p><ul><li>one</li></ul>' });
        assert.ok(f.length > 20, 'length: ' + f.length);
        assert.ok(f.markup >= 4, 'markup: ' + f.markup);
        assert.strictEqual(style.markupCount('# Title\n- a\n- b'), 3);
        assert.strictEqual(style.markupCount('plain text'), 0);
    });

    await check('a voter who disagrees with the consensus is down-weighted, never named', async () => {
        const random = rng(31);
        const games = [];
        for (let i = 0; i < 400; i++) {
            const p = 1 / (1 + Math.exp(-0.9));
            games.push({
                id: 'g' + i, a: 'alpha', b: 'beta', outcome: random() < p ? 'a' : 'b',
                fa: { length: 100, markup: 1 }, fb: { length: 100, markup: 1 },
                voter: 'voter-' + (i % 12),
            });
        }
        // One voter always disagrees with the consensus.
        for (const g of games) if (g.voter === 'voter-3') g.outcome = g.outcome === 'a' ? 'b' : 'a';
        const fit = style.fitRatings(games, { bootstrap: 60 });
        assert.ok(fit.voters.downweighted >= 1, 'someone is down-weighted: ' + JSON.stringify(fit.voters));
        assert.ok(!JSON.stringify(fit).includes('voter-3'), 'the down-weighted voter is never named in the board');
        const weights = new Map((fit.vote_weights || []).map((w) => [w.id, w.weight]));
        const odd = games.filter((g) => g.voter === 'voter-3');
        assert.ok(odd.every((g) => (weights.get(g.id) || 1) < 1), 'the odd voter\'s votes count less');
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });

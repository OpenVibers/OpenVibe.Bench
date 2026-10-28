'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { eloUpdate, bradleyTerry, voterWeights, wilson, pareto, costPerSolved, percentile } = require('../server/rating/lib');

const game = (a, b, outcome, voter) => ({ a, b, outcome, voter });
const bySubject = fit => new Map(fit.map(row => [row.subject, row]));

test('Elo produces known equal-rating win, tie, and both_bad values', () => {
  assert.deepEqual(eloUpdate(1000, 1000, 'a'), [1016, 984]);
  assert.deepEqual(eloUpdate(1000, 1000, 'tie'), [1000, 1000]);
  assert.deepEqual(eloUpdate(1000, 1000, 'both_bad'), [1000, 1000]);
  assert.deepEqual(eloUpdate(1000, 1000, 'b', 16), [992, 1008]);
  assert.ok(Math.abs(eloUpdate(1200, 1000, 'a')[0] - 1207.6880983472654) < 1e-9);
});

test('Bradley-Terry recovers a planted three-subject order', () => {
  const games = [
    ...Array.from({ length: 18 }, () => game('A', 'B', 'a')),
    ...Array.from({ length: 2 }, () => game('A', 'B', 'b')),
    ...Array.from({ length: 15 }, () => game('B', 'C', 'a')),
    ...Array.from({ length: 5 }, () => game('B', 'C', 'b')),
    ...Array.from({ length: 19 }, () => game('A', 'C', 'a')),
    game('A', 'C', 'b'),
  ];
  const fit = bradleyTerry(games, { bootstrap: 0 });
  assert.deepEqual(fit.map(row => row.subject), ['A', 'B', 'C']);
  assert.ok(Math.abs(fit.reduce((sum, row) => sum + row.rating, 0) / 3 - 1000) < 1e-9);
  assert.deepEqual(fit.map(row => row.games), [40, 40, 40]);
  assert.ok(fit.every(row => !row.provisional));
});

test('ties count as half a win for each side and both_bad is skipped', () => {
  const fit = bradleyTerry([game('A', 'B', 'tie'), game('A', 'B', 'both_bad')], { bootstrap: 0 });
  assert.equal(fit[0].rating, 1000);
  assert.equal(fit[1].rating, 1000);
  assert.deepEqual(fit.map(row => [row.games, row.wins, row.losses, row.ties]), [[1, 0, 0, 1], [1, 0, 0, 1]]);
  assert.ok(fit.every(row => row.provisional));
  assert.deepEqual(bradleyTerry([game('A', 'B', 'both_bad')]), []);
});

test('bootstrap intervals are deterministic for a seed', () => {
  const games = Array.from({ length: 30 }, (_, i) => game('A', 'B', i % 3 ? 'a' : 'b'));
  const options = { bootstrap: 80, seed: 17 };
  assert.deepEqual(bradleyTerry(games, options), bradleyTerry(games, options));
  assert.notDeepEqual(bradleyTerry(games, options), bradleyTerry(games, { ...options, seed: 18 }));
});

test('bootstrap intervals narrow with more games from the same mix', () => {
  const makeGames = n => Array.from({ length: n }, (_, i) => game('A', 'B', i % 5 < 3 ? 'a' : 'b'));
  const short = bradleyTerry(makeGames(20), { bootstrap: 250, seed: 7 });
  const long = bradleyTerry(makeGames(200), { bootstrap: 250, seed: 7 });
  assert.ok(long[0].ci_upper - long[0].ci_lower < short[0].ci_upper - short[0].ci_lower);
});

test('weighted games affect the fit and dissenting voters are down-weighted after burn-in', () => {
  const games = [
    ...Array.from({ length: 20 }, () => game('A', 'B', 'a', 'agree')),
    ...Array.from({ length: 20 }, () => game('A', 'B', 'b', 'dissent')),
    game('A', 'B', 'b', 'new'),
  ];
  const fit = [{ subject: 'A', rating: 1100 }, { subject: 'B', rating: 900 }];
  const weights = voterWeights(games, fit);
  assert.equal(weights.get('agree'), 1);
  assert.equal(weights.get('dissent'), 0.25);
  assert.equal(weights.get('new'), 1);
  const weighted = bradleyTerry(games, { bootstrap: 0, weights });
  assert.equal(weighted[0].subject, 'A');
  assert.ok(bySubject(weighted).get('A').rating > 1000);
});

test('one-sided and disconnected graphs yield finite ratings and intervals', () => {
  const fit = bradleyTerry([game('A', 'B', 'a'), game('C', 'D', 'a')], { bootstrap: 30 });
  assert.equal(fit.length, 4);
  assert.ok(fit.every(row => Number.isFinite(row.rating) && Number.isFinite(row.ci_lower) && Number.isFinite(row.ci_upper)));
});

test('Wilson interval matches reference values and handles zero trials', () => {
  assert.deepEqual(wilson(0, 0), { p: 0, lower: 0, upper: 0 });
  const result = wilson(5, 10);
  assert.equal(result.p, 0.5);
  assert.ok(Math.abs(result.lower - 0.23658959361548731) < 1e-12);
  assert.ok(Math.abs(result.upper - 0.7634104063845126) < 1e-12);
});

test('Pareto frontier retains tradeoffs and equal rows', () => {
  const rows = [{ id: 'cheap', cost: 1, score: 4 }, { id: 'best', cost: 3, score: 8 },
    { id: 'dominated', cost: 4, score: 3 }, { id: 'equal', cost: 1, score: 4 }];
  const result = pareto(rows, { x: 'cost', y: 'score' });
  assert.deepEqual(result.map(row => row.frontier), [true, true, false, true]);
  assert.equal(rows[0].frontier, undefined);
  assert.deepEqual(pareto([{ x: 1, y: 2 }, { x: 2, y: 3 }], { x: 'x', y: 'y', lowerX: false, higherY: false }).map(row => row.frontier), [true, true]);
});

test('cost per solved sums costs and counts, with null for no solutions', () => {
  assert.deepEqual(costPerSolved([{ cost_usd: 2, solved: true }, { cost_usd: 4, solved: false }, { cost_usd: 3, solved: 2 }]),
    { cost_usd: 9, solved: 3, per_solved: 3 });
  assert.deepEqual(costPerSolved([]), { cost_usd: 0, solved: 0, per_solved: null });
});

test('percentile interpolates and handles empty input', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.ok(Math.abs(percentile([1, 2, 3, 4], 95) - 3.85) < 1e-12);
  assert.equal(percentile([], 95), null);
});

'use strict';

const ELO_LOG_SCALE = 400 / Math.log(10);
const PRIOR = 0.1; // Half a win and half a loss against a unit-strength opponent.

function eloUpdate(ra, rb, outcome, k = 32) {
  if (outcome === 'both_bad') return [ra, rb];
  if (!['a', 'b', 'tie'].includes(outcome)) throw new RangeError('invalid outcome');
  const score = outcome === 'a' ? 1 : outcome === 'b' ? 0 : 0.5;
  const expected = 1 / (1 + 10 ** ((rb - ra) / 400));
  const change = k * (score - expected);
  return [ra + change, rb - change];
}

function percentile(values, p) {
  if (!values.length) return null;
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new RangeError('percentile must be in [0, 100]');
  // Fractions are accepted as well: .5 is the median, .95 is p95.
  const fraction = p <= 1 ? p : p / 100;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function gameWeight(game, weights) {
  if (weights == null || game.voter == null) return 1;
  const value = typeof weights === 'function' ? weights(game.voter, game)
    : weights instanceof Map ? weights.get(game.voter) : weights[game.voter];
  if (value == null) return 1;
  if (!Number.isFinite(value) || value < 0) throw new RangeError('weights must be finite and nonnegative');
  return value;
}

function fitStrengths(games, subjects, weights, iterations) {
  const index = new Map(subjects.map((subject, i) => [subject, i]));
  const wins = Array(subjects.length).fill(PRIOR / 2);
  const pairs = new Map();
  for (const game of games) {
    if (game.outcome === 'both_bad' || game.a === game.b) continue;
    const weight = gameWeight(game, weights);
    if (weight === 0) continue;
    const a = index.get(game.a);
    const b = index.get(game.b);
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { a: Math.min(a, b), b: Math.max(a, b), n: 0 };
      pairs.set(key, pair);
    }
    pair.n += weight;
    if (game.outcome === 'a') wins[a] += weight;
    else if (game.outcome === 'b') wins[b] += weight;
    else if (game.outcome === 'tie') {
      wins[a] += weight / 2;
      wins[b] += weight / 2;
    } else throw new RangeError('invalid outcome');
  }

  let strength = Array(subjects.length).fill(1);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const denominator = strength.map(value => PRIOR / (value + 1));
    for (const pair of pairs.values()) {
      const term = pair.n / (strength[pair.a] + strength[pair.b]);
      denominator[pair.a] += term;
      denominator[pair.b] += term;
    }
    const next = strength.map((_, i) => wins[i] / denominator[i]);
    const change = Math.max(0, ...next.map((value, i) => Math.abs(Math.log(value / strength[i]))));
    strength = next;
    if (change < 1e-10) break;
  }
  return strength;
}

function ratingsFor(games, subjects, weights, iterations, anchor) {
  const strength = fitStrengths(games, subjects, weights, iterations);
  const logs = strength.map(Math.log);
  const mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
  return logs.map(value => anchor + ELO_LOG_SCALE * (value - mean));
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function bradleyTerry(games, { bootstrap = 200, seed = 1, anchor = 1000, iterations = 200, weights } = {}) {
  const active = games.filter(game => game.outcome !== 'both_bad');
  const subjects = [...new Set(active.flatMap(game => [game.a, game.b]))].sort();
  if (!subjects.length) return [];
  const stats = new Map(subjects.map(subject => [subject, { games: 0, wins: 0, losses: 0, ties: 0 }]));
  for (const game of active) {
    if (!['a', 'b', 'tie'].includes(game.outcome)) throw new RangeError('invalid outcome');
    if (game.a === game.b) throw new RangeError('a game requires two different subjects');
    const a = stats.get(game.a);
    const b = stats.get(game.b);
    a.games++;
    b.games++;
    if (game.outcome === 'tie') { a.ties++; b.ties++; }
    else if (game.outcome === 'a') { a.wins++; b.losses++; }
    else { b.wins++; a.losses++; }
  }
  const ratings = ratingsFor(active, subjects, weights, iterations, anchor);
  const samples = subjects.map(() => []);
  if (bootstrap > 0 && active.length) {
    const random = seededRandom(seed);
    for (let i = 0; i < bootstrap; i++) {
      const resampled = Array.from({ length: active.length }, () => active[Math.floor(random() * active.length)]);
      const draw = ratingsFor(resampled, subjects, weights, iterations, anchor);
      draw.forEach((rating, j) => samples[j].push(rating));
    }
  }
  return subjects.map((subject, i) => ({
    subject,
    rating: ratings[i],
    ci_lower: samples[i].length ? percentile(samples[i], 2.5) : ratings[i],
    ci_upper: samples[i].length ? percentile(samples[i], 97.5) : ratings[i],
    ...stats.get(subject),
    provisional: stats.get(subject).games < 10,
  })).sort((a, b) => b.rating - a.rating || String(a.subject).localeCompare(String(b.subject)));
}

function voterWeights(games, fit, { burnIn = 20, floor = 0.25 } = {}) {
  const ratings = new Map(fit.map(row => [row.subject, row.rating]));
  const voters = new Map();
  for (const game of games) {
    if (game.voter == null) continue;
    if (!voters.has(game.voter)) voters.set(game.voter, { count: 0, disagreement: 0 });
    if (game.outcome === 'both_bad' || !ratings.has(game.a) || !ratings.has(game.b)) continue;
    const record = voters.get(game.voter);
    const expected = Math.sign(ratings.get(game.a) - ratings.get(game.b));
    const observed = game.outcome === 'a' ? 1 : game.outcome === 'b' ? -1 : 0;
    record.count++;
    record.disagreement += expected === observed ? 0 : expected === 0 || observed === 0 ? 0.5 : 1;
  }
  return new Map([...voters].map(([voter, record]) => [voter,
    record.count < burnIn ? 1 : Math.max(floor, 1 - record.disagreement / record.count)]));
}

function wilson(successes, n, z = 1.96) {
  if (n === 0) return { p: 0, lower: 0, upper: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const radius = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denominator;
  return { p, lower: center - radius, upper: center + radius };
}

function pareto(rows, { x, y, lowerX = true, higherY = true }) {
  return rows.map((row, i) => ({ ...row, frontier: !rows.some((other, j) => {
    if (i === j) return false;
    const xBetter = lowerX ? other[x] <= row[x] : other[x] >= row[x];
    const yBetter = higherY ? other[y] >= row[y] : other[y] <= row[y];
    const strictlyBetter = other[x] !== row[x] || other[y] !== row[y];
    return xBetter && yBetter && strictlyBetter;
  }) }));
}

function costPerSolved(entries) {
  const cost_usd = entries.reduce((sum, entry) => sum + entry.cost_usd, 0);
  const solved = entries.reduce((sum, entry) => sum + Number(entry.solved), 0);
  return { cost_usd, solved, per_solved: solved ? cost_usd / solved : null };
}

module.exports = { eloUpdate, bradleyTerry, voterWeights, wilson, pareto, costPerSolved, percentile };

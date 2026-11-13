'use strict';
/**
 * server/rating/factors.js: model and harness, apart. Synthetic matches are drawn from known effects (four models,
 * three harnesses besides the neutral one, one real interaction, one pair never run), and the fit must find them:
 * the models' order, each harness's effect inside its interval, the interaction that exists (and none where there is
 * none), a harness's effect with a model it never ran, a gap split into parts that add up, and the same answer twice.
 */
const assert = require('assert');
const { fitFactors, splitGap, parseEntrant, SCALE } = require('../server/rating/factors');

function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s + 0x6D2B79F5) >>> 0; let v = s; v = Math.imul(v ^ (v >>> 15), v | 1); v ^= v + Math.imul(v ^ (v >>> 7), v | 61); return ((v ^ (v >>> 14)) >>> 0) / 4294967296; };
}
const sig = (x) => 1 / (1 + Math.exp(-x));
const MU = { 'gpt-5-mini': 0.6, 'deepseek-flash': 0.2, 'glm-5.3': -0.2, 'qwen3.8-max': -0.6 };
const ETA = { 'ov-bare': 0, codex: 0.5, opencode: 0.1, aider: -0.2 };
const GAMMA = { 'glm-5.3|opencode': 0.5 };
const NEVER = 'qwen3.8-max|aider';
const id = (h, m) => `agent:${h}+${m}#0123abcd`;
const theta = (h, m) => MU[m] + ETA[h] + (GAMMA[`${m}|${h}`] || 0);

const random = rng(7);
const entrants = [];
for (const h of Object.keys(ETA)) for (const m of Object.keys(MU)) if (`${m}|${h}` !== NEVER) entrants.push([h, m]);
const games = [];
for (let n = 0; n < 9000; n++) {
    const a = entrants[Math.floor(random() * entrants.length)];
    let b = entrants[Math.floor(random() * entrants.length)];
    while (b === a) b = entrants[Math.floor(random() * entrants.length)];
    const p = sig(theta(...a) - theta(...b));
    const r = random();
    games.push({ a: id(...a), b: id(...b), outcome: r < 0.04 ? 'tie' : r < 0.04 + 0.96 * p ? 'a' : 'b' });
}

const t0 = Date.now();
const fit = fitFactors(games, { bootstrap: 120 });
const ms = Date.now() - t0;

assert.deepStrictEqual(parseEntrant('agent:codex+gpt-5-mini#0123abcd'), { kind: 'agent', model: 'gpt-5-mini', harness: 'codex' });
assert.deepStrictEqual(parseEntrant('harness:opencode@1.4.2'), { kind: 'harness', model: null, harness: 'opencode' });
assert.strictEqual(parseEntrant('robot:x'), null);

assert.deepStrictEqual(fit.models.map((m) => m.model), ['gpt-5-mini', 'deepseek-flash', 'glm-5.3', 'qwen3.8-max'], 'the models in their true order');
// A harness's effect is its average over the models it ran with: its own η plus its interactions' mean (the pooling
// centres the interactions within each harness). OpenCode: 0.1 + 0.5 / 4.
const models = Object.keys(MU);
const avgEffect = (h) => ETA[h] + models.reduce((sum, m) => sum + (GAMMA[`${m}|${h}`] || 0), 0) / models.length;
for (const h of ['codex', 'opencode', 'aider']) {
    const row = fit.harnesses.find((x) => x.harness === h);
    const truth = SCALE * avgEffect(h);
    assert.ok(row.ci_lower <= truth && truth <= row.ci_upper, `${h}: ${truth.toFixed(1)} inside [${row.ci_lower}, ${row.ci_upper}]`);
    assert.ok(Math.abs(row.effect - truth) < 35, `${h} effect ${row.effect} near ${truth.toFixed(1)}`);
}
assert.deepStrictEqual(fit.harnesses.map((x) => x.harness), ['codex', 'opencode', 'aider'], 'harnesses ordered by effect');

const glmOpen = fit.agents.find((x) => x.id === id('opencode', 'glm-5.3'));
assert.ok(glmOpen.factors.interaction.score > 40, `the real interaction is found (${glmOpen.factors.interaction.score})`);
for (const a of fit.agents.filter((x) => x.harness !== 'ov-bare')) {
    const truth = SCALE * ((GAMMA[`${a.model}|${a.harness}`] || 0) - (avgEffect(a.harness) - ETA[a.harness]));
    assert.ok(Math.abs(a.factors.interaction.score - truth) < 25, `${a.harness}+${a.model}: interaction ${a.factors.interaction.score} near ${truth.toFixed(1)} (none invented)`);
}
assert.ok(fit.agents.filter((x) => x.harness === 'codex' || x.harness === 'aider').every((x) => Math.abs(x.factors.interaction.score) < 25), 'harnesses with no interaction get none');

assert.ok(!fit.agents.some((x) => x.id === id('aider', 'qwen3.8-max')), 'the pair never run is not a row');
assert.ok(fit.harnesses.find((x) => x.harness === 'aider').ci_upper < 0, 'yet aider\'s effect is known from its other models');

const gap = splitGap(fit, id('codex', 'gpt-5-mini'), id('aider', 'deepseek-flash'));
assert.ok(Math.abs(gap.model + gap.harness + gap.interaction - gap.gap) < 0.5, 'the parts of a gap add up to the gap');
assert.ok(gap.model > 0 && gap.harness > 0, 'both the model and the harness explain part of it');

const again = fitFactors(games, { bootstrap: 120 });
assert.deepStrictEqual(again.harnesses, fit.harnesses, 'the same matches and seed give the same board');
assert.ok(ms < 20000, `fast enough for a board refresh (${ms} ms)`);

console.log(`rating-factors: models in order; harness effects in their intervals; the interaction found and none invented; aider known without qwen; gaps split; reproducible (${ms} ms)`);

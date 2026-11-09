'use strict';

/**
 * The OpenVibe Index and the holdout gap (stage B3): the published weights, the null for one component, the
 * renormalisation over the evidence a model actually has, and the holdout gap's n on both sides.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openvibeIndex, holdoutGap, ratingScore, INDEX_WEIGHTS, RATING_ANCHOR } = require('../server/rating/stats');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/rating', name), 'utf8'));

test('the published weights are the ones the docs and the API name', () => {
    assert.deepEqual(INDEX_WEIGHTS, { rating: 0.5, benchmarks: 0.5 });
    assert.equal(RATING_ANCHOR, 1000);
    assert.equal(ratingScore(1000), 50);
    assert.ok(Math.abs(ratingScore(1200) - 75.97469266479578) < 1e-9);
    assert.equal(ratingScore(null), null);
});

test('the Index fixture: two components or null, with the weights in the answer', () => {
    for (const testCase of fixture('index-cases.json').cases) {
        const got = openvibeIndex({
            rating: testCase.rating,
            benchmarks: testCase.benchmarks,
            benchmarkCount: testCase.benchmarkCount,
        });
        assert.equal(got.index, testCase.expect.index, testCase.name);
        assert.equal(got.n_components, testCase.expect.n_components, testCase.name);
        assert.equal(got.weight_sum, testCase.expect.weight_sum, testCase.name);
        if (testCase.expect.rating_value != null) {
            assert.equal(got.components[0].value, testCase.expect.rating_value, testCase.name);
        }
        for (const component of got.components) {
            assert.ok(component.weight > 0, testCase.name + ': every component has its weight');
        }
    }
});

test('the Index never invents a score from one component, and null is not zero', () => {
    assert.equal(openvibeIndex({ rating: 1300 }).index, null);
    assert.equal(openvibeIndex({ benchmarks: [{ id: 'b', score: 99 }] }).index, null);
    assert.equal(openvibeIndex({}).index, null);
    assert.equal(openvibeIndex({ rating: 1100, benchmarks: [{ id: 'b', score: 90 }] }).index != null, true);
});

test('a model missing one benchmark of the kind gets the weight renormalised, not a second benchmark', () => {
    const got = openvibeIndex({
        rating: 1000,
        benchmarks: [{ id: 'b1', score: 80 }],
        benchmarkCount: 3,
    });
    assert.equal(got.n_components, 2);
    assert.equal(got.weight_sum, 0.666667);
    assert.equal(got.components.find((c) => c.id === 'b1').weight, 0.166667);
    assert.ok(got.index > 50 && got.index < 80);
});

test('the holdout gap fixture: public minus holdout, with n on each side', () => {
    for (const testCase of fixture('holdout-cases.json').cases) {
        assert.deepEqual(holdoutGap(testCase.public, testCase.holdout), testCase.expect, testCase.name);
    }
});

test('the holdout gap ignores missing scores and keeps the side count honest', () => {
    assert.deepEqual(holdoutGap([80, null, undefined], [null]), {
        public_n: 1, public_score: 80, holdout_n: 0, holdout_score: null, gap: null,
    });
});

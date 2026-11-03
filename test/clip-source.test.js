'use strict';

/**
 * Which recording a live.clip submitter may submit for (item 151, C19). The grant is the service token's `ns`
 * claim; the namespace of a recording is `rec:<recording_id>`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceAllowed, namespaceOf, grantedNamespaces } = require('../server/bench/clip-source');

test('a recording is addressed by its own namespace', () => {
    assert.equal(namespaceOf('vod_5021'), 'rec:vod_5021');
    assert.equal(namespaceOf('  vod_5021  '), 'rec:vod_5021');
    assert.equal(namespaceOf(''), '');
    assert.equal(namespaceOf(null), '');
});

test('a token holds no namespace when its claim names none', () => {
    assert.deepEqual(grantedNamespaces({ ns: ['rec:vod_*'] }), ['rec:vod_*']);
    assert.deepEqual(grantedNamespaces({ ns: [] }), []);
    assert.deepEqual(grantedNamespaces({}), []);
    assert.deepEqual(grantedNamespaces(null), []);
    assert.deepEqual(grantedNamespaces({ ns: 'rec:vod_*' }), []);
});

test('an exact namespace allows its recording and no other', () => {
    const claims = { ns: ['rec:vod_5021'] };
    assert.equal(sourceAllowed(claims, 'vod_5021').allowed, true);
    const denied = sourceAllowed(claims, 'vod_5022');
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, 'bench.clip_source_denied');
});

test('a wildcard namespace allows the recordings it covers', () => {
    assert.equal(sourceAllowed({ ns: ['rec:vod_*'] }, 'vod_5021').allowed, true);
    assert.equal(sourceAllowed({ ns: ['rec:vod_*'] }, 'vod_5022').allowed, true);
    assert.equal(sourceAllowed({ ns: ['rec:vod_*'] }, 'clip_99').allowed, false);
    assert.equal(sourceAllowed({ ns: ['rec:*'] }, 'anything_at_all').allowed, true);
    assert.equal(sourceAllowed({ ns: ['*'] }, 'anything_at_all').allowed, true);
});

test('a token granted no recording is authorised for none', () => {
    for (const claims of [{ ns: [] }, {}, null, { ns: ['other:thing'] }]) {
        const r = sourceAllowed(claims, 'vod_5021');
        assert.equal(r.allowed, false);
        assert.equal(r.code, 'bench.clip_source_denied');
    }
});

test('a clip that names no recording is refused', () => {
    const r = sourceAllowed({ ns: ['rec:*'] }, '');
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'bench.clip_source_missing');
});

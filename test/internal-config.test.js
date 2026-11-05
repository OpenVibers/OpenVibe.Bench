'use strict';
/**
 * D11 owner settings: the bench.variant_evidence namespace and /internal/config.
 * Env pins win; an owner change applies live; bench.config.manage is required; no KEK still works;
 * a secret-class value never leaves a summary, snapshot or history.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const CAP = ['bench.config.manage'];
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const SECRET = 'fixture-bench-d11-not-a-credential';

(async () => {
    const t = await boot({ env: { BENCH_VARIANT_EVIDENCE: '1' } });
    const admin = () => t.network.serviceToken({ sub: 'svc:network', audience: 'openvibe.bench', cap: CAP });
    try {
        await check('the summary: schema, the env pin, sealed:false without a KEK', async () => {
            const r = await t.get('/internal/config/bench.variant_evidence', { bearer: admin() });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.json().namespace, 'bench.variant_evidence');
            assert.strictEqual(r.json().sealed, false);
            assert.strictEqual(r.json().values.enabled, true);
            assert.deepStrictEqual(r.json().pins.enabled, { env: 'BENCH_VARIANT_EVIDENCE', pinned: true });
            assert.ok(!r.text.includes(SECRET));
        });

        await check('a service token without bench.config.manage is refused', async () => {
            const token = t.network.serviceToken({ sub: 'svc:reader', audience: 'openvibe.bench', cap: ['bench.round.read'] });
            const r = await t.get('/internal/config/bench.variant_evidence', { bearer: token });
            assert.strictEqual(r.status, 403);
            assert.strictEqual(r.json().code, 'capability.denied');
        });

        await check('an env-pinned key is read-only', async () => {
            const r = await t.get('/internal/config/bench.variant_evidence', {
                method: 'POST', bearer: admin(), headers: { 'x-ov-subject': OWNER }, json: { values: { enabled: false }, reason: 'off' },
            });
            assert.strictEqual(r.status, 409, r.text.slice(0, 300));
            assert.strictEqual(r.json().code, 'config.pinned_in_env');
        });
    } finally { await t.close(); }

    const live = await boot();
    const liveAdmin = () => live.network.serviceToken({ sub: 'svc:network', audience: 'openvibe.bench', cap: CAP });
    try {
        await check('an owner change applies live: the evidence API appears', async () => {
            const reader = live.network.serviceToken({ sub: 'svc:reader', audience: 'openvibe.bench', cap: ['bench.round.read'] });
            assert.strictEqual((await live.get('/api/v1/variant-families', { bearer: reader })).status, 404);
            const r = await live.get('/internal/config/bench.variant_evidence', {
                method: 'POST', bearer: liveAdmin(), headers: { 'x-ov-subject': OWNER }, json: { values: { enabled: true }, reason: 'owner turned it on' },
            });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.json().revision, 2);
            assert.strictEqual(live.config.bench.variantEvidence, true);
            assert.strictEqual((await live.get('/api/v1/variant-families', { bearer: reader })).status, 200);
            assert.ok(live.logs().includes('by user:' + OWNER));
            assert.ok(!live.logs().includes(SECRET));
        });

        await check('with a KEK the store is sealed and boot reseals', async () => {
            const sealed = await boot({ env: { OV_CONFIG_KEKS: 'k1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=', OV_CONFIG_KEK_CURRENT: 'k1' } });
            try {
                const token = sealed.network.serviceToken({ sub: 'svc:network', audience: 'openvibe.bench', cap: CAP });
                const r = await sealed.get('/internal/config/bench.variant_evidence', { bearer: token });
                assert.strictEqual(r.status, 200, r.text.slice(0, 300));
                assert.strictEqual(r.json().sealed, true);
                assert.strictEqual(r.json().kek, 'k1');
            } finally { await sealed.close(); }
        });

        await check('a secret is write-only and never appears in a summary, snapshot or history', async () => {
            const shared = require('openvibe-shared/config');
            const extra = await shared.createConfigStore({
                db: live.store.db, service: 'bench', namespace: 'bench.test_secrets',
                schema: { type: 'object', additionalProperties: false, properties: { api_key: { type: 'string' } } },
                classify: () => 'secret',
            });
            const marker = await extra.setSecret('api_key', SECRET, { actor: { type: 'user', id: OWNER }, reason: 'test' });
            assert.strictEqual(marker.redacted, true);
            assert.ok(!JSON.stringify(marker).includes(SECRET));
            const summary = await extra.summary();
            assert.strictEqual(summary.values.api_key.redacted, true);
            assert.ok(!JSON.stringify(summary).includes(SECRET));
            assert.ok(!JSON.stringify(await extra.history()).includes(SECRET));
            assert.ok(!JSON.stringify(await extra.snapshot(1)).includes(SECRET));
        });
    } finally { await live.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

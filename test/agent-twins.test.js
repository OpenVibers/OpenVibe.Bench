'use strict';
// The Bench public pages moved into OpenVibe.Report's AI section (owner, 2026-11-08). Every old page and its
// Markdown twin answer one permanent redirect to the Report counterpart; an unknown twin is still a 404, and the
// API keeps answering here.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const COMPARE = 'https://openvibe.compare';
    try {
        await check('the old public pages answer one 301 to their Report counterparts', async () => {
            const list = await t.get('/api/v1/benchmarks?limit=1');
            const b = list.json().benchmarks[0];
            const pages = [
                ['/', '/ai'],
                ['/docs', '/ai/method'],
                ['/benchmarks', '/ai'],
                [`/benchmarks/${b.id}`, `/ai/${b.id}`],
                ['/compare', '/ai/compare'],
                ['/showcase', '/ai'],
                ['/gallery', '/ai'],
            ];
            for (const [p, target] of pages) {
                const r = await t.get(p);
                assert.strictEqual(r.status, 301, p);
                assert.strictEqual(r.headers.get('location'), `${COMPARE}${target}`, p);
            }
        });

        await check('a Markdown twin follows its page; an unknown twin stays a 404', async () => {
            const docs = await t.get('/docs.md');
            assert.strictEqual(docs.status, 301);
            assert.strictEqual(docs.headers.get('location'), `${COMPARE}/ai/method.md`);
            const missing = await t.get('/no-such-page-here.md');
            assert.strictEqual(missing.status, 404);
        });

        await check('the API and the agent manifest still answer here', async () => {
            assert.strictEqual((await t.get('/api/v1/kinds')).status, 200);
            assert.strictEqual((await t.get('/api/v1/overview')).status, 200);
            assert.strictEqual((await t.get('/.well-known/agent.json')).status, 200);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
// The Bench pages moved to OpenVibe.Report (2026-11-08). Bench keeps the API, the agent manifest and its datasets;
// the two llms files answer 301 to Report's, which now describes the AI section.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    await check('llms.txt and llms-full.txt answer 301 to Report', async () => {
        for (const p of ['/llms.txt', '/llms-full.txt']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 301, p);
            assert.strictEqual(r.headers.get('location'), `https://openvibe.compare${p}`, p);
        }
    });
    await check('the API docs stay readable as JSON on Bench', async () => {
        const r = await t.get('/openapi.json');
        assert.strictEqual(r.status, 200);
        assert.ok(r.json().paths && Object.keys(r.json().paths).length > 0);
    });
    await check('stop', async () => { await t.close(); });
    done();
})();

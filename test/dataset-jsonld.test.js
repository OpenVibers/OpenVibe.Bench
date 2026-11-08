'use strict';
// The Bench pages (with their schema.org Dataset nodes) moved into OpenVibe.Report's AI section (2026-11-08).
// The open datasets themselves stay on Bench's API, which still lists every public kind.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    await check('the home page redirects and the dataset API stays on Bench', async () => {
        const home = await t.get('/');
        assert.strictEqual(home.status, 301);
        const kinds = await t.get('/api/v1/kinds');
        assert.strictEqual(kinds.status, 200);
        const list = kinds.json().kinds;
        assert.ok(list.length >= 2, `only ${list.length} kinds`);
        for (const k of list) {
            const data = await t.get(`/api/v1/datasets/${encodeURIComponent(k.id)}.jsonl`);
            assert.strictEqual(data.status, 200, k.id);
        }
    });
    await check('stop', async () => { await t.close(); });
    done();
})();

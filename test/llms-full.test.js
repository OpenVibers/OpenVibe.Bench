'use strict';
// SEO-33: /llms-full.txt holds the API page in full (it was one line a page, 314 characters in all), from the same
// view /docs renders, so a language model reading it learns the API without fetching HTML.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    await check('llms-full.txt: the home, then the API page in full', async () => {
        const r = await t.get('/llms-full.txt');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type') || '', /^text\/plain/);
        assert.ok(r.text.startsWith('# OpenVibe.Bench'));
        assert.match(r.text, /### The Bench API\n\nURL: [^\n]*\/docs\n/);
        assert.ok(r.text.length > 2000, `${r.text.length} characters`);
        assert.ok(!/<\/?(div|p|span|a|code|pre|section|h[1-6]|li|ul|ol|table|tr|td|th|button|nav)\b[^>]*>/i.test(r.text.split('### The Bench API')[1] || ''), 'the page as text, no markup');
    });
    await check('llms.txt (AGT-5): own pages at their Markdown twins, the API and files as they are, Optional last', async () => {
        const r = await t.get('/llms.txt');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /\(https?:\/\/[^)]*\/index\.md\)/, 'the home links its twin');
        assert.match(r.text, /\(https?:\/\/[^)]*\/docs\.md\)/);
        assert.match(r.text, /\(https?:\/\/[^)]*\/api\/v1\/kinds\)/);
        assert.ok(r.text.includes('\n## Optional\n') && r.text.lastIndexOf('\n## ') === r.text.indexOf('\n## Optional\n'));
        const twin = await t.get('/docs.md');
        assert.strictEqual(twin.status, 200, 'the twin it links answers');
    });
    await check('stop', async () => { await t.close(); });
    done();
})();

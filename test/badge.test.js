'use strict';

/** The badge (B10): escaped text, a width from the text, the right headers, and a grey badge with a 404. */

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { badgeSvg } = require('../server/http/badge');

(async () => {
    await check('the text of the badge is escaped', () => {
        const svg = badgeSvg({ label: 'a & b <script>', message: '"x" \'y\'' });
        assert.ok(svg.includes('&amp;'), 'the ampersand');
        assert.ok(svg.includes('&lt;script&gt;'), 'the angle brackets');
        assert.ok(!svg.includes('<script>'), 'no raw script tag');
    });

    await check('the width comes from the text', () => {
        const short = badgeSvg({ label: 'ab', message: 'c' });
        const long = badgeSvg({ label: 'a much longer benchmark title', message: 'c' });
        const w = (s) => Number(/width="(\d+)"/.exec(s)[1]);
        assert.ok(w(long) > w(short), 'the longer badge is wider: ' + w(long) + ' vs ' + w(short));
    });

    const t = await boot();
    const list = (await t.get('/api/v1/benchmarks')).json();
    const benchmark = (list.benchmarks || list)[0];

    await check('an unknown benchmark gets a grey badge and a 404', async () => {
        const r = await t.get('/badge/bmk_nope/nope.svg');
        assert.strictEqual(r.status, 404, r.text.slice(0, 200));
        assert.ok(/image\/svg\+xml/.test(r.headers.get('content-type')), 'the type: ' + r.headers.get('content-type'));
        assert.strictEqual(r.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'");
        assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=3600');
        assert.ok(r.text.includes('no data'), 'it says there is no data');
        assert.ok(r.text.includes('<svg'), 'and it is still a picture');
    });

    await check('a model with no runs gets a grey badge and a 404', async () => {
        const r = await t.get('/badge/' + benchmark.id + '/no-such-model.svg');
        assert.strictEqual(r.status, 404);
        assert.ok(r.text.includes('no data'), 'it says there is no data');
    });

    await check('a badge may be used from another site', async () => {
        const r = await t.get('/badge/' + benchmark.id + '/no-such-model.svg');
        assert.strictEqual(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

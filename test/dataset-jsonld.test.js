'use strict';
/**
 * The home page lists the kinds, so each kind it lists is a schema.org Dataset: the JSONL the API serves for that kind
 * is the dataset itself (url and distribution), the description restates the kind's own room, judge and entry type, and
 * no licence is claimed because Bench states none. /docs publishes no dataset, so it carries no Dataset node.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const nodes = (html, type) => [...String(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1])).filter((x) => x['@type'] === type);

(async () => {
    const t = await boot();
    let kinds;

    await check('the home page carries one Dataset per kind, describing what the page lists', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        kinds = (await t.get('/api/v1/kinds')).json().kinds;
        assert.ok(kinds.length >= 2, `only ${kinds.length} kinds`);
        const sets = nodes(r.text, 'Dataset');
        assert.deepStrictEqual(sets.map((d) => d.name), kinds.map((k) => k.name));
        for (const [i, d] of sets.entries()) {
            const k = kinds[i];
            const url = `https://bench.openvibe.services/api/v1/datasets/${encodeURIComponent(k.id)}.jsonl`;
            assert.strictEqual(d.url, url);
            assert.strictEqual(d.distribution['@type'], 'DataDownload');
            assert.strictEqual(d.distribution.contentUrl, url);
            assert.strictEqual(d.creator.name, 'OpenVibe.Bench');
            assert.ok(d.description.includes(k.room) && d.description.includes(k.name), d.description);
            assert.ok(!('license' in d), 'no licence is claimed for data Bench does not license');
            assert.ok(r.text.includes(`href="/api/v1/boards/${k.id}?type=elo"`), `${k.id} is not listed on the page`);
        }
    });

    await check('/docs publishes no dataset and therefore carries no Dataset node', async () => {
        const r = await t.get('/docs');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(nodes(r.text, 'Dataset'), []);
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

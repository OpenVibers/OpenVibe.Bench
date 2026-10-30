'use strict';
// The home on a phone (the owner's short-pages rule, 2026-10-30): the parts a reader rarely needs — the promises
// and the kinds for developers — fold closed, with a checkbox and a label and no script. Everything stays in the
// page for the crawlers, and where there is room the fold is open and looks like the section it replaces.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();

    await check('the home folds the promises and the kinds for developers, and keeps both in the page', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        const home = r.text;
        for (const [id, title] of [['bm-why', 'What Bench promises'], ['bm-kinds', 'For developers: the arena kinds']]) {
            const re = new RegExp(`<div class="fold[^"]*" id="fold-${id}"><input class="fold-toggle" type="checkbox" id="fold-${id}-open">`
                + `<label class="fold-h" for="fold-${id}-open"><h2[^>]*>[^<]*${title}[^<]*</h2>.*?<div class="fold-body">`);
            assert.ok(re.test(home), `the ${title} fold is on the home`);
        }
        // The parts themselves are in the page, not removed: the four promises and every kind.
        assert.strictEqual((home.match(/<li><b>(Outputs, not just scores|Every run published|Value you can read|Free and open)<\/b>/g) || []).length, 4, 'the four promises are in the page');
        const kinds = (home.match(/class="bm-kind-link"/g) || []).length;
        assert.ok(kinds >= 9, `the kinds are in the page (${kinds})`);
        assert.match(home, /<h2 id="bm-kinds-h">For developers: the arena kinds<\/h2>/, 'the kinds keep their heading');
        // The benchmarks are the main thing on the home: they stay as they were.
        assert.match(home, /<section class="bm-section" aria-labelledby="bm-bench-h">/, 'the benchmarks section is where it was');
    });

    await check('the fold is closed on a phone and open where there is room', async () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'bench.css'), 'utf8');
        const fold = css.slice(css.indexOf('/* The fold (the owner'));
        assert.ok(fold.length > 0, 'the fold rules are in bench.css');
        assert.match(fold, /\.fold-body \{ display: none; \}/, 'the body is closed by default');
        assert.match(fold, /\.fold-toggle:checked ~ \.fold-body \{ display: block; \}/, 'the title row opens it');
        assert.match(fold, /\.fold-toggle \{ display: none; \}/, 'the toggle is hidden where there is room');
        assert.match(fold, /\.fold-body \{ display: block; \}/, 'the body is open where there is room');
        assert.match(fold, /\.fold-nohead > \.fold-h \{ display: none; \}/, 'a part with no heading of its own looks as it did');
        assert.ok(!/#[0-9a-f]{3,6}\b/i.test(fold.replace(/#[0-9a-f]{3,6}\b/gi, '')), 'no new colours in the fold rules');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

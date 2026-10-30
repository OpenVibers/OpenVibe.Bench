'use strict';

/**
 * Mirror published results into Bench (B12).
 *
 *   node scripts/mirror-import.js                                  # what HELM would bring (writes nothing)
 *   node scripts/mirror-import.js --source helm --group mmlu --release v1.13.0
 *   node scripts/mirror-import.js --apply                           # write it
 *
 * A source is read only when its licence clears, and every row that lands says where it came from, under which
 * licence and the day it was read. The same model, benchmark version and source never land twice.
 *
 * Run it as the service user, with the service's own environment (never printed):
 *
 *   sudo systemd-run --wait --pipe --uid=ubuntu --gid=ubuntu \
 *     --property=EnvironmentFile=/etc/openvibe/bench.env \
 *     --working-directory=/opt/openvibe.bench /usr/bin/env node scripts/mirror-import.js
 */
const { load } = require('../server/config');
const { openStore } = require('../server/db');
const { createRegistry } = require('../server/bench/registry');
const { createMirror } = require('../server/bench/mirror');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const value = (name, fallback) => {
    const at = argv.indexOf('--' + name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

(async () => {
    const config = load();
    const s = await openStore(config, { log: console });
    const registry = createRegistry(s, { log: console });
    const mirror = createMirror({ s, registry, fetchImpl: globalThis.fetch, log: console });
    const source = value('source', 'helm');
    const options = {
        suite: value('suite', undefined),
        release: value('release', undefined),
        group: value('group', undefined),
        limit: value('limit', undefined),
    };
    const out = flag('apply')
        ? await mirror.apply(source, options)
        : await mirror.preview(source, options);
    if (!out.ok) {
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        process.exitCode = 1;
        return;
    }
    if (flag('apply')) {
        process.stdout.write(JSON.stringify({
            source: out.source, licence: out.licence, licence_url: out.licence_url, read_at: out.read_at,
            written: out.written.length, skipped: out.skipped.length,
        }, null, 2) + '\n');
        return;
    }
    const sample = (out.rows || []).slice(0, 10).map((r) => ({ benchmark: r.benchmark, model: r.model, score: Math.round(r.score * 100) / 100, source_url: r.source_url }));
    process.stdout.write(JSON.stringify({
        source: out.source, title: out.title, url: out.url, licence: out.licence, licence_url: out.licence_url,
        licence_quote: out.licence_quote, attribution: out.attribution, rows: out.count, sample,
    }, null, 2) + '\n');
})().catch((err) => {
    process.stderr.write('The mirror failed: ' + ((err && err.message) || err) + '\n');
    process.exitCode = 1;
});

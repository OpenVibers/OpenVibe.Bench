'use strict';

/**
 * Bench's server-rendered pages: a plain home and the API docs. Public boards are JSON only (Report renders their
 * HTML later).
 */
const express = require('express');
const seo = require('openvibe-shared/seo');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { raw } = require('../render/html');
const { send } = require('../render/layout');
const views = require('../views');
const results = require('../views/results');

const PUBLIC_CACHE = 'public, max-age=60';

/**
 * One Dataset node per kind the home lists. The dataset is the JSONL the API already serves for that kind, so its url
 * and its download are the endpoint itself; the description restates the kind's own room, judge and entry type.
 * Bench states no licence for the data, so no licence is claimed here.
 */
function datasetJsonLd(k, base) {
    const contentUrl = `${base}/api/v1/datasets/${encodeURIComponent(k.id)}.jsonl`;
    return {
        '@context': 'https://schema.org',
        '@type': 'Dataset',
        name: k.name,
        description: `${k.name}: a ${String(k.judge).replace(/_/g, ' ')} benchmark of ${String(k.entry).replace(/_/g, ' ')} entries from the ${k.room} room.`,
        creator: { '@type': 'Organization', name: 'OpenVibe.Bench', url: base },
        keywords: [k.id, k.room, k.judge, k.entry],
        distribution: { '@type': 'DataDownload', contentUrl, encodingFormat: 'application/x-ndjson' },
        url: contentUrl,
    };
}

/**
 * The page's JSON-LD in one script: every node in one @graph, so a page carries exactly one JSON-LD script.
 * The nodes keep their own fields; only their own @context goes, because the graph carries it once.
 */
function oneGraph(nodes) {
    const graph = nodes.filter(Boolean).map((n) => { const c = { ...n }; delete c['@context']; return c; });
    return [{ '@context': 'https://schema.org', '@graph': graph }];
}

function createPageRoutes(ctx) {
    const { config, bench, registry } = ctx;
    const r = asyncRouter();
    const base = () => String(config.baseUrl).replace(/\/+$/, '');
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });

    r.get('/', async (req, res) => {
        const kinds = await bench.listKinds();
        const benchmarks = await registry.listBenchmarks({ limit: 6 });
        const counts = await registry.runCounts();
        for (const b of benchmarks) b.runs = counts.get(b.id) || 0;
        return page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: null,
            description: 'OpenVibe.Bench shows what AI models really make: the same tasks on every model, outputs live side by side, every run published with its cost and time, free and open.',
            jsonLd: oneGraph([...homeJsonLd(config), ...kinds.map((k) => datasetJsonLd(k, base())), seo.jsonLd.organization()]),
            body: raw(views.home({ kinds, counts: { kinds: kinds.length }, benchmarks })),
        });
    });

    // ---- the results pages (B2) ----------------------------------------------------------------------------
    const subjectOf = (req) => (req.viewer && req.viewer.kind === 'user' ? (req.viewer.subject || req.viewer.id || null) : null);
    const notFound = (req, res, what) => page(req, res, { title: `No such ${what}`, body: raw(views.notFound()) }, 404);
    const METRIC_IDS = results.METRICS.map((m) => m.id);

    r.get('/benchmarks', async (req, res) => {
        const q = String(req.query.q || '').slice(0, 80);
        const family = String(req.query.kind || '').replace(/[^a-z0-9._-]/gi, '').slice(0, 40) || null;
        const all = await registry.listBenchmarks({ q: q || null, limit: 200 });
        const kinds = [...new Set(all.map((b) => b.kind).filter(Boolean))];
        const list = family ? all.filter((b) => b.kind === family || String(b.kind).startsWith(`${family}.`)) : all;
        const counts = await registry.runCounts();
        for (const b of list) b.runs = counts.get(b.id) || 0;
        return page(req, res, {
            index: !q && !family, cache: PUBLIC_CACHE,
            title: 'Benchmarks',
            description: 'Versioned AI benchmarks anyone can run again: tasks, judges and limits, with every run published.',
            jsonLd: [seo.jsonLd.webPage({ name: 'Benchmarks', url: `${base()}/benchmarks`, description: 'Versioned AI benchmarks anyone can run again.', siteUrl: base() })],
            body: raw(String(results.benchmarksIndex({ benchmarks: list, kinds, kind: family, q }))),
        });
    });

    r.get('/benchmarks/:ref', async (req, res) => {
        const ref = String(req.params.ref || '');
        const out = await registry.getDefinition(ref, { reveal: false });
        const subject = subjectOf(req);
        if (!out || (out.benchmark.visibility === 'private' && out.benchmark.owner !== subject)) return notFound(req, res, 'benchmark');
        const metric = METRIC_IDS.includes(String(req.query.metric)) ? String(req.query.metric) : 'score';
        const id = out.benchmark.id;
        const [rankings, runs] = await Promise.all([
            registry.rankings({ benchmark: id, metric }),
            registry.listRuns({ benchmark: id, limit: 8 }),
        ]);
        const isPublic = out.benchmark.visibility === 'public';
        return page(req, res, {
            index: isPublic && metric === 'score', cache: isPublic ? PUBLIC_CACHE : null,
            title: out.benchmark.title,
            description: out.benchmark.description || `${out.benchmark.title}: rankings, value and every run.`,
            jsonLd: [seo.jsonLd.webPage({ name: out.benchmark.title, url: `${base()}/benchmarks/${encodeURIComponent(id)}`, description: out.benchmark.description || out.benchmark.title, siteUrl: base() })],
            body: raw(String(results.benchmarkPage({
                benchmark: out.benchmark, definition: out.definition, version: out.version && out.version.version,
                rankings, metric, runs, codesRunUrl: config.codesRunUrl || null,
            }))),
        });
    });

    r.get('/runs/:id', async (req, res) => {
        const run = await registry.getRun(String(req.params.id || ''));
        if (!run) return notFound(req, res, 'run');
        const def = await registry.getDefinition(`${run.benchmark_id}@${run.benchmark_version}`, { reveal: false });
        const benchmark = def ? def.benchmark : null;
        if (benchmark && benchmark.visibility === 'private' && benchmark.owner !== subjectOf(req)) return notFound(req, res, 'run');
        const pct = run.score != null ? await registry.percentile({ benchmark: run.benchmark_id, model: run.model, score: run.score }) : null;
        const isPublic = !benchmark || benchmark.visibility === 'public';
        return page(req, res, {
            index: isPublic && run.provenance === 'verified', cache: isPublic ? PUBLIC_CACHE : null,
            title: `${run.model} on ${benchmark ? benchmark.title : run.benchmark_id}`,
            description: `${run.model} scored ${results.fmtScore(run.score)} out of 100 on ${benchmark ? benchmark.title : 'this benchmark'}, for ${results.fmtUsd(run.cost_usd)}.`,
            body: raw(String(results.runPage({ run, benchmark, definition: def && def.definition, pct }))),
        });
    });

    r.get('/compare', async (req, res) => {
        const refs = String(req.query.runs || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 4);
        let cmp = refs.length ? await registry.compareRuns(refs) : null;
        const titles = {};
        if (cmp) {
            const subject = subjectOf(req);
            const keep = [];
            for (const run of cmp.runs) {
                const b = await registry.getBenchmark(run.benchmark_id);
                if (b && b.visibility === 'private' && b.owner !== subject) continue;
                if (b) titles[b.id] = b.title;
                keep.push(run);
            }
            cmp = keep.length ? { ...cmp, runs: keep, rows: cmp.rows.map((row) => ({ ...row, scores: keep.map((run) => { const t = run.tasks.find((x) => x.task_id === row.task_id); return t ? t.score : null; }) })) } : null;
        }
        return page(req, res, {
            index: false, cache: PUBLIC_CACHE,
            title: cmp ? `Compare: ${cmp.runs.map((x) => x.model).join(' vs ')}` : 'Compare runs',
            description: 'Runs side by side: the same tasks, their scores, cost, time and outputs.',
            body: raw(String(results.comparePage({ cmp, titles }))),
        });
    });

    r.get('/models/:model', async (req, res) => {
        const model = String(req.params.model || '').slice(0, 160);
        const [summary, runs] = await Promise.all([
            registry.modelSummary(model),
            registry.listRuns({ model, publicOnly: true, limit: 12 }),
        ]);
        const titles = {};
        for (const b of summary.benchmarks) titles[b.benchmark_id] = b.title;
        for (const run of runs) {
            if (!titles[run.benchmark_id]) { const b = await registry.getBenchmark(run.benchmark_id); if (b) titles[b.id] = b.title; }
        }
        return page(req, res, {
            index: summary.runs > 0, cache: PUBLIC_CACHE,
            title: model,
            description: `${model} across OpenVibe.Bench: its median score, spread, cost and time on every benchmark it ran.`,
            body: raw(String(results.modelPage({ model, summary, runs, titles }))),
        }, summary.runs > 0 || runs.length ? 200 : 404);
    });

    r.get('/docs', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: 'The Bench API',
        description: 'The Bench JSON API, the boards, the open dataset and the MCP tools.',
        jsonLd: [seo.jsonLd.webPage({ name: 'The Bench API', url: `${base()}/docs`, description: 'The Bench JSON API, the boards, the open dataset and the MCP tools.', siteUrl: base() })],
        body: raw(views.docs()),
    }));

    r.use(createDiscoveryRoutes(ctx));

    return r;
}

module.exports = { createPageRoutes };

'use strict';

/**
 * The render origin's routes (spec 2). The model output is served from its own path, on its own origin, with no
 * cookies and no session: /render/w/:entryId is the trusted wrapper (clock and stop button), /render/e/:entryId is the
 * model's own document under the strict CSP.
 */

const express = require('express');
const crypto = require('crypto');
const renderLib = require('../bench/render');
const { kindById } = require('../kinds');

function createRenderRoutes(ctx) {
    const r = express.Router();

    async function entryOf(id) {
        const row = await ctx.s.db.maybe(
            'SELECT e.id, e.payload, e.error, r.kind_id FROM bench_entries e JOIN bench_rounds r ON r.id = e.round_id WHERE e.id = $1',
            [String(id || '')]);
        if (!row) {
            const match = /^((?:brn_)[0-9A-HJKMNP-TV-Z]{26})~([A-Za-z0-9_-]{1,120})$/.exec(String(id || ''));
            if (!match) return null;
            const taskId = Buffer.from(match[2], 'base64url').toString('utf8');
            const runTask = await ctx.s.db.maybe(
                `SELECT t.artifacts, v.definition FROM bench_run_tasks t
                 JOIN bench_runs r ON r.id = t.run_id
                 JOIN bench_benchmark_versions v ON v.benchmark_id = r.benchmark_id AND v.version = r.benchmark_version
                 WHERE t.run_id = $1 AND t.task_id = $2`, [match[1], taskId]);
            if (!runTask) return null;
            let artifacts = runTask.artifacts;
            let definition = runTask.definition;
            if (typeof artifacts === 'string') { try { artifacts = JSON.parse(artifacts); } catch { artifacts = []; } }
            if (typeof definition === 'string') { try { definition = JSON.parse(definition); } catch { definition = {}; } }
            const artifact = (Array.isArray(artifacts) ? artifacts : []).find((a) => a && a.payload);
            if (!artifact) return null;
            return { id: String(id), payload: artifact.payload, error: null, kind: kindById(definition && definition.kind) };
        }
        let payload = row.payload;
        if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = {}; } }
        return { id: row.id, payload: payload || {}, error: row.error || null, kind: kindById(row.kind_id) };
    }

    /** No cookies on this origin, ever. */
    function bare(res) {
        res.removeHeader('Set-Cookie');
        res.removeHeader('X-Frame-Options');   // helmet's DENY; frame-ancestors in each response's CSP names who may frame it
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'no-referrer');
        return res;
    }

    r.get('/w/:entryId', async (req, res) => {
        const entry = await entryOf(req.params.entryId);
        if (!entry) return bare(res).status(404).type('text/plain').send('No such entry.');
        const kind = entry.kind;
        const nonce = crypto.randomBytes(16).toString('base64');
        const doc = renderLib.wrapperDocument({
            nonce,
            entryId: entry.id,
            kindId: kind ? kind.id : '',
            limitMs: renderLib.limitMsOf(kind),
            title: kind ? kind.name : 'Generated output',
        });
        return bare(res)
            .set('Content-Security-Policy', renderLib.wrapperCsp(nonce))
            .type('html')
            .send(doc);
    });

    r.get('/e/:entryId', async (req, res) => {
        const entry = await entryOf(req.params.entryId);
        if (!entry) return bare(res).status(404).type('text/plain').send('No such entry.');
        const kind = entry.kind;
        const nonce = crypto.randomBytes(16).toString('base64');
        if (kind && renderLib.modeOf(kind) === 'static') {
            const p = renderLib.renderablePayload(kind, entry.payload);
            const svg = renderLib.sanitizeSvg(p.svg || p.html || '');
            return bare(res)
                .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox")
                .type('image/svg+xml')
                .send(svg);
        }
        const doc = renderLib.modelDocument(kind, entry.payload, { nonce });
        return bare(res)
            .set('Content-Security-Policy', renderLib.cspFor(nonce))
            .type('html')
            .send(doc);
    });

    return r;
}

module.exports = { createRenderRoutes };

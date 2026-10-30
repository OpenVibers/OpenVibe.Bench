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
        if (!row) return null;
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

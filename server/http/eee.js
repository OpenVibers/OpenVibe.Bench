'use strict';

/**
 * The EEE routes (B2).
 *
 *   GET  /api/v1/datasets/eee                    Bench's public runs as EEE `evaluation_run` records (JSONL, paged)
 *   GET  /api/v1/datasets/eee/runs/:id.samples.jsonl   one run's per-sample scores
 *   GET  /api/v1/external/records                the imported EEE records, each `external: true` with its provenance
 *   POST /api/v1/admin/eee/sync                  one bounded pass of the weekly import (operator token)
 *
 * Everything here is public except the sync, which is the operator's own switch and reads the public datastore.
 */
const crypto = require('crypto');
const { asyncRouter } = require('./router');

function operatorToken(req) {
    const h = String(req.get('authorization') || '');
    return /^Bearer\s+\S/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : null;
}

function tokenMatches(given, expected) {
    if (!given || !expected) return false;
    const a = crypto.createHash('sha256').update(String(given), 'utf8').digest();
    const b = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createEeeRoutes(ctx) {
    const r = asyncRouter();
    const eee = ctx.eee;
    const token = process.env.BENCH_ADMIN_TOKEN || '';

    const paging = (req) => ({
        offset: Math.max(0, Number(req.query.offset) || 0),
        limit: Math.max(1, Math.min(1000, Number(req.query.limit) || 500)),
    });

    const jsonl = (res, text, name) => {
        res.set('Cache-Control', 'public, max-age=60');
        res.set('Content-Disposition', `attachment; filename="${name}"`);
        return res.type('application/x-ndjson').send(text);
    };

    r.get('/api/v1/datasets/eee', async (req, res) => {
        const { offset, limit } = paging(req);
        const [text, total] = await Promise.all([eee.exportLines({ offset, limit }), eee.exportCount()]);
        res.set('X-Total-Count', String(total));
        return jsonl(res, text, 'bench-eee.jsonl');
    });

    r.get('/api/v1/datasets/eee.jsonl', async (req, res) => {
        const { offset, limit } = paging(req);
        const [text, total] = await Promise.all([eee.exportLines({ offset, limit }), eee.exportCount()]);
        res.set('X-Total-Count', String(total));
        return jsonl(res, text, 'bench-eee.jsonl');
    });

    r.get('/api/v1/datasets/eee/runs/:id.samples.jsonl', async (req, res) => {
        const out = await eee.samplesOf(String(req.params.id || ''));
        if (!out) return res.status(404).type('text/plain').send('No such public run.');
        res.set('X-Total-Count', String(out.lines.length));
        return jsonl(res, out.lines.length ? out.lines.join('\n') + '\n' : '', `${out.run.id}-samples.jsonl`);
    });

    // The external records: imported, never rated, always labelled with where they came from.
    r.get('/api/v1/external/records', async (req, res) => {
        const { offset, limit } = paging(req);
        const filters = {
            model: req.query.model ? String(req.query.model) : null,
            family: req.query.family ? String(req.query.family) : null,
            task: req.query.task ? String(req.query.task) : null,
            sourceType: req.query.source_type ? String(req.query.source_type) : null,
            republishableOnly: req.query.republishable === '1' || req.query.republishable === 'true',
        };
        const [records, total] = await Promise.all([
            eee.listRecords({ ...filters, offset, limit }),
            eee.countRecords(filters),
        ]);
        res.set('Cache-Control', 'public, max-age=60');
        return res.json({ count: records.length, total, offset, limit, external: true, records });
    });

    r.get('/api/v1/external/sync', async (_req, res) => {
        res.set('Cache-Control', 'public, max-age=30');
        return res.json({ sync: await eee.latestSync() });
    });

    r.post('/api/v1/admin/eee/sync', async (req, res) => {
        if (!token) return res.status(404).type('text').send('No such route.');
        if (!tokenMatches(operatorToken(req), token)) return res.status(403).type('text').send('The operator token is required.');
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const out = await eee.sync({
            maxFiles: body.max_files ? Math.max(1, Math.min(20000, Number(body.max_files))) : undefined,
            maxRecords: body.max_records ? Math.max(1, Math.min(200000, Number(body.max_records))) : undefined,
        });
        return res.json(out);
    });

    return r;
}

module.exports = { createEeeRoutes, tokenMatches };

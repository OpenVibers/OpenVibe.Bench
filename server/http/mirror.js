'use strict';

/**
 * The operator's mirror route (B12). It is not a public API: it needs the operator's own token, and it reads
 * the sources' licences before it writes anything. A dry run (the default) says what it would import and from
 * where, and writes nothing.
 */
const { asyncRouter } = require('./router');

function operatorToken(req) {
    const h = String(req.get('authorization') || '');
    return /^Bearer\s+\S/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : null;
}

function createMirrorRoutes(ctx) {
    const r = asyncRouter();
    const token = process.env.BENCH_ADMIN_TOKEN || '';

    r.post('/api/v1/admin/mirror', async (req, res) => {
        if (!token) return res.status(404).type('text').send('No such route.');
        const given = operatorToken(req);
        if (!given || given !== token) return res.status(403).type('text').send('The operator token is required.');
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const source = String(body.source || 'helm');
        const options = {
            suite: body.suite ? String(body.suite) : undefined,
            release: body.release ? String(body.release) : undefined,
            group: body.group ? String(body.group) : undefined,
            limit: body.limit ? Number(body.limit) : undefined,
        };
        const apply = body.apply === true || body.apply === 'true';
        const out = apply
            ? await ctx.mirror.apply(source, options)
            : await ctx.mirror.preview(source, options);
        return res.json(out);
    });

    return r;
}

module.exports = { createMirrorRoutes };

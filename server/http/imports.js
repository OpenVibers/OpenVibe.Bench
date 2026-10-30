'use strict';

/**
 * Bringing your own results (B12): the upload form, the preview and the file itself.
 *
 * The upload is a plain form post, same-origin (CSRF), signed in, and capped at 20 MB by the body parser. The
 * file is the person's own: the page that shows it is theirs, and the file stays private until they share the
 * benchmark it became.
 */
const express = require('express');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./same-origin');
const { parseMultipart } = require('./multipart');
const { raw } = require('../render/html');
const { send } = require('../render/layout');
const views = require('../views/imports');
const { ImportError } = require('../bench/importers/limits');

function createImportRoutes(ctx) {
    const { config } = ctx;
    const r = asyncRouter();
    const subjectOf = (req) => (req.viewer && req.viewer.kind === 'user' ? (req.viewer.subject || req.viewer.id || null) : null);
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });

    const upload = async (req, res) => {
        const subject = subjectOf(req);
        const loginUrl = '/auth/login?next=' + encodeURIComponent('/imports');
        // The upload is the person's own: a visitor who is not signed in goes to the sign-in and comes back.
        if (!subject) return res.redirect(303, loginUrl);
        const imports = await ctx.imports.listFor(subject, { limit: 10 });
        return page(req, res, {
            index: false,
            title: 'Import a results file',
            description: 'Bring the results file of Inspect AI, Harbor, lm-evaluation-harness or promptfoo, and see the runs it holds before they are imported.',
            body: raw(String(views.uploadPage({ signedIn: Boolean(subject), loginUrl, imports, error: req.query.error ? String(req.query.error).slice(0, 200) : null }))),
        });
    };
    r.get('/imports', upload);

    r.post('/imports', express.raw({ type: 'multipart/form-data', limit: '21mb' }), ctx.principal.middleware, async (req, res) => {
        const subject = subjectOf(req);
        const loginUrl = '/auth/login?next=' + encodeURIComponent('/imports');
        const fail = (status, error) => page(req, res, {
            index: false, title: 'Import a results file',
            description: 'Bring a results file of Inspect AI, Harbor, lm-evaluation-harness or promptfoo.',
            body: raw(String(views.uploadPage({ signedIn: Boolean(subject), loginUrl, error }))),
        }, status);
        if (!sameOrigin(req, config)) return res.status(403).type('text').send('This form only works from Bench itself.');
        if (!subject) return fail(401, 'Sign in to bring your own results.');
        const parts = parseMultipart(req.body, req.get('content-type'));
        if (!parts) return fail(422, 'That upload did not arrive as a form. Try again.');
        const file = parts.parts.find((p) => p.name === 'file' && p.data && p.data.length);
        if (!file) return fail(422, 'Pick a results file to read.');
        const toolPart = parts.parts.find((p) => p.name === 'tool');
        const tool = toolPart ? String(toolPart.data.toString('utf8')).trim() : '';
        try {
            const imp = await ctx.imports.store({
                owner: subject, subject, filename: file.filename || 'results', bytes: file.data, tool: tool || null,
            });
            return res.redirect(303, '/imports/' + encodeURIComponent(imp.id));
        } catch (err) {
            const detail = err instanceof ImportError ? err.detail : 'That file could not be read.';
            return fail(err instanceof ImportError ? err.status : 422, detail);
        }
    });

    /** The preview: what the file says, before anything is written. */
    r.get('/imports/:id', async (req, res) => {
        const subject = subjectOf(req);
        const imp = await ctx.imports.get(String(req.params.id || ''));
        if (!imp || String(imp.owner) !== String(subject)) {
            return page(req, res, { index: false, title: 'No such upload', body: raw(String(require('../views').notFound())) }, 404);
        }
        return page(req, res, {
            index: false,
            title: 'Import preview',
            description: 'What this results file holds, before it is imported.',
            body: raw(String(views.previewPage({ imp }))),
        });
    });

    r.post('/imports/:id/confirm', ctx.principal.middleware, async (req, res) => {
        const subject = subjectOf(req);
        if (!sameOrigin(req, config)) return res.status(403).type('text').send('This form only works from Bench itself.');
        const imp = await ctx.imports.get(String(req.params.id || ''));
        if (!imp || String(imp.owner) !== String(subject)) {
            return page(req, res, { index: false, title: 'No such upload', body: raw(String(require('../views').notFound())) }, 404);
        }
        try {
            const done = await ctx.imports.commit(imp.id, { subject });
            if (done.benchmark) return res.redirect(303, '/benchmarks/' + encodeURIComponent(done.benchmark.id));
            return page(req, res, { index: false, title: 'Import preview', body: raw(String(views.previewPage({ imp, error: 'Nothing could be imported from that file.' }))) }, 422);
        } catch (err) {
            const detail = err instanceof ImportError ? err.detail : 'The import did not go through.';
            return page(req, res, { index: false, title: 'Import preview', body: raw(String(views.previewPage({ imp, error: detail }))) }, 422);
        }
    });

    /** The uploaded file: the owner's own, and anyone else's once the benchmark it became is shared. */
    r.get('/imports/:id/file', async (req, res) => {
        const subject = subjectOf(req);
        const shareToken = req.query.share ? String(req.query.share) : null;
        const found = await ctx.imports.file(String(req.params.id || ''), { subject, shareToken });
        if (!found) {
            return page(req, res, { index: false, title: 'No such file', body: raw(String(require('../views').notFound())) }, 404);
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment; filename="' + String(found.filename).replace(/[^A-Za-z0-9._-]+/g, '_') + '"');
        res.setHeader('Cache-Control', 'private, max-age=0, no-store');
        return res.send(found.content);
    });

    return r;
}

module.exports = { createImportRoutes };

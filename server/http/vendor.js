'use strict';

/**
 * The libraries the render origin vendors (server/bench/render.js VENDOR): three 0.170.0, pinned in package.json, served
 * from node_modules so a model output never fetches code from a CDN. A model document runs in an opaque origin (its
 * frame has no allow-same-origin), so a module script it loads is a cross-origin CORS request: these answer with
 * Access-Control-Allow-Origin * and Cross-Origin-Resource-Policy cross-origin (helmet's same-site would refuse them).
 *
 *   GET /vendor/three.module.js         three's module build
 *   GET /vendor/three/addons/<path>.js  examples/jsm (loaders, controls, …), the import map's "three/addons/"
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

// three's exports map hides package.json; its main entry (build/three.cjs) is one level under the package root.
const ROOT = path.resolve(path.dirname(require.resolve('three')), '..');
const BUILD = path.join(ROOT, 'build');
const ADDONS = path.join(ROOT, 'examples', 'jsm');

function createVendorRoutes() {
    const r = express.Router();
    const send = (res, file) => {
        res.removeHeader('Set-Cookie');
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.set('X-Content-Type-Options', 'nosniff');
        res.type('text/javascript');
        return res.sendFile(file);
    };
    r.get('/three.module.js', (_req, res) => send(res, path.join(BUILD, 'three.module.js')));
    r.get(/^\/three\/addons\/([\w./-]+\.js)$/, (req, res) => {
        const rel = req.params[0];
        const file = path.resolve(ADDONS, rel);
        if (!file.startsWith(ADDONS + path.sep) || rel.includes('..') || !fs.existsSync(file)) return res.status(404).type('text/plain').send('Not vendored.');
        return send(res, file);
    });
    return r;
}

module.exports = { createVendorRoutes };

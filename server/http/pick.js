'use strict';

/**
 * The pick routes (spec 3): the page at /pick and the same answer as JSON at /api/v1/pick.
 * Both read the same three controls — kind, top price per solved task and fast — and the free text that sets them.
 */

const express = require('express');
const { asyncRouter } = require('./router');
const { send } = require('../render/layout');
const { raw } = require('../render/html');
const pickLib = require('../pick/pick');
const { pickPage } = require('../views/pick');

const str = (v) => (typeof v === 'string' ? v : '');

function readControls(query) {
    const maxCost = str(query.max_cost);
    return {
        kind: str(query.kind).slice(0, 80),
        maxCost: maxCost === '' ? null : Number(maxCost),
        fast: str(query.fast) === '1' || str(query.fast) === 'true',
        q: str(query.q).slice(0, 200),
    };
}

const viewerOf = (req) => (req.principal && req.principal.kind === 'user'
    ? { kind: 'user', subject: req.principal.subject, displayName: req.principal.displayName || req.principal.username }
    : { kind: 'anonymous' });

function createPickPages(ctx) {
    const r = express.Router();
    r.use(ctx.principal.middleware);
    r.get('/', async (req, res) => {
        const controls = readControls(req.query);
        const answer = await pickLib.answer(ctx, controls);
        const body = pickPage(answer);
        return send(res, 200, {
            config: ctx.config,
            viewer: viewerOf(req),
            path: req.originalUrl,
            title: 'Pick for me: the frontier of a kind',
            description: 'Plain controls, then the models no other model beats on both score and cost per solved task.',
            body: raw(body),
        });
    });
    return r;
}

function createPickRoutes(ctx) {
    const r = asyncRouter();
    r.get('/pick', async (req, res) => {
        const controls = readControls(req.query);
        const answer = await pickLib.answer(ctx, controls);
        res.set('Cache-Control', 'public, max-age=30');
        return res.json(answer);
    });
    return r;
}

module.exports = { createPickPages, createPickRoutes, readControls };

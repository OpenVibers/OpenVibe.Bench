'use strict';
/**
 * An in-process stand-in for OpenVibe.AI: GET /api/v1/routes?operation=generate lists offers, POST /api/v1/generate
 * answers with a fake run. It verifies the client-credentials token Bench got from the Network stub (audience
 * openvibe.ai, capability ai.run.create, namespace ai.generate) and records every request.
 */
const http = require('http');
const crypto = require('crypto');

const DEFAULT_MODELS = [
    { provider: 'acme', model: 'alpha-1' },
    { provider: 'beta', model: 'beta-2' },
    { provider: 'gamma', model: 'gamma-3' },
];

function payload(token) {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
}

function listen(handler) {
    return new Promise((resolve) => {
        const sockets = new Set();
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks);
                const json = (status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
                Promise.resolve(handler(req, raw, json, res)).catch((err) => json(500, { code: 'stub.error', detail: String(err && err.message) }));
            });
        });
        server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
        server.listen(0, '127.0.0.1', () => resolve({
            server, url: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
        }));
    });
}

async function startAi({ models = DEFAULT_MODELS, costUsd = 0.0012, ms = 321, tokensIn = 120, tokensOut = 480, textFor = null } = {}) {
    const st = { models: models.map((m) => ({ ...m })), requests: [], runCount: 0, runs: new Map(), costUsd, ms, tokensIn, tokensOut, textFor };

    function modelFor(body) {
        const asked = body && body.route;
        if (asked && typeof asked === 'object') {
            const hit = st.models.find((x) => x.provider === asked.provider && (asked.model == null || x.model === asked.model));
            if (hit) return hit;
            return false;
        }
        return st.models[st.runCount % st.models.length] || { provider: 'stub', model: 'stub-1' };
    }

    const srv = await listen(async (req, raw, json) => {
        const url = new URL(req.url, 'http://x');
        const text = raw.toString('utf8');
        let body = {};
        try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
        const auth = String(req.headers.authorization || '');
        const claims = auth.startsWith('Bearer ') ? payload(auth.slice(7)) : null;
        if (!claims || !(claims.aud || []).includes('openvibe.ai') || !(claims.cap || []).includes('ai.run.create')) {
            return json(401, { code: 'token.invalid', detail: 'a Bench client-credentials token with ai.run.create is required' });
        }
        if (!(claims.ns || []).some((n) => n === 'ai.generate' || n === 'ai.*')) {
            return json(403, { code: 'namespace.denied', detail: 'the token needs the ai.generate namespace' });
        }

        if (url.pathname === '/api/v1/routes' && req.method === 'GET') {
            st.requests.push({ method: 'GET', path: url.pathname, body });
            const [first, ...rest] = st.models;
            return json(200, { routes: [{ key: 'default.chat', version: 3, status: 'active', capability: 'chat', primary: { provider: first.provider, model: first.model }, fallbacks: rest.map((m) => ({ provider: m.provider, model: m.model })), pinned: [], constraints: {}, offers: st.models.map((m) => ({ provider: m.provider, model: m.model })) }] });
        }

        if (url.pathname === '/api/v1/generate' && req.method === 'POST') {
            st.requests.push({ method: 'POST', path: url.pathname, body, claims });
            const pick = modelFor(body);
            if (pick === false) return json(422, { code: 'input.invalid', detail: `route ${body.route.provider}/${body.route.model} is not offered` });
            const id = `run_${crypto.randomBytes(8).toString('hex')}`;
            const make = st.textFor || textFor;
            const text = make ? make(body, pick, st) : `<!doctype html><html><body><h1>Generated output</h1><p>${String(body.prompt || '').split('\n')[0].slice(0, 200)}</p></body></html>`;
            const run = {
                id, status: 'succeeded', workflow: { key: 'ai.generate', version: 1 },
                provenance: { provider: pick.provider, model: pick.model, run_id: id },
                output: { text },
                usage: { tokens_in: st.tokensIn, tokens_out: st.tokensOut, cost_usd: st.costUsd, attempts: 1 },
                started_at: new Date(Date.now() - st.ms).toISOString(), finished_at: new Date().toISOString(), created_at: new Date().toISOString(),
            };
            st.runs.set(id, run);
            st.runCount++;
            return json(201, { run });
        }

        const one = /^\/api\/v1\/runs\/([^/]+)$/.exec(url.pathname);
        if (one && req.method === 'GET') {
            const run = st.runs.get(decodeURIComponent(one[1]));
            if (!run) return json(404, { code: 'run.not_found' });
            return json(200, { run });
        }

        return json(404, { code: 'not_found', detail: 'not found' });
    });

    return { url: srv.url, state: st, models: st.models, requests: st.requests, close: srv.close };
}

module.exports = { startAi, DEFAULT_MODELS };

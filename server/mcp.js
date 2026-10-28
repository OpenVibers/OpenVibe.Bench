'use strict';

/**
 * Bench as a Model Context Protocol server (Streamable HTTP), POST /mcp — modelled on OpenVibe.Search's endpoint.
 * Stateless JSON-RPC 2.0: initialize, ping, tools/list and tools/call, single requests or batches, CORS preflight,
 * and a JSON-RPC parse error for malformed bodies.
 *
 * The six tools are the §4.12 list. A person is a Network user token as a Bearer (or the bench_at session cookie).
 */

const express = require('express');
const pkg = require('../package.json');

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = Object.freeze(new Set(['2025-06-18', '2025-03-26']));
const BODY_LIMIT = '64kb';

const INSTRUCTIONS = 'Bench runs one shared benchmark engine across every OpenVibe room. list_kinds shows the fifteen kinds; start_round queues a pinned round and returns its id; next_pair fetches a blind pair to judge; cast_judgement records a vote and reveals the two entries; get_board renders an elo, pareto or cost board; run_eval runs a private task suite.';

function toolsInput() {
    return {
        list_kinds: { type: 'object', properties: {} },
        start_round: {
            type: 'object',
            required: ['kind', 'prompt'],
            properties: {
                kind: { type: 'string', description: 'A kind id, e.g. design.page.' },
                prompt: { type: 'string', description: 'The task prompt.' },
                offers: { type: 'array', items: { type: 'object' }, description: 'Optional pinned {provider, model} slots.' },
                seed: { type: 'integer' },
            },
        },
        next_pair: {
            type: 'object',
            required: ['kind'],
            properties: { kind: { type: 'string' }, judge: { type: 'string' } },
        },
        cast_judgement: {
            type: 'object',
            required: ['round', 'left', 'right', 'outcome'],
            properties: {
                round: { type: 'string' },
                left: { type: 'string' },
                right: { type: 'string' },
                outcome: { type: 'string', enum: ['left', 'right', 'tie', 'both_bad'] },
            },
        },
        get_board: {
            type: 'object',
            required: ['kind'],
            properties: {
                kind: { type: 'string' },
                type: { type: 'string', enum: ['elo', 'pareto', 'cost'], default: 'elo' },
                category: { type: 'string' },
                period: { type: 'string' },
            },
        },
        run_eval: {
            type: 'object',
            required: ['kind', 'test_suite'],
            properties: {
                kind: { type: 'string' },
                test_suite: { type: 'array', items: { type: 'object' } },
                offers: { type: 'array', items: { type: 'object' } },
            },
        },
    };
}

const TOOL_META = Object.freeze([
    { name: 'bench.list_kinds', title: 'List Bench kinds', description: 'List the fifteen benchmark kinds Bench runs for every room.' },
    { name: 'bench.start_round', title: 'Start a Bench round', description: 'Create a task and queue a pinned round for it.' },
    { name: 'bench.next_pair', title: 'Next blind pair', description: 'Fetch the next ready round this person has not judged, with the two entries shuffled and identities hidden.' },
    { name: 'bench.cast_judgement', title: 'Cast a judgement', description: 'Record a blind pairwise vote and reveal the two entries.' },
    { name: 'bench.get_board', title: 'Get a board', description: 'Render an elo, pareto or cost board for one kind.' },
    { name: 'bench.run_eval', title: 'Run a private eval', description: 'Create and run a private task suite against chosen offers.' },
]);

const TOOLS = Object.freeze(TOOL_META.map((t) => ({ ...t, inputSchema: toolsInput()[t.name.slice(6)] })));

function result(id, value) { return { jsonrpc: '2.0', id, result: value }; }
function error(id, code, message) { return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } }; }
function validId(id) { return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)); }

function subjectOf(req) {
    return req.principal && req.principal.kind === 'user' && req.principal.subject ? req.principal.subject : null;
}

function requirePersonTool(id, req) {
    if (subjectOf(req)) return null;
    return { response: result(id, { content: [{ type: 'text', text: 'This tool needs a person: sign in, or send a Network user token as a Bearer.' }], isError: true }) };
}

function rowText(obj) {
    return Object.entries(obj || {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
}

async function callTool(id, params, req, ctx) {
    const { bench } = ctx;
    const name = params.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { response: error(id, -32602, 'Unknown tool') };
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};

    switch (name) {
        case 'bench.list_kinds': {
            const kinds = await bench.listKinds();
            return { response: result(id, { content: [{ type: 'text', text: kinds.map((k) => `${k.id}: ${k.name} (${k.room}, ${k.judge})`).join('\n') }], structuredContent: { kinds }, isError: false }) };
        }
        case 'bench.start_round': {
            const denied = requirePersonTool(id, req);
            if (denied) return denied;
            const owner = subjectOf(req);
            const task = await bench.createTask({ kindId: args.kind, prompt: args.prompt, public: true, subject: owner });
            if (!task.ok) return { response: result(id, { content: [{ type: 'text', text: task.message }], isError: true }) };
            const out = await bench.createRound({ taskId: task.task.id, offers: args.offers, seed: args.seed, subject: owner });
            if (!out.ok) return { response: result(id, { content: [{ type: 'text', text: out.message }], isError: true }) };
            return { response: result(id, { content: [{ type: 'text', text: rowText(out.round) }], structuredContent: out.round, isError: false }) };
        }
        case 'bench.next_pair': {
            const denied = requirePersonTool(id, req);
            if (denied) return denied;
            const pair = await bench.nextJudgement({ kind: args.kind, subject: subjectOf(req) });
            if (!pair) return { response: result(id, { content: [{ type: 'text', text: 'No round waiting for your judgement.' }], isError: false }) };
            return { response: result(id, { content: [{ type: 'text', text: `Round ${pair.round.id}: choose left or right.` }], structuredContent: pair, isError: false }) };
        }
        case 'bench.cast_judgement': {
            const denied = requirePersonTool(id, req);
            if (denied) return denied;
            const out = await bench.castJudgement({
                roundId: args.round, kindId: args.kind, judge: 'human_pairwise',
                pair: { left: args.left, right: args.right }, outcome: args.outcome, subject: subjectOf(req),
            });
            return { response: result(id, { content: [{ type: 'text', text: rowText(out.judgement) }], structuredContent: out, isError: false }) };
        }
        case 'bench.get_board': {
            const board = await bench.board(args.kind, { type: args.type || 'elo', category: args.category || 'all', period: args.period || 'all' });
            if (!board) return { response: result(id, { content: [{ type: 'text', text: 'No such kind.' }], isError: true }) };
            const lines = board.rows.map((r) => rowText(r));
            return { response: result(id, { content: [{ type: 'text', text: lines.join('\n') || 'No rows yet.' }], structuredContent: { board }, isError: false }) };
        }
        case 'bench.run_eval': {
            const denied = requirePersonTool(id, req);
            if (denied) return denied;
            const owner = subjectOf(req);
            const ev = await bench.createEval({ owner, kindId: args.kind, name: `MCP eval ${args.kind}`, testSuite: args.test_suite });
            if (!ev.ok) return { response: result(id, { content: [{ type: 'text', text: ev.message }], isError: true }) };
            const run = await bench.runEval({ evalId: ev.eval.id, offers: args.offers, owner });
            return { response: result(id, { content: [{ type: 'text', text: `Eval ${ev.eval.id}, run ${run.id} (${run.status}).` }], structuredContent: { eval: ev.eval, run }, isError: false }) };
        }
        default:
            return { response: error(id, -32602, 'Unknown tool') };
    }
}

async function handleMessage(msg, req, ctx) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { response: error(null, -32600, 'Invalid Request') };
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { response: error(null, -32600, 'Invalid Request') };
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
    if (hasId && !validId(msg.id)) return { response: error(null, -32600, 'Invalid Request') };
    if (!hasId || msg.method.startsWith('notifications/')) return { notification: true };
    const id = msg.id;
    const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {};
    switch (msg.method) {
        case 'initialize': {
            const requested = params.protocolVersion;
            const protocolVersion = SUPPORTED_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION;
            return { response: result(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'openvibe-bench', title: 'OpenVibe Bench', version: pkg.version }, instructions: INSTRUCTIONS }) };
        }
        case 'ping':
            return { response: result(id, {}) };
        case 'tools/list':
            return { response: result(id, { tools: TOOLS }) };
        case 'tools/call':
            return await callTool(id, params, req, ctx);
        default:
            return { response: error(id, -32601, 'Method not found') };
    }
}

function mcpRouter(ctx) {
    const router = express.Router();
    const json = express.json({ limit: BODY_LIMIT, type: ['application/json', 'application/*+json'], strict: false });

    router.use('/mcp', (_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
    router.options('/mcp', (_req, res) => {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Protocol-Version');
        res.setHeader('Access-Control-Max-Age', '600');
        res.status(204).end();
    });

    router.post('/mcp', json, ctx.principal.middleware, async (req, res) => {
        const version = req.get('mcp-protocol-version');
        if (version && !SUPPORTED_VERSIONS.has(version)) {
            const body = req.body;
            const id = body && !Array.isArray(body) && validId(body.id) ? body.id : null;
            return res.status(400).json(error(id, -32600, 'Unsupported protocol version'));
        }
        const offered = req.body;
        if (!offered || typeof offered !== 'object') return res.status(200).json(error(null, -32600, 'Invalid Request'));
        const batch = Array.isArray(offered);
        if (batch && offered.length === 0) return res.status(200).json(error(null, -32600, 'Invalid Request'));
        const messages = batch ? offered : [offered];
        const responses = [];
        for (const message of messages) {
            const out = await handleMessage(message, req, ctx);
            if (out.response) responses.push(out.response);
        }
        if (!responses.length) return res.status(202).end();
        return res.status(200).json(batch ? responses : responses[0]);
    });

    router.all('/mcp', (_req, res) => {
        res.setHeader('Allow', 'POST');
        res.status(405).json(error(null, -32600, 'Method Not Allowed'));
    });

    // eslint-disable-next-line no-unused-vars
    router.use((err, req, res, next) => {
        if (err && err.type === 'entity.parse.failed') return res.status(400).json(error(null, -32700, 'Parse error'));
        if (err && err.type === 'entity.too.large') return res.status(413).json(error(null, -32600, 'Request body too large'));
        return next(err);
    });

    return router;
}

module.exports = { mcpRouter, TOOLS, INSTRUCTIONS, PROTOCOL_VERSION, SUPPORTED_VERSIONS };

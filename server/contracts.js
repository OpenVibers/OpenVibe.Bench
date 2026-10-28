'use strict';

/**
 * Bench's Contracts surface, kept as JSON in the service until the published openvibe-contracts package carries
 * the bench.* schemas and capabilities. These are the exact shapes the API, the SDK and the outbox publish, so a
 * later move into openvibe-contracts is a copy, not a redesign.
 */

const BENCH_CAPABILITIES = Object.freeze([
    'bench.kind.read',
    'bench.task.create',
    'bench.round.create',
    'bench.round.read',
    'bench.entry.create',
    'bench.judgement.cast',
    'bench.board.read',
    'bench.dataset.read',
    'bench.eval.manage',
]);

const BENCH_EVENTS = Object.freeze([
    'bench.round.finished',
    'bench.judgement.recorded',
    'bench.rating.changed',
]);

const BENCH_SCHEMAS = Object.freeze({
    'bench.kind@1': {
        type: 'object',
        required: ['id', 'room', 'entry', 'judge', 'name', 'schema', 'metrics', 'created_at'],
        properties: {
            id: { type: 'string' },
            room: { type: 'string' },
            entry: { type: 'string' },
            judge: { type: 'string' },
            name: { type: 'string' },
            schema: { type: 'object' },
            metrics: { type: 'array', items: { type: 'string' } },
            created_at: { type: 'string', format: 'date-time' },
        },
    },
    'bench.task@1': {
        type: 'object',
        required: ['id', 'kind_id', 'prompt', 'public', 'created_by', 'created_at'],
        properties: {
            id: { type: 'string' },
            kind_id: { type: 'string' },
            prompt: { type: 'string' },
            task_class: { type: ['string', 'null'] },
            public: { type: 'boolean' },
            created_by: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
        },
    },
    'bench.round@1': {
        type: 'object',
        required: ['id', 'task_id', 'kind_id', 'offers', 'status', 'seed', 'created_by', 'created_at'],
        properties: {
            id: { type: 'string' },
            task_id: { type: 'string' },
            kind_id: { type: 'string' },
            offers: { type: 'array', items: { type: 'object' } },
            status: { type: 'string', enum: ['queued', 'running', 'ready', 'finished', 'failed'] },
            seed: { type: 'integer' },
            pool_fallback: { type: 'boolean' },
            receipt: { type: ['string', 'null'] },
            created_by: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
        },
    },
    'bench.entry@1': {
        type: 'object',
        required: ['id', 'round_id', 'provider', 'model', 'route', 'payload', 'cost_usd', 'ms', 'tokens'],
        properties: {
            id: { type: 'string' },
            round_id: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            route: { type: 'object' },
            payload: { type: 'object' },
            cost_usd: { type: 'number' },
            ms: { type: 'number' },
            tokens: { type: 'number' },
            error: { type: ['string', 'null'] },
            ui_check: { type: ['object', 'null'] },
            run_id: { type: ['string', 'null'] },
        },
    },
    'bench.judgement@1': {
        type: 'object',
        required: ['id', 'round_id', 'kind_id', 'judge', 'method', 'pair', 'outcome', 'score', 'at'],
        properties: {
            id: { type: 'string' },
            round_id: { type: 'string' },
            kind_id: { type: 'string' },
            judge: { type: 'string' },
            judge_name: { type: ['string', 'null'] },
            judge_version: { type: ['string', 'null'] },
            method: { type: 'string' },
            pair: { type: ['object', 'null'] },
            outcome: { type: ['string', 'null'] },
            score: { type: ['number', 'null'] },
            at: { type: 'string', format: 'date-time' },
        },
    },
    'bench.rating@1': {
        type: 'object',
        required: ['kind_id', 'category', 'subject', 'elo', 'games', 'wins', 'losses', 'ties', 'win_rate', 'ci_lower', 'ci_upper'],
        properties: {
            kind_id: { type: 'string' },
            category: { type: 'string' },
            subject: { type: 'string' },
            elo: { type: 'number' },
            games: { type: 'number' },
            wins: { type: 'number' },
            losses: { type: 'number' },
            ties: { type: 'number' },
            win_rate: { type: 'number' },
            ci_lower: { type: 'number' },
            ci_upper: { type: 'number' },
            median_cost_usd: { type: ['number', 'null'] },
            median_ms: { type: ['number', 'null'] },
            provisional: { type: 'boolean' },
        },
    },
});

module.exports = { BENCH_CAPABILITIES, BENCH_EVENTS, BENCH_SCHEMAS };

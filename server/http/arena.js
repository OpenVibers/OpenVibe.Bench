'use strict';

/**
 * The Exchange arena's own API, for OpenVibe.Exchange and nobody else.
 *
 * The Arena is a blind pair in Exchange's chat: a person's prompt, two models' answers side by side, a vote,
 * then both names and their receipts. Each vote is a Bench human_pairwise judgement owned by that person, and
 * each round belongs to the service so the person can vote on it.
 *
 *   POST /api/v1/arena/rounds             (service:exchange, bench.round.create)
 *        { prompt, category?, entries: [{ provider, model, answer, cost_usd?, ms?, tokens?, run_id? }] }
 *        → 201 { round: { id, status }, category, entries: [{ id, side, provider, model }] }
 *
 *   POST /api/v1/arena/rounds/:id/votes   (service:exchange, bench.judgement.cast)
 *        x-ov-subject: the person's Network subject
 *        { outcome: left|right|tie|both_bad, pair: { left, right } }
 *        → 201 { judgement, revealed }
 *
 * A second vote by the same person is 409 (Bench's one-vote rule), and the service that built the round can
 * never cast the vote itself: the judgement belongs to the person named in x-ov-subject.
 */
const express = require('express');
const { http, ids } = require('openvibe-contracts');
const { asyncRouter } = require('./router');

const SERVICE = 'service:exchange';
const ARENA_KIND = 'chat.arena';
const OUTCOMES = new Set(['left', 'right', 'tie', 'both_bad']);

function createArenaRoutes(ctx) {
    const { bench, principal, log } = ctx;
    const r = asyncRouter();
    r.use(express.json({ limit: '128kb' }));
    r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    const problem = (res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: res.req && res.req.ov });

    const fromExchange = (req, res, next) => {
        if (req.principal && req.principal.kind === 'app' && req.principal.requester === SERVICE) return next();
        return problem(res, 403, 'bench.arena_service_only', 'The arena is built by OpenVibe.Exchange.');
    };
    const failed = (res, err) => {
        if (err && err.status) return problem(res, err.status, err.code || 'bench.invalid', err.detail || 'The arena request was not accepted.');
        log.warn('[OpenVibe.Bench] arena failed:', (err && err.message) || err);
        return problem(res, 500, 'internal.error', 'Bench could not answer. Try again in a moment.');
    };

    r.post('/rounds', principal.requireCapability('bench.round.create'), fromExchange, async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const prompt = String(b.prompt == null ? '' : b.prompt).replace(/\s+/g, ' ').trim();
        if (!prompt) return problem(res, 422, 'bench.prompt_required', 'A round needs the prompt the models answered.');
        try {
            const out = await bench.createArenaRound({
                prompt,
                category: b.category == null ? null : String(b.category),
                entries: Array.isArray(b.entries) ? b.entries : [],
            });
            res.set('Location', `/api/v1/arena/rounds/${out.round.id}`);
            return res.status(201).json({
                round: { id: out.round.id, status: out.round.status, kind_id: ARENA_KIND },
                category: b.category == null ? null : String(b.category).slice(0, 40),
                entries: out.entries,
            });
        } catch (err) { return failed(res, err); }
    });

    r.post('/rounds/:id/votes', principal.requireCapability('bench.judgement.cast'), fromExchange, async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const subject = String(req.headers['x-ov-subject'] || '');
        if (!ids.isSubjectId('user', subject)) {
            return problem(res, 422, 'bench.invalid_subject', 'x-ov-subject must be the Network subject of the person who voted.');
        }
        const outcome = String(b.outcome || '');
        if (!OUTCOMES.has(outcome)) return problem(res, 422, 'bench.invalid_outcome', 'The outcome must be left, right, tie or both_bad.');
        const pair = b.pair && typeof b.pair === 'object' ? { left: String(b.pair.left || ''), right: String(b.pair.right || '') } : null;
        if (!pair || !pair.left || !pair.right || pair.left === pair.right) {
            return problem(res, 422, 'bench.invalid_pair', 'A vote names the two entries it compares.');
        }
        try {
            const round = await bench.getRound(String(req.params.id || ''), { viewerSubject: null });
            if (!round || round.kind_id !== ARENA_KIND) return problem(res, 404, 'bench.round_not_found', 'No such arena round.');
            if (round.created_by !== SERVICE) return problem(res, 403, 'bench.arena_service_only', 'That round was not built by OpenVibe.Exchange.');
            const out = await bench.castJudgement({
                roundId: round.id, judge: 'human_pairwise', pair, outcome, subject,
            });
            return res.status(201).json({ judgement: out.judgement, revealed: out.revealed });
        } catch (err) { return failed(res, err); }
    });

    return r;
}

module.exports = { createArenaRoutes, SERVICE, ARENA_KIND };

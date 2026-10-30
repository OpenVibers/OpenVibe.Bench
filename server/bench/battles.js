'use strict';

/**
 * Battles (spec 2): two outputs, one prompt, blind.
 *
 * A battle is a pair of entries from a finished round. The rules the research asks for are enforced here, not in
 * the page:
 *
 *   - only a signed-in person votes (the page sends anonymous readers to sign in);
 *   - a person never sees the same pair twice (bench_battle_seen holds the pair the moment it is shown);
 *   - votes are limited per person and per network (the network is a hash of the address, never the address).
 *
 * The vote itself is a human_pairwise judgement, so the battle votes are the same votes the ratings are made of.
 * Two extras ride along: the kind's own question ("which is more fun" for games, "which looks more finished" for
 * design) and the network hash, which never leaves the database.
 */

const crypto = require('crypto');
const { SHOWCASE_KIND_IDS } = require('../kinds');

const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));

/** The question each kind asks about its own outputs. */
const QUESTIONS = Object.freeze({
    games: { id: 'more_fun', text: 'Which one is more fun?', options: ['A', 'B', 'tie'] },
    design: { id: 'more_finished', text: 'Which one looks more finished?', options: ['A', 'B', 'tie'] },
    other: { id: 'better', text: 'Which one is better?', options: ['A', 'B', 'tie'] },
});

/** The question a kind asks. */
function questionFor(kindId) {
    const id = String(kindId || '');
    if (id.startsWith('games.')) return QUESTIONS.games;
    if (id.startsWith('design.')) return QUESTIONS.design;
    return QUESTIONS.other;
}

/** The pair key: the two entry ids, sorted, so A and B in any order is the same pair. */
function pairKey(a, b) {
    return [String(a || ''), String(b || '')].sort().join('|');
}

function createBattles(ctx) {
    const { s, config, bench } = ctx;
    const db = s.db;

    /** The network fingerprint: a hash of the address, so the limit works without storing an address. */
    function netHashOf(req) {
        const ip = String((req && req.ip) || (req && req.socket && req.socket.remoteAddress) || '').trim();
        if (!ip) return null;
        return crypto.createHash('sha256').update('bench-battle|' + ip).digest('hex').slice(0, 40);
    }

    const limits = () => (config && config.bench) || {};

    /** How many votes this person and this network may still cast. */
    async function budget({ subject, netHash }) {
        const cfg = limits();
        const hourAgo = new Date(Date.now() - 3600_000).toISOString();
        const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
        const personHour = num(await db.value(
            "SELECT COUNT(*)::int AS n FROM bench_judgements WHERE subject = $1 AND judge = 'human_pairwise' AND at >= $2::timestamptz",
            [subject, hourAgo]));
        const personDay = num(await db.value(
            "SELECT COUNT(*)::int AS n FROM bench_judgements WHERE subject = $1 AND judge = 'human_pairwise' AND at >= $2::timestamptz",
            [subject, dayAgo]));
        const netHour = netHash ? num(await db.value(
            "SELECT COUNT(*)::int AS n FROM bench_judgements WHERE net_hash = $1 AND judge = 'human_pairwise' AND at >= $2::timestamptz",
            [netHash, hourAgo])) : 0;
        const netDay = netHash ? num(await db.value(
            "SELECT COUNT(*)::int AS n FROM bench_judgements WHERE net_hash = $1 AND judge = 'human_pairwise' AND at >= $2::timestamptz",
            [netHash, dayAgo])) : 0;
        const perPersonHour = Math.max(1, num(cfg.battlePersonPerHour, 30));
        const perPersonDay = Math.max(1, num(cfg.battlePersonPerDay, 200));
        const perNetworkHour = Math.max(1, num(cfg.battleNetworkPerHour, 120));
        const perNetworkDay = Math.max(1, num(cfg.battleNetworkPerDay, 1000));
        const reasons = [];
        if (personHour >= perPersonHour) reasons.push('You have voted a lot in the last hour. Try again in a little while.');
        if (personDay >= perPersonDay) reasons.push('You have used your votes for today.');
        if (netHour >= perNetworkHour) reasons.push('This network has voted a lot in the last hour. Try again later.');
        if (netDay >= perNetworkDay) reasons.push('This network has used its votes for today.');
        return {
            allowed: reasons.length === 0,
            message: reasons.join(' '),
            person_hour: personHour, person_day: personDay, network_hour: netHour, network_day: netDay,
            limits: { person_hour: perPersonHour, person_day: perPersonDay, network_hour: perNetworkHour, network_day: perNetworkDay },
        };
    }

    /**
     * A pair this person has not seen: a finished round, not their own, with two usable entries, and not a pair
     * they have been shown before. The pair is recorded as seen the moment it is shown, so nobody meets it twice.
     */
    async function pickPair({ subject, kind = 'all', random = Math.random, netHash = null }) {
        const kinds = kind && kind !== 'all' ? [String(kind)] : SHOWCASE_KIND_IDS;
        const rows = await db.many(
            `SELECT r.id, r.kind_id, t.prompt
             FROM bench_rounds r JOIN bench_tasks t ON t.id = r.task_id
             WHERE r.status = 'finished' AND r.kind_id = ANY($1::text[]) AND r.created_by <> $2
               AND (SELECT COUNT(*) FROM bench_entries e WHERE e.round_id = r.id AND e.error IS NULL) >= 2
               AND NOT EXISTS (SELECT 1 FROM bench_judgements j WHERE j.round_id = r.id AND j.subject = $2)
               AND NOT EXISTS (SELECT 1 FROM bench_battle_seen v WHERE v.subject = $2 AND v.round_id = r.id)
             ORDER BY r.created_at DESC, r.id LIMIT 60`,
            [kinds, subject]);
        if (!rows.length) return null;
        const row = rows[Math.floor(random() * rows.length) % rows.length];
        const entries = await db.many(
            `SELECT id, provider, model, route, cost_usd, ms, tokens, payload, style_length, style_markup
             FROM bench_entries WHERE round_id = $1 AND error IS NULL ORDER BY id`,
            [row.id]);
        if (entries.length < 2) return null;
        // Prefer two different models, so a battle is always between two models.
        let pair = [entries[0], entries[1]];
        const other = entries.find((e) => e.model !== entries[0].model);
        if (other) pair = [entries[0], other];
        const [a, b] = pair;
        const key = pairKey(a.id, b.id);
        const id = s.newId('bbs');
        await db.exec(
            `INSERT INTO bench_battle_seen (id, subject, pair_key, round_id, kind_id, a_entry, b_entry, net_hash, at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
            [id, subject, key, row.id, row.kind_id, a.id, b.id, netHash, s.iso()]);
        return {
            id, round_id: row.id, kind_id: row.kind_id, prompt: row.prompt,
            question: questionFor(row.kind_id),
            a: { id: a.id, provider: a.provider, model: a.model, cost_usd: num(a.cost_usd), ms: num(a.ms) },
            b: { id: b.id, provider: b.provider, model: b.model, cost_usd: num(b.cost_usd), ms: num(b.ms) },
        };
    }

    /** The battle as it was shown, for the reveal and the share card. */
    async function battleOf(id, subject = null) {
        const seen = await db.maybe('SELECT * FROM bench_battle_seen WHERE id = $1', [String(id || '')]);
        if (!seen) return null;
        if (subject && seen.subject !== subject) return null;
        const round = await db.maybe(
            'SELECT r.id, r.kind_id, r.created_at, t.prompt FROM bench_rounds r JOIN bench_tasks t ON t.id = r.task_id WHERE r.id = $1',
            [seen.round_id]);
        if (!round) return null;
        const entries = await db.many(
            'SELECT id, provider, model, route, cost_usd, ms, tokens, payload, style_length, style_markup FROM bench_entries WHERE id = ANY($1::text[])',
            [[seen.a_entry, seen.b_entry]]);
        const a = entries.find((e) => e.id === seen.a_entry);
        const b = entries.find((e) => e.id === seen.b_entry);
        if (!a || !b) return null;
        const vote = await db.maybe(
            "SELECT outcome, question, answer FROM bench_judgements WHERE round_id = $1 AND subject = $2 AND judge = 'human_pairwise' ORDER BY at LIMIT 1",
            [seen.round_id, seen.subject]);
        return {
            id: seen.id, round_id: seen.round_id, kind_id: seen.kind_id, prompt: round.prompt,
            question: questionFor(seen.kind_id),
            voted_at: seen.voted_at ? new Date(seen.voted_at).toISOString() : null,
            a: { id: a.id, provider: a.provider, model: a.model, route: a.route, cost_usd: num(a.cost_usd), ms: num(a.ms), tokens: num(a.tokens), payload: a.payload },
            b: { id: b.id, provider: b.provider, model: b.model, route: b.route, cost_usd: num(b.cost_usd), ms: num(b.ms), tokens: num(b.tokens), payload: b.payload },
            vote: vote ? { outcome: vote.outcome, question: vote.question, answer: vote.answer } : null,
        };
    }

    /** The vote. The rules are checked here; a caller that breaks them gets a refusal, not a quiet write. */
    async function recordVote({ subject, battleId, outcome, answer = null, netHash = null }) {
        const seen = await db.maybe('SELECT * FROM bench_battle_seen WHERE id = $1', [String(battleId || '')]);
        if (!seen) return { ok: false, status: 404, code: 'bench.battle_not_found', message: 'That battle is gone.' };
        if (seen.subject !== subject) return { ok: false, status: 403, code: 'bench.battle_not_yours', message: 'That battle belongs to someone else.' };
        if (seen.voted_at) return { ok: false, status: 409, code: 'bench.already_voted', message: 'You have already voted on this pair.' };
        const map = { A: 'left', B: 'right', tie: 'tie', both_bad: 'both_bad' };
        const won = map[String(outcome || '')];
        if (!won) return { ok: false, status: 422, code: 'bench.invalid_outcome', message: 'The outcome must be A, B, tie or both_bad.' };
        const room = await budget({ subject, netHash });
        if (!room.allowed) return { ok: false, status: 429, code: 'bench.limit_battle', message: room.message };
        const question = questionFor(seen.kind_id);
        const answerValue = answer == null || answer === '' ? null : String(answer).slice(0, 8);
        if (answerValue != null && !question.options.includes(answerValue)) {
            return { ok: false, status: 422, code: 'bench.invalid_answer', message: 'That answer does not fit the question.' };
        }
        try {
            await bench.castJudgement({
                roundId: seen.round_id,
                judge: 'human_pairwise',
                pair: { left: seen.a_entry, right: seen.b_entry },
                outcome: won,
                question: question.text,
                answer: answerValue,
                netHash,
                subject,
            });
        } catch (err) {
            if (err && err.status) return { ok: false, status: err.status, code: err.code || 'bench.invalid', message: err.detail || 'The vote was not accepted.' };
            throw err;
        }
        await db.exec('UPDATE bench_battle_seen SET voted_at = $2::timestamptz WHERE id = $1', [seen.id, s.iso()]);
        return { ok: true, battle_id: seen.id, outcome: won, question };
    }

    return { pickPair, battleOf, recordVote, budget, netHashOf, questionFor, pairKey };
}

module.exports = { createBattles, questionFor, pairKey, QUESTIONS };

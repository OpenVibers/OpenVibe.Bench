'use strict';

/**
 * Bench's data access: kinds, tasks, rounds, entries, judgements, ratings, boards, the open dataset and private
 * evals. A judgement and the rating changes (plus the outbox rows) commit in one transaction, so a crash can
 * never leave a vote without its Elo update. One vote per person per round; a creator cannot vote on their own
 * round; identities stay hidden until a caller has voted (or started the round).
 */
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const { KINDS, JUDGES, WINNERS, kindById } = require('./kinds');
const ratingLib = require('./rating');
const styleLib = require('./rating/style');

const BASE_ELO = ratingLib.BASE_ELO;
const K = 32;
const CATEGORY_DEFAULT = 'all';

const num = (v, d = 0) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));
const refusal = (status, code, message) => ({ ok: false, status, code, message });
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

class BenchError extends Error {
    constructor(status, code, detail) {
        super(detail);
        this.name = 'BenchError';
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}

function wireKind(row) {
    if (!row) return null;
    let schema = row.schema;
    let metrics = row.metrics;
    if (typeof schema === 'string') { try { schema = JSON.parse(schema); } catch { schema = {}; } }
    if (typeof metrics === 'string') { try { metrics = JSON.parse(metrics); } catch { metrics = []; } }
    return {
        id: row.id, room: row.room, entry: row.entry, judge: row.judge, name: row.name,
        renderer: schema.renderer || null, limit_ms: schema.limit_ms == null ? null : num(schema.limit_ms),
        judges: Array.isArray(schema.judges) ? schema.judges : null,
        schema, metrics: Array.isArray(metrics) ? metrics : [], created_at: iso(row.created_at),
    };
}

function wireTask(row) {
    if (!row) return null;
    return { id: row.id, kind_id: row.kind_id, prompt: row.prompt, task_class: row.task_class == null ? null : row.task_class, public: Boolean(row.public), created_by: row.created_by, created_at: iso(row.created_at) };
}

function wireRound(row) {
    if (!row) return null;
    let offers = row.offers;
    let params = row.params;
    if (typeof offers === 'string') { try { offers = JSON.parse(offers); } catch { offers = []; } }
    if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = {}; } }
    return {
        id: row.id, task_id: row.task_id, kind_id: row.kind_id,
        offers: Array.isArray(offers) ? offers : [],
        status: row.status, seed: num(row.seed), params,
        pool_fallback: Boolean(row.pool_fallback),
        receipt: row.receipt == null ? null : row.receipt,
        created_by: row.created_by, created_at: iso(row.created_at), finished_at: iso(row.finished_at),
    };
}

function wireEntry(row, { blind = false } = {}) {
    if (!row) return null;
    let payload = row.payload;
    let route = row.route;
    let uiCheck = row.ui_check;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = {}; } }
    if (typeof route === 'string') { try { route = JSON.parse(route); } catch { route = {}; } }
    if (typeof uiCheck === 'string') { try { uiCheck = JSON.parse(uiCheck); } catch { uiCheck = null; } }
    const base = {
        id: row.id,
        round_id: row.round_id,
        payload,
        error: row.error || null,
        ui_check: uiCheck == null ? null : uiCheck,
        run_id: row.run_id || null,
        created_at: iso(row.created_at),
    };
    if (blind) return base;
    return { ...base, provider: row.provider, model: row.model, route, cost_usd: num(row.cost_usd), ms: num(row.ms), tokens: num(row.tokens) };
}

function wireJudgement(row, { withSubject = false } = {}) {
    if (!row) return null;
    let pair = row.pair;
    if (typeof pair === 'string') { try { pair = JSON.parse(pair); } catch { pair = null; } }
    const out = {
        id: row.id, round_id: row.round_id, kind_id: row.kind_id,
        judge: row.judge, judge_name: row.judge_name || null, judge_version: row.judge_version || null,
        method: row.method, pair, outcome: row.outcome || null, score: row.score == null ? null : num(row.score),
        vote_counts: row.vote_counts == null ? null : (typeof row.vote_counts === 'string' ? JSON.parse(row.vote_counts) : row.vote_counts), at: iso(row.at),
    };
    if (withSubject) out.subject = row.subject || null;
    return out;
}

function wireRating(row) {
    if (!row) return null;
    return {
        kind_id: row.kind_id, category: row.category, subject: row.subject,
        elo: num(row.elo, BASE_ELO), games: num(row.games), wins: num(row.wins), losses: num(row.losses), ties: num(row.ties),
        win_rate: num(row.win_rate), ci_lower: row.ci_lower == null ? null : num(row.ci_lower),
        ci_upper: row.ci_upper == null ? null : num(row.ci_upper),
        median_cost_usd: row.median_cost_usd == null ? null : num(row.median_cost_usd),
        median_ms: row.median_ms == null ? null : num(row.median_ms),
    };
}

function wireEval(row) {
    if (!row) return null;
    let suite = row.test_suite;
    if (typeof suite === 'string') { try { suite = JSON.parse(suite); } catch { suite = []; } }
    return { id: row.id, owner: row.owner, kind_id: row.kind_id, name: row.name, test_suite: Array.isArray(suite) ? suite : [], created_at: iso(row.created_at) };
}

function wireEvalRun(row) {
    if (!row) return null;
    let offers = row.offers;
    let results = row.results;
    if (typeof offers === 'string') { try { offers = JSON.parse(offers); } catch { offers = []; } }
    if (typeof results === 'string') { try { results = JSON.parse(results); } catch { results = null; } }
    return { id: row.id, eval_id: row.eval_id, offers: Array.isArray(offers) ? offers : [], status: row.status, results, created_at: iso(row.created_at), finished_at: iso(row.finished_at) };
}

function shuffle(list, random = Math.random) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function eloDelta(p) {
    if (!(p > 0)) return -400;
    if (p >= 1) return 400;
    return 400 * Math.log10(p / (1 - p));
}

/** Wilson bounds on win rate, mapped to an Elo band around the live rating. */
function ratingCi(elo, wins, losses, ties) {
    const games = wins + losses + ties;
    if (!games) return { ci_lower: null, ci_upper: null };
    const p = (wins + ties * 0.5) / games;
    const w = ratingLib.wilson(wins + ties * 0.5, games);
    const delta = eloDelta(p);
    return {
        ci_lower: Math.round((elo + (eloDelta(w.lower) - delta)) * 100) / 100,
        ci_upper: Math.round((elo + (eloDelta(w.upper) - delta)) * 100) / 100,
    };
}

function createStore(s, { log = console, random = Math.random, config = null } = {}) {
    const db = s.db;

    // ── Outbox (in the same ambient transaction as the change that caused it) ──
    async function insertOutbox(topic, payload) {
        const eventId = ids.newId('event', s.now());
        await db.exec(
            `INSERT INTO bench_outbox (event_id, topic, payload, created_at, next_attempt_at)
             VALUES ($1, $2, $3::jsonb, $4::timestamptz, $4::timestamptz)`,
            [eventId, topic, JSON.stringify(payload), s.iso()],
        );
        return eventId;
    }

    // ── Kinds ───────────────────────────────────────────────
    async function seedKinds() {
        for (const k of KINDS) {
            await db.exec(
                `INSERT INTO bench_kinds (id, room, entry, judge, name, schema, metrics, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now())
                 ON CONFLICT (id) DO UPDATE SET room = EXCLUDED.room, entry = EXCLUDED.entry, judge = EXCLUDED.judge,
                   name = EXCLUDED.name, schema = EXCLUDED.schema, metrics = EXCLUDED.metrics`,
                [k.id, k.room, k.entry, k.judge, k.name, JSON.stringify(k.schema), JSON.stringify(k.metrics)],
            );
        }
    }
    async function listKinds() {
        return (await db.many('SELECT * FROM bench_kinds ORDER BY id')).map(wireKind);
    }
    async function getKind(id) {
        return wireKind(await db.maybe('SELECT * FROM bench_kinds WHERE id = $1', [String(id || '')]));
    }

    // ── Tasks ───────────────────────────────────────────────
    async function createTask({ kindId, prompt, taskClass = null, public: isPublic = false, subject }) {
        const kind = await getKind(kindId);
        if (!kind) return refusal(422, 'bench.kind_not_found', `No such kind: ${kindId}`);
        const text = String(prompt == null ? '' : prompt).replace(/\s+/g, ' ').trim();
        if (!text) return refusal(422, 'bench.prompt_required', 'A task needs a prompt or spec.');
        if (text.length > 4000) return refusal(422, 'bench.prompt_too_long', 'The prompt must be at most 4000 characters.');
        const id = s.newId('btk');
        const row = await db.maybe(
            `INSERT INTO bench_tasks (id, kind_id, prompt, task_class, public, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz) RETURNING *`,
            [id, kind.id, text, taskClass, Boolean(isPublic), subject, s.iso()],
        );
        return { ok: true, task: wireTask(row) };
    }
    async function getTask(id) {
        return wireTask(await db.maybe('SELECT * FROM bench_tasks WHERE id = $1', [String(id || '')]));
    }

    // ── Rounds ──────────────────────────────────────────────
    const dayStart = (at = s.now()) => {
        const d = new Date(at);
        d.setUTCHours(0, 0, 0, 0);
        return d.toISOString();
    };

    async function roundCounts(subject) {
        const start = dayStart();
        const perDay = config ? config.bench.roundsPerDay : 3;
        const daily = config ? config.bench.roundsDaily : 20;
        const used = num(await db.value('SELECT COUNT(*)::int AS n FROM bench_rounds WHERE created_by = $1 AND created_at >= $2::timestamptz', [subject, start]));
        const siteUsed = num(await db.value('SELECT COUNT(*)::int AS n FROM bench_rounds WHERE created_at >= $1::timestamptz', [start]));
        return {
            used,
            remaining: Math.max(0, perDay - used),
            per_day: perDay,
            site_used: siteUsed,
            site_daily: daily,
            site_remaining: Math.max(0, daily - siteUsed),
        };
    }

    async function createRound({ taskId, offers = null, seed = 0, subject }) {
        const task = await getTask(taskId);
        if (!task) return refusal(404, 'bench.task_not_found', 'No such task.');
        const kind = await getKind(task.kind_id);
        if (!kind) return refusal(422, 'bench.kind_not_found', 'The task\'s kind is gone.');
        const off = Array.isArray(offers) ? offers.slice(0, 3).map((o) => ({ provider: String(o.provider || ''), model: o.model == null ? null : String(o.model) })) : [];
        if (off.some((o) => !o.provider)) return refusal(422, 'bench.invalid_offers', 'Every offer needs a provider.');
        const perDay = config ? config.bench.roundsPerDay : 3;
        const daily = config ? config.bench.roundsDaily : 20;
        const start = dayStart();
        const id = s.newId('brd');
        const row = await db.maybe(
            `INSERT INTO bench_rounds (id, task_id, kind_id, offers, status, seed, params, pool_fallback, created_by, created_at)
             SELECT $1, $2, $3, $4::jsonb, 'queued', $5, '{}'::jsonb, $6, $7, $8::timestamptz
             WHERE (SELECT COUNT(*) FROM bench_rounds WHERE created_by = $7 AND created_at >= $9::timestamptz) < $10
               AND (SELECT COUNT(*) FROM bench_rounds WHERE created_at >= $9::timestamptz) < $11
             RETURNING *`,
            [id, task.id, kind.id, JSON.stringify(off), Math.max(0, Number(seed) || 0), off.length < 3, subject, s.iso(), start, perDay, daily],
        );
        if (!row) {
            const c = await roundCounts(subject);
            if (c.used >= perDay) throw new BenchError(429, 'bench.limit_person', `You can start ${perDay} round${perDay === 1 ? '' : 's'} a day.`);
            throw new BenchError(429, 'bench.limit_site', `Bench has reached its ${daily} round${daily === 1 ? '' : 's'} for today.`);
        }
        return { ok: true, round: await getRound(id) };
    }

    async function getRound(id, { viewerSubject = null } = {}) {
        const r = await db.maybe('SELECT * FROM bench_rounds WHERE id = $1', [String(id || '')]);
        if (!r) return null;
        const entryRows = await db.many('SELECT * FROM bench_entries WHERE round_id = $1 ORDER BY created_at, id', [r.id]);
        const revealed = viewerSubject != null && (r.created_by === viewerSubject
            || await db.value('SELECT COUNT(*)::int AS n FROM bench_judgements WHERE round_id = $1 AND subject = $2', [r.id, viewerSubject]) > 0);
        const votes = num(await db.value("SELECT COUNT(*)::int AS n FROM bench_judgements WHERE round_id = $1 AND method <> 'game_outcome'", [r.id]));
        const entries = entryRows.map((e) => wireEntry(e, { blind: !revealed }));
        const out = { ...wireRound(r), entries, votes };
        if (!revealed) out.blind = true;
        return out;
    }

    /** Insert an entry into a round; moves a room-submitted round to ready when it has two usable entries. */
    async function addEntry({ roundId, provider, model, route, payload, costUsd = 0, ms = 0, tokens = 0, error = null, uiCheck = null, runId = null }) {
        return await s.tx(async () => {
            const r = await db.maybe('SELECT * FROM bench_rounds WHERE id = $1 FOR UPDATE', [String(roundId || '')]);
            if (!r) throw new BenchError(404, 'bench.round_not_found', 'No such Bench round.');
            const id = s.newId('bte');
            // The style of the output (how long it is, how much markup it wears) is measured once, here, so the
            // ratings can control for style later without opening the payload again.
            const style = styleLib.styleFeatures(payload || {});
            const row = await db.maybe(
                `INSERT INTO bench_entries (id, round_id, provider, model, route, payload, cost_usd, ms, tokens, error, ui_check, run_id, created_at, style_length, style_markup)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11::jsonb, $12, $13::timestamptz, $14, $15) RETURNING *`,
                [id, r.id, String(provider || 'ai').slice(0, 80), String(model || 'unknown').slice(0, 120), JSON.stringify(route || {}),
                    JSON.stringify(payload || {}), num(costUsd), Math.max(0, num(ms)), Math.max(0, num(tokens)), error || null,
                    uiCheck == null ? null : JSON.stringify(uiCheck), runId || null, s.iso(), style.length, style.markup],
            );
            await maybeReady(r.id);
            return wireEntry(row);
        });
    }

    async function maybeReady(roundId) {
        const usable = num(await db.value('SELECT COUNT(*)::int AS n FROM bench_entries WHERE round_id = $1 AND error IS NULL', [roundId]));
        if (usable >= 2) {
            const r = await db.maybe('SELECT * FROM bench_rounds WHERE id = $1 FOR UPDATE', [roundId]);
            if (r && (r.status === 'queued' || r.status === 'running')) {
                await finishRound(r.id);
            }
        }
    }

    async function finishRound(roundId) {
        const r = await db.maybe('SELECT * FROM bench_rounds WHERE id = $1', [roundId]);
        if (!r) return;
        const receipt = sha256(JSON.stringify({ id: r.id, task_id: r.task_id, kind_id: r.kind_id, offers: r.offers, seed: r.seed, params: r.params }));
        await db.exec("UPDATE bench_rounds SET status = 'finished', receipt = $1, finished_at = $2::timestamptz WHERE id = $3",
            [receipt, s.iso(), r.id]);
        await insertOutbox('bench.round.finished', {
            round_id: r.id, kind_id: r.kind_id, task_id: r.task_id, receipt, created_by: r.created_by,
        });
    }

    // ── Judgements ──────────────────────────────────────────
    async function pairwiseGames(kindId, category = CATEGORY_DEFAULT) {
        const rows = await db.many(
            `SELECT * FROM bench_judgements
             WHERE kind_id = $1 AND method IN ('human_pairwise', 'game_outcome', 'audience_poll') AND pair IS NOT NULL
               AND ($2::text = 'all' OR outcome IS NOT NULL)
             ORDER BY at, id`,
            [kindId, category],
        );
        const out = [];
        for (const j of rows) {
            const pair = typeof j.pair === 'string' ? JSON.parse(j.pair) : j.pair;
            if (!pair || !pair.left || !pair.right) continue;
            if (j.outcome === 'both_bad') continue;
            if (j.method === 'audience_poll') {
                const counts = typeof j.vote_counts === 'string' ? JSON.parse(j.vote_counts) : j.vote_counts;
                if (!counts || !num(counts.voters)) continue;
            }
            out.push({ a: pair.left, b: pair.right, outcome: j.outcome === 'left' ? 1 : j.outcome === 'right' ? 0 : 0.5 });
        }
        return out;
    }

    /** A ready round this person has not judged and did not start, with two entries shuffled and identities hidden. */
    async function nextJudgement({ kind, subject, random: rng = random } = {}) {
        const row = await db.maybe(
            `SELECT r.* FROM bench_rounds r
             WHERE r.kind_id = $1 AND r.status = 'finished' AND r.created_by <> $2
               AND (SELECT COUNT(*) FROM bench_entries e WHERE e.round_id = r.id AND e.error IS NULL) >= 2
               AND NOT EXISTS (SELECT 1 FROM bench_judgements j WHERE j.round_id = r.id AND j.subject = $2)
             ORDER BY r.created_at, r.id LIMIT 1`,
            [String(kind || ''), subject],
        );
        if (!row) return null;
        const entries = (await db.many('SELECT * FROM bench_entries WHERE round_id = $1 AND error IS NULL ORDER BY id', [row.id])).map(wireEntry);
        if (entries.length < 2) return null;
        const [left, right] = shuffle(entries, rng).slice(0, 2);
        return {
            round: { id: row.id, kind_id: row.kind_id, prompt: (await getTask(row.task_id)).prompt },
            left: { id: left.id, payload: left.payload },
            right: { id: right.id, payload: right.payload },
        };
    }

    async function castJudgement({ roundId, kindId, judge, judgeName = null, judgeVersion = null, pair = null, outcome = null, score = null, voteCounts = null, question = null, answer = null, netHash = null, subject }) {
        if (!JUDGES.includes(judge)) throw new BenchError(422, 'bench.invalid_judge', 'Unknown judge.');
        try {
            return await s.tx(async () => {
                const r = await db.maybe('SELECT * FROM bench_rounds WHERE id = $1 FOR UPDATE', [String(roundId || '')]);
                if (!r) throw new BenchError(404, 'bench.round_not_found', 'No such Bench round.');
                if (r.status !== 'finished' && r.status !== 'ready') throw new BenchError(409, 'bench.round_not_ready', 'This round is not ready to judge yet.');
                if (judge === 'audience_poll' && kindById(r.kind_id)?.judge !== 'human_pairwise') {
                    throw new BenchError(422, 'bench.invalid_judge', 'Audience polls require a pairwise kind.');
                }

                let left = null;
                let right = null;
                if (judge === 'human_pairwise' || judge === 'game_outcome' || judge === 'audience_poll') {
                    if (judge === 'human_pairwise' && r.created_by === subject) throw new BenchError(403, 'bench.creator_cannot_vote', 'You cannot judge a round you started.');
                    const p = pair && typeof pair === 'object' ? pair : {};
                    if (!p.left || !p.right || p.left === p.right) throw new BenchError(422, 'bench.invalid_pair', 'A pairwise judgement needs two different entries.');
                    const prior = await db.maybe('SELECT 1 AS n FROM bench_judgements WHERE round_id = $1 AND subject = $2', [r.id, subject]);
                    if (prior) throw new BenchError(409, 'bench.already_judged', 'You have already judged this round.');
                    const rows = await db.many('SELECT * FROM bench_entries WHERE round_id = $1 AND id = ANY($2::text[]) AND error IS NULL', [r.id, [p.left, p.right]]);
                    if (rows.length !== 2) throw new BenchError(422, 'bench.invalid_pair', 'Those two entries are not both part of this round.');
                    left = wireEntry(rows.find((o) => o.id === p.left));
                    right = wireEntry(rows.find((o) => o.id === p.right));
                    const allowed = judge === 'game_outcome' ? ['left', 'right', 'draw'] : judge === 'audience_poll' ? ['left', 'right', 'tie'] : WINNERS;
                    if (!allowed.includes(outcome)) throw new BenchError(422, 'bench.invalid_outcome', `The outcome must be ${allowed.join(', ')}.`);
                    if (judge === 'audience_poll') {
                        const c = voteCounts;
                        if (!c || !['left', 'right', 'tie', 'voters'].every((k) => Number.isSafeInteger(c[k]) && c[k] >= 0)
                            || c.left + c.right + c.tie !== c.voters || c.voters > 1000000
                            || outcome !== (c.left > c.right && c.left > c.tie ? 'left' : c.right > c.left && c.right > c.tie ? 'right' : 'tie')) {
                            throw new BenchError(422, 'bench.invalid_vote_counts', 'Poll counts and outcome must agree.');
                        }
                        voteCounts = { left: c.left, right: c.right, tie: c.tie, voters: c.voters };
                    } else if (voteCounts != null) throw new BenchError(422, 'bench.invalid_vote_counts', 'Only an audience poll carries vote counts.');
                }

                const id = s.newId('bju');
                const row = await db.maybe(
                    `INSERT INTO bench_judgements (id, round_id, kind_id, judge, judge_name, judge_version, method, pair, outcome, score, subject, at, vote_counts, question, answer, net_hash)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::timestamptz, $13::jsonb, $14, $15, $16) RETURNING *`,
                    [id, r.id, r.kind_id, judge, judgeName, judgeVersion, judge, pair ? JSON.stringify(pair) : null,
                        outcome || null, score == null ? null : num(score), subject || null, s.iso(), voteCounts ? JSON.stringify(voteCounts) : null,
                        question == null ? null : String(question).slice(0, 200), answer == null ? null : String(answer).slice(0, 40),
                        netHash == null ? null : String(netHash).slice(0, 64)],
                );
                // One stream poll is one game, regardless of audience size. The counts are evidence, not Elo weight.
                if (judge === 'human_pairwise' || judge === 'game_outcome' || (judge === 'audience_poll' && voteCounts.voters > 0)) {
                    await applyPairwiseRating(r.id, r.kind_id, left, right, outcome);
                }
                await insertOutbox('bench.judgement.recorded', {
                    judgement_id: id, round_id: r.id, kind_id: r.kind_id, judge, method: judge, outcome: outcome || null, score: score == null ? null : num(score),
                });
                return { judgement: wireJudgement(row), revealed: left && right ? { left, right } : null };
            });
        } catch (err) {
            if (err && err.code === '23505') throw new BenchError(409, 'bench.already_judged', 'You have already judged this round.');
            throw err;
        }
    }

    async function applyPairwiseRating(roundId, kindId, left, right, outcome) {
        if (outcome === 'both_bad') return;
        if (!left || !right || left.model === right.model) return;
        const models = [left.model, right.model];
        const now = s.iso();
        for (const model of models) {
            await db.exec(
                `INSERT INTO bench_ratings (kind_id, category, subject, elo, games, wins, losses, ties, win_rate, ci_lower, ci_upper, updated_at)
                 VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, NULL, NULL, $5::timestamptz)
                 ON CONFLICT (kind_id, category, subject) DO NOTHING`,
                [kindId, CATEGORY_DEFAULT, model, BASE_ELO, now],
            );
        }
        const rows = await db.many('SELECT * FROM bench_ratings WHERE kind_id = $1 AND category = $2 AND subject = ANY($3::text[]) ORDER BY subject FOR UPDATE',
            [kindId, CATEGORY_DEFAULT, models]);
        const byModel = new Map(rows.map((r) => [r.subject, r]));
        const a = byModel.get(left.model);
        const b = byModel.get(right.model);
        if (!a || !b) return;
        const eloOutcome = outcome === 'draw' ? 'tie' : outcome;
        const update = ratingLib.eloUpdate(num(a.elo, BASE_ELO), num(b.elo, BASE_ELO), eloOutcome, K);
        const sa = outcome === 'left' ? 1 : outcome === 'right' ? 0 : 0.5;
        const sb = 1 - sa;
        for (const [row, elo, score, opp] of [[a, update.a, sa, sb], [b, update.b, sb, sa]]) {
            const games = num(row.games) + 1;
            const wins = num(row.wins) + (score > opp ? 1 : 0);
            const losses = num(row.losses) + (score < opp ? 1 : 0);
            const ties = num(row.ties) + (score === opp ? 1 : 0);
            const ci = ratingCi(elo, wins, losses, ties);
            await db.exec(
                `UPDATE bench_ratings SET elo = $1, games = $2, wins = $3, losses = $4, ties = $5,
                   win_rate = $6, ci_lower = $7, ci_upper = $8, updated_at = $9::timestamptz
                 WHERE kind_id = $10 AND category = $11 AND subject = $12`,
                [elo, games, wins, losses, ties, games ? Math.round(((wins + ties * 0.5) / games) * 10000) / 10000 : 0,
                    ci.ci_lower, ci.ci_upper, now, kindId, CATEGORY_DEFAULT, row.subject],
            );
        }
        await insertOutbox('bench.rating.changed', { kind_id: kindId, category: CATEGORY_DEFAULT, subjects: models });
        // The ratings have been refitted: this is where the watches are checked.
        if (typeof s.onRatingsChanged === 'function') {
            try { await s.onRatingsChanged(kindId, models); } catch (err) {
                if (log && typeof log.warn === 'function') log.warn('[OpenVibe.Bench] watch check failed: ' + (err && err.message ? err.message : err));
            }
        }
    }

    // ── Boards ──────────────────────────────────────────────
    async function subjectsFor(kindId) {
        const rows = await db.many(
            `SELECT DISTINCT e.model FROM bench_entries e JOIN bench_rounds r ON r.id = e.round_id
             WHERE r.kind_id = $1 AND e.error IS NULL ORDER BY e.model`,
            [kindId],
        );
        return rows.map((r) => r.model);
    }

    async function boardElo(kindId) {
        const subjects = await subjectsFor(kindId);
        const ratings = await db.many('SELECT * FROM bench_ratings WHERE kind_id = $1 AND category = $2', [kindId, CATEGORY_DEFAULT]);
        const by = new Map(ratings.map((r) => [r.subject, wireRating(r)]));
        const rows = subjects.map((subject) => {
            const r = by.get(subject);
            const games = r ? r.games : 0;
            return {
                kind_id: kindId, category: CATEGORY_DEFAULT, subject,
                elo: r ? r.elo : BASE_ELO,
                games, wins: r ? r.wins : 0, losses: r ? r.losses : 0, ties: r ? r.ties : 0,
                win_rate: r ? r.win_rate : 0,
                ci_lower: r ? r.ci_lower : null,
                ci_upper: r ? r.ci_upper : null,
                provisional: games < 10,
            };
        });
        rows.sort((a, b) => b.elo - a.elo || a.subject.localeCompare(b.subject));
        return rows;
    }

    async function costStats(kindId) {
        const rows = await db.many(
            `SELECT e.model,
                    COUNT(*)::int AS entries,
                    COALESCE(SUM(e.cost_usd), 0)::numeric AS total_cost,
                    COUNT(*) FILTER (WHERE e.error IS NULL)::int AS usable,
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY e.cost_usd) AS median_cost,
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY e.ms) AS median_ms
             FROM bench_entries e JOIN bench_rounds r ON r.id = e.round_id
             WHERE r.kind_id = $1 AND e.error IS NULL
             GROUP BY e.model`,
            [kindId],
        );
        return new Map(rows.map((r) => [r.model, r]));
    }

    async function passRate(kindId) {
        const rows = await db.many(
            `SELECT e.model, COUNT(*)::int AS trials, COUNT(*) FILTER (WHERE j.outcome = 'pass' OR COALESCE(j.score, 0) > 0)::int AS passed
             FROM bench_entries e
             JOIN bench_rounds r ON r.id = e.round_id
             JOIN bench_judgements j ON j.round_id = r.id
             WHERE r.kind_id = $1 AND e.error IS NULL
             GROUP BY e.model`,
            [kindId],
        );
        return new Map(rows.map((r) => [r.model, r]));
    }

    async function board(kindId, { type = 'elo', category = CATEGORY_DEFAULT, period = 'all' } = {}) {
        const kind = await getKind(kindId);
        if (!kind) return null;
        const cost = await costStats(kindId);
        const pass = await passRate(kindId);
        const eloRows = await boardElo(kindId);

        let rows;
        if (type === 'elo') {
            rows = eloRows.map((r) => ({ ...r, median_cost_usd: num(cost.get(r.subject)?.median_cost), median_ms: num(cost.get(r.subject)?.median_ms) }));
        } else if (type === 'pareto') {
            const subjects = await subjectsFor(kindId);
            rows = subjects.map((subject) => {
                const e = eloRows.find((x) => x.subject === subject) || {};
                const p = pass.get(subject);
                const quality = p ? (num(p.trials) ? num(p.passed) / num(p.trials) : 0) : (num(e.win_rate) || 0);
                const medianCost = num(cost.get(subject)?.median_cost);
                return { subject, quality, win_rate: num(e.win_rate) || 0, pass_rate: p ? (num(p.trials) ? num(p.passed) / num(p.trials) : 0) : 0, cost: medianCost, median_cost_usd: medianCost, median_ms: num(cost.get(subject)?.median_ms), provisional: num(e.games) < 10 };
            });
            rows = ratingLib.pareto(rows, { x: 'quality', y: 'cost' });
        } else if (type === 'cost') {
            rows = [...cost.values()].map((r) => {
                const solved = num(pass.get(r.model)?.passed) || num(r.usable) || 0;
                const totalCost = num(r.total_cost);
                return {
                    subject: r.model, entries: num(r.entries), usable: num(r.usable),
                    total_cost_usd: Math.round(totalCost * 1e6) / 1e6,
                    solved,
                    cost_per_solved: solved ? Math.round((totalCost / solved) * 1e6) / 1e6 : null,
                    median_cost_usd: num(r.median_cost),
                    median_ms: num(r.median_ms),
                };
            });
            rows.sort((a, b) => (a.cost_per_solved == null ? Infinity : a.cost_per_solved) - (b.cost_per_solved == null ? Infinity : b.cost_per_solved) || a.subject.localeCompare(b.subject));
        } else {
            return null;
        }
        return { kind_id: kindId, category, period, type, rows };
    }

    /**
     * Every model that ran a kind, with the numbers the pick reads: the score (how often its output passed), the cost
     * per solved task, the median time a task took and how many runs it has. Every row is kept, including the ones
     * another model beats on both score and cost: the pick works out the frontier itself.
     */
    async function valueRows(kindId) {
        const cost = await costStats(kindId);
        const pass = await passRate(kindId);
        const eloRows = await boardElo(kindId);
        const rows = [];
        for (const [model, c] of cost) {
            const p = pass.get(model);
            const e = eloRows.find((x) => x.subject === model) || {};
            const trials = num(p && p.trials);
            const passed = num(p && p.passed);
            const quality = trials ? passed / trials : (num(e.win_rate) || 0);
            const totalCost = num(c.total_cost);
            const solved = passed || num(c.usable);
            rows.push({
                subject: model,
                score: Math.round(quality * 1000) / 10,
                quality: Math.round(quality * 1e6) / 1e6,
                votes: num(e.games),
                win_rate: num(e.win_rate) || 0,
                runs: num(c.usable),
                entries: num(c.entries),
                solved,
                cost_per_solved: solved ? Math.round((totalCost / solved) * 1e6) / 1e6 : null,
                median_cost_usd: num(c.median_cost),
                median_ms: num(c.median_ms),
            });
        }
        rows.sort((a, b) => (b.score - a.score)
            || ((a.cost_per_solved == null ? Infinity : a.cost_per_solved) - (b.cost_per_solved == null ? Infinity : b.cost_per_solved))
            || a.subject.localeCompare(b.subject));
        return rows;
    }

    async function modelSummary(model) {
        const name = String(model || '');
        const ratings = (await db.many('SELECT * FROM bench_ratings WHERE subject = $1 ORDER BY kind_id, category', [name])).map(wireRating);
        const entries = (await db.many(
            `SELECT e.*, r.kind_id FROM bench_entries e JOIN bench_rounds r ON r.id = e.round_id WHERE e.model = $1 ORDER BY e.created_at DESC LIMIT 100`,
            [name],
        )).map((e) => ({ ...wireEntry(e), kind_id: e.kind_id }));
        const cost = num(await db.value('SELECT COALESCE(SUM(cost_usd), 0)::numeric AS n FROM bench_entries WHERE model = $1', [name]));
        return { model: name, ratings, entries, total_cost_usd: Math.round(cost * 1e6) / 1e6 };
    }

    // ── Dataset (open, no voter ids) ─────────────────────────
    async function dataset(kindId) {
        const kind = await getKind(kindId);
        if (!kind) return null;
        const tasks = (await db.many('SELECT * FROM bench_tasks WHERE kind_id = $1 AND public = true ORDER BY created_at, id', [kindId]))
            .map(wireTask).map(({ created_by, ...rest }) => rest);
        const rounds = (await db.many("SELECT * FROM bench_rounds WHERE kind_id = $1 AND status IN ('ready', 'finished') ORDER BY created_at, id", [kindId]))
            .map(wireRound).map(({ created_by, ...rest }) => rest);
        const roundIds = rounds.map((r) => r.id);
        let entries = [];
        let judgements = [];
        if (roundIds.length) {
            entries = (await db.many('SELECT * FROM bench_entries WHERE round_id = ANY($1::text[]) ORDER BY created_at, id', [roundIds])).map(wireEntry);
            judgements = (await db.many('SELECT * FROM bench_judgements WHERE round_id = ANY($1::text[]) ORDER BY at, id', [roundIds])).map((j) => wireJudgement(j));
        }
        const ratings = (await db.many('SELECT * FROM bench_ratings WHERE kind_id = $1 ORDER BY subject', [kindId])).map(wireRating);
        return { kind_id: kindId, tasks, rounds, entries, judgements, ratings };
    }

    async function datasetJsonl(kindId) {
        const d = await dataset(kindId);
        if (!d) return null;
        const lines = [];
        for (const t of d.tasks) lines.push(JSON.stringify({ type: 'task', ...t }));
        for (const r of d.rounds) lines.push(JSON.stringify({ type: 'round', ...r }));
        for (const e of d.entries) lines.push(JSON.stringify({ type: 'entry', ...e }));
        for (const j of d.judgements) lines.push(JSON.stringify({ type: 'judgement', ...j }));
        for (const r of d.ratings) lines.push(JSON.stringify({ type: 'rating', ...r }));
        return lines.length ? `${lines.join('\n')}\n` : '';
    }

    // ── Private evals ────────────────────────────────────────
    async function createEval({ owner, kindId, name, testSuite }) {
        const kind = await getKind(kindId);
        if (!kind) return refusal(422, 'bench.kind_not_found', `No such kind: ${kindId}`);
        const cleanName = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 160);
        if (!cleanName) return refusal(422, 'bench.eval_name_required', 'An eval needs a name.');
        const suite = Array.isArray(testSuite) ? testSuite : [];
        if (!suite.length) return refusal(422, 'bench.eval_suite_required', 'An eval needs a non-empty test_suite.');
        const id = s.newId('bev');
        const row = await db.maybe(
            `INSERT INTO bench_evals (id, owner, kind_id, name, test_suite, created_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz) RETURNING *`,
            [id, owner, kind.id, cleanName, JSON.stringify(suite), s.iso()],
        );
        return { ok: true, eval: wireEval(row) };
    }
    async function getEval(id, { owner = null } = {}) {
        const row = await db.maybe('SELECT * FROM bench_evals WHERE id = $1', [String(id || '')]);
        if (!row || (owner && row.owner !== owner)) return null;
        return wireEval(row);
    }

    async function evalDailyCount(owner) {
        const start = dayStart();
        return num(await db.value(
            `SELECT COUNT(*)::int AS n FROM bench_eval_runs r JOIN bench_evals e ON e.id = r.eval_id
             WHERE e.owner = $1 AND r.created_at >= $2::timestamptz`,
            [owner, start],
        ));
    }

    async function runEval({ evalId, offers, owner }) {
        const ev = await getEval(evalId, { owner });
        if (!ev) throw new BenchError(404, 'bench.eval_not_found', 'No such eval (or it is not yours).');
        const used = await evalDailyCount(owner);
        const cap = config ? config.bench.evalsPerDay : 20;
        if (used >= cap) throw new BenchError(429, 'bench.eval_limit', `You can run ${cap} private evals a day.`);
        const off = Array.isArray(offers) ? offers.map((o) => ({ provider: String(o.provider || ''), model: o.model == null ? null : String(o.model) })) : [];
        const id = s.newId('ber');
        const row = await db.maybe(
            `INSERT INTO bench_eval_runs (id, eval_id, offers, status, created_at)
             VALUES ($1, $2, $3::jsonb, 'queued', $4::timestamptz) RETURNING *`,
            [id, ev.id, JSON.stringify(off), s.iso()],
        );
        return wireEvalRun(row);
    }

    async function evalResults(evalId, { owner = null } = {}) {
        const ev = await getEval(evalId, { owner });
        if (!ev) return null;
        const runs = (await db.many('SELECT * FROM bench_eval_runs WHERE eval_id = $1 ORDER BY created_at DESC', [ev.id])).map(wireEvalRun);
        return { eval: ev, runs };
    }

    return {
        wireKind, wireTask, wireRound, wireEntry, wireJudgement, wireRating, wireEval, wireEvalRun,
        insertOutbox, seedKinds, listKinds, getKind,
        createTask, getTask,
        createRound, getRound, addEntry, maybeReady, finishRound,
        nextJudgement, castJudgement, pairwiseGames,
        board, valueRows, modelSummary, dataset, datasetJsonl,
        createEval, getEval, runEval, evalResults, evalDailyCount,
        KINDS, JUDGES, WINNERS, BASE_ELO, CATEGORY_DEFAULT, shuffle,
    };
}

module.exports = { createStore, BenchError, KINDS, JUDGES, WINNERS, BASE_ELO, CATEGORY_DEFAULT, shuffle };

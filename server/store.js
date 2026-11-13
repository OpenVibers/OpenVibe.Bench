'use strict';

/**
 * Bench's data access: kinds, tasks, rounds, entries, judgements, ratings, boards, the open dataset and private
 * evals. A judgement and the rating changes (plus the outbox rows) commit in one transaction, so a crash can
 * never leave a vote without its Elo update. One vote per person per round; a creator cannot vote on their own
 * round; identities stay hidden until a caller has voted (or started the round).
 */
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const { KINDS, ALL_KINDS, PRIVATE_KIND_IDS, JUDGES, WINNERS, kindById, isPrivateKind } = require('./kinds');
const clipLib = require('./bench/clip');
const clipSource = require('./bench/clip-source');
const ratingLib = require('./rating');
const styleLib = require('./rating/style');
const statsLib = require('./rating/stats');
const { checkSvg } = require('./bench/svg-check');
const { createWillingReader } = require('./bench/willing');

const BASE_ELO = ratingLib.BASE_ELO;
const K = 32;
const CATEGORY_DEFAULT = 'all';
// The rating categories: everyone ('all'), the signed-in people ('people') and the anonymous voters ('anon').
const CATEGORY_PEOPLE = 'people';
const CATEGORY_ANON = 'anon';
// The Arena's kind and the first-party service that builds its rounds (OpenVibe.Exchange).
const ARENA_KIND = 'chat.arena';
const ARENA_SERVICE = 'service:exchange';

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

/**
 * Who voted: a person, a first-party service, or an anonymous voter. An anonymous voter is a hash (anon_…), never
 * an id, so the database never holds anything about the visitor.
 */
function kindOfVoter(voterKind, subject) {
    if (voterKind === 'person' || voterKind === 'anon' || voterKind === 'service') return voterKind;
    const s = String(subject || '');
    if (!s) return 'service';
    if (s.startsWith('anon_')) return 'anon';
    if (s.startsWith('usr_')) return 'person';
    return 'service';
}

/**
 * The rating categories a vote is counted in: everyone, the kind of voter it came from, and the task's own
 * category (code, writing, chat, reasoning…) when the room classified the prompt. One vote updates each of
 * them, so a board can show all votes, only people's, or only one kind of task.
 */
function categoriesOf(voterKind, taskCategory = null) {
    const out = [CATEGORY_DEFAULT];
    if (voterKind === 'person') out.push(CATEGORY_PEOPLE);
    else if (voterKind === 'anon') out.push(CATEGORY_ANON);
    const task = normalizeCategory(taskCategory);
    if (task) out.push(task);
    return [...new Set(out)];
}

/** A task category is a short slug; 'all', 'people' and 'anon' are the board's own, never a task's. */
function normalizeCategory(value) {
    const slug = String(value == null ? '' : value).toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!slug || slug === CATEGORY_DEFAULT || slug === CATEGORY_PEOPLE || slug === CATEGORY_ANON) return null;
    return slug;
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

function createStore(s, { log = console, random = Math.random, config = null, ai = null } = {}) {
    const db = s.db;
    const willingReader = createWillingReader({ ai, log, now: s.now });
    // The kind boards' fits are pure functions of the games, so a board asks for the same fit only once per
    // vote set. The key changes with the number of games, and a short TTL covers a vote that lands mid-request.
    const boardFits = new Map();
    const BOARD_BOOTSTRAP = 200;
    const BOARD_FIT_TTL_MS = 5 * 60_000;
    // A per-category board is published only when its category has this many games; below it there is not
    // enough play to separate models, so the board is left out of the category list rather than shown thin.
    const CATEGORY_MIN_GAMES = 30;

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
        for (const k of ALL_KINDS) {
            await db.exec(
                `INSERT INTO bench_kinds (id, room, entry, judge, name, schema, metrics, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now())
                 ON CONFLICT (id) DO UPDATE SET room = EXCLUDED.room, entry = EXCLUDED.entry, judge = EXCLUDED.judge,
                   name = EXCLUDED.name, schema = EXCLUDED.schema, metrics = EXCLUDED.metrics`,
                [k.id, k.room, k.entry, k.judge, k.name, JSON.stringify(k.schema), JSON.stringify(k.metrics)],
            );
        }
    }
    /** The public kinds; a private one (live.clip) is never listed. */
    async function listKinds({ includeAdult = false } = {}) {
        return (await db.many('SELECT * FROM bench_kinds WHERE NOT (id = ANY($1::text[])) ORDER BY id', [PRIVATE_KIND_IDS])).map(wireKind)
            .filter((kind) => includeAdult || !kind.schema || kind.schema.adult !== true);
    }
    async function getKind(id) {
        return wireKind(await db.maybe('SELECT * FROM bench_kinds WHERE id = $1', [String(id || '')]));
    }

    // ── Tasks ───────────────────────────────────────────────
    async function createTask({ kindId, prompt, taskClass = null, public: isPublic = false, subject }) {
        const kind = await getKind(kindId);
        if (!kind) return refusal(422, 'bench.kind_not_found', `No such kind: ${kindId}`);
        // A private kind's tasks name what is not public (a held-out recording): never public.
        if (isPrivateKind(kind.id)) isPublic = false;
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
        // A private kind's rounds spend no AI (their submitter brings the entries): they count against nothing.
        const used = num(await db.value('SELECT COUNT(*)::int AS n FROM bench_rounds WHERE created_by = $1 AND created_at >= $2::timestamptz AND NOT (kind_id = ANY($3::text[]))', [subject, start, PRIVATE_KIND_IDS]));
        const siteUsed = num(await db.value('SELECT COUNT(*)::int AS n FROM bench_rounds WHERE created_at >= $1::timestamptz AND NOT (kind_id = ANY($2::text[]))', [start, PRIVATE_KIND_IDS]));
        return {
            used,
            remaining: Math.max(0, perDay - used),
            per_day: perDay,
            site_used: siteUsed,
            site_daily: daily,
            site_remaining: Math.max(0, daily - siteUsed),
        };
    }

    async function createRound({ taskId, offers = null, seed = 0, subject, bypassQuota = false }) {
        const task = await getTask(taskId);
        if (!task) return refusal(404, 'bench.task_not_found', 'No such task.');
        const kind = await getKind(task.kind_id);
        if (!kind) return refusal(422, 'bench.kind_not_found', 'The task\'s kind is gone.');
        const off = Array.isArray(offers) ? offers.slice(0, 3).map((o) => ({ provider: String(o.provider || ''), model: o.model == null ? null : String(o.model) })) : [];
        if (off.some((o) => !o.provider)) return refusal(422, 'bench.invalid_offers', 'Every offer needs a provider.');
        // The daily rounds job spends Bench's own budget, not a person's quota, so it may skip the counts. A private
        // kind's round (live.clip) spends no AI at all (its submitter brings the entries), so it skips them too.
        if (bypassQuota || isPrivateKind(kind.id)) {
            const ownId = s.newId('brd');
            const own = await db.maybe(
                `INSERT INTO bench_rounds (id, task_id, kind_id, offers, status, seed, params, pool_fallback, created_by, created_at)
                 VALUES ($1, $2, $3, $4::jsonb, 'queued', $5, '{}'::jsonb, $6, $7, $8::timestamptz)
                 RETURNING *`,
                [ownId, task.id, kind.id, JSON.stringify(off), Math.max(0, Number(seed) || 0), off.length < 3, subject, s.iso()],
            );
            if (!own) throw new BenchError(500, 'bench.round_not_created', 'Bench could not create the round.');
            return { ok: true, round: await getRound(ownId) };
        }
        const perDay = config ? config.bench.roundsPerDay : 3;
        const daily = config ? config.bench.roundsDaily : 20;
        const start = dayStart();
        const id = s.newId('brd');
        const row = await db.maybe(
            `INSERT INTO bench_rounds (id, task_id, kind_id, offers, status, seed, params, pool_fallback, created_by, created_at)
             SELECT $1, $2, $3, $4::jsonb, 'queued', $5, '{}'::jsonb, $6, $7, $8::timestamptz
             WHERE (SELECT COUNT(*) FROM bench_rounds WHERE created_by = $7 AND created_at >= $9::timestamptz AND NOT (kind_id = ANY($12::text[]))) < $10
               AND (SELECT COUNT(*) FROM bench_rounds WHERE created_at >= $9::timestamptz AND NOT (kind_id = ANY($12::text[]))) < $11
             RETURNING *`,
            [id, task.id, kind.id, JSON.stringify(off), Math.max(0, Number(seed) || 0), off.length < 3, subject, s.iso(), start, perDay, daily, PRIVATE_KIND_IDS],
        );
        if (!row) {
            const c = await roundCounts(subject);
            if (c.used >= perDay) throw new BenchError(429, 'bench.limit_person', `You can start ${perDay} round${perDay === 1 ? '' : 's'} a day.`);
            throw new BenchError(429, 'bench.limit_site', `Bench has reached its ${daily} round${daily === 1 ? '' : 's'} for today.`);
        }
        return { ok: true, round: await getRound(id) };
    }

    /**
     * One Arena round for OpenVibe.Exchange: a person's prompt, two or three answers from different models, and
     * a round this service owns. The Exchange's rounds spend no AI and no person's daily quota here; they have
     * their own daily cap. The voter is the person who asked, so the creator rule still keeps this service from
     * voting on the round it built.
     */
    async function createArenaRound({ prompt, category = null, entries = [] } = {}) {
        const list = Array.isArray(entries) ? entries.slice(0, 3) : [];
        if (list.length < 2) throw new BenchError(422, 'bench.invalid_entries', 'An arena round needs two answers.');
        const clean = list.map((e) => ({
            provider: String((e && e.provider) || '').slice(0, 80),
            model: String((e && e.model) || '').slice(0, 120),
            answer: String((e && e.answer) == null ? '' : e.answer).slice(0, 16000),
            costUsd: num(e && e.cost_usd),
            ms: num(e && e.ms),
            tokens: num(e && e.tokens),
            runId: e && e.run_id ? String(e.run_id).slice(0, 120) : null,
        }));
        if (clean.some((e) => !e.provider || !e.model || !e.answer.trim())) {
            throw new BenchError(422, 'bench.invalid_entries', 'Every answer needs a provider, a model and text.');
        }
        // One model against itself is not a comparison: it could never move a rating.
        if (new Set(clean.map((e) => e.model)).size < 2) {
            throw new BenchError(422, 'bench.invalid_entries', 'An arena round needs answers from two different models.');
        }

        const cap = config ? config.bench.arenaRoundsDaily : 2000;
        const used = num(await db.value('SELECT COUNT(*)::int AS n FROM bench_rounds WHERE kind_id = $1 AND created_at >= $2::timestamptz',
            [ARENA_KIND, dayStart()]));
        if (used >= cap) throw new BenchError(429, 'bench.arena_limit', 'The arena has reached its rounds for today.');

        const taskOut = await createTask({
            kindId: ARENA_KIND, prompt, taskClass: normalizeCategory(category), public: true, subject: ARENA_SERVICE,
        });
        if (!taskOut.ok) throw new BenchError(taskOut.status || 400, taskOut.code || 'bench.invalid', taskOut.message || 'invalid task');
        const built = await createRound({
            taskId: taskOut.task.id,
            offers: clean.map((e) => ({ provider: e.provider, model: e.model })),
            subject: ARENA_SERVICE,
            bypassQuota: true,
        });
        if (!built.ok) throw new BenchError(built.status || 400, built.code || 'bench.invalid', built.message || 'invalid round');

        const roundId = built.round.id;
        const made = [];
        try {
            for (const e of clean) {
                made.push(await addEntry({
                    roundId, provider: e.provider, model: e.model, payload: { answer: e.answer },
                    costUsd: e.costUsd, ms: e.ms, tokens: e.tokens, runId: e.runId,
                }));
            }
        } catch (err) {
            await db.exec('DELETE FROM bench_rounds WHERE id = $1', [roundId]);
            throw err;
        }
        const sides = ['left', 'right', 'third'];
        return {
            round: await getRound(roundId, { viewerSubject: ARENA_SERVICE }),
            entries: made.map((e, i) => ({ id: e.id, side: sides[i], provider: e.provider, model: e.model })),
        };
    }

    async function getRound(id, { viewerSubject = null } = {}) {
        const r = await db.maybe('SELECT * FROM bench_rounds WHERE id = $1', [String(id || '')]);
        if (!r) return null;
        const entryRows = await db.many('SELECT * FROM bench_entries WHERE round_id = $1 ORDER BY created_at, id', [r.id]);
        const revealed = viewerSubject != null && (r.created_by === viewerSubject
            || await db.value('SELECT COUNT(*)::int AS n FROM bench_judgements WHERE round_id = $1 AND subject = $2', [r.id, viewerSubject]) > 0);
        const votes = num(await db.value("SELECT COUNT(*)::int AS n FROM bench_judgements WHERE round_id = $1 AND method <> 'game_outcome'", [r.id]));
        // A live.clip playback is only for a voter (nextJudgement); a round read never carries one.
        const entries = entryRows.map((e) => wireEntry(e, { blind: !revealed }))
            .map((e) => (isPrivateKind(r.kind_id) ? { ...e, payload: clipLib.forViewer(e.payload, { now: s.now(), playback: false }) } : e));
        const out = { ...wireRound(r), entries, votes };
        if (!revealed) out.blind = true;
        return out;
    }

    /** Insert an entry into a round; moves a room-submitted round to ready when it has two usable entries. */
    async function addEntry({ roundId, provider, model, route, payload, costUsd = 0, ms = 0, tokens = 0, error = null, uiCheck = null, runId = null, claims = null }) {
        return await s.tx(async () => {
            const r = await db.maybe('SELECT * FROM bench_rounds WHERE id = $1 FOR UPDATE', [String(roundId || '')]);
            if (!r) throw new BenchError(404, 'bench.round_not_found', 'No such Bench round.');
            if (r.kind_id === 'design.svg' && !error) {
                const task = await db.maybe('SELECT prompt FROM bench_tasks WHERE id = $1', [r.task_id]);
                const check = checkSvg(payload && payload.svg, task && task.prompt);
                uiCheck = { ...(uiCheck && typeof uiCheck === 'object' && !Array.isArray(uiCheck) ? uiCheck : {}), svg_layout: check };
                if (check.status === 'failed') error = 'SVG layout check failed: ' + check.issues.join(', ');
            }
            if (r.kind_id === 'live.clip') {
                // A clip pick: its shape checked, and the policy that chose it pinned on the entry (route), never rewritten.
                const v = clipLib.validateEntry(payload, { now: s.now() });
                if (!v.ok) throw new BenchError(422, 'bench.invalid_clip', v.message);
                payload = v.payload;
                // The submitter must be authorised for the recording the clip was cut from: a token that may submit
                // for one recording may not name another. The check fails closed (no grant, no recording).
                const src = clipSource.sourceAllowed(claims, payload.source.recording_id);
                if (!src.allowed) throw new BenchError(403, src.code, src.reason);
                route = { policy: v.payload.policy };
                model = model || v.payload.policy.models[0] || `${v.payload.policy.selector}@${v.payload.policy.version}`;
                provider = provider || 'live';
            }
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
    /**
     * The pairwise games of a board, as the rating maths reads them: two model names and an outcome of
     * 'a', 'b' or 'tie'. The pair on a judgement names two entries, so the models come from the entries, never
     * from the entry ids.
     *
     * The category picks the games the board counts: 'all' every vote, 'people' the signed-in voters, 'anon' the
     * anonymous ones, and any other slug the task's own category (code, writing, chat, reasoning…).
     */
    async function pairwiseGames(kindId, category = CATEGORY_DEFAULT) {
        const cat = String(category == null ? CATEGORY_DEFAULT : category);
        const rows = await db.many(
            `SELECT j.id, j.method, j.outcome, j.vote_counts, l.model AS left_model, e.model AS right_model
             FROM bench_judgements j
             JOIN bench_rounds rd ON rd.id = j.round_id
             JOIN bench_tasks t ON t.id = rd.task_id
             JOIN bench_entries l ON l.id = j.pair->>'left' AND l.round_id = j.round_id
             JOIN bench_entries e ON e.id = j.pair->>'right' AND e.round_id = j.round_id
             WHERE j.kind_id = $1
               AND j.method IN ('human_pairwise', 'game_outcome', 'audience_poll')
               AND j.pair IS NOT NULL AND j.outcome IS NOT NULL
               AND ($2::text <> 'people' OR COALESCE(j.voter_kind, 'person') = 'person')
               AND ($2::text <> 'anon' OR j.voter_kind = 'anon')
               AND ($2::text IN ('all', 'people', 'anon') OR t.task_class = $2)
             ORDER BY j.at, j.id`,
            [kindId, cat],
        );
        const out = [];
        for (const j of rows) {
            if (j.outcome === 'both_bad') continue;
            if (j.method === 'audience_poll') {
                const counts = typeof j.vote_counts === 'string' ? JSON.parse(j.vote_counts) : j.vote_counts;
                if (!counts || !num(counts.voters)) continue;
            }
            if (!j.left_model || !j.right_model || j.left_model === j.right_model) continue;
            const outcome = j.outcome === 'left' ? 'a' : j.outcome === 'right' ? 'b' : (j.outcome === 'tie' || j.outcome === 'draw') ? 'tie' : null;
            if (!outcome) continue;
            out.push({ id: j.id, a: j.left_model, b: j.right_model, outcome });
        }
        return out;
    }

    /** A ready round this person has not judged and did not start, with two entries shuffled and identities hidden. */
    async function nextJudgement({ kind, subject, random: rng = random, extraCreators = [] } = {}) {
        const creators = (extraCreators || []).filter(Boolean);
        const row = await db.maybe(
            `SELECT r.* FROM bench_rounds r
             WHERE r.kind_id = $1 AND r.status = 'finished' AND r.created_by <> $2
               AND NOT (r.created_by = ANY($3::text[]))
               AND (SELECT COUNT(*) FROM bench_entries e WHERE e.round_id = r.id AND e.error IS NULL) >= 2
               AND NOT EXISTS (SELECT 1 FROM bench_judgements j WHERE j.round_id = r.id AND j.subject = $2)
             ORDER BY r.created_at, r.id LIMIT 1`,
            [String(kind || ''), subject, creators],
        );
        if (!row) return null;
        const entries = (await db.many('SELECT * FROM bench_entries WHERE round_id = $1 AND error IS NULL ORDER BY id', [row.id])).map(wireEntry)
            // A voter of a private kind sees the playback, while it lasts (clip.forViewer).
            .map((e) => (isPrivateKind(row.kind_id) ? { ...e, payload: clipLib.forViewer(e.payload, { now: s.now(), playback: true }) } : e));
        if (entries.length < 2) return null;
        const [left, right] = shuffle(entries, rng).slice(0, 2);
        return {
            round: { id: row.id, kind_id: row.kind_id, prompt: (await getTask(row.task_id)).prompt },
            left: { id: left.id, payload: left.payload },
            right: { id: right.id, payload: right.payload },
        };
    }

    async function castJudgement({ roundId, kindId, judge, judgeName = null, judgeVersion = null, pair = null, outcome = null, score = null, voteCounts = null, question = null, answer = null, netHash = null, subject, voterKind = null, extraCreators = [], quota = null }) {
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
                    // A voter never judges a round they started: a person never judges their own, and the
                    // service that relays an anonymous vote never judges a round it started itself.
                    const extra = (extraCreators || []).filter(Boolean);
                    const creators = [r.created_by, ...extra].filter(Boolean);
                    if (judge === 'human_pairwise' && (creators.includes(subject) || extra.includes(r.created_by))) {
                        throw new BenchError(403, 'bench.creator_cannot_vote', 'You cannot judge a round you started.');
                    }
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

                // The daily caps of the anonymous vote are spent here, inside the vote's own transaction: a
                // refused vote spends nothing, and a vote that is rolled back spends nothing either.
                if (quota) await quota();

                const id = s.newId('bju');
                const row = await db.maybe(
                    `INSERT INTO bench_judgements (id, round_id, kind_id, judge, judge_name, judge_version, method, pair, outcome, score, subject, at, vote_counts, question, answer, net_hash, voter_kind)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::timestamptz, $13::jsonb, $14, $15, $16, $17) RETURNING *`,
                    [id, r.id, r.kind_id, judge, judgeName, judgeVersion, judge, pair ? JSON.stringify(pair) : null,
                        outcome || null, score == null ? null : num(score), subject || null, s.iso(), voteCounts ? JSON.stringify(voteCounts) : null,
                        question == null ? null : String(question).slice(0, 200), answer == null ? null : String(answer).slice(0, 40),
                        netHash == null ? null : String(netHash).slice(0, 64), kindOfVoter(voterKind, subject)],
                );
                // One stream poll is one game, regardless of audience size. The counts are evidence, not Elo weight.
                if (judge === 'human_pairwise' || judge === 'game_outcome' || (judge === 'audience_poll' && voteCounts.voters > 0)) {
                    const task = await getTask(r.task_id);
                    await applyPairwiseRating(r.id, r.kind_id, left, right, outcome, kindOfVoter(voterKind, subject),
                        task && task.task_class);
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

    async function applyPairwiseRating(roundId, kindId, left, right, outcome, voterKind = 'person', taskCategory = null) {
        if (outcome === 'both_bad') return;
        if (!left || !right || left.model === right.model) return;
        const models = [left.model, right.model];
        const now = s.iso();
        // The vote is counted for everyone ('all'), for the kind of voter it came from ('people' or 'anon')
        // and for the task's own category (code, writing, chat, reasoning…), so a board can show the votes
        // for one kind of work beside the whole.
        for (const category of categoriesOf(voterKind, taskCategory)) {
            for (const model of models) {
                await db.exec(
                    `INSERT INTO bench_ratings (kind_id, category, subject, elo, games, wins, losses, ties, win_rate, ci_lower, ci_upper, updated_at)
                     VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, NULL, NULL, $5::timestamptz)
                     ON CONFLICT (kind_id, category, subject) DO NOTHING`,
                    [kindId, category, model, BASE_ELO, now],
                );
            }
            const rows = await db.many('SELECT * FROM bench_ratings WHERE kind_id = $1 AND category = $2 AND subject = ANY($3::text[]) ORDER BY subject FOR UPDATE',
                [kindId, category, models]);
            const byModel = new Map(rows.map((r) => [r.subject, r]));
            const a = byModel.get(left.model);
            const b = byModel.get(right.model);
            if (!a || !b) continue;
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
                        ci.ci_lower, ci.ci_upper, now, kindId, category, row.subject],
                );
            }
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

    /**
     * The Bradley-Terry fit of one board, cached on the vote set. The fit is the same maths the ratings page uses
     * (server/rating/lib.js): every game is one vote, the ratings are centred on 1000, and the bootstrap supplies
     * both the rating interval and the 95% rank interval. The seed is fixed, so the same games give the same board.
     */
    async function pairwiseFit(kindId, category) {
        const games = await pairwiseGames(kindId, category);
        const key = `${kindId}:${category}:${games.length}:${games.length ? games[games.length - 1].id : '-'}`;
        const hit = boardFits.get(key);
        if (hit && Date.now() - hit.at < BOARD_FIT_TTL_MS) return hit.fit;
        const fit = ratingLib.bradleyTerry(games, { bootstrap: BOARD_BOOTSTRAP, seed: 1 });
        boardFits.set(key, { at: Date.now(), fit });
        if (boardFits.size > 200) {
            const oldest = [...boardFits.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
            for (const [stale] of oldest) boardFits.delete(stale);
        }
        return fit;
    }

    async function boardElo(kindId, category = CATEGORY_DEFAULT) {
        const subjects = await subjectsFor(kindId);
        const fit = await pairwiseFit(kindId, category);
        const by = new Map(fit.map((r) => [r.subject, r]));
        // A task category only lists the models that played in it: a model with no game in this kind of
        // work has no place on its board, rather than a baseline score it never earned.
        const taskCategory = ![CATEGORY_DEFAULT, CATEGORY_PEOPLE, CATEGORY_ANON].includes(category);
        const listed = new Set(taskCategory ? subjects.filter((subject) => by.has(subject)) : subjects);
        for (const r of fit) listed.add(r.subject);
        const rows = [...listed].map((subject) => {
            const r = by.get(subject);
            const games = r ? r.games : 0;
            return {
                kind_id: kindId, category, subject,
                elo: r ? Math.round(r.rating * 100) / 100 : BASE_ELO,
                games, wins: r ? r.wins : 0, losses: r ? r.losses : 0, ties: r ? r.ties : 0,
                win_rate: games ? Math.round(((r.wins + r.ties * 0.5) / games) * 10000) / 10000 : 0,
                ci_lower: r ? Math.round(r.ci_lower * 100) / 100 : null,
                ci_upper: r ? Math.round(r.ci_upper * 100) / 100 : null,
                rank: r ? r.rank : null,
                rank_lo: r ? r.rank_lo : null,
                rank_hi: r ? r.rank_hi : null,
                provisional: games < 10,
            };
        });
        rows.sort((a, b) => b.elo - a.elo || a.subject.localeCompare(b.subject));
        return rows;
    }

    /**
     * The per-category boards: one for every task category of the kind with at least CATEGORY_MIN_GAMES games, in
     * the same shape as the kind's own board. A category below the floor is not listed at all, so a page can say
     * "not enough games yet" without drawing a board that cannot separate anything.
     */
    async function categoryBoards(kindId) {
        const rows = await db.many(
            `SELECT t.task_class AS category, COUNT(*)::int AS games
             FROM bench_judgements j
             JOIN bench_rounds rd ON rd.id = j.round_id
             JOIN bench_tasks t ON t.id = rd.task_id
             JOIN bench_entries l ON l.id = j.pair->>'left' AND l.round_id = j.round_id
             JOIN bench_entries e ON e.id = j.pair->>'right' AND e.round_id = j.round_id
             WHERE j.kind_id = $1
               AND j.method IN ('human_pairwise', 'game_outcome', 'audience_poll')
               AND j.pair IS NOT NULL AND j.outcome IS NOT NULL AND j.outcome <> 'both_bad'
               AND t.task_class IS NOT NULL
               AND t.task_class NOT IN ('all', 'people', 'anon')
             GROUP BY t.task_class
             HAVING COUNT(*) >= $2
             ORDER BY COUNT(*) DESC, t.task_class`,
            [kindId, CATEGORY_MIN_GAMES],
        );
        const out = [];
        for (const row of rows) {
            // Use the same eligible votes as the fit: self-pairs and empty polls do not earn a board.
            const games = (await pairwiseGames(kindId, row.category)).length;
            if (games < CATEGORY_MIN_GAMES) continue;
            out.push({ category: row.category, games, rows: await boardElo(kindId, row.category) });
        }
        return out.sort((a, b) => b.games - a.games || a.category.localeCompare(b.category));
    }

    /**
     * The OpenVibe Index for a kind: the Bradley-Terry rating plus the model's median verified score on each public
     * benchmark of that kind, weighted 50/50 and split equally between the benchmarks. The weights are in the
     * answer; a model with fewer than two components gets null, never a number from one component.
     */
    async function kindIndex(kindId, eloRows) {
        const rows = await db.many(
            `SELECT b.id, b.title, r.model, r.score
             FROM bench_runs r
             JOIN bench_benchmarks b ON b.id = r.benchmark_id
             WHERE b.kind = $1 AND b.visibility = 'public' AND r.provenance = 'verified'
               AND r.score IS NOT NULL
             ORDER BY b.created_at, b.id, r.model, r.created_at, r.id`,
            [kindId],
        );
        const benchmarks = new Map();
        const scores = new Map();
        for (const row of rows) {
            if (!benchmarks.has(row.id)) benchmarks.set(row.id, { id: row.id, label: row.title });
            const key = `${row.id}\u0000${row.model}`;
            if (!scores.has(key)) scores.set(key, []);
            scores.get(key).push(num(row.score));
        }
        const benchmarkList = [...benchmarks.values()];
        const modelNames = new Set(eloRows.filter((row) => row.rank != null).map((row) => row.subject));
        for (const key of scores.keys()) modelNames.add(key.split('\u0000')[1]);
        const indexRows = [...modelNames].map((subject) => {
            const ratingRow = eloRows.find((row) => row.subject === subject);
            const present = benchmarkList
                .map((benchmark) => ({
                    id: benchmark.id,
                    label: benchmark.label,
                    runs: (scores.get(`${benchmark.id}\u0000${subject}`) || []).length,
                    score: statsLib.median(scores.get(`${benchmark.id}\u0000${subject}`) || []),
                }))
                .filter((benchmark) => benchmark.score != null);
            const value = statsLib.openvibeIndex({
                rating: ratingRow && ratingRow.rank != null ? ratingRow.elo : null,
                benchmarks: present,
                benchmarkCount: benchmarkList.length,
            });
            return { subject, ...value };
        });
        indexRows.sort((a, b) => {
            if (a.index == null && b.index == null) return a.subject.localeCompare(b.subject);
            if (a.index == null) return 1;
            if (b.index == null) return -1;
            return b.index - a.index || a.subject.localeCompare(b.subject);
        });
        return {
            kind_id: kindId,
            weights: { ...statsLib.INDEX_WEIGHTS },
            rating_anchor: statsLib.RATING_ANCHOR,
            benchmark_count: benchmarkList.length,
            benchmarks: benchmarkList.map((benchmark) => ({
                id: benchmark.id,
                label: benchmark.label,
                weight: benchmarkList.length ? Math.round((statsLib.INDEX_WEIGHTS.benchmarks / benchmarkList.length) * 1e6) / 1e6 : 0,
            })),
            rows: indexRows,
        };
    }

    /**
     * The holdout gap for a kind: per model, the mean score on public tasks minus the mean score on held-out tasks,
     * with the number of scored tasks on each side. Verified runs of public benchmarks only. A kind without
     * held-out tasks says `available: false`; a model missing one side gets a null gap.
     */
    async function kindHoldout(kindId) {
        const rows = await db.many(
            `SELECT b.id AS benchmark_id, r.model, t.task_id, t.score, t.held_out
             FROM bench_run_tasks t
             JOIN bench_runs r ON r.id = t.run_id
             JOIN bench_benchmarks b ON b.id = r.benchmark_id
             WHERE b.kind = $1 AND b.visibility = 'public' AND r.provenance = 'verified'
               AND t.score IS NOT NULL
             ORDER BY r.model, t.created_at, t.id`,
            [kindId],
        );
        const by = new Map();
        for (const row of rows) {
            if (!by.has(row.model)) by.set(row.model, { public: [], holdout: [] });
            const bucket = by.get(row.model);
            if (row.held_out) bucket.holdout.push(num(row.score));
            else bucket.public.push(num(row.score));
        }
        const out = [...by.entries()].map(([subject, bucket]) => ({ subject, ...statsLib.holdoutGap(bucket.public, bucket.holdout) }));
        out.sort((a, b) => (b.gap == null ? -Infinity : b.gap) - (a.gap == null ? -Infinity : a.gap) || a.subject.localeCompare(b.subject));
        const available = rows.some((row) => row.held_out);
        return {
            kind_id: kindId,
            available,
            held_out_tasks: new Set(rows.filter((row) => row.held_out).map((row) => `${row.benchmark_id}:${row.task_id}`)).size,
            rows: out,
        };
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

    /**
     * Which rating category a board reads: everyone ('all'), the signed-in people ('people') or the anonymous
     * voters ('anon'). The voters parameter wins over the older category parameter.
     */
    function categoryOf(voters, category) {
        const v = String(voters == null ? '' : voters).trim().toLowerCase();
        if (v === 'people' || v === 'person' || v === 'persons') return CATEGORY_PEOPLE;
        if (v === 'anon' || v === 'anonymous') return CATEGORY_ANON;
        const c = String(category == null ? '' : category).trim().toLowerCase();
        if (c === 'people' || c === 'person') return CATEGORY_PEOPLE;
        if (c === 'anon' || c === 'anonymous') return CATEGORY_ANON;
        // A task category (code, writing, chat, reasoning…) is its own board.
        return normalizeCategory(c) || CATEGORY_DEFAULT;
    }

    /** How many votes of each kind of voter a board holds. */
    async function voterCounts(kindId) {
        const rows = await db.many(
            `SELECT COALESCE(voter_kind, 'person') AS kind, COUNT(*)::int AS n
             FROM bench_judgements WHERE kind_id = $1 AND judge = 'human_pairwise'
             GROUP BY 1`,
            [kindId],
        );
        const out = { person: 0, anon: 0, service: 0, total: 0 };
        for (const row of rows) {
            const kind = String(row.kind || '');
            if (kind in out) out[kind] = num(row.n);
            out.total += num(row.n);
        }
        return out;
    }

    async function board(kindId, { type = null, category = CATEGORY_DEFAULT, period = 'all', voters = null } = {}) {
        const kind = await getKind(kindId);
        if (!kind || isPrivateKind(kind.id)) return null;
        const adultKind = Boolean(kind.schema && kind.schema.adult === true);
        const wanted = type || (adultKind ? 'willing' : 'elo');
        if (wanted === 'willing') {
            if (!adultKind) return null;
            const data = await willingReader.read();
            return {
                kind_id: kindId, category: CATEGORY_DEFAULT, period, type: 'willing', adult: true,
                prompt_set: data.prompt_set, prompts: data.prompts, measured_on: data.measured_on,
                rows: data.rows, abliteration: data.abliteration,
                unavailable: data.unavailable, error: data.error, note: data.note,
                voters: await voterCounts(kindId),
            };
        }
        if (adultKind) return null;
        const cat = categoryOf(voters, category);
        const cost = await costStats(kindId);
        const pass = await passRate(kindId);
        const eloRows = await boardElo(kindId, cat);

        let rows;
        if (wanted === 'elo') {
            rows = eloRows.map((r) => ({ ...r, median_cost_usd: num(cost.get(r.subject)?.median_cost), median_ms: num(cost.get(r.subject)?.median_ms) }));
        } else if (wanted === 'pareto') {
            const subjects = await subjectsFor(kindId);
            rows = subjects.map((subject) => {
                const e = eloRows.find((x) => x.subject === subject) || {};
                const p = pass.get(subject);
                const quality = p ? (num(p.trials) ? num(p.passed) / num(p.trials) : 0) : (num(e.win_rate) || 0);
                const medianCost = num(cost.get(subject)?.median_cost);
                return { subject, quality, win_rate: num(e.win_rate) || 0, pass_rate: p ? (num(p.trials) ? num(p.passed) / num(p.trials) : 0) : 0, cost: medianCost, median_cost_usd: medianCost, median_ms: num(cost.get(subject)?.median_ms), provisional: num(e.games) < 10 };
            });
            rows = ratingLib.pareto(rows, { x: 'quality', y: 'cost' });
        } else if (wanted === 'cost') {
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
        // The kind's own statistics travel with every board: the rating board also carries its per-category
        // boards, and every type carries the OpenVibe Index and the holdout gap. The Index always reads the
        // whole kind's rating, even when the rows are filtered to one kind of voter.
        const allEloRows = cat === CATEGORY_DEFAULT ? eloRows : await boardElo(kindId);
        const [voterKinds, categories, index, holdout] = await Promise.all([
            voterCounts(kindId),
            wanted === 'elo' ? categoryBoards(kindId) : Promise.resolve(undefined),
            kindIndex(kindId, allEloRows),
            kindHoldout(kindId),
        ]);
        const out = { kind_id: kindId, category: cat, period, type: wanted, adult: false, rows, voters: voterKinds, index, holdout };
        if (categories !== undefined) out.categories = categories;
        return out;
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

    // The public rating shared by model pages and other sites. It uses the same fit as the
    // board and dataset; bench_ratings remains a write-side counter, never this read's score.
    async function ratings(kindId, { category = CATEGORY_DEFAULT } = {}) {
        const kind = await getKind(kindId);
        if (!kind || isPrivateKind(kind.id) || kind.schema?.adult === true) return null;
        const cat = String(category || CATEGORY_DEFAULT);
        if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(cat)) throw new BenchError(422, 'bench.invalid_category', 'Use a task category of at most 80 characters.');
        return {
            schema: 'bench.ratings@1', kind_id: kindId, category: cat, type: 'elo', adult: false,
            minimum_samples: 20, source: 'OpenVibe.Bench judgements',
            methodology: 'Bradley-Terry fit of eligible pairwise games; one game has one vote. Ratings below twenty games are withheld.',
            rows: (await boardElo(kindId, cat)).filter((row) => row.games >= 20),
        };
    }

    async function modelSummary(model) {
        const name = String(model || '');
        const kinds = await db.many('SELECT DISTINCT r.kind_id FROM bench_entries e JOIN bench_rounds r ON r.id = e.round_id WHERE e.model = $1 ORDER BY r.kind_id', [name]);
        const modelRatings = [];
        for (const { kind_id: kindId } of kinds) {
            const result = await ratings(kindId);
            const rating = result?.rows.find((row) => row.subject === name);
            if (rating) modelRatings.push(rating);
        }
        const entries = (await db.many(
            `SELECT e.*, r.kind_id FROM bench_entries e JOIN bench_rounds r ON r.id = e.round_id WHERE e.model = $1 ORDER BY e.created_at DESC LIMIT 100`,
            [name],
        )).map((e) => ({ ...wireEntry(e), kind_id: e.kind_id }));
        const cost = num(await db.value('SELECT COALESCE(SUM(cost_usd), 0)::numeric AS n FROM bench_entries WHERE model = $1', [name]));
        return { model: name, ratings: modelRatings, ratings_minimum_samples: 20, entries, total_cost_usd: Math.round(cost * 1e6) / 1e6 };
    }

    // ── Dataset (open, no voter ids) ─────────────────────────
    async function dataset(kindId) {
        const kind = await getKind(kindId);
        if (!kind || isPrivateKind(kind.id)) return null;
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
        const allEloRows = await boardElo(kindId);
        const savedRatings = (await db.many('SELECT * FROM bench_ratings WHERE kind_id = $1 ORDER BY subject', [kindId])).map(wireRating);
        const fitted = new Map([[CATEGORY_DEFAULT, allEloRows]]);
        for (const category of new Set(savedRatings.map((rating) => rating.category))) {
            if (!fitted.has(category)) fitted.set(category, await boardElo(kindId, category));
        }
        // Export the same fit and intervals as the board, not the old incremental Elo beside a fitted rank.
        const ratings = [...fitted.values()].flat().filter((rating) => rating.games > 0).map((rating) => ({
            ...savedRatings.find((saved) => saved.subject === rating.subject && saved.category === rating.category),
            ...rating,
        }));
        const [categories, index, holdout] = await Promise.all([
            categoryBoards(kindId),
            kindIndex(kindId, allEloRows),
            kindHoldout(kindId),
        ]);
        // The open dataset carries the same four statistics the board API answers with: every rating's rank
        // interval, the per-category boards, the OpenVibe Index with its weights, and the holdout gap.
        return { kind_id: kindId, tasks, rounds, entries, judgements, ratings, categories, index, holdout };
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
        for (const c of d.categories) lines.push(JSON.stringify({ type: 'category', ...c }));
        lines.push(JSON.stringify({ type: 'index', ...d.index }));
        lines.push(JSON.stringify({ type: 'holdout', ...d.holdout }));
        return lines.length ? `${lines.join('\n')}\n` : '';
    }

    /**
     * live.clip by policy (selector@version), for its submitter: entries, abstentions, cost, and how its picks fared
     * in blind votes. accept_rate = (wins + ties) / votes it was in; a both_bad vote counts against both sides.
     */
    async function clipPolicies() {
        const entries = await db.many(`SELECT e.id, e.cost_usd, e.payload FROM bench_entries e JOIN bench_rounds r ON r.id = e.round_id
                                        WHERE r.kind_id = 'live.clip' AND e.error IS NULL`);
        const byEntry = new Map();
        const stats = new Map();
        for (const e of entries) {
            const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload || {});
            const key = `${(p.policy && p.policy.selector) || '?'}@${(p.policy && p.policy.version) || '?'}`;
            byEntry.set(e.id, key);
            const st = stats.get(key) || { policy: key, entries: 0, abstained: 0, cost_usd: 0, votes: 0, wins: 0, ties: 0, losses: 0, both_bad: 0 };
            st.entries += 1;
            if (p.abstained) st.abstained += 1;
            st.cost_usd += num(e.cost_usd);
            stats.set(key, st);
        }
        const votes = await db.many(`SELECT j.pair, j.outcome FROM bench_judgements j WHERE j.kind_id = 'live.clip' AND j.judge = 'human_pairwise' AND j.pair IS NOT NULL AND j.outcome IS NOT NULL`);
        for (const v of votes) {
            const pair = typeof v.pair === 'string' ? JSON.parse(v.pair) : v.pair;
            const sides = [['left', pair && pair.left], ['right', pair && pair.right]];
            for (const [side, id] of sides) {
                const st = stats.get(byEntry.get(id));
                if (!st) continue;
                st.votes += 1;
                if (v.outcome === 'tie') st.ties += 1;
                else if (v.outcome === 'both_bad') st.both_bad += 1;
                else if (v.outcome === side) st.wins += 1;
                else st.losses += 1;
            }
        }
        return [...stats.values()].map((st) => ({ ...st, cost_usd: Math.round(st.cost_usd * 1e6) / 1e6, accept_rate: st.votes ? Math.round(((st.wins + st.ties) / st.votes) * 1000) / 1000 : null }))
            .sort((a, b) => a.policy.localeCompare(b.policy));
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

    // ── Matches (bench.match@1, Contracts 0.422.0): every comparison on the network as one record ──
    /**
     * Record a match. A new id is inserted; an id the same service recorded before gains the judgements it did not
     * have (a Codes race is judged by its tests first and by the merge later). Another service's id is refused.
     */
    async function recordMatch(match, { recordedBy }) {
        const m = { ...match, id: match.id || `mat_${ids.ulid(s.now())}` };
        return s.tx(async () => {
            const prev = await db.maybe('SELECT * FROM bench_matches WHERE id = $1 FOR UPDATE', [m.id]);
            let body = m;
            let created = true;
            if (prev) {
                if (prev.recorded_by !== recordedBy) throw new BenchError(409, 'bench.match_taken', 'That match id was recorded by another service.');
                const old = prev.body || {};
                // jsonb keeps keys in its own order, so a judgement is known by its fields, not by its JSON text.
                const keyOf = (j) => [j.judge, j.winner || '', j.signal || '', JSON.stringify(Object.entries(j.scores || {}).sort()),
                    (j.by && j.by.type) || '', (j.by && j.by.id_hash) || '', String(j.at || '')].join('|');
                const seen = new Set((old.judgements || []).map(keyOf));
                body = { ...old, ...m, judgements: [...(old.judgements || []), ...(m.judgements || []).filter((j) => !seen.has(keyOf(j)))] };
                created = false;
                await db.exec('UPDATE bench_matches SET body = $2::jsonb, updated_at = $3::timestamptz WHERE id = $1', [m.id, JSON.stringify(body), s.iso()]);
            } else {
                await db.exec(
                    `INSERT INTO bench_matches (id, source, task_kind, category, prompt_hash, recorded_by, body, at, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9::timestamptz, $9::timestamptz)`,
                    [m.id, m.source, m.task.kind, m.task.category || null, m.task.prompt_hash || null, recordedBy, JSON.stringify(body), m.at, s.iso()],
                );
            }
            const judges = [...new Set((body.judgements || []).map((j) => j.judge))];
            const last = (body.judgements || []).slice(-1)[0];
            const winner = last && last.winner && /^[a-h]$/.test(last.winner) ? ((body.slots || []).find((x) => x.slot === last.winner) || {}).entrant || null : null;
            await insertOutbox('bench.match.recorded', {
                match_id: body.id, source: body.source, task_kind: body.task.kind, category: body.task.category || null,
                entrants: (body.slots || []).map((x) => x.entrant), judges, winner_entrant: winner, at: s.iso(),
            });
            return { match: body, created };
        });
    }

    /** The matches a board reads: one task kind, optionally one category, since a day. */
    async function matchesFor({ taskKind, category = null, since, limit = 50000 }) {
        const rows = await db.many(
            `SELECT body FROM bench_matches WHERE task_kind = $1 AND ($2::text IS NULL OR category = $2) AND at >= $3::timestamptz
             ORDER BY at DESC LIMIT $4`,
            [String(taskKind), category, since, Math.max(1, Math.min(200000, Number(limit) || 50000))],
        );
        return rows.map((r) => r.body);
    }

    return {
        wireKind, wireTask, wireRound, wireEntry, wireJudgement, wireRating, wireEval, wireEvalRun,
        insertOutbox, seedKinds, listKinds, getKind,
        createTask, getTask,
        createRound, createArenaRound, getRound, addEntry, maybeReady, finishRound, clipPolicies,
        nextJudgement, castJudgement, pairwiseGames, recordMatch, matchesFor,
        board, ratings, valueRows, modelSummary, dataset, datasetJsonl,
        createEval, getEval, runEval, evalResults, evalDailyCount,
        KINDS, JUDGES, WINNERS, BASE_ELO, CATEGORY_DEFAULT, shuffle,
    };
}

module.exports = {
    createStore, BenchError, KINDS, JUDGES, WINNERS, BASE_ELO, CATEGORY_DEFAULT, shuffle,
    CATEGORY_PEOPLE, CATEGORY_ANON, kindOfVoter, categoriesOf,
};

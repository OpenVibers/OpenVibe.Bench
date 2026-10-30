'use strict';

/**
 * Model watch (spec 6): follow a benchmark, or a model on a benchmark, and hear when it moves.
 *
 * Two things are worth a notice:
 *   - a model's style-controlled score moves by more than its own interval (the board of B9), and
 *   - a model overtakes another one on that benchmark: its band sits fully above the other's.
 *
 * The check runs where the ratings are refitted, so the board it reads is the board the person would see. One
 * notice per watch per day at most, and the text names the benchmark, the two models and the numbers.
 *
 * The notice itself is a Network notification (network.notification-push-request@1): it lands in the Action Center,
 * and email or chat follow the person's own Network settings. Bench never sends email.
 */

const { ids } = require('openvibe-contracts');

const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
const round = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);
const dayOf = (v) => (v == null ? null : new Date(v).toISOString().slice(0, 10));

/** The notification client: Bench's own service token, pushed at the Network. */
function notifier(ctx) {
    if (ctx.benchNotifier) return ctx.benchNotifier;
    const { createClient } = require('openvibe-sdk/core');
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    const { createNotificationsClient } = require('openvibe-sdk/notifications');
    const network = ctx.config.networkInternalUrl;
    const tokens = createServiceTokenClient({
        tokenUrl: network + '/oauth/token',
        clientId: ctx.config.oauth && ctx.config.oauth.clientId,
        clientSecret: ctx.config.oauth && ctx.config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'network.notifications.push',
        fetch: ctx.fetchImpl || globalThis.fetch,
    });
    const client = createClient({
        tokenProvider: tokens,
        baseUrls: { network },
        fetch: ctx.fetchImpl || globalThis.fetch,
        timeoutMs: 8000,
    });
    ctx.benchNotifier = createNotificationsClient(client, { baseUrl: network });
    return ctx.benchNotifier;
}

/** The UTC day a timestamp falls in. */
function today(now) {
    return new Date(now || Date.now()).toISOString().slice(0, 10);
}

/** True when the watch may get a notice: one notice per watch per day. */
function mayNotify(watch, stamp) {
    return dayOf(watch && watch.last_notified_at) !== today(stamp);
}

function createWatches(ctx) {
    const db = ctx.s.db;

    /** The watches of one person, with the benchmark they are on. */
    async function listFor(subject) {
        return db.many(
            `SELECT w.id, w.subject, w.benchmark_id, w.model, w.user_id, w.created_at, w.last_notified_at,
                    b.title AS benchmark_title, b.kind AS benchmark_kind, b.latest_version
               FROM bench_watches w JOIN bench_benchmarks b ON b.id = w.benchmark_id
              WHERE w.subject = $1 ORDER BY w.created_at DESC`,
            [String(subject || '')]);
    }

    /** Follow a benchmark, or a model on a benchmark. Following twice changes nothing. */
    async function follow({ subject, benchmarkId, model = null, userId = null }) {
        const benchmark = await ctx.registry.getBenchmark(String(benchmarkId || ''));
        if (!benchmark) return { ok: false, status: 404, error: 'No such benchmark.' };
        const row = await db.maybe(
            `INSERT INTO bench_watches (id, subject, benchmark_id, model, user_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
             ON CONFLICT (subject, benchmark_id, COALESCE(model, ''))
             DO UPDATE SET user_id = COALESCE(EXCLUDED.user_id, bench_watches.user_id)
             RETURNING *`,
            [ids.newId('watch'), String(subject), benchmark.id, model ? String(model) : null,
                userId == null ? null : Number(userId), ctx.s.iso()]);
        return { ok: true, watch: row };
    }

    /** Stop watching. */
    async function unfollow({ subject, id }) {
        const row = await db.maybe('DELETE FROM bench_watches WHERE id = $1 AND subject = $2 RETURNING id',
            [String(id || ''), String(subject || '')]);
        return { ok: Boolean(row) };
    }

    /** The style-controlled fit of a kind. */
    async function fitOf(kindId) {
        const board = await require('../rating/board').boardForKind(ctx, kindId);
        return board.fit;
    }

    /** The board as it was last seen, so a move can be measured against it. */
    async function previous(kindId) {
        const rows = await db.many('SELECT * FROM bench_watch_ratings WHERE kind_id = $1', [String(kindId)]);
        return new Map(rows.map((r) => [r.model, r]));
    }

    /** Remember the board we have just seen. */
    async function remember(kindId, models) {
        if (!models.length) return;
        const values = [];
        const params = [];
        for (const m of models) {
            values.push('($1, $' + (params.length + 2) + ', $' + (params.length + 3) + ', $' + (params.length + 4)
                + ', $' + (params.length + 5) + ', $' + (params.length + 6) + ', now())');
            params.push(m.model, m.rating, m.lower, m.upper, m.band);
        }
        await db.exec(
            `INSERT INTO bench_watch_ratings (kind_id, model, rating, ci_lower, ci_upper, band, updated_at)
             VALUES ${values.join(', ')}
             ON CONFLICT (kind_id, model) DO UPDATE SET rating = EXCLUDED.rating, ci_lower = EXCLUDED.ci_lower,
                ci_upper = EXCLUDED.ci_upper, band = EXCLUDED.band, updated_at = now()`,
            [String(kindId), ...params]);
    }

    /** The notice a watch gets from the board, or null. */
    function noticeFor(watch, models, bands, before, all) {
        const byModel = new Map(models.map((m) => [m.model, m]));
        const followed = watch.model ? byModel.get(watch.model) : null;
        const title = watch.benchmark_title || watch.benchmark_id;

        if (watch.model) {
            if (!followed) return null;
            const was = before.get(watch.model);
            if (was && was.rating != null && followed.rating != null) {
                const delta = followed.rating - num(was.rating);
                const interval = followed.upper - followed.lower;
                if (Math.abs(delta) > interval) {
                    return {
                        kind: 'move',
                        title: 'Bench: ' + title,
                        message: title + ': ' + watch.model + ' moved from ' + round(num(was.rating)) + ' to '
                            + round(followed.rating) + ' (' + (delta > 0 ? '+' : '') + round(delta) + '), more than its '
                            + round(interval) + '-point interval (' + round(followed.lower) + '–' + round(followed.upper) + ').',
                        models: [watch.model],
                    };
                }
            }
            const over = models.find((m) => m.model !== watch.model && m.lower > followed.upper
                && !all.some((w) => w.subject === watch.subject && w.benchmark_id === watch.benchmark_id && w.model === m.model));
            if (over) {
                return {
                    kind: 'overtake',
                    title: 'Bench: ' + title,
                    message: title + ': ' + over.model + ' (' + round(over.rating) + ', ' + round(over.lower) + '–'
                        + round(over.upper) + ') is now fully above ' + watch.model + ' (' + round(followed.rating) + ', '
                        + round(followed.lower) + '–' + round(followed.upper) + ').',
                    models: [over.model, watch.model],
                };
            }
            return null;
        }

        // A benchmark watch: any model that moved by more than its interval, and any model that overtook another.
        for (const m of models) {
            const was = before.get(m.model);
            if (!was || was.rating == null || m.rating == null) continue;
            const delta = m.rating - num(was.rating);
            const interval = m.upper - m.lower;
            if (Math.abs(delta) > interval) {
                return {
                    kind: 'move',
                    title: 'Bench: ' + title,
                    message: title + ': ' + m.model + ' moved from ' + round(num(was.rating)) + ' to ' + round(m.rating)
                        + ' (' + (delta > 0 ? '+' : '') + round(delta) + '), more than its ' + round(interval)
                        + '-point interval (' + round(m.lower) + '–' + round(m.upper) + ').',
                    models: [m.model],
                };
            }
        }
        const over = models.find((m) => models.some((o) => o.model !== m.model && m.lower > o.upper));
        if (over) {
            const under = models.find((o) => o.model !== over.model && over.lower > o.upper);
            return {
                kind: 'overtake',
                title: 'Bench: ' + title,
                message: title + ': ' + over.model + ' (' + round(over.rating) + ', ' + round(over.lower) + '–'
                    + round(over.upper) + ') is now fully above ' + (under ? under.model : 'the model below it') + '.',
                models: [over.model, under ? under.model : null].filter(Boolean),
            };
        }
        return null;
    }

    /** Push the notice to the Network. The Network decides whether it reaches email or chat. */
    async function notify(watch, notice) {
        if (watch.user_id == null) return { sent: false, reason: 'no_network_user' };
        try {
            const out = await notifier(ctx).push({
                userId: Number(watch.user_id),
                type: 'WATCH_TRIGGERED',
                title: notice.title,
                message: notice.message,
                url: (ctx.config.baseUrl || 'https://bench.openvibe.services') + '/benchmarks/' + watch.benchmark_id,
                category: 'service',
                priority: 'normal',
                service: 'bench',
            });
            return { sent: Boolean(out && out.sent), skipped: Boolean(out && out.skipped) };
        } catch (err) {
            ctx.log.warn('[OpenVibe.Bench] watch notice failed: ' + (err && err.message ? err.message : err));
            return { sent: false, reason: 'push_failed' };
        }
    }

    /**
     * Look at the board of a kind and tell the watchers what changed. Runs where the ratings are refitted.
     */
    async function check(kindId, { now = null } = {}) {
        const kind = String(kindId || '');
        if (!kind) return { notices: [], checked: 0 };
        const watches = await db.many(
            `SELECT w.*, b.title AS benchmark_title, b.kind AS benchmark_kind
               FROM bench_watches w JOIN bench_benchmarks b ON b.id = w.benchmark_id
              WHERE b.kind = $1`,
            [kind]);
        if (!watches.length) return { notices: [], checked: 0 };

        const fit = await fitOf(kind);
        const bands = new Map();
        for (const b of ((fit.bands && fit.bands.controlled) || [])) for (const m of b.models || []) bands.set(m, b.label);
        const models = (fit.models || []).map((m) => ({
            model: m.model,
            rating: num(m.controlled.rating),
            lower: num(m.controlled.ci_lower),
            upper: num(m.controlled.ci_upper),
            band: bands.get(m.model) || null,
            votes: m.votes,
        }));
        const before = await previous(kind);
        await remember(kind, models);

        const notices = [];
        const stamp = now || new Date().toISOString();
        for (const w of watches) {
            const notice = noticeFor(w, models, bands, before, watches);
            if (!notice) continue;
            if (!mayNotify(w, stamp)) continue;   // one notice per watch per day
            const sent = await notify(w, notice);
            await db.exec('UPDATE bench_watches SET last_notified_at = $1 WHERE id = $2', [stamp, w.id]);
            notices.push({ watch: w.id, kind: notice.kind, message: notice.message, sent });
        }
        return { notices, checked: watches.length };
    }

    /** The event Bench already publishes when the ratings change, so a watch rides on it. */
    async function publishRatingChanged(kindId, subjects) {
        const row = await ctx.bench.insertOutbox('bench.rating.changed', {
            kind_id: String(kindId || ''),
            subjects: (subjects || []).map(String),
            at: new Date().toISOString(),
        });
        return row;
    }

    return { listFor, follow, unfollow, check, notify, publishRatingChanged, noticeFor, notifier };
}

module.exports = { createWatches, notifier, today, dayOf, mayNotify };

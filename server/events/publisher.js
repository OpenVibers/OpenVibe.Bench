'use strict';

/**
 * The transactional outbox → OpenVibe.Events. A row is written in the same transaction as the change it announces,
 * so a retry never makes a second event. A claim lease keeps two processes from sending the same row at once.
 * Topics: bench.round.finished, bench.judgement.recorded, bench.rating.changed.
 */
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

const MAX_ATTEMPTS_BACKOFF_MS = 5 * 60_000;

function createPublisher({ config, s, fetchImpl = globalThis.fetch, log = console, intervalMs = config.events.intervalMs }) {
    const db = s.db;
    const worker = `bench-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const configured = Boolean(config.events.url && config.oauth.clientSecret);
    const scopes = [...new Set([config.events.scope || 'events.event.publish'])];
    const clients = configured ? scopes.map((scope) => serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.events',
        scope,
        fetchImpl,
    })) : [];
    let preferred = 0;
    async function authHeaders() {
        for (let i = preferred; i < clients.length; i++) {
            try {
                const headers = await clients[i].authHeaders();
                preferred = i;
                return headers;
            } catch (err) {
                if (i === clients.length - 1) throw err;
            }
        }
        throw new Error('no Events token client is configured');
    }
    let timer = null;
    let running = false;
    const stats = { published: 0, failed: 0, last_error: null };

    function backoffMs(attempts) {
        return Math.min(MAX_ATTEMPTS_BACKOFF_MS, 5000 * Math.pow(2, Math.max(0, Math.min(6, attempts))));
    }

    async function claim(limit = 20) {
        const now = new Date(s.now()).toISOString();
        const stale = new Date(s.now() - 2 * 60_000).toISOString();
        return await db.many(
            `UPDATE bench_outbox o SET claimed_at = $1::timestamptz, claimed_by = $2
             WHERE o.event_id IN (
               SELECT o2.event_id FROM bench_outbox o2
               WHERE o2.published_at IS NULL AND o2.next_attempt_at <= $1::timestamptz
                 AND (o2.claimed_at IS NULL OR o2.claimed_at < $3::timestamptz)
               ORDER BY o2.created_at ASC, o2.event_id ASC
               LIMIT $4
               FOR UPDATE SKIP LOCKED
             )
             RETURNING o.*`,
            [now, worker, stale, Math.min(100, Math.max(1, limit))],
        );
    }

    function envelope(row) {
        const subjectId = row.payload && (row.payload.subject || row.payload.owner);
        return {
            event_id: row.event_id,
            event_type: row.topic,
            version: 1,
            source: 'bench',
            actor: { type: 'service', id: 'bench' },
            subject: subjectId && String(subjectId).startsWith('usr_') ? { type: 'user', id: subjectId } : { type: 'service', id: 'bench' },
            timestamp: new Date(s.now()).toISOString(),
            priority: 'important',
            visibility: 'internal',
            payload: row.payload,
        };
    }

    async function send(row) {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(await authHeaders()) };
        const res = await fetchImpl(`${config.events.url.replace(/\/+$/, '')}/api/v1/events`, {
            method: 'POST',
            headers,
            body: JSON.stringify(envelope(row)),
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`events ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
        }
        await db.exec('UPDATE bench_outbox SET published_at = $1::timestamptz, claimed_at = NULL, claimed_by = NULL, last_error = NULL WHERE event_id = $2',
            [new Date(s.now()).toISOString(), row.event_id]);
        return { ok: true };
    }

    async function runOnce({ limit = 20 } = {}) {
        if (!configured) return { configured: false, claimed: 0, published: 0, failed: 0 };
        if (running) return { configured: true, busy: true, claimed: 0, published: 0, failed: 0 };
        running = true;
        let claimed = 0;
        let published = 0;
        let failed = 0;
        try {
            const rows = await claim(limit);
            claimed = rows.length;
            for (const row of rows) {
                try {
                    await send(row);
                    published++;
                    stats.published++;
                } catch (err) {
                    failed++;
                    stats.failed++;
                    const message = String((err && err.message) || err).slice(0, 500);
                    stats.last_error = message;
                    const attempts = Number(row.attempts) + 1;
                    const next = new Date(s.now() + backoffMs(attempts)).toISOString();
                    await db.exec(
                        `UPDATE bench_outbox SET attempts = attempts + 1, last_error = $1, claimed_at = NULL, claimed_by = NULL, next_attempt_at = $2::timestamptz WHERE event_id = $3`,
                        [message, next, row.event_id],
                    );
                    log.warn(`[OpenVibe.Bench] outbox ${row.event_id} publish failed (attempt ${attempts}): ${message}`);
                }
            }
            return { configured: true, claimed, published, failed };
        } finally {
            running = false;
        }
    }

    function start() {
        if (!configured || timer || config.drill) return false;
        timer = setInterval(() => { runOnce().catch((err) => log.warn('[OpenVibe.Bench] outbox tick failed:', err.message)); }, intervalMs);
        if (timer.unref) timer.unref();
        return true;
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        return Promise.resolve();
    }

    async function pending() {
        return Number(await db.value('SELECT COUNT(*)::int AS n FROM bench_outbox WHERE published_at IS NULL')) || 0;
    }

    return { configured, runOnce, start, stop, pending, stats: () => ({ ...stats }) };
}

module.exports = { createPublisher, MAX_ATTEMPTS_BACKOFF_MS };

'use strict';

/**
 * Sharing for Bench benchmarks (design 2026-11-06, VISIBILITY-EVERYWHERE step 4; openvibe-sdk/share).
 *
 * The SDK owns the model and the rules: the `shares` row next to each benchmark, the one access check
 * (canView), members, access requests, transfers, the append-only log and the delivery queue. This
 * file is the wiring a service supplies:
 *
 *   - network.json       Network's identity lookups (@name → subject, and a person's card for the sheet)
 *   - events.publish     Bench's Events publisher, so share.* envelopes go out with every other bench.* event
 *   - notify             Network's notification push; a refusal is logged, never allowed to stall the queue
 *   - onAudienceChange   keeps bench_benchmarks.visibility in step (public→public, link→unlisted, people/private→private), so
 *                        the registry, the sitemap and Search drop it at once
 *   - onOwnerChange      moves bench_benchmarks.owner and created_by to the new owner
 *
 * A private benchmark is registered Only me. The sheet on it can name people ("look at this before
 * I share it"); a public one is Everyone, an unlisted one is Anyone with the link. The row's own
 * visibility is what every access check reads (bench/registry.js canViewBenchmark).
 */
const { createShares } = require('openvibe-sdk/share');
const { serviceAuth } = require('openvibe-contracts');

const SERVICE = 'bench';
const KIND = 'benchmark';
const AUDIENCES = ['public', 'link', 'people', 'private'];
/** Bench's visibility words to the SDK's, and back. */
const TO_SDK = { public: 'public', link: 'link', unlisted: 'link', people: 'people', private: 'private' };
const FROM_SDK = { public: 'public', link: 'unlisted', people: 'private', private: 'private' };

const refOf = (id) => ({ service: SERVICE, kind: KIND, id: String(id) });

/** Blog's viewer as the SDK wants it: a subject object, and the staff bit. */
function shareViewer(v) {
    if (!v || !v.subject) return null;
    if (String(v.subject).startsWith('usr_')) return { subject: { type: 'user', id: v.subject }, staff: !!v.staff };
    if (String(v.subject).startsWith('gst_')) return { subject: { type: 'guest', id: v.subject }, staff: !!v.staff };
    return null;
}

function createSharing({ db, config, now = Date.now, fetchImpl = globalThis.fetch, log = console } = {}) {
    // Bench has no generic outbox for arbitrary envelopes: share.* events go to Events with their own token.
    const eventsToken = config.events && config.events.url && config.oauth && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${String(config.networkInternalUrl || config.networkUrl).replace(/\/+$/, '')}/oauth/token`,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, audience: 'openvibe.events', scope: 'events.event.publish', fetchImpl,
    }) : null;
    async function publish(envelope) {
        if (!eventsToken) return;
        const res = await fetchImpl(config.events.url, { method: 'POST', headers: { ...(await eventsToken.authHeaders()), 'Content-Type': 'application/json' },
            body: JSON.stringify(envelope), signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`Events answered ${res.status}`);
    }
    const base = String(config.networkInternalUrl || config.networkUrl || '').replace(/\/+$/, '');
    const tokens = config.oauth && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'identity.subject.resolve network.notifications.push',
        fetchImpl,
    }) : null;

    async function networkJson({ path, method = 'GET', json, query } = {}) {
        if (!tokens) throw new Error('Network is not configured for this service');
        const url = new URL(`${base}${path}`);
        for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
        const headers = { Accept: 'application/json', ...(await tokens.authHeaders()) };
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error(`Network ${method} ${path} ${res.status}: ${(body && (body.detail || body.error)) || 'failed'}`);
            err.status = res.status;
            throw err;
        }
        return body;
    }

    /** One notification, addressed by canonical subject. It never carries a post's title or text. */
    async function notify(n) {
        const to = n && n.to;
        if (!to || to.type !== 'user') return;
        const words = {
            'share.added': ['A benchmark was shared with you', 'Open it on OpenVibe.Bench.'],
            'share.access_requested': ['Someone asked for access to your benchmark', 'Review the request on OpenVibe.Bench.'],
            'share.transfer.requested': ['Someone wants to give you a benchmark', 'Accept or decline it on OpenVibe.Bench.'],
            'share.transfer.answered': ['A benchmark transfer was answered', 'See what happened on OpenVibe.Bench.'],
        }[n.kind] || ['Sharing on OpenVibe.Bench', 'There is something new for you.'];
        try {
            await networkJson({
                path: '/internal/notifications/push', method: 'POST',
                json: {
                    subject: to.id, type: 'GENERIC', title: words[0], message: words[1],
                    service: 'bench', url: n.ref && n.ref.id ? `${config.baseUrl}/benchmarks/${encodeURIComponent(n.ref.id)}` : config.baseUrl,
                    category: 'social',
                },
            });
        } catch (err) {
            log.warn('[Sharing] notification not sent:', err.message);
        }
    }

    /** The row's audience change keeps the registry column (and every read that filters on it) in step. */
    async function onAudienceChange(ref, audience, tx) {
        if (ref.service !== SERVICE || ref.kind !== KIND) return;
        const row = await tx.maybe('SELECT visibility FROM bench_benchmarks WHERE id = $1', [ref.id]);
        if (!row) return;
        await tx.exec('UPDATE bench_benchmarks SET visibility = $1, updated_at = now() WHERE id = $2', [FROM_SDK[audience] || 'private', ref.id]);
    }

    async function onOwnerChange(ref, from, to, tx) {
        if (ref.service !== SERVICE || ref.kind !== KIND) return;
        const owner = to && to.type === 'user' ? to.id : null;
        await tx.exec('UPDATE bench_benchmarks SET owner = $1, created_by = $1, updated_at = now() WHERE id = $2', [owner, ref.id]);
    }

    const shares = createShares({
        db,
        network: { json: networkJson },
        events: { publish },
        notify,
        onAudienceChange,
        onOwnerChange,
    });

    const sv = (viewer) => shareViewer(viewer);
    const at = (id) => refOf(id);

    async function defaultAudience(owner) {
        const row = await db.maybe('SELECT audience FROM bench_share_defaults WHERE owner_subject = $1', [owner]);
        return row ? row.audience : 'private';
    }
    async function setDefaultAudience(owner, audience) {
        if (!AUDIENCES.includes(audience)) throw new Error('Invalid benchmark default');
        await db.exec(`INSERT INTO bench_share_defaults (owner_subject, audience) VALUES ($1, $2)
            ON CONFLICT (owner_subject) DO UPDATE SET audience = excluded.audience, updated_at = now()`, [owner, audience]);
    }
    async function applyDefault(owner, audience) {
        if (!AUDIENCES.includes(audience)) throw new Error('Invalid benchmark default');
        const rows = await db.many('SELECT id FROM bench_benchmarks WHERE owner = $1', [owner]);
        let changed = 0;
        for (const row of rows) {
            const current = await db.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, KIND, row.id]);
            if (!current) {
                await shares.register(at(row.id), { owner_subject: { type: 'user', id: owner }, audience });
                await onAudienceChange(at(row.id), audience, db);
                changed++;
            } else if (current.audience !== audience) {
                await shares.setAudience(sv({ subject: owner }), at(row.id), audience);
                changed++;
            }
        }
        return changed;
    }

    return {
        shares,
        SERVICE,
        KIND,
        AUDIENCES,
        refOf,
        shareViewer,
        defaultAudience, setDefaultAudience, applyDefault,
        /** Register a post with the sharing system (inside the post's own transaction). */
        register: async (viewer, id, audience = 'private') => await shares.register(at(id), {
            owner_subject: viewer && viewer.subject ? { type: String(viewer.subject).startsWith('gst_') ? 'guest' : 'user', id: viewer.subject } : { type: 'service', id: SERVICE },
            audience: TO_SDK[audience] || 'private',
        }),
        /**
         * The service's own audience move (a create form, the editor's select, a publish). The caller
         * has already passed access.canWrite and owns the column and the Search sync; this only keeps
         * the share row in step. The SDK's owner check is for people using the sheet.
         */
        syncAudience: async (id, audience) => {
            const next = TO_SDK[audience] || 'private';
            await db.tx(async (t) => {
                const row = await t.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3 FOR UPDATE', [SERVICE, KIND, String(id)]);
                if (!row || row.audience === next) return;
                await t.exec('UPDATE shares SET audience = $1, revision = revision + 1 WHERE service = $2 AND kind = $3 AND resource_id = $4', [next, SERVICE, KIND, String(id)]);
            });
        },
        /** A claimed guest draft's share row moves to the person who claimed it (never through the sheet). */
        adopt: async (id, viewer) => await db.exec(`UPDATE shares SET owner_subject = $1::jsonb WHERE service = $2 AND kind = $3 AND resource_id = $4`,
            [JSON.stringify({ type: String(viewer.subject).startsWith('gst_') ? 'guest' : 'user', id: viewer.subject }), SERVICE, KIND, String(id)]),
        shareOf: async (id) => await db.maybe('SELECT * FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, KIND, String(id)]),
        // Bench's own rule survives: an unlisted benchmark with a share token opens only through that token,
        // never by its id, whatever the sheet says. The owner is decided before this (bench/registry.js).
        canView: async (viewer, id) => {
            const row = await db.maybe('SELECT visibility, share_token_hash FROM bench_benchmarks WHERE id = $1', [String(id)]);
            if (row && row.visibility === 'unlisted' && row.share_token_hash) return false;
            return await shares.canView(sv(viewer), at(id));
        },
        canEdit: async (viewer, id) => await shares.canEdit(sv(viewer), at(id)),
        get: async (viewer, id) => await shares.get(sv(viewer), at(id)),
        getWithRevision: async (viewer, id) => await shares.getWithRevision(sv(viewer), at(id)),
        setAudience: async (viewer, id, audience) => await shares.setAudience(sv(viewer), at(id), TO_SDK[audience] || 'private'),
        addMembers: async (viewer, id, list) => await shares.addMembers(sv(viewer), at(id), list),
        removeMember: async (viewer, id, subject) => await shares.removeMember(sv(viewer), at(id), subject),
        update: async (viewer, id, body, opts) => await shares.update(sv(viewer), at(id), body, opts),
        requestAccess: async (viewer, id) => await shares.requestAccess(sv(viewer), at(id)),
        dismiss: async (viewer, id, requestId) => await shares.dismiss(sv(viewer), at(id), requestId),
        transfer: async (viewer, id, input) => await shares.transfer(sv(viewer), at(id), input),
        accept: async (viewer, id, transferId) => await shares.accept(sv(viewer), at(id), transferId),
        decline: async (viewer, id, transferId) => await shares.decline(sv(viewer), at(id), transferId),
        cancel: async (viewer, id, transferId) => await shares.cancel(sv(viewer), at(id), transferId),
        lookup: async (viewer, name) => await shares.lookup(sv(viewer), name),
        sharedWithMe: async (viewer, opts) => await shares.sharedWithMe(sv(viewer), { service: SERVICE, ...(opts || {}) }),
        /** Expire members and transfers, then send queued events and notifications. */
        work: async ({ flush = true } = {}) => {
            let expired = 0;
            try { expired = await shares.expireMembers(); } catch (err) { log.warn('[Sharing] expiry sweep:', err.message); }
            let sent = 0;
            if (flush) { try { sent = await shares.flush(); } catch (err) { log.warn('[Sharing] deliveries:', err.message); } }
            return { expired, sent };
        },
    };
}

/** The uniform API's describe(ref): the sheet shows the post's title and link to its owner. */
function describeRef(db, config) {
    return async (ref) => {
        if (ref.service !== SERVICE || ref.kind !== KIND) return {};
        const benchmark = await db.maybe('SELECT id, title, visibility FROM bench_benchmarks WHERE id = $1', [ref.id]);
        if (!benchmark) return {};
        return {
            title: benchmark.title || 'Untitled benchmark',
            link: `${String(config.baseUrl || '').replace(/\/+$/, '')}/benchmarks/${encodeURIComponent(benchmark.id)}`,
            roles: ['viewer'],
            audiences: AUDIENCES,
            transferable: true,
        };
    };
}

module.exports = { createSharing, describeRef, shareViewer, refOf, AUDIENCES, TO_SDK, FROM_SDK, SERVICE, KIND };

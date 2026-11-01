'use strict';

/**
 * Anonymous voting (plan L51, step 1): a person who has not signed in may still judge a pairwise round.
 *
 * There are two ways in, and both end at the same place:
 *
 *   1. Bench's own vote page. The visitor gets a random opaque id in a signed, httpOnly cookie. The id says
 *      nothing about the person, and the cookie is signed with a server secret so a client cannot mint a new
 *      voter id at will. Bench never stores the address: the per-address cap counts a salted hash of it, and
 *      the salt is derived from the day, so yesterday's hash says nothing about today's.
 *   2. A first-party service (OpenVibe.Design) that relays the vote. It sends its service token and the
 *      header X-OV-Voter: anon:<opaque id it derived from its own cookie>. Only a service on the allow-list
 *      (BENCH_ANON_RELAY_SERVICES, 'design' by default) may relay, and the relay's own daily total is capped.
 *
 * What is stored is never the opaque id: the judgement carries voter_kind 'anon' and the hash of the id, in
 * the same subject column a person's id would use. One vote per voter per round falls out of that for free.
 *
 * Every cap answers the same way: 429 bench.limit_anon, "Sign in to keep voting today".
 */

const crypto = require('crypto');
const { BenchError } = require('../store');

const HEADER = 'x-ov-voter';
const HEADER_PREFIX = 'anon:';
const RELAY_CAP = 'bench.judgement.cast';
const LIMIT_DETAIL = 'Sign in to keep voting today';
const SUBJECT_PREFIX = 'anon_';
const KEEP_DAYS = 7;

const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (secret, msg) => crypto.createHmac('sha256', secret).update(String(msg), 'utf8').digest();
const sha256hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

function createAnon({ s, config, log = console }) {
    const db = s.db;
    const cfg = () => (config && config.bench && config.bench.anon) || {};
    let secretCache = null;

    /** The secret the cookie is signed with and the voter id is hashed with. */
    function secret() {
        if (secretCache) return secretCache;
        const c = cfg();
        const own = String(c.secret || '').trim();
        const oauth = String((config && config.oauth && config.oauth.clientSecret) || '').trim();
        secretCache = own || oauth || crypto.randomBytes(32).toString('hex');
        if (!own && !oauth && log && typeof log.warn === 'function') {
            log.warn('[OpenVibe.Bench] neither BENCH_ANON_SECRET nor an OAuth client secret is set: the anonymous voter cookie is signed with a per-process secret, so a restart resets the anonymous caps.');
        }
        return secretCache;
    }

    const cookieName = () => String(cfg().cookieName || 'bench_anon');
    const enabled = () => cfg().enabled !== false;

    /** The UTC day, 'YYYY-MM-DD'. */
    function dayOf(now) {
        return new Date(now == null ? s.now() : now).toISOString().slice(0, 10);
    }

    /** A new opaque voter id: random bytes, nothing about the person. */
    function newOpaqueId() {
        return b64u(crypto.randomBytes(18));
    }

    /** The cookie value: the id and its signature. */
    function cookieValue(opaque) {
        return `${opaque}.${hmac(secret(), 'cookie|' + opaque).toString('base64url')}`;
    }

    /** The id inside a signed cookie, or null when the cookie is not ours or is broken. */
    function opaqueFromCookie(raw) {
        const value = String(raw || '');
        const dot = value.indexOf('.');
        if (dot < 1) return null;
        const id = value.slice(0, dot);
        const sig = value.slice(dot + 1);
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
        const want = hmac(secret(), 'cookie|' + id).toString('base64url');
        const a = Buffer.from(String(sig));
        const b = Buffer.from(want);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
        return id;
    }

    /** The hash of the opaque id: what the database holds, never the id itself. */
    function voterHash(scope, opaque) {
        return SUBJECT_PREFIX + hmac(secret(), `${scope}|${opaque}`).toString('hex');
    }

    /** The address hash: salted per day, so the rows of two days cannot be linked. */
    function ipHash(ip, day) {
        const salt = hmac(secret(), 'ip-salt|' + day).toString('hex');
        return sha256hex(`bench-anon-ip|${day}|${salt}|${ip}`);
    }

    /** The address of the request, as the proxy chain reports it. */
    function ipOf(req) {
        const ip = String((req && req.ip) || (req && req.socket && req.socket.remoteAddress) || '').trim();
        return ip || null;
    }

    /** The name of a service principal: 'service:design' is 'design'. */
    function serviceName(requester) {
        const r = String(requester || '').trim().toLowerCase();
        return r.startsWith('service:') ? r.slice('service:'.length) : r;
    }

    /** Whether a service may relay an anonymous voter. */
    function relayAllowed(service) {
        const list = cfg().relayServices || [];
        const name = serviceName(service);
        return list.includes(name) || list.includes('service:' + name);
    }

    /**
     * Who the anonymous voter is, if the request names one:
     *   - a relaying service and its X-OV-Voter header;
     *   - the signed cookie Bench set earlier;
     *   - a fresh cookie, when the caller is nobody in particular (mint).
     * Returns null when the request carries no anonymous voter and none should be made.
     */
    function resolve(req, principal, { mint = true } = {}) {
        const p = principal || { kind: 'anonymous' };
        const header = String((req && req.headers && req.headers[HEADER]) || '').trim();
        if (header) {
            if (p.kind !== 'app') throw new BenchError(403, 'bench.relay_not_allowed', 'Only a first-party service may relay an anonymous voter.');
            const service = serviceName(p.requester);
            if (!relayAllowed(service)) throw new BenchError(403, 'bench.relay_not_allowed', 'This service may not relay anonymous votes.');
            if (typeof p.hasCapability === 'function' && !p.hasCapability(RELAY_CAP)) {
                throw new BenchError(403, 'bench.capability_denied', `A service token needs ${RELAY_CAP}.`);
            }
            if (!header.startsWith(HEADER_PREFIX)) throw new BenchError(400, 'bench.anon_voter_invalid', 'The X-OV-Voter header must be anon:<opaque id>.');
            const opaque = header.slice(HEADER_PREFIX.length).trim();
            if (!/^[A-Za-z0-9._~:-]{6,200}$/.test(opaque)) throw new BenchError(400, 'bench.anon_voter_invalid', 'The X-OV-Voter header must be anon:<opaque id>.');
            return {
                kind: 'anon', source: 'relay', opaque,
                subject: voterHash('relay:' + service, opaque),
                relay: service, creator: 'service:' + service, ip: null, minted: false,
            };
        }
        const cookies = (req && req.cookies) || {};
        const raw = cookies[cookieName()];
        const id = raw ? opaqueFromCookie(raw) : null;
        if (id) {
            return {
                kind: 'anon', source: 'cookie', opaque: id,
                subject: voterHash('cookie', id),
                relay: null, creator: null, ip: ipOf(req), minted: false,
            };
        }
        if (!mint) return null;
        if (p.kind && p.kind !== 'anonymous') return null;
        const fresh = newOpaqueId();
        return {
            kind: 'anon', source: 'cookie', opaque: fresh,
            subject: voterHash('cookie', fresh),
            relay: null, creator: null, ip: ipOf(req), minted: true,
        };
    }

    /** Give the browser its voter cookie. */
    function setCookie(res, opaque) {
        if (!res || typeof res.cookie !== 'function') return;
        const days = Math.max(1, num(cfg().cookieDays, 180));
        res.cookie(cookieName(), cookieValue(opaque), {
            httpOnly: true,
            sameSite: 'lax',
            secure: Boolean(config && config.cookies && config.cookies.secure),
            maxAge: days * 86_400_000,
            path: '/',
        });
    }

    /**
     * The daily counters this vote spends: the voter, the address (only for Bench's own cookie), the relaying
     * service and the site. The counters move inside the vote's own transaction, so a refused vote spends
     * nothing and a vote that is rolled back spends nothing either.
     */
    async function takeQuota(identity) {
        const c = cfg();
        const day = dayOf();
        const scopes = [{ scope: 'voter', key: identity.subject, cap: num(c.voterPerDay, 30) }];
        if (identity.source === 'cookie' && identity.ip) {
            scopes.push({ scope: 'ip', key: ipHash(identity.ip, day), cap: num(c.ipPerDay, 60) });
        }
        if (identity.relay) scopes.push({ scope: 'relay', key: identity.relay, cap: num(c.relayPerDay, 3000) });
        scopes.push({ scope: 'global', key: 'all', cap: num(c.globalPerDay, 20000) });
        for (const one of scopes) {
            const row = await db.maybe(
                `INSERT INTO bench_anon_counters (scope, key, day, count) VALUES ($1, $2, $3, 1)
                 ON CONFLICT (scope, key, day) DO UPDATE SET count = bench_anon_counters.count + 1
                 RETURNING count`,
                [one.scope, one.key, day],
            );
            if (num(row && row.count) > one.cap) throw new BenchError(429, 'bench.limit_anon', LIMIT_DETAIL);
        }
        return { day, scopes: scopes.map((one) => one.scope) };
    }

    /** What the voter may still spend today, for the pages that want to say so. */
    async function remaining(identity) {
        const c = cfg();
        const day = dayOf();
        const used = num(await db.value(
            'SELECT COUNT(*)::int AS n FROM bench_anon_counters WHERE scope = $1 AND key = $2 AND day = $3',
            ['voter', identity.subject, day],
        ));
        return { used, limit: num(c.voterPerDay, 30), left: Math.max(0, num(c.voterPerDay, 30) - used) };
    }

    /** Old counters are dropped: the address hash of yesterday is worth nothing today. */
    async function prune(days = KEEP_DAYS) {
        const cutoff = new Date(s.now() - Math.max(1, days) * 86_400_000).toISOString().slice(0, 10);
        await db.exec('DELETE FROM bench_anon_counters WHERE day < $1', [cutoff]);
    }

    return {
        HEADER, HEADER_PREFIX, RELAY_CAP, LIMIT_DETAIL,
        resolve, setCookie, takeQuota, remaining, prune,
        cookieName, enabled, dayOf, newOpaqueId, cookieValue, opaqueFromCookie, voterHash, ipHash, ipOf,
        serviceName, relayAllowed, secret,
    };
}

module.exports = { createAnon, HEADER, HEADER_PREFIX, RELAY_CAP, LIMIT_DETAIL };

'use strict';

/**
 * Who is calling /api/v1 — req.principal:
 *
 *   { kind: 'user', subject: 'usr_…', username, role, token, viaSession }
 *       a person: their Network user token as a Bearer, or this site's session cookie (bench_at).
 *   { kind: 'app', requester: 'service:…' | 'app:…' | 'agent:…', project, claims, capabilities }
 *       a Network service token for audience openvibe.bench with bench.* capabilities.
 *   { kind: 'anonymous' }
 *
 * A request that presents a token is judged on that token alone. A session-cookie write must come from this site
 * (Sec-Fetch-Site same-origin, or an Origin equal to ours).
 */
const { serviceAuth, http, ids } = require('openvibe-contracts');
const { BENCH_CAPABILITIES } = require('../contracts');
const { sameOrigin } = require('./same-origin');

const PRINCIPAL_SUB = /^(svc|app|mod|agent):/;
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;

const CAPABILITIES = Object.freeze([...BENCH_CAPABILITIES]);

function decodePayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

function roleClaim(claims) {
    return typeof claims.role === 'string' && claims.role ? claims.role.slice(0, 32) : 'user';
}
function usernameClaim(claims) {
    return typeof claims.username === 'string' ? claims.username.slice(0, 64) : null;
}

function requesterOfSub(sub) {
    if (sub.startsWith('svc:')) return `service:${sub.slice(4)}`;
    return sub;
}

function createPrincipal({ config, keys }) {
    async function resolve(req) {
        const header = String(req.headers.authorization || '');
        if (header.startsWith('Bearer ')) {
            const token = header.slice(7).trim();
            const payload = decodePayload(token);
            if (payload && typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) {
                const publicKey = await keys.pemForToken(token);
                if (!publicKey) return { error: [503, 'identity.unavailable', 'the Network signing key is not loaded yet'] };
                const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.networkIssuer, audience: config.audience });
                if (!r.ok) return { error: [401, r.code || 'token.invalid', r.reason || 'the token does not verify'] };
                const project = typeof r.claims.project_id === 'string' && PROJECT_RE.test(r.claims.project_id) ? r.claims.project_id : null;
                const capabilities = Array.isArray(r.claims.cap) ? r.claims.cap : [];
                return {
                    principal: {
                        kind: 'app', requester: requesterOfSub(r.claims.sub), project, claims: r.claims,
                        capabilities, hasCapability: (cap) => capabilities.includes(cap),
                    },
                };
            }
            const v = await keys.verifyUser(token, { issuer: config.networkIssuer, audience: config.oauth.sessionAudience });
            if (!v.ok) return { error: [401, v.expired ? 'token.expired' : 'token.invalid', v.reason] };
            if (v.claims.typ === 'fedcm' || v.claims.actor_type !== undefined) return { error: [401, 'token.invalid', 'not a person\'s token'] };
            if (!ids.isSubjectId('user', v.claims.subject_id)) return { error: [403, 'identity.no_subject', 'this account has no canonical subject yet; sign in again'] };
            return { principal: { kind: 'user', subject: v.claims.subject_id, requester: `user:${v.claims.subject_id}`, project: null, role: roleClaim(v.claims), username: usernameClaim(v.claims), token, viaSession: false } };
        }
        const viewer = req.viewer;
        if (viewer && viewer.kind === 'user' && ids.isSubjectId('user', viewer.subject)) {
            return { principal: { kind: 'user', subject: viewer.subject, requester: `user:${viewer.subject}`, project: null, role: viewer.role || 'user', username: viewer.username || null, token: viewer.token, viaSession: true } };
        }
        return { principal: { kind: 'anonymous' } };
    }

    async function middleware(req, res, next) {
        const r = await resolve(req);
        if (r.error) return http.sendProblem(res, r.error[0], r.error[1], { detail: r.error[2], ctx: req.ov });
        req.principal = r.principal;
        return next();
    }

    function requireCapability(cap) {
        if (!CAPABILITIES.includes(cap)) throw new Error(`requireCapability(${cap}): not one of OpenVibe.Bench's capabilities`);
        return function guard(req, res, next) {
            const p = req.principal;
            if (p.kind === 'app' && p.hasCapability(cap)) return next();
            if (p.kind === 'anonymous') return http.sendProblem(res, 401, 'token.required', { detail: 'Send a person\'s Network token as a Bearer, or a service token with bench.* capabilities.', ctx: req.ov });
            if (p.kind === 'user') return http.sendProblem(res, 403, 'bench.capability_required', { detail: `This route needs the ${cap} capability on a service token.`, ctx: req.ov });
            return http.sendProblem(res, 403, 'bench.capability_required', { detail: `This route needs the ${cap} capability.`, ctx: req.ov });
        };
    }

    function requirePerson(req, res, next) {
        const p = req.principal;
        if (p.kind === 'anonymous') return http.sendProblem(res, 401, 'bench.sign_in_required', { detail: 'Sign in at bench.openvibe.services, or send a person\'s Network token as a Bearer.', ctx: req.ov });
        if (p.kind !== 'user') return http.sendProblem(res, 403, 'bench.person_required', { detail: 'This route is for a person, not a service token.', ctx: req.ov });
        if (p.viaSession && req.method !== 'GET' && !sameOrigin(req, config)) {
            return http.sendProblem(res, 403, 'bench.cross_site', { detail: 'A signed-in request that changes something must come from bench.openvibe.services itself.', ctx: req.ov });
        }
        return next();
    }

    return { middleware, resolve, requireCapability, requirePerson };
}

module.exports = { createPrincipal, CAPABILITIES, decodePayload };

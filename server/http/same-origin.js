'use strict';

/**
 * Same-origin writes (CSRF). A write authenticated by the httpOnly `bench_at` session cookie must come from this
 * site: Sec-Fetch-Site: same-origin, or an Origin equal to BASE_URL's origin. A Bearer write is not
 * cookie-authenticated and is unaffected.
 */
const { http } = require('openvibe-contracts');
const { ACCESS_COOKIE } = require('../auth/sso');

function ownOrigin(config) {
    try { return new URL(config.baseUrl).origin; } catch { return null; }
}

function bearer(req) {
    const h = String(req.get('authorization') || '');
    return /^Bearer\s+\S/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : null;
}

function cookieAuthenticated(req) {
    return Boolean(req.cookies && req.cookies[ACCESS_COOKIE]);
}

function sameOrigin(req, config) {
    const site = String(req.get('sec-fetch-site') || '').trim().toLowerCase();
    if (site === 'same-origin') return true;
    const sent = String(req.get('origin') || '');
    const own = ownOrigin(config);
    return Boolean(sent) && Boolean(own) && sent === own;
}

function writeAllowed(req, config) {
    if (bearer(req)) return true;
    if (!cookieAuthenticated(req)) return true;
    return sameOrigin(req, config);
}

function requireSameOrigin(config, { detail = 'A change must come from this site itself.', code = 'bench.cross_site' } = {}) {
    return (req, res, next) => {
        if (writeAllowed(req, config)) return next();
        return http.sendProblem(res, 403, code, { detail, ctx: req.ov });
    };
}

module.exports = { ownOrigin, bearer, cookieAuthenticated, sameOrigin, writeAllowed, requireSameOrigin };

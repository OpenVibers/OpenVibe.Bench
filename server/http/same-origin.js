'use strict';

/**
 * Same-origin writes (CSRF). A write authenticated by the httpOnly session cookie must come from this site:
 * Sec-Fetch-Site: same-origin, or an Origin equal to BASE_URL's origin. A Bearer write is not cookie-authenticated
 * and is unaffected.
 *
 * The session lives in `ov_token` since the move to openvibe-sdk/sso; the site's own `bench_at` cookie is still read
 * as the session (until the next sign-in or refresh writes ov_token), so both are a cookie-authenticated write.
 */
const { http } = require('openvibe-contracts');
const { SESSION_COOKIES } = require('../auth/sso');

function ownOrigin(config) {
    try { return new URL(config.baseUrl).origin; } catch { return null; }
}

function bearer(req) {
    const h = String(req.get('authorization') || '');
    return /^Bearer\s+\S/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : null;
}

function cookieAuthenticated(req) {
    const c = req.cookies || {};
    return SESSION_COOKIES.some((name) => Boolean(c[name]));
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

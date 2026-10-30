'use strict';
/**
 * Sign-in with PKCE S256 through openvibe-sdk/sso (0.73.0): the routes, the SDK's own recovery (a lost flow or a
 * code the Network no longer accepts starts the sign-in once more by itself, and only then shows a page with
 * "Try again"), the old cookies read as the session, the session-token rules (a FedCM assertion or an app token is
 * not a session), the open-redirect guard, truthful readiness and cross-site sign-out.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');
const { sanitizeNext } = require('../server/auth/sso');

const cookieJar = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

(async () => {
    const t = await boot();
    const user = t.network.addUser('kim');

    await check('login redirects to Network with state and an S256 code challenge', async () => {
        const r = await t.get('/auth/login?next=/boards');
        assert.strictEqual(r.status, 302);
        const loc = new URL(r.headers.get('location'));
        assert.strictEqual(loc.origin + loc.pathname, `${t.network.url}/oauth/authorize`);
        assert.strictEqual(loc.searchParams.get('client_id'), 'bench');
        assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
        assert.match(loc.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
        assert.match(loc.searchParams.get('state'), /^[A-Za-z0-9_-]{32}$/);
        assert.match(r.headers.get('set-cookie'), /ov_oauth_state=.*Path=\/auth.*HttpOnly/i);
    });

    await check('login passes ?silent, ?prompt and ?login_hint to the Network', async () => {
        const silent = new URL((await t.get('/auth/login?silent=1')).headers.get('location'));
        assert.strictEqual(silent.searchParams.get('prompt'), 'none');
        const chooser = new URL((await t.get('/auth/login?prompt=select_account')).headers.get('location'));
        assert.strictEqual(chooser.searchParams.get('prompt'), 'select_account');
        const hint = new URL((await t.get('/auth/login?login_hint=kim')).headers.get('location'));
        assert.strictEqual(hint.searchParams.get('login_hint'), 'kim');
    });

    await check('callback exchanges the code with the matching verifier and sets the SDK\'s own httpOnly cookies', async () => {
        const login = await t.get('/auth/login?next=/boards');
        const loc = new URL(login.headers.get('location'));
        const flowCookie = cookieJar(login);
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        const r = await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`, { cookie: flowCookie });
        assert.strictEqual(r.status, 302, r.text);
        assert.strictEqual(r.headers.get('location'), '/boards');
        const set = r.headers.get('set-cookie');
        assert.match(set, /ov_token=[^;]+;.*HttpOnly/i);
        assert.match(set, /ov_refresh=[^;]+;.*HttpOnly/i);
        assert.match(set, /bench_at=;/);
        const at = set.match(/ov_token=([^;]+)/)[1];
        const me = await t.get('/auth/me', { cookie: `ov_token=${at}` });
        assert.strictEqual(me.json().user.username, 'kim');
        assert.ok(!me.text.includes(at), '/auth/me never returns the token');
    });

    await check('the old cookie is still the session, so nobody is signed out by the move', async () => {
        const at = t.network.userToken(user);
        const me = await t.get('/auth/me', { cookie: `bench_at=${at}` });
        assert.strictEqual(me.status, 200);
        assert.strictEqual(me.json().user.username, 'kim');
        assert.strictEqual(me.json().user.subject_id, user.subject);
    });

    await check('a wrong state, a verifier that does not match, or no flow cookie starts the sign-in once more', async () => {
        const login = await t.get('/auth/login');
        const loc = new URL(login.headers.get('location'));
        const flowCookie = cookieJar(login);
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        const wrong = await t.get(`/auth/callback?code=${code}&state=${'0'.repeat(32)}`, { cookie: flowCookie });
        assert.strictEqual(wrong.status, 302, 'the SDK recovers by itself once');
        assert.match(wrong.headers.get('location'), /^\/auth\/login/);
        const retry = cookieJar(wrong);
        assert.match(retry, /ov_oauth_retry=1/);
        const again = await t.get(`/auth/callback?code=${code}&state=${'0'.repeat(32)}`, { cookie: `${flowCookie}; ${retry}` });
        assert.strictEqual(again.status, 400);
        assert.match(again.text, /Try again/);
        const other = t.network.issueCode(user, crypto.createHash('sha256').update('another-verifier').digest('base64url'));
        assert.strictEqual((await t.get(`/auth/callback?code=${other}&state=${loc.searchParams.get('state')}`, { cookie: flowCookie })).status, 302);
        assert.strictEqual((await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`)).status, 302);
    });

    await check('next= only accepts same-site paths', async () => {
        const r = await t.get('/auth/login?next=//evil.example/x');
        assert.ok(!/ov_oauth_next=[^;]+/.test(String(r.headers.get('set-cookie') || '')), 'another origin is never a target');
        const config = { baseUrl: 'https://bench.openvibe.services' };
        assert.strictEqual(sanitizeNext('/boards?x=1', config), '/boards?x=1');
        assert.strictEqual(sanitizeNext('https://bench.openvibe.services/boards?y=1', config), '/boards?y=1');
        for (const v of ['//evil.com', '/\\evil.com', 'https://evil.com/x', '/\t/evil.com', 'javascript:alert(1)', 'https://bench.openvibe.services.evil.com/x']) assert.strictEqual(sanitizeNext(v, config), '/', v);
    });

    await check('/auth/health says whether the Network accepts this site\'s client', async () => {
        const r = await t.get('/auth/health');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json(), { ok: true, client: 'ok' });
    });

    await check('readiness is truthful: db required; JWKS, the OAuth client and Valkey optional', async () => {
        const r = await t.get('/api/ready');
        const b = r.json();
        assert.strictEqual(r.status, 200);
        assert.strictEqual(b.checks.db.status, 'ok');
        assert.strictEqual(b.checks.db.required, true);
        assert.strictEqual(b.checks.network_jwks.status, 'ok');
        assert.strictEqual(b.checks.network_jwks.required, false);
        assert.strictEqual(b.checks.oauth_client.status, 'ok');
        assert.strictEqual(b.checks.oauth_client.required, false);
        assert.strictEqual(b.checks.sso_client.status, 'ok');
        assert.strictEqual(b.checks.sso_client.required, true);
        assert.ok('valkey' in b.checks);
    });

    await check('/auth/me: a guest is signed out (200 { user: null }); a failing session cookie is 401', async () => {
        const guest = await t.get('/auth/me');
        assert.strictEqual(guest.status, 200);
        assert.deepStrictEqual(JSON.parse(guest.text), { user: null });
        assert.strictEqual(guest.headers.get('cache-control'), 'private, no-store');
        assert.strictEqual((await t.get('/auth/me', { cookie: 'bench_at=garbage' })).status, 401);
        assert.strictEqual((await t.get('/auth/me', { cookie: 'bench_rt=stale' })).status, 401);
        assert.strictEqual((await t.get('/auth/me', { as: user })).status, 200);
    });

    await check('a FedCM assertion and an app token are not sessions', async () => {
        const now = Math.floor(Date.now() / 1000);
        const fedcm = t.network.signJwt({ iss: t.network.issuer(), sub: user.id, id: user.id, subject_id: user.subject, username: user.username, display_name: user.username, nonce: null, typ: 'fedcm', jti: 'x', aud: 'https://tenant.openvibe.host', iat: now, exp: now + 300 });
        assert.strictEqual((await t.get('/auth/me', { cookie: `bench_at=${fedcm}` })).status, 401);
        const app = t.network.signJwt({ iss: t.network.issuer(), sub: 'app:app_01JABCDEFGHJKMNPQRSTVWXYZ0', actor_type: 'app', aud: ['openvibe.network'], cap: ['x.y.z'], subject_id: user.subject, iat: now, exp: now + 300 });
        assert.strictEqual((await t.get('/auth/me', { cookie: `bench_at=${app}` })).status, 401);
    });

    await check('another site cannot sign a person out; this site can', async () => {
        const cross = await t.get('/auth/logout', { as: user, headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(cross.status, 200);
        assert.ok(!/bench_at=;|bench_at=deleted/i.test(String(cross.headers.get('set-cookie') || '')));
        assert.match(cross.text, /method="post"/);
        const crossPost = await t.get('/auth/logout', { as: user, method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(crossPost.status, 403);
        const same = await t.get('/auth/logout?next=/boards', { as: user, headers: { 'sec-fetch-site': 'same-origin' } });
        assert.strictEqual(same.status, 303);
        assert.strictEqual(same.headers.get('location'), '/boards');
        assert.match(String(same.headers.get('set-cookie') || ''), /bench_at=;/);
    });

    await t.close();
    done();
})();

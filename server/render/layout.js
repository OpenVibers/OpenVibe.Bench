'use strict';

/**
 * Page shell. Every page is server-rendered through openvibe-shared/shell and complete without JavaScript.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const appIcon = require('openvibe-shared/app-icon');
const shell = require('openvibe-shared/shell');
const rooms = require('openvibe-shared/rooms');
const ovServe = require('openvibe-shared/serve');
const cache = require('openvibe-shared/cache-policy');
const { render, esc } = require('./html');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Bench';
const TAGLINE = 'One AI benchmark and comparison engine for every room.';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const NAV = [
    { label: 'Home', href: '/' },
    { label: 'Docs', href: '/docs' },
];

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

function renderPage(o) {
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const pathNow = o.path || '/';
    const loginNext = encodeURIComponent(pathNow);
    const canonical = `${o.config.baseUrl}${pathNow.split('?')[0]}`;
    const nav = {
        service: 'bench',
        apiBase: NETWORK_URL,
        links: NAV.map((l) => ({ label: l.label, href: l.href, active: pathNow === l.href || pathNow.startsWith(`${l.href}/`) })),
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${o.config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',
        logoutUrl: '/auth/logout?next={path}',
        notificationsRealtime: true,
    };
    const footer = { service: 'bench', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME };
    const account = signedIn
        ? `Signed in as <strong>${esc(viewer.displayName || viewer.username || 'you')}</strong> · <a href="/auth/logout?next=${loginNext}">Sign out</a>`
        : `<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a>`;
    const scripts = (o.scripts || []).map((rel) => `<script src="${asset(rel)}" defer></script>`);
    return shell.page({
        name: SITE_NAME,
        lang: 'en',
        title: o.title || `${SITE_NAME}: ${TAGLINE}`,
        titleSuffix: o.title ? ` · ${SITE_NAME}` : '',
        siteName: SITE_NAME,
        description: o.description || `${SITE_NAME} — ${TAGLINE}`,
        canonical,
        robots: o.index ? 'index, follow' : 'noindex, nofollow',
        jsonLd: (o.jsonLd || []).filter(Boolean),
        home: '/',
        navLinks: NAV,
        navbar: nav,
        footer,
        head: `<meta name="referrer" content="strict-origin-when-cross-origin">
${appIcon.headTags({ site: 'bench' })}
<link rel="stylesheet" href="${ovServe.url('kit.css')}">
<link rel="stylesheet" href="${ovServe.url('room.css')}">
<link rel="stylesheet" href="${asset('css/bench.css')}">
<script src="${asset('js/bench.js')}" defer></script>
${render(scripts)}
<meta name="ov-boost" content="bench@${esc(RELEASE)}">
<script src="${require('openvibe-shared/serve').url('boost.js')}" data-main="#main" defer></script>`,
        body: `<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
<noscript><div class="account-bar" role="navigation" aria-label="Account">${account}</div></noscript>
<main id="main" class="bm ov-room" style="${rooms.style('bench')}">
${render(o.body)}
</main>
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* the Frame is optional */ }
});
</script>`,
    });
}

function send(res, status, o) {
    const personal = o.viewer && o.viewer.kind === 'user';
    if (!res.get('Cache-Control')) res.set('Cache-Control', personal ? cache.htmlHeaders({ private: true }) : (o.cache || cache.htmlHeaders({ private: true })));
    res.set('Vary', 'Cookie');
    res.status(status).type('html').send(renderPage(o));
}

module.exports = { renderPage, send, asset, assetVersion, setRelease, SITE_NAME, TAGLINE, NETWORK_URL, NAV };

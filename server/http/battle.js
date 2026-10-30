'use strict';

/**
 * The battle pages: /battle (blind), /battle/revealed/:id (after the vote) and /battle/card/:id.svg (the share card).
 *
 * The vote is a plain form post to the same origin, so it works with JavaScript switched off. The page itself is
 * server-rendered: the two panes are the same sandboxed render frames the showcase uses, and the model names stay
 * closed until the vote is in.
 */

const express = require('express');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./same-origin');
const renderLib = require('../bench/render');
const { kindById } = require('../kinds');
const { esc, raw } = require('../render/html');
const { send } = require('../render/layout');
const { createBattles } = require('../bench/battles');

const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));

/** The share card is a vector image: 1200 by 630, the size every social card expects. */
const CARD = { w: 1200, h: 630 };

function paneOf(slot, letter) {
    const url = renderLib.RENDER_ORIGIN + '/render/w/' + encodeURIComponent(slot.id);
    return '<figure class="bt-pane" data-slot="' + esc(letter) + '" data-entry-id="' + esc(slot.id) + '">'
        + '<figcaption><span class="bt-pane-label">Pane ' + esc(letter) + '</span></figcaption>'
        + '<iframe class="bt-pane-frame" src="' + esc(url) + '" title="Output ' + esc(letter) + '"'
        + ' sandbox="' + esc(renderLib.WRAPPER_SANDBOX) + '" referrerpolicy="no-referrer" loading="lazy"></iframe>'
        + '</figure>';
}

function voteForm(battle) {
    const q = battle.question;
    return '<form class="bt-vote" method="post" action="/battle" data-battle-form="1">'
        + '<input type="hidden" name="battle" value="' + esc(battle.id) + '">'
        + '<fieldset><legend>Which is better?</legend>'
        + '<label><input type="radio" name="outcome" value="A" required> A</label>'
        + '<label><input type="radio" name="outcome" value="B"> B</label>'
        + '<label><input type="radio" name="outcome" value="tie"> Tie</label>'
        + '<label><input type="radio" name="outcome" value="both_bad"> Both bad</label>'
        + '</fieldset>'
        + '<fieldset><legend>' + esc(q.text) + '</legend>'
        + '<label><input type="radio" name="answer" value="A"> A</label>'
        + '<label><input type="radio" name="answer" value="B"> B</label>'
        + '<label><input type="radio" name="answer" value="tie"> Same</label>'
        + '</fieldset>'
        + '<button class="bm-btn" type="submit">Cast the vote</button>'
        + '</form>';
}

function battleView(battle) {
    const kind = kindById(battle.kind_id);
    return '<section class="bt-battle" data-battle="' + esc(battle.id) + '" data-kind="' + esc(battle.kind_id) + '">'
        + '<h1 class="bt-prompt" data-prompt="1">' + esc(battle.prompt) + '</h1>'
        + '<p class="bt-meta"><span class="br-chip">' + esc(kind ? kind.name : battle.kind_id) + '</span>'
        + '<span class="bm-fine">Blind: you see two outputs, not their names.</span></p>'
        + '<div class="bt-panes">' + paneOf(battle.a, 'A') + paneOf(battle.b, 'B') + '</div>'
        + voteForm(battle)
        + '</section>';
}

function revealView(battle) {
    const kind = kindById(battle.kind_id);
    const vote = battle.vote || {};
    const winner = vote.outcome === 'left' ? 'A' : vote.outcome === 'right' ? 'B' : vote.outcome === 'tie' ? 'Tie' : 'Both bad';
    const fact = (slot, letter) => '<dl class="bt-facts" data-slot="' + esc(letter) + '">'
        + '<div><dt>Model</dt><dd>' + esc(slot.model) + '</dd></div>'
        + '<div><dt>Provider</dt><dd>' + esc(slot.provider) + '</dd></div>'
        + '<div><dt>Cost</dt><dd>$' + esc(slot.cost_usd) + '</dd></div>'
        + '<div><dt>Time</dt><dd>' + esc(slot.ms) + ' ms</dd></div>'
        + '</dl>';
    return '<section class="bt-battle bt-revealed" data-battle="' + esc(battle.id) + '" data-kind="' + esc(battle.kind_id) + '">'
        + '<h1 class="bt-prompt" data-prompt="1">' + esc(battle.prompt) + '</h1>'
        + '<p class="bt-meta"><span class="br-chip">' + esc(kind ? kind.name : battle.kind_id) + '</span>'
        + '<span class="br-chip">' + esc('Your vote: ' + winner) + '</span>'
        + (vote.answer ? '<span class="br-chip">' + esc(battle.question.text + ': ' + vote.answer) + '</span>' : '')
        + '</p>'
        + '<div class="bt-panes">' + paneOf(battle.a, 'A') + paneOf(battle.b, 'B') + '</div>'
        + '<div class="bt-reveal-facts">' + fact(battle.a, 'A') + fact(battle.b, 'B') + '</div>'
        + '<p class="bm-actions"><a class="bm-btn bm-btn-quiet" href="/battle">Next battle</a>'
        + '<a class="bm-btn bm-btn-quiet" href="/gallery">See the gallery</a></p>'
        + '</section>';
}

function signedOutView() {
    return '<section class="bt-battle bt-signed-out">'
        + '<h1>Battles: two outputs, one prompt, blind</h1>'
        + '<p class="bm-lede">Every battle shows two outputs of the same prompt, without their names. You say which one is '
        + 'better (or that both are bad), the names open, and your vote counts towards the board.</p>'
        + '<p class="bm-note">Battles are for signed-in people: one vote per person, one pair per person, and the votes '
        + 'are rate limited so the board stays honest.</p>'
        + '<p class="bm-actions"><a class="bm-btn" href="/auth/login?next=%2Fbattle">Sign in to fight</a>'
        + '<a class="bm-btn bm-btn-quiet" href="/gallery">Look at the gallery first</a></p>'
        + '</section>';
}

/** The share card: both panes and the question. A vector card, so no rasteriser is needed. */
function cardSvg(battle, baseUrl) {
    const kind = kindById(battle.kind_id);
    const escXml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const thumb = (slot, x, letter) => {
        const payload = slot.payload || {};
        const svg = typeof payload.svg === 'string' ? payload.svg : '';
        if (svg && svg.trim()) {
            const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
            return '<image href="' + uri + '" x="' + x + '" y="150" width="480" height="300" preserveAspectRatio="xMidYMid meet"/>';
        }
        return '<rect x="' + x + '" y="150" width="480" height="300" rx="18" fill="#16203a" stroke="#2b3a5c"/>'
            + '<text x="' + (x + 240) + '" y="292" fill="#7d8ea9" font-family="system-ui, sans-serif" font-size="26" text-anchor="middle">'
            + escXml(kind ? kind.name : 'output') + '</text>'
            + '<text x="' + (x + 240) + '" y="330" fill="#55658a" font-family="system-ui, sans-serif" font-size="20" text-anchor="middle">live preview</text>';
    };
    const prompt = String(battle.prompt || '').replace(/\s+/g, ' ').trim();
    const short = prompt.length > 150 ? prompt.slice(0, 147) + '…' : prompt;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + CARD.w + '" height="' + CARD.h + '" viewBox="0 0 ' + CARD.w + ' ' + CARD.h + '">'
        + '<rect width="' + CARD.w + '" height="' + CARD.h + '" fill="#0b1220"/>'
        + '<rect x="24" y="24" width="' + (CARD.w - 48) + '" height="' + (CARD.h - 48) + '" rx="28" fill="none" stroke="#24304a"/>'
        + '<text x="60" y="96" fill="#e6edf7" font-family="system-ui, sans-serif" font-size="52" font-weight="800">Vote: which is better?</text>'
        + '<text x="60" y="132" fill="#8fa3c2" font-family="system-ui, sans-serif" font-size="24">' + escXml(short) + '</text>'
        + thumb(battle.a, 60, 'A')
        + thumb(battle.b, 660, 'B')
        + '<text x="84" y="196" fill="#7fd1a8" font-family="system-ui, sans-serif" font-size="30" font-weight="800">A</text>'
        + '<text x="684" y="196" fill="#7fd1a8" font-family="system-ui, sans-serif" font-size="30" font-weight="800">B</text>'
        + '<text x="60" y="516" fill="#8fa3c2" font-family="system-ui, sans-serif" font-size="26">Two outputs, one prompt, blind.</text>'
        + '<text x="60" y="556" fill="#c9d6ea" font-family="system-ui, sans-serif" font-size="26" font-weight="700">'
        + escXml('OpenVibe.Bench') + '</text>'
        + '<text x="' + (CARD.w - 60) + '" y="556" fill="#55658a" font-family="system-ui, sans-serif" font-size="20" text-anchor="end">'
        + escXml(baseUrl + '/battle') + '</text>'
        + '</svg>';
}

function createBattlePages(ctx) {
    const r = express.Router();
    const { config, principal } = ctx;
    const battles = createBattles(ctx);
    ctx.battles = battles;
    r.use(express.urlencoded({ extended: false, limit: '16kb' }));
    r.use(principal.middleware);
    const viewerOf = (req) => (req.principal && req.principal.kind === 'user'
        ? { kind: 'user', subject: req.principal.subject, displayName: req.principal.displayName || req.principal.username }
        : { kind: 'anonymous' });
    const subjectOf = (req) => (req.principal && req.principal.kind === 'user' ? req.principal.subject : null);

    r.get('/', async (req, res) => {
        const subject = subjectOf(req);
        if (!subject) {
            return send(res, 200, {
                config, viewer: viewerOf(req), path: req.originalUrl,
                title: 'Battles: two outputs, one prompt, blind',
                description: 'Pick the better output, blind. The names open after the vote.',
                body: raw(signedOutView()),
            });
        }
        const battle = await battles.pickPair({
            subject,
            kind: typeof req.query.kind === 'string' ? req.query.kind : 'all',
            random: ctx.random || Math.random,
            netHash: battles.netHashOf(req),
        });
        if (!battle) {
            return send(res, 200, {
                config, viewer: viewerOf(req), path: req.originalUrl,
                title: 'Battles: nothing waiting',
                description: 'Pick the better output, blind. The names open after the vote.',
                body: raw('<section class="bt-battle"><h1>No battle is waiting right now</h1>'
                    + '<p class="bm-lede">Every pair you have seen is voted on, and the next rounds are still running. '
                    + 'Come back in a minute, or <a href="/gallery">look at the gallery</a>.</p></section>'),
            });
        }
        return send(res, 200, {
            config, viewer: viewerOf(req), path: req.originalUrl,
            title: 'Battle: two outputs, one prompt',
            description: 'Pick the better output, blind. The names open after the vote.',
            headExtra: '<meta property="og:title" content="Vote: which is better?">'
                + '<meta property="og:description" content="Two outputs, one prompt, blind. Vote on OpenVibe.Bench.">'
                + '<meta property="og:image" content="' + esc(config.baseUrl + '/battle/card/' + battle.id + '.svg') + '">'
                + '<meta property="og:image:type" content="image/svg+xml">'
                + '<meta name="twitter:card" content="summary_large_image">',
            body: raw(battleView(battle)),
        });
    });

    r.get('/card/:id.svg', async (req, res) => {
        const battle = await battles.battleOf(String(req.params.id || ''));
        if (!battle) return res.status(404).type('text/plain').send('No such card.');
        res.set('Cache-Control', 'public, max-age=60');
        res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data: 'self'");
        return res.type('image/svg+xml').send(cardSvg(battle, config.baseUrl));
    });

    r.get('/revealed/:id', async (req, res) => {
        const subject = subjectOf(req);
        const battle = await battles.battleOf(String(req.params.id || ''), subject);
        if (!battle) {
            return send(res, 404, { config, viewer: viewerOf(req), path: req.originalUrl, title: 'No such battle', body: raw('<section><h1>No such battle</h1></section>') });
        }
        return send(res, 200, {
            config, viewer: viewerOf(req), path: req.originalUrl,
            title: 'Battle: the names are open',
            description: 'The two outputs of one prompt, with their names.',
            body: raw(revealView(battle)),
        });
    });

    r.post('/', async (req, res) => {
        const subject = subjectOf(req);
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        if (!subject) return res.redirect('/auth/login?next=' + encodeURIComponent('/battle'));
        if (req.principal.viaSession && !sameOrigin(req, config)) {
            return res.status(403).type('text/plain').send('A signed-in vote must come from bench.openvibe.services itself.');
        }
        const out = await battles.recordVote({
            subject,
            battleId: String(body.battle || ''),
            outcome: body.outcome,
            answer: body.answer,
            netHash: battles.netHashOf(req),
        });
        if (!out.ok) {
            return res.status(out.status || 422).type('text/plain').send(out.message || 'The vote was not accepted.');
        }
        return res.redirect(303, '/battle/revealed/' + out.battle_id);
    });

    return r;
}

module.exports = { createBattlePages, cardSvg };

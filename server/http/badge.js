'use strict';

/**
 * The README badge (spec 3): /badge/:benchmark/:model.svg
 *
 * The badge carries the benchmark, its version and the model's score with its spread, plus the band the model sits in
 * when the board knows it — never a bare rank. The text is escaped and the width comes from the text, so a long
 * title still fits. An unknown benchmark or a model with no data gets a grey "no data" badge and a 404.
 */

const express = require('express');
const { esc } = require('../render/html');

/** The height of a badge and the width one character takes at this size. */
const HEIGHT = 20;
const CHAR_W = 6.9;
const PAD = 10;

/** The XML escape for text inside the SVG. */
function xml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The width of a run of text, from the text itself. */
function widthOf(text) {
    return Math.max(20, Math.ceil(String(text).length * CHAR_W) + PAD * 2);
}

/**
 * A shields-shaped badge. `label` on the left, `message` on the right; the width comes from both.
 * The fills are the standard badge greys: a badge is a picture of its own, so it cannot borrow the site's theme.
 */
function badgeSvg({ label, message, tone = 'value', title = null }) {
    const lw = widthOf(label);
    const mw = widthOf(message);
    const width = lw + mw;
    const labelFill = tone === 'nodata' ? '#9f9f9f' : '#555';
    const valueFill = tone === 'nodata' ? '#c8c8c8' : '#007ec6';
    const labelText = tone === 'nodata' ? '#ffffff' : '#ffffff';
    const name = title || (label + ' · ' + message);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + HEIGHT + '" role="img" aria-label="' + xml(name) + '">'
        + '<title>' + xml(name) + '</title>'
        + '<rect width="' + width + '" height="' + HEIGHT + '" rx="3" fill="' + valueFill + '"/>'
        + '<rect width="' + lw + '" height="' + HEIGHT + '" rx="3" fill="' + labelFill + '"/>'
        + '<rect x="' + (lw - 3) + '" width="3" height="' + HEIGHT + '" fill="' + valueFill + '"/>'
        + '<g fill="' + labelText + '" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">'
        + '<text x="' + (PAD - 0.5) + '" y="14">' + xml(label) + '</text>'
        + '<text x="' + (lw + PAD - 0.5) + '" y="14">' + xml(message) + '</text>'
        + '</g></svg>';
}

const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
const fmtScore = (v) => (v == null ? '—' : String(Math.round(Number(v) * 10) / 10));

/** The no-data badge: grey, with the reason, and a 404 beside it. */
function noData(reason) {
    const svg = badgeSvg({ label: 'OpenVibe Bench', message: 'no data' + (reason ? ' (' + reason + ')' : ''), tone: 'nodata' });
    return { svg, status: 404 };
}

/**
 * The badge for one benchmark and one model. The score is the median of the model's verified runs on that benchmark;
 * the spread is how much those runs differ from each other, and the band is where the model sits on that benchmark's
 * board.
 */
async function badgeFor(ctx, benchmarkId, model) {
    const registry = ctx.registry;
    const benchmark = await registry.getBenchmark(String(benchmarkId || ''));
    if (!benchmark) return noData('unknown benchmark');
    const rankings = await registry.rankings({ benchmark: benchmark.id, metric: 'score' });
    const entries = (rankings && rankings.entries) || [];
    const row = entries.find((e) => String(e.model) === String(model || ''));
    if (!row || row.score == null) return noData('no runs');
    const version = num(benchmark.latest_version, 1);
    const title = String(benchmark.title || benchmark.id);
    const spread = row.consistency != null ? Math.round(num(row.consistency) * 10) / 10 : null;
    let band = null;
    try {
        const board = await require('../rating/board').boardForKind(ctx, benchmark.kind);
        for (const b of ((board.fit && board.fit.bands && board.fit.bands.controlled) || [])) {
            if ((b.models || []).includes(String(model))) { band = b.label; break; }
        }
    } catch { /* the board is a nicety here: a badge without a band still carries the score */ }
    const message = spread != null ? fmtScore(row.score) + ' ±' + spread : fmtScore(row.score);
    const label = title + ' v' + version + (band ? ' · band ' + band : '');
    return { svg: badgeSvg({ label, message, title: label + ': ' + message }), status: 200 };
}

function createBadgeRoutes(ctx) {
    const r = express.Router();
    r.get('/:benchmark/:model.svg', async (req, res) => {
        const model = String(req.params.model || '').replace(/\.svg$/i, '');
        const out = await badgeFor(ctx, String(req.params.benchmark || ''), model);
        res.status(out.status);
        res.set('Content-Type', 'image/svg+xml; charset=utf-8');
        res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        res.set('Cache-Control', 'public, max-age=3600');
        return res.send(out.svg);
    });
    return r;
}

module.exports = { createBadgeRoutes, badgeFor, badgeSvg, xml, widthOf, noData };

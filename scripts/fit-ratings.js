'use strict';

/**
 * Re-derive the board from the open vote dump.
 *
 *   node scripts/fit-ratings.js /tmp/votes.jsonl            # the table
 *   node scripts/fit-ratings.js /tmp/votes.jsonl --json     # the same board as JSON
 *   curl -s https://bench.openvibe.services/api/v1/datasets/votes.jsonl | node scripts/fit-ratings.js
 *
 * The dump carries every vote without voter ids, plus the weight each vote carried in the live fit (so a voter
 * who disagreed with the consensus far too often counts less). The fit below is the same fit the board uses, with
 * the same seed, so the numbers here are the numbers on /ratings.
 */

const fs = require('fs');
const path = require('path');
const style = require(path.join(__dirname, '..', 'server', 'rating', 'style'));

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const bootstrapIndex = argv.indexOf('--bootstrap');
const bootstrap = bootstrapIndex >= 0 ? Number(argv[bootstrapIndex + 1]) || style.BOOTSTRAP : style.BOOTSTRAP;
const file = argv.find((a) => !a.startsWith('--') && a !== String(bootstrap));

function readInput() {
    if (!file) return fs.readFileSync(0, 'utf8');
    return fs.readFileSync(file, 'utf8');
}

/** The dump's lines into the games the fit reads. */
function gamesOf(lines) {
    const games = [];
    const weights = new Map();
    for (const line of lines) {
        const text = String(line || '').trim();
        if (!text) continue;
        let v;
        try { v = JSON.parse(text); } catch { continue; }
        if (!v || !v.left || !v.right || !v.left.model || !v.right.model) continue;
        const outcome = v.outcome === 'left' ? 'a' : v.outcome === 'right' ? 'b' : v.outcome === 'tie' ? 'tie' : 'both_bad';
        games.push({
            id: v.id == null ? null : String(v.id),
            a: v.left.model,
            b: v.right.model,
            outcome,
            fa: { length: Number(v.left.length) || 0, markup: Number(v.left.markup) || 0 },
            fb: { length: Number(v.right.length) || 0, markup: Number(v.right.markup) || 0 },
        });
        if (v.id != null && v.weight != null) weights.set(String(v.id), Number(v.weight));
    }
    return { games, weights };
}

function main() {
    const text = readInput();
    const { games, weights } = gamesOf(text.split('\n'));
    if (!games.length) {
        process.stderr.write('No votes in the dump. Fetch one: curl -s https://bench.openvibe.services/api/v1/datasets/votes.jsonl\n');
        process.exit(1);
    }
    const fit = style.fitRatings(games, { bootstrap, voteWeights: weights });
    if (asJson) {
        process.stdout.write(JSON.stringify({ models: fit.models, bands: fit.bands, effects: fit.effects, votes: fit.votes, bootstrap: fit.bootstrap, seed: fit.seed }, null, 2) + '\n');
        return;
    }
    const cell = (m, key) => {
        const c = m[key];
        const lo = Math.round(c.ci_lower);
        const hi = Math.round(c.ci_upper);
        return String(Math.round(c.rating)).padStart(5) + '  [' + String(lo).padStart(5) + ', ' + String(hi).padStart(5) + ']';
    };
    const lines = [];
    lines.push('OpenVibe.Bench — the board, re-derived from the open vote dump');
    lines.push(fit.votes + ' votes, ' + fit.bootstrap + ' bootstrap resamples, seed ' + fit.seed);
    lines.push('');
    lines.push('model'.padEnd(28) + 'votes   raw rating (95% interval)   band     controlled rating (95% interval)   band');
    lines.push('-'.repeat(120));
    for (const m of fit.models) {
        lines.push(
            String(m.model).padEnd(28)
            + String(m.votes).padStart(5) + '   '
            + cell(m, 'raw') + '   ' + String(m.raw.band || '').padEnd(8)
            + cell(m, 'controlled') + '   ' + String(m.controlled.band || ''),
        );
    }
    lines.push('');
    for (const [key, e] of Object.entries(fit.effects || {})) {
        lines.push('style effect ' + key + ':'
            + (e.elo_per_1000_chars != null ? ' ' + e.elo_per_1000_chars + ' Elo per 1000 characters' : '')
            + (e.elo_per_10_marks != null ? ' ' + e.elo_per_10_marks + ' Elo per 10 markup marks' : ''));
    }
    if (fit.dropped_covariates && fit.dropped_covariates.length) {
        lines.push('dropped (too close to another covariate): ' + fit.dropped_covariates.join(', '));
    }
    lines.push('down-weighted voters: ' + fit.voters.downweighted + ' of ' + fit.voters.total + ' (never named)');
    process.stdout.write(lines.join('\n') + '\n');
}

main();

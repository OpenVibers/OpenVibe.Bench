'use strict';

/**
 * live.clip entries (item 151, C19 of the clip-quality research): a clip OpenVibe.Live's picker made, or chose not to
 * make, for one held-out stretch of a recording, compared blind against another policy's pick. Bench does not make
 * clips: Live submits them with its service token.
 *
 *   payload = {
 *     source:   { recording_id, start_ms, end_ms, language?, genre? }   the stretch the clip was cut from
 *     playback: { url, expires_at }                                     a short-lived private URL from Media
 *     policy:   { selector, version, models: [string] }                 which picker chose it, pinned on the entry
 *     title?:   string                                                   the title it would be published with
 *     abstained: boolean, reason?: string                               "nothing worth clipping here"
 *   }
 *
 *   validateEntry(payload, { now }) → { ok: true, payload } | { ok: false, message }
 *   forViewer(payload, { now, playback }) → the payload a reader sees: playback only for a voter, never after expiry
 */
const RECORDING_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const MIN_MS = 5_000;
const MAX_MS = 180_000;
const RUBRIC = Object.freeze([
    'Interesting on its own, without the stream around it',
    'Has its setup and its payoff',
    'Starts and ends at the right moment, not mid-sentence',
    'The title says what happens',
    'Not a repeat of a clip the stream already has',
]);

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function validateEntry(payload, { now = Date.now() } = {}) {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    if (!p) return { ok: false, message: 'A live.clip entry is an object.' };
    const s = p.source && typeof p.source === 'object' ? p.source : null;
    if (!s || !RECORDING_RE.test(String(s.recording_id || ''))) return { ok: false, message: 'source.recording_id names the recording the clip comes from.' };
    const start = Number(s.start_ms);
    const end = Number(s.end_ms);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return { ok: false, message: 'source.start_ms and end_ms are whole milliseconds, end after start.' };
    const pol = p.policy && typeof p.policy === 'object' ? p.policy : null;
    const version = pol && str(pol.version, 80);
    if (!pol || !str(pol.selector, 80) || !version) return { ok: false, message: 'policy.selector and policy.version name the picker that chose it.' };
    const models = Array.isArray(pol.models) ? pol.models.map((m) => str(m, 120)).filter(Boolean).slice(0, 10) : [];
    const out = {
        source: { recording_id: String(s.recording_id), start_ms: start, end_ms: end, language: str(s.language, 16), genre: str(s.genre, 40) },
        policy: { selector: str(pol.selector, 80), version, models },
        abstained: p.abstained === true,
    };
    if (out.abstained) {
        const reason = str(p.reason, 300);
        if (!reason) return { ok: false, message: 'An abstention says why: reason.' };
        if (p.playback) return { ok: false, message: 'An abstention has no playback.' };
        out.reason = reason;
        return { ok: true, payload: out };
    }
    if (end - start < MIN_MS || end - start > MAX_MS) return { ok: false, message: 'A clip is 5 to 180 seconds long.' };
    const pb = p.playback && typeof p.playback === 'object' ? p.playback : null;
    let url = null;
    try { url = pb && new URL(String(pb.url)); } catch { url = null; }
    if (!url || url.protocol !== 'https:') return { ok: false, message: 'playback.url is an https address.' };
    const exp = pb && Date.parse(pb.expires_at);
    if (!Number.isFinite(exp) || exp <= now) return { ok: false, message: 'playback.expires_at is a time still to come.' };
    out.playback = { url: url.toString(), expires_at: new Date(exp).toISOString() };
    const title = str(p.title, 200);
    if (title) out.title = title;
    return { ok: true, payload: out };
}

/** What a reader of a live.clip entry sees: the playback only for a voter, and never once it has expired. */
function forViewer(payload, { now = Date.now(), playback = false } = {}) {
    if (!payload || typeof payload !== 'object' || !payload.playback) return payload;
    const { playback: pb, ...rest } = payload;
    if (!playback) return rest;
    const exp = Date.parse(pb.expires_at);
    if (!Number.isFinite(exp) || exp <= now) return { ...rest, playback_expired: true };
    return payload;
}

module.exports = { validateEntry, forViewer, RUBRIC, MIN_MS, MAX_MS };

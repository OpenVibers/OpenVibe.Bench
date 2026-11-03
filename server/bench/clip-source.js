'use strict';

/**
 * Which recording a live.clip submitter is allowed to submit for (item 151, C19).
 *
 * A clip names the recording it was cut from, so a service that may submit clips for one recording must not be able
 * to submit a clip for another: the payload would then carry a recording the submitter never held, and the round
 * would compare a clip of a stranger's stream against one of its own.
 *
 * The grant lives in the service token's `ns` claim, the same namespace list OpenVibe.Media reads for its own
 * objects (`capabilities.namespaceAllowed`): the namespace of a recording is `rec:<recording_id>`. A token for Live's
 * evaluation run holds `ns: ['rec:vod_*']` and may submit for exactly the recordings that namespace covers; `rec:*`
 * (or `*`) is every recording.
 *
 * A token that names no namespace is authorised for none. The check fails closed on purpose: a token with no
 * namespace grant says nothing about which recordings its holder may use, and the cost of guessing wrong here is a
 * clip of somebody else's stream sitting in a round that compares it against Live's own.
 *
 *   sourceAllowed(claims, recordingId) → { allowed: true } | { allowed: false, code, reason }
 *   namespaceOf(recordingId) → 'rec:<recording_id>'
 */

/** The namespace a recording is addressed by in a token's `ns` grant. */
function namespaceOf(recordingId) {
    const id = String(recordingId == null ? '' : recordingId).trim();
    return id ? `rec:${id}` : '';
}

/** The namespaces a token holds; a claim without a usable `ns` list holds none. */
function grantedNamespaces(claims) {
    const ns = claims && Array.isArray(claims.ns) ? claims.ns : [];
    return ns.map((n) => String(n)).filter(Boolean);
}

/**
 * May the holder of `claims` submit a clip cut from `recordingId`?
 *
 * The rules, in order: a namespace exactly naming the recording allows it; a wildcard namespace covering it
 * (`rec:*`, `*`, or `rec:vod_*` for the recordings it names) allows it; anything else is refused.
 */
function sourceAllowed(claims, recordingId) {
    const ns = namespaceOf(recordingId);
    if (!ns) return { allowed: false, code: 'bench.clip_source_missing', reason: 'A clip names the recording it was cut from.' };
    const granted = grantedNamespaces(claims);
    for (const g of granted) {
        if (g === ns || g === '*') return { allowed: true };
        // A prefix wildcard: 'rec:*' covers every recording, 'rec:vod_*' covers the recordings it names.
        if (g.endsWith('*') && ns.startsWith(g.slice(0, -1))) return { allowed: true };
    }
    return {
        allowed: false,
        code: 'bench.clip_source_denied',
        reason: `This token is granted no recording, so not ${ns}.`,
    };
}

module.exports = { sourceAllowed, namespaceOf, grantedNamespaces };

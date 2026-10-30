'use strict';

/**
 * The plain keyword parser behind the free-text box on /pick (spec 3).
 *
 * There is no model here and no network call: the words in the box are read with rules, so the pick stays free and
 * the same words always give the same answer. The parser only fills in the three controls the pick has — the kind,
 * the top price per solved task and "fast" — and says in its notes what it read, so the reader can see the reading
 * and change it.
 */

/** The numbers people write as words. */
const WORD_NUMBERS = Object.freeze({
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, fifteen: 15, twenty: 20, fifty: 50, hundred: 100,
});

/** The words that mean "fast": a time cap per task. */
const FAST_WORDS = Object.freeze(['fast', 'quicker', 'quick', 'quickly', 'snappy', 'speedy', 'speed', 'instant', 'instantly', 'low latency']);

/**
 * What people write for the kinds Bench has. The kind's own id and name are added to these at parse time, so a new
 * kind is readable without touching this table.
 */
const KIND_ALIASES = Object.freeze({
    'games.play': ['playable games', 'playable game', 'browser game', 'game', 'games'],
    'games.three': ['three.js', 'three js', '3d scene', 'three'],
    'design.svg': ['svg', 'svg art', 'illustration', 'drawing'],
    'design.ui': ['ui', 'interface screens', 'screen', 'screens'],
    'design.dataviz': ['dataviz', 'data viz', 'data visualisation', 'chart', 'graph'],
    'design.motion': ['motion', 'animation', 'effects'],
    'design.interface': ['component system', 'component', 'design system'],
    'design.page': ['landing page', 'web page', 'website', 'page'],
    'design.shader': ['shader', 'glsl'],
    'design.model3d': ['3d model', 'gltf', 'model3d'],
    'design.component': ['component arena'],
});

const clean = (text) => String(text == null ? '' : text).toLowerCase().replace(/[,;]/g, ' ').replace(/\s+/g, ' ').trim();

/** The kind the words name, or null. The longest alias wins, so "landing page" beats "page". */
function parseKind(text, kinds) {
    const hay = ' ' + clean(text) + ' ';
    const list = (Array.isArray(kinds) ? kinds : []).map((k) => ({ id: k.id, name: k.name }));
    const candidates = [];
    for (const k of list) {
        const aliases = new Set(KIND_ALIASES[k.id] || []);
        if (k.name) aliases.add(String(k.name).toLowerCase());
        aliases.add(String(k.id).toLowerCase());
        aliases.add(String(k.id).toLowerCase().replace(/\./g, ' '));
        for (const alias of aliases) {
            const a = clean(alias);
            if (!a) continue;
            if (hay.includes(' ' + a + ' ')) candidates.push({ id: k.id, alias: a });
        }
    }
    if (!candidates.length) return null;
    candidates.sort((x, y) => y.alias.length - x.alias.length || x.id.localeCompare(y.id));
    return candidates[0].id;
}

/** The top price per solved task the words name, in dollars, or null. */
function parseCost(text) {
    const t = ' ' + clean(text) + ' ';
    // Dollars: $0.02
    const dollar = /\$\s*(\d+(?:\.\d+)?)/.exec(t);
    // Cents: 2 cents, 2¢, two cents, half a cent
    const cent = /\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s*(?:cents?|¢)/.exec(t);
    const half = /\bhalf\s+(?:a\s+)?cent/.test(t);
    if (half) return 0.005;
    if (cent) {
        const raw = cent[1];
        const n = WORD_NUMBERS[raw] != null ? WORD_NUMBERS[raw] : Number(raw);
        if (Number.isFinite(n)) return Math.round(n / 100 * 1e6) / 1e6;
    }
    if (dollar) {
        const n = Number(dollar[1]);
        if (Number.isFinite(n)) return Math.round(n * 1e6) / 1e6;
    }
    return null;
}

/** True when the words ask for fast. */
function parseFast(text) {
    const t = clean(text);
    return FAST_WORDS.some((w) => new RegExp('(^|[^a-z])' + w + '([^a-z]|$)').test(t));
}

/**
 * Read the free text into the three controls. Returns { kind, max_cost, fast, notes }.
 * Nothing is guessed: an unknown word changes nothing.
 */
function parsePick(text, { kinds = [] } = {}) {
    const raw = clean(text);
    const notes = [];
    if (!raw) return { kind: null, max_cost: null, fast: false, notes, text: '' };

    const kind = parseKind(raw, kinds);
    if (kind) notes.push('read the kind as ' + kind);
    else notes.push('no kind in the words: the kind stays as it was');

    const maxCost = parseCost(raw);
    if (maxCost != null) {
        const cents = Math.round(maxCost * 10000) / 100;
        notes.push('read the price as at most ' + (cents + ' cents') + ' a solved task');
    } else notes.push('no price in the words: any price');

    const fast = parseFast(raw);
    if (fast) notes.push('read "fast" as a time cap from the run times');
    else notes.push('no "fast" in the words: no time cap');

    return { kind, max_cost: maxCost, fast, notes, text: raw };
}

module.exports = { parsePick, parseKind, parseCost, parseFast, KIND_ALIASES, FAST_WORDS, WORD_NUMBERS };

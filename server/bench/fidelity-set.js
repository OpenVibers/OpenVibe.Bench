'use strict';

/**
 * The fixed objective set used to measure provider fidelity (plan 2026-11-09, stage B5).
 *
 * Provider fidelity asks a different question from the pairwise boards: the same open-weight model is
 * served by several providers, and the question is whether each one answers the *model's* task as well
 * as the others. So the set is small, fixed, public and objective: every item has one answer a
 * deterministic check can recognise, with no LLM judge and no human vote. A provider that quantizes the
 * weights, changes the chat template, truncates the context or substitutes a different checkpoint scores
 * lower on the same items, and the difference is what the fidelity field publishes.
 *
 * The version is part of every result and every idempotency key: changing the set changes the version,
 * so two scores are never compared across sets. A score is a pass rate with a Wilson interval, not a
 * ranking: the public read never names a winner.
 */

const OBJECTIVE_SET = 'fidelity-2026-11-09.v1';

/** The system line every item is measured with: the same instructions for every provider. */
const SYSTEM = [
    'You are answering a fixed objective benchmark.',
    'Follow the requested format exactly and return only the answer, with no explanation or extra text.',
].join('\n');

const ITEMS = Object.freeze([
    {
        id: 'arithmetic',
        prompt: 'What is 37 multiplied by 24? Answer with the number only.',
        max_tokens: 16,
        check: { type: 'equals', value: '888' },
    },
    {
        id: 'extraction',
        prompt: 'Read this line: "region: fra1; status: ok". Answer with the region code only.',
        max_tokens: 16,
        check: { type: 'equals', value: 'fra1' },
    },
    {
        id: 'json',
        prompt: 'Return exactly this JSON object and nothing else: {"ok": true, "n": 3}',
        max_tokens: 40,
        check: { type: 'json', value: { ok: true, n: 3 } },
    },
    {
        id: 'repeat',
        prompt: 'Write the word aurora exactly four times in a row, separated by single spaces. Answer with the four words only.',
        max_tokens: 24,
        check: { type: 'equals', value: 'aurora aurora aurora aurora' },
    },
    {
        id: 'reverse',
        prompt: 'Spell the word "stressed" backwards. Answer with the reversed word only.',
        max_tokens: 16,
        check: { type: 'equals', value: 'desserts' },
    },
    {
        id: 'count',
        prompt: 'How many times does the letter s appear in the word "mississippi"? Answer with the number only.',
        max_tokens: 16,
        check: { type: 'equals', value: '4' },
    },
    {
        id: 'symbol',
        prompt: 'What is the chemical symbol for gold? Answer with the symbol only.',
        max_tokens: 16,
        check: { type: 'equals', value: 'Au' },
    },
    {
        id: 'next-day',
        prompt: 'If today is Wednesday, what day will it be three days from now? Answer with the day only.',
        max_tokens: 16,
        check: { type: 'equals', value: 'Saturday' },
    },
    {
        id: 'long-context',
        prompt: [
            'Read the note below to its last line, then answer the question.',
            '',
            ...Array.from({ length: 40 }, (_, i) => `Note line ${i + 1}: the archive keeps its records in order and never changes a line.`),
            'The access code is ORBIT-71.',
            '',
            'Question: what is the access code? Answer with the code only.',
        ].join('\n'),
        max_tokens: 16,
        check: { type: 'equals', value: 'ORBIT-71' },
    },
    {
        id: 'format',
        prompt: 'Reply with exactly the word READY and nothing else.',
        max_tokens: 12,
        check: { type: 'equals', value: 'READY' },
    },
]);

/** The answer without the wrappers models like to add: a code fence, quotes, a final full stop. */
function stripFence(text) {
    const s = String(text == null ? '' : text).trim();
    const fenced = /^```[a-z0-9_-]*\s*\n?([\s\S]*?)\n?```$/i.exec(s);
    return fenced ? fenced[1] : s;
}

function normalize(text) {
    return stripFence(text)
        .trim()
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/[.!]\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function parseJson(text) {
    const s = stripFence(text).trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One item's verdict. `passed` is the only thing stored; `reason` says what the check compared, so an
 * operator can see a template change without reading the answer back.
 */
function check(item, answer) {
    const got = String(answer == null ? '' : answer);
    const c = item.check || {};
    if (c.type === 'equals') {
        const passed = normalize(got) === normalize(c.value);
        return { passed, reason: passed ? 'exact' : 'not the expected answer' };
    }
    if (c.type === 'one_of') {
        const n = normalize(got);
        const passed = (c.values || []).some((v) => normalize(v) === n);
        return { passed, reason: passed ? 'one of the expected answers' : 'not one of the expected answers' };
    }
    if (c.type === 'contains_all') {
        const n = normalize(got);
        const missing = (c.values || []).filter((v) => !n.includes(normalize(v)));
        return { passed: missing.length === 0, reason: missing.length ? `missing ${missing.join(', ')}` : 'all parts present' };
    }
    if (c.type === 'json') {
        const parsed = parseJson(got);
        const passed = parsed != null && same(parsed, c.value);
        return { passed, reason: passed ? 'the expected object' : 'not the expected JSON' };
    }
    if (c.type === 'regex') {
        const passed = new RegExp(String(c.pattern), String(c.flags || 'i')).test(got);
        return { passed, reason: passed ? 'matched' : 'did not match' };
    }
    return { passed: false, reason: 'unknown check' };
}

/** The input side of a cost estimate, from the text itself (a stable convention, not a billing number). */
function promptTokens(item) {
    return Math.max(1, Math.ceil((SYSTEM.length + String(item.prompt || '').length) / 4));
}

/** The public view of the set: what was asked, never the model's answer. */
function publicSet() {
    return {
        objective_set: OBJECTIVE_SET,
        items: ITEMS.length,
        note: 'A fixed, public objective set: each item has one answer a deterministic check recognises. The same set is run through every provider that serves an open-weight model.',
        prompts: ITEMS.map((item) => ({
            id: item.id,
            prompt: item.prompt,
            max_tokens: item.max_tokens,
            check: item.check,
        })),
    };
}

module.exports = { OBJECTIVE_SET, SYSTEM, ITEMS, normalize, check, promptTokens, publicSet };

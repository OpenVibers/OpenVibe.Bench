'use strict';

/**
 * B11: a person's own prompts, pasted as a private benchmark.
 *
 * The paste is either one prompt per line, or CSV with an optional expected answer in the second column. The parser
 * is deliberately small and local: nothing here calls a model, so a prompt never leaves the request that made it.
 * Bounds: 5–50 prompts (the spec's "paste 5–50 of your real prompts").
 *
 * A CSV may carry a header (`prompt` or `prompt,expected`); without a header the form's format choice says which
 * form it is. Quotes follow RFC 4180 closely enough for a spreadsheet export: a field may be quoted, a `""` inside
 * quotes is one quote, and a quoted field may hold commas and newlines.
 */
const { kindById } = require('../kinds');

const MIN_PROMPTS = 5;
const MAX_PROMPTS = 50;
const MAX_PROMPT = 8000;
const MAX_EXPECTED = 4000;
const MAX_PASTE = 512 * 1024;
const DEFAULT_TITLE = 'Your prompts';
const TAG = 'your-prompts';

const clean = (v) => String(v == null ? '' : v).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();

/** Parse a CSV body into rows of strings. */
function csvRows(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') quoted = false;
            else field += c;
        } else if (c === '"' && field === '') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

const HEADER_PROMPT = new Set(['prompt', 'prompts', 'task', 'input']);
const HEADER_EXPECTED = new Set(['expected', 'expected answer', 'answer', 'expected_answer', 'output']);

/** The first row is a header when it names a prompt column (and at most an expected-answer column). */
function headerKind(row) {
    if (!row || !row.length) return null;
    const cells = row.map((c) => String(c || '').trim().toLowerCase());
    if (!HEADER_PROMPT.has(cells[0])) return null;
    if (cells.length === 1) return { expected: false };
    if (cells.length === 2 && HEADER_EXPECTED.has(cells[1])) return { expected: true };
    return null;
}

function promptRows(rows) {
    const out = [];
    for (const row of rows) {
        if (!row || !row.length) continue;
        const prompt = String(row[0] == null ? '' : row[0]).trim();
        if (!prompt && row.every((c) => !String(c || '').trim())) continue;
        if (!prompt) return { ok: false, code: 'bench.prompt_empty', detail: `An empty prompt is not a task (row ${out.length + 1}).` };
        const answer = row.length > 1 ? String(row[1] == null ? '' : row[1]).trim() : '';
        if (row.length > 2 && row.slice(2).some((c) => String(c || '').trim())) {
            return { ok: false, code: 'bench.csv_columns', detail: `Row ${out.length + 1} has more than two columns; use prompt,expected.` };
        }
        out.push({ prompt, expected: answer || null });
    }
    return { ok: true, prompts: out };
}

function bounds(prompts, format) {
    if (prompts.length < MIN_PROMPTS) {
        return { ok: false, code: 'bench.too_few_prompts', detail: `Paste at least ${MIN_PROMPTS} prompts; this has ${prompts.length}.` };
    }
    if (prompts.length > MAX_PROMPTS) {
        return { ok: false, code: 'bench.too_many_prompts', detail: `Paste at most ${MAX_PROMPTS} prompts; this has ${prompts.length}.` };
    }
    for (let i = 0; i < prompts.length; i++) {
        const p = prompts[i];
        if (p.prompt.length > MAX_PROMPT) return { ok: false, code: 'bench.prompt_too_long', detail: `Prompt ${i + 1} is longer than ${MAX_PROMPT} characters.` };
        if (p.expected && p.expected.length > MAX_EXPECTED) return { ok: false, code: 'bench.expected_too_long', detail: `The expected answer for prompt ${i + 1} is longer than ${MAX_EXPECTED} characters.` };
    }
    return { ok: true, prompts, format };
}

/**
 * Parse a paste.
 *
 *   format 'lines'  one prompt per line (a comma is part of the prompt)
 *   format 'csv'    comma-separated, optional expected answer in the second column
 *   format 'auto'   CSV only when the first line is a prompt/expected header, else lines
 */
function parsePrompts(raw, { format = 'auto' } = {}) {
    const text = clean(raw);
    if (!text) return { ok: false, code: 'bench.prompts_required', detail: 'Paste 5 to 50 prompts.' };
    if (text.length > MAX_PASTE) return { ok: false, code: 'bench.prompts_too_large', detail: 'That paste is too large; keep it under 512 KB.' };
    let mode = String(format || 'auto').toLowerCase();
    if (!['auto', 'lines', 'csv'].includes(mode)) mode = 'auto';
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    if (mode === 'auto') {
        const head = csvRows(lines[0] || '');
        mode = head.length && headerKind(head[0]) ? 'csv' : 'lines';
    }
    if (mode === 'csv') {
        const rows = csvRows(text);
        const header = rows.length ? headerKind(rows[0]) : null;
        const parsed = promptRows(header ? rows.slice(1) : rows);
        if (!parsed.ok) return parsed;
        return bounds(parsed.prompts, 'csv');
    }
    // Lines: one prompt per line. A line may still be a CSV header by mistake; say so rather than making it a task.
    const head = lines.length ? csvRows(lines[0]) : [];
    if (head.length && headerKind(head[0])) {
        return { ok: false, code: 'bench.prompt_header', detail: 'That looks like a CSV header. Choose the CSV format, or remove the header line.' };
    }
    return bounds(lines.map((prompt) => ({ prompt, expected: null })), 'lines');
}

/** The judges of a kind: its schema's list, else its own judge. */
function judgesFor(kind) {
    const list = kind && Array.isArray(kind.schema && kind.schema.judges) && kind.schema.judges.length
        ? kind.schema.judges
        : [kind ? kind.judge : 'automatic_grader'];
    return list.map((type) => ({ type, version: '1.0', config: {} }));
}

/**
 * The definition a paste becomes: the tasks (one per prompt), the kind's judges, mean scoring, a time limit from
 * the kind and no dollar limit. No dollar limit means the existing launcher always asks before it starts, and no
 * cap is added or raised here.
 */
function definitionFor({ prompts, kind, title, description }) {
    const k = kindById(kind) || kindById('text.answer');
    const name = String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, 160) || DEFAULT_TITLE;
    const text = String(description == null ? '' : description).trim().slice(0, 4000);
    return {
        title: name,
        description: text,
        kind: k.id,
        tags: [TAG, String(k.id).split('.')[0]],
        // Stored as unlisted in the contract document (the published shape knows public and unlisted); the
        // benchmark row's own visibility is private, and that row is what access checks read.
        visibility: 'unlisted',
        tasks: prompts.map((p, i) => ({
            id: `t${i + 1}`,
            prompt: p.prompt,
            files: [],
            expected: p.expected ? { answer: p.expected } : null,
            holdout: false,
        })),
        judges: judgesFor(k),
        scoring: { method: 'mean', scale: { min: 0, max: 100 } },
        limits: { ms: Number(k.schema && k.schema.limit_ms) || 120000, tokens: 0, usd: 0 },
        matrix: { models: [], harnesses: [] },
    };
}

module.exports = {
    parsePrompts, csvRows, definitionFor, judgesFor, headerKind,
    MIN_PROMPTS, MAX_PROMPTS, MAX_PROMPT, MAX_EXPECTED, MAX_PASTE, DEFAULT_TITLE, TAG,
};

'use strict';

/**
 * The four tools whose results a person can bring to Bench (B12): Inspect AI, Harbor, the EleutherAI
 * lm-evaluation-harness and promptfoo. The file says which one it is; when it does not, the shape of the
 * document says it.
 */
const { ImportError, MAX_UPLOAD_BYTES } = require('./limits');
const inspectTool = require('./inspect');
const harborTool = require('./harbor');
const lmEvalTool = require('./lm-eval');
const promptfooTool = require('./promptfoo');

const TOOLS = {
    inspect: inspectTool,
    harbor: harborTool,
    'lm-eval': lmEvalTool,
    promptfoo: promptfooTool,
};

const TOOL_LABELS = {
    inspect: 'Inspect AI',
    harbor: 'Harbor',
    'lm-eval': 'lm-evaluation-harness',
    promptfoo: 'promptfoo',
};

/** The tool that wrote this file, or null when it is none of ours. */
function detect(doc, filename = '') {
    const name = String(filename || '').toLowerCase();
    if (name.endsWith('.eval')) return 'inspect';
    if (inspectTool.looksLike(doc)) return 'inspect';
    if (harborTool.looksLike(doc)) return 'harbor';
    if (lmEvalTool.looksLike(doc)) return 'lm-eval';
    if (promptfooTool.looksLike(doc)) return 'promptfoo';
    return null;
}

/**
 * Read a results file: check its size, find the tool, read it.
 * The tool's own parser throws when the file is not its shape; that error is passed on as a plain message.
 */
function parse(bytes, { filename = '', tool = null } = {}) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
    if (!buf.length) throw new ImportError(422, 'bench.import_empty', 'That file is empty.');
    if (buf.length > MAX_UPLOAD_BYTES) {
        throw new ImportError(413, 'bench.import_too_large', 'That file is larger than 20 MB.');
    }
    const wanted = tool ? String(tool) : null;
    if (wanted && !TOOLS[wanted]) {
        throw new ImportError(422, 'bench.import_unknown_tool', 'I do not know that tool.');
    }
    if (wanted) {
        const out = TOOLS[wanted].parse(buf);
        out.filename = String(filename || '');
        return out;
    }
    // No tool named: look at the shape. Inspect's log is read first (it may be a zip), then the others.
    const errors = [];
    for (const key of ['inspect', 'harbor', 'lm-eval', 'promptfoo']) {
        try {
            const out = TOOLS[key].parse(buf);
            out.filename = String(filename || '');
            return out;
        } catch (err) {
            if (err instanceof ImportError) throw err;   // a size or a shape problem is the answer
            errors.push(key + ': ' + ((err && err.message) || 'unknown'));
        }
    }
    throw new ImportError(422, 'bench.import_unknown_format',
        'I do not know that file. It should be an Inspect AI log, a Harbor results.json, an lm-evaluation-harness results.json or a promptfoo output.json.');
}

module.exports = { TOOLS, TOOL_LABELS, detect, parse, ImportError, MAX_UPLOAD_BYTES };

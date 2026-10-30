'use strict';

/**
 * What an uploaded file may be (B12). The rules are the same for every tool:
 *
 *   20 MB   the file as it arrives
 *   100 MB  everything it unpacks to (a zip that says more is refused, so a bomb never fills the disk)
 *   64      how deep a JSON document may nest
 *
 * Nothing in the file is ever run. A name in the file is never used as a path: the entries of a zip are read in
 * memory, and only their bytes matter.
 */
const zlib = require('zlib');

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_ZIP_ENTRIES = 2000;
const MAX_COMPRESSION_RATIO = 200;

class ImportError extends Error {
    constructor(status, code, detail) {
        super(detail);
        this.name = 'ImportError';
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}

/** How deep a parsed document nests, counted with an explicit stack so a deep file cannot blow the call stack. */
function depthOf(value) {
    let max = 0;
    const stack = [[value, 1]];
    while (stack.length) {
        const [node, depth] = stack.pop();
        if (depth > max) max = depth;
        if (node && typeof node === 'object') {
            for (const child of Object.values(node)) {
                if (child && typeof child === 'object') stack.push([child, depth + 1]);
            }
        }
        if (stack.length > 200000) return max + 1;   // a document this wide is refused on its size alone
    }
    return max;
}

/** JSON with a size and a depth limit: a file that is not JSON, or nests too deep, is refused, never guessed at. */
function parseJson(text, { maxDepth = MAX_JSON_DEPTH, what = 'file' } = {}) {
    const body = String(text == null ? '' : text);
    if (!body.trim()) throw new ImportError(422, 'bench.import_empty', 'That ' + what + ' is empty.');
    let value;
    try {
        value = JSON.parse(body);
    } catch (err) {
        throw new ImportError(422, 'bench.import_not_json', 'That ' + what + ' is not JSON I can read.');
    }
    if (depthOf(value) > maxDepth) {
        throw new ImportError(422, 'bench.import_too_deep', 'That ' + what + ' nests too deeply for me to read.');
    }
    return value;
}

/** The bytes as text, refusing anything that is not text (a binary file is not a results file). */
function asText(bytes, { what = 'file' } = {}) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
    // A NUL byte or a lone high-byte run means binary: refuse rather than mangle it.
    let nul = 0;
    for (let i = 0; i < buf.length && nul < 2; i += 1) if (buf[i] === 0) nul += 1;
    if (nul >= 2) throw new ImportError(422, 'bench.import_not_text', 'That ' + what + ' is not a text file.');
    return buf.toString('utf8');
}

// ── zip ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * The entries of a zip, in memory. Only what a results file needs: the names and the bytes. A zip that claims
 * more than it may unpack to, or that hides a thousand parts, is refused before anything is inflated.
 */
function readZip(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    // The end-of-central-directory record sits at the end, behind a comment of up to 64 KB.
    let eocd = -1;
    const from = Math.max(0, buf.length - (22 + 0xffff));
    for (let i = buf.length - 22; i >= from; i -= 1) {
        if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new ImportError(422, 'bench.import_not_zip', 'That file is not a zip I can read.');
    const count = buf.readUInt16LE(eocd + 10);
    const size = buf.readUInt32LE(eocd + 12);
    const offset = buf.readUInt32LE(eocd + 16);
    if (count > MAX_ZIP_ENTRIES) throw new ImportError(413, 'bench.import_too_many_parts', 'That zip holds too many parts.');
    if (size > buf.length) throw new ImportError(422, 'bench.import_bad_zip', 'That zip is damaged.');
    const entries = [];
    let at = offset;
    let total = 0;
    for (let n = 0; n < count; n += 1) {
        if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) {
            throw new ImportError(422, 'bench.import_bad_zip', 'That zip is damaged.');
        }
        const method = buf.readUInt16LE(at + 10);
        const compressed = buf.readUInt32LE(at + 20);
        const uncompressed = buf.readUInt32LE(at + 24);
        const nameLen = buf.readUInt16LE(at + 28);
        const extraLen = buf.readUInt16LE(at + 30);
        const commentLen = buf.readUInt16LE(at + 32);
        const localOffset = buf.readUInt32LE(at + 42);
        const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
        at += 46 + nameLen + extraLen + commentLen;
        if (uncompressed > MAX_DECOMPRESSED_BYTES) {
            throw new ImportError(413, 'bench.import_unpacks_too_much', 'That zip unpacks to more than 100 MB.');
        }
        if (compressed > 0 && uncompressed / compressed > MAX_COMPRESSION_RATIO) {
            throw new ImportError(413, 'bench.import_zip_bomb', 'That zip packs far too much into too little; I will not open it.');
        }
        total += uncompressed;
        if (total > MAX_DECOMPRESSED_BYTES) {
            throw new ImportError(413, 'bench.import_unpacks_too_much', 'That zip unpacks to more than 100 MB.');
        }
        entries.push({ name, method, compressed, uncompressed, localOffset });
    }
    return entries;
}

/** The bytes of one entry of a zip, inflated in memory. */
function readZipEntry(buffer, entry) {
    const buf = buffer;
    const at = entry.localOffset;
    if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) {
        throw new ImportError(422, 'bench.import_bad_zip', 'That zip is damaged.');
    }
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const start = at + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + entry.compressed);
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method !== 8) throw new ImportError(422, 'bench.import_bad_zip', 'That zip uses a compression I do not know.');
    let out;
    try {
        out = zlib.inflateRawSync(raw, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    } catch (err) {
        throw new ImportError(422, 'bench.import_bad_zip', 'That zip could not be unpacked.');
    }
    if (out.length > MAX_DECOMPRESSED_BYTES) {
        throw new ImportError(413, 'bench.import_unpacks_too_much', 'That zip unpacks to more than 100 MB.');
    }
    return out;
}

/** Every JSON part of a zip, biggest first: the results log of an .eval file is the one that matters. */
function jsonPartsOfZip(buffer) {
    const entries = readZip(buffer);
    const out = [];
    for (const entry of entries) {
        if (entry.uncompressed > MAX_DECOMPRESSED_BYTES) {
            throw new ImportError(413, 'bench.import_unpacks_too_much', 'That zip unpacks to more than 100 MB.');
        }
        if (!/\.json$/i.test(entry.name)) continue;
        out.push({ name: entry.name, data: readZipEntry(buffer, entry) });
    }
    if (!out.length) throw new ImportError(422, 'bench.import_no_json', 'That zip holds no JSON file I can read.');
    out.sort((a, b) => b.data.length - a.data.length);
    return out;
}

module.exports = {
    MAX_UPLOAD_BYTES, MAX_DECOMPRESSED_BYTES, MAX_JSON_DEPTH, MAX_ZIP_ENTRIES, MAX_COMPRESSION_RATIO,
    ImportError, depthOf, parseJson, asText, readZip, readZipEntry, jsonPartsOfZip,
};

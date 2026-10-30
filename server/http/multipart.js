'use strict';

/**
 * A multipart/form-data body, read in memory (B12). Express has no body parser for it and a results file needs
 * one: the upload form posts one file and nothing else.
 *
 * The body is already capped by the caller (express.raw with a limit), so this only has to find the parts.
 * A part's name is used as a field name; a part's filename is only ever shown, never used as a path.
 */
function parseMultipart(buffer, contentType) {
    const type = String(contentType || '');
    const at = type.toLowerCase().indexOf('multipart/form-data');
    if (at < 0) return null;
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type.slice(at));
    if (!match) return null;
    const boundary = (match[1] || match[2] || '').trim();
    if (!boundary || boundary.length > 200) return null;
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    const delimiter = Buffer.from('--' + boundary);
    const parts = [];
    let start = buf.indexOf(delimiter);
    if (start < 0) return null;
    start += delimiter.length;
    for (let guard = 0; guard < 50; guard += 1) {
        if (start + 2 <= buf.length && buf[start] === 0x2d && buf[start + 1] === 0x2d) break;   // the closing --
        // The part's headers run to the first blank line.
        const headEnd = buf.indexOf('\r\n\r\n', start, 'latin1');
        if (headEnd < 0) break;
        const head = buf.subarray(start, headEnd).toString('latin1');
        const bodyStart = headEnd + 4;
        const next = buf.indexOf(delimiter, bodyStart);
        if (next < 0) break;
        const bodyEnd = Math.max(bodyStart, next - 2);   // the CRLF before the boundary belongs to the delimiter
        const name = /name="([^"]*)"/i.exec(head);
        const filename = /filename="([^"]*)"/i.exec(head);
        parts.push({
            name: name ? name[1] : '',
            filename: filename ? filename[1] : null,
            contentType: (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || null,
            data: buf.subarray(bodyStart, bodyEnd),
        });
        start = next + delimiter.length;
    }
    return { parts };
}

module.exports = { parseMultipart };

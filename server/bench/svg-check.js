'use strict';

// Cheap layout check for generated SVGs. It checks the geometry we can measure without a browser;
// a missing or unsupported shape is reported rather than silently treating an empty drawing as valid.
const NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi;
const DRAWING = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const identity = [1, 0, 0, 1, 0, 0];
const mul = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const point = (m, x, y) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
const nums = (s) => [...String(s || '').matchAll(NUMBER)].map((m) => Number(m[0]));
const attr = (s) => Object.fromEntries([...s.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1], m[2] === undefined ? m[3] : m[2]]));
const n = (a, key, fallback = 0) => a[key] == null ? fallback : Number(a[key]);
const mod = (a) => (a % (2*Math.PI) + 2*Math.PI) % (2*Math.PI);

function arcPoints(x1, y1, rx, ry, degrees, large, sweep, x2, y2) {
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (!rx || !ry || (x1 === x2 && y1 === y2)) return [];
    const phi = degrees * Math.PI / 180, c = Math.cos(phi), s = Math.sin(phi);
    const dx = (x1-x2)/2, dy = (y1-y2)/2;
    const xp = c*dx+s*dy, yp = -s*dx+c*dy;
    const stretch = Math.sqrt(xp*xp/(rx*rx)+yp*yp/(ry*ry));
    if (stretch > 1) { rx *= stretch; ry *= stretch; }
    const numerator = Math.max(0, rx*rx*ry*ry-rx*rx*yp*yp-ry*ry*xp*xp);
    const denominator = rx*rx*yp*yp+ry*ry*xp*xp;
    const factor = (Boolean(large) === Boolean(sweep) ? -1 : 1) * Math.sqrt(numerator/denominator);
    const cxp = factor*rx*yp/ry, cyp = -factor*ry*xp/rx;
    const cx = c*cxp-s*cyp+(x1+x2)/2, cy = s*cxp+c*cyp+(y1+y2)/2;
    const start = Math.atan2((yp-cyp)/ry, (xp-cxp)/rx);
    const end = Math.atan2((-yp-cyp)/ry, (-xp-cxp)/rx);
    const span = sweep ? mod(end-start) : mod(start-end);
    const candidates = [Math.atan2(-s*ry, c*rx), Math.atan2(-s*ry, c*rx)+Math.PI,
        Math.atan2(c*ry, s*rx), Math.atan2(c*ry, s*rx)+Math.PI];
    return candidates.filter((angle) => (sweep ? mod(angle-start) : mod(start-angle)) <= span+1e-9)
        .map((angle) => [cx+c*rx*Math.cos(angle)-s*ry*Math.sin(angle), cy+s*rx*Math.cos(angle)+c*ry*Math.sin(angle)]);
}

function transform(source) {
    let m = identity;
    for (const call of String(source || '').matchAll(/(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g)) {
        const v = nums(call[2]);
        let next;
        if (call[1] === 'matrix' && v.length === 6) next = v;
        else if (call[1] === 'translate' && v.length >= 1) next = [1, 0, 0, 1, v[0], v[1] || 0];
        else if (call[1] === 'scale' && v.length >= 1) next = [v[0], 0, 0, v[1] == null ? v[0] : v[1], 0, 0];
        else if (call[1] === 'rotate' && v.length >= 1) {
            const c = Math.cos(v[0] * Math.PI / 180), s = Math.sin(v[0] * Math.PI / 180);
            const r = [c, s, -s, c, 0, 0];
            next = v.length >= 3 ? mul(mul([1, 0, 0, 1, v[1], v[2]], r), [1, 0, 0, 1, -v[1], -v[2]]) : r;
        } else return null;
        m = mul(m, next);
    }
    if (String(source || '').replace(/(matrix|translate|scale|rotate)\s*\([^)]*\)/g, '').trim()) return null;
    return m;
}

function pathPoints(d) {
    const tokens = String(d || '').match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) || [];
    const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
    const out = [];
    let i = 0, command = null, x = 0, y = 0, startX = 0, startY = 0;
    while (i < tokens.length) {
        if (/^[a-z]$/i.test(tokens[i])) command = tokens[i++];
        if (!command || !Object.hasOwn(arity, command.toUpperCase())) return null;
        const upper = command.toUpperCase(), count = arity[upper];
        if (upper === 'Z') { x = startX; y = startY; out.push([x, y]); command = null; continue; }
        if (i + count > tokens.length || tokens.slice(i, i + count).some((t) => /^[a-z]$/i.test(t))) return null;
        const v = tokens.slice(i, i += count).map(Number);
        const rel = command !== upper, ox = rel ? x : 0, oy = rel ? y : 0;
        if (upper === 'H') x = ox + v[0];
        else if (upper === 'V') y = oy + v[0];
        else if (upper === 'A') {
            const x2 = ox+v[5], y2 = oy+v[6];
            out.push(...arcPoints(x, y, v[0], v[1], v[2], v[3], v[4], x2, y2));
            x = x2; y = y2;
        }
        else {
            if (upper === 'C') out.push([ox+v[0], oy+v[1]], [ox+v[2], oy+v[3]]);
            if (upper === 'S' || upper === 'Q') out.push([ox+v[0], oy+v[1]]);
            x = ox + v[count-2]; y = oy + v[count-1];
        }
        out.push([x, y]);
        if (upper === 'M') { startX = x; startY = y; command = rel ? 'l' : 'L'; }
    }
    return out;
}

function shapePoints(tag, a) {
    if (tag === 'path') return pathPoints(a.d);
    if (tag === 'polyline' || tag === 'polygon') {
        const v = nums(a.points);
        if (v.length < 2 || v.length % 2) return null;
        return Array.from({ length: v.length / 2 }, (_, i) => [v[2*i], v[2*i+1]]);
    }
    if (tag === 'line') return [[n(a, 'x1'), n(a, 'y1')], [n(a, 'x2'), n(a, 'y2')]];
    if (tag === 'rect') {
        const x = n(a, 'x'), y = n(a, 'y'), w = n(a, 'width'), h = n(a, 'height');
        return w < 0 || h < 0 ? null : [[x,y], [x+w,y], [x,y+h], [x+w,y+h]];
    }
    if (tag === 'circle' || tag === 'ellipse') {
        const x = n(a, 'cx'), y = n(a, 'cy'), rx = n(a, tag === 'circle' ? 'r' : 'rx'), ry = tag === 'circle' ? rx : n(a, 'ry');
        return rx < 0 || ry < 0 ? null : [[x-rx,y-ry], [x+rx,y-ry], [x-rx,y+ry], [x+rx,y+ry]];
    }
    return null;
}

function separateIcons(prompt) {
    const text = String(prompt || '');
    const match = /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b[^.!?]{0,80}?\b(?:icons?|glyphs?)\b/i.exec(text)
        || /\bicon set of\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i.exec(text);
    if (!match) return 0;
    const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    return Number(match[1]) || words.indexOf(match[1].toLowerCase()) + 1;
}

function checkSvg(svg, prompt = '') {
    const issues = [];
    const source = String(svg || '');
    const root = /<svg\b([^>]*)>/i.exec(source);
    const box = root && nums(attr(root[1]).viewBox);
    if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) {
        return { status: 'failed', issues: ['missing_viewbox'] };
    }
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    const groups = [];
    const stack = [{ tag: 'root', matrix: identity, stroke: 'none', strokeWidth: 1 }];
    let shapes = 0;
    for (const match of source.matchAll(/<\s*(\/?)\s*([a-z][\w:-]*)\b([^>]*)>/gi)) {
        const closing = Boolean(match[1]), tag = match[2].toLowerCase();
        if (closing) { if (stack.length > 1 && stack.at(-1).tag === tag) stack.pop(); continue; }
        const a = attr(match[3]);
        const own = transform(a.transform);
        if (!own) { issues.push('unsupported_transform'); continue; }
        const matrix = mul(stack.at(-1).matrix, own);
        const stroke = a.stroke || stack.at(-1).stroke;
        const strokeWidth = a['stroke-width'] == null ? stack.at(-1).strokeWidth : Number(a['stroke-width']);
        if (tag === 'g') groups.push({ origin: point(matrix, 0, 0), shapes: 0 });
        if (DRAWING.has(tag)) {
            const pts = shapePoints(tag, a);
            if (!pts || !pts.length || pts.some((p) => !p.every(Number.isFinite))) issues.push('unmeasurable_shape');
            else {
                shapes++;
                const shapeBounds = [Infinity, Infinity, -Infinity, -Infinity];
                for (const p of pts) {
                    const [x, y] = point(matrix, ...p);
                    shapeBounds[0] = Math.min(shapeBounds[0], x); shapeBounds[1] = Math.min(shapeBounds[1], y);
                    shapeBounds[2] = Math.max(shapeBounds[2], x); shapeBounds[3] = Math.max(shapeBounds[3], y);
                }
                const width = stroke !== 'none' ? strokeWidth/2 : 0;
                if (!Number.isFinite(width) || width < 0) issues.push('unmeasurable_stroke');
                else {
                    const dx = width*Math.hypot(matrix[0], matrix[2]), dy = width*Math.hypot(matrix[1], matrix[3]);
                    bounds[0] = Math.min(bounds[0], shapeBounds[0]-dx); bounds[1] = Math.min(bounds[1], shapeBounds[1]-dy);
                    bounds[2] = Math.max(bounds[2], shapeBounds[2]+dx); bounds[3] = Math.max(bounds[3], shapeBounds[3]+dy);
                }
                if (stack.at(-1).group != null) groups[stack.at(-1).group].shapes++;
            }
        }
        if (!/\/\s*$/.test(match[3]) && !['path','rect','circle','ellipse','line','polyline','polygon','stop','use','image'].includes(tag)) {
            stack.push({ tag, matrix, stroke, strokeWidth, group: tag === 'g' ? groups.length - 1 : stack.at(-1).group });
        }
    }
    if (!shapes) issues.push('empty_drawing');
    const epsilon = 0.01;
    if (shapes && (bounds[0] < box[0]-epsilon || bounds[1] < box[1]-epsilon || bounds[2] > box[0]+box[2]+epsilon || bounds[3] > box[1]+box[3]+epsilon)) issues.push('outside_viewbox');
    const expected = separateIcons(prompt);
    if (expected > 1) {
        const origins = new Set(groups.filter((g) => g.shapes).map((g) => g.origin.map((v) => v.toFixed(2)).join(',')));
        if (origins.size < expected) issues.push('overlapping_icon_origins');
    }
    return { status: issues.length ? 'failed' : 'ok', issues: [...new Set(issues)], bounds: shapes ? bounds : null, viewBox: box, icon_groups: expected ? groups.length : undefined };
}

module.exports = { checkSvg, separateIcons };

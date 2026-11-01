'use strict';

/**
 * The isolated render origin (showcase spec 2). Script-bearing kinds cannot run inside Bench's own page: the inert
 * sandbox (server/bench/sanitize.js) allows no scripts, so a game, a canvas loop, three.js or a shader cannot run.
 *
 * So every model output is served from its own path on a separate, cookie-less origin (bench-render.openvibe.services):
 *
 *   GET /render/w/:entryId   the trusted wrapper: the clock, the stop button and the child frame
 *   GET /render/e/:entryId   the model's own output, in a document that carries the strict CSP
 *
 * The child frame is <iframe sandbox="allow-scripts">: no allow-same-origin (the document gets an opaque origin, so it
 * cannot read our cookies or our DOM), no allow-forms, no allow-popups and no allow-top-navigation. The CSP holds the
 * line on the network: connect-src 'none', no external images, fonts or scripts, only the pinned render origin.
 */

const crypto = require('crypto');
const vm = require('vm');
const { truncateBytes, MAX_BYTES } = require('./sanitize');

const RENDER_ORIGIN = String(process.env.OV_RENDER_ORIGIN || 'https://bench-render.openvibe.services').replace(/\/+$/, '');
/** The only origins a model output may load code, styles, images or fonts from. */
const PINNED_ORIGINS = Object.freeze([RENDER_ORIGIN]);
/** Version-pinned libraries the render origin vendors (three 0.170.0, server/http/vendor.js). A model imports these by
 *  absolute URL, or by the import map's bare names ("three", "three/addons/…"). */
const VENDOR = Object.freeze({
    three: RENDER_ORIGIN + '/vendor/three.module.js',
    addons: RENDER_ORIGIN + '/vendor/three/addons/',
});
/** The pages that may frame the wrapper and the model documents. OpenVibe.Design shows its arena's blind pairs in
 *  these frames (plan L51: Design's /arena is a view of Bench's design kinds). */
const FRAME_ANCESTORS = 'https://bench.openvibe.services https://openvibe.report https://openvibe.design';
/** The wrapper's own policy: its one inline script under a fresh nonce, its child frame only from the render origin. */
function wrapperCsp(nonce) {
    return "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; frame-src " + RENDER_ORIGIN
        + "; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors " + FRAME_ANCESTORS;
}
/** The policy as a <meta> tag carries it: browsers ignore frame-ancestors there (and warn); the header has it. */
const metaPolicy = (p) => p.split('; ').filter((d) => !d.startsWith('frame-ancestors')).join('; ');
/** The sandbox attributes for every model frame: scripts yes, everything else no. */
const SANDBOX = 'allow-scripts';
/** The wrapper's own frame on the showcase pages. The wrapper is our code on the cookie-less render origin, and it keeps
 *  that origin: frame-ancestors on the model document checks every ancestor, and a wrapper with an opaque origin matched
 *  none, so Chrome refused every model frame. The model output stays in SANDBOX (opaque) one level down. */
const WRAPPER_SANDBOX = 'allow-scripts allow-same-origin';
/** The default wall-clock a kind may run before the wrapper stops it. */
const DEFAULT_LIMIT_MS = 20000;
/** The hard size cap on one entry, the same cap sanitizeHtml already applies. */
const MAX_ENTRY_BYTES = MAX_BYTES;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The payload field each showcase entry type renders from. A model answers in text; this is where that text goes. */
const PAYLOAD_FIELD = Object.freeze({
    html_game: 'html', three_scene: 'html', motion_html: 'html', ui_page: 'html', dataviz_page: 'html', component_set: 'html',
    svg_art: 'svg', shader_glsl: 'glsl',
});
/** The code inside a model's answer: the first fenced block when it wrote one (```html … ```), else the whole answer. */
function codeOf(text) {
    const t = String(text == null ? '' : text);
    const m = /```[\w-]*[^\S\n]*\n([\s\S]*?)```/.exec(t);
    return (m ? m[1] : t).trim();
}
/** A generated answer as the payload its entry type renders: { html } | { svg } | { glsl }, or { text } for the rest. */
function payloadFor(entryType, text) {
    const field = PAYLOAD_FIELD[entryType];
    return field ? { [field]: codeOf(text) } : { text: String(text == null ? '' : text) };
}
/** An entry stored before payloadFor existed held only { text }: read it as its entry type's field. */
function renderablePayload(kind, payload) {
    const p = payload || {};
    if (p.html || p.svg || p.glsl || p.gltf_base64 || typeof p.text !== 'string') return p;
    return { ...p, ...payloadFor(kind && kind.entry, p.text) };
}

/** The CSP a model document runs under. The nonce is ours; model scripts get it, nothing else does. */
function cspFor(nonce) {
    return [
        "default-src 'none'",
        "script-src 'nonce-" + nonce + "' " + PINNED_ORIGINS.join(' '),
        "style-src 'unsafe-inline' " + PINNED_ORIGINS.join(' '),
        "img-src data: " + PINNED_ORIGINS.join(' '),
        "font-src " + PINNED_ORIGINS.join(' '),
        "connect-src 'none'",
        "media-src 'none'",
        "object-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        // The model document's parent is the wrapper, on the render origin itself; every ancestor must be listed.
        "frame-ancestors " + RENDER_ORIGIN + ' ' + FRAME_ANCESTORS,
    ].join('; ');
}

/** Give every script tag in the model output our nonce, so only our own script-src nonce runs it. A tag that already
 *  names a nonce (the model guessing one, or our __NONCE__ placeholder) gets ours in its place: one nonce per tag. */
function applyNonce(html, nonce) {
    return String(html == null ? '' : html)
        .replace(/(<script\b[^>]*?)\snonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1')
        .replace(/<script\b/gi, '<script nonce="' + nonce + '"');
}

/** The inline scripts a browser would run as classic scripts, in document order. Modules are left alone: their top
 *  level is its own scope, and vm.Script cannot parse import/export. */
function inlineScripts(html) {
    const text = String(html == null ? '' : html);
    const scripts = [];
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let m;
    while ((m = re.exec(text))) {
        const attrs = m[1] || '';
        if (/\bsrc\s*=/i.test(attrs)) continue;
        const typeMatch = /type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
        const type = typeMatch ? String(typeMatch[1] || typeMatch[2] || typeMatch[3] || '').trim().toLowerCase() : '';
        if (type === 'module' || (type && !/^(?:text\/javascript|application\/javascript)$/.test(type))) continue;
        const openEnd = m.index + m[0].indexOf('>') + 1;
        scripts.push({ code: m[2], start: m.index, length: m[0].length, openEnd, originalLength: m[2].length });
    }
    return scripts;
}

/** Which characters of a script are code, not string, template or comment: a declaration in a string is not a
 *  declaration. The mask also gives the brace depth at each position, so a shadowing declaration in a nested block is
 *  not confused with a duplicate in the same scope. */
function codeMap(code) {
    const isCode = new Uint8Array(code.length);
    const depth = new Int32Array(code.length + 1);
    let state = 'code';
    let d = 0;
    for (let i = 0; i < code.length; i++) {
        const c = code[i], n = code[i + 1];
        depth[i] = d;
        if (state === 'code') {
            if (c === '/' && n === '/') { state = 'line'; i++; continue; }
            if (c === '/' && n === '*') { state = 'block'; i++; continue; }
            isCode[i] = 1;
            if (c === "'") state = 'single';
            else if (c === '"') state = 'double';
            else if (c === '`') state = 'template';
            else if (c === '{') d++;
            else if (c === '}') d--;
        } else if (state === 'line') {
            if (c === '\n') state = 'code';
        } else if (state === 'block') {
            if (c === '*' && n === '/') { state = 'code'; i++; }
        } else if (state === 'single') {
            if (c === '\\') i++; else if (c === "'") state = 'code';
        } else if (state === 'double') {
            if (c === '\\') i++; else if (c === '"') state = 'code';
        } else if (state === 'template') {
            if (c === '\\') i++; else if (c === '`') state = 'code';
        }
    }
    depth[code.length] = d;
    return { isCode, depth };
}

/**
 * A model answer is not trusted to compile. The browser runs a page's classic scripts in one global scope, so two
 * declarations of the same const/let - in one script or across two - throw "Identifier 'x' has already been declared"
 * before either script runs, and every showcase page that frames it reports an uncaught error (11-01: the seeded
 * dataviz entry declares maxVal twice, once per chart scale). Join the duplicate declarations at the same brace depth
 * into one binding (the first becomes let, the later ones assignments) and use the result only when it then compiles.
 * That keeps the model's output running rather than leaving a blank frame. Returns null when there is nothing to
 * repair or the repair does not compile; the caller then leaves the bad script out.
 */
function repairDuplicateDeclarations(html) {
    const text = String(html == null ? '' : html);
    const scripts = inlineScripts(text);
    if (!scripts.length) return null;
    let changed = false;
    for (let attempt = 0; attempt < 6; attempt++) {
        const joined = scripts.map((s) => s.code).join('\n;\n');
        try {
            new vm.Script(joined, { filename: 'model-scripts.js' });
            break;
        } catch (err) {
            const dup = /Identifier '([^']+)' has already been declared/.exec(String((err && err.message) || err));
            if (!dup) return null;
            const name = dup[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const decls = [];
            for (let si = 0; si < scripts.length; si++) {
                const { isCode, depth } = codeMap(scripts[si].code);
                const re = new RegExp('\\b(const|let|var)\\s+' + name + '\\b', 'g');
                let m;
                while ((m = re.exec(scripts[si].code))) {
                    if (!isCode[m.index]) continue;
                    decls.push({ si, index: m.index, keyword: m[1], keywordEnd: m.index + m[1].length, depth: depth[m.index] });
                }
            }
            const byDepth = new Map();
            for (const d of decls) {
                if (!byDepth.has(d.depth)) byDepth.set(d.depth, []);
                byDepth.get(d.depth).push(d);
            }
            // The shallowest depth with a duplicate is the one the parser named: a legal shadowing declaration in a
            // deeper block cannot be the duplicate, and a conflicting top-level one is shallower.
            const group = [...byDepth.entries()].filter(([, g]) => g.length > 1).sort((a, b) => a[0] - b[0])[0];
            if (!group) return null;
            const declsInGroup = group[1].sort((a, b) => a.si - b.si || a.index - b.index);
            const edits = new Map();
            for (let i = 0; i < declsInGroup.length; i++) {
                const d = declsInGroup[i];
                const code = scripts[d.si].code;
                let end = d.keywordEnd;
                let replacement = '';
                if (i === 0) {
                    if (d.keyword !== 'const') continue;
                    replacement = 'let';
                } else {
                    // Drop the keyword and the whitespace after it: "let maxVal = 1" becomes "maxVal = 1".
                    while (end < code.length && /\s/.test(code[end])) end++;
                }
                if (!edits.has(d.si)) edits.set(d.si, []);
                edits.get(d.si).push({ from: d.index, to: end, text: replacement });
            }
            for (const [si, list] of edits) {
                list.sort((a, b) => b.from - a.from);
                let code = scripts[si].code;
                for (const e of list) code = code.slice(0, e.from) + e.text + code.slice(e.to);
                scripts[si].code = code;
            }
            changed = true;
        }
    }
    if (!changed) return null;
    let out = text;
    for (let i = scripts.length - 1; i >= 0; i--) {
        const s = scripts[i];
        out = out.slice(0, s.openEnd) + s.code + out.slice(s.openEnd + s.originalLength);
    }
    return out;
}

/** The scripts that still cannot run, alone or after the ones before them; the repair above handles the duplicate
 *  declaration case, this is the honest fallback for every other syntax error. */
function scriptProblems(html) {
    const scripts = inlineScripts(html);
    const bad = new Map();
    let prefix = '';
    for (const script of scripts) {
        try {
            new vm.Script(script.code, { filename: 'model-script.js' });
        } catch (err) {
            bad.set(script, err);
            continue;
        }
        try {
            new vm.Script(prefix + '\n;\n' + script.code, { filename: 'model-scripts.js' });
            prefix += '\n;\n' + script.code;
        } catch (err) {
            bad.set(script, err);
        }
    }
    return { scripts, bad };
}

/** The document without the scripts that cannot run, and a visible line naming the reason (the rest of the output
 *  still renders: its HTML and CSS are the model's own work, and often all that can be shown). */
function withoutUnrunnableScripts(html) {
    let text = String(html == null ? '' : html);
    const repaired = repairDuplicateDeclarations(text);
    if (repaired) text = repaired;
    const { scripts, bad } = scriptProblems(text);
    if (!bad.size) return text;
    let out = text;
    for (const script of scripts.slice().reverse()) {
        if (bad.has(script)) out = out.slice(0, script.start) + out.slice(script.start + script.length);
    }
    const messages = [...new Set([...bad.values()].map((err) => String((err && err.message) || err)))];
    const note = '<div class="ov-entry-script-error" data-ov-entry-script-error="1" role="status"'
        + ' style="margin:0;padding:.6rem .8rem;font:600 12px/1.45 system-ui,sans-serif;background:#3a1d1d;color:#ffd7d7;border-bottom:1px solid #6b3030">'
        + 'This output\'s script could not run: <code style="font-weight:500">' + esc(messages.join('; ')) + '</code></div>';
    const body = /<body\b[^>]*>/i.exec(out);
    if (body) {
        const at = body.index + body[0].length;
        return out.slice(0, at) + note + out.slice(at);
    }
    return note + out;
}

/** The namespace names an SVG needs. They look like URLs but are never fetched, so the pass below keeps them: without
 *  them the browser reads the document as plain XML and shows only its text (11-01: every svg_art entry did). */
const SVG_NAMESPACES = Object.freeze([
    'http://www.w3.org/2000/svg',
    'http://www.w3.org/1999/xlink',
    'http://www.w3.org/XML/1998/namespace',
]);

/** SVG-specific pass (spec 2.3): no script, no foreignObject, no external reference, no event handler, no @import. */
function sanitizeSvg(input) {
    let s = input == null ? '' : String(input);
    const kept = [];
    s = s.replace(/(xmlns(?::[\w-]+)?\s*=\s*)(["'])(https?:\/\/[^"']*)\2/gi, (m, attr, q, url) => {
        if (!SVG_NAMESPACES.includes(url)) return m;
        kept.push(url);
        return attr + q + '\u0000NS' + (kept.length - 1) + '\u0000' + q;
    });
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
    s = s.replace(/<\/?script\b[^>]*>/gi, '');
    s = s.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, '');
    s = s.replace(/<\/?foreignObject\b[^>]*>/gi, '');
    s = s.replace(/<\/?(?:iframe|object|embed|audio|video)\b[^>]*>/gi, '');
    s = s.replace(/@import[^;"']*;?/gi, '');
    s = s.replace(/\son[a-z0-9_:.-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    s = s.replace(/(xlink:href|href|src)\s*=\s*(["'])\s*(?:https?:)?\/\/[^"']*\2/gi, '$1="#blocked"');
    s = s.replace(/(?:https?:)?\/\/[\w.-]+/gi, 'blocked:');
    s = s.replace(/javascript\s*:/gi, 'blocked:');
    s = s.replace(/\u0000NS(\d+)\u0000/g, (m, i) => kept[Number(i)] || '');
    return truncateBytes(s, MAX_ENTRY_BYTES);
}

/** Shown on its own in a frame, the drawing fills the frame: the root's fixed width and height give way to 100% when
 *  it has a viewBox to scale by (the aspect ratio is kept), so a 1200 by 700 poster is not cropped in a small pane. */
function fitSvg(svg) {
    const s = String(svg == null ? '' : svg);
    const m = /<svg\b[^>]*>/i.exec(s);
    if (!m || !/\sviewBox\s*=/i.test(m[0])) return s;
    const root = m[0].replace(/\s(width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/<svg\b/i, '<svg width="100%" height="100%"');
    return s.slice(0, m.index) + root + s.slice(m.index + m[0].length);
}

/** The wall-clock a kind may run, from the kind itself. */
function limitMsOf(kind) {
    const ms = Number(kind && (kind.limit_ms || (kind.schema && kind.schema.limit_ms)));
    return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 300000) : DEFAULT_LIMIT_MS;
}

/** 'script' kinds run in the isolated frame; 'static' kinds are shown as an inert image. */
function modeOf(kind) {
    const r = kind && (kind.renderer || (kind.schema && kind.schema.renderer));
    return r === 'static' ? 'static' : 'script';
}

function head(nonce, extra) {
    return '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<meta http-equiv="Content-Security-Policy" content="' + esc(metaPolicy(cspFor(nonce))) + '">' + (extra || '');
}

/** The import map the wrapper injects: three.js is vendored on the render origin, never fetched from a CDN. */
function importMap() {
    return '<script type="importmap" nonce="__NONCE__">' + JSON.stringify({ imports: { three: VENDOR.three, 'three/addons/': VENDOR.addons } }) + '</script>';
}

/** The model document for a script kind: the model's own HTML, under our nonce and our CSP. */
function modelDocument(kind, payload, opts) {
    const nonce = (opts && opts.nonce) || crypto.randomBytes(16).toString('base64');
    const p = renderablePayload(kind, payload);
    let body = '';
    if (typeof p.html === 'string' && p.html.trim()) body = p.html;
    else if (typeof p.glsl === 'string' && p.glsl.trim()) body = glslPage(p.glsl);
    else if (typeof p.gltf_base64 === 'string' && p.gltf_base64.trim()) body = gltfPage(p.gltf_base64);
    else body = '<p>Nothing was generated for this entry.</p>';
    body = truncateBytes(body, MAX_ENTRY_BYTES);
    body = withoutUnrunnableScripts(body);
    // A whole page of the model's own gets the import map too (an addon imports the bare "three"), unless it has one.
    const own = /<html\b/i.test(body);
    const withMap = own && !/type\s*=\s*["']?importmap/i.test(body)
        ? (/<head\b[^>]*>/i.test(body) ? body.replace(/<head\b[^>]*>/i, (m) => m + importMap()) : body.replace(/<html\b[^>]*>/i, (m) => m + '<head>' + importMap() + '</head>'))
        : body;
    const doc = own
        ? withMap
        : '<!doctype html><html lang="en"><head>' + head(nonce, importMap()) + '</head><body>' + body + '</body></html>';
    // The built-in pages (glsl, gltf) write __NONCE__ in their CSP meta and tags; it becomes this response's nonce.
    return truncateBytes(applyNonce(doc.split('__NONCE__').join(nonce), nonce), MAX_ENTRY_BYTES + 2048);
}

/** A minimal WebGL page: the model's fragment shader on a full-frame quad. */
function glslPage(glsl) {
    const src = String(glsl).replace(/<\/script/gi, '<\\/script');
    return '<!doctype html><html lang="en"><head>' + head('__NONCE__', importMap())
        + '<style>html,body{margin:0;height:100%;background:#111;overflow:hidden}canvas{display:block;width:100%;height:100%}</style></head>'
        + '<body><canvas id="c"></canvas><script type="x-shader/x-fragment" id="fs" nonce="__NONCE__">' + src + '</script>'
        + '<script nonce="__NONCE__">'
        + '(function(){var c=document.getElementById("c");var gl=c.getContext("webgl");'
        + 'if(!gl){document.body.textContent="WebGL is not available in this frame.";return;}'
        + 'var vs="attribute vec2 p; void main(){ gl_Position = vec4(p,0.0,1.0); }";'
        + 'var fsSrc=document.getElementById("fs").textContent;'
        + 'function sh(t,s){var o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);return o;}'
        + 'var v=sh(gl.VERTEX_SHADER,vs),f=sh(gl.FRAGMENT_SHADER,fsSrc);var pr=gl.createProgram();'
        + 'gl.attachShader(pr,v);gl.attachShader(pr,f);gl.linkProgram(pr);'
        + 'if(!gl.getProgramParameter(pr,gl.LINK_STATUS)){document.body.textContent="Shader did not compile: "+gl.getShaderInfoLog(f);return;}'
        + 'gl.useProgram(pr);var buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);'
        + 'gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);'
        + 'var loc=gl.getAttribLocation(pr,"p");gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);'
        + 'function size(){c.width=c.clientWidth*devicePixelRatio;c.height=c.clientHeight*devicePixelRatio;}'
        + 'function frame(){gl.viewport(0,0,c.width,c.height);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,3);requestAnimationFrame(frame);}'
        + 'addEventListener("resize",size);size();frame();})();'
        + '</script></body></html>';
}

/** A minimal viewer page: the model's glTF (base64) in a neutral studio, with three.js from the render origin. */
function gltfPage(b64) {
    const data = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
    return '<!doctype html><html lang="en"><head>' + head('__NONCE__', importMap())
        + '<style>html,body{margin:0;height:100%;background:#e9edf2}canvas{display:block}</style></head><body>'
        + '<script type="module" nonce="__NONCE__">'
        + 'import * as THREE from "three";'
        + 'const bin=atob("' + data + '");const bytes=new Uint8Array(bin.length);'
        + 'for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);'
        + 'const scene=new THREE.Scene();const camera=new THREE.PerspectiveCamera(45,1,0.01,100);camera.position.set(2,2,3);'
        + 'scene.add(new THREE.HemisphereLight(0xffffff,0x444444,1.2));'
        + 'const key=new THREE.DirectionalLight(0xffffff,1.6);key.position.set(3,4,2);scene.add(key);'
        + 'const fill=new THREE.DirectionalLight(0x88aaff,0.5);fill.position.set(-3,1,-2);scene.add(fill);'
        + 'const renderer=new THREE.WebGLRenderer({antialias:true});document.body.appendChild(renderer.domElement);'
        + 'function size(){const w=innerWidth,h=innerHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();}'
        + 'addEventListener("resize",size);size();'
        + 'const loader=new THREE.GLTFLoader();'
        + 'loader.parse(bytes.buffer,"",(g)=>{scene.add(g.scene);window.__bench={rendered:true};});'
        + 'let t=0;(function loop(){t+=0.01;scene.rotation.y=t;renderer.render(scene,camera);requestAnimationFrame(loop);})();'
        + '</script></body></html>';
}

/**
 * The trusted wrapper: our page, our clock, our stop button. The model output lives in the child frame, and the
 * wrapper never hands the child anything but the clock.
 */
function wrapperDocument(opts) {
    const entryId = (opts && opts.entryId) || '';
    const kindId = (opts && opts.kindId) || '';
    const limitMs = (opts && opts.limitMs) || DEFAULT_LIMIT_MS;
    const title = (opts && opts.title) || 'Generated output';
    const nonce = (opts && opts.nonce) || crypto.randomBytes(16).toString('base64');
    const secs = Math.max(1, Math.round(limitMs / 1000));
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<meta http-equiv="Content-Security-Policy" content="' + esc(metaPolicy(wrapperCsp(nonce))) + '">'
        + '<style>html,body{margin:0;height:100%;font:14px/1.4 system-ui,sans-serif;background:#0f1115;color:#e9edf2}'
        + '.bar{display:flex;gap:.5rem;align-items:center;justify-content:space-between;padding:.35rem .6rem;background:#171a21;border-bottom:1px solid #262b36}'
        + '.bar b{font-weight:600}.clock{font-variant-numeric:tabular-nums;color:#9fb0c8}'
        + 'button{font:inherit;background:#262b36;color:#e9edf2;border:1px solid #39414f;border-radius:6px;padding:.25rem .6rem;cursor:pointer}'
        + 'iframe{width:100%;height:calc(100% - 40px);border:0;background:#fff}'
        + '.stopped{display:none;padding:1rem;color:#9fb0c8}</style></head>'
        + '<body data-entry-id="' + esc(entryId) + '" data-kind-id="' + esc(kindId) + '" data-limit-ms="' + limitMs + '">'
        + '<div class="bar"><b>' + esc(title) + '</b><span><span class="clock" id="clock">' + secs + 's</span> '
        + '<button type="button" id="stop">Stop</button></span></div>'
        + '<iframe id="frame" title="' + esc(title) + '" sandbox="' + SANDBOX + '" referrerpolicy="no-referrer" loading="lazy" src="' + esc(RENDER_ORIGIN + '/render/e/' + encodeURIComponent(entryId)) + '"></iframe>'
        + '<div class="stopped" id="stopped">The entry stopped after ' + secs + ' seconds. <button type="button" id="again">Run it again</button></div>'
        + '<script nonce="' + esc(nonce) + '">(function(){var frame=document.getElementById("frame");var clock=document.getElementById("clock");'
        + 'var stopped=document.getElementById("stopped");var src=frame.getAttribute("src");var left=' + secs + ';var timer=0;'
        + 'function tick(){left-=1;clock.textContent=left>0?left+"s":"0s";if(left<=0)stop();}'
        + 'function stop(){clearInterval(timer);frame.src="about:blank";frame.style.display="none";stopped.style.display="block";clock.textContent="0s";}'
        // A voter comparing two pages may need longer than the clock: the same entry runs again, from the start.
        + 'function again(){clearInterval(timer);left=' + secs + ';clock.textContent=left+"s";stopped.style.display="none";frame.style.display="";frame.src=src;timer=setInterval(tick,1000);}'
        + 'document.getElementById("stop").addEventListener("click",stop);document.getElementById("again").addEventListener("click",again);'
        + 'timer=setInterval(tick,1000);'
        + 'addEventListener("message",function(e){if(e&&e.data==="bench:stop")stop();});})();</script></body></html>';
}

module.exports = {
    RENDER_ORIGIN, PINNED_ORIGINS, VENDOR, SANDBOX, WRAPPER_SANDBOX, DEFAULT_LIMIT_MS, MAX_ENTRY_BYTES,
    FRAME_ANCESTORS, PAYLOAD_FIELD, codeOf, payloadFor, renderablePayload, wrapperCsp, cspFor, applyNonce, sanitizeSvg, fitSvg, SVG_NAMESPACES, limitMsOf, modeOf, modelDocument, wrapperDocument,
    repairDuplicateDeclarations, scriptProblems, withoutUnrunnableScripts,
};

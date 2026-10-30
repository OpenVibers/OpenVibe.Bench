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
const { truncateBytes, MAX_BYTES } = require('./sanitize');

const RENDER_ORIGIN = String(process.env.OV_RENDER_ORIGIN || 'https://bench-render.openvibe.services').replace(/\/+$/, '');
/** The only origins a model output may load code, styles, images or fonts from. */
const PINNED_ORIGINS = Object.freeze([RENDER_ORIGIN]);
/** Version-pinned libraries the render origin vendors. A model imports these by absolute URL. */
const VENDOR = Object.freeze({
    three: RENDER_ORIGIN + '/vendor/three.module.js',
    threeLegacy: RENDER_ORIGIN + '/vendor/three.min.js',
});
/** The sandbox attributes for every model frame: scripts yes, everything else no. */
const WRAPPER_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src " + RENDER_ORIGIN + "; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
const SANDBOX = 'allow-scripts';
/** The default wall-clock a kind may run before the wrapper stops it. */
const DEFAULT_LIMIT_MS = 20000;
/** The hard size cap on one entry, the same cap sanitizeHtml already applies. */
const MAX_ENTRY_BYTES = MAX_BYTES;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
        "frame-ancestors https://bench.openvibe.services https://openvibe.report",
    ].join('; ');
}

/** Give every script tag in the model output our nonce, so only our own script-src nonce runs it. */
function applyNonce(html, nonce) {
    return String(html == null ? '' : html).replace(/<script\b/gi, '<script nonce="' + nonce + '"');
}

/** SVG-specific pass (spec 2.3): no script, no foreignObject, no external reference, no event handler, no @import. */
function sanitizeSvg(input) {
    let s = input == null ? '' : String(input);
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
    return truncateBytes(s, MAX_ENTRY_BYTES);
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
        + '<meta http-equiv="Content-Security-Policy" content="' + esc(cspFor(nonce)) + '">' + (extra || '');
}

/** The import map the wrapper injects: three.js is vendored on the render origin, never fetched from a CDN. */
function importMap() {
    return '<script type="importmap" nonce="__NONCE__">' + JSON.stringify({ imports: { three: VENDOR.three } }) + '</script>';
}

/** The model document for a script kind: the model's own HTML, under our nonce and our CSP. */
function modelDocument(kind, payload, opts) {
    const nonce = (opts && opts.nonce) || crypto.randomBytes(16).toString('base64');
    const p = payload || {};
    let body = '';
    if (typeof p.html === 'string' && p.html.trim()) body = p.html;
    else if (typeof p.glsl === 'string' && p.glsl.trim()) body = glslPage(p.glsl);
    else if (typeof p.gltf_base64 === 'string' && p.gltf_base64.trim()) body = gltfPage(p.gltf_base64);
    else body = '<p>Nothing was generated for this entry.</p>';
    body = truncateBytes(body, MAX_ENTRY_BYTES);
    const doc = /<html\b/i.test(body)
        ? body
        : '<!doctype html><html lang="en"><head>' + head(nonce, importMap()) + '</head><body>' + body + '</body></html>';
    return truncateBytes(applyNonce(doc, nonce), MAX_ENTRY_BYTES + 2048);
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
    const secs = Math.max(1, Math.round(limitMs / 1000));
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<meta http-equiv="Content-Security-Policy" content="' + WRAPPER_CSP + '">'
        + '<style>html,body{margin:0;height:100%;font:14px/1.4 system-ui,sans-serif;background:#0f1115;color:#e9edf2}'
        + '.bar{display:flex;gap:.5rem;align-items:center;justify-content:space-between;padding:.35rem .6rem;background:#171a21;border-bottom:1px solid #262b36}'
        + '.bar b{font-weight:600}.clock{font-variant-numeric:tabular-nums;color:#9fb0c8}'
        + 'button{font:inherit;background:#262b36;color:#e9edf2;border:1px solid #39414f;border-radius:6px;padding:.25rem .6rem;cursor:pointer}'
        + 'iframe{width:100%;height:calc(100% - 40px);border:0;background:#fff}'
        + '.stopped{display:none;padding:1rem;color:#9fb0c8}</style></head>'
        + '<body data-entry-id="' + esc(entryId) + '" data-kind-id="' + esc(kindId) + '" data-limit-ms="' + limitMs + '">'
        + '<div class="bar"><b>' + esc(title) + '</b><span><span class="clock" id="clock">' + secs + 's</span> '
        + '<button type="button" id="stop">Stop</button></span></div>'
        + '<iframe id="frame" title="' + esc(title) + '" sandbox="' + SANDBOX + '" referrerpolicy="no-referrer" loading="lazy" src="/render/e/' + encodeURIComponent(entryId) + '"></iframe>'
        + '<div class="stopped" id="stopped">The entry stopped after ' + secs + ' seconds.</div>'
        + '<script>(function(){var frame=document.getElementById("frame");var clock=document.getElementById("clock");'
        + 'var stopped=document.getElementById("stopped");var left=' + secs + ';'
        + 'function stop(){frame.src="about:blank";frame.style.display="none";stopped.style.display="block";clock.textContent="0s";}'
        + 'document.getElementById("stop").addEventListener("click",stop);'
        + 'var timer=setInterval(function(){left-=1;clock.textContent=left>0?left+"s":"0s";if(left<=0){clearInterval(timer);stop();}},1000);'
        + 'addEventListener("message",function(e){if(e&&e.data==="bench:stop")stop();});})();</script></body></html>';
}

module.exports = {
    RENDER_ORIGIN, PINNED_ORIGINS, VENDOR, SANDBOX, DEFAULT_LIMIT_MS, MAX_ENTRY_BYTES,
    cspFor, applyNonce, sanitizeSvg, limitMsOf, modeOf, modelDocument, wrapperDocument,
};

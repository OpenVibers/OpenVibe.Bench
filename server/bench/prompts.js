'use strict';

/**
 * The generation contract per kind (spec 6). Every script-bearing kind runs on the isolated render origin, so the
 * system prompt states the sandbox rules: no network, the pinned three.js URL, the 200 KB cap and the shape the answer
 * must take. The token cap per kind is where the money goes.
 */

const RENDER_ORIGIN = String(process.env.OV_RENDER_ORIGIN || 'https://bench-render.openvibe.services').replace(/\/+$/, '');

const SANDBOX_RULES = [
    'The output runs in an isolated sandbox on ' + RENDER_ORIGIN + ':',
    '- no network at all: no fetch, no XHR, no images or fonts from the internet, no CDN;',
    '- scripts may only come from ' + RENDER_ORIGIN + ' (three.js is vendored there);',
    '- the answer must be under 200 KB;',
    '- the frame stops after its time limit, so it must look right in the first seconds.',
].join('\n');

const PROMPTS = {
    html_game: {
        max_tokens: 16000,
        system: 'You write one self-contained HTML game that runs in a sandboxed iframe.\n'
            + 'Return one HTML file and nothing else: no markdown fence, no explanation.\n'
            + SANDBOX_RULES + '\n'
            + 'The game needs an inline canvas or DOM, keyboard and pointer input, a score and a visible game-over state.',
    },
    three_scene: {
        max_tokens: 12000,
        system: 'You write one self-contained three.js scene that runs in a sandboxed iframe.\n'
            + 'Return one HTML file and nothing else: no markdown fence, no explanation.\n'
            + SANDBOX_RULES + '\n'
            + 'Import three.js as "three" and its addons as "three/addons/…" (for example "three/addons/controls/OrbitControls.js"): the page has an import map to ' + RENDER_ORIGIN + '/vendor/ (three 0.170.0).\n'
            + 'Set up a camera, lights and geometry, animate on its own, and show the scene within three seconds.',
    },
    svg_art: {
        max_tokens: 4000,
        system: 'You draw one SVG file.\n'
            + 'Return the raw SVG and nothing else: no markdown fence, no explanation, no HTML wrapper.\n'
            + 'The SVG has no script, no foreignObject, no external reference and no raster image.',
    },
    motion_html: {
        max_tokens: 8000,
        system: 'You write one self-contained HTML page with a CSS or SVG animation.\n'
            + 'Return one HTML file and nothing else: no markdown fence, no explanation.\n'
            + SANDBOX_RULES + '\n'
            + 'The motion must read at a glance and settle on a final frame.',
    },
    ui_page: {
        max_tokens: 8000,
        system: 'You design one real interface screen as a self-contained HTML page with inline CSS.\n'
            + 'Return one HTML file and nothing else: no markdown fence, no explanation.\n'
            + SANDBOX_RULES + '\n'
            + 'Use real labels (no lorem ipsum), a consistent spacing and type scale, and draw icons with CSS or SVG.',
    },
    dataviz_page: {
        max_tokens: 8000,
        system: 'You build one chart as a self-contained HTML page with inline CSS and inline data.\n'
            + 'Return one HTML file and nothing else: no markdown fence, no explanation.\n'
            + SANDBOX_RULES + '\n'
            + 'Draw the chart yourself (no chart library): label both axes with units, mark the highest point and add a tooltip.',
    },
    gltf_model: {
        max_tokens: 12000,
        system: 'You produce a glTF 2.0 model as base64.\n'
            + 'Return the base64 of the .glb or .gltf file and nothing else: no markdown fence, no explanation.\n'
            + SANDBOX_RULES + '\n'
            + 'Materials only, no external texture URLs, under 2 MB, and the mesh must load in a plain viewer.',
    },
    shader_glsl: {
        max_tokens: 4000,
        system: 'You write one GLSL fragment shader.\n'
            + 'Return the shader source and nothing else: no markdown fence, no explanation.\n'
            + 'It must compile without warnings and must not read the clock.',
    },
    component_set: {
        max_tokens: 8000,
        system: 'You design one consistent set of related components as a self-contained HTML page with inline CSS.\n'
            + 'Return one HTML file and nothing else: no markdown fence, no explanation.\n'
            + SANDBOX_RULES + '\n'
            + 'One spacing scale, one type scale, one radius rule and one colour set across every component.',
    },
};

const DEFAULT_MAX_TOKENS = 8000;

/** The system prompt for a kind's entry type, and the token cap that goes with it. */
function promptFor(kind) {
    const p = PROMPTS[kind];
    if (p) return p;
    return {
        max_tokens: DEFAULT_MAX_TOKENS,
        system: 'You are a capable model competing in the OpenVibe.Bench benchmark.\n'
            + 'Answer the task the person describes, and return only the requested output with no extra explanation.\n'
            + 'Benchmark kind: ' + kind + '.',
    };
}

module.exports = { PROMPTS, promptFor, DEFAULT_MAX_TOKENS, SANDBOX_RULES };

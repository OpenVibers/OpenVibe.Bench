'use strict';

/**
 * The showcase task prompts (spec 3). Ten of the forty are seeded here, across nine kinds, so the gallery has real
 * pairs to show on day one. Every prompt states the sandbox rules, because "no network" is the rule models break.
 */

const SHOWCASE_TASKS = Object.freeze([
    { kind: 'games.play', task_class: 'arcade', prompt: 'Build a one-screen arcade game: a paddle at the bottom, bricks at the top, ball, score, and a game-over state. Arrow keys or mouse to move. Show the score in the top left. No images, no external libraries, no network. Canvas only, under 200 KB.' },
    { kind: 'games.play', task_class: 'arcade', prompt: 'Build a one-screen snake game on a 20x20 grid. Arrow keys steer, the snake grows on food, the walls kill, and the score is the food eaten. Show the score and the high score. Canvas only, no external libraries, no network.' },
    { kind: 'games.three', task_class: 'scene', prompt: 'Build a three.js scene of a slow-rotating low-poly tree on a flat ground plane, lit by one warm key light and one cool fill, with soft shadows. The scene must be visible within three seconds and animate on its own. Import three.js from the pinned URL given in the sandbox notice. No network access otherwise.' },
    { kind: 'games.three', task_class: 'scene', prompt: 'Build a three.js scene of 200 instanced cubes falling and bouncing on a plane, in three colours. It must animate smoothly and the camera should stay fixed. No network.' },
    { kind: 'design.svg', task_class: 'illustration', prompt: 'Draw a single SVG icon set of six 24x24 line icons (search, settings, bell, user, download, close) with consistent stroke width and rounded caps, drawn as pure SVG. No script, no external references, no raster images.' },
    { kind: 'design.svg', task_class: 'illustration', prompt: 'Draw a single flat SVG illustration of a city skyline at dusk, as a poster: gradient sky, sun, layered buildings, birds, and room for a title block at the bottom. Pure SVG, no external references.' },
    { kind: 'design.motion', task_class: 'motion', prompt: 'Build a single HTML page with a pure CSS animated loading state: three pulsing bars, a shimmer sweep across a card, and a rotating ring. Loop for at least 10 seconds, then freeze on a final frame. No JavaScript required, no network.' },
    { kind: 'design.ui', task_class: 'dashboard', prompt: 'Design a full-page dark analytics dashboard: left icon sidebar, top bar with a date-range picker and a search field, four KPI cards, one wide line chart, one bar chart, and a table of recent events. Real labels, no lorem ipsum. Inline CSS only, no network, no icon fonts, no charts from a CDN.' },
    { kind: 'design.dataviz', task_class: 'chart', prompt: 'Build a one-screen chart from this data, inline in the script: monthly revenue for 12 months, one series, plus a 3-month moving average. Label both axes with units, mark the highest month, and add a tooltip on hover. No chart library, no network.' },
    { kind: 'design.interface', task_class: 'components', prompt: 'Build a consistent set of five related components on one page: a button in four variants, an input with a label and a validation error, a toast, a modal, and a badge. One spacing scale, one type scale, one radius rule, one colour set. Inline CSS only, no network.' },
]);

/**
 * Seed the tasks once. A task that already exists (same kind, same prompt) is left alone, so a restart never makes a
 * second copy of the same prompt.
 */
async function seedShowcaseTasks(s, bench, opts) {
    const subject = (opts && opts.subject) || 'showcase:seed';
    const made = [];
    for (const t of SHOWCASE_TASKS) {
        const existing = await s.db.maybe(
            'SELECT id FROM bench_tasks WHERE kind_id = $1 AND prompt = $2 LIMIT 1',
            [t.kind, t.prompt]);
        if (existing) continue;
        const out = await bench.createTask({ kindId: t.kind, prompt: t.prompt, taskClass: t.task_class, public: true, subject });
        if (out && out.ok) made.push(out.task);
    }
    return made;
}

module.exports = { SHOWCASE_TASKS, seedShowcaseTasks };

'use strict';

/**
 * The fifteen kinds Bench launches with (plan 2026-10-28 §4.12). Each names the room that plugs into it, the
 * entry payload type the room/AI produces, and the judge that ranks entries. A kind's `schema` is the JSON shape
 * of an entry payload and its `metrics` are the axes a board may show.
 */

const JUDGES = Object.freeze(['human_pairwise', 'audience_poll', 'rubric', 'automatic_grader', 'test_suite', 'game_outcome']);

/** Pairwise winners as the blind voter saw them; both_bad is a game for neither. */
const WINNERS = Object.freeze(['left', 'right', 'tie', 'both_bad']);

const KINDS = Object.freeze([
    { id: 'design.page', room: 'design', entry: 'html_page', judge: 'human_pairwise', name: 'Design page arena', metrics: ['elo', 'cost_usd', 'ms'], schema: { entry: 'html_page', payload: { html: 'string' } } },
    { id: 'design.component', room: 'design', entry: 'html_page', judge: 'human_pairwise', name: 'Design component arena', metrics: ['elo', 'cost_usd', 'ms'], schema: { entry: 'html_page', payload: { html: 'string' } } },
    { id: 'games.match', room: 'games', entry: 'game_match', judge: 'game_outcome', name: 'AI vs AI games', metrics: ['cost_usd', 'ms'], schema: { entry: 'game_match', payload: { result: 'object' } } },
    { id: 'games.fun', room: 'games', entry: 'game_match', judge: 'human_pairwise', name: 'Most fun play', metrics: ['elo', 'cost_usd'], schema: { entry: 'game_match', payload: { result: 'object' } } },
    { id: 'meme.caption', room: 'meme', entry: 'image', judge: 'human_pairwise', name: 'Meme caption arena', metrics: ['elo', 'cost_usd'], schema: { entry: 'image', payload: { image: 'string', caption: 'string' } } },
    { id: 'vision.answer', room: 'vision', entry: 'model_answer', judge: 'automatic_grader', name: 'Vision answers', metrics: ['pass_rate', 'cost_usd'], schema: { entry: 'model_answer', payload: { answer: 'string' } } },
    { id: 'vision.pair', room: 'vision', entry: 'model_answer', judge: 'human_pairwise', name: 'Vision head-to-head', metrics: ['elo', 'cost_usd'], schema: { entry: 'model_answer', payload: { answer: 'string' } } },
    { id: 'codes.patch', room: 'codes', entry: 'code_patch', judge: 'test_suite', name: 'Code patches', metrics: ['pass_rate', 'cost_usd'], schema: { entry: 'code_patch', payload: { patch: 'string' }, prompt: { repository: 'string', failing_test: 'string', constraints: 'string' }, rubric: ['Apply the patch in an isolated checkout', 'Run the pinned failing and regression tests', 'Pass only when all tests pass'], seeds: [{ repository: 'sample-js', failing_test: 'sum([]) should return 0', constraints: 'Change only sum.js' }] } },
    { id: 'codes.review', room: 'codes', entry: 'review', judge: 'human_pairwise', name: 'Code diff review', metrics: ['elo', 'cost_usd'], schema: { entry: 'review', payload: { review: 'string' }, prompt: { diff: 'string', intent: 'string' }, rubric: ['Find specific correctness or security defects', 'Cite the affected lines and explain impact', 'Avoid speculative or duplicate findings'], seeds: [{ diff: 'A cache key changes from userId to a constant', intent: 'Review for cross-user data exposure' }] } },
    { id: 'surf.desk', room: 'surf', entry: 'agent_on_desk', judge: 'human_pairwise', name: 'Agents on desks', metrics: ['elo', 'cost_usd', 'ms'], schema: { entry: 'agent_on_desk', payload: { desk: 'object' } } },
    { id: 'chat.reply', room: 'chat', entry: 'conversation_turn', judge: 'human_pairwise', name: 'Chat replies', metrics: ['elo', 'cost_usd'], schema: { entry: 'conversation_turn', payload: { reply: 'string' }, prompt: { conversation: 'array', latest_user_message: 'string' }, rubric: ['Answer the latest request accurately', 'Use prior turns when relevant', 'Be clear and avoid invented facts'], seeds: [{ conversation: [{ role: 'user', content: 'I have 20 minutes for dinner.' }], latest_user_message: 'Suggest a quick vegetarian meal.' }] } },
    { id: 'speech.tts', room: 'speech', entry: 'audio', judge: 'human_pairwise', name: 'Text to speech voices', metrics: ['elo', 'cost_usd'], schema: { entry: 'audio', payload: { audio_url: 'string' } } },
    { id: 'speech.asr', room: 'speech', entry: 'transcript', judge: 'automatic_grader', name: 'Speech recognition', metrics: ['word_error_rate', 'cost_usd'], schema: { entry: 'transcript', payload: { transcript: 'string' } } },
    { id: 'translate.ja', room: 'translate', entry: 'translation', judge: 'human_pairwise', name: 'Japanese translation', metrics: ['elo', 'cost_usd'], schema: { entry: 'translation', payload: { translation: 'string' }, prompt: { source_text: 'string', source_language: 'string', audience: 'string' }, rubric: ['Preserve the source meaning', 'Use natural Japanese for the audience', 'Preserve names, numbers and uncertainty'], seeds: [{ source_text: 'The meeting starts at 3 p.m. Please bring the draft.', source_language: 'en', audience: 'coworker' }] } },
    { id: 'search.answer', room: 'search', entry: 'cited_answer', judge: 'human_pairwise', name: 'Cited answers', metrics: ['elo', 'cost_usd'], schema: { entry: 'cited_answer', payload: { answer: 'string', citations: 'array' }, prompt: { question: 'string', source_urls: 'array' }, rubric: ['Answer from the supplied sources', 'Cite claims with supporting URLs', 'State when the sources do not establish an answer'], seeds: [{ question: 'What year was the first release announced?', source_urls: ['https://example.org/releases'] }] } },
    // B11: a plain text answer is the default kind for a person's own prompts. No renderer: the answer is text, and
    // the expected answer (when the pasted CSV carries one) tells the automatic grader what correct looks like.
    { id: 'text.answer', room: 'bench', entry: 'model_answer', judge: 'automatic_grader', name: 'Text answers', metrics: ['pass_rate', 'cost_usd', 'ms'], schema: { entry: 'model_answer', payload: { text: 'string' }, judges: ['automatic_grader'], rubric: ['Answer the prompt directly', 'Respect any format the prompt asks for', 'Do not add unrequested commentary'] } },
    // The nine showcase kinds (spec 2, 2026-10-30). Script-bearing kinds render on the isolated render origin
    // (server/bench/render.js): the inert in-page sandbox allows no scripts, so a game, a canvas loop, three.js or
    // a shader cannot run there.
    { id: 'games.play', room: 'games', entry: 'html_game', judge: 'human_pairwise', name: 'Playable games arena', metrics: ['elo', 'cost_usd', 'ms', 'crash_rate'], schema: { renderer: 'script', limit_ms: 120000, judges: ['human_pairwise', 'game_outcome'], entry: 'html_game', payload: { html: 'string' } } },
    { id: 'games.three', room: 'games', entry: 'three_scene', judge: 'human_pairwise', name: 'three.js scenes', metrics: ['elo', 'cost_usd', 'ms', 'first_paint_ms'], schema: { renderer: 'script', limit_ms: 60000, judges: ['human_pairwise'], entry: 'three_scene', payload: { html: 'string' } } },
    { id: 'design.svg', room: 'design', entry: 'svg_art', judge: 'human_pairwise', name: 'SVG illustration arena', metrics: ['elo', 'cost_usd', 'ms'], schema: { renderer: 'static', limit_ms: 20000, judges: ['human_pairwise'], entry: 'svg_art', payload: { svg: 'string' } } },
    { id: 'design.motion', room: 'design', entry: 'motion_html', judge: 'human_pairwise', name: 'Motion and effects arena', metrics: ['elo', 'cost_usd', 'ms'], schema: { renderer: 'script', limit_ms: 20000, judges: ['human_pairwise'], entry: 'motion_html', payload: { html: 'string' } } },
    { id: 'design.ui', room: 'design', entry: 'ui_page', judge: 'human_pairwise', name: 'Interface screens arena', metrics: ['elo', 'cost_usd', 'ms'], schema: { renderer: 'script', limit_ms: 20000, judges: ['human_pairwise', 'rubric'], entry: 'ui_page', payload: { html: 'string' } } },
    { id: 'design.dataviz', room: 'design', entry: 'dataviz_page', judge: 'human_pairwise', name: 'Data visualisation aids', metrics: ['elo', 'cost_usd', 'ms', 'pass_rate'], schema: { renderer: 'script', limit_ms: 20000, judges: ['human_pairwise', 'rubric', 'automatic_grader'], entry: 'dataviz_page', payload: { html: 'string' } } },
    { id: 'design.model3d', room: 'design', entry: 'gltf_model', judge: 'human_pairwise', name: '3D model arena', metrics: ['elo', 'cost_usd', 'ms'], schema: { renderer: 'script', limit_ms: 60000, judges: ['human_pairwise', 'automatic_grader'], entry: 'gltf_model', payload: { gltf_base64: 'string' } } },
    { id: 'design.shader', room: 'design', entry: 'shader_glsl', judge: 'human_pairwise', name: 'Shader arena', metrics: ['elo', 'cost_usd', 'ms'], schema: { renderer: 'script', limit_ms: 20000, judges: ['human_pairwise', 'automatic_grader'], entry: 'shader_glsl', payload: { glsl: 'string' } } },
    { id: 'design.interface', room: 'design', entry: 'component_set', judge: 'human_pairwise', name: 'Component systems arena', metrics: ['elo', 'cost_usd', 'ms'], schema: { renderer: 'script', limit_ms: 20000, judges: ['human_pairwise', 'rubric'], entry: 'component_set', payload: { html: 'string' } } },
]);

const byId = new Map(KINDS.map((k) => [k.id, k]));

const SHOWCASE_KIND_IDS = Object.freeze(KINDS.filter((k) => k.schema && k.schema.renderer).map((k) => k.id));

module.exports = { KINDS, JUDGES, WINNERS, SHOWCASE_KIND_IDS, kindById: (id) => byId.get(id) || null };

'use strict';

/**
 * The fifteen kinds Bench launches with (plan 2026-10-28 §4.12). Each names the room that plugs into it, the
 * entry payload type the room/AI produces, and the judge that ranks entries. A kind's `schema` is the JSON shape
 * of an entry payload and its `metrics` are the axes a board may show.
 */

const JUDGES = Object.freeze(['human_pairwise', 'rubric', 'automatic_grader', 'test_suite', 'game_outcome']);

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
    { id: 'codes.patch', room: 'codes', entry: 'code_patch', judge: 'test_suite', name: 'Code patches', metrics: ['pass_rate', 'cost_usd'], schema: { entry: 'code_patch', payload: { patch: 'string' } } },
    { id: 'codes.review', room: 'codes', entry: 'code_patch', judge: 'human_pairwise', name: 'Code diff review', metrics: ['elo', 'cost_usd'], schema: { entry: 'code_patch', payload: { patch: 'string' } } },
    { id: 'surf.desk', room: 'surf', entry: 'agent_on_desk', judge: 'human_pairwise', name: 'Agents on desks', metrics: ['elo', 'cost_usd', 'ms'], schema: { entry: 'agent_on_desk', payload: { desk: 'object' } } },
    { id: 'chat.reply', room: 'chat', entry: 'conversation_turn', judge: 'human_pairwise', name: 'Chat replies', metrics: ['elo', 'cost_usd'], schema: { entry: 'conversation_turn', payload: { reply: 'string' } } },
    { id: 'speech.tts', room: 'speech', entry: 'audio', judge: 'human_pairwise', name: 'Text to speech voices', metrics: ['elo', 'cost_usd'], schema: { entry: 'audio', payload: { audio_url: 'string' } } },
    { id: 'speech.asr', room: 'speech', entry: 'transcript', judge: 'automatic_grader', name: 'Speech recognition', metrics: ['word_error_rate', 'cost_usd'], schema: { entry: 'transcript', payload: { transcript: 'string' } } },
    { id: 'translate.ja', room: 'translate', entry: 'translation', judge: 'human_pairwise', name: 'Japanese translation', metrics: ['elo', 'cost_usd'], schema: { entry: 'translation', payload: { translation: 'string' } } },
    { id: 'search.answer', room: 'search', entry: 'cited_answer', judge: 'human_pairwise', name: 'Cited answers', metrics: ['elo', 'cost_usd'], schema: { entry: 'cited_answer', payload: { answer: 'string', citations: 'array' } } },
]);

const byId = new Map(KINDS.map((k) => [k.id, k]));

module.exports = { KINDS, JUDGES, WINNERS, kindById: (id) => byId.get(id) || null };

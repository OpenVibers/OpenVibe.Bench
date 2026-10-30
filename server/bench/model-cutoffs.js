'use strict';

/**
 * When each model was released, or the training cutoff its maker states. The contamination flag needs one date per
 * model; a model not in this table gets no flag, never a guessed one. Every row names the page it comes from.
 *
 * The table is deliberately small and in the repo, so changing it is a reviewable change with a source. A provider
 * prefix ("openai:gpt-5") is stripped before the lookup.
 */
const CUTOFFS = Object.freeze([
    { model: 'gpt-5', cutoff: '2025-08-07', source: 'https://openai.com/index/introducing-gpt-5/' },
    { model: 'claude-opus-4', cutoff: '2025-05-22', source: 'https://www.anthropic.com/news/claude-4' },
    { model: 'claude-sonnet-4', cutoff: '2025-05-22', source: 'https://www.anthropic.com/news/claude-4' },
    { model: 'gemini-2.5-pro', cutoff: '2025-06-17', source: 'https://blog.google/technology/google-deepmind/google-gemini-updates-io-2025/' },
    { model: 'deepseek-v3', cutoff: '2024-12-26', source: 'https://api-docs.deepseek.com/news/news1226' },
    { model: 'kimi-k2', cutoff: '2025-07-11', source: 'https://moonshotai.github.io/Kimi-K2/' },
    { model: 'llama-4-maverick', cutoff: '2025-04-05', source: 'https://ai.meta.com/blog/llama-4-multimodal-intelligence/' },
]);

const byModel = new Map(CUTOFFS.map((row) => [row.model.toLowerCase(), row]));

/** The row for a model, or null: unknown means no flag. */
function cutoffFor(model) {
    const text = String(model || '').trim().toLowerCase();
    if (!text) return null;
    const bare = text.includes(':') ? text.slice(text.lastIndexOf(':') + 1) : text;
    return byModel.get(text) || byModel.get(bare) || null;
}

module.exports = { CUTOFFS, cutoffFor };

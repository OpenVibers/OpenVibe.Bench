'use strict';

/**
 * Bench's only model gateway: OpenVibe.AI's `generate` operation, called as the first-party service `bench` with
 * a client-credentials token (audience openvibe.ai, scope ai.run.create; Network grants the ai.generate
 * namespace). AI's routing is the authority: Bench reads GET /api/v1/routes?operation=generate and pins each slot
 * as { provider, model }. The reported provenance always wins, so a fallback is never mislabelled.
 */
const { serviceAuth } = require('openvibe-contracts');
const { sanitizeHtml } = require('./sanitize');
const { promptFor } = require('./prompts');

class BenchAiError extends Error {
    constructor(status, code, detail) {
        super(detail || code);
        this.name = 'BenchAiError';
        this.status = status;
        this.code = code;
        this.detail = detail || code;
    }
}

function createBenchAi({ config, fetchImpl = globalThis.fetch, log = console }) {
    const ai = config.ai;
    const tokenClient = config.oauth.clientSecret
        ? serviceAuth.createTokenClient({
            tokenUrl: `${config.networkInternalUrl || config.networkUrl}/oauth/token`,
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            audience: ai.audience,
            scope: ai.scope,
            fetchImpl,
        })
        : null;
    const enabled = Boolean(ai.url && tokenClient);

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function call(method, path, body, { retried = false } = {}) {
        if (!enabled) throw new BenchAiError(503, 'ai.not_configured', 'OpenVibe.AI is not configured for Bench.');
        let headers;
        try {
            headers = { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokenClient.authHeaders()) };
        } catch (err) {
            throw new BenchAiError(502, 'ai.token_failed', 'OpenVibe.Network did not issue an AI token for Bench.');
        }
        let res;
        try {
            res = await fetchImpl(`${ai.url.replace(/\/+$/, '')}${path}`, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(ai.timeoutMs),
            });
        } catch (err) {
            throw new BenchAiError(502, 'ai.unreachable', err && err.name === 'TimeoutError'
                ? 'OpenVibe.AI did not answer in time.'
                : 'OpenVibe.AI could not be reached.');
        }
        if (res.status === 401 && !retried) {
            tokenClient.invalidate();
            return call(method, path, body, { retried: true });
        }
        const json = await res.json().catch(() => null);
        if (!res.ok) {
            const code = (json && (json.code || json.error)) || `ai.http_${res.status}`;
            const detail = (json && (json.detail || json.message)) || `OpenVibe.AI refused the run (${res.status}).`;
            throw new BenchAiError(res.status >= 500 ? 502 : res.status, String(code).slice(0, 80), String(detail).slice(0, 500));
        }
        return json;
    }

    async function offeredModels() {
        let body;
        try { body = await call('GET', '/api/v1/routes?operation=generate'); } catch (err) {
            log.warn('[OpenVibe.Bench] AI routes unavailable:', (err && err.message) || err);
            return [];
        }
        let routes = Array.isArray(body) ? body : (body && Array.isArray(body.routes) ? body.routes : []);
        if (!routes.length && body && body.routes && typeof body.routes === 'object' && !Array.isArray(body.routes)) {
            routes = Object.entries(body.routes).map(([key, r]) => ({ key, ...(r || {}) }));
        }
        if (!routes.length && body && body.key) routes = [body];
        if (!routes.length && body && Array.isArray(body.models)) {
            routes = body.models.map((m) => ({ key: 'default.chat', capability: 'chat', primary: { provider: m.provider || m.provider_key, model: m.model || m.model_key } }));
        }
        const chat = routes.filter((r) => r && (r.capability === 'chat' || /chat|generate/i.test(String(r.key || ''))));
        const ordered = [
            ...chat.filter((r) => r.key === 'default.chat'),
            ...chat.filter((r) => r.key !== 'default.chat'),
        ];
        const out = [];
        const seen = new Set();
        const add = (provider, model) => {
            const p = String(provider || '').trim();
            const m = model == null ? null : String(model).trim();
            if (!p) return;
            const key = `${p}|${m || ''}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push({ provider: p, model: m || null });
        };
        const hasOffers = ordered.some((r) => Array.isArray(r.offers));
        if (hasOffers) {
            const preferred = ordered.find((r) => r.key === 'default.chat' && Array.isArray(r.offers));
            const source = preferred ? [preferred] : ordered.filter((r) => Array.isArray(r.offers));
            for (const r of source) for (const o of r.offers) add(o && o.provider, o && o.model);
        } else {
            for (const r of ordered) {
                if (r.primary) add(r.primary.provider, r.primary.model);
                for (const p of Array.isArray(r.pinned) ? r.pinned : []) add(p && p.provider, p && p.model);
                for (const f of Array.isArray(r.fallbacks) ? r.fallbacks : []) add(f && f.provider, f && f.model);
            }
        }
        return rankOffers(out);
    }

    function rankOffers(list) {
        const out = [];
        const seen = new Set();
        const providers = new Set();
        const rest = [];
        for (const c of list) {
            const p = String((c && c.provider) || '').trim();
            if (!p) continue;
            const m = c.model == null ? null : String(c.model).trim();
            const key = `${p}|${m || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const offer = { provider: p, model: m || null };
            if (!providers.has(p)) { providers.add(p); out.push(offer); } else rest.push(offer);
        }
        return [...out, ...rest];
    }

    function configuredModels() {
        return (ai.models || []).map((s) => {
            const i = s.indexOf(':');
            return i > 0 ? { provider: s.slice(0, i), model: s.slice(i + 1) || null } : { provider: s, model: null };
        });
    }

    async function slotPlan() {
        let list = configuredModels();
        if (!list.length) list = await offeredModels();
        const ranked = rankOffers(list);
        const slots = ranked.slice(0, 3);
        const poolFallback = slots.length < 3;
        while (slots.length < 3) slots.push({ provider: 'ai', model: null });
        return { slots, pool_fallback: poolFallback, offered: ranked.length };
    }

    async function slots() { return (await slotPlan()).slots; }

    function systemPrompt(kind) {
        return promptFor(kind).system;
    }

    /** The token cap for a kind's entry type: games and three.js cost the most, SVG the least. */
    function maxTokensFor(kind) {
        return promptFor(kind).max_tokens;
    }

    function textOf(output) {
        if (typeof output === 'string') return output;
        if (!output || typeof output !== 'object') return '';
        for (const k of ['text', 'html', 'content', 'body']) if (typeof output[k] === 'string') return output[k];
        if (output.message && typeof output.message.content === 'string') return output.message.content;
        return '';
    }

    function msOf(run, fallback) {
        for (const v of [run && run.ms, run && run.latency_ms, run && run.duration_ms, run && run.usage && run.usage.ms, run && run.usage && run.usage.latency_ms, run && run.usage && run.usage.duration_ms]) {
            if (Number.isFinite(Number(v)) && Number(v) >= 0) return Math.round(Number(v));
        }
        const start = run && (run.started_at || run.created_at);
        const end = run && run.finished_at;
        if (start && end) {
            const d = Date.parse(end) - Date.parse(start);
            if (Number.isFinite(d) && d >= 0) return Math.round(d);
        }
        return Math.max(0, Math.round(fallback));
    }

    async function waitFor(run, startedAt) {
        let r = run;
        const deadline = Date.now() + ai.timeoutMs;
        while (r && ['queued', 'running'].includes(r.status)) {
            if (!r.id) throw new BenchAiError(502, 'ai.bad_answer', 'OpenVibe.AI answered with a running run that has no id.');
            if (Date.now() > deadline) throw new BenchAiError(504, 'ai.timeout', `The AI run ${r.id} did not finish in time.`);
            await sleep(ai.pollMs);
            const body = await call('GET', `/api/v1/runs/${encodeURIComponent(r.id)}`);
            r = body && body.run ? body.run : body;
        }
        if (!r) throw new BenchAiError(502, 'ai.bad_answer', 'OpenVibe.AI answered without a run.');
        const done = ['succeeded', 'cached', 'completed', 'ok'].includes(r.status)
            || (r.status == null && r.output != null && !r.error);
        if (!done) {
            const e = r.error || {};
            throw new BenchAiError(502, 'ai.run_failed', `The AI run ${r.id || '?'} ${r.status || 'did not finish'}${e.code ? ` (${e.code}: ${e.detail || ''})` : ''}.`);
        }
        return { run: r, ms: msOf(r, Date.now() - startedAt) };
    }

    async function generate({ prompt, kind, slot, roundId, index }) {
        if (!enabled) throw new BenchAiError(503, 'ai.not_configured', 'OpenVibe.AI is not configured for Bench.');
        const pinned = slot && slot.provider && slot.provider !== 'ai' ? { provider: slot.provider, model: slot.model || null } : null;
        const body = {
            prompt,
            system: systemPrompt(kind),
            max_tokens: maxTokensFor(kind),
            temperature: 0.7,
            options: { cache: false },
            ...(pinned ? { route: pinned } : {}),
            target: { service: 'bench', type: 'bench_output', id: `${roundId}_${index}`.slice(0, 128) },
        };
        const startedAt = Date.now();
        const wait = Math.min(ai.waitMs, 60_000);
        let created;
        try {
            created = await call('POST', `/api/v1/generate?wait=${wait}`, body);
        } catch (err) {
            if (!err || err.status !== 404) throw err;
            created = await call('POST', `/api/v1/runs?wait=${wait}`, {
                workflow: 'ai.generate',
                input: { prompt: body.prompt, system: body.system, max_tokens: body.max_tokens, temperature: body.temperature },
                options: body.options,
                ...(body.route ? { route: body.route } : {}),
                target: body.target,
            });
        }
        const first = created && created.run ? created.run : created;
        const { run, ms } = await waitFor(first, startedAt);
        const text = textOf(run.output);
        if (!text.trim()) throw new BenchAiError(502, 'ai.empty', `The AI run ${run.id} returned no output.`);
        const usage = run.usage || {};
        const prov = run.provenance || {};
        const tokens = usage.tokens && typeof usage.tokens === 'object'
            ? (Number(usage.tokens.input) || 0) + (Number(usage.tokens.output) || 0)
            : Number.isFinite(Number(usage.tokens)) ? Number(usage.tokens)
                : (Number(usage.tokens_in) || 0) + (Number(usage.tokens_out) || 0)
                    || (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0)
                    || (Number(run.tokens) || 0);
        const model = String(prov.model || run.model || (run.output && run.output.model) || (slot && slot.model) || 'unknown').slice(0, 120);
        const provider = String(prov.provider || run.provider || (slot && slot.provider) || 'ai').slice(0, 80);
        const ui_check = run.ui_check || (run.output && run.output.ui_check) || null;
        const html = /html_page/.test(kind || '') ? sanitizeHtml(text, { maxBytes: ai.maxHtmlBytes }) : text;
        const payload = /html_page/.test(kind || '') ? { html } : { text };
        return {
            payload,
            html,
            cost_usd: Number(usage.cost_usd != null ? usage.cost_usd
                : usage.cost != null ? usage.cost
                    : run.cost_usd != null ? run.cost_usd
                        : run.cost != null ? run.cost : 0) || 0,
            ms,
            tokens: Math.max(0, Math.round(tokens)),
            model,
            provider,
            ui_check,
            run_id: run.id || null,
        };
    }

    return { enabled, slots, slotPlan, offeredModels, rankOffers, generate, systemPrompt, maxTokensFor };
}

module.exports = { createBenchAi, BenchAiError };

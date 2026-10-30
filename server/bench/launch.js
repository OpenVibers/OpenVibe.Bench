'use strict';

/**
 * Starting a benchmark on openvibe.codes for a signed-in person (stage B3): the one place that checks the request,
 * estimates the cost, asks for a confirmation above $1 and hands the matrix to Codes. The API
 * (POST /api/v1/benchmarks/:id/run) and the run form (/benchmarks/:id/run) both call it, so the page never promises
 * something the API refuses.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const CONFIRM_ABOVE_USD = 1;
const HARNESS_TTL_MS = 10 * 60 * 1000;

function createLauncher({ config, registry, fetchImpl = globalThis.fetch, log = console }) {
    const codesTokens = config.oauth && config.oauth.clientSecret ? createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret, audience: 'openvibe.codes', scope: 'codes.task.start', fetch: fetchImpl,
    }) : null;

    /**
     * The cost a run may reach: tasks × models × harnesses × repeats × the benchmark's per-task dollar limit. Null when
     * the benchmark sets no dollar limit: then nobody can say, and the run always asks for a confirmation.
     */
    function estimate(definition, { models, harnesses, repeat }) {
        const tasks = (definition && Array.isArray(definition.tasks) ? definition.tasks : []).length;
        const usd = Number(definition && definition.limits && definition.limits.usd) || 0;
        if (!(usd > 0)) return null;
        return Math.round(tasks * models.length * harnesses.length * repeat * usd * 100) / 100;
    }

    /**
     * Start the run. Returns { status, body }: 202 with Codes' answer, 409 when the estimate needs a confirmation,
     * or a problem ({ code, detail }) for everything else.
     */
    async function launch({ principal, id, models, harnesses, repeat, confirm }) {
        const fail = (status, code, detail) => ({ status, body: { code, detail } });
        if (!principal || principal.kind !== 'user') return fail(403, 'bench.person_required', 'Sign in as the person who will run this benchmark.');
        if (!config.codesRunUrl) return fail(503, 'bench.runner_unavailable', 'Codes benchmark runs are not configured.');
        const clean = (list) => [...new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim()).filter((x) => /^[\w.:/@-]{1,120}$/.test(x)))];
        models = clean(models); harnesses = clean(harnesses); repeat = Number(repeat);
        if (!models.length || !harnesses.length || models.length > 20 || harnesses.length > 20 || !Number.isInteger(repeat) || repeat < 1 || repeat > 20) {
            return fail(400, 'bench.invalid', 'models and harnesses must be non-empty lists (at most 20 each), and repeat must be 1–20');
        }
        const definition = await registry.getDefinition(String(id), { reveal: false });
        if (!definition) return fail(404, 'bench.benchmark_not_found', 'No such benchmark.');
        const cost = estimate(definition.definition, { models, harnesses, repeat });
        if ((cost == null || cost > CONFIRM_ABOVE_USD) && confirm !== true) {
            return { status: 409, body: { code: 'bench.confirm_cost', cost_estimate_usd: cost, confirm_required: true, ...(cost == null ? { detail: 'This benchmark sets no dollar limit per task, so its cost depends on the models.' } : {}) } };
        }
        if (!codesTokens) return fail(503, 'bench.runner_unavailable', 'Bench has no Network client credentials for Codes.');
        try {
            const url = new URL(`/api/v1/benchmarks/${encodeURIComponent(String(id))}/run`, config.codesRunUrl).toString();
            const response = await fetchImpl(url, {
                method: 'POST',
                headers: { ...(await codesTokens.authHeaders()), 'content-type': 'application/json', 'x-ov-subject': principal.subject, 'x-ov-user-token': principal.token },
                body: JSON.stringify({ benchmark: String(id), models, harnesses, repeat }),
                signal: AbortSignal.timeout(15000),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                return fail(response.status < 500 ? response.status : 502, body.code || 'bench.runner_failed', body.detail || body.message || 'Codes could not start this benchmark.');
            }
            return { status: 202, body: { ...body, cost_estimate_usd: cost, tasks_url: new URL('/tasks', config.codesRunUrl).toString() } };
        } catch (err) {
            log.warn('[OpenVibe.Bench] starting a Codes run failed:', (err && err.message) || err);
            return fail(502, 'bench.runner_failed', 'Codes did not answer. Try again in a minute.');
        }
    }

    // The harnesses Codes offers, for the run form: read from Codes and kept ten minutes. Unreachable, the form falls
    // back to the benchmark's own matrix.
    let harnessCache = { at: 0, list: null };
    async function harnessList() {
        if (harnessCache.list && Date.now() - harnessCache.at < HARNESS_TTL_MS) return harnessCache.list;
        if (!config.codesRunUrl) return [];
        try {
            const res = await fetchImpl(new URL('/api/v1/harnesses', config.codesRunUrl).toString(), { signal: AbortSignal.timeout(5000) });
            const body = await res.json();
            const rows = Array.isArray(body) ? body : (body.harnesses || body.offers || []);
            const list = rows.map((h) => ({ id: String(h.id || ''), label: String(h.label || h.name || h.id || '') })).filter((h) => h.id);
            harnessCache = { at: Date.now(), list };
            return list;
        } catch (err) {
            log.warn('[OpenVibe.Bench] Codes harness list unavailable:', (err && err.message) || err);
            return harnessCache.list || [];
        }
    }

    return { launch, estimate, harnessList, CONFIRM_ABOVE_USD };
}

module.exports = { createLauncher, CONFIRM_ABOVE_USD };

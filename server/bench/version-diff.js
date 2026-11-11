'use strict';

/** Paired task-level comparison for two runs of the same frozen benchmark version. */
function seeded(seed) {
    let state = Number(seed) >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function percentile(sorted, p) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function compareRuns(baseline, candidate, { iterations = 10000, seed = 301 } = {}) {
    const oldScores = new Map((baseline.tasks || []).filter((t) => t.score != null && !t.held_out).map((t) => [t.task_id, Number(t.score)]));
    const newScores = new Map((candidate.tasks || []).filter((t) => t.score != null && !t.held_out).map((t) => [t.task_id, Number(t.score)]));
    const rows = [...oldScores.keys()].filter((id) => newScores.has(id)).sort().map((task_id) => ({
        task_id, baseline: oldScores.get(task_id), candidate: newScores.get(task_id),
        delta: newScores.get(task_id) - oldScores.get(task_id),
    }));
    const diffs = rows.map((r) => r.delta);
    const mean = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null;
    const sd = diffs.length > 1 ? Math.sqrt(diffs.reduce((sum, d) => sum + ((d - mean) ** 2), 0) / (diffs.length - 1)) : null;
    const random = seeded(seed);
    const samples = [];
    for (let i = 0; i < iterations && diffs.length; i++) {
        let total = 0;
        for (let j = 0; j < diffs.length; j++) total += diffs[Math.floor(random() * diffs.length)];
        samples.push(total / diffs.length);
    }
    samples.sort((a, b) => a - b);
    const lower = percentile(samples, 0.025);
    const upper = percentile(samples, 0.975);
    const better = diffs.filter((d) => d > 0).length;
    const worse = diffs.filter((d) => d < 0).length;
    return {
        schema: 'bench.version-diff@1',
        method: { design: 'paired by identical task_id on the same frozen benchmark version', interval: '95% percentile bootstrap of paired mean score differences', iterations, seed, held_out: 'excluded from public rows and statistics' },
        baseline: { run_id: baseline.id, model: baseline.model, benchmark: baseline.benchmark, created_at: baseline.created_at, score: baseline.score, cost_usd: baseline.cost_usd, ms: baseline.ms },
        candidate: { run_id: candidate.id, model: candidate.model, benchmark: candidate.benchmark, created_at: candidate.created_at, score: candidate.score, cost_usd: candidate.cost_usd, ms: candidate.ms },
        paired_tasks: rows.length,
        mean_delta: mean,
        ci95: { lower, upper },
        significant: rows.length >= 2 && (lower > 0 || upper < 0),
        minimum_detectable_effect_80pct_power: sd == null ? null : (1.96 + 0.84) * sd / Math.sqrt(rows.length),
        changes: { better, worse, unchanged: rows.length - better - worse },
        rows,
        caveat: 'A task bootstrap describes these paired items; it does not correct judge bias or benchmark contamination.',
    };
}

module.exports = { compareRuns };

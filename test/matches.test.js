'use strict';

/**
 * Matches and the factor boards (bench.match@1, Contracts 0.422.0, compare-arena-ecosystem.md): a service records the
 * comparisons it ran, the same service adds a later judgement (a Codes race judged by its tests, then by the merge),
 * nobody else can touch its match, and the code board rates model and harness apart from them.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { gamesOf } = require('../server/rating/match-games');

const at = '2026-11-13T02:00:00Z';
const agent = (h, m) => `agent:${h}+${m}#0123abcd`;
function codeRace(a, b, winner, judge = 'test_suite') {
    return {
        source: 'codes', task: { kind: 'code', category: 'code.bugfix' },
        slots: [{ slot: 'a', entrant: a, receipts: { outcome: 'succeeded', cost_usd: 0.2 } }, { slot: 'b', entrant: b, receipts: { outcome: 'succeeded', cost_usd: 0.1 } }],
        blind: false,
        judgements: [judge === 'test_suite'
            ? { judge, scores: { a: winner === 'a' ? 1 : 0.5, b: winner === 'b' ? 1 : 0.5 }, by: { type: 'suite' }, at }
            : { judge, winner, signal: 'merged', by: { type: 'person', id_hash: '0123456789abcdef' }, at }],
        at,
    };
}

(async () => {
    // Pure: one judgement with a winner among three sides is two games; scores decide every pair; both_bad is none.
    await check('a match becomes the pairwise games the fit reads', async () => {
        const three = { slots: [{ slot: 'a', entrant: 'model:x' }, { slot: 'b', entrant: 'model:y' }, { slot: 'c', entrant: 'model:z' }],
            judgements: [{ judge: 'human_pairwise', winner: 'b', at }, { judge: 'rubric', scores: { a: 3, b: 3, c: 1 }, at }, { judge: 'human_pairwise', winner: 'both_bad', at }] };
        const g = gamesOf([three]);
        assert.deepStrictEqual(g.map((x) => `${x.a}>${x.b}:${x.outcome}`), [
            'model:x>model:y:b', 'model:y>model:z:a',
            'model:x>model:y:tie', 'model:x>model:z:a', 'model:y>model:z:a',
        ]);
    });

    const t = await boot();
    try {
        const codes = t.network.serviceToken({ sub: 'svc:codes', audience: 'openvibe.bench', cap: ['bench.judgement.cast'] });
        const live = t.network.serviceToken({ sub: 'svc:live', audience: 'openvibe.bench', cap: ['bench.judgement.cast'] });
        const reader = t.network.serviceToken({ sub: 'svc:compare', audience: 'openvibe.bench', cap: ['bench.board.read'] });

        let firstId = null;
        await check('a service records a match; it gets an id and the event is queued', async () => {
            const r = await t.get('/api/v1/matches', { bearer: codes, json: codeRace(agent('codex', 'gpt-5-mini'), agent('opencode', 'glm-5.3'), 'a') });
            assert.strictEqual(r.status, 201, r.text);
            firstId = r.json().match.id;
            assert.match(firstId, /^mat_[0-9A-HJKMNP-TV-Z]{26}$/);
            const outbox = await t.store.db.many("SELECT payload FROM bench_outbox WHERE topic = 'bench.match.recorded'");
            assert.strictEqual(outbox.length, 1);
            assert.deepStrictEqual(outbox[0].payload.judges, ['test_suite']);
        });

        await check('the same service adds the merge later; the judgements add up', async () => {
            const later = { ...codeRace(agent('codex', 'gpt-5-mini'), agent('opencode', 'glm-5.3'), 'a', 'implicit'), id: firstId };
            const r = await t.get('/api/v1/matches', { bearer: codes, json: later });
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual(r.json().match.judgements.map((j) => j.judge), ['test_suite', 'implicit']);
            const again = await t.get('/api/v1/matches', { bearer: codes, json: later });
            assert.strictEqual(again.json().match.judgements.length, 2, 'the same judgement is not counted twice');
        });

        await check('another service cannot touch it; a bad match and a token without the capability are refused', async () => {
            const other = await t.get('/api/v1/matches', { bearer: live, json: { ...codeRace(agent('codex', 'gpt-5-mini'), agent('opencode', 'glm-5.3'), 'b'), id: firstId } });
            assert.strictEqual(other.status, 409, other.text);
            const bad = await t.get('/api/v1/matches', { bearer: codes, json: { ...codeRace('model:x', 'model:y', 'a'), slots: [{ slot: 'a', entrant: 'model:x' }] } });
            assert.strictEqual(bad.status, 400, bad.text);
            const denied = await t.get('/api/v1/matches', { bearer: reader, json: codeRace('model:x', 'model:y', 'a') });
            assert.strictEqual(denied.status, 403, denied.text);
        });

        await check('the code board rates the harnesses apart from the models', async () => {
            const models = ['gpt-5-mini', 'glm-5.3', 'deepseek-flash'];
            let n = 0;
            for (const m1 of models) for (const m2 of models) {
                for (let k = 0; k < 6; k++) {
                    // Codex beats OpenCode on the same model or a weaker one, most of the time.
                    const winner = (k % 3 === 2) ? 'b' : 'a';
                    const r = await t.get('/api/v1/matches', { bearer: codes, json: codeRace(agent('codex', m1), agent('opencode', m2), winner) });
                    assert.strictEqual(r.status, 201, r.text);
                    n += 1;
                }
            }
            const board = await t.get('/api/v1/factors?task_kind=code&days=365');
            assert.strictEqual(board.status, 200, board.text);
            const b = board.json();
            assert.strictEqual(b.matches, n + 1);
            const effect = (h) => b.harnesses.find((x) => x.harness === h).effect;
            assert.ok(effect('codex') > effect('opencode'), `codex ${effect('codex')} ahead of opencode ${effect('opencode')}`);
            assert.ok(b.agents.length >= 6 && b.agents.every((x) => x.factors && x.factors.model && x.factors.harness));
            assert.match(b.method, /model \+ harness/);
            const badKind = await t.get('/api/v1/factors?task_kind=poetry');
            assert.strictEqual(badKind.status, 400);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((error) => { console.error(error); process.exitCode = 1; });

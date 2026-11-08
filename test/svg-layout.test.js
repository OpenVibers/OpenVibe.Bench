'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { checkSvg, separateIcons } = require('../server/bench/svg-check');
const { SHOWCASE_TASKS, LEGACY_ICON_PROMPT: oldPrompt, seedShowcaseTasks, auditSvgEntries } = require('../server/bench/seed-tasks');

const prompt = SHOWCASE_TASKS.find((t) => t.kind === 'design.svg').prompt;
const iconSvg = (origins) => '<svg viewBox="0 0 168 48">' + origins.map((x) => `<g transform="translate(${x} 12)"><path d="M2 2 L20 20"/></g>`).join('') + '</svg>';
const good = iconSvg([0, 28, 56, 84, 112, 140]);

(async () => {
    await check('the new prompt fixes six icon cells and is a new task identity', async () => {
        assert.match(prompt, /viewBox="0 0 168 48"/);
        for (const x of [0, 28, 56, 84, 112, 140]) assert.ok(prompt.includes(`(${x},12)`));
        assert.match(prompt, /stroke-width="2"/);
        assert.match(prompt, /stroke="currentColor"/);
        assert.notStrictEqual(prompt, oldPrompt);
        assert.strictEqual(separateIcons(prompt), 6);
        assert.strictEqual(separateIcons(oldPrompt), 6);
    });

    await check('geometry and separate origins are checked without a browser', async () => {
        assert.strictEqual(checkSvg(good, prompt).status, 'ok');
        assert.ok(checkSvg(iconSvg([0, 0, 0, 0, 0, 0]), prompt).issues.includes('overlapping_icon_origins'));
        assert.ok(checkSvg(iconSvg([0, 28, 56, 84, 112, 160]), prompt).issues.includes('outside_viewbox'));
        assert.ok(checkSvg('<svg viewBox="0 0 24 24"><g transform="translate(48 0)"><rect width="20" height="20"/></g></svg>').issues.includes('outside_viewbox'));
        assert.ok(checkSvg('<svg><path d="M0 0 L1 1"/></svg>').issues.includes('missing_viewbox'));
        assert.ok(checkSvg('<svg viewBox="0 0 24 24"><path d="M0 0 L5 5" transform="translate(25 0)"/></svg>').issues.includes('outside_viewbox'));
        assert.ok(checkSvg('<svg viewBox="0 0 24 24"><path d="M1 1 A20 20 0 1 1 1 20"/></svg>').issues.includes('outside_viewbox'), 'the arc crosses the edge even though its endpoints do not');
        assert.ok(checkSvg('<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M0 1 L10 10"/></svg>').issues.includes('outside_viewbox'), 'the stroke also needs clearance');
    });

    const t = await boot();
    try {
        await check('seeding leaves existing tasks and votes under the old prompt', async () => {
            const old = await t.ctx.bench.createTask({ kindId: 'design.svg', prompt: oldPrompt, taskClass: 'illustration', public: true, subject: 'showcase:seed' });
            assert.ok(old.ok);
            const before = await t.ctx.s.db.value("SELECT COUNT(*)::int AS n FROM bench_tasks WHERE kind_id = 'design.svg'");
            await seedShowcaseTasks(t.ctx.s, t.ctx.bench);
            const after = await t.ctx.s.db.value("SELECT COUNT(*)::int AS n FROM bench_tasks WHERE kind_id = 'design.svg'");
            assert.strictEqual(after, before);
            const seeded = await t.ctx.s.db.maybe('SELECT id, public FROM bench_tasks WHERE prompt = $1', [prompt]);
            assert.ok(seeded && seeded.public);
            assert.notStrictEqual(old.task.id, seeded.id);
            const retired = await t.ctx.s.db.maybe('SELECT public FROM bench_tasks WHERE id = $1', [old.task.id]);
            assert.strictEqual(retired.public, false);
        });

        await check('a failed output is recorded and never paired; earlier votes remain', async () => {
            const old = await t.ctx.s.db.maybe('SELECT id FROM bench_tasks WHERE prompt = $1', [oldPrompt]);
            const created = await t.ctx.bench.createRound({ taskId: old.id, offers: [{ provider: 'acme', model: 'alpha' }, { provider: 'beta', model: 'beta' }], subject: 'showcase:seed', bypassQuota: true });
            assert.ok(created.ok, JSON.stringify(created));
            const roundId = created.round.id;
            const first = await t.ctx.bench.addEntry({ roundId, provider: 'acme', model: 'alpha', payload: { svg: good } });
            const second = await t.ctx.bench.addEntry({ roundId, provider: 'beta', model: 'beta', payload: { svg: good } });
            assert.strictEqual(first.error, null);
            assert.strictEqual(second.error, null);
            assert.strictEqual(first.ui_check.svg_layout.status, 'ok');
            const voter = t.network.addUser('svg-voter');
            const vote = await t.get(`/api/v1/rounds/${roundId}/judgements`, { as: voter, json: { judge: 'human_pairwise', pair: { left: first.id, right: second.id }, outcome: 'left' } });
            assert.strictEqual(vote.status, 201, vote.text);
            // Simulate an entry from before the check existed, then run the one-time audit.
            await t.ctx.s.db.exec('UPDATE bench_entries SET payload = $1::jsonb, ui_check = NULL WHERE id = $2', [JSON.stringify({ svg: iconSvg([0, 0, 0, 0, 0, 0]) }), first.id]);
            await auditSvgEntries(t.ctx.s);
            const flagged = await t.ctx.s.db.maybe('SELECT error, ui_check FROM bench_entries WHERE id = $1', [first.id]);
            assert.match(flagged.error, /overlapping_icon_origins/);
            assert.strictEqual(flagged.ui_check.svg_layout.status, 'failed');
            assert.strictEqual(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM bench_judgements WHERE round_id = $1', [roundId]), 1);
            const pair = await t.get('/api/v1/judgements/next?kind=design.svg');
            assert.strictEqual(pair.status, 204, pair.text);
            const gallery = await t.get('/api/v1/showcase/pairs?kind=design.svg');
            assert.ok(!gallery.json().pairs.some((p) => p.id === roundId));
            const third = await t.ctx.bench.addEntry({ roundId, provider: 'gamma', model: 'gamma', payload: { svg: iconSvg([0, 0, 0, 0, 0, 0]) } });
            assert.match(third.error, /overlapping_icon_origins/);
            assert.strictEqual(third.ui_check.svg_layout.status, 'failed');
        });

        await check('the generation worker fails a round with fewer than two usable SVGs', async () => {
            const task = await t.ctx.s.db.maybe('SELECT id FROM bench_tasks WHERE prompt = $1', [prompt]);
            const created = await t.ctx.bench.createRound({ taskId: task.id, subject: 'showcase:seed', bypassQuota: true });
            assert.ok(created.ok);
            await t.tick(); // The fake AI emits HTML, which is not a usable SVG.
            const round = await t.ctx.s.db.maybe('SELECT status FROM bench_rounds WHERE id = $1', [created.round.id]);
            assert.strictEqual(round.status, 'failed');
            const entries = await t.ctx.s.db.many('SELECT error, ui_check FROM bench_entries WHERE round_id = $1', [created.round.id]);
            assert.strictEqual(entries.length, 3);
            for (const entry of entries) {
                assert.match(entry.error, /missing_viewbox/);
                assert.strictEqual(entry.ui_check.svg_layout.status, 'failed');
            }
        });
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exit(1); });

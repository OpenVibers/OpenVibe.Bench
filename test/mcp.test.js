'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

(async () => {
    const t = await boot({ env: { BENCH_ROUNDS_PER_DAY: '100', BENCH_ROUNDS_DAILY: '1000' } });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');

    let roundId;
    let leftId;
    let rightId;

    await check('initialize negotiates and names the server', async () => {
        const r = await t.get('/mcp', { json: rpc('initialize', { protocolVersion: '2025-06-18' }, 1) });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().result.serverInfo.name, 'openvibe-bench');
        assert.strictEqual(r.json().result.protocolVersion, '2025-06-18');
    });

    await check('initialize falls back to the current protocol for an unknown version', async () => {
        const r = await t.get('/mcp', { json: rpc('initialize', { protocolVersion: '2099-01-01' }, 2) });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().result.protocolVersion, '2025-06-18');
    });

    await check('ping answers an empty result', async () => {
        const r = await t.get('/mcp', { json: rpc('ping', {}, 3) });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.json().result, {});
    });

    await check('tools/list has the six §4.12 tools', async () => {
        const r = await t.get('/mcp', { json: rpc('tools/list', {}, 4) });
        const names = r.json().result.tools.map((x) => x.name);
        assert.deepStrictEqual(names, ['bench.list_kinds', 'bench.start_round', 'bench.next_pair', 'bench.cast_judgement', 'bench.get_board', 'bench.run_eval']);
    });

    await check('an unknown method and a malformed message are JSON-RPC errors', async () => {
        const unknown = await t.get('/mcp', { json: rpc('does.not_exist', {}, 5) });
        assert.strictEqual(unknown.status, 200, unknown.text);
        assert.strictEqual(unknown.json().error.code, -32601);
        const malformed = await t.get('/mcp', { json: { jsonrpc: '2.0', id: 6, method: 3 } });
        assert.strictEqual(malformed.status, 200, malformed.text);
        assert.strictEqual(malformed.json().error.code, -32600);
    });

    await check('an unknown tool is a JSON-RPC error', async () => {
        const r = await t.get('/mcp', { json: rpc('tools/call', { name: 'bench.nope', arguments: {} }, 7) });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().error.code, -32602);
        assert.strictEqual(r.json().error.message, 'Unknown tool');
    });

    await check('bench.list_kinds lists the fifteen kinds', async () => {
        const r = await t.get('/mcp', { json: rpc('tools/call', { name: 'bench.list_kinds', arguments: {} }, 8) });
        assert.strictEqual(r.json().result.isError, false);
        assert.strictEqual(r.json().result.structuredContent.kinds.length, 15);
    });

    await check('bench.get_board renders a board without a person', async () => {
        const r = await t.get('/mcp', { json: rpc('tools/call', { name: 'bench.get_board', arguments: { kind: 'design.page', type: 'elo' } }, 9) });
        assert.strictEqual(r.json().result.isError, false);
        assert.strictEqual(r.json().result.structuredContent.board.type, 'elo');
    });

    await check('bench.get_board reports a missing kind as a tool error', async () => {
        const r = await t.get('/mcp', { json: rpc('tools/call', { name: 'bench.get_board', arguments: { kind: 'no.such', type: 'elo' } }, 10) });
        assert.strictEqual(r.json().result.isError, true);
        assert.match(r.json().result.content[0].text, /No such kind/);
    });

    await check('a person-only tool is a tool error when anonymous', async () => {
        for (const call of [
            { name: 'bench.next_pair', arguments: { kind: 'design.page' } },
            { name: 'bench.cast_judgement', arguments: { round: 'brd_nope', left: 'bte_1', right: 'bte_2', outcome: 'left' } },
            { name: 'bench.start_round', arguments: { kind: 'design.page', prompt: 'x' } },
            { name: 'bench.run_eval', arguments: { kind: 'vision.answer', test_suite: [{ prompt: 'x' }] } },
        ]) {
            const r = await t.get('/mcp', { json: rpc('tools/call', call, 11) });
            assert.strictEqual(r.json().result.isError, true, `${call.name} should be a person error`);
            assert.match(r.json().result.content[0].text, /person/);
        }
    });

    await check('bench.start_round creates a task and round for a person', async () => {
        const r = await t.get('/mcp', { as: alice, json: rpc('tools/call', { name: 'bench.start_round', arguments: { kind: 'design.page', prompt: 'A page for a robot.' } }, 12) });
        assert.strictEqual(r.json().result.isError, false, JSON.stringify(r.json().result));
        assert.match(r.json().result.structuredContent.id, /^brd_/);
        roundId = r.json().result.structuredContent.id;
        await t.tick();
        const round = await t.get(`/api/v1/rounds/${roundId}`, { as: alice });
        assert.strictEqual(round.json().round.status, 'finished');
    });

    await check('bench.start_round with no prompt is a tool error', async () => {
        const r = await t.get('/mcp', { as: alice, json: rpc('tools/call', { name: 'bench.start_round', arguments: { kind: 'design.page' } }, 13) });
        assert.strictEqual(r.json().result.isError, true);
        assert.match(r.json().result.content[0].text, /prompt/);
    });

    await check('bench.run_eval with no suite is a tool error', async () => {
        const r = await t.get('/mcp', { as: alice, json: rpc('tools/call', { name: 'bench.run_eval', arguments: { kind: 'vision.answer' } }, 14) });
        assert.strictEqual(r.json().result.isError, true);
        assert.match(r.json().result.content[0].text, /test_suite/);
    });

    await check('bench.cast_judgement records a blind vote and reveals the entries', async () => {
        const pair = await t.get('/api/v1/judgements/next?kind=design.page', { as: bob });
        assert.strictEqual(pair.status, 200, pair.text);
        assert.ok(pair.json().left && pair.json().right);
        leftId = pair.json().left.id;
        rightId = pair.json().right.id;
        const r = await t.get('/mcp', { as: bob, json: rpc('tools/call', { name: 'bench.cast_judgement', arguments: { round: roundId, left: leftId, right: rightId, outcome: 'left' } }, 15) });
        assert.strictEqual(r.json().result.isError, false, JSON.stringify(r.json().result));
        assert.ok(r.json().result.structuredContent.revealed.left.model, 'revealed after the vote');
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

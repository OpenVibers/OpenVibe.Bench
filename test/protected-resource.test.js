'use strict';

/**
 * RFC 9728 on Bench's MCP endpoint: the protected-resource metadata at
 * /.well-known/oauth-protected-resource, and the WWW-Authenticate challenge on a 401. A call that needs a token
 * and has none answers 401 and names the metadata; a call that needs no token is still answered.
 */

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const protectedResource = require('../server/http/protected-resource');

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const METADATA_PATH = '/.well-known/oauth-protected-resource';

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');

    await check('the metadata document names the resource, the authorization server and the bearer method', async () => {
        const r = await t.get(METADATA_PATH);
        assert.strictEqual(r.status, 200, r.text);
        assert.match(r.headers.get('content-type'), /application\/json/);
        const doc = r.json();
        assert.strictEqual(doc.resource, 'https://bench.openvibe.services');
        assert.deepStrictEqual(doc.authorization_servers, [t.config.networkIssuer]);
        assert.ok(Array.isArray(doc.scopes_supported) && doc.scopes_supported.length > 0, 'scopes_supported is a non-empty list');
        assert.deepStrictEqual(doc.bearer_methods_supported, ['header']);
    });

    await check('the issuer is the Network when the configuration says so', async () => {
        const doc = protectedResource.document({ baseUrl: 'https://bench.openvibe.services', networkIssuer: 'https://openvibe.network' });
        assert.deepStrictEqual(doc.authorization_servers, ['https://openvibe.network']);
        assert.strictEqual(doc.resource_documentation, 'https://bench.openvibe.services/docs');
    });

    await check('a tool that needs a person answers 401 and names the metadata', async () => {
        const r = await t.get('/mcp', { json: rpc('tools/call', { name: 'bench.next_pair', arguments: { kind: 'design.page' } }, 7) });
        assert.strictEqual(r.status, 401, r.text);
        assert.strictEqual(r.headers.get('www-authenticate'), `Bearer resource_metadata="https://bench.openvibe.services${METADATA_PATH}"`);
        assert.strictEqual(r.json().error.code, -32001);
        assert.strictEqual(r.json().error.data.resource_metadata, `https://bench.openvibe.services${METADATA_PATH}`);
    });

    await check('a tool that needs no token is still answered', async () => {
        const r = await t.get('/mcp', { json: rpc('tools/call', { name: 'bench.list_kinds', arguments: {} }, 8) });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().result.isError, false);
        assert.strictEqual(r.headers.get('www-authenticate'), null);
    });

    await check('a token that does not verify answers 401 with the challenge', async () => {
        const r = await t.get('/mcp', { bearer: 'not-a-token', json: rpc('tools/call', { name: 'bench.next_pair', arguments: { kind: 'design.page' } }, 9) });
        assert.strictEqual(r.status, 401, r.text);
        assert.strictEqual(r.headers.get('www-authenticate'), `Bearer resource_metadata="https://bench.openvibe.services${METADATA_PATH}"`);
    });

    await check('a person with a token gets the tool', async () => {
        const r = await t.get('/mcp', { bearer: t.network.userToken(alice), json: rpc('tools/call', { name: 'bench.next_pair', arguments: { kind: 'design.page' } }, 10) });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().result.isError, false, r.text);
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

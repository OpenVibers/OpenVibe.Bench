'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');

    await check('a cookie write from another origin is refused', async () => {
        const r = await t.get('/api/v1/kinds/design.page/tasks', {
            as: alice,
            json: { prompt: 'A page for a robot.', public: true },
            origin: 'https://evil.example',
        });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json().code, 'bench.cross_site');
    });

    await check('the same cookie write is allowed from this origin', async () => {
        const r = await t.get('/api/v1/kinds/design.page/tasks', {
            as: alice,
            json: { prompt: 'A page for a robot.', public: true },
            origin: t.config.baseUrl,
        });
        assert.strictEqual(r.status, 201, r.text);
    });

    await check('a Bearer write is unaffected by the Origin header', async () => {
        const r = await t.get('/api/v1/kinds/design.page/tasks', {
            bearer: t.network.userToken(alice),
            json: { prompt: 'A page for a robot.', public: true },
            origin: 'https://evil.example',
        });
        assert.strictEqual(r.status, 201, r.text);
    });

    await check('stop', async () => { await t.close(); });

    done();
})();

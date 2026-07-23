const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const protection = require('../serverProtection');
const serversRouter = require('../routes/servers');
const serverRoutesSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'servers.js'), 'utf8');

test('default protected ports include 27015 and 27016', () => {
    assert.equal(protection.isProtectedPort(27015), true);
    assert.equal(protection.isProtectedPort('27016'), true);
    assert.equal(protection.isProtectedPort(27017), false);
    assert.throws(() => protection.assertDestructiveOperationAllowed(27015, 'reset'), /protected/);
});

test('reset route rejects a protected port before touching its container', async () => {
    let destructiveCall = false;
    const container = {
        inspect: async () => ({
            State: { Running: true },
            HostConfig: { PortBindings: { '27015/udp': [{ HostPort: '27015' }] } }
        }),
        stop: async () => { destructiveCall = true; },
        remove: async () => { destructiveCall = true; }
    };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { id: 1, role: 'admin' };
        req.docker = { getContainer: () => container };
        req.panelDb = { requireServerAccess: async () => ({ port: 27015 }) };
        next();
    });
    app.use('/api/servers', serversRouter);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/servers/test/reset`, { method: 'POST' });
        assert.equal(response.status, 409);
        assert.match((await response.json()).error, /protected/);
        assert.equal(destructiveCall, false);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('rental keeps the requested RCON password consistent between database and container', () => {
    assert.match(serverRoutesSource, /rcon_password = \?/);
    assert.match(serverRoutesSource, /RCON_PASSWORD=\$\{requestedRconPassword\}/);
    assert.doesNotMatch(serverRoutesSource, /RCON_PASSWORD=\$\{sRecord\.db_password/);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const Docker = require('dockerode');
const express = require('express');

const docker = new Docker();
const gamePort = 29998;
const containerName = `cspanel-integration-${process.pid}`;
const tempRoot = path.resolve(__dirname, '..', '.tmp-docker-integration');
const fastdlPortRoot = path.join(tempRoot, String(gamePort));
process.env.FASTDL_PATH = tempRoot;

const cFs = require('../containerFsHelper');
const filesRouter = require('../routes/files');
const mapsRouter = require('../routes/maps');
const pluginsRouter = require('../routes/plugins');

function formFile(filename, content, fields = {}) {
    const form = new FormData();
    form.append('file', new Blob([content]), filename);
    Object.entries(fields).forEach(([key, value]) => form.append(key, String(value)));
    return form;
}

async function jsonRequest(url, init) {
    const response = await fetch(url, init);
    const body = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
    return body;
}

async function main() {
    assert.ok(tempRoot.startsWith(path.resolve(__dirname, '..') + path.sep), 'Unsafe integration temp path');
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(fastdlPortRoot, { recursive: true });

    const bindSource = fastdlPortRoot.replace(/\\/g, '/');
    const container = await docker.createContainer({
        Image: 'cs16-server-base:latest',
        name: containerName,
        Entrypoint: ['sleep'],
        Cmd: ['infinity'],
        ExposedPorts: { [`${gamePort}/udp`]: {} },
        HostConfig: {
            Binds: [`${bindSource}:/fastdl-data`],
            PortBindings: { [`${gamePort}/udp`]: [{ HostIp: '127.0.0.1', HostPort: String(gamePort) }] }
        }
    });

    let httpServer;
    try {
        await container.start();
        const app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            req.docker = docker;
            req.user = { id: 1, role: 'admin' };
            req.panelDb = { requireServerAccess: async () => ({ id: containerName }) };
            next();
        });
        app.use('/api/files', filesRouter);
        app.use('/api/maps', mapsRouter);
        app.use('/api/plugins', pluginsRouter);
        httpServer = http.createServer(app);
        await new Promise((resolve, reject) => {
            httpServer.once('error', reject);
            httpServer.listen(0, '127.0.0.1', resolve);
        });
        const address = httpServer.address();
        const base = `http://127.0.0.1:${address.port}`;

        const wavA = Buffer.from('RIFF0000WAVEfmt ROUTE-A');
        const wavB = Buffer.from('RIFF0000WAVEfmt ROUTE-B');
        await jsonRequest(`${base}/api/files/${containerName}/upload`, {
            method: 'POST', body: formFile('route-test.wav', wavA, { path: 'sound/cspanel' })
        });
        await jsonRequest(`${base}/api/files/${containerName}/upload`, {
            method: 'POST', body: formFile('route-test.wav', wavB, { path: 'sound/cspanel' })
        });
        assert.deepEqual(fs.readFileSync(path.join(fastdlPortRoot, 'sound', 'cspanel', 'route-test.wav')), wavB);

        const tga = Buffer.from([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 24, 0, 255, 0, 0]);
        await jsonRequest(`${base}/api/files/${containerName}/upload`, {
            method: 'POST', body: formFile('route-test.tga', tga, { path: 'gfx/env' })
        });
        assert.deepEqual(fs.readFileSync(path.join(fastdlPortRoot, 'gfx', 'env', 'route-test.tga')), tga);

        const makeFolderForm = marker => {
            const form = new FormData();
            form.append('basePath', 'addons');
            for (let index = 0; index < 126; index++) {
                form.append('files', new Blob([`${marker}-${index}`]), `file-${index}.cfg`);
                form.append('relativePaths', `batch-126/file-${index}.cfg`);
            }
            return form;
        };
        const folderStartedAt = Date.now();
        const firstFolder = await jsonRequest(`${base}/api/files/${containerName}/upload-folder`, {
            method: 'POST', body: makeFolderForm('first')
        });
        const secondFolder = await jsonRequest(`${base}/api/files/${containerName}/upload-folder`, {
            method: 'POST', body: makeFolderForm('replacement')
        });
        const folderElapsedMs = Date.now() - folderStartedAt;
        assert.equal(firstFolder.uploaded, 126, JSON.stringify(firstFolder));
        assert.equal(secondFolder.uploaded, 126, JSON.stringify(secondFolder));
        assert.ok(folderElapsedMs < 20000, `126-file batch overwrite took ${folderElapsedMs}ms`);
        assert.equal((await cFs.listFiles(container, 'addons/batch-126')).length, 126);
        assert.equal((await cFs.readFile(container, 'addons/batch-126/file-125.cfg')).trim(), 'replacement-125');

        const bspA = Buffer.from('BSP-ROUTE-A');
        const bspB = Buffer.from('BSP-ROUTE-B');
        await jsonRequest(`${base}/api/maps/${containerName}/upload`, {
            method: 'POST', body: formFile('route_test.bsp', bspA, { addToCycle: true })
        });
        await jsonRequest(`${base}/api/maps/${containerName}/upload`, {
            method: 'POST', body: formFile('route_test.bsp', bspB, { addToCycle: true })
        });
        assert.deepEqual(fs.readFileSync(path.join(fastdlPortRoot, 'maps', 'route_test.bsp')), bspB);

        const sma = '#include <amxmodx>\npublic plugin_init() { register_plugin("Panel Test", "1.0", "Codex"); }\n';
        await jsonRequest(`${base}/api/plugins/${containerName}/upload`, {
            method: 'POST', body: formFile('panel_test.sma', sma)
        });
        await cFs.runExec(container, {
            Cmd: ['chmod', '0644', '/hlds/cstrike/addons/amxmodx/scripting/amxxpc']
        });
        const compile = await jsonRequest(`${base}/api/plugins/${containerName}/compile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: 'panel_test.sma', addToIni: true })
        });
        assert.equal(compile.success, true, compile.output || compile.error);
        assert.equal(await cFs.fileExists(container, 'addons/amxmodx/plugins/panel_test.amxx'), true);
        const pluginsIni = await cFs.readFile(container, 'addons/amxmodx/configs/plugins.ini');
        assert.match(pluginsIni, /(?:^|\n)panel_test\.amxx(?:\n|$)/);

        console.log(JSON.stringify({
            success: true,
            overwrite: ['wav', 'bsp'],
            folderBatch: { files: 126, passes: 2, elapsedMs: folderElapsedMs },
            fastdl: ['wav', 'tga', 'bsp'],
            compiler: 'sma-to-amxx'
        }));
    } finally {
        if (httpServer) await new Promise(resolve => httpServer.close(resolve));
        try { await container.remove({ force: true }); } catch (_) { /* best effort */ }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

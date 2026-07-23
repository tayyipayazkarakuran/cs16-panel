const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_ROOT = process.env.LOCAL_PANEL_URL || 'http://127.0.0.1:3100';
const FASTDL_ROOT = process.env.LOCAL_FASTDL_URL || 'http://127.0.0.1:18080';

function readEnv() {
    const envPath = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return {};
    return fs.readFileSync(envPath, 'utf8').split(/\r?\n/).reduce((values, line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return values;
        const separator = trimmed.indexOf('=');
        if (separator > 0) values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
        return values;
    }, {});
}

function formFile(filename, content, fields = {}) {
    const form = new FormData();
    form.append('file', new Blob([content]), filename);
    Object.entries(fields).forEach(([key, value]) => form.append(key, String(value)));
    return form;
}

async function main() {
    let panelReady = false;
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            const health = await fetch(`${API_ROOT}/api/auth/me`);
            if (health.status > 0) {
                panelReady = true;
                break;
            }
        } catch (_) {
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
    assert.equal(panelReady, true, `Panel did not become ready at ${API_ROOT}`);
    const localEnv = readEnv();
    const username = process.env.PANEL_ADMIN_USERNAME || localEnv.PANEL_ADMIN_USERNAME || 'admin';
    const password = process.env.PANEL_ADMIN_PASSWORD || localEnv.PANEL_ADMIN_PASSWORD || 'admin123';
    const candidates = [[username, password], ['admin', 'admin123']];
    let loginResponse;
    let login;
    for (const [candidateUser, candidatePassword] of candidates) {
        loginResponse = await fetch(`${API_ROOT}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: candidateUser, password: candidatePassword })
        });
        login = await loginResponse.json();
        if (loginResponse.ok) break;
    }
    assert.equal(loginResponse.ok, true, login.error || 'Local login failed');
    assert.ok(login.token, 'Login did not return a token');
    const headers = { Authorization: `Bearer ${login.token}` };

    const apiJson = async (url, init = {}) => {
        const response = await fetch(`${API_ROOT}${url}`, {
            ...init,
            headers: { ...headers, ...(init.headers || {}) }
        });
        const body = await response.json();
        assert.equal(response.ok, true, `${response.status} ${url}: ${JSON.stringify(body)}`);
        return body;
    };

    const servers = await apiJson('/api/servers');
    const server = servers.find(item => item.port === 27017) || servers.find(item => ![27015, 27016].includes(item.port));
    assert.ok(server, 'No non-protected local game server is available');
    const id = server.id;
    const port = server.port;
    const created = [
        'sound/cspanel/local_stack_test.wav',
        'gfx/env/local_stack_test.tga',
        'addons/amxmodx/scripting/local_stack_test.sma',
        'addons/amxmodx/plugins/local_stack_test.amxx'
    ];
    const fastdlFiles = [
        'sound/cspanel/local_stack_test.wav',
        'gfx/env/local_stack_test.tga'
    ];
    const batchFolder = 'addons/cspanel_local_batch';
    const batchCount = 126;

    try {
        const wavA = Buffer.from('RIFF0000WAVEfmt LOCAL-A');
        const wavB = Buffer.from('RIFF0000WAVEfmt LOCAL-B');
        const tga = Buffer.from([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 24, 0, 255, 0, 0]);
        await apiJson(`/api/files/${id}/upload`, {
            method: 'POST', body: formFile('local_stack_test.wav', wavA, { path: 'sound/cspanel' })
        });
        await apiJson(`/api/files/${id}/upload`, {
            method: 'POST', body: formFile('local_stack_test.wav', wavB, { path: 'sound/cspanel' })
        });
        await apiJson(`/api/files/${id}/upload`, {
            method: 'POST', body: formFile('local_stack_test.tga', tga, { path: 'gfx/env' })
        });

        const wavDownload = await fetch(`${API_ROOT}/api/files/${id}/download?file=${encodeURIComponent(created[0])}`, { headers });
        assert.equal(wavDownload.ok, true);
        assert.deepEqual(Buffer.from(await wavDownload.arrayBuffer()), wavB);
        const fastdlWav = await fetch(`${FASTDL_ROOT}/${port}/${fastdlFiles[0]}`);
        const fastdlTga = await fetch(`${FASTDL_ROOT}/${port}/${fastdlFiles[1]}`);
        assert.equal(fastdlWav.status, 200);
        assert.equal(fastdlTga.status, 200);
        assert.deepEqual(Buffer.from(await fastdlWav.arrayBuffer()), wavB);
        assert.deepEqual(Buffer.from(await fastdlTga.arrayBuffer()), tga);

        const bspA = Buffer.from('BSP-LOCAL-A');
        const bspB = Buffer.from('BSP-LOCAL-B');
        await apiJson(`/api/maps/${id}/upload`, {
            method: 'POST', body: formFile('local_stack_test.bsp', bspA, { addToCycle: false })
        });
        await apiJson(`/api/maps/${id}/upload`, {
            method: 'POST', body: formFile('local_stack_test.bsp', bspB, { addToCycle: false })
        });
        const fastdlMap = await fetch(`${FASTDL_ROOT}/${port}/maps/local_stack_test.bsp`);
        assert.equal(fastdlMap.status, 200);
        assert.deepEqual(Buffer.from(await fastdlMap.arrayBuffer()), bspB);

        const sma = '#include <amxmodx>\npublic plugin_init() { register_plugin("Local Stack", "1.0", "Codex"); }\n';
        await apiJson(`/api/plugins/${id}/upload`, {
            method: 'POST', body: formFile('local_stack_test.sma', sma)
        });
        const compile = await apiJson(`/api/plugins/${id}/compile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: 'local_stack_test.sma', addToIni: false })
        });
        assert.equal(compile.success, true, compile.output || compile.message);

        const uploadBatch = async marker => {
            const form = new FormData();
            for (let index = 0; index < batchCount; index++) {
                const relative = `group-${String(index % 7).padStart(2, '0')}/file-${String(index).padStart(3, '0')}.txt`;
                form.append('files', new Blob([`${marker}-${index}`]), path.posix.basename(relative));
                form.append('relativePaths', relative);
            }
            form.append('basePath', batchFolder);
            const started = Date.now();
            const result = await apiJson(`/api/files/${id}/upload-folder`, { method: 'POST', body: form });
            return { result, elapsedMs: Date.now() - started };
        };
        const firstBatch = await uploadBatch('FIRST');
        const replacementBatch = await uploadBatch('REPLACED');
        assert.equal(firstBatch.result.uploaded, batchCount);
        assert.equal(replacementBatch.result.uploaded, batchCount);
        assert.ok(firstBatch.elapsedMs < 20000, `First ${batchCount}-file upload took ${firstBatch.elapsedMs}ms`);
        assert.ok(replacementBatch.elapsedMs < 20000, `Replacement ${batchCount}-file upload took ${replacementBatch.elapsedMs}ms`);
        const replacedFile = `${batchFolder}/group-00/file-000.txt`;
        const replacedDownload = await fetch(`${API_ROOT}/api/files/${id}/download?file=${encodeURIComponent(replacedFile)}`, { headers });
        assert.equal(replacedDownload.ok, true);
        assert.equal(await replacedDownload.text(), 'REPLACED-0');

        console.log(JSON.stringify({
            success: true,
            serverPort: port,
            overwrite: ['file', 'map'],
            compiler: 'sma-to-amxx',
            fastdlHttp: ['wav:200', 'tga:200', 'bsp:200'],
            folderBatch: {
                files: batchCount,
                passes: 2,
                firstMs: firstBatch.elapsedMs,
                replacementMs: replacementBatch.elapsedMs
            }
        }));
    } finally {
        await apiJson(`/api/files/${id}?file=${encodeURIComponent(batchFolder)}`, { method: 'DELETE' }).catch(() => {});
        await apiJson(`/api/maps/${id}?filename=local_stack_test.bsp`, { method: 'DELETE' }).catch(() => {});
        for (const file of created) {
            await apiJson(`/api/files/${id}?file=${encodeURIComponent(file)}`, { method: 'DELETE' }).catch(() => {});
        }
        for (const file of fastdlFiles) {
            await apiJson(`/api/fastdl/${port}/file?path=${encodeURIComponent(file)}`, { method: 'DELETE' }).catch(() => {});
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

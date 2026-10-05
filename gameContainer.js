// Shared game-container lifecycle helpers. Rental, reset, plan changes, the
// pool service and expiry reclamation all build containers the same way so
// FastDL, MySQL and PHP mounts/variables can never diverge between them.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const containerFs = require('./containerFsHelper');
const fastdl = require('./fastdlService');

function volumeName(port) {
    return `cs16-server-${parseInt(port, 10)}-cstrike`;
}

function gamePortFromInspect(info) {
    const bindings = (info && info.HostConfig && info.HostConfig.PortBindings) || {};
    for (const [key, values] of Object.entries(bindings)) {
        if (key.endsWith('/udp') && values && values[0] && values[0].HostPort) {
            return parseInt(values[0].HostPort, 10);
        }
    }
    return null;
}

/** Characters that would break server.cfg / shell env handling. */
function sanitizeServerName(name, fallback) {
    const clean = String(name || '').replace(/[\u0000-\u001f\u007f"\\;]/g, '').trim().slice(0, 64);
    return clean || fallback;
}

function sanitizeMapName(map) {
    const value = String(map || '').trim();
    return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'de_dust2';
}

async function networkExists(docker, name) {
    try {
        await docker.getNetwork(name).inspect();
        return true;
    } catch (_) {
        return false;
    }
}

function cpusetFor(port) {
    if (process.env.GAME_CPUSET_MODE === 'none') return undefined;
    return (port % 2 === 1) ? '0' : '1';
}

async function buildCreateOptions(docker, { port, name, rconPassword, maxPlayers = 24, startMap = 'de_dust2', sql = null, image = null }) {
    const p = parseInt(port, 10);
    const vol = volumeName(p);
    const ExposedPorts = { [`${p}/udp`]: {}, [`${p}/tcp`]: {} };
    const PortBindings = {
        [`${p}/udp`]: [{ HostPort: String(p) }],
        [`${p}/tcp`]: [{ HostPort: String(p) }]
    };
    const env = [
        `PORT=${p}`,
        `SERVER_NAME=${sanitizeServerName(name, `CS 1.6 Server ${p}`)}`,
        `RCON_PASSWORD=${rconPassword}`,
        `MAXPLAYERS=${Math.min(32, Math.max(2, parseInt(maxPlayers, 10) || 24))}`,
        `START_MAP=${sanitizeMapName(startMap)}`,
        `SV_DOWNLOADURL=${cfg.fastdlUrl(p)}`
    ];
    if (sql && sql.db_name) {
        env.push(
            `AMX_SQL_HOST=${cfg.mysql.internalHost}:${cfg.mysql.internalPort}`,
            `AMX_SQL_USER=${sql.db_username}`,
            `AMX_SQL_PASS=${sql.db_password}`,
            `AMX_SQL_DB=${sql.db_name}`
        );
    }
    const hostConfig = {
        PortBindings,
        Binds: [
            `${vol}:/hlds/cstrike`,
            `${cfg.fastdl.hostPath}/${p}:/fastdl-data`
        ],
        RestartPolicy: { Name: 'unless-stopped' },
        CapAdd: ['SYS_NICE'],
        Ulimits: [{ Name: 'rtprio', Soft: 99, Hard: 99 }],
        Memory: parseInt(process.env.GAME_MEMORY_LIMIT_MB || '0', 10) * 1024 * 1024 || undefined
    };
    const cpuset = cpusetFor(p);
    if (cpuset !== undefined) hostConfig.CpusetCpus = cpuset;
    // Joining cs-network at creation (instead of after start) means the
    // server can already reach cs-mysql while AMX Mod X loads on first boot.
    if (await networkExists(docker, cfg.docker.network)) hostConfig.NetworkMode = cfg.docker.network;

    return {
        Image: image || cfg.docker.gameImage,
        name: `cs16-server-${p}`,
        ExposedPorts,
        Env: env,
        Labels: { 'cs-panel.managed': 'true', 'cs-panel.port': String(p) },
        HostConfig: hostConfig
    };
}

async function removeContainerQuietly(docker, containerId) {
    if (!containerId) return;
    const container = docker.getContainer(containerId);
    try { await container.stop({ t: 5 }); } catch (_) { /* not running */ }
    try { await container.remove({ force: true, v: true }); } catch (_) { /* already gone */ }
}

async function removeContainerByName(docker, name) {
    try {
        const list = await docker.listContainers({ all: true, filters: { name: [`^/${name}$`] } });
        for (const c of list) await removeContainerQuietly(docker, c.Id);
    } catch (_) { /* ignore */ }
}

async function removeVolumeWithRetry(docker, port, attempts = 6) {
    const vol = docker.getVolume(volumeName(port));
    for (let i = 0; i < attempts; i++) {
        try {
            await vol.remove();
            return true;
        } catch (err) {
            if (err.statusCode === 404) return true;
            if (i === attempts - 1) {
                console.log(`Failed to remove volume ${volumeName(port)}:`, err.message);
                return false;
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }
    return false;
}

/** Create + start a game container, replacing any container with the same name. */
async function createGameContainer(docker, options) {
    const createOpts = await buildCreateOptions(docker, options);
    await removeContainerByName(docker, createOpts.name);
    fastdl.ensureFastdlTree(options.port);
    const container = await docker.createContainer(createOpts);
    await container.start();
    if (!createOpts.HostConfig.NetworkMode) {
        try { await docker.getNetwork(cfg.docker.network).connect({ Container: container.id }); } catch (_) { /* optional */ }
    }
    return container;
}

async function waitForContainerReady(container, maxWaitMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        try {
            const info = await container.inspect();
            if (info.State.Running && await containerFs.fileExists(container, 'server.cfg')) return true;
        } catch (_) { /* still starting */ }
        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

async function syncFastdlWithRetry(container, port, categories = null, retries = 5, delayMs = 2000) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            const result = await fastdl.syncFastdlFromContainer(container, port, categories);
            if (result && result.success !== false) return result;
            lastError = new Error(result && result.message);
        } catch (e) {
            lastError = e;
        }
        if (i < retries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
    throw lastError;
}

/** Make sure server.cfg points clients at this server's FastDL directory. */
async function ensureSvDownloadUrl(container, port) {
    const url = cfg.fastdlUrl(port);
    const script = `
import re, sys
path = '/hlds/cstrike/server.cfg'
url = sys.argv[1]
try:
    content = open(path, 'r', encoding='utf-8', errors='ignore').read()
except FileNotFoundError:
    content = ''
line = 'sv_downloadurl "' + url + '"'
pattern = re.compile(r'^[ \\t]*sv_downloadurl[ \\t].*$', re.M)
if pattern.search(content):
    content = pattern.sub(line, content)
else:
    content = content.rstrip('\\n') + '\\n' + line + '\\n'
if not re.search(r'^[ \\t]*sv_allowdownload[ \\t]', content, re.M):
    content += 'sv_allowdownload 1\\n'
open(path, 'w', encoding='utf-8').write(content)
`;
    try {
        await containerFs.runExec(container, { Cmd: ['python3', '-c', script, url] });
    } catch (e) {
        console.log('ensureSvDownloadUrl warning:', e.message);
    }
    return url;
}

/** Write the per-server MySQL credentials into AMX Mod X's sql.cfg. */
async function ensureSqlCfg(container, record) {
    if (!record || !record.db_name) return;
    const script = `
import os, re, sys
path = '/hlds/cstrike/addons/amxmodx/configs/sql.cfg'
values = dict(zip(['amx_sql_host', 'amx_sql_user', 'amx_sql_pass', 'amx_sql_db'], sys.argv[1:5]))
values['amx_sql_type'] = 'mysql'
os.makedirs(os.path.dirname(path), exist_ok=True)
content = open(path, 'r', encoding='utf-8', errors='ignore').read() if os.path.exists(path) else ''
for key, val in values.items():
    line = key + ' "' + val + '"'
    pattern = re.compile(r'^[ \\t]*' + key + r'[ \\t].*$', re.M)
    content = pattern.sub(line, content) if pattern.search(content) else content.rstrip('\\n') + '\\n' + line + '\\n'
open(path, 'w', encoding='utf-8').write(content)
`;
    try {
        await containerFs.runExec(container, {
            Cmd: ['python3', '-c', script, `${cfg.mysql.internalHost}:${cfg.mysql.internalPort}`, record.db_username, record.db_password, record.db_name]
        });
    } catch (e) {
        console.log('ensureSqlCfg warning:', e.message);
    }
}

/**
 * Background post-boot configuration: once server.cfg exists, write the
 * FastDL URL and SQL credentials and mirror downloadable assets.
 */
function finishProvisioningInBackground(container, record, { syncFastdl = true } = {}) {
    (async () => {
        const ready = await waitForContainerReady(container);
        if (!ready) {
            console.log(`[Provision] container for port ${record.port} did not become ready in time`);
            return;
        }
        await ensureSvDownloadUrl(container, record.port);
        await ensureSqlCfg(container, record);
        if (syncFastdl) {
            try { await syncFastdlWithRetry(container, record.port); } catch (e) {
                console.log(`[Provision] FastDL sync failed for ${record.port}:`, e.message);
            }
        }
    })().catch(e => console.log('[Provision] background error:', e.message));
}

// ---------------------------------------------------------------------------
//  PHP area helpers (directory on the shared php-www volume)
// ---------------------------------------------------------------------------

function resolveInside(base, rel = '') {
    const resolvedBase = path.resolve(base);
    const resolved = path.resolve(resolvedBase, rel);
    if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
        const err = new Error('Access denied');
        err.statusCode = 403;
        throw err;
    }
    return resolved;
}

function removePhpArea(record) {
    if (!record || !record.php_path) return;
    const dir = resolveInside(cfg.php.wwwPath, record.php_path);
    if (dir !== path.resolve(cfg.php.wwwPath) && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
    volumeName,
    gamePortFromInspect,
    sanitizeServerName,
    sanitizeMapName,
    buildCreateOptions,
    createGameContainer,
    removeContainerQuietly,
    removeVolumeWithRetry,
    waitForContainerReady,
    syncFastdlWithRetry,
    ensureSvDownloadUrl,
    ensureSqlCfg,
    finishProvisioningInBackground,
    removePhpArea,
    resolveInside
};

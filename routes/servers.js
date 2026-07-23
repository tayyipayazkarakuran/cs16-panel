const express = require('express');
const router = express.Router();
const net = require('net');
const fs = require('fs');
const path = require('path');
const queryHelper = require('../queryHelper');
const fastdl = require('../fastdlService');
const containerFs = require('../containerFsHelper');
const { PROTECTED_SERVER_PORTS, assertDestructiveOperationAllowed, isProtectedPort } = require('../serverProtection');

const PHP_WWW_PATH = process.env.PHP_WWW_PATH || path.join(__dirname, '..', 'php-www');

// Resolve public-facing service URLs from env (set in docker-compose / .env)
const PANEL_PUBLIC_URL = (process.env.PANEL_PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
const FASTDL_HOST = process.env.FASTDL_HOST || '127.0.0.1';
const FASTDL_PORT = process.env.FASTDL_PORT || '8080';
const MYSQL_PUBLIC_HOST = process.env.MYSQL_PUBLIC_HOST || process.env.MYSQL_HOST || '127.0.0.1';
const MYSQL_PUBLIC_PORT = parseInt(process.env.MYSQL_PUBLIC_PORT || process.env.MYSQL_PORT || '3306', 10);
const PHP_PUBLIC_BASE_URL = process.env.PHP_PUBLIC_BASE_URL || `http://${FASTDL_HOST}:8081`;

/** Build the public FastDL URL for a given port */
function publicFastdlUrl(port) {
    const portStr = (FASTDL_PORT === '80' || FASTDL_PORT === '443') ? '' : `:${FASTDL_PORT}`;
    return `http://${FASTDL_HOST}${portStr}/${port}/`;
}

/** Build the public PHP URL for a given port */
function publicPhpUrl(port) {
    // If PHP_PUBLIC_BASE_URL contains '{port}', replace it; else append ?p=<port>
    if (PHP_PUBLIC_BASE_URL.includes('{port}')) {
        return PHP_PUBLIC_BASE_URL.replace('{port}', port);
    }
    return `${PHP_PUBLIC_BASE_URL}/?p=${port}`;
}

// In-memory cache for server stats (FPS, CPU) to prevent spamming RCON logs
const statsCache = {};

function routeError(res, e) {
    res.status(e.statusCode || 500).json({ error: e.message });
}

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

function ensurePhpArea(serverRecord) {
    if (!serverRecord || !serverRecord.php_path) return;
    const phpDir = resolveInside(PHP_WWW_PATH, serverRecord.php_path);
    if (!fs.existsSync(phpDir)) fs.mkdirSync(phpDir, { recursive: true });
    const htaccessPath = path.join(phpDir, '.htaccess');
    if (!fs.existsSync(htaccessPath)) {
        fs.writeFileSync(htaccessPath, 'Options -Indexes\n');
    }
}

function removePhpArea(serverRecord) {
    if (!serverRecord || !serverRecord.php_path) return;
    const phpDir = resolveInside(PHP_WWW_PATH, serverRecord.php_path);
    if (fs.existsSync(phpDir)) fs.rmSync(phpDir, { recursive: true, force: true });
}

// Wait for the game container to finish its initial setup (hlds_clean copy)
async function waitForContainerReady(container, maxWaitMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        try {
            const info = await container.inspect();
            if (!info.State.Running) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            // server.cfg is copied as part of the clean image setup
            if (await containerFs.fileExists(container, 'server.cfg')) {
                return true;
            }
        } catch (e) {
            // container may still be starting; ignore and retry
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

async function syncFastdlWithRetry(container, port, categories = null, retries = 5, delayMs = 2000) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            return await fastdl.syncFastdlFromContainer(container, port, categories);
        } catch (e) {
            lastError = e;
            console.log(`FastDL sync attempt ${i + 1}/${retries} failed for port ${port}:`, e.message);
            if (i < retries - 1) await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw lastError;
}

async function ensureSvDownloadUrl(container, port) {
    const fastdlHost = process.env.FASTDL_HOST || '127.0.0.1';
    const fastdlPort = process.env.FASTDL_PORT || '8080';
    const svDownloadUrl = `http://${fastdlHost}:${fastdlPort}/${port}/`;

    const pythonScript = `
import sys, re
cfg_path = '/hlds/cstrike/server.cfg'
url = sys.argv[1]
try:
    with open(cfg_path, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()
    if 'sv_downloadurl' not in content:
        content += '\\nsv_downloadurl "' + url + '"\\n'
    else:
        content = re.sub(r'sv_downloadurl\\s+"[^"]*"', 'sv_downloadurl "' + url + '"', content)
        content = re.sub(r"sv_downloadurl\\s+'[^']*'", 'sv_downloadurl "' + url + '"', content)
    with open(cfg_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print('OK')
except Exception as e:
    print('ERR:', e)
`;
    try {
        await containerFs.runExec(container, {
            Cmd: ['python3', '-c', pythonScript, svDownloadUrl],
            AttachStdout: true,
            AttachStderr: true
        });
    } catch (e) {
        console.log('ensureSvDownloadUrl warning:', e.message);
    }
    return svDownloadUrl;
}

async function ensureSqlCfg(container, serverRecord) {
    if (!serverRecord || !serverRecord.db_name) return;

    const host = MYSQL_PUBLIC_HOST;
    const user = serverRecord.db_username;
    const pass = serverRecord.db_password;
    const db = serverRecord.db_name;

    const pythonScript = `
import sys, re, os
cfg_path = '/hlds/cstrike/addons/amxmodx/configs/sql.cfg'
host = sys.argv[1]
user = sys.argv[2]
password = sys.argv[3]
database = sys.argv[4]

try:
    os.makedirs(os.path.dirname(cfg_path), exist_ok=True)
    content = ""
    if os.path.exists(cfg_path):
        with open(cfg_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()

    # Update or add configurations
    def update_cfg(cfg_text, key, val):
        pattern = r'^\\s*' + key + r'\\s+"[^"]*"'
        repl = key + ' "' + val + '"'
        if re.search(pattern, cfg_text, re.M):
            return re.sub(pattern, repl, cfg_text, flags=re.M)
        else:
            return cfg_text.strip() + '\\n' + repl + '\\n'

    content = update_cfg(content, 'amx_sql_host', host)
    content = update_cfg(content, 'amx_sql_user', user)
    content = update_cfg(content, 'amx_sql_pass', password)
    content = update_cfg(content, 'amx_sql_db', database)
    content = update_cfg(content, 'amx_sql_table', 'csstats')
    content = update_cfg(content, 'amx_sql_type', 'mysql')

    with open(cfg_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print('OK')
except Exception as e:
    print('ERR:', e)
`;
    try {
        await containerFs.runExec(container, {
            Cmd: ['python3', '-c', pythonScript, host, user, pass, db],
            AttachStdout: true,
            AttachStderr: true
        });
    } catch (e) {
        console.log('ensureSqlCfg warning:', e.message);
    }
}

// Helper to check if a port is in use on the host
function isPortInUse(port) {
    return new Promise((resolve) => {
        const tester = net.createServer()
            .once('error', (err) => {
                if (err.code === 'EADDRINUSE') resolve(true);
                else resolve(false);
            })
            .once('listening', () => {
                tester.once('close', () => resolve(false)).close();
            })
            .listen(port);
    });
}

// Helper to find next free port starting from 27015
async function findFreePort(docker, startPort = 27015) {
    let port = startPort;
    const containers = await docker.listContainers({ all: true });
    
    // Collect all ports used by docker containers
    const usedPorts = new Set();
    containers.forEach(c => {
        if (c.Ports && c.Ports.length > 0) {
            c.Ports.forEach(p => {
                if (p.PublicPort) {
                    usedPorts.add(p.PublicPort);
                }
            });
        }
    });

    while (true) {
        if (usedPorts.has(port) || await isPortInUse(port)) {
            port++;
        } else {
            return port;
        }
    }
}

// In-memory cache for live server status/queries to drastically reduce dashboard loading latency
const serverStatusCache = {};

// GET /api/servers - List all CS 1.6 server containers with status
router.get('/', async (req, res) => {
    try {
        const containers = await req.docker.listContainers({ all: true });
        let serverRecords;
        if (req.user.role === 'admin') {
            serverRecords = await req.panelDb.listServersForUser(req.user);
        } else {
            const owned = await req.panelDb.listServersForUser(req.user);
            const pool = await req.panelDb.listUnrentedPoolServers();
            serverRecords = [...owned, ...pool];
        }
        const recordsById = new Map(serverRecords.map(r => [r.container_id, r]));
        
        // Filter containers running our cs16 image by name pattern or database association
        const csContainers = containers
            .filter(c => c.Names.some(n => n.includes('cs16-server-')) || recordsById.has(c.Id))
            .filter(c => req.user.role === 'admin' || recordsById.has(c.Id));
        
        const now = Date.now();
        const cacheTTL = 10000; // 10 seconds cache TTL for live UDP/RCON queries
        
        const servers = await Promise.all(csContainers.map(async (c) => {
            try {
                // Check memory cache first
                const cached = serverStatusCache[c.Id];
                if (cached && (now - cached.timestamp < cacheTTL) && cached.state === c.State) {
                    return {
                        ...cached.data,
                        state: c.State,
                        statusText: c.Status
                    };
                }

                let serverRecord = recordsById.get(c.Id);
                if (!serverRecord) {
                    serverRecord = await req.panelDb.requireServerAccess(req.user, req.docker, c.Id);
                }
                const container = req.docker.getContainer(c.Id);
                const info = await container.inspect();
                
                // Get port bindings
                let port = 27015;
                const portBindings = info.HostConfig.PortBindings;
                for (const key in portBindings) {
                    if (key.endsWith('/udp')) {
                        port = parseInt(portBindings[key][0].HostPort);
                        break;
                    }
                }

                // Get env settings
                const env = info.Config.Env;
                let rconPassword = serverRecord.rcon_password || 'rcon123';
                let maxPlayers = 32;
                let currentMap = 'de_dust2';
                let name = `Server ${port}`;

                const maxPlayersEnv = env.find(e => e.startsWith('MAXPLAYERS='));
                if (maxPlayersEnv) maxPlayers = parseInt(maxPlayersEnv.split('=')[1]);

                const mapEnv = env.find(e => e.startsWith('START_MAP='));
                if (mapEnv) currentMap = mapEnv.split('=')[1];

                const nameEnv = env.find(e => e.startsWith('SERVER_NAME='));
                if (nameEnv) name = nameEnv.split('=')[1];

                let status = {
                    name,
                    map: currentMap,
                    players: 0,
                    maxPlayers,
                    online: false,
                    fps: 0,
                    cpu: 0
                };

                if (c.State === 'running') {
                    const ip = queryHelper.getServerIp(info);
                    
                    // Run A2S_INFO query and RCON stats queries in parallel
                    const liveInfoPromise = queryHelper.getServerInfo(ip, port);
                    
                    const statsCached = statsCache[c.Id];
                    let statsPromise;
                    if (statsCached && (now - statsCached.timestamp < 60000)) {
                        statsPromise = Promise.resolve(statsCached.stats);
                    } else {
                        statsPromise = queryHelper.getServerStats(ip, port, rconPassword).then(stats => {
                            statsCache[c.Id] = {
                                stats: { fps: stats.fps, cpu: stats.cpu },
                                timestamp: Date.now()
                            };
                            return stats;
                        }).catch(() => ({ fps: 0, cpu: 0 }));
                    }

                    const [liveInfo, stats] = await Promise.all([liveInfoPromise, statsPromise]);
                    
                    if (liveInfo.online) {
                        status.name = liveInfo.name;
                        status.map = liveInfo.map;
                        status.players = liveInfo.players;
                        status.maxPlayers = liveInfo.maxPlayers;
                        status.online = true;
                        status.fps = stats.fps;
                        status.cpu = stats.cpu;
                    }
                }

                const serverData = {
                    id: c.Id,
                    name: status.name,
                    owner: serverRecord.owner_username,
                    owner_id: serverRecord.owner_id,
                    ip: process.env.GAME_SERVER_HOST || process.env.HOST_IP || FASTDL_HOST,
                    state: c.State,
                    statusText: c.Status,
                    port,
                    map: status.map,
                    players: status.players,
                    maxPlayers: status.maxPlayers,
                    online: status.online,
                    fps: status.fps,
                    cpu: status.cpu,
                    plan_type: serverRecord.plan_type,
                    expires_at: serverRecord.expires_at,
                    sql: serverRecord.db_name ? {
                        database: serverRecord.db_name,
                        username: serverRecord.db_username,
                        host: MYSQL_PUBLIC_HOST,
                        port: MYSQL_PUBLIC_PORT
                    } : null,
                    php: serverRecord.php_path ? {
                        path: serverRecord.php_path,
                        url: serverRecord.php_url || publicPhpUrl(port)
                    } : null,
                    fastdl: {
                        path: serverRecord.fastdl_path || String(port),
                        url: serverRecord.sv_downloadurl || publicFastdlUrl(port)
                    }
                };

                // Store in memory cache
                serverStatusCache[c.Id] = {
                    data: serverData,
                    state: c.State,
                    timestamp: Date.now()
                };

                return serverData;
            } catch (err) {
                console.error(`Error loading cs16 container ${c.Id.slice(0, 12)}:`, err.message);
                return null;
            }
        }));

        const activeServers = servers.filter(s => s !== null);
        activeServers.sort((a, b) => a.port - b.port);
        res.json(activeServers);
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/servers/create - Create a new CS 1.6 server
router.post('/create', async (req, res) => {
    try {
        const plan = req.body.plan || 'standard';
        const requestPort = parseInt(req.body.port, 10);
        if (requestPort && isProtectedPort(requestPort)) {
            return res.status(409).json({ error: `Port ${requestPort} is protected and unavailable for rental.` });
        }
        if (!['standard', 'pro'].includes(plan)) {
            return res.status(400).json({ error: 'Lütfen geçerli bir paket seçiniz (standard veya pro).' });
        }

        const requestedRconPassword = String(req.body.rconPassword || '').trim();
        if (!/^\S{8,64}$/.test(requestedRconPassword)) {
            return res.status(400).json({ error: 'RCON password must be 8-64 characters and cannot contain spaces.' });
        }

        // Get dynamic limits from settings
        const priceStandard = parseFloat(await req.panelDb.getSetting('price_standard') || '250');
        const pricePro = parseFloat(await req.panelDb.getSetting('price_pro') || '350');
        const maxPlayersStandard = parseInt(await req.panelDb.getSetting('max_players_standard') || '24', 10);
        const maxPlayersPro = parseInt(await req.panelDb.getSetting('max_players_pro') || '32', 10);

        let price = 0;
        let maxPlayers = 24;

        if (plan === 'standard') {
            price = priceStandard;
            maxPlayers = maxPlayersStandard;
        } else if (plan === 'pro') {
            price = pricePro;
            maxPlayers = maxPlayersPro;
        }

        // Deduct balance first
        if (price > 0) {
            try {
                await req.panelDb.deductUserBalance(req.user.id, price);
            } catch (balErr) {
                return res.status(400).json({ error: balErr.message || 'Insufficient balance. Please add funds to rent a server.' });
            }
        }

        // Find available server in the 10 always-on pool (specific port if requested, otherwise first available)
        const protectedPorts = [...PROTECTED_SERVER_PORTS];
        let queryStr = "SELECT * FROM panel_servers WHERE owner_id = 1";
        const queryParams = [];
        if (protectedPorts.length) {
            queryStr += ` AND port NOT IN (${protectedPorts.map(() => '?').join(',')})`;
            queryParams.push(...protectedPorts);
        }
        if (requestPort) {
            queryStr += " AND port = ?";
            queryParams.push(requestPort);
        }
        queryStr += " LIMIT 1";

        const [available] = await req.panelDb.assertPool().query(queryStr, queryParams);

        if (!available || !available[0]) {
            // Refund balance since no server was found
            if (price > 0) {
                await req.panelDb.assertPool().query(
                    "UPDATE panel_users SET balance = balance + ? WHERE id = ?",
                    [price, req.user.id]
                );
            }
            return res.status(400).json({ error: 'All servers in the pool are currently rented. Please try again later.' });
        }

        const sRecord = available[0];
        const port = sRecord.port;
        assertDestructiveOperationAllowed(port, 'rented or reset');
        const containerId = sRecord.container_id;
        const serverName = req.body.name || `CS 1.6 Server ${port}`;

        // Calculate expires_at (30 days from now)
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        // Update database record to change ownership and plan details
        await req.panelDb.assertPool().query(
            "UPDATE panel_servers SET owner_id = ?, plan_type = ?, name = ?, rcon_password = ?, expires_at = ? WHERE id = ?",
            [req.user.id, plan, serverName, requestedRconPassword, expiresAt, sRecord.id]
        );

        // Now run clean reset on this container so user gets a completely fresh startup
        const container = req.docker.getContainer(containerId);
        let info = null;
        try {
            info = await container.inspect();
        } catch(e) {
            // If container is missing, heal pool and raise error
            await require('../poolService').ensurePool(req.docker);
            return res.status(500).json({ error: 'Kiralama sırasında bir hata oluştu, lütfen tekrar deneyiniz.' });
        }

        // Reset server files (similar to POST /:id/reset logic)
        const volumeName = `cs16-server-${port}-cstrike`;
        if (info.State.Running) {
            await container.stop({ t: 5 }).catch(() => {});
        }
        await container.remove({ v: true }).catch(() => {});
        
        try {
            const volume = req.docker.getVolume(volumeName);
            await volume.remove();
        } catch (volErr) {}

        // Drop old MySQL and recreate for this server
        try {
            await req.panelDb.dropSqlAccount(sRecord.db_name, sRecord.db_username);
        } catch(e) {}

        // Recreate container with new ownership variables
        const cpuset = (port % 2 === 1) ? '0' : '1';
        const ExposedPorts = {};
        ExposedPorts[`${port}/udp`] = {};
        ExposedPorts[`${port}/tcp`] = {};
        const PortBindings = {};
        PortBindings[`${port}/udp`] = [{ HostPort: port.toString() }];
        PortBindings[`${port}/tcp`] = [{ HostPort: port.toString() }];

        const fastdlPath = process.env.FASTDL_HOST_PATH || '/opt/cspanel/fastdl-data';
        const phpWwwPath = process.env.PHP_WWW_HOST_PATH || '/opt/cspanel/php-www';
        const svDownloadUrl = publicFastdlUrl(port);

        const createOpts = {
            Image: 'cs16-server-base',
            name: `cs16-server-${port}`,
            ExposedPorts,
            Env: [
                `PORT=${port}`,
                `SERVER_NAME=${serverName}`,
                `RCON_PASSWORD=${requestedRconPassword}`,
                `MAXPLAYERS=${maxPlayers}`,
                `START_MAP=de_dust2`,
                `SV_DOWNLOADURL=${svDownloadUrl}`
            ],
            HostConfig: {
                PortBindings,
                Binds: [
                    `${volumeName}:/hlds/cstrike`,
                    `${fastdlPath}/${port}:/fastdl-data`,
                    `${phpWwwPath}/${port}:/php-www`
                ],
                RestartPolicy: { Name: 'always' },
                CapAdd: ['SYS_NICE'],
                CpusetCpus: cpuset,
                Ulimits: [
                    { Name: 'rtprio', Soft: 99, Hard: 99 }
                ]
            }
        };

        const newContainer = await req.docker.createContainer(createOpts);
        await newContainer.start();
        
        try {
            const network = req.docker.getNetwork('cs-network');
            await network.connect({ Container: newContainer.id });
        } catch (netErr) {}

        // Update container_id in database
        await req.panelDb.assertPool().query(
            "UPDATE panel_servers SET container_id = ? WHERE id = ?",
            [newContainer.id, sRecord.id]
        );

        // Fetch updated record and provision DB/FastDL
        let updatedRecord = await req.panelDb.requireServerAccess(req.user, req.docker, newContainer.id);
        updatedRecord = await req.panelDb.provisionSqlForRecord(updatedRecord);
        fastdl.ensureCleanFastdlTree(port);
        ensurePhpArea(updatedRecord);

        const ready = await waitForContainerReady(newContainer);
        if (ready) {
            await ensureSvDownloadUrl(newContainer, port);
            await ensureSqlCfg(newContainer, updatedRecord);
            try {
                await syncFastdlWithRetry(newContainer, port);
            } catch (syncErr) {}
        }

        res.json({
            success: true,
            message: `Sunucu başarıyla kiralandı! Port: ${port}`,
            containerId: newContainer.id,
            port
        });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/servers/:id/renew - Extend server duration by 30 days (User)
router.post('/:id/renew', async (req, res) => {
    try {
        const server = await req.panelDb.getServerByContainerId(req.params.id);
        if (!server) {
            return res.status(404).json({ error: 'Server not found' });
        }

        if (server.plan_type === 'free') {
            return res.status(400).json({ error: 'Ücretsiz paketler uzatılamaz.' });
        }

        const priceStandard = parseFloat(await req.panelDb.getSetting('price_standard') || '250');
        const pricePro = parseFloat(await req.panelDb.getSetting('price_pro') || '350');

        let price = priceStandard;
        if (server.plan_type === 'pro') {
            price = pricePro;
        }

        // Deduct price from balance
        try {
            await req.panelDb.deductUserBalance(req.user.id, price);
        } catch (balErr) {
            return res.status(400).json({ error: balErr.message || 'Yetersiz bakiye. Süre uzatabilmek için lütfen bakiye yükleyiniz.' });
        }

        // Add 30 days
        const newExpiry = await req.panelDb.renewServerDuration(server.id, 30);

        res.json({
            success: true,
            message: 'Server duration extended by 30 days successfully.',
            expires_at: newExpiry
        });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/servers/:id/start - Start server
router.post('/:id/start', async (req, res) => {
    try {
        const serverRecord = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);
        await container.start();

        // Background sync FastDL on boot
        const port = serverRecord.port;
        if (port) {
            waitForContainerReady(container).then(() => {
                syncFastdlWithRetry(container, port).catch(err => {
                    console.log(`Auto FastDL sync on start failed for port ${port}:`, err.message);
                });
            }).catch(() => {});
        }

        res.json({ success: true, message: 'Server started' });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/servers/:id/stop - Stop server
router.post('/:id/stop', async (req, res) => {
    try {
        await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);
        await container.stop();
        res.json({ success: true, message: 'Server stopped' });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/servers/:id/restart - Restart server
router.post('/:id/restart', async (req, res) => {
    try {
        const serverRecord = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);
        await container.restart();

        // Background sync FastDL on reboot
        const port = serverRecord.port;
        if (port) {
            waitForContainerReady(container).then(() => {
                syncFastdlWithRetry(container, port).catch(err => {
                    console.log(`Auto FastDL sync on restart failed for port ${port}:`, err.message);
                });
            }).catch(() => {});
        }

        res.json({ success: true, message: 'Server restarted' });
    } catch (e) {
        routeError(res, e);
    }
});

// DELETE /api/servers/:id - Delete server (Admin Only)
router.delete('/:id', async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Yalnızca yöneticiler sunucu silebilir.' });
        }
        const serverRecord = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);
        const info = await container.inspect();
        let port = null;
        const portBindings = info.HostConfig.PortBindings;
        for (const key in portBindings) {
            if (key.endsWith('/udp')) {
                port = portBindings[key][0].HostPort;
                break;
            }
        }
        assertDestructiveOperationAllowed(port, 'deleted');

        // Stop container if running and wait until fully stopped
        if (info.State.Running) {
            await container.stop();
            try { await container.wait(); } catch (waitErr) { /* already stopped or removed */ }
        }

        // Remove container
        await container.remove();

        // Remove Docker named volume (with retries to handle locks)
        if (port) {
            const volumeName = `cs16-server-${port}-cstrike`;
            const volume = req.docker.getVolume(volumeName);
            // Async background removal with retries
            (async () => {
                for (let i = 0; i < 6; i++) {
                    try {
                        await volume.remove();
                        break;
                    } catch (err) {
                        if (i === 5) {
                            console.log(`Failed to remove volume ${volumeName}:`, err.message);
                        } else {
                            await new Promise(r => setTimeout(r, 500));
                        }
                    }
                }
            })().catch(e => console.log('Volume deletion error:', e.message));
        }

        const cleanupErrors = [];
        try { if (port) fastdl.removeFastdlTree(port); } catch (err) { cleanupErrors.push(`FastDL: ${err.message}`); }
        try { await req.panelDb.dropSqlAccount(serverRecord.db_name, serverRecord.db_username); } catch (err) { cleanupErrors.push(`MySQL: ${err.message}`); }
        try { removePhpArea(serverRecord); } catch (err) { cleanupErrors.push(`PHP: ${err.message}`); }
        try { await req.panelDb.deleteServerRecord(req.params.id); } catch (err) { cleanupErrors.push(`Metadata: ${err.message}`); }

        res.json({
            success: true,
            message: cleanupErrors.length ? 'Server deleted, but some cleanup steps failed.' : 'Server deleted successfully',
            cleanupErrors
        });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/servers/:id/reset - Wipe cstrike volume and reinstall from clean image
router.post('/:id/reset', async (req, res) => {
    try {
        const originalRecord = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);
        const info = await container.inspect();

        // Get port binding so we can find the volume name
        let port = null;
        const portBindings = info.HostConfig.PortBindings;
        for (const key in portBindings) {
            if (key.endsWith('/udp')) {
                port = portBindings[key][0].HostPort;
                break;
            }
        }

        if (!port) {
            return res.status(400).json({ error: 'Could not determine server port from container bindings.' });
        }
        assertDestructiveOperationAllowed(port, 'reset');

        const volumeName = `cs16-server-${port}-cstrike`;

        // 1. Stop container if running and wait until fully stopped
        if (info.State.Running) {
            await container.stop({ t: 10 });
            try { await container.wait(); } catch (waitErr) { /* already stopped or removed */ }
        }

        // 2. Remove the container and its cstrike volume so we get a clean start
        try {
            await container.remove({ v: true });
        } catch (removeErr) {
            console.log('Container remove warning:', removeErr.message);
        }
        try {
            const volume = req.docker.getVolume(volumeName);
            await volume.remove();
        } catch (volErr) {
            console.log('Volume remove warning:', volErr.message);
        }

        // 3. Recreate container with the same configuration and dynamic CPU core affinity
        const cpuset = (originalRecord.port % 2 === 1) ? '0' : '1';
        const createOpts = {
            Image: info.Config.Image,
            name: info.Name.replace(/^\//, ''),
            Env: info.Config.Env,
            ExposedPorts: info.Config.ExposedPorts || {},
            HostConfig: {
                PortBindings: info.HostConfig.PortBindings || {},
                Binds: info.HostConfig.Binds || [`${volumeName}:/hlds/cstrike`],
                RestartPolicy: info.HostConfig.RestartPolicy || { Name: 'always' },
                CapAdd: info.HostConfig.CapAdd || ['SYS_NICE'],
                CpusetCpus: cpuset,
                Ulimits: [
                    { Name: 'rtprio', Soft: 99, Hard: 99 }
                ]
            }
        };
        const newContainer = await req.docker.createContainer(createOpts);
        await newContainer.start();

        // Connect new CS container to cs-network so it can reach mysql/fastdl
        try {
            const network = req.docker.getNetwork('cs-network');
            await network.connect({ Container: newContainer.id });
        } catch (netErr) {
            console.log('cs-network connect skipped:', netErr.message);
        }

        // Update the panel record to point to the new container
        await req.panelDb.updateServerContainer(req.params.id, { container_id: newContainer.id });

        // Ensure PHP area exists for the reset server
        const newServerRecord = await req.panelDb.getServerByContainerId(newContainer.id);
        ensurePhpArea(newServerRecord);

        // 4. Ensure sv_downloadurl and sync FastDL
        let fastdlSync = null;
        const ready = await waitForContainerReady(newContainer);
        if (ready) {
            await ensureSvDownloadUrl(newContainer, port);
            await ensureSqlCfg(newContainer, newServerRecord);
            try {
                fastdl.ensureCleanFastdlTree(port);
                fastdlSync = await syncFastdlWithRetry(newContainer, port);
            } catch (syncErr) {
                console.log('FastDL reset sync warning:', syncErr.message);
            }
        } else {
            console.log('FastDL reset sync skipped: container did not become ready in time');
        }

        res.json({
            success: true,
            message: `Server on port ${port} has been reset. A clean installation is now starting.`,
            containerId: newContainer.id,
            fastdl: fastdlSync ? {
                copied: fastdlSync.totalCopied,
                errors: fastdlSync.totalErrors
            } : null
        });
    } catch (e) {
        routeError(res, e);
    }
});

// Helper function to extract config values from server.cfg content
function extractCfgValue(content, key, defaultValue = '') {
    const regex = new RegExp(`^[ \\t]*${key}[ \\t]+"?([^"\\r\\n]*)"?`, 'm');
    const match = content.match(regex);
    return match ? match[1].trim() : defaultValue;
}

// Helper function to update or append values to server.cfg
function updateOrAppendCfg(content, key, value) {
    const regex = new RegExp(`^[ \\t]*${key}[ \\t]+.*`, 'm');
    const valueText = String(value);
    if (/[\r\n;]/.test(valueText)) {
        const error = new Error(`Invalid value for ${key}`);
        error.statusCode = 400;
        throw error;
    }
    const quotedValue = (typeof value === 'string' && isNaN(value))
        ? `"${valueText.replace(/["\\]/g, '')}"`
        : value;
    const newLine = `${key} ${quotedValue}`;
    if (regex.test(content)) {
        return content.replace(regex, newLine);
    } else {
        return content.trim() + `\n${newLine}\n`;
    }
}

// GET /api/servers/:id/settings - Read and parse server.cfg
router.get('/:id/settings', async (req, res) => {
    try {
        await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);
        
        const content = await containerFs.readFile(container, 'server.cfg');

        let startupMap = 'de_dust2';
        try {
            if (await containerFs.fileExists(container, 'startup_map.txt')) {
                const mapFileContent = await containerFs.readFile(container, 'startup_map.txt');
                if (mapFileContent && mapFileContent.trim()) {
                    startupMap = mapFileContent.trim();
                }
            } else {
                const inspect = await container.inspect();
                const env = inspect.Config.Env;
                const mapEnv = env.find(e => e.startsWith('START_MAP='));
                if (mapEnv) startupMap = mapEnv.split('=')[1];
            }
        } catch (e) {
            console.log('Error reading startupMap:', e.message);
        }

        const settings = {
            name: extractCfgValue(content, 'hostname', 'CS 1.6 Server'),
            rconPassword: extractCfgValue(content, 'rcon_password', ''),
            fpsLimit: extractCfgValue(content, 'sys_ticrate', '1000'),
            sv_password: extractCfgValue(content, 'sv_password', ''),
            mp_timelimit: extractCfgValue(content, 'mp_timelimit', '20'),
            mp_roundtime: extractCfgValue(content, 'mp_roundtime', '2.5'),
            mp_freezetime: extractCfgValue(content, 'mp_freezetime', '1'),
            mp_friendlyfire: extractCfgValue(content, 'mp_friendlyfire', '0'),
            mp_c4timer: extractCfgValue(content, 'mp_c4timer', '35'),
            sv_maxspeed: extractCfgValue(content, 'sv_maxspeed', '320'),
            sv_gravity: extractCfgValue(content, 'sv_gravity', '800'),
            pausable: extractCfgValue(content, 'pausable', '0'),
            sv_cheats: extractCfgValue(content, 'sv_cheats', '0'),
            mp_autoteambalance: extractCfgValue(content, 'mp_autoteambalance', '1'),
            mp_limitteams: extractCfgValue(content, 'mp_limitteams', '2'),
            mp_startmoney: extractCfgValue(content, 'mp_startmoney', '800'),
            mp_buytime: extractCfgValue(content, 'mp_buytime', '1.5'),
            mp_forcechasecam: extractCfgValue(content, 'mp_forcechasecam', '0'),
            mp_footsteps: extractCfgValue(content, 'mp_footsteps', '1'),
            mp_flashlight: extractCfgValue(content, 'mp_flashlight', '0'),
            decalfrequency: extractCfgValue(content, 'decalfrequency', '60'),
            sv_voiceenable: extractCfgValue(content, 'sv_voiceenable', '1'),
            sv_alltalk: extractCfgValue(content, 'sv_alltalk', '0'),
            startupMap: startupMap
        };

        res.json({ success: true, settings });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/servers/:id/settings - Save server settings
router.post('/:id/settings', async (req, res) => {
    try {
        await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);
        const info = await container.inspect();
        if (req.body.map && !/^[A-Za-z0-9_-]+$/.test(req.body.map)) {
            return res.status(400).json({ error: 'Invalid map name' });
        }
        if (req.body.startupMap && !/^[A-Za-z0-9_-]+$/.test(req.body.startupMap)) {
            return res.status(400).json({ error: 'Invalid startup map name' });
        }
        
        let port = null;
        const portBindings = info.HostConfig.PortBindings;
        for (const key in portBindings) {
            if (key.endsWith('/udp')) {
                port = portBindings[key][0].HostPort;
                break;
            }
        }

        if (!port) {
            return res.status(400).json({ error: 'Port mapping not found' });
        }

        const oldRcon = serverRecord.rcon_password || 'rcon123';

        const ip = queryHelper.getServerIp(info);

        let content = await containerFs.readFile(container, 'server.cfg');

        {
            // Update settings list
            const configUpdates = {
                'hostname': req.body.name,
                'rcon_password': req.body.rconPassword,
                'sys_ticrate': req.body.fpsLimit,
                'fps_max': req.body.fpsLimit,
                'sv_password': req.body.sv_password,
                'mp_timelimit': req.body.mp_timelimit,
                'mp_roundtime': req.body.mp_roundtime,
                'mp_freezetime': req.body.mp_freezetime,
                'mp_friendlyfire': req.body.mp_friendlyfire,
                'mp_c4timer': req.body.mp_c4timer,
                'sv_maxspeed': req.body.sv_maxspeed,
                'sv_gravity': req.body.sv_gravity,
                'pausable': req.body.pausable,
                'sv_cheats': req.body.sv_cheats,
                'mp_autoteambalance': req.body.mp_autoteambalance,
                'mp_limitteams': req.body.mp_limitteams,
                'mp_startmoney': req.body.mp_startmoney,
                'mp_buytime': req.body.mp_buytime,
                'mp_forcechasecam': req.body.mp_forcechasecam,
                'mp_footsteps': req.body.mp_footsteps,
                'mp_flashlight': req.body.mp_flashlight,
                'decalfrequency': req.body.decalfrequency,
                'sv_voiceenable': req.body.sv_voiceenable,
                'sv_alltalk': req.body.sv_alltalk
            };

            for (const [key, value] of Object.entries(configUpdates)) {
                if (value !== undefined) {
                    content = updateOrAppendCfg(content, key, value);
                    if (info.State.Running) {
                        try {
                            const rconValue = (typeof value === 'string' && isNaN(value)) ? `"${value}"` : value;
                            await queryHelper.sendRconCommand(ip, port, oldRcon, `${key} ${rconValue}`);
                        } catch (rconErr) {
                            console.log(`Failed to apply RCON change for ${key}:`, rconErr.message);
                        }
                    }
                }
            }

            await containerFs.writeFile(container, 'server.cfg', content);
        }

        if (req.body.map && info.State.Running) {
            await queryHelper.sendRconCommand(ip, port, req.body.rconPassword || oldRcon, `changelevel ${req.body.map}`);
        }

        if (req.body.name) {
            await req.panelDb.updateServerContainer(req.params.id, { name: req.body.name });
        }

        if (req.body.rconPassword) {
            await req.panelDb.updateServerContainer(req.params.id, { rcon_password: req.body.rconPassword });
        }

        if (req.body.startupMap) {
            await containerFs.writeFile(container, 'startup_map.txt', req.body.startupMap.trim());
        }

        res.json({ success: true, message: 'Settings saved and applied where possible' });
    } catch (e) {
        routeError(res, e);
    }
});

// GET /api/servers/:id/configs - Get config, ini, and txt files list recursively (max depth 4)
router.get('/:id/configs', async (req, res) => {
    try {
        await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);

        const pythonScript = `
import os, json
root = '/hlds/cstrike'
items = []
allowed_exts = ('.cfg', '.ini', '.txt')
priorities = [
    'server.cfg',
    'addons/amxmodx/configs/amxx.cfg',
    'addons/amxmodx/configs/plugins.ini',
    'addons/amxmodx/configs/users.ini',
    'mapcycle.txt',
    'motd.txt'
]

if os.path.exists(root):
    for current, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('logs', 'models', 'sprites', 'sound', 'gfx')]
        rel_dir = os.path.relpath(current, root)
        if rel_dir != '.' and len(rel_dir.split(os.sep)) > 4:
            dirs[:] = []
            continue
        for name in files:
            if name.lower().endswith(allowed_exts):
                full = os.path.join(current, name)
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                items.append(rel)

# Priority sorting helper
def get_sort_key(path):
    try:
        idx = priorities.index(path)
        return (0, idx, path)
    except ValueError:
        return (1, 0, path)

items.sort(key=get_sort_key)
print(json.dumps(items))
`;

        const result = await containerFs.runExec(container, { Cmd: ['python3', '-c', pythonScript] });
        const configs = JSON.parse(result.output.trim() || '[]');
        res.json({ success: true, configs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

function parseDockerLogs(buffer) {
    let result = '';
    let offset = 0;
    while (offset < buffer.length) {
        if (offset + 8 > buffer.length) break;
        const type = buffer.readUInt8(offset);
        const size = buffer.readUInt32BE(offset + 4);
        offset += 8;
        if (offset + size > buffer.length) {
            result += buffer.toString('utf8', offset);
            break;
        }
        result += buffer.toString('utf8', offset, offset + size);
        offset += size;
    }
    return result;
}

// GET /api/servers/:id/logs - Get console and crash logs (stdout/stderr)
router.get('/:id/logs', async (req, res) => {
    try {
        await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);

        const logsBuffer = await container.logs({
            stdout: true,
            stderr: true,
            tail: 500,
            follow: false
        });

        const logs = parseDockerLogs(logsBuffer);
        res.json({ success: true, logs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Helper to read absolute files from game container using docker exec
async function readContainerFileAbsolute(container, absolutePath) {
    try {
        const exec = await container.exec({
            Cmd: ['sh', '-c', `if [ -f "${absolutePath}" ]; then cat "${absolutePath}"; fi`],
            AttachStdout: true,
            AttachStderr: true
        });
        const stream = await exec.start({});
        
        return new Promise((resolve) => {
            const chunks = [];
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => {
                const buffer = Buffer.concat(chunks);
                resolve(parseDockerLogs(buffer));
            });
            stream.on('error', () => {
                resolve('');
            });
        });
    } catch (err) {
        return '';
    }
}

// GET /api/servers/:id/crash-logs - Get contents of sys_error.log, debug.log, and AMXX error logs
router.get('/:id/crash-logs', async (req, res) => {
    try {
        await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);

        const sysErrorPromise = readContainerFileAbsolute(container, '/hlds/cstrike/sys_error.log');
        const debugLogPromise = readContainerFileAbsolute(container, '/hlds/debug.log');

        // Fetch latest AMXX error log file path and read it
        let amxxErrorsPromise = Promise.resolve('');
        try {
            const listExec = await container.exec({
                Cmd: ['sh', '-c', 'ls -1 /hlds/cstrike/addons/amxmodx/logs/error_* 2>/dev/null | sort | tail -n 1'],
                AttachStdout: true,
                AttachStderr: true
            });
            const listStream = await listExec.start({});
            const latestFile = await new Promise((resolve) => {
                const chunks = [];
                listStream.on('data', chunk => chunks.push(chunk));
                listStream.on('end', () => {
                    const filePath = parseDockerLogs(Buffer.concat(chunks)).trim();
                    resolve(filePath);
                });
                listStream.on('error', () => resolve(''));
            });

            if (latestFile) {
                amxxErrorsPromise = readContainerFileAbsolute(container, latestFile);
            }
        } catch (err) {
            console.log('Failed to fetch AMXX logs list:', err.message);
        }

        const [sys_error, debug_log, amxx_errors] = await Promise.all([
            sysErrorPromise,
            debugLogPromise,
            amxxErrorsPromise
        ]);

        res.json({
            success: true,
            sys_error: sys_error.trim(),
            debug_log: debug_log.trim(),
            amxx_errors: amxx_errors.trim()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;

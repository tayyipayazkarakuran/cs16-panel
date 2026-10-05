const express = require('express');
const cors = require('cors');
const compression = require('compression');
const http = require('http');
const ws = require('ws');
const path = require('path');
const fs = require('fs');
const Docker = require('dockerode');
const cfg = require('./config');
const panelDb = require('./panelDb');
const security = require('./security');
const queryHelper = require('./queryHelper');

const app = express();
const server = http.createServer(app);
const wss = new ws.Server({ server, maxPayload: 64 * 1024 });
// PANEL_MOCK_DOCKER=1 runs the panel against simulated containers (UI/dev only).
const docker = process.env.PANEL_MOCK_DOCKER === '1'
    ? (() => {
        const mock = require('./tests/support/mockDocker').create();
        ['cs-panel', 'cs-mysql', 'cs-php', 'cs-fastdl'].forEach(name => mock.addService(name));
        return mock;
    })()
    : new Docker();

const PUBLIC_DIR = path.join(__dirname, 'public');
const startedAt = Date.now();

app.disable('x-powered-by');
app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY || '1') ? parseInt(process.env.TRUST_PROXY || '1', 10) : process.env.TRUST_PROXY);

app.use(cors({
    origin: (origin, cb) => {
        // Same-origin requests and server-to-server calls carry no Origin.
        if (!origin || security.ALLOWED_ORIGINS.has(origin)) return cb(null, true);
        if (!cfg.isProduction) return cb(null, true);
        return cb(null, false);
    },
    credentials: true
}));
app.use(compression({ threshold: 1024 }));

app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.path.startsWith('/api/')) {
        res.set('Cache-Control', 'no-store');
    } else {
        res.set('Content-Security-Policy', security.CSP);
    }
    next();
});

// Legacy proxy links redirect to the isolated PHP host (no body parsing needed).
app.use('/api/php/proxy', require('./routes/phpProxy'));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use(express.static(PUBLIC_DIR, {
    index: false,
    etag: true,
    setHeaders: (res, filePath) => {
        if (/\.(?:css|js)$/i.test(filePath)) {
            // Assets are referenced with ?v=<release>; revalidate cheaply via ETag.
            res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
        } else if (/\.(?:webp|png|jpg|svg|ico|woff2?)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
        } else if (/\.html$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));
// Receipts are served only through the authenticated payments route.
app.use('/uploads', (req, res) => res.status(404).send('Not found'));

app.use((req, res, next) => {
    req.docker = docker;
    req.panelDb = panelDb;
    next();
});

// ---------------------------------------------------------------------------
//  Public endpoints
// ---------------------------------------------------------------------------

app.get('/api/health', async (req, res) => {
    let database = false;
    try {
        await panelDb.assertPool().query('SELECT 1');
        database = true;
    } catch (_) { /* reported below */ }
    res.status(database ? 200 : 503).json({ ok: database, database, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
});

app.use('/api', require('./routes/auth'));

// Compact public list for the landing page.
const PUBLIC_SERVER_CACHE_TTL_MS = 10000;
let publicServersCache = { timestamp: 0, servers: [], pending: null };

async function buildPublicServers() {
    const [rows] = await panelDb.assertPool().query(
        'SELECT container_id, port, name FROM panel_servers WHERE is_pool = 0 AND suspended = 0 ORDER BY port'
    );
    const containers = await docker.listContainers({ all: false });
    const running = new Map(containers.map(c => [c.Id, c]));
    return Promise.all(rows.map(async row => {
        const base = { port: row.port, name: row.name || 'CS 1.6 Server', ip: cfg.gameServerHost, map: null, players: null, maxplayers: null, status: 'offline' };
        if (!running.has(row.container_id)) return base;
        try {
            const info = await docker.getContainer(row.container_id).inspect();
            const live = await queryHelper.getServerInfo(queryHelper.getServerIp(info), row.port);
            if (!live.online) return base;
            return { ...base, name: live.name || base.name, map: live.map, players: live.players, maxplayers: live.maxPlayers, status: 'online' };
        } catch (_) {
            return base;
        }
    }));
}

app.get('/api/servers/public', async (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=5, stale-while-revalidate=10');
        if (Date.now() - publicServersCache.timestamp > PUBLIC_SERVER_CACHE_TTL_MS) {
            if (!publicServersCache.pending) {
                publicServersCache.pending = buildPublicServers()
                    .then(servers => { publicServersCache = { timestamp: Date.now(), servers, pending: null }; })
                    .catch(e => { publicServersCache.pending = null; throw e; });
            }
            await publicServersCache.pending;
        }
        res.json({ servers: publicServersCache.servers });
    } catch (e) {
        res.status(500).json({ error: 'Sunucu listesi alınamadı.', servers: [] });
    }
});

// ---------------------------------------------------------------------------
//  Authentication gate for everything else under /api
// ---------------------------------------------------------------------------

let maintenanceCache = { at: 0, value: null };
async function maintenanceMessage() {
    if (Date.now() - maintenanceCache.at < 5000) return maintenanceCache.value;
    const settings = await panelDb.getSettingsMap(['maintenance_mode', 'maintenance_message']);
    maintenanceCache = {
        at: Date.now(),
        value: settings.maintenance_mode === '1' ? (settings.maintenance_message || 'Bakım çalışması yapılıyor.') : null
    };
    return maintenanceCache.value;
}

/** Resolve and validate the session of a request; returns the user or null. */
async function authenticateRequest(token) {
    const payload = panelDb.verifyToken(token);
    if (!payload) return null;
    const user = await panelDb.getUserById(payload.sub);
    if (!user) return null;
    // Password changes, suspensions and "log out everywhere" bump token_version.
    if (Number(user.token_version || 0) !== Number(payload.ver || 0)) return null;
    return user;
}

async function requireApiAuth(req, res, next) {
    try {
        const auth = security.getAuthToken(req);
        const user = await authenticateRequest(auth.token);
        if (!user) return res.status(401).json({ error: 'Oturum gerekli.' });
        if (user.suspended) return res.status(403).json({ error: 'Hesabınız askıya alınmış. Lütfen destek ile iletişime geçin.', code: 'ACCOUNT_SUSPENDED' });
        if (auth.source === 'cookie' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !security.requestHasTrustedOrigin(req)) {
            return res.status(403).json({ error: 'Invalid request origin' });
        }
        if (user.role !== 'admin') {
            const maintenance = await maintenanceMessage();
            if (maintenance) return res.status(503).json({ error: maintenance, code: 'MAINTENANCE' });
        }
        req.user = user;
        req.authSource = auth.source;
        next();
    } catch (e) {
        console.error('[Auth gate]', e.message);
        res.status(500).json({ error: 'Oturum doğrulanamadı.' });
    }
}

app.use('/api', requireApiAuth);

app.post('/api/auth/handoff', async (req, res) => {
    try {
        const handoff = await panelDb.createAuthHandoff(req.user.id);
        res.status(201).json({
            success: true,
            code: handoff.code,
            expiresIn: handoff.expiresIn,
            redirectUrl: `${cfg.panelPublicUrl}/auth/callback#code=${encodeURIComponent(handoff.code)}`
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.use('/api/account', require('./routes/account'));
app.use('/api/servers', require('./routes/servers'));
app.use('/api/files', require('./routes/files'));
app.use('/api/plugins', require('./routes/plugins'));
app.use('/api/maps', require('./routes/maps'));
app.use('/api/admins', require('./routes/admins'));
app.use('/api/players', require('./routes/players'));
app.use('/api/fastdl', require('./routes/fastdl'));
app.use('/api/mysql', require('./routes/mysql'));
app.use('/api/php', require('./routes/php'));
app.use('/api/sites', require('./routes/sites'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/admin', require('./routes/admin'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Keep upload/validation failures machine-readable instead of Express HTML.
app.use('/api', (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const uploadLimitError = error && (error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_FILE_COUNT');
    const status = error.statusCode || error.status || (uploadLimitError ? 413 : 500);
    const message = uploadLimitError ? 'Yükleme boyut veya dosya sayısı sınırını aşıyor.' : (error.type === 'entity.too.large' ? 'İstek gövdesi çok büyük.' : error.message);
    if (status >= 500) console.error('[API]', error);
    res.status(status).json({ error: status >= 500 ? 'Beklenmeyen bir sunucu hatası oluştu.' : (message || 'Hatalı istek') });
});

// ---------------------------------------------------------------------------
//  Frontend
// ---------------------------------------------------------------------------

const indexHtml = path.join(PUBLIC_DIR, 'index.html');
app.get('/landing', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'landing.html')));
app.get(/^\/(?!api\/).*/, (req, res) => {
    if (/\.[a-z0-9]{2,5}$/i.test(req.path)) return res.status(404).send('Not found');
    res.sendFile(indexHtml);
});

// ---------------------------------------------------------------------------
//  WebSocket: live console stream + RCON
// ---------------------------------------------------------------------------

function filterStatsLogs(text) {
    if (!text) return '';
    return text.split(/\r?\n/).filter(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('Rcon from ')) return false;
        if (trimmed.startsWith('rcon ') && trimmed.includes('stats')) return false;
        if (trimmed.includes('CPU   In    Out   Uptime  Users   FPS    Players')) return false;
        if (/^\s*\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+\s+\d+\s+\d+(\.\d+)?\s+\d+\s*$/.test(trimmed)) return false;
        return true;
    }).join('\n');
}

function wsSend(socket, payload) {
    if (socket.readyState === ws.OPEN) socket.send(JSON.stringify(payload));
}

wss.on('connection', async (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const containerId = url.searchParams.get('containerId');
    const cookieToken = security.parseCookies(req.headers.cookie || '')[security.COOKIE_NAME];
    // Browsers attach cookies to cross-site WebSocket handshakes, so the
    // Origin must be the panel itself (exact match, not "any subdomain").
    if (!security.isTrustedOrigin(req.headers.origin, req.headers.host)) {
        wsSend(socket, { type: 'error', data: 'Invalid origin' });
        return socket.close(1008);
    }
    let record;
    try {
        const user = await authenticateRequest(cookieToken);
        if (!user || user.suspended) {
            wsSend(socket, { type: 'error', data: 'Authentication required' });
            return socket.close(1008);
        }
        record = await panelDb.requireServerAccess(user, docker, containerId);
    } catch (e) {
        wsSend(socket, { type: 'error', data: e.message || 'Access denied' });
        return socket.close(1008);
    }

    const container = docker.getContainer(record.container_id);
    let logStream = null;
    let lastCommandAt = 0;

    container.logs({ follow: true, stdout: true, stderr: true, tail: 200, timestamps: false }, (err, stream) => {
        if (err) {
            wsSend(socket, { type: 'error', data: err.message });
            return socket.close();
        }
        logStream = stream;
        stream.on('data', chunk => {
            let text = '';
            if (chunk.length >= 8 && (chunk[0] === 1 || chunk[0] === 2)) {
                let offset = 0;
                while (offset + 8 <= chunk.length) {
                    const size = chunk.readUInt32BE(offset + 4);
                    text += chunk.toString('utf8', offset + 8, Math.min(chunk.length, offset + 8 + size));
                    offset += 8 + size;
                }
            } else {
                text = chunk.toString('utf8');
            }
            const filtered = filterStatsLogs(text);
            if (filtered.trim()) wsSend(socket, { type: 'log', data: filtered });
        });
        stream.on('end', () => { wsSend(socket, { type: 'status', data: 'Stream ended' }); socket.close(); });
        stream.on('error', e => { wsSend(socket, { type: 'error', data: e.message }); socket.close(); });
    });

    socket.on('message', async message => {
        try {
            const parsed = JSON.parse(message);
            if (parsed.type !== 'command') return;
            const command = String(parsed.data || '').replace(/[\r\n]/g, ' ').trim().slice(0, 500);
            if (!command) return;
            if (Date.now() - lastCommandAt < 250) return wsSend(socket, { type: 'error', data: 'Çok hızlı komut gönderiyorsunuz.' });
            lastCommandAt = Date.now();
            const fresh = await panelDb.getServerByContainerId(record.container_id);
            const info = await container.inspect();
            const response = await queryHelper.sendRconCommand(queryHelper.getServerIp(info), fresh.port, fresh.rcon_password || '', command);
            wsSend(socket, { type: 'rcon_response', data: response });
        } catch (e) {
            wsSend(socket, { type: 'error', data: `Error: ${e.message}` });
        }
    });

    socket.on('close', () => {
        if (logStream && logStream.destroy) logStream.destroy();
    });
});

// ---------------------------------------------------------------------------
//  Start / stop
// ---------------------------------------------------------------------------

const timers = [];

async function start() {
    await panelDb.init(docker);
    try { require('./phpSiteService').ensureRoots(); } catch (e) { console.log('[PHP] root setup skipped:', e.message); }

    const lifecycle = require('./lifecycleService');
    const runLifecycle = () => lifecycle.runLifecycle(docker).catch(e => console.error('[Lifecycle]', e.message));
    timers.push(setInterval(runLifecycle, parseInt(process.env.LIFECYCLE_INTERVAL_MS || String(10 * 60 * 1000), 10)));
    setTimeout(runLifecycle, 15000);
    timers.push(setInterval(() => panelDb.cleanupAuthHandoffs().catch(e => console.error('[Auth cleanup]', e.message)), 300000));

    server.listen(cfg.port, '0.0.0.0', () => {
        console.log(`CS 1.6 Server Panel running on http://localhost:${cfg.port}`);
        console.log(`FastDL      : ${cfg.fastdlBaseUrl()}/<port>/`);
        console.log(`PHP sites   : ${cfg.phpSiteUrl(27015).replace('27015', '<port>')}`);
        console.log(`MySQL       : ${cfg.mysql.host}:${cfg.mysql.port} (servers use ${cfg.mysql.internalHost}:${cfg.mysql.internalPort})`);
    });
}

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down...`);
    timers.forEach(clearInterval);
    wss.clients.forEach(client => client.close(1001));
    server.close(async () => {
        await panelDb.close();
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
    start().catch(e => {
        console.error('Failed to start CS panel:', e);
        process.exit(1);
    });
}

module.exports = { app, server, start };

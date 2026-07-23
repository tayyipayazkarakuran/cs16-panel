const express = require('express');
const cors    = require('cors');
const compression = require('compression');
const http    = require('http');
const ws      = require('ws');
const path    = require('path');
const fs      = require('fs');
const Docker  = require('dockerode');
const panelDb = require('./panelDb');
const { isProtectedPort } = require('./serverProtection');

const app    = express();
const server = http.createServer(app);
const wss    = new ws.Server({ server });
const docker = new Docker();

const PORT        = process.env.PORT       || 3000;
const SERVERS_DIR = path.join(__dirname, 'servers');
const PANEL_PUBLIC_URL = (process.env.PANEL_PUBLIC_URL || 'https://panel.example.com').replace(/\/$/, '');
const PANEL_URL = new URL(PANEL_PUBLIC_URL);
const PANEL_ORIGIN = PANEL_URL.origin;
const PANEL_HOSTNAME = PANEL_URL.hostname.toLowerCase();
const PANEL_COOKIE_NAME = 'cs_panel_session';
const PANEL_SESSION_MAX_AGE_MS = parseInt(process.env.PANEL_TOKEN_TTL_SECONDS || '86400', 10) * 1000;
const PANEL_COOKIE_SECURE = process.env.PANEL_COOKIE_SECURE
    ? process.env.PANEL_COOKIE_SECURE === 'true'
    : PANEL_URL.protocol === 'https:';

// Ensure servers directory exists (legacy compat)
if (!fs.existsSync(SERVERS_DIR)) {
    fs.mkdirSync(SERVERS_DIR, { recursive: true });
}

// Middleware
app.set('trust proxy', 1);

// CORS: only allow requests from the panel origin and the landing origin
const ALLOWED_ORIGINS = [
    PANEL_ORIGIN,
    // Also allow the root domain (landing page origin) if different from panel
    (() => { try { const u = new URL(PANEL_PUBLIC_URL.replace(/^https?:\/\/panel\./, (m) => m.replace('panel.', ''))); return u.origin; } catch (_) { return null; } })(),
    ...String(process.env.PANEL_ADDITIONAL_ORIGINS || '').split(',').map(value => {
        try { return new URL(value.trim()).origin; } catch (_) { return null; }
    })
].filter(Boolean);

app.use(cors({
    origin: (origin, cb) => {
        // Allow requests with no origin (server-to-server, curl, mobile apps)
        if (!origin) return cb(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        // In development mode be permissive
        if (process.env.NODE_ENV !== 'production') return cb(null, true);
        return cb(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true
}));
app.use(compression({ threshold: 1024 }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    const isHtmlNavigation = req.path === '/' || req.path === '/panel' || req.path.endsWith('.html');
    if (req.path.startsWith('/api/')) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    } else if (isHtmlNavigation) {
        res.set('Cache-Control', 'no-cache, must-revalidate');
    }
    next();
});
// index:false prevents express.static from auto-serving public/index.html for GET /.
// The explicit route below keeps the login screen as the single entry point.
app.use(express.static(path.join(__dirname, 'public'), {
    index: false,
    etag: true,
    maxAge: '7d',
    setHeaders: (res, filePath) => {
        if (/\.(?:css|js)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
        }
    }
}));
// Receipts are served only through the authenticated payments route.
app.use('/uploads', (req, res) => res.status(404).send('Not found'));
// Attach Docker instance and config to every request
app.use((req, res, next) => {
    req.docker     = docker;
    req.serversDir = SERVERS_DIR;
    req.panelDb    = panelDb;
    next();
});

function parseCookies(header = '') {
    return header.split(';').reduce((cookies, part) => {
        const separator = part.indexOf('=');
        if (separator < 0) return cookies;
        const key = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        if (!key) return cookies;
        try {
            cookies[key] = decodeURIComponent(value);
        } catch (_) {
            cookies[key] = value;
        }
        return cookies;
    }, {});
}

function getAuthToken(req) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
        return { token: header.slice(7).trim(), source: 'bearer' };
    }
    const cookieToken = parseCookies(req.headers.cookie || '')[PANEL_COOKIE_NAME];
    if (cookieToken) return { token: cookieToken, source: 'cookie' };
    // Legacy query token support is retained for existing API clients.
    if (req.query && req.query.token) {
        return { token: String(req.query.token), source: 'query' };
    }
    return { token: null, source: null };
}

function isPanelRequest(req) {
    const hostname = (req.hostname || '').toLowerCase();
    const domainParts = PANEL_HOSTNAME.split('.');
    const baseDomain = domainParts.length >= 2 ? domainParts.slice(-2).join('.') : '';
    return hostname === PANEL_HOSTNAME || hostname === baseDomain;
}

function hasPanelOrigin(req) {
    const origin = req.get('origin') || '';
    if (!origin) return false;
    try {
        return ALLOWED_ORIGINS.includes(new URL(origin).origin);
    } catch (_) {
        return false;
    }
}

function baseDomainName() {
    const domainParts = PANEL_HOSTNAME.split('.');
    const isIp = domainParts.every(part => /^\d+$/.test(part)) && domainParts.length === 4;
    if (isIp) return '';
    return domainParts.length >= 2 ? domainParts.slice(-2).join('.') : '';
}

function panelCookieOptions() {
    const domain = baseDomainName() ? '.' + baseDomainName() : undefined;
    return {
        httpOnly: true,
        secure: PANEL_COOKIE_SECURE,
        sameSite: 'lax',
        path: '/',
        maxAge: PANEL_SESSION_MAX_AGE_MS,
        domain: domain
    };
}

function setPanelSessionCookie(req, res, user) {
    if (!isPanelRequest(req)) return;
    res.cookie(PANEL_COOKIE_NAME, panelDb.makeToken(user), panelCookieOptions());
}

function clearPanelSessionCookie(res) {
    const options = panelCookieOptions();
    delete options.maxAge;
    res.clearCookie(PANEL_COOKIE_NAME, options);
}

async function requireApiAuth(req, res, next) {
    try {
        const auth = getAuthToken(req);
        const token = auth.token;
        const payload = panelDb.verifyToken(token);
        if (!payload) return res.status(401).json({ error: 'Authentication required' });

        const user = await panelDb.getUserById(payload.sub);
        if (!user) return res.status(401).json({ error: 'Authentication required' });

        req.user = user;
        req.authSource = auth.source;
        if (auth.source === 'cookie' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !hasPanelOrigin(req)) {
            return res.status(403).json({ error: 'Invalid request origin' });
        }
        next();
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        const user = await panelDb.authenticate(username, password);
        if (!user) return res.status(401).json({ error: 'Invalid username or password' });
        setPanelSessionCookie(req, res, user);
        res.json({ success: true, token: panelDb.makeToken(user), user });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        const user = await panelDb.createUser(username, password);
        setPanelSessionCookie(req, res, user);
        res.status(201).json({ success: true, token: panelDb.makeToken(user), user });
    } catch (e) {
        const status = e.statusCode || 500;
        res.status(status).json({ error: e.message });
    }
});

app.post('/api/auth/exchange', async (req, res) => {
    try {
        if (!isPanelRequest(req) || !hasPanelOrigin(req)) {
            return res.status(403).json({ error: 'Invalid panel origin' });
        }
        const user = await panelDb.consumeAuthHandoff(req.body && req.body.code);
        if (!user) return res.status(401).json({ error: 'Login code is invalid, expired, or already used' });
        setPanelSessionCookie(req, res, user);
        res.json({ success: true, user });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/auth/logout', (req, res) => {
    if (!isPanelRequest(req) || !hasPanelOrigin(req)) {
        return res.status(403).json({ error: 'Invalid panel origin' });
    }
    clearPanelSessionCookie(res);
    res.json({ success: true });
});

// Public server list — intentionally compact because the landing page only
// needs summary data. Detailed player/config data remains behind authenticated APIs.
const PUBLIC_SERVER_CACHE_TTL_MS = 10000;
let publicServersCache = { timestamp: 0, servers: [] };

app.get('/api/servers/public', async (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=5, stale-while-revalidate=10');
        if (Date.now() - publicServersCache.timestamp < PUBLIC_SERVER_CACHE_TTL_MS) {
            return res.json({ servers: publicServersCache.servers });
        }

        const containers = await docker.listContainers({ all: true });
        const csContainers = containers.filter(c => c.Names.some(n => n.includes('cs16-server-')));
        const qh = require('./queryHelper');
        const hostIp = process.env.HOST_IP || process.env.FASTDL_HOST || '127.0.0.1';

        const servers = await Promise.all(csContainers.map(async (c) => {
            const portBinding = (c.Ports || []).find(p => p.Type === 'udp');
            const port = portBinding ? portBinding.PublicPort : null;
            const running = c.State === 'running';
            let players = null, map = null, name = null, maxplayers = 32;

            if (running && port) {
                try {
                    const container = docker.getContainer(c.Id);
                    const info = await container.inspect();
                    const serverIp = qh.getServerIp(info);
                    const envName = (info.Config.Env || []).find(e => e.startsWith('SERVER_NAME='));
                    const envMax = (info.Config.Env || []).find(e => e.startsWith('MAXPLAYERS='));
                    if (envName) name = envName.split('=').slice(1).join('=');
                    if (envMax) maxplayers = parseInt(envMax.split('=')[1], 10) || 32;

                    const liveInfo = await qh.getServerInfo(serverIp, port);
                    if (liveInfo) {
                        players = liveInfo.players !== undefined ? liveInfo.players : null;
                        map = liveInfo.map || null;
                        if (!name && liveInfo.name) name = liveInfo.name;
                        if (liveInfo.maxPlayers) maxplayers = liveInfo.maxPlayers;
                    }
                } catch (_) { /* server offline or unreachable */ }
            }

            return {
                port,
                name: name || 'CS 1.6 Server',
                ip: hostIp,
                map,
                players,
                maxplayers,
                status: running ? 'online' : 'offline'
            };
        }));

        servers.sort((a, b) => (a.port || 0) - (b.port || 0));
        publicServersCache = { timestamp: Date.now(), servers };
        res.json({ servers });
    } catch (e) {
        res.status(500).json({ error: e.message, servers: [] });
    }
});

// ---- Routes ----
const serversRouter = require('./routes/servers');
const filesRouter   = require('./routes/files');
const pluginsRouter = require('./routes/plugins');
const mapsRouter    = require('./routes/maps');
const adminsRouter  = require('./routes/admins');
const playersRouter = require('./routes/players');
const fastdlRouter  = require('./routes/fastdl');
const mysqlRouter   = require('./routes/mysql');
const phpRouter     = require('./routes/php');
const phpProxyRouter = require('./routes/phpProxy');
const paymentsRouter = require('./routes/payments');
const adminRouter   = require('./routes/admin');

// Public PHP proxy (no auth) – mounted before the global /api auth middleware
app.use('/api/php/proxy', phpProxyRouter);

// Apply auth middleware only to protected routes (excludes /api/auth/* and /api/servers/public)
app.use('/api', (req, res, next) => {
    const pub = [
        { method: 'POST', path: '/auth/login' },
        { method: 'POST', path: '/auth/register' },
        { method: 'POST', path: '/auth/exchange' },
        { method: 'POST', path: '/auth/logout' },
        { method: 'GET',  path: '/auth/me' },
        { method: 'GET',  path: '/servers/public' },
    ];
    const reqPath = req.path; // already stripped of /api prefix by express
    const isPub = pub.some(r => r.method === req.method && reqPath === r.path);
    if (isPub) return next();
    return requireApiAuth(req, res, next);
});

app.get('/api/auth/me', async (req, res) => {
    const auth = getAuthToken(req);
    let user = null;
    if (auth.token) {
        try {
            const payload = panelDb.verifyToken(auth.token);
            if (payload) {
                user = await panelDb.getUserById(payload.sub);
            }
        } catch (_) {}
    }
    res.json({ user });
});

app.post('/api/auth/handoff', async (req, res) => {
    try {
        const handoff = await panelDb.createAuthHandoff(req.user.id);
        res.status(201).json({
            success: true,
            code: handoff.code,
            expiresIn: handoff.expiresIn,
            redirectUrl: `${PANEL_PUBLIC_URL}/auth/callback#code=${encodeURIComponent(handoff.code)}`
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.use('/api/servers',  serversRouter);
app.use('/api/files',    filesRouter);
app.use('/api/plugins',  pluginsRouter);
app.use('/api/maps',     mapsRouter);
app.use('/api/admins',   adminsRouter);
app.use('/api/players',  playersRouter);
app.use('/api/fastdl',   fastdlRouter);
app.use('/api/mysql',    mysqlRouter);
app.use('/api/php',      phpRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/admin',    adminRouter);

// Keep upload/validation failures machine-readable. Without this handler,
// Multer sends Express's HTML error page and the browser appears to hang while
// trying to parse it as JSON.
app.use('/api', (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const uploadLimitError = error && (error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_FILE_COUNT');
    const status = error.statusCode || (uploadLimitError ? 413 : 500);
    const message = uploadLimitError ? 'Upload exceeds the configured size or file-count limit' : error.message;
    res.status(status).json({ error: message || 'Unexpected server error' });
});

// =====================================================================
//  Frontend routing
// ---------------------------------------------------------------------
//  Legacy vanilla SPA (login + single-screen panel) is served from
//  public/ and reachable at / and /panel (vanilla).
//
//  New Next.js static export (CS 1.6 themed UI) is dropped at
//  public/panel/ by panel.Dockerfile's frontend-builder stage and is
//  served under /panel-next/* (mounted with basePath='/panel' in
//  next.config.ts). We expose two opt-in URLs so the user can A/B them:
//      /                -> legacy login (unchanged)
//      /panel           -> legacy panel SPA (unchanged)
//      /panel-next      -> new Next.js landing/login screen
//      /panel-next/...  -> new Next.js panel + sub-routes
//  Once the new UI is validated the legacy routes can be retired.
// =====================================================================

// New Next.js UI (static export from frontend/)
const NEXT_DIST = path.join(__dirname, 'public', 'panel');

function serveNextHtml(relPath, fallbackToIndex = true) {
    return (req, res) => {
        // Sanitize: only allow simple relative paths
        const safe = String(relPath || '')
            .replace(/^\/+/, '')
            .replace(/\.\.+/g, '');
        let candidate = path.join(NEXT_DIST, safe);
        if (safe === '' || safe.endsWith('/')) {
            candidate = path.join(candidate, 'index.html');
        }
        if (!fs.existsSync(candidate)) {
            if (fallbackToIndex) {
                return res.sendFile(path.join(NEXT_DIST, 'index.html'));
            }
            return res.status(404).send('Not found');
        }
        // If a directory without trailing slash, redirect to trailing-slash form
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            return res.redirect(301, req.originalUrl.replace(/\/?$/, '/'));
        }
        res.sendFile(candidate);
    };
}

// The login screen is the single entry point for every public host.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// New CS 1.6 themed UI (Next.js static export)
app.get('/panel-next', serveNextHtml('index.html'));
app.get('/panel-next/', serveNextHtml('index.html'));
app.get('/panel-next/*', (req, res) => {
    // Strip the /panel-next prefix and serve from public/panel/
    const sub = req.params[0] || '';
    // Direct file request (e.g. /panel-next/_next/static/...js)
    const directPath = path.join(NEXT_DIST, sub);
    if (sub && fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
        return res.sendFile(directPath);
    }
    // Otherwise treat as a route and serve its index.html
    serveNextHtml(sub)(req, res);
});

// SPA fallback: only for non-API routes
app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Helper: strip RCON stats from live console stream ----
function filterStatsLogs(text) {
    if (!text) return '';
    const lines    = text.split(/\r?\n/);
    const filtered = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('Rcon from '))                                         continue;
        if (trimmed.startsWith('rcon ') && trimmed.includes('stats'))                 continue;
        if (trimmed.includes('CPU   In    Out   Uptime  Users   FPS    Players'))      continue;
        if (/^\s*\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+\s+\d+\s+\d+(\.\d+)?\s+\d+\s*$/.test(trimmed)) continue;
        filtered.push(line);
    }
    return filtered.join('\n');
}

// ---- WebSocket: live console stream ----
wss.on('connection', async (socket, req) => {
    const urlParams  = new URLSearchParams(req.url.split('?')[1]);
    const containerId = urlParams.get('containerId');
    const queryToken = urlParams.get('token');
    const cookieToken = parseCookies(req.headers.cookie || '')[PANEL_COOKIE_NAME];
    const token = cookieToken || queryToken;
    const authSource = cookieToken ? 'cookie' : (queryToken ? 'query' : null);

    if (!containerId) {
        socket.send('Error: Missing containerId');
        socket.close();
        return;
    }

    try {
        const origin = req.headers.origin || '';
        const cleanOrigin = origin.replace(/^https?:\/\//, '').split(':')[0].toLowerCase();
        const isAllowed = cleanOrigin === PANEL_HOSTNAME || 
                          cleanOrigin === baseDomainName() || 
                          cleanOrigin.endsWith('.' + baseDomainName()) ||
                          cleanOrigin === 'localhost' ||
                          cleanOrigin === '127.0.0.1';
        if (authSource === 'cookie' && !isAllowed) {
            throw new Error('Invalid request origin');
        }
        const payload = panelDb.verifyToken(token);
        const user = payload ? await panelDb.getUserById(payload.sub) : null;
        if (!user) {
            socket.send(JSON.stringify({ type: 'error', data: 'Authentication required' }));
            socket.close();
            return;
        }
        await panelDb.requireServerAccess(user, docker, containerId);
    } catch (e) {
        socket.send(JSON.stringify({ type: 'error', data: e.message || 'Access denied' }));
        socket.close();
        return;
    }

    console.log(`WS connected: ${containerId.slice(0, 12)}`);
    let logStream = null;

    const container = docker.getContainer(containerId);
    container.logs({
        follow: true, stdout: true, stderr: true,
        tail: 200, timestamps: false
    }, (err, stream) => {
        if (err) {
            socket.send(JSON.stringify({ type: 'error', data: err.message }));
            socket.close();
            return;
        }
        logStream = stream;

        stream.on('data', (chunk) => {
            let text = '';
            if (chunk.length >= 8 && (chunk[0] === 1 || chunk[0] === 2)) {
                let offset = 0;
                while (offset < chunk.length) {
                    const size = chunk.readUInt32BE(offset + 4);
                    text += chunk.toString('utf8', offset + 8, offset + 8 + size);
                    offset += 8 + size;
                }
            } else {
                text = chunk.toString('utf8');
            }
            const filtered = filterStatsLogs(text);
            if (filtered.trim()) {
                socket.send(JSON.stringify({ type: 'log', data: filtered }));
            }
        });

        stream.on('end',   () => { socket.send(JSON.stringify({ type: 'status', data: 'Stream ended' })); socket.close(); });
        stream.on('error', (e) => { socket.send(JSON.stringify({ type: 'error',  data: e.message })); socket.close(); });
    });

    // Handle commands from frontend
    socket.on('message', async (message) => {
        try {
            const parsed = JSON.parse(message);
            if (parsed.type === 'command') {
                const info         = await container.inspect();
                const portBindings = info.HostConfig.PortBindings;
                let   port         = 27015;
                for (const key in portBindings) {
                    if (key.endsWith('/udp')) { port = parseInt(portBindings[key][0].HostPort); break; }
                }
                const serverRecord = await panelDb.getServerByContainerId(containerId);
                const rconPass  = (serverRecord && serverRecord.rcon_password) || 'rcon123';

                const qh = require('./queryHelper');
                const ip = qh.getServerIp(info);
                console.log(`RCON cmd: "${parsed.data}" on port ${port} (IP: ${ip})`);
                const response = await qh.sendRconCommand(ip, port, rconPass, parsed.data);
                socket.send(JSON.stringify({ type: 'rcon_response', data: response }));
            }
        } catch (e) {
            socket.send(JSON.stringify({ type: 'error', data: `Error: ${e.message}` }));
        }
    });

    socket.on('close', () => {
        console.log(`WS disconnected: ${containerId.slice(0, 12)}`);
        if (logStream && logStream.destroy) logStream.destroy();
    });
});

// ---- Background Check: Expired Servers (Hourly) ----
async function checkExpiredServers() {
    console.log('[Expired Check] Starting hourly check...');
    try {
        const db = panelDb.assertPool();
        // Find servers where expires_at <= NOW()
        const [expired] = await db.query(
            "SELECT id, container_id, port, name, db_name, db_username FROM panel_servers WHERE expires_at <= NOW() AND owner_id != 1"
        );

        if (!expired || !expired.length) {
            console.log('[Expired Check] No expired servers found.');
            return;
        }

        const fastdl = require('./fastdlService');

        for (const s of expired) {
            if (isProtectedPort(s.port)) {
                console.warn(`[Expired Check] Port ${s.port} is protected; destructive expiry cleanup skipped.`);
                continue;
            }
            console.log(`[Expired Check] Server "${s.name}" (Port: ${s.port}) has expired. Deleting...`);
            try {
                const container = docker.getContainer(s.container_id);
                
                // Stop container
                try {
                    await container.stop({ t: 5 });
                } catch (stopErr) {
                    console.log(`[Expired Check] Stop container warning: ${stopErr.message}`);
                }

                // Remove container
                try {
                    await container.remove({ force: true });
                } catch (rmErr) {
                    console.log(`[Expired Check] Remove container warning: ${rmErr.message}`);
                }

                // Remove volume
                try {
                    const volumeName = `cs16-server-${s.port}-cstrike`;
                    const vol = docker.getVolume(volumeName);
                    await vol.remove();
                } catch (volErr) {
                    console.log(`[Expired Check] Remove volume warning: ${volErr.message}`);
                }

                // Drop MySQL DB
                try {
                    if (s.db_name && s.db_username) {
                        await panelDb.dropSqlAccount(s.db_name, s.db_username);
                    }
                } catch (sqlErr) {
                    console.log(`[Expired Check] Drop MySQL warning: ${sqlErr.message}`);
                }

                // Delete local FastDL files
                try {
                    const localFastdlDir = fastdl.fastdlDir(s.port);
                    if (fs.existsSync(localFastdlDir)) {
                        fs.rmSync(localFastdlDir, { recursive: true, force: true });
                    }
                } catch (fdlErr) {
                    console.log(`[Expired Check] Delete FastDL warning: ${fdlErr.message}`);
                }

                // Delete local PHP files
                try {
                    const localPhpDir = path.join(__dirname, 'php-data', String(s.port));
                    if (fs.existsSync(localPhpDir)) {
                        fs.rmSync(localPhpDir, { recursive: true, force: true });
                    }
                } catch (phpErr) {
                    console.log(`[Expired Check] Delete PHP data warning: ${phpErr.message}`);
                }

                // Delete from panelDb
                await panelDb.deleteServerRecord(s.container_id);
                console.log(`[Expired Check] Server "${s.name}" deleted successfully.`);

            } catch (err) {
                console.error(`[Expired Check] Error deleting expired server ${s.id}:`, err);
            }
        }
        
        // Recreate reset servers back into the always-on pool
        if (expired && expired.length) {
            await require('./poolService').ensurePool(docker);
        }
    } catch (e) {
        console.error('[Expired Check] Error during hourly check:', e);
    }
}

// ---- Start ----
async function start() {
    await panelDb.init(docker);
    
    // Start background check every hour (3600000 ms) and check immediately once on startup
    setInterval(checkExpiredServers, 3600000);
    checkExpiredServers();
    setInterval(() => panelDb.cleanupAuthHandoffs().catch((e) => {
        console.error('[Auth Handoff Cleanup]', e.message);
    }), 300000);

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`CS 1.6 Server Panel running on http://localhost:${PORT}`);
        console.log(`FastDL path : ${process.env.FASTDL_PATH || '(local fallback)'}`);
        console.log(`MySQL host  : ${process.env.MYSQL_HOST  || '127.0.0.1'}:${process.env.MYSQL_PORT || 3306}`);
        console.log('Seed logins : admin/admin123 and user/user123 unless overridden by env.');
    });
}

start().catch((e) => {
    console.error('Failed to start CS panel:', e);
    process.exit(1);
});

const express = require('express');
const queryHelper = require('../queryHelper');
const fastdl = require('../fastdlService');
const containerFs = require('../containerFsHelper');
const gameContainer = require('../gameContainer');
const billing = require('../billingService');
const cfg = require('../config');
const security = require('../security');
const serverOps = require('../serverOps');
const { assertDestructiveOperationAllowed, isProtectedPort } = require('../serverProtection');

const router = express.Router();

function routeError(res, e) {
    const status = e.statusCode || 500;
    if (status >= 500) console.error('[Servers]', e.message);
    res.status(status).json({ error: e.message, code: e.code });
}

function audit(req, action, port, details = null) {
    return req.panelDb.logAudit({
        actorId: req.user.id, actorName: req.user.username, action,
        targetType: 'server', targetId: port, details, ip: security.clientIp(req)
    });
}

// ---------------------------------------------------------------------------
//  Live status (A2S + RCON stats) with caching and in-flight de-duplication
// ---------------------------------------------------------------------------

const LIVE_TTL_MS = 10000;
const STATS_TTL_MS = 60000;
const liveCache = new Map();   // containerId -> { at, data }
const statsCache = new Map();  // containerId -> { at, stats }
const inflight = new Map();

async function liveStatus(container, record, inspect) {
    const key = container.id;
    const cached = liveCache.get(key);
    if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.data;
    if (inflight.has(key)) return inflight.get(key);

    const promise = (async () => {
        const port = gameContainer.gamePortFromInspect(inspect) || record.port;
        const ip = queryHelper.getServerIp(inspect);
        const statsEntry = statsCache.get(key);
        const statsPromise = statsEntry && Date.now() - statsEntry.at < STATS_TTL_MS
            ? Promise.resolve(statsEntry.stats)
            : queryHelper.getServerStats(ip, port, record.rcon_password || '')
                .then(stats => { statsCache.set(key, { at: Date.now(), stats }); return stats; })
                .catch(() => ({ fps: 0, cpu: 0 }));
        const [info, stats] = await Promise.all([queryHelper.getServerInfo(ip, port), statsPromise]);
        const data = info.online
            ? { online: true, name: info.name, map: info.map, players: info.players, maxPlayers: info.maxPlayers, fps: stats.fps || 0, cpu: stats.cpu || 0 }
            : { online: false };
        liveCache.set(key, { at: Date.now(), data });
        return data;
    })().finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
}

function invalidateLive(containerId) {
    liveCache.delete(containerId);
}

async function serializeServer(req, record, summary, plansBySlug, { graceDays = 3 } = {}) {
    const env = {};
    let inspect = null;
    let live = { online: false };
    if (summary) {
        try {
            inspect = await req.docker.getContainer(summary.Id).inspect();
            (inspect.Config.Env || []).forEach(e => {
                const i = e.indexOf('=');
                env[e.slice(0, i)] = e.slice(i + 1);
            });
            if (summary.State === 'running' && !record.suspended) {
                live = await liveStatus({ id: summary.Id }, record, inspect);
            }
        } catch (_) { /* container vanished between list and inspect */ }
    }
    const plan = plansBySlug.get(record.plan_type);
    const port = record.port;
    return {
        id: record.container_id,
        dbId: record.id,
        name: live.online ? live.name : (record.name || env.SERVER_NAME || `Server ${port}`),
        owner: record.owner_username,
        owner_id: record.owner_id,
        ip: cfg.gameServerHost,
        address: `${cfg.gameServerHost}:${port}`,
        port,
        state: summary ? summary.State : 'missing',
        statusText: summary ? summary.Status : 'Konteyner bulunamadı',
        online: !!live.online,
        map: live.online ? live.map : (env.START_MAP || 'de_dust2'),
        players: live.online ? live.players : 0,
        maxPlayers: live.online ? live.maxPlayers : parseInt(env.MAXPLAYERS || (plan && plan.max_players) || 32, 10),
        fps: live.fps || 0,
        cpu: live.cpu || 0,
        plan_type: record.plan_type,
        plan_name: plan ? plan.name : record.plan_type,
        plan_is_trial: plan ? plan.is_trial : false,
        expires_at: record.expires_at,
        rented_at: record.rented_at,
        auto_renew: !!record.auto_renew,
        suspended: !!record.suspended,
        suspended_reason: record.suspended_reason || null,
        deletes_at: (() => { const d = require('../lifecycleService').deletionDate(record, graceDays); return d ? d.toISOString() : null; })(),
        is_pool: !!record.is_pool,
        protected: isProtectedPort(port),
        sql: record.db_name ? {
            database: record.db_name,
            username: record.db_username,
            host: cfg.mysql.internalHost,
            port: cfg.mysql.internalPort,
            externalHost: cfg.mysql.publicHost || null,
            externalPort: cfg.mysql.publicHost ? cfg.mysql.publicPort : null
        } : null,
        php: { url: cfg.phpSiteUrl(port), domain: record.php_domain || null },
        fastdl: { url: cfg.fastdlUrl(port) }
    };
}

// GET /api/servers — servers the user can manage (admins: everything)
router.get('/', async (req, res) => {
    try {
        const [containers, records, plans, graceSetting] = await Promise.all([
            req.docker.listContainers({ all: true }),
            req.panelDb.listServersForUser(req.user),
            req.panelDb.listPlans({ activeOnly: false }),
            req.panelDb.getSetting('grace_days')
        ]);
        const graceDays = parseInt(graceSetting || '3', 10);
        const plansBySlug = new Map(plans.map(p => [p.slug, p]));
        const containersById = new Map(containers.map(c => [c.Id, c]));
        const known = new Set(records.map(r => r.container_id));

        // Admins also see stray cs16-server-* containers so they can be adopted.
        if (req.user.role === 'admin') {
            for (const c of containers) {
                if (!known.has(c.Id) && (c.Names || []).some(n => /cs16-server-\d+$/.test(n))) {
                    try {
                        records.push(await req.panelDb.requireServerAccess(req.user, req.docker, c.Id));
                    } catch (e) {
                        console.log(`Adopt skipped for ${c.Id.slice(0, 12)}:`, e.message);
                    }
                }
            }
        }

        const list = await Promise.all(records.map(record =>
            serializeServer(req, record, containersById.get(record.container_id), plansBySlug, { graceDays })
                .catch(err => { console.error(`Server ${record.port}:`, err.message); return null; })
        ));
        res.json(list.filter(Boolean).sort((a, b) => a.port - b.port));
    } catch (e) {
        routeError(res, e);
    }
});

// GET /api/servers/available — rentable pool slots
router.get('/available', async (req, res) => {
    try {
        const pool = await req.panelDb.listUnrentedPoolServers();
        res.json({ servers: pool.map(s => ({ port: s.port, address: `${cfg.gameServerHost}:${s.port}` })) });
    } catch (e) {
        routeError(res, e);
    }
});

// GET /api/servers/quote?plan=&months=&coupon=
router.get('/quote', async (req, res) => {
    try {
        const plan = await req.panelDb.getPlan(req.query.plan);
        if (!plan || (!plan.active && !req.query.renew)) return res.status(404).json({ error: 'Paket bulunamadı.' });
        const q = await billing.quote({ plan, months: req.query.months, couponCode: req.query.coupon, userId: req.user.id });
        res.json(billing.publicQuote(q));
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/servers/create — rent a pool server (paywall checkout)
router.post('/create', security.rateLimit({ name: 'rent', windowMs: 60000, max: 5, keys: req => [String(req.user.id)] }), async (req, res) => {
    try {
        if (req.user.suspended) return res.status(403).json({ error: 'Hesabınız askıda.' });
        const { record, quote } = await billing.rentServer(req.docker, req.user, req.body || {}, { ip: security.clientIp(req) });
        res.json({
            success: true,
            message: `Sunucu kiralandı! Port: ${record.port}. Kurulum 30-60 saniye sürer.`,
            containerId: record.container_id,
            port: record.port,
            quote
        });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/servers/:id/renew — extend (or upgrade) a subscription
router.post('/:id/renew', async (req, res) => {
    try {
        await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id, { allowSuspended: true });
        const body = req.body || {};
        const result = await billing.renewServer(req.docker, req.user, req.params.id, {
            months: body.months || 1, couponCode: body.coupon || null, planSlug: body.plan || null, ip: security.clientIp(req)
        });
        invalidateLive(req.params.id);
        res.json({
            success: true,
            message: 'Sunucu süresi uzatıldı.',
            expires_at: result.expires_at,
            containerId: result.record.container_id,
            quote: result.quote
        });
    } catch (e) {
        routeError(res, e);
    }
});

// GET /api/servers/:id/refund-quote — prorated refund for the unused paid time
router.get('/:id/refund-quote', async (req, res) => {
    try {
        const record = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id, { allowSuspended: true });
        const quote = await require('../refundService').quoteForServer(record);
        const [pending] = await req.panelDb.assertPool().query("SELECT id, created_at FROM panel_refund_requests WHERE server_id = ? AND status = 'pending' LIMIT 1", [record.id]);
        res.json({ success: true, quote, pendingRequest: pending[0] || null });
    } catch (e) {
        routeError(res, e);
    }
});

router.post('/:id/auto-renew', async (req, res) => {
    try {
        const record = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id, { allowSuspended: true });
        const enabled = !!(req.body && (req.body.enabled === true || req.body.enabled === 'true'));
        const plan = await req.panelDb.getPlan(record.plan_type);
        if (enabled && plan && plan.is_trial) return res.status(400).json({ error: 'Deneme paketinde otomatik yenileme kullanılamaz.' });
        await req.panelDb.updateServerContainer(record.container_id, { auto_renew: enabled ? 1 : 0 });
        res.json({ success: true, auto_renew: enabled });
    } catch (e) {
        routeError(res, e);
    }
});

async function powerAction(req, res, action) {
    try {
        const current = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const { record, recreated } = await serverOps.powerAction(req.docker, current, action);
        if (recreated) await audit(req, 'server.recreate', record.port);
        invalidateLive(req.params.id);
        invalidateLive(record.container_id);
        await audit(req, `server.${action}`, record.port);
        const labels = { start: 'başlatıldı', stop: 'durduruldu', restart: 'yeniden başlatıldı' };
        res.json({ success: true, message: `Sunucu ${labels[action]}.`, containerId: record.container_id });
    } catch (e) {
        routeError(res, e);
    }
}

router.post('/:id/start', (req, res) => powerAction(req, res, 'start'));
router.post('/:id/stop', (req, res) => powerAction(req, res, 'stop'));
router.post('/:id/restart', (req, res) => powerAction(req, res, 'restart'));

// DELETE /api/servers/:id — admin only, removes the server and its resources
router.delete('/:id', async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Yalnızca yöneticiler sunucu silebilir.' });
        const record = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        assertDestructiveOperationAllowed(record.port, 'deleted');
        const errors = await require('../lifecycleService').destroyServerResources(req.docker, record);
        await audit(req, 'server.delete', record.port);
        res.json({
            success: true,
            message: errors.length ? 'Sunucu silindi, ancak bazı temizlik adımları başarısız oldu.' : 'Sunucu silindi.',
            cleanupErrors: errors
        });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/servers/:id/reset — wipe game files and reinstall from the clean image
router.post('/:id/reset', async (req, res) => {
    try {
        const record = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);
        const info = await container.inspect();
        const port = gameContainer.gamePortFromInspect(info) || record.port;
        if (!port) return res.status(400).json({ error: 'Sunucu portu belirlenemedi.' });
        assertDestructiveOperationAllowed(port, 'reset');

        const plan = await req.panelDb.getPlan(record.plan_type);
        const maxPlayers = parseInt(req.panelDb.getEnvValue(info.Config.Env, 'MAXPLAYERS', (plan && plan.max_players) || 24), 10);
        const startMap = req.panelDb.getEnvValue(info.Config.Env, 'START_MAP', 'de_dust2');

        await gameContainer.removeContainerQuietly(req.docker, record.container_id);
        await gameContainer.removeVolumeWithRetry(req.docker, port);
        fastdl.ensureCleanFastdlTree(port);
        const fresh = await gameContainer.createGameContainer(req.docker, {
            port, name: record.name, rconPassword: record.rcon_password, maxPlayers, startMap, sql: record
        });
        const updated = await req.panelDb.updateServerContainer(record.container_id, { container_id: fresh.id });
        gameContainer.finishProvisioningInBackground(fresh, updated);
        await audit(req, 'server.reset', port);
        res.json({
            success: true,
            message: `Port ${port} sıfırlandı. Temiz kurulum başlıyor (30-60 sn).`,
            containerId: fresh.id
        });
    } catch (e) {
        routeError(res, e);
    }
});

// ---------------------------------------------------------------------------
//  server.cfg settings
// ---------------------------------------------------------------------------

const CVAR_FIELDS = {
    // field          cvar               validator
    name:               ['hostname', 'text'],
    rconPassword:       ['rcon_password', 'secret'],
    sv_password:        ['sv_password', 'text'],
    fpsLimit:           ['sys_ticrate', 'number'],
    mp_timelimit:       ['mp_timelimit', 'number'],
    mp_roundtime:       ['mp_roundtime', 'number'],
    mp_freezetime:      ['mp_freezetime', 'number'],
    mp_friendlyfire:    ['mp_friendlyfire', 'bool'],
    mp_c4timer:         ['mp_c4timer', 'number'],
    sv_maxspeed:        ['sv_maxspeed', 'number'],
    sv_gravity:         ['sv_gravity', 'number'],
    pausable:           ['pausable', 'bool'],
    sv_cheats:          ['sv_cheats', 'bool'],
    mp_autoteambalance: ['mp_autoteambalance', 'bool'],
    mp_limitteams:      ['mp_limitteams', 'number'],
    mp_startmoney:      ['mp_startmoney', 'number'],
    mp_buytime:         ['mp_buytime', 'number'],
    mp_forcechasecam:   ['mp_forcechasecam', 'number'],
    mp_footsteps:       ['mp_footsteps', 'bool'],
    mp_flashlight:      ['mp_flashlight', 'bool'],
    decalfrequency:     ['decalfrequency', 'number'],
    sv_voiceenable:     ['sv_voiceenable', 'bool'],
    sv_alltalk:         ['sv_alltalk', 'bool']
};

const CVAR_DEFAULTS = {
    hostname: 'CS 1.6 Server', rcon_password: '', sv_password: '', sys_ticrate: '1000', mp_timelimit: '20',
    mp_roundtime: '2.5', mp_freezetime: '1', mp_friendlyfire: '0', mp_c4timer: '35', sv_maxspeed: '320',
    sv_gravity: '800', pausable: '0', sv_cheats: '0', mp_autoteambalance: '1', mp_limitteams: '2',
    mp_startmoney: '800', mp_buytime: '1.5', mp_forcechasecam: '0', mp_footsteps: '1', mp_flashlight: '0',
    decalfrequency: '60', sv_voiceenable: '1', sv_alltalk: '0'
};

function cfgError(message) {
    const e = new Error(message);
    e.statusCode = 400;
    return e;
}

function validateCvarValue(field, cvar, kind, raw) {
    const value = String(raw).trim();
    if (/[\r\n;"]/.test(value)) throw cfgError(`${cvar} değeri ; " veya satır sonu içeremez.`);
    if (kind === 'number' && !/^-?\d+(\.\d+)?$/.test(value)) throw cfgError(`${cvar} sayısal olmalı.`);
    if (kind === 'bool' && !/^[01]$/.test(value)) throw cfgError(`${cvar} 0 veya 1 olmalı.`);
    if (kind === 'secret' && !/^[A-Za-z0-9!@#$%^&*()_+\-=.,:?]{8,64}$/.test(value)) {
        throw cfgError('RCON şifresi 8-64 karakter olmalı; boşluk ve tırnak içeremez.');
    }
    if (kind === 'text' && value.length > 64) throw cfgError(`${cvar} en fazla 64 karakter olabilir.`);
    return value;
}

function extractCfgValue(content, key, defaultValue = '') {
    const regex = new RegExp(`^[ \\t]*${key}[ \\t]+"?([^"\\r\\n]*)"?`, 'm');
    const match = content.match(regex);
    return match ? match[1].trim() : defaultValue;
}

function updateOrAppendCfg(content, key, value, kind) {
    const regex = new RegExp(`^[ \\t]*${key}[ \\t]+.*$`, 'm');
    const line = (kind === 'number' || kind === 'bool') ? `${key} ${value}` : `${key} "${value}"`;
    return regex.test(content) ? content.replace(regex, line) : `${content.replace(/\s*$/, '')}\n${line}\n`;
}

router.get('/:id/settings', async (req, res) => {
    try {
        await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);
        const content = await containerFs.readFile(container, 'server.cfg');
        let startupMap = 'de_dust2';
        try {
            if (await containerFs.fileExists(container, 'startup_map.txt')) {
                startupMap = (await containerFs.readFile(container, 'startup_map.txt')).trim() || startupMap;
            } else {
                const inspect = await container.inspect();
                startupMap = req.panelDb.getEnvValue(inspect.Config.Env, 'START_MAP', startupMap);
            }
        } catch (_) { /* default map */ }
        const settings = { startupMap };
        for (const [field, [cvar]] of Object.entries(CVAR_FIELDS)) {
            settings[field] = extractCfgValue(content, cvar, CVAR_DEFAULTS[cvar]);
        }
        res.json({ success: true, settings });
    } catch (e) {
        routeError(res, e);
    }
});

router.post('/:id/settings', async (req, res) => {
    try {
        const record = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);
        const info = await container.inspect();
        const body = req.body || {};
        if (body.map && !/^[A-Za-z0-9_.-]{1,64}$/.test(body.map)) return res.status(400).json({ error: 'Geçersiz harita adı' });
        if (body.startupMap && !/^[A-Za-z0-9_.-]{1,64}$/.test(String(body.startupMap).trim())) return res.status(400).json({ error: 'Geçersiz başlangıç haritası' });

        const port = gameContainer.gamePortFromInspect(info) || record.port;
        const ip = queryHelper.getServerIp(info);
        const running = info.State.Running;
        const currentRcon = record.rcon_password || '';

        const updates = [];
        for (const [field, [cvar, kind]] of Object.entries(CVAR_FIELDS)) {
            if (body[field] === undefined || body[field] === null) continue;
            if (field === 'rconPassword' && String(body[field]).trim() === '') continue;
            updates.push([cvar, kind, validateCvarValue(field, cvar, kind, body[field])]);
        }

        if (updates.length) {
            let content = await containerFs.readFile(container, 'server.cfg');
            for (const [cvar, kind, value] of updates) content = updateOrAppendCfg(content, cvar, value, kind);
            if (updates.some(([cvar]) => cvar === 'sys_ticrate')) {
                const fps = updates.find(([cvar]) => cvar === 'sys_ticrate')[2];
                content = updateOrAppendCfg(content, 'fps_max', fps, 'number');
            }
            await containerFs.writeFile(container, 'server.cfg', content);

            if (running) {
                // Apply live in a few batched RCON packets instead of one round-trip per cvar.
                const commands = updates.map(([cvar, kind, value]) => (kind === 'number' || kind === 'bool') ? `${cvar} ${value}` : `${cvar} "${value}"`);
                for (let i = 0; i < commands.length; i += 8) {
                    await queryHelper.sendRconCommand(ip, port, currentRcon, commands.slice(i, i + 8).join('; ')).catch(() => {});
                }
            }
        }

        const recordUpdates = {};
        if (body.name !== undefined && String(body.name).trim()) recordUpdates.name = gameContainer.sanitizeServerName(body.name, record.name);
        const newRcon = updates.find(([cvar]) => cvar === 'rcon_password');
        if (newRcon) recordUpdates.rcon_password = newRcon[2];
        if (Object.keys(recordUpdates).length) {
            const updated = await req.panelDb.updateServerContainer(record.container_id, recordUpdates);
            try { require('../phpSiteService').writeSiteConfig(updated); } catch (_) { /* site not provisioned */ }
        }

        if (body.startupMap) await containerFs.writeFile(container, 'startup_map.txt', String(body.startupMap).trim());
        if (body.map && running) {
            await queryHelper.sendRconCommand(ip, port, newRcon ? newRcon[2] : currentRcon, `changelevel ${body.map}`);
        }
        invalidateLive(req.params.id);
        await audit(req, 'server.settings', port, { fields: updates.map(u => u[0]).filter(c => c !== 'rcon_password') });
        res.json({ success: true, message: running ? 'Ayarlar kaydedildi ve sunucuya uygulandı.' : 'Ayarlar kaydedildi; sunucu başlatıldığında geçerli olacak.' });
    } catch (e) {
        routeError(res, e);
    }
});

// GET /api/servers/:id/configs — editable config files (max depth 4)
router.get('/:id/configs', async (req, res) => {
    try {
        await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);
        const pythonScript = `
import os, json
root = '/hlds/cstrike'
priorities = ['server.cfg', 'addons/amxmodx/configs/amxx.cfg', 'addons/amxmodx/configs/plugins.ini',
              'addons/amxmodx/configs/users.ini', 'addons/amxmodx/configs/sql.cfg', 'mapcycle.txt', 'motd.txt']
items = []
for current, dirs, files in os.walk(root):
    dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('logs', 'models', 'sprites', 'sound', 'gfx', 'maps', 'scripting')]
    rel_dir = os.path.relpath(current, root)
    if rel_dir != '.' and len(rel_dir.split(os.sep)) > 4:
        dirs[:] = []
        continue
    for name in files:
        if name.lower().endswith(('.cfg', '.ini', '.txt')):
            items.append(os.path.relpath(os.path.join(current, name), root).replace(os.sep, '/'))
items.sort(key=lambda p: (0, priorities.index(p), p) if p in priorities else (1, 0, p))
print(json.dumps(items[:500]))
`;
        const result = await containerFs.runExec(container, { Cmd: ['python3', '-c', pythonScript] });
        res.json({ success: true, configs: JSON.parse(result.output.trim() || '[]') });
    } catch (e) {
        routeError(res, e);
    }
});

// GET /api/servers/:id/logs — container stdout/stderr tail
router.get('/:id/logs', async (req, res) => {
    try {
        await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 500, 50), 5000);
        const buffer = await req.docker.getContainer(req.params.id).logs({ stdout: true, stderr: true, tail, follow: false });
        res.json({ success: true, logs: containerFs.decodeDockerOutput(Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer))) });
    } catch (e) {
        routeError(res, e);
    }
});

// GET /api/servers/:id/crash-logs — sys_error.log, debug.log, latest AMXX error log
router.get('/:id/crash-logs', async (req, res) => {
    try {
        await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(req.params.id);
        // File names come from the customer's own volume, so pass them as argv
        // (never through a shell) and cap how much we read.
        const script = `
import glob, json, os
def tail(path, limit=200000):
    try:
        with open(path, 'rb') as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - limit))
            return f.read().decode('utf-8', 'ignore')
    except Exception:
        return ''
errors = sorted(glob.glob('/hlds/cstrike/addons/amxmodx/logs/error_*.log'))
print(json.dumps({
    'sys_error': tail('/hlds/cstrike/sys_error.log'),
    'debug_log': tail('/hlds/debug.log'),
    'amxx_errors': tail(errors[-1]) if errors else '',
    'amxx_file': os.path.basename(errors[-1]) if errors else None
}))
`;
        const result = await containerFs.runExec(container, { Cmd: ['python3', '-c', script] }, { timeoutMs: 20000 });
        const data = JSON.parse(result.output.trim() || '{}');
        res.json({
            success: true,
            sys_error: String(data.sys_error || '').trim(),
            debug_log: String(data.debug_log || '').trim(),
            amxx_errors: String(data.amxx_errors || '').trim(),
            amxx_file: data.amxx_file || null
        });
    } catch (e) {
        routeError(res, e);
    }
});

// ---------------------------------------------------------------------------
//  Resource usage (docker stats + volume size)
// ---------------------------------------------------------------------------

const DISK_TTL_MS = 5 * 60 * 1000;
const diskCache = new Map(); // containerId -> { at, bytes }

async function volumeUsage(container, running) {
    const cached = diskCache.get(container.id);
    if (cached && Date.now() - cached.at < DISK_TTL_MS) return cached;
    if (!running) return cached || null;
    const result = await containerFs.runExec(container, { Cmd: ['du', '-sb', '/hlds/cstrike'] }, { timeoutMs: 30000, allowNonZero: true });
    const bytes = parseInt(String(result.output).trim().split(/\s+/)[0], 10);
    if (!Number.isFinite(bytes)) return cached || null;
    const entry = { at: Date.now(), bytes };
    diskCache.set(container.id, entry);
    return entry;
}

router.get('/:id/resources', async (req, res) => {
    try {
        const record = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(record.container_id);
        const inspect = await container.inspect();
        const running = !!(inspect.State && inspect.State.Running);
        let cpu = { percent: 0, cores: null };
        let memory = { used: 0, limit: inspect.HostConfig && inspect.HostConfig.Memory ? inspect.HostConfig.Memory : 0, limited: !!(inspect.HostConfig && inspect.HostConfig.Memory) };
        let network = { rx: 0, tx: 0 };
        if (running) {
            const stats = await container.stats({ stream: false });
            cpu = serverOps.cpuPercentFromStats(stats);
            memory = serverOps.memoryFromStats(stats, inspect.HostConfig && inspect.HostConfig.Memory);
            network = serverOps.networkFromStats(stats);
        }
        const disk = await volumeUsage(container, running).catch(() => null);
        res.json({
            success: true,
            running,
            startedAt: running ? inspect.State.StartedAt : null,
            restartCount: inspect.RestartCount || 0,
            cpu,
            memory,
            network,
            disk: disk ? { used: disk.bytes, measuredAt: new Date(disk.at).toISOString() } : null,
            sampledAt: new Date().toISOString()
        });
    } catch (e) {
        routeError(res, e);
    }
});

// ---------------------------------------------------------------------------
//  Launch parameters (read by entrypoint.sh at container start)
// ---------------------------------------------------------------------------

const STARTUP_FILE = 'panel_startup.cfg';
const STARTUP_FIELDS = {
    pingboost: { key: 'PINGBOOST', def: 2, valid: v => [0, 1, 2, 3].includes(v), error: 'pingboost 0-3 arasında olmalı.' },
    sysTicrate: { key: 'SYS_TICRATE', def: 1000, valid: v => v >= 100 && v <= 1000, error: 'sys_ticrate 100-1000 arasında olmalı.' },
    fpsMax: { key: 'FPS_MAX', def: 1000, valid: v => v >= 100 && v <= 1000, error: 'fps_max 100-1000 arasında olmalı.' },
    insecure: { key: 'INSECURE', def: 0, valid: v => v === 0 || v === 1, error: 'insecure 0 veya 1 olmalı.' },
    nomaster: { key: 'NOMASTER', def: 0, valid: v => v === 0 || v === 1, error: 'nomaster 0 veya 1 olmalı.' }
};

function parseStartupFile(content) {
    const values = {};
    for (const [field, spec] of Object.entries(STARTUP_FIELDS)) values[field] = spec.def;
    String(content || '').split(/\r?\n/).forEach(line => {
        const m = /^([A-Z_]+)=(\d+)\s*$/.exec(line.trim());
        if (!m) return;
        const entry = Object.entries(STARTUP_FIELDS).find(([, spec]) => spec.key === m[1]);
        if (!entry) return;
        const value = parseInt(m[2], 10);
        if (entry[1].valid(value)) values[entry[0]] = value;
    });
    return values;
}

function normalizeStartup(input) {
    const out = {};
    for (const [field, spec] of Object.entries(STARTUP_FIELDS)) {
        let raw = input[field];
        if (raw === undefined || raw === null || raw === '') { out[field] = spec.def; continue; }
        if (typeof raw === 'boolean') raw = raw ? 1 : 0;
        const value = Number(raw);
        if (!Number.isInteger(value) || !spec.valid(value)) throw cfgError(spec.error);
        out[field] = value;
    }
    return out;
}

function renderStartupFile(values) {
    return ['# Managed by CS 1.6 Panel — applied on the next server start', ...Object.entries(STARTUP_FIELDS).map(([field, spec]) => `${spec.key}=${values[field]}`)].join('\n') + '\n';
}

router.get('/:id/startup', async (req, res) => {
    try {
        const record = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(record.container_id);
        let content = '';
        try {
            if (await containerFs.fileExists(container, STARTUP_FILE)) content = await containerFs.readFile(container, STARTUP_FILE);
        } catch (_) { /* defaults */ }
        res.json({ success: true, startup: parseStartupFile(content), defaults: Object.fromEntries(Object.entries(STARTUP_FIELDS).map(([f, s]) => [f, s.def])) });
    } catch (e) {
        routeError(res, e);
    }
});

router.put('/:id/startup', async (req, res) => {
    try {
        const record = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const values = normalizeStartup(req.body || {});
        const container = req.docker.getContainer(record.container_id);
        await containerFs.writeFile(container, STARTUP_FILE, renderStartupFile(values));
        let restarted = false;
        if (req.body && (req.body.restart === true || req.body.restart === 'true')) {
            await serverOps.powerAction(req.docker, record, 'restart');
            invalidateLive(record.container_id);
            restarted = true;
        }
        await audit(req, 'server.startup', record.port, values);
        res.json({
            success: true,
            startup: values,
            restarted,
            message: restarted ? 'Başlatma parametreleri kaydedildi, sunucu yeniden başlatılıyor.' : 'Başlatma parametreleri kaydedildi; sunucu yeniden başlatıldığında uygulanır.'
        });
    } catch (e) {
        routeError(res, e);
    }
});

// ---------------------------------------------------------------------------
//  Game log files & chat history (cstrike/logs/L*.log)
// ---------------------------------------------------------------------------

const LOG_FILE_RE = /^L\d{4,8}\.log$/;

function assertLogFileName(name) {
    if (!LOG_FILE_RE.test(String(name || ''))) throw cfgError('Geçersiz log dosyası adı.');
    return String(name);
}

// "L 10/17/2026 - 21:04:11: "Nick<12><STEAM_0:1:123><CT>" say "hello""
const CHAT_RE = /^L (\d{2})\/(\d{2})\/(\d{4}) - (\d{2}):(\d{2}):(\d{2}): "(.*)<(\d+)><([^>]*)><([^>]*)>" (say|say_team) "(.*)"(?: \(dead\))?\s*$/;

function parseChatLine(line) {
    const m = CHAT_RE.exec(line);
    if (!m) return null;
    return {
        time: `${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6]}`,
        name: m[7],
        userId: parseInt(m[8], 10),
        steamId: m[9],
        team: m[10],
        channel: m[11] === 'say_team' ? 'team' : 'all',
        dead: /\(dead\)\s*$/.test(line),
        message: m[12]
    };
}

router.get('/:id/logfiles', async (req, res) => {
    try {
        const record = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(record.container_id);
        const script = `
import os, json
root = '/hlds/cstrike/logs'
items = []
if os.path.isdir(root):
    for name in os.listdir(root):
        path = os.path.join(root, name)
        if name.startswith('L') and name.endswith('.log') and os.path.isfile(path) and not os.path.islink(path):
            st = os.stat(path)
            items.append({'name': name, 'size': st.st_size, 'modified': int(st.st_mtime)})
items.sort(key=lambda i: i['modified'], reverse=True)
print(json.dumps(items[:200]))
`;
        const result = await containerFs.runExec(container, { Cmd: ['python3', '-c', script] }, { timeoutMs: 20000 });
        const files = JSON.parse(result.output.trim() || '[]').map(f => ({ ...f, modified: new Date(f.modified * 1000).toISOString() }));
        res.json({ success: true, files });
    } catch (e) {
        routeError(res, e);
    }
});

router.get('/:id/logfiles/download', async (req, res) => {
    try {
        const record = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const name = assertLogFileName(req.query.file);
        const container = req.docker.getContainer(record.container_id);
        const file = await containerFs.openFileStream(container, `logs/${name}`);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${record.port}-${name}"`);
        res.setHeader('Content-Length', String(file.size));
        file.stream.on('end', file.done);
        file.stream.on('error', err => res.destroy(err));
        file.stream.pipe(res);
    } catch (e) {
        routeError(res, e);
    }
});

router.get('/:id/chat', async (req, res) => {
    try {
        const record = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const container = req.docker.getContainer(record.container_id);
        const file = req.query.file ? assertLogFileName(req.query.file) : '';
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 20), 2000);
        // Read only the say/say_team lines of the newest (or chosen) log files.
        const script = `
import os, sys, json
root = '/hlds/cstrike/logs'
wanted = sys.argv[1]
limit = int(sys.argv[2])
names = []
if os.path.isdir(root):
    names = sorted([n for n in os.listdir(root) if n.startswith('L') and n.endswith('.log')], key=lambda n: os.path.getmtime(os.path.join(root, n)), reverse=True)
if wanted:
    names = [wanted] if wanted in names else []
lines = []
for name in names[:10]:
    path = os.path.join(root, name)
    if os.path.islink(path):
        continue
    with open(path, 'rb') as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(max(0, size - 4000000))
        chunk = f.read().decode('utf-8', 'ignore').splitlines()
    found = [l for l in chunk if '" say "' in l or '" say_team "' in l]
    lines = found + lines
    if len(lines) >= limit:
        break
print(json.dumps({'files': names[:10], 'lines': lines[-limit:]}))
`;
        const result = await containerFs.runExec(container, { Cmd: ['python3', '-c', script, file, String(limit)] }, { timeoutMs: 30000 });
        const data = JSON.parse(result.output.trim() || '{}');
        const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
        let messages = (data.lines || []).map(parseChatLine).filter(Boolean);
        if (q) messages = messages.filter(m => m.message.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.steamId.toLowerCase().includes(q));
        res.json({ success: true, messages: messages.reverse(), files: data.files || [] });
    } catch (e) {
        routeError(res, e);
    }
});

module.exports = router;
module.exports._test = { validateCvarValue, updateOrAppendCfg, extractCfgValue, parseChatLine, assertLogFileName, normalizeStartup, parseStartupFile, renderStartupFile };

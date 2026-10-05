const express = require('express');
const router = express.Router();
const queryHelper = require('../queryHelper');
const cFs = require('../containerFsHelper');

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const STEAM_RE = /^(STEAM_[0-5]:[01]:\d{1,12}|VALVE_[0-5]:[01]:\d{1,12}|BOT|HLTV)$/i;

function badRequest(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

function iniField(value, label, { max = 64, required = true } = {}) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (required && !text) throw badRequest(`${label} zorunludur.`);
    if (text.length > max || /["\r\n;]/.test(text)) throw badRequest(`${label} geçersiz karakter içeriyor (" ; satır sonu) veya çok uzun.`);
    return text;
}

function banTarget(target, isIp) {
    const value = String(target || '').trim();
    if (isIp ? !IP_RE.test(value) : !STEAM_RE.test(value)) {
        throw badRequest(isIp ? 'Geçerli bir IPv4 adresi girin.' : 'Geçerli bir SteamID girin (örn. STEAM_0:1:12345).');
    }
    return value;
}

router.use('/:id', async (req, res, next) => {
    try {
        req.serverRecord = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        next();
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// GET /api/admins/:id - List admins and bans
router.get('/:id', async (req, res) => {
    try {
        const container = req.docker.getContainer(req.params.id);
        const inspect = await container.inspect();

        if (!inspect.State.Running) {
            return res.json({ admins: [], bans: [], offline: true });
        }

        const usersIniPath = 'addons/amxmodx/configs/users.ini';
        const listIpPath = 'listip.cfg';
        const bannedCfgPath = 'banned.cfg';

        // 1. Read and parse users.ini (Admins)
        const admins = [];
        if (await cFs.fileExists(container, usersIniPath)) {
            const content = await cFs.readFile(container, usersIniPath);
            const lines = content.split('\n');

            lines.forEach((line, index) => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(';')) return;

                const matches = trimmed.match(/"([^"]*)"/g);
                if (matches && matches.length >= 3) {
                    const auth = matches[0].replace(/"/g, '');
                    const password = matches[1].replace(/"/g, '');
                    const access = matches[2].replace(/"/g, '');
                    const flags = matches.length >= 4 ? matches[3].replace(/"/g, '') : '';

                    admins.push({
                        auth,
                        password,
                        access,
                        flags,
                        lineIndex: index,
                        raw: trimmed
                    });
                }
            });
        }

        // 2. Read and parse listip.cfg (IP Bans)
        const ipBans = [];
        if (await cFs.fileExists(container, listIpPath)) {
            const content = await cFs.readFile(container, listIpPath);
            const lines = content.split('\n');
            lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith('addip')) {
                    const parts = trimmed.split(/\s+/);
                    if (parts.length >= 3) {
                        ipBans.push({
                            ip: parts[2].replace(/"/g, ''),
                            duration: parts[1],
                            type: 'IP'
                        });
                    }
                }
            });
        }

        // 3. Read and parse banned.cfg (SteamID Bans)
        const authBans = [];
        if (await cFs.fileExists(container, bannedCfgPath)) {
            const content = await cFs.readFile(container, bannedCfgPath);
            const lines = content.split('\n');
            lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith('banid')) {
                    const parts = trimmed.split(/\s+/);
                    if (parts.length >= 3) {
                        authBans.push({
                            steamId: parts[2].replace(/"/g, ''),
                            duration: parts[1],
                            type: 'SteamID'
                        });
                    }
                }
            });
        }

        res.json({
            admins,
            bans: [...ipBans, ...authBans]
        });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// POST /api/admins/:id/add - Add admin
router.post('/:id/add', async (req, res) => {
    try {
        const container = req.docker.getContainer(req.params.id);
        const inspect = await container.inspect();
        const auth = iniField(req.body.auth, 'SteamID / Nick / IP');
        const password = iniField(req.body.password, 'Şifre', { required: false });
        const access = iniField(req.body.access, 'Yetki bayrakları', { max: 32 });
        const flags = iniField(req.body.flags, 'Giriş tipi', { max: 8 });
        const comment = iniField(req.body.comment, 'Not', { max: 100, required: false }).replace(/[\r\n]/g, ' ');
        if (!/^[a-z]+$/.test(access) || !/^[a-e]+$/.test(flags)) return res.status(400).json({ error: 'Geçersiz yetki veya giriş bayrağı.' });

        const usersIniPath = 'addons/amxmodx/configs/users.ini';
        let originalContent = '';
        if (await cFs.fileExists(container, usersIniPath)) {
            originalContent = await cFs.readFile(container, usersIniPath);
        }

        // Format line
        const exists = originalContent.split(/\r?\n/).some(line => {
            const m = line.trim().match(/^"([^"]*)"/);
            return m && m[1] === auth;
        });
        if (exists) return res.status(409).json({ error: 'Bu yetkili zaten users.ini içinde kayıtlı.' });
        const adminLine = `"${auth}" "${password}" "${access}" "${flags}" ; ${comment || 'Panel üzerinden eklendi'}`;
        const separator = originalContent && !originalContent.endsWith('\n') ? '\n' : '';
        await cFs.writeFile(container, usersIniPath, `${originalContent}${separator}${adminLine}\n`);

        // Reload admins in-game if running
        if (inspect.State.Running) {
            let port = null;
            const portBindings = inspect.HostConfig.PortBindings;
            for (const key in portBindings) {
                if (key.endsWith('/udp')) {
                    port = portBindings[key][0].HostPort;
                    break;
                }
            }
            const rconPassword = req.serverRecord.rcon_password || '';

            if (port) {
                const ip = queryHelper.getServerIp(inspect);
                await queryHelper.sendRconCommand(ip, port, rconPassword, 'amx_reloadadmins');
            }
        }

        res.json({ success: true, message: 'Admin added successfully' });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// POST /api/admins/:id/delete - Delete admin
router.post('/:id/delete', async (req, res) => {
    try {
        const container = req.docker.getContainer(req.params.id);
        const inspect = await container.inspect();
        const { auth } = req.body;

        if (!auth) return res.status(400).json({ error: 'auth is required' });

        const usersIniPath = 'addons/amxmodx/configs/users.ini';
        if (!(await cFs.fileExists(container, usersIniPath))) {
            return res.status(404).json({ error: 'users.ini not found' });
        }

        const content = await cFs.readFile(container, usersIniPath);
        const lines = content.split('\n');

        const newLines = lines.filter(line => {
            const trimmed = line.trim();
            if (trimmed.startsWith(';')) return true;
            
            const matches = trimmed.match(/"([^"]*)"/g);
            if (matches && matches.length >= 3) {
                const lineAuth = matches[0].replace(/"/g, '');
                if (lineAuth === auth) {
                    return false;
                }
            }
            return true;
        });

        await cFs.writeFile(container, usersIniPath, newLines.join('\n'));

        // Reload admins in-game if running
        if (inspect.State.Running) {
            let port = null;
            const portBindings = inspect.HostConfig.PortBindings;
            for (const key in portBindings) {
                if (key.endsWith('/udp')) {
                    port = portBindings[key][0].HostPort;
                    break;
                }
            }
            const rconPassword = req.serverRecord.rcon_password || '';

            if (port) {
                const ip = queryHelper.getServerIp(inspect);
                await queryHelper.sendRconCommand(ip, port, rconPassword, 'amx_reloadadmins');
            }
        }

        res.json({ success: true, message: 'Admin deleted successfully' });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// POST /api/admins/:id/ban - Ban a player
router.post('/:id/ban', async (req, res) => {
    try {
        const isIp = req.body.isIp === true || req.body.isIp === 'true';
        const target = banTarget(req.body.target, isIp);
        const duration = Math.max(0, Math.min(525600, parseInt(req.body.duration, 10) || 0));

        const container = req.docker.getContainer(req.params.id);
        const inspect = await container.inspect();

        if (!inspect.State.Running) {
            return res.status(400).json({ error: 'Server must be running to execute ban' });
        }

        let port = null;
        const portBindings = inspect.HostConfig.PortBindings;
        for (const key in portBindings) {
            if (key.endsWith('/udp')) {
                port = portBindings[key][0].HostPort;
                break;
            }
        }
        const rconPassword = req.serverRecord.rcon_password || '';

        if (!port) return res.status(400).json({ error: 'Server port mapping not found' });

        const time = duration;
        let rconCmd = '';
        
        if (isIp) {
            rconCmd = `addip ${time} ${target}; writeip`;
        } else {
            rconCmd = `banid ${time} ${target}; writeid`;
        }

        const ip = queryHelper.getServerIp(inspect);
        const response = await queryHelper.sendRconCommand(ip, port, rconPassword, rconCmd);
        res.json({ success: true, message: `Ban command executed`, response });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// POST /api/admins/:id/unban - Remove ban
router.post('/:id/unban', async (req, res) => {
    try {
        const isIp = req.body.isIp === true || req.body.isIp === 'true';
        const target = banTarget(req.body.target, isIp);

        const container = req.docker.getContainer(req.params.id);
        const inspect = await container.inspect();

        if (!inspect.State.Running) {
            // Unban offline by directly modifying cfg file inside container!
            const banFile = isIp ? 'listip.cfg' : 'banned.cfg';
            if (await cFs.fileExists(container, banFile)) {
                let content = await cFs.readFile(container, banFile);
                let lines = content.split('\n');
                let newLines = lines.filter(l => l.trim().split(/\s+/)[2] !== target);
                await cFs.writeFile(container, banFile, newLines.join('\n'));
                return res.json({ success: true, message: `Target ${target} unbanned offline` });
            }
            return res.status(400).json({ error: 'Ban file not found' });
        }

        let port = null;
        const portBindings = inspect.HostConfig.PortBindings;
        for (const key in portBindings) {
            if (key.endsWith('/udp')) {
                port = portBindings[key][0].HostPort;
                break;
            }
        }
        const rconPassword = req.serverRecord.rcon_password || '';

        let rconCmd = '';
        if (isIp) {
            rconCmd = `removeip ${target}; writeip`;
        } else {
            rconCmd = `removeid ${target}; writeid`;
        }

        const ip = queryHelper.getServerIp(inspect);
        const response = await queryHelper.sendRconCommand(ip, port, rconPassword, rconCmd);
        res.json({ success: true, message: `Unban command executed`, response });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

module.exports = router;

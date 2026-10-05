const express = require('express');
const router = express.Router();
const queryHelper = require('../queryHelper');
const cFs = require('../containerFsHelper');

router.use('/:id', async (req, res, next) => {
    try {
        req.serverRecord = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        next();
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// Helper to get server port and RCON password
async function getServerConnectionDetails(docker, containerId, serverRecord) {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    
    if (!info.State.Running) {
        throw Object.assign(new Error('Sunucu kapalı.'), { statusCode: 409 });
    }

    let port = null;
    const portBindings = info.HostConfig.PortBindings;
    for (const key in portBindings) {
        if (key.endsWith('/udp')) {
            port = parseInt(portBindings[key][0].HostPort);
            break;
        }
    }

    if (!port) {
        throw new Error('Server port mapping not found');
    }

    const rconPassword = (serverRecord && serverRecord.rcon_password) || '';
    const ip = queryHelper.getServerIp(info);

    return { ip, port, rconPassword };
}

// GET /api/players/:id - Get online players list
router.get('/:id', async (req, res) => {
    try {
        const { ip, port } = await getServerConnectionDetails(req.docker, req.params.id, req.serverRecord);
        const players = await queryHelper.getPlayersList(ip, port);
        res.json({ players });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// POST /api/players/:id/action - Player action (kick, ban, slap, slay)
router.post('/:id/action', async (req, res) => {
    try {
        const { action } = req.body;
        // Player names come from the game and are attacker-controlled; strip
        // everything that could terminate the quoted RCON argument.
        const clean = value => String(value || '').replace(/["\r\n;\\]/g, '').trim().slice(0, 64);
        const name = clean(req.body.name);
        const reason = clean(req.body.reason).slice(0, 100);
        const duration = Math.max(0, Math.min(525600, parseInt(req.body.duration, 10) || 0));
        if (!action || !name) {
            return res.status(400).json({ error: 'İşlem ve oyuncu adı zorunludur.' });
        }

        const { ip, port, rconPassword } = await getServerConnectionDetails(req.docker, req.params.id, req.serverRecord);

        let command = '';
        switch (action.toLowerCase()) {
            case 'kick':
                command = `amx_kick "${name}" "${reason || 'Kicked by admin'}"`;
                break;
            case 'slap':
                command = `amx_slap "${name}" 5`; // 5 damage slap
                break;
            case 'slay':
                command = `amx_slay "${name}"`;
                break;
            case 'ban':
                command = `amx_ban "${name}" ${duration} "${reason || 'Banned by admin'}"`;
                break;
            default:
                return res.status(400).json({ error: `Invalid action: ${action}` });
        }

        const response = await queryHelper.sendRconCommand(ip, port, rconPassword, command);

        res.json({ success: true, message: `Command executed: ${command}`, response });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// GET /api/players/:id/stats - SQL based stats / leaderboard
router.get('/:id/stats', async (req, res) => {
    try {
        const record = req.serverRecord;
        if (!record || !record.db_name) {
            return res.json({ success: true, enabled: false, message: 'MySQL is not configured/enabled for this server.' });
        }

        const mysql = require('mysql2/promise');
        const host = process.env.MYSQL_HOST || 'cs-mysql';
        const cfg = require('../config');

        let connection;
        try {
            connection = await mysql.createConnection({
                host: host,
                port: parseInt(process.env.MYSQL_PORT || '3306', 10),
                user: record.db_username,
                password: record.db_password,
                database: record.db_name,
                connectTimeout: 4000
            });

            // Check which tables are present
            const [tablesCsstats] = await connection.query("SHOW TABLES LIKE 'csstats'");
            const [tablesAmxStats] = await connection.query("SHOW TABLES LIKE 'amx_stats'");
            const [tablesCsstatsPlayers] = await connection.query("SHOW TABLES LIKE 'csstats_players'");

            let tableName = '';
            if (tablesCsstats.length > 0) tableName = 'csstats';
            else if (tablesAmxStats.length > 0) tableName = 'amx_stats';
            else if (tablesCsstatsPlayers.length > 0) tableName = 'csstats_players';

            if (!tableName) {
                // Table doesn't exist yet, return configuration instructions for amxmodx
                return res.json({
                    success: true,
                    enabled: false,
                    message: 'Leaderboard SQL table csstats/amx_stats not found. Ensure "csstats_mysql" or "statsx_sql" plugin is enabled in AMXX.',
                    dbInfo: {
                        host: cfg.mysql.internalHost,
                        port: cfg.mysql.internalPort,
                        database: record.db_name,
                        username: record.db_username,
                        password: record.db_password
                    }
                });
            }

            let query = '';
            if (tableName === 'csstats' || tableName === 'amx_stats') {
                query = `SELECT name, kills, deaths, hs, shots, hits, damage FROM ${tableName} ORDER BY kills DESC LIMIT 100`;
            } else {
                // fallback basic structure
                query = `SELECT name, kills, deaths, hs FROM ${tableName} ORDER BY kills DESC LIMIT 100`;
            }

            const [rows] = await connection.query(query);

            res.json({
                success: true,
                enabled: true,
                tableName,
                stats: rows.map((r, index) => ({
                    rank: index + 1,
                    name: r.name,
                    kills: r.kills || 0,
                    deaths: r.deaths || 0,
                    hs: r.hs || 0,
                    shots: r.shots || 0,
                    hits: r.hits || 0,
                    damage: r.damage || 0,
                    kd: r.deaths > 0 ? (r.kills / r.deaths).toFixed(2) : r.kills,
                    accuracy: r.shots > 0 ? ((r.hits / r.shots) * 100).toFixed(1) + '%' : '0%'
                }))
            });
        } catch (dbErr) {
            res.json({ success: true, enabled: false, message: `Veritabanına bağlanılamadı: ${dbErr.message}` });
        } finally {
            if (connection) await connection.end();
        }
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// GET /api/players/:id/history - Get player connection history (Last 50)
router.get('/:id/history', async (req, res) => {
    try {
        const record = req.serverRecord;
        const container = req.docker.getContainer(req.params.id);
        
        let connectionHistory = [];
        let fetchedFromDb = false;

        // Option 1: Try database bhop_players table if configured
        if (record && record.db_name) {
            const mysql = require('mysql2/promise');
            const host = process.env.MYSQL_HOST || 'cs-mysql';
            let connection;
            try {
                connection = await mysql.createConnection({
                    host: host,
                    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
                    user: record.db_username,
                    password: record.db_password,
                    database: record.db_name,
                    connectTimeout: 3000
                });

                // Check if bhop_players table is present
                const [tables] = await connection.query("SHOW TABLES LIKE 'bhop_players'");
                if (tables.length > 0) {
                    const [rows] = await connection.query(
                        `SELECT name, authid, updated_at FROM bhop_players ORDER BY updated_at DESC LIMIT 50`
                    );
                    connectionHistory = rows.map(r => ({
                        name: r.name,
                        steamid: r.authid || 'N/A',
                        lastSeen: (() => {
                            const value = typeof r.updated_at === 'number' ? new Date(r.updated_at * 1000) : new Date(r.updated_at);
                            return isNaN(value.getTime()) ? '-' : value.toISOString().replace('T', ' ').slice(0, 19);
                        })()
                    }));
                    fetchedFromDb = true;
                }
            } catch (dbErr) {
                console.log('Failed to fetch history from database:', dbErr.message);
            } finally {
                if (connection) await connection.end();
            }
        }

        // Option 2: Fallback to reading server logs if not fetched from DB or empty
        if (!fetchedFromDb || connectionHistory.length === 0) {
            try {
                const logsPath = 'logs';
                if (await cFs.fileExists(container, logsPath)) {
                    const files = await cFs.listFiles(container, logsPath);
                    const logFiles = files
                        .filter(f => f.name.endsWith('.log'))
                        .sort((a, b) => b.name.localeCompare(a.name));
                    
                    if (logFiles.length > 0) {
                        // Read the latest log file
                        const latestLogContent = await cFs.readFile(container, `logs/${logFiles[0].name}`);
                        const lines = latestLogContent.split('\n');
                        
                        // Parse backwards to get newest connections first
                        for (let i = lines.length - 1; i >= 0; i--) {
                            const line = lines[i];
                            // Match pattern: L 07/13/2026 - 15:45:20: "PlayerName<1><STEAM_0:1:1702411><>" connected
                            const match = line.match(/L (\d{2}\/\d{2}\/\d{4}) - (\d{2}:\d{2}:\d{2}): "([^<]+)<[^>]+><([^>]+)><[^>]*>" connected/);
                            if (match) {
                                const date = match[1];
                                const time = match[2];
                                const name = match[3];
                                const steamid = match[4];
                                
                                // Avoid duplicates
                                if (!connectionHistory.some(c => c.steamid === steamid)) {
                                    // Convert date to YYYY-MM-DD
                                    const parts = date.split('/');
                                    const formattedDate = parts.length === 3 ? `${parts[2]}-${parts[0]}-${parts[1]}` : date;
                                    connectionHistory.push({
                                        name,
                                        steamid,
                                        lastSeen: `${formattedDate} ${time}`
                                    });
                                    if (connectionHistory.length >= 50) break;
                                }
                            }
                        }
                    }
                }
            } catch (logsErr) {
                console.log('Failed to fetch history from logs:', logsErr.message);
            }
        }

        res.json({
            success: true,
            enabled: connectionHistory.length > 0,
            history: connectionHistory
        });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

module.exports = router;

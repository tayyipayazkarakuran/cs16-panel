const express = require('express');
const router  = express.Router();
const mysql   = require('mysql2/promise');

const MYSQL_CONFIG = {
    host:     process.env.MYSQL_HOST     || '127.0.0.1',
    port:     parseInt(process.env.MYSQL_PORT || '3306'),
    user:     'root',
    password: process.env.MYSQL_ROOT_PASSWORD || 'cs_root_2024',
    connectTimeout: 10000
};

async function getConn(database) {
    const cfg = { ...MYSQL_CONFIG };
    if (database) cfg.database = database;
    return mysql.createConnection(cfg);
}

function routeError(res, e) {
    res.status(e.statusCode || 500).json({ error: e.message });
}

function requireAdmin(req) {
    if (!req.user || req.user.role !== 'admin') {
        const err = new Error('Admin access required');
        err.statusCode = 403;
        throw err;
    }
}

async function getScopedConn(req, database) {
    if (req.user.role === 'admin') return getConn(database);
    const resources = await req.panelDb.listSqlResourcesForUser(req.user);
    const resource = resources.find(r => r.database === database);
    if (!resource) {
        const err = new Error('Access denied for this database');
        err.statusCode = 403;
        throw err;
    }
    return mysql.createConnection({
        host: MYSQL_CONFIG.host,
        port: MYSQL_CONFIG.port,
        user: resource.username,
        password: resource.password,
        database,
        connectTimeout: MYSQL_CONFIG.connectTimeout
    });
}

// GET /api/mysql/status – ping MySQL, return version
router.get('/status', async (req, res) => {
    try {
        const conn = await getConn();
        const [rows] = await conn.query('SELECT VERSION() AS version, NOW() AS time');
        await conn.end();
        res.json({ online: true, version: rows[0].version, time: rows[0].time, host: MYSQL_CONFIG.host, port: MYSQL_CONFIG.port });
    } catch (e) {
        res.json({ online: false, error: e.message });
    }
});

// GET /api/mysql/databases – list all databases
router.get('/resources', async (req, res) => {
    try {
        const resources = await req.panelDb.listSqlResourcesForUser(req.user);
        res.json({ resources });
    } catch (e) {
        routeError(res, e);
    }
});

router.post('/resources/:id/rotate-password', async (req, res) => {
    try {
        await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const record = await req.panelDb.rotateSqlPassword(req.params.id);
        res.json({
            success: true,
            resource: {
                serverId: record.container_id,
                serverName: record.name,
                port: record.port,
                database: record.db_name,
                username: record.db_username,
                password: record.db_password,
                host: MYSQL_CONFIG.host,
                mysqlPort: MYSQL_CONFIG.port
            }
        });
    } catch (e) {
        routeError(res, e);
    }
});

router.get('/databases', async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            const resources = await req.panelDb.listSqlResourcesForUser(req.user);
            return res.json({
                databases: resources.map(r => ({
                    name: r.database,
                    system: false,
                    serverId: r.serverId,
                    port: r.port
                }))
            });
        }

        const conn = await getConn();
        const [rows] = await conn.query("SHOW DATABASES");
        await conn.end();
        const system = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
        const dbs = rows.map(r => r.Database).map(name => ({ name, system: system.has(name) }));
        res.json({ databases: dbs });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/mysql/databases – create database
router.post('/databases', async (req, res) => {
    try {
        requireAdmin(req);
        const { name } = req.body;
        if (!name || !/^[a-zA-Z0-9_]+$/.test(name)) {
            return res.status(400).json({ error: 'Invalid database name (alphanumeric + underscore only)' });
        }
        const conn = await getConn();
        await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await conn.end();
        res.json({ success: true, message: `Database "${name}" created.` });
    } catch (e) {
        routeError(res, e);
    }
});

// DELETE /api/mysql/databases/:name – drop database
router.delete('/databases/:name', async (req, res) => {
    try {
        requireAdmin(req);
        const name = req.params.name;
        const system = ['information_schema', 'performance_schema', 'mysql', 'sys'];
        if (system.includes(name)) return res.status(403).json({ error: 'Cannot drop system database' });
        if (!/^[a-zA-Z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid name' });

        const conn = await getConn();
        await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
        await conn.end();
        res.json({ success: true, message: `Database "${name}" dropped.` });
    } catch (e) {
        routeError(res, e);
    }
});

// GET /api/mysql/users – list MySQL users (excluding root system entries)
router.get('/users', async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            const resources = await req.panelDb.listSqlResourcesForUser(req.user);
            return res.json({
                users: resources.map(r => ({
                    user: r.username,
                    host: '%',
                    serverId: r.serverId,
                    port: r.port
                }))
            });
        }

        const conn = await getConn();
        const [rows] = await conn.query("SELECT User, Host FROM mysql.user ORDER BY User");
        await conn.end();
        res.json({ users: rows.map(r => ({ user: r.User, host: r.Host })) });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/mysql/users – create user with optional database grant
router.post('/users', async (req, res) => {
    try {
        requireAdmin(req);
        const { username, password, database, host = '%' } = req.body;
        if (!username || !/^[a-zA-Z0-9_]+$/.test(username)) {
            return res.status(400).json({ error: 'Invalid username' });
        }
        if (!password || password.length < 4) {
            return res.status(400).json({ error: 'Password must be at least 4 characters' });
        }

        const conn = await getConn();

        // Create user
        await conn.query(`CREATE USER IF NOT EXISTS '${username}'@'${host}' IDENTIFIED BY ?`, [password]);

        // Grant privileges if database specified
        if (database && /^[a-zA-Z0-9_]+$/.test(database)) {
            await conn.query(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${username}'@'${host}'`);
            await conn.query('FLUSH PRIVILEGES');
        }

        await conn.end();
        res.json({ success: true, message: `User "${username}"@"${host}" created${database ? ` with access to "${database}"` : ''}.` });
    } catch (e) {
        routeError(res, e);
    }
});

// DELETE /api/mysql/users – drop user
router.delete('/users', async (req, res) => {
    try {
        requireAdmin(req);
        const { username, host = '%' } = req.body;
        if (!username) return res.status(400).json({ error: 'Missing username' });
        if (username === 'root') return res.status(403).json({ error: 'Cannot drop root user' });

        const conn = await getConn();
        await conn.query(`DROP USER IF EXISTS '${username}'@'${host}'`);
        await conn.query('FLUSH PRIVILEGES');
        await conn.end();
        res.json({ success: true, message: `User "${username}"@"${host}" dropped.` });
    } catch (e) {
        routeError(res, e);
    }
});

// GET /api/mysql/databases/:name/tables – list tables in a database
router.get('/databases/:name/tables', async (req, res) => {
    try {
        const name = req.params.name;
        if (!/^[a-zA-Z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
        if (!(await req.panelDb.canAccessDatabase(req.user, name))) {
            return res.status(403).json({ error: 'Access denied for this database' });
        }

        const conn = await getScopedConn(req, name);
        const [rows] = await conn.query('SHOW TABLE STATUS');
        await conn.end();
        res.json({
            database: name,
            tables: rows.map(r => ({
                name:    r.Name,
                engine:  r.Engine,
                rows:    r.Rows,
                size:    (r.Data_length || 0) + (r.Index_length || 0),
                updated: r.Update_time
            }))
        });
    } catch (e) {
        routeError(res, e);
    }
});

// GET /api/mysql/databases/:name/tables/:table/data – browse a table's rows
router.get('/databases/:name/tables/:table/data', async (req, res) => {
    try {
        const name = req.params.name;
        const table = req.params.table;
        if (!/^[a-zA-Z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid database name' });
        if (!/^[a-zA-Z0-9_]+$/.test(table)) return res.status(400).json({ error: 'Invalid table name' });
        if (!(await req.panelDb.canAccessDatabase(req.user, name))) {
            return res.status(403).json({ error: 'Access denied for this database' });
        }

        const limit  = Math.min(parseInt(req.query.limit) || 100, 1000);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);

        const conn = await getScopedConn(req, name);
        const [rows, fields] = await conn.query(`SELECT * FROM \`${table}\` LIMIT ? OFFSET ?`, [limit, offset]);
        const [countRows] = await conn.query(`SELECT COUNT(*) AS total FROM \`${table}\``);
        await conn.end();

        res.json({
            database: name,
            table,
            columns: fields.map(f => f.name),
            rows,
            total: countRows[0].total,
            limit,
            offset
        });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/mysql/query – run a raw SQL query (SELECT only for safety)
router.post('/query', async (req, res) => {
    try {
        let { database, sql } = req.body;
        if (!sql) return res.status(400).json({ error: 'Missing sql' });

        if (!database && req.user.role !== 'admin') {
            const resources = await req.panelDb.listSqlResourcesForUser(req.user);
            if (resources.length === 1) database = resources[0].database;
        }
        if (!(await req.panelDb.canAccessDatabase(req.user, database || null))) {
            return res.status(403).json({ error: 'Access denied for this database' });
        }

        // Basic safety: only allow SELECT
        const trimmed = sql.trim().toUpperCase();
        if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('SHOW') && !trimmed.startsWith('DESCRIBE') && !trimmed.startsWith('EXPLAIN')) {
            return res.status(403).json({ error: 'Only SELECT, SHOW, DESCRIBE, EXPLAIN queries are allowed via this endpoint.' });
        }

        const conn = await getScopedConn(req, database || null);
        const [rows, fields] = await conn.query(sql);
        await conn.end();

        res.json({
            success: true,
            columns: fields ? fields.map(f => f.name) : [],
            rows: rows.slice(0, 500) // limit result set
        });
    } catch (e) {
        routeError(res, e);
    }
});

module.exports = router;

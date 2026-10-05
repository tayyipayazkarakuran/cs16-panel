const express = require('express');
const mysql = require('mysql2/promise');
const cfg = require('../config');
const gameContainer = require('../gameContainer');
const phpSite = require('../phpSiteService');
const security = require('../security');

const router = express.Router();

const SYSTEM_DATABASES = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
const PANEL_DB_NAME = process.env.PANEL_DB_NAME || 'cs_panel';
const NAME_RE = /^[a-zA-Z0-9_]{1,64}$/;
const HOST_RE = /^(%|localhost|[a-zA-Z0-9.%_-]{1,60})$/;

function httpError(status, message) {
    const err = new Error(message);
    err.statusCode = status;
    return err;
}

function routeError(res, e) {
    const status = e.statusCode || (e.sqlMessage ? 400 : 500);
    res.status(status).json({ error: e.sqlMessage || e.message });
}

function requireAdmin(req) {
    if (!req.user || req.user.role !== 'admin') throw httpError(403, 'Admin access required');
}

function rootConnection(database = null) {
    return mysql.createConnection({
        host: cfg.mysql.host,
        port: cfg.mysql.port,
        user: 'root',
        password: cfg.mysql.rootPassword,
        database: database || undefined,
        connectTimeout: 10000,
        dateStrings: true
    });
}

/** Admins use root; customers connect with their own server credentials. */
async function scopedConnection(req, database) {
    if (req.user.role === 'admin') return rootConnection(database);
    const resources = await req.panelDb.listSqlResourcesForUser(req.user);
    const resource = resources.find(r => r.database === database);
    if (!resource) throw httpError(403, 'Bu veritabanına erişim yetkiniz yok.');
    return mysql.createConnection({
        host: cfg.mysql.host,
        port: cfg.mysql.port,
        user: resource.username,
        password: resource.password,
        database,
        connectTimeout: 10000,
        dateStrings: true
    });
}

async function withConnection(factory, fn) {
    const conn = await factory();
    try {
        return await fn(conn);
    } finally {
        await conn.end().catch(() => {});
    }
}

/** After credentials change, push them to the game server and the PHP site. */
async function propagateCredentials(req, record) {
    try {
        const container = req.docker.getContainer(record.container_id);
        const info = await container.inspect();
        if (info.State.Running) await gameContainer.ensureSqlCfg(container, record);
    } catch (_) { /* server offline: sql.cfg is rewritten on next provisioning */ }
    try { phpSite.writeSiteConfig(record); } catch (_) { /* site may not exist yet */ }
}

router.get('/status', async (req, res) => {
    try {
        const endpoints = cfg.mysqlEndpoints();
        const row = await withConnection(() => rootConnection(), async conn => {
            const [rows] = await conn.query('SELECT VERSION() AS version');
            return rows[0];
        });
        res.json({
            online: true,
            version: row.version,
            internal: endpoints.internal,
            external: endpoints.external,
            host: req.user.role === 'admin' ? `${cfg.mysql.host}:${cfg.mysql.port}` : undefined
        });
    } catch (e) {
        res.json({ online: false, error: req.user.role === 'admin' ? e.message : 'MySQL sunucusuna ulaşılamıyor.' });
    }
});

router.get('/resources', async (req, res) => {
    try {
        res.json({ resources: await req.panelDb.listSqlResourcesForUser(req.user) });
    } catch (e) {
        routeError(res, e);
    }
});

router.post('/resources/:id/rotate-password', async (req, res) => {
    try {
        await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const record = await req.panelDb.rotateSqlPassword(req.params.id);
        await propagateCredentials(req, record);
        await req.panelDb.logAudit({ actorId: req.user.id, actorName: req.user.username, action: 'mysql.rotate', targetType: 'server', targetId: record.port, ip: security.clientIp(req) });
        res.json({ success: true, resource: req.panelDb.sqlResourceFromRecord(record) });
    } catch (e) {
        routeError(res, e);
    }
});

// Re-creates the database/user with the stored password and rewrites sql.cfg.
router.post('/resources/:id/repair', async (req, res) => {
    try {
        const record = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        const updated = await req.panelDb.provisionSqlForRecord(record);
        await propagateCredentials(req, updated);
        res.json({ success: true, message: 'Veritabanı hesabı doğrulandı; sunucu ve web sitesi yapılandırması güncellendi.' });
    } catch (e) {
        routeError(res, e);
    }
});

router.get('/databases', async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            const resources = await req.panelDb.listSqlResourcesForUser(req.user);
            return res.json({ databases: resources.map(r => ({ name: r.database, system: false, serverId: r.serverId, port: r.port })) });
        }
        const rows = await withConnection(() => rootConnection(), async conn => {
            const [result] = await conn.query(`
                SELECT s.SCHEMA_NAME AS name,
                       COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS size,
                       COUNT(t.TABLE_NAME) AS tables
                FROM information_schema.SCHEMATA s
                LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
                GROUP BY s.SCHEMA_NAME ORDER BY s.SCHEMA_NAME`);
            return result;
        });
        res.json({
            databases: rows.map(r => ({
                name: r.name, size: Number(r.size), tables: Number(r.tables),
                system: SYSTEM_DATABASES.has(r.name) || r.name === PANEL_DB_NAME
            }))
        });
    } catch (e) {
        routeError(res, e);
    }
});

router.post('/databases', async (req, res) => {
    try {
        requireAdmin(req);
        const name = String((req.body && req.body.name) || '');
        if (!NAME_RE.test(name)) throw httpError(400, 'Geçersiz veritabanı adı (harf, rakam, alt çizgi).');
        await withConnection(() => rootConnection(), conn =>
            conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`));
        res.json({ success: true, message: `"${name}" veritabanı oluşturuldu.` });
    } catch (e) {
        routeError(res, e);
    }
});

router.delete('/databases/:name', async (req, res) => {
    try {
        requireAdmin(req);
        const name = req.params.name;
        if (!NAME_RE.test(name)) throw httpError(400, 'Geçersiz ad');
        if (SYSTEM_DATABASES.has(name) || name === PANEL_DB_NAME) throw httpError(403, 'Sistem veritabanı silinemez.');
        const [used] = await req.panelDb.assertPool().query('SELECT port FROM panel_servers WHERE db_name = ? LIMIT 1', [name]);
        if (used[0]) throw httpError(409, `Bu veritabanı ${used[0].port} portlu sunucuya atanmış. Önce sunucuyu silin.`);
        await withConnection(() => rootConnection(), conn => conn.query(`DROP DATABASE IF EXISTS \`${name}\``));
        await req.panelDb.logAudit({ actorId: req.user.id, actorName: req.user.username, action: 'mysql.drop_database', targetType: 'database', targetId: name, ip: security.clientIp(req) });
        res.json({ success: true, message: `"${name}" silindi.` });
    } catch (e) {
        routeError(res, e);
    }
});

router.get('/users', async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            const resources = await req.panelDb.listSqlResourcesForUser(req.user);
            return res.json({ users: resources.map(r => ({ user: r.username, host: '%', serverId: r.serverId, port: r.port })) });
        }
        const rows = await withConnection(() => rootConnection(), async conn => {
            const [result] = await conn.query('SELECT User, Host FROM mysql.user ORDER BY User');
            return result;
        });
        res.json({ users: rows.map(r => ({ user: r.User, host: r.Host })) });
    } catch (e) {
        routeError(res, e);
    }
});

router.post('/users', async (req, res) => {
    try {
        requireAdmin(req);
        const { username, password, database } = req.body || {};
        const host = (req.body && req.body.host) || '%';
        if (!NAME_RE.test(String(username || '')) || username.length > 32) throw httpError(400, 'Geçersiz kullanıcı adı');
        if (!HOST_RE.test(host)) throw httpError(400, 'Geçersiz host');
        if (!password || String(password).length < 8) throw httpError(400, 'Şifre en az 8 karakter olmalı');
        if (database && !NAME_RE.test(database)) throw httpError(400, 'Geçersiz veritabanı adı');
        await withConnection(() => rootConnection(), async conn => {
            await conn.query(`CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?`, [username, host, String(password)]);
            if (database) await conn.query(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO ?@?`, [username, host]);
            await conn.query('FLUSH PRIVILEGES');
        });
        res.json({ success: true, message: `"${username}"@"${host}" oluşturuldu.` });
    } catch (e) {
        routeError(res, e);
    }
});

router.delete('/users', async (req, res) => {
    try {
        requireAdmin(req);
        const { username } = req.body || {};
        const host = (req.body && req.body.host) || '%';
        if (!username || !/^[a-zA-Z0-9_.-]{1,32}$/.test(username)) throw httpError(400, 'Geçersiz kullanıcı adı');
        if (!HOST_RE.test(host)) throw httpError(400, 'Geçersiz host');
        if (['root', 'mysql.sys', 'mysql.session', 'mysql.infoschema'].includes(username)) throw httpError(403, 'Sistem kullanıcısı silinemez');
        await withConnection(() => rootConnection(), async conn => {
            await conn.query('DROP USER IF EXISTS ?@?', [username, host]);
            await conn.query('FLUSH PRIVILEGES');
        });
        res.json({ success: true, message: `"${username}"@"${host}" silindi.` });
    } catch (e) {
        routeError(res, e);
    }
});

async function assertDbAccess(req, name) {
    if (!NAME_RE.test(name)) throw httpError(400, 'Geçersiz veritabanı adı');
    if (!(await req.panelDb.canAccessDatabase(req.user, name))) throw httpError(403, 'Bu veritabanına erişim yetkiniz yok.');
}

router.get('/databases/:name/tables', async (req, res) => {
    try {
        const name = req.params.name;
        await assertDbAccess(req, name);
        const rows = await withConnection(() => scopedConnection(req, name), async conn => {
            const [result] = await conn.query('SHOW TABLE STATUS');
            return result;
        });
        res.json({
            database: name,
            tables: rows.map(r => ({
                name: r.Name, engine: r.Engine, rows: r.Rows,
                size: Number(r.Data_length || 0) + Number(r.Index_length || 0), updated: r.Update_time
            }))
        });
    } catch (e) {
        routeError(res, e);
    }
});

router.get('/databases/:name/tables/:table/data', async (req, res) => {
    try {
        const { name, table } = req.params;
        await assertDbAccess(req, name);
        if (!NAME_RE.test(table)) throw httpError(400, 'Geçersiz tablo adı');
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const result = await withConnection(() => scopedConnection(req, name), async conn => {
            const [rows, fields] = await conn.query(`SELECT * FROM \`${table}\` LIMIT ? OFFSET ?`, [limit, offset]);
            const [count] = await conn.query(`SELECT COUNT(*) AS total FROM \`${table}\``);
            return { rows, columns: fields.map(f => f.name), total: count[0].total };
        });
        res.json({ database: name, table, limit, offset, ...result });
    } catch (e) {
        routeError(res, e);
    }
});

/**
 * Run one SQL statement. Customers run it with their own MySQL account, so
 * their privileges are limited to their own database by MySQL itself;
 * multipleStatements stays disabled so a single request is a single statement.
 */
router.post('/query', security.rateLimit({ name: 'sqlquery', windowMs: 60000, max: 60, keys: req => [String(req.user.id)] }), async (req, res) => {
    try {
        let { database, sql } = req.body || {};
        sql = String(sql || '').trim();
        if (!sql) throw httpError(400, 'Sorgu boş');
        if (sql.length > 100000) throw httpError(413, 'Sorgu çok uzun');
        if (!database && req.user.role !== 'admin') {
            const resources = await req.panelDb.listSqlResourcesForUser(req.user);
            if (resources.length === 1) database = resources[0].database;
        }
        if (database) await assertDbAccess(req, database);
        else requireAdmin(req);

        const started = Date.now();
        const result = await withConnection(() => scopedConnection(req, database || null), async conn => {
            const [rows, fields] = await conn.query({ sql, timeout: 30000 });
            return { rows, fields };
        });
        const elapsedMs = Date.now() - started;
        if (Array.isArray(result.rows)) {
            const truncated = result.rows.length > 1000;
            return res.json({
                success: true,
                columns: result.fields ? result.fields.map(f => f.name) : [],
                rows: result.rows.slice(0, 1000),
                rowCount: result.rows.length,
                truncated,
                elapsedMs
            });
        }
        res.json({
            success: true,
            columns: [],
            rows: [],
            affectedRows: result.rows.affectedRows,
            insertId: result.rows.insertId,
            message: `${result.rows.affectedRows || 0} satır etkilendi.`,
            elapsedMs
        });
        await req.panelDb.logAudit({ actorId: req.user.id, actorName: req.user.username, action: 'mysql.query', targetType: 'database', targetId: database || '*', details: sql.slice(0, 500), ip: security.clientIp(req) });
    } catch (e) {
        routeError(res, e);
    }
});

/** Stream a plain SQL dump (structure + data) of one database. */
router.get('/databases/:name/export', async (req, res) => {
    const name = req.params.name;
    let conn;
    try {
        await assertDbAccess(req, name);
        conn = await scopedConnection(req, name);
        const [tables] = await conn.query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
        const tableNames = tables.map(t => Object.values(t)[0]);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        res.setHeader('Content-Type', 'application/sql; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}-${stamp}.sql"`);
        res.write(`-- CS 1.6 Panel SQL export\n-- Database: ${name}\n-- Date: ${new Date().toISOString()}\n\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n`);
        for (const table of tableNames) {
            const [create] = await conn.query(`SHOW CREATE TABLE \`${table}\``);
            res.write(`DROP TABLE IF EXISTS \`${table}\`;\n${create[0]['Create Table']};\n\n`);
            for (let offset = 0; ; offset += 500) {
                const [rows] = await conn.query(`SELECT * FROM \`${table}\` LIMIT 500 OFFSET ${offset}`);
                if (!rows.length) break;
                const columns = Object.keys(rows[0]).map(c => `\`${c}\``).join(', ');
                const values = rows.map(row => `(${Object.values(row).map(v => conn.escape(v)).join(', ')})`).join(',\n');
                res.write(`INSERT INTO \`${table}\` (${columns}) VALUES\n${values};\n`);
                if (rows.length < 500) break;
            }
            res.write('\n');
        }
        res.end('SET FOREIGN_KEY_CHECKS = 1;\n');
    } catch (e) {
        if (!res.headersSent) routeError(res, e);
        else res.end(`\n-- EXPORT FAILED: ${e.message}\n`);
    } finally {
        if (conn) await conn.end().catch(() => {});
    }
});

module.exports = router;

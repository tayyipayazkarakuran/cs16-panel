const crypto = require('crypto');
const mysql = require('mysql2/promise');

const PANEL_DB_NAME = process.env.PANEL_DB_NAME || 'cs_panel';
const TOKEN_TTL_SECONDS = parseInt(process.env.PANEL_TOKEN_TTL_SECONDS || '86400', 10);
const AUTH_HANDOFF_TTL_SECONDS = parseInt(process.env.PANEL_AUTH_HANDOFF_TTL_SECONDS || '60', 10);

const MYSQL_ROOT_CONFIG = {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: 'root',
    password: process.env.MYSQL_ROOT_PASSWORD || 'cs_root_2024',
    connectTimeout: 10000
};

let pool = null;
let initialized = false;

function getMysqlPublicConfig() {
    return {
        host: MYSQL_ROOT_CONFIG.host,
        port: MYSQL_ROOT_CONFIG.port
    };
}

function getTokenSecret() {
    return process.env.PANEL_AUTH_SECRET || `${MYSQL_ROOT_CONFIG.password}:cs-panel-dev-secret`;
}

function b64url(input) {
    return Buffer.from(input).toString('base64url');
}

function signPayload(payload) {
    return crypto.createHmac('sha256', getTokenSecret()).update(payload).digest('base64url');
}

function makeToken(user) {
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(JSON.stringify({
        sub: user.id,
        username: user.username,
        role: user.role,
        iat: now,
        exp: now + TOKEN_TTL_SECONDS
    }));
    return `${header}.${payload}.${signPayload(`${header}.${payload}`)}`;
}

function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const expected = signPayload(`${header}.${payload}`);
    const sig = Buffer.from(signature);
    const exp = Buffer.from(expected);
    if (sig.length !== exp.length || !crypto.timingSafeEqual(sig, exp)) return null;

    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
        return data;
    } catch (e) {
        return null;
    }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
    if (!password || !stored) return false;
    const [scheme, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function defaultSeedUsers() {
    return [
        {
            username: process.env.PANEL_ADMIN_USERNAME || 'admin',
            password: process.env.PANEL_ADMIN_PASSWORD || 'admin123',
            role: 'admin'
        },
        {
            username: process.env.PANEL_USER_USERNAME || 'user',
            password: process.env.PANEL_USER_PASSWORD || 'user123',
            role: 'user'
        }
    ];
}

function parseSeedUsers() {
    if (!process.env.PANEL_USERS_JSON) return defaultSeedUsers();
    try {
        const parsed = JSON.parse(process.env.PANEL_USERS_JSON);
        if (!Array.isArray(parsed)) throw new Error('PANEL_USERS_JSON must be an array');
        return parsed
            .filter(u => u && u.username && u.password && ['admin', 'user'].includes(u.role))
            .map(u => ({ username: String(u.username), password: String(u.password), role: u.role }));
    } catch (e) {
        console.log('PANEL_USERS_JSON parse failed, using defaults:', e.message);
        return defaultSeedUsers();
    }
}

function assertPool() {
    if (!pool) throw new Error('Panel database is not initialized');
    return pool;
}

function validateSqlName(name, label = 'SQL name') {
    if (!name || !/^[a-zA-Z0-9_]+$/.test(name)) {
        throw new Error(`${label} must contain only letters, numbers, and underscores`);
    }
}

function randomPassword() {
    return crypto.randomBytes(18).toString('base64url');
}

function extractServerPortFromInspect(info) {
    const bindings = info && info.HostConfig && info.HostConfig.PortBindings;
    if (!bindings) return null;
    for (const key of Object.keys(bindings)) {
        if (key.endsWith('/udp') && bindings[key] && bindings[key][0] && bindings[key][0].HostPort) {
            return parseInt(bindings[key][0].HostPort, 10);
        }
    }
    return null;
}

function getEnvValue(env, key, fallback = null) {
    const found = (env || []).find(e => e.startsWith(`${key}=`));
    return found ? found.slice(key.length + 1) : fallback;
}

function buildServerResources(port, existing = {}) {
    const phpPath = existing.php_path || `servers/${port}`;
    const host = process.env.FASTDL_HOST || '127.0.0.1';
    return {
        db_name: existing.db_name || `cs_srv_${port}`,
        db_username: existing.db_username || `csu_${port}`,
        db_password: existing.db_password || randomPassword(),
        php_path: phpPath,
        php_url: existing.php_url || `http://${host}:8081/?p=${port}`,
        fastdl_path: existing.fastdl_path || String(port),
        sv_downloadurl: existing.sv_downloadurl || `http://${host}:${process.env.FASTDL_PORT || '8080'}/${port}/`
    };
}

async function rootConnection(database = null) {
    const cfg = { ...MYSQL_ROOT_CONFIG };
    if (database) cfg.database = database;
    return mysql.createConnection(cfg);
}

async function ensureSchema() {
    const conn = await rootConnection();
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${PANEL_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.end();

    pool = mysql.createPool({
        ...MYSQL_ROOT_CONFIG,
        database: PANEL_DB_NAME,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });

    // 1. Create panel_users table if not exists
    await pool.query(`
        CREATE TABLE IF NOT EXISTS panel_users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(64) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Migrate panel_users columns if already exists
    const [userCols] = await pool.query("SHOW COLUMNS FROM panel_users");
    const userColNames = userCols.map(c => c.Field.toLowerCase());
    if (!userColNames.includes('balance')) {
        await pool.query("ALTER TABLE panel_users ADD COLUMN balance DECIMAL(10,2) NOT NULL DEFAULT 0.00");
    }
    if (!userColNames.includes('suspended')) {
        await pool.query("ALTER TABLE panel_users ADD COLUMN suspended TINYINT(1) NOT NULL DEFAULT 0");
    }

    // 2. Create panel_servers table if not exists
    await pool.query(`
        CREATE TABLE IF NOT EXISTS panel_servers (
            id INT AUTO_INCREMENT PRIMARY KEY,
            container_id VARCHAR(128) NOT NULL UNIQUE,
            port INT NOT NULL UNIQUE,
            owner_id INT NOT NULL,
            name VARCHAR(255) NULL,
            db_name VARCHAR(64) NULL,
            db_username VARCHAR(64) NULL,
            db_password VARCHAR(255) NULL,
            php_path VARCHAR(255) NULL,
            php_url VARCHAR(512) NULL,
            fastdl_path VARCHAR(255) NULL,
            sv_downloadurl VARCHAR(512) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT fk_panel_servers_owner FOREIGN KEY (owner_id)
                REFERENCES panel_users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Migrate panel_servers columns if already exists
    const [serverCols] = await pool.query("SHOW COLUMNS FROM panel_servers");
    const serverColNames = serverCols.map(c => c.Field.toLowerCase());
    if (!serverColNames.includes('plan_type')) {
        await pool.query("ALTER TABLE panel_servers ADD COLUMN plan_type ENUM('free', 'standard', 'pro') NOT NULL DEFAULT 'standard'");
    }
    if (!serverColNames.includes('expires_at')) {
        await pool.query("ALTER TABLE panel_servers ADD COLUMN expires_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
    }
    if (!serverColNames.includes('suspended')) {
        await pool.query("ALTER TABLE panel_servers ADD COLUMN suspended TINYINT(1) NOT NULL DEFAULT 0");
    }
    if (!serverColNames.includes('rcon_password')) {
        await pool.query("ALTER TABLE panel_servers ADD COLUMN rcon_password VARCHAR(255) NULL");
    }

    // 3. Create panel_payments table if not exists
    await pool.query(`
        CREATE TABLE IF NOT EXISTS panel_payments (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            amount DECIMAL(10,2) NOT NULL,
            sender_name VARCHAR(128) NOT NULL,
            receipt_path VARCHAR(512) NULL,
            status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT fk_panel_payments_user FOREIGN KEY (user_id)
                REFERENCES panel_users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 4. Create panel_settings table if not exists
    await pool.query(`
        CREATE TABLE IF NOT EXISTS panel_settings (
            \`key\` VARCHAR(64) PRIMARY KEY,
            \`value\` TEXT NULL,
            \`name\` VARCHAR(255) NULL,
            \`type\` VARCHAR(50) DEFAULT 'text',
            \`description\` TEXT NULL,
            \`options\` TEXT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Migrate panel_settings columns if already exists
    const [settingsCols] = await pool.query("SHOW COLUMNS FROM panel_settings");
    const settingsColNames = settingsCols.map(c => c.Field.toLowerCase());
    if (!settingsColNames.includes('name')) {
        await pool.query("ALTER TABLE panel_settings ADD COLUMN name VARCHAR(255) NULL");
    }
    if (!settingsColNames.includes('type')) {
        await pool.query("ALTER TABLE panel_settings ADD COLUMN type VARCHAR(50) DEFAULT 'text'");
    }
    if (!settingsColNames.includes('description')) {
        await pool.query("ALTER TABLE panel_settings ADD COLUMN description TEXT NULL");
    }
    if (!settingsColNames.includes('options')) {
        await pool.query("ALTER TABLE panel_settings ADD COLUMN options TEXT NULL");
    }

    // Short-lived, single-use login handoffs from the landing origin to panel origin.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS panel_auth_handoffs (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            code_hash CHAR(64) NOT NULL UNIQUE,
            user_id INT NOT NULL,
            created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            expires_at DATETIME(3) NOT NULL,
            used_at DATETIME(3) NULL,
            INDEX idx_panel_auth_handoffs_expiry (expires_at),
            CONSTRAINT fk_panel_auth_handoffs_user FOREIGN KEY (user_id)
                REFERENCES panel_users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Seed default settings with metadata
    const defaultSettings = [
        ['iban_details', 'TR00 0000 0000 0000 0000 0000 00 - Tayyip Yavuz', 'IBAN & Bank Details', 'textarea', 'Bank transfer details displayed on Billing tab.', null],
        ['global_free_limit', '15', 'Global Free Servers Limit', 'number', 'Max number of free servers allowed globally.', null],
        ['price_standard', '250', 'Standard Plan Price (TL)', 'number', 'Monthly price for Standard plan.', null],
        ['price_pro', '350', 'Pro Plan Price (TL)', 'number', 'Monthly price for Pro plan.', null],
        ['max_players_free', '24', 'Free Plan Max Players', 'number', 'Max player slots allowed for Free plan.', null],
        ['max_players_standard', '24', 'Standard Plan Max Players', 'number', 'Max player slots allowed for Standard plan.', null],
        ['max_players_pro', '32', 'Pro Plan Max Players', 'number', 'Max player slots allowed for Pro plan.', null]
    ];
    for (const [key, val, name, type, desc, opts] of defaultSettings) {
        await pool.query(`
            INSERT INTO panel_settings (\`key\`, \`value\`, \`name\`, \`type\`, \`description\`, \`options\`)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                \`name\` = IFNULL(\`name\`, VALUES(\`name\`)),
                \`type\` = IFNULL(\`type\`, VALUES(\`type\`)),
                \`description\` = IFNULL(\`description\`, VALUES(\`description\`)),
                \`options\` = IFNULL(\`options\`, VALUES(\`options\`))
        `, [key, val, name, type, desc, opts]);
    }
}

async function seedUsers() {
    const db = assertPool();
    const users = parseSeedUsers();
    for (const user of users) {
        if (!/^[a-zA-Z0-9_.-]{2,64}$/.test(user.username)) {
            console.log(`Skipping invalid seed user: ${user.username}`);
            continue;
        }
        await db.query(
            `INSERT INTO panel_users (username, password_hash, role)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = VALUES(role)`,
            [user.username, hashPassword(user.password), user.role]
        );
    }
}

async function getUserByUsername(username) {
    const db = assertPool();
    const [rows] = await db.query('SELECT * FROM panel_users WHERE username = ? LIMIT 1', [username]);
    return rows[0] || null;
}

async function getUserById(id) {
    const db = assertPool();
    const [rows] = await db.query('SELECT id, username, role, balance, suspended FROM panel_users WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
}

function hashAuthHandoffCode(code) {
    return crypto.createHash('sha256').update(String(code)).digest('hex');
}

async function cleanupAuthHandoffs() {
    const db = assertPool();
    await db.query(`
        DELETE FROM panel_auth_handoffs
        WHERE expires_at < NOW(3) OR (used_at IS NOT NULL AND used_at < DATE_SUB(NOW(3), INTERVAL 5 MINUTE))
    `);
}

async function createAuthHandoff(userId) {
    const db = assertPool();
    const code = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + AUTH_HANDOFF_TTL_SECONDS * 1000);

    // Keep this table small without needing a separate scheduler.
    await cleanupAuthHandoffs().catch(() => {});
    await db.query(
        'INSERT INTO panel_auth_handoffs (code_hash, user_id, expires_at) VALUES (?, ?, ?)',
        [hashAuthHandoffCode(code), userId, expiresAt]
    );
    return { code, expiresIn: AUTH_HANDOFF_TTL_SECONDS };
}

async function consumeAuthHandoff(code) {
    if (!code || typeof code !== 'string' || code.length > 256) return null;

    const db = assertPool();
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(`
            SELECT h.id, u.id AS user_id, u.username, u.role, u.balance, u.suspended
            FROM panel_auth_handoffs h
            INNER JOIN panel_users u ON u.id = h.user_id
            WHERE h.code_hash = ? AND h.used_at IS NULL AND h.expires_at >= NOW(3)
            LIMIT 1 FOR UPDATE
        `, [hashAuthHandoffCode(code)]);

        if (!rows[0] || rows[0].suspended) {
            await conn.rollback();
            return null;
        }

        const [result] = await conn.query(
            'UPDATE panel_auth_handoffs SET used_at = NOW(3) WHERE id = ? AND used_at IS NULL',
            [rows[0].id]
        );
        if (result.affectedRows !== 1) {
            await conn.rollback();
            return null;
        }

        await conn.commit();
        return {
            id: rows[0].user_id,
            username: rows[0].username,
            role: rows[0].role,
            balance: rows[0].balance,
            suspended: rows[0].suspended
        };
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
}

async function authenticate(username, password) {
    const user = await getUserByUsername(username);
    if (!user || !verifyPassword(password, user.password_hash)) return null;
    if (user.suspended) {
        throw Object.assign(new Error('This account is suspended. Please contact admin.'), { statusCode: 403 });
    }
    return { id: user.id, username: user.username, role: user.role };
}

async function createUser(username, password) {
    if (!username || !/^[a-zA-Z0-9_.\.\-]{3,64}$/.test(username)) {
        throw Object.assign(new Error('Invalid username. You can use letters, numbers, _, ., - (3-64 characters).'), { statusCode: 400 });
    }
    if (!password || password.length < 6) {
        throw Object.assign(new Error('Password must be at least 6 characters.'), { statusCode: 400 });
    }
    const db = assertPool();
    const [exists] = await db.query('SELECT id FROM panel_users WHERE username = ? LIMIT 1', [username]);
    if (exists.length > 0) {
        throw Object.assign(new Error('This username is already taken.'), { statusCode: 409 });
    }
    const [result] = await db.query(
        'INSERT INTO panel_users (username, password_hash, role) VALUES (?, ?, ?)',
        [username, hashPassword(password), 'user']
    );
    return { id: result.insertId, username, role: 'user' };
}

async function getAdminUser() {
    const db = assertPool();
    const [rows] = await db.query("SELECT id, username, role FROM panel_users WHERE role = 'admin' ORDER BY id LIMIT 1");
    if (rows[0]) return rows[0];
    throw new Error('No admin user is seeded');
}

async function getServerByContainerId(containerId) {
    const db = assertPool();
    const [rows] = await db.query(
        `SELECT s.*, u.username AS owner_username, u.role AS owner_role
         FROM panel_servers s
         JOIN panel_users u ON u.id = s.owner_id
         WHERE s.container_id = ? LIMIT 1`,
        [containerId]
    );
    return rows[0] || null;
}

async function getServerByPort(port) {
    const db = assertPool();
    const [rows] = await db.query(
        `SELECT s.*, u.username AS owner_username, u.role AS owner_role
         FROM panel_servers s
         JOIN panel_users u ON u.id = s.owner_id
         WHERE s.port = ? LIMIT 1`,
        [parseInt(port, 10)]
    );
    return rows[0] || null;
}

async function listServersForUser(user) {
    const db = assertPool();
    const sql = `
        SELECT s.*, u.username AS owner_username, u.role AS owner_role
        FROM panel_servers s
        JOIN panel_users u ON u.id = s.owner_id
        ${user.role === 'admin' ? '' : 'WHERE s.owner_id = ?'}
        ORDER BY s.port ASC
    `;
    const [rows] = await db.query(sql, user.role === 'admin' ? [] : [user.id]);
    return rows;
}

async function listUnrentedPoolServers() {
    const db = assertPool();
    const sql = `
        SELECT s.*, u.username AS owner_username, u.role AS owner_role
        FROM panel_servers s
        JOIN panel_users u ON u.id = s.owner_id
        WHERE s.owner_id = 1 AND s.port != 27015
        ORDER BY s.port ASC
    `;
    const [rows] = await db.query(sql);
    return rows;
}

async function upsertServerRecord(data) {
    const db = assertPool();
    const resources = buildServerResources(data.port, data);
    const planType = data.plan_type || 'standard';
    const expiresAt = data.expires_at || (planType === 'free' 
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) 
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

    const rconPassword = data.rcon_password || `rcon${data.port}`;

    await db.query(
        `INSERT INTO panel_servers
            (container_id, port, owner_id, name, plan_type, expires_at, db_name, db_username, db_password, php_path, php_url, fastdl_path, sv_downloadurl, rcon_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            container_id = VALUES(container_id),
            owner_id = VALUES(owner_id),
            name = VALUES(name),
            plan_type = VALUES(plan_type),
            expires_at = VALUES(expires_at),
            db_name = COALESCE(panel_servers.db_name, VALUES(db_name)),
            db_username = COALESCE(panel_servers.db_username, VALUES(db_username)),
            db_password = COALESCE(panel_servers.db_password, VALUES(db_password)),
            php_path = COALESCE(panel_servers.php_path, VALUES(php_path)),
            php_url = COALESCE(panel_servers.php_url, VALUES(php_url)),
            fastdl_path = COALESCE(panel_servers.fastdl_path, VALUES(fastdl_path)),
            sv_downloadurl = COALESCE(panel_servers.sv_downloadurl, VALUES(sv_downloadurl)),
            rcon_password = COALESCE(panel_servers.rcon_password, VALUES(rcon_password))`,
        [
            data.container_id,
            parseInt(data.port, 10),
            data.owner_id,
            data.name || `Server ${data.port}`,
            planType,
            expiresAt,
            resources.db_name,
            resources.db_username,
            resources.db_password,
            resources.php_path,
            resources.php_url,
            resources.fastdl_path,
            resources.sv_downloadurl,
            rconPassword
        ]
    );
    return getServerByContainerId(data.container_id);
}

async function updateServerContainer(containerId, fields) {
    const db = assertPool();
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(fields)) {
        sets.push(`${key} = ?`);
        params.push(value);
    }
    if (!sets.length) return getServerByContainerId(containerId);
    params.push(containerId);
    await db.query(`UPDATE panel_servers SET ${sets.join(', ')} WHERE container_id = ?`, params);
    return getServerByContainerId(containerId);
}

async function deleteServerRecord(containerId) {
    const db = assertPool();
    await db.query('DELETE FROM panel_servers WHERE container_id = ?', [containerId]);
}

function canAccessServer(user, serverRecord) {
    return !!user && !!serverRecord && (user.role === 'admin' || serverRecord.owner_id === user.id);
}

function httpError(status, message) {
    const err = new Error(message);
    err.statusCode = status;
    return err;
}

async function adoptContainer(docker, containerId, preferredOwnerId = null) {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    const port = extractServerPortFromInspect(info);
    if (!port) throw httpError(400, 'Server port mapping not found');

    let existing = await getServerByPort(port);
    if (existing) {
        if (existing.container_id !== containerId) {
            await updateServerContainer(existing.container_id, { container_id: containerId });
            existing = await getServerByContainerId(containerId);
        }
        return existing;
    }

    const admin = preferredOwnerId ? { id: preferredOwnerId } : await getAdminUser();
    const name = getEnvValue(info.Config.Env, 'SERVER_NAME', `Server ${port}`);
    const rconPassword = getEnvValue(info.Config.Env, 'RCON_PASSWORD', `rcon${port}`);
    return upsertServerRecord({
        container_id: containerId,
        port,
        owner_id: admin.id,
        name,
        rcon_password: rconPassword
    });
}

async function requireServerAccess(user, docker, containerId) {
    let record = await getServerByContainerId(containerId);
    if (!record) {
        record = await adoptContainer(docker, containerId);
    }
    if (!canAccessServer(user, record)) {
        throw httpError(403, 'Access denied for this server');
    }
    return record;
}

async function requirePortAccess(user, docker, port) {
    let record = await getServerByPort(port);
    if (!record) {
        const containers = await docker.listContainers({ all: true });
        const match = containers.find(c => c.Ports && c.Ports.some(p => p.PublicPort == port && p.Type === 'udp'));
        if (match) record = await adoptContainer(docker, match.Id);
    }
    if (!record) throw httpError(404, 'Server resource not found');
    if (!canAccessServer(user, record)) throw httpError(403, 'Access denied for this server');
    return record;
}

async function ensureSqlAccount(dbName, username, password) {
    validateSqlName(dbName, 'Database name');
    validateSqlName(username, 'Database username');

    const conn = await rootConnection();
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`CREATE USER IF NOT EXISTS '${username}'@'%' IDENTIFIED WITH mysql_native_password BY ?`, [password]);
    await conn.query(`ALTER USER '${username}'@'%' IDENTIFIED WITH mysql_native_password BY ?`, [password]);
    await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${username}'@'%'`);
    await conn.query('FLUSH PRIVILEGES');
    await conn.end();
}

async function dropSqlAccount(dbName, username) {
    const conn = await rootConnection();
    if (dbName) {
        validateSqlName(dbName, 'Database name');
        await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    }
    if (username && username !== 'root') {
        validateSqlName(username, 'Database username');
        await conn.query(`DROP USER IF EXISTS '${username}'@'%'`);
    }
    await conn.query('FLUSH PRIVILEGES');
    await conn.end();
}

async function provisionSqlForRecord(record) {
    const resources = buildServerResources(record.port, record);
    await ensureSqlAccount(resources.db_name, resources.db_username, resources.db_password);
    return updateServerContainer(record.container_id, resources);
}

async function rotateSqlPassword(containerId) {
    const record = await getServerByContainerId(containerId);
    if (!record) throw httpError(404, 'Server resource not found');
    const password = randomPassword();
    await ensureSqlAccount(record.db_name, record.db_username, password);
    return updateServerContainer(containerId, { db_password: password });
}

async function listSqlResourcesForUser(user) {
    const rows = await listServersForUser(user);
    return rows
        .filter(row => row.db_name && row.db_username)
        .map(row => ({
            serverId: row.container_id,
            serverName: row.name,
            port: row.port,
            database: row.db_name,
            username: row.db_username,
            password: row.db_password,
            host: MYSQL_ROOT_CONFIG.host,
            mysqlPort: MYSQL_ROOT_CONFIG.port,
            owner: row.owner_username
        }));
}

async function canAccessDatabase(user, database) {
    if (!database) return user.role === 'admin';
    validateSqlName(database, 'Database name');
    if (user.role === 'admin') return true;
    const db = assertPool();
    const [rows] = await db.query(
        'SELECT id FROM panel_servers WHERE owner_id = ? AND db_name = ? LIMIT 1',
        [user.id, database]
    );
    return rows.length > 0;
}

// ========================== BILLING & PAYMENTS HELPERS ==========================
async function createPaymentReport(userId, amount, senderName, receiptPath) {
    const db = assertPool();
    const [result] = await db.query(
        `INSERT INTO panel_payments (user_id, amount, sender_name, receipt_path, status) 
         VALUES (?, ?, ?, ?, 'pending')`,
        [userId, parseFloat(amount), senderName, receiptPath]
    );
    return result.insertId;
}

async function getPendingPayments() {
    const db = assertPool();
    const [rows] = await db.query(
        `SELECT p.*, u.username 
         FROM panel_payments p
         JOIN panel_users u ON u.id = p.user_id
         WHERE p.status = 'pending'
         ORDER BY p.created_at DESC`
    );
    return rows;
}

async function getUserPayments(userId) {
    const db = assertPool();
    const [rows] = await db.query(
        `SELECT * FROM panel_payments 
         WHERE user_id = ? 
         ORDER BY created_at DESC`,
        [userId]
    );
    return rows;
}

async function getPaymentByReceiptPath(receiptPath) {
    const db = assertPool();
    const [rows] = await db.query(
        `SELECT id, user_id, receipt_path
         FROM panel_payments
         WHERE receipt_path = ?
         LIMIT 1`,
        [receiptPath]
    );
    return rows[0] || null;
}

async function approvePayment(paymentId) {
    const db = assertPool();
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        
        // Fetch payment details
        const [payments] = await connection.query('SELECT * FROM panel_payments WHERE id = ? FOR UPDATE', [paymentId]);
        if (!payments || !payments.length) throw new Error('Payment not found');
        const payment = payments[0];
        
        if (payment.status !== 'pending') throw new Error('Payment is not pending');

        // Update payment status
        await connection.query('UPDATE panel_payments SET status = "approved" WHERE id = ?', [paymentId]);

        // Add to user balance
        await connection.query('UPDATE panel_users SET balance = balance + ? WHERE id = ?', [payment.amount, payment.user_id]);

        await connection.commit();
        return true;
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
}

async function rejectPayment(paymentId) {
    const db = assertPool();
    const [result] = await db.query(
        'UPDATE panel_payments SET status = "rejected" WHERE id = ? AND status = "pending"',
        [paymentId]
    );
    if (result.affectedRows === 0) throw new Error('Payment not found or not pending');
    return true;
}

async function deductUserBalance(userId, amount) {
    const db = assertPool();
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [users] = await connection.query('SELECT balance FROM panel_users WHERE id = ? FOR UPDATE', [userId]);
        if (!users || !users.length) throw new Error('User not found');
        
        const balance = parseFloat(users[0].balance);
        const reqAmount = parseFloat(amount);
        if (balance < reqAmount) {
            throw Object.assign(new Error('Yetersiz bakiye.'), { statusCode: 400 });
        }

        await connection.query('UPDATE panel_users SET balance = balance - ? WHERE id = ?', [reqAmount, userId]);
        await connection.commit();
        return true;
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
}

async function renewServerDuration(serverId, days) {
    const db = assertPool();
    const [servers] = await db.query('SELECT expires_at FROM panel_servers WHERE id = ? LIMIT 1', [serverId]);
    if (!servers || !servers.length) throw new Error('Server not found');

    const currentExpiry = new Date(servers[0].expires_at);
    // If expired, renew from NOW. Otherwise extend from current expiry.
    const baseDate = currentExpiry > new Date() ? currentExpiry : new Date();
    const newExpiry = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);

    await db.query('UPDATE panel_servers SET expires_at = ? WHERE id = ?', [newExpiry, serverId]);
    return newExpiry;
}

async function countFreeServersGlobal() {
    const db = assertPool();
    const [rows] = await db.query("SELECT COUNT(*) as count FROM panel_servers WHERE plan_type = 'free'");
    return rows[0].count;
}

async function countFreeServersForUser(userId) {
    const db = assertPool();
    const [rows] = await db.query("SELECT COUNT(*) as count FROM panel_servers WHERE owner_id = ? AND plan_type = 'free'", [userId]);
    return rows[0].count;
}

async function adoptExistingServers(docker) {
    const admin = await getAdminUser();
    const containers = await docker.listContainers({ all: true });
    const csContainers = containers.filter(c => c.Names.some(n => n.includes('cs16-server-')));
    for (const c of csContainers) {
        try {
            const record = await adoptContainer(docker, c.Id, admin.id);
            if (record && record.db_name && record.db_username && record.db_password) {
                await ensureSqlAccount(record.db_name, record.db_username, record.db_password);
            }
        } catch (e) {
            console.log(`Existing server adoption skipped for ${c.Id.slice(0, 12)}:`, e.message);
        }
    }
}

async function init(docker = null) {
    if (initialized) return;
    await ensureSchema();
    await seedUsers();
    if (docker) {
        await require('./poolService').ensurePool(docker);
    }
    initialized = true;
}

async function getSetting(key) {
    const db = assertPool();
    const [rows] = await db.query('SELECT \`value\` FROM panel_settings WHERE \`key\` = ? LIMIT 1', [key]);
    return rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
    const db = assertPool();
    await db.query(
        'INSERT INTO panel_settings (\`key\`, \`value\`) VALUES (?, ?) ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)',
        [key, String(value)]
    );
    return true;
}

async function listAllUsers() {
    const db = assertPool();
    const [rows] = await db.query(
        'SELECT id, username, role, balance, suspended, created_at FROM panel_users ORDER BY id ASC'
    );
    return rows;
}

async function updateUserAdmin(userId, fields, docker = null) {
    const db = assertPool();
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(fields)) {
        sets.push(`\`${key}\` = ?`);
        params.push(value);
    }
    if (!sets.length) return getUserById(userId);
    params.push(userId);

    await db.query(`UPDATE panel_users SET ${sets.join(', ')} WHERE id = ?`, params);

    // If suspended is set to 1, stop all the user's servers
    if (fields.suspended === 1 && docker) {
        const user = { id: userId, role: 'user' }; // mock user for authorization check
        const servers = await listServersForUser(user);
        for (const s of servers) {
            try {
                const container = docker.getContainer(s.container_id);
                await container.stop({ t: 3 }).catch(() => {});
            } catch (err) {
                console.log(`Failed to stop server during suspend: ${err.message}`);
            }
        }
    }

    return getUserById(userId);
}

async function deleteUserAdmin(userId, docker) {
    const db = assertPool();
    const user = { id: userId, role: 'user' };
    const servers = await listServersForUser(user);
    const { isProtectedPort } = require('./serverProtection');
    const protectedServer = servers.find(server => isProtectedPort(server.port));
    if (protectedServer) {
        const error = new Error(`User owns protected server port ${protectedServer.port}; user deletion was cancelled.`);
        error.statusCode = 409;
        throw error;
    }

    // Delete all containers, volumes, database schemas first
    const fastdl = require('./fastdlService');
    const path = require('path');
    const fs = require('fs');

    for (const s of servers) {
        try {
            const container = docker.getContainer(s.container_id);
            await container.stop({ t: 3 }).catch(() => {});
            await container.remove({ force: true }).catch(() => {});
        } catch (err) {
            console.log(`Failed to remove container during user deletion: ${err.message}`);
        }

        try {
            const volumeName = `cs16-server-${s.port}-cstrike`;
            const vol = docker.getVolume(volumeName);
            await vol.remove().catch(() => {});
        } catch (err) {
            console.log(`Failed to remove volume during user deletion: ${err.message}`);
        }

        try {
            if (s.db_name && s.db_username) {
                await dropSqlAccount(s.db_name, s.db_username).catch(() => {});
            }
        } catch (err) {
            console.log(`Failed to drop database during user deletion: ${err.message}`);
        }

        try {
            const localFastdlDir = fastdl.fastdlDir(s.port);
            if (fs.existsSync(localFastdlDir)) {
                fs.rmSync(localFastdlDir, { recursive: true, force: true });
            }
        } catch (err) {
            console.log(`Failed to remove FastDL during user deletion: ${err.message}`);
        }

        try {
            const localPhpDir = path.join(__dirname, 'php-data', String(s.port));
            if (fs.existsSync(localPhpDir)) {
                fs.rmSync(localPhpDir, { recursive: true, force: true });
            }
        } catch (err) {
            console.log(`Failed to remove PHP data during user deletion: ${err.message}`);
        }
    }

    // Finally delete the user (ON DELETE CASCADE will clear servers and payments records)
    await db.query('DELETE FROM panel_users WHERE id = ?', [userId]);
    return true;
}

async function listAllSettings() {
    const db = assertPool();
    const [rows] = await db.query('SELECT * FROM panel_settings ORDER BY `key` ASC');
    return rows;
}

async function createSetting(key, value, name, type, description, options) {
    const db = assertPool();
    await db.query(
        'INSERT INTO panel_settings (`key`, `value`, `name`, `type`, `description`, `options`) VALUES (?, ?, ?, ?, ?, ?)',
        [key, value, name, type, description, options]
    );
    return true;
}

async function updateSetting(key, fields) {
    const db = assertPool();
    const allowedFields = ['value', 'name', 'type', 'description', 'options'];
    const updateParts = [];
    const values = [];
    for (const field of allowedFields) {
        if (fields[field] !== undefined) {
            updateParts.push(`\`${field}\` = ?`);
            values.push(fields[field]);
        }
    }
    if (updateParts.length === 0) return false;
    values.push(key);
    await db.query(
        `UPDATE panel_settings SET ${updateParts.join(', ')} WHERE \`key\` = ?`,
        values
    );
    return true;
}

async function deleteSetting(key) {
    const db = assertPool();
    await db.query('DELETE FROM panel_settings WHERE `key` = ?', [key]);
    return true;
}

module.exports = {
    listAllSettings,
    createSetting,
    updateSetting,
    deleteSetting,
    init,
    assertPool,
    makeToken,
    verifyToken,
    createAuthHandoff,
    consumeAuthHandoff,
    cleanupAuthHandoffs,
    authenticate,
    createUser,
    getUserById,
    getAdminUser,
    getMysqlPublicConfig,
    getServerByContainerId,
    getServerByPort,
    listServersForUser,
    listUnrentedPoolServers,
    upsertServerRecord,
    updateServerContainer,
    deleteServerRecord,
    requireServerAccess,
    requirePortAccess,
    extractServerPortFromInspect,
    getEnvValue,
    buildServerResources,
    ensureSqlAccount,
    provisionSqlForRecord,
    dropSqlAccount,
    rotateSqlPassword,
    listSqlResourcesForUser,
    canAccessDatabase,
    validateSqlName,
    createPaymentReport,
    getPendingPayments,
    getUserPayments,
    getPaymentByReceiptPath,
    approvePayment,
    rejectPayment,
    deductUserBalance,
    renewServerDuration,
    countFreeServersGlobal,
    countFreeServersForUser,
    getSetting,
    setSetting,
    listAllUsers,
    updateUserAdmin,
    deleteUserAdmin
};

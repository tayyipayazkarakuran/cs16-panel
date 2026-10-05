const crypto = require('crypto');
const util = require('util');
const mysql = require('mysql2/promise');
const cfg = require('./config');

const scryptAsync = util.promisify(crypto.scrypt);

const PANEL_DB_NAME = process.env.PANEL_DB_NAME || 'cs_panel';
const TOKEN_TTL_SECONDS = parseInt(process.env.PANEL_TOKEN_TTL_SECONDS || '86400', 10);
const AUTH_HANDOFF_TTL_SECONDS = parseInt(process.env.PANEL_AUTH_HANDOFF_TTL_SECONDS || '60', 10);
const PASSWORD_RESET_TTL_SECONDS = parseInt(process.env.PANEL_PASSWORD_RESET_TTL_SECONDS || String(24 * 3600), 10);
const MAX_FAILED_LOGINS = parseInt(process.env.PANEL_MAX_FAILED_LOGINS || '8', 10);
const LOCKOUT_MINUTES = parseInt(process.env.PANEL_LOCKOUT_MINUTES || '15', 10);
// Values that shipped as public defaults must never sign production sessions.
const INSECURE_SECRETS = new Set(['', 'cs-panel-dev-secret', 'change-me', 'changeme']);

const MYSQL_ROOT_CONFIG = {
    host: cfg.mysql.host,
    port: cfg.mysql.port,
    user: 'root',
    password: cfg.mysql.rootPassword,
    connectTimeout: 10000
};

let pool = null;
let initialized = false;
let tokenSecret = null;
let poolOwnerIdCache = null;

// ============================================================================
//  Small helpers
// ============================================================================

function httpError(status, message, extra = {}) {
    const err = new Error(message);
    err.statusCode = status;
    Object.assign(err, extra);
    return err;
}

function assertPool() {
    if (!pool) throw new Error('Panel database is not initialized');
    return pool;
}

function validateSqlName(name, label = 'SQL name') {
    if (!name || !/^[a-zA-Z0-9_]{1,64}$/.test(name)) {
        throw httpError(400, `${label} must contain only letters, numbers, and underscores`);
    }
}

function randomPassword(bytes = 18) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function money(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

async function withTransaction(fn) {
    const conn = await assertPool().getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
    } catch (error) {
        try { await conn.rollback(); } catch (_) { /* connection already broken */ }
        throw error;
    } finally {
        conn.release();
    }
}

// ============================================================================
//  Tokens & passwords
// ============================================================================

function getTokenSecret() {
    if (!tokenSecret) throw new Error('Auth secret is not initialized');
    return tokenSecret;
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
        ver: Number(user.token_version || 0),
        iat: now,
        exp: now + TOKEN_TTL_SECONDS
    }));
    return `${header}.${payload}.${signPayload(`${header}.${payload}`)}`;
}

function verifyToken(token) {
    if (!token || typeof token !== 'string' || token.length > 4096) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    let expected;
    try { expected = signPayload(`${header}.${payload}`); } catch (_) { return null; }
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

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = (await scryptAsync(String(password), salt, 64)).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

async function verifyPassword(password, stored) {
    if (!password || !stored) return false;
    const [scheme, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const candidate = await scryptAsync(String(password), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function validatePasswordStrength(password) {
    const value = String(password || '');
    if (value.length < 8) throw httpError(400, 'Şifre en az 8 karakter olmalıdır.');
    if (value.length > 128) throw httpError(400, 'Şifre en fazla 128 karakter olabilir.');
    if (!/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(value) || !/\d/.test(value)) {
        throw httpError(400, 'Şifre en az bir harf ve bir rakam içermelidir.');
    }
}

function normalizeUsername(username) {
    const value = String(username || '').trim();
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(value)) {
        throw httpError(400, 'Kullanıcı adı 3-32 karakter olmalı; harf, rakam, _ . - kullanılabilir.');
    }
    return value;
}

function normalizeEmail(email, { required = true } = {}) {
    const value = String(email || '').trim().toLowerCase();
    if (!value) {
        if (required) throw httpError(400, 'E-posta adresi zorunludur.');
        return null;
    }
    if (value.length > 190 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        throw httpError(400, 'Geçerli bir e-posta adresi girin.');
    }
    return value;
}

// ============================================================================
//  Schema & migrations
// ============================================================================

async function rootConnection(database = null) {
    const options = { ...MYSQL_ROOT_CONFIG };
    if (database) options.database = database;
    return mysql.createConnection(options);
}

async function columnNames(table) {
    const [cols] = await pool.query(`SHOW COLUMNS FROM \`${table}\``);
    return new Set(cols.map(c => c.Field.toLowerCase()));
}

async function addColumnIfMissing(table, column, definition) {
    const cols = await columnNames(table);
    if (!cols.has(column.toLowerCase())) {
        await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    }
}

async function indexExists(table, indexName) {
    const [rows] = await pool.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [indexName]);
    return rows.length > 0;
}

async function ensureBaseSchema() {
    const conn = await rootConnection();
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${PANEL_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.end();

    pool = mysql.createPool({
        ...MYSQL_ROOT_CONFIG,
        database: PANEL_DB_NAME,
        waitForConnections: true,
        connectionLimit: parseInt(process.env.PANEL_DB_POOL_SIZE || '15', 10),
        queueLimit: 0,
        dateStrings: false,
        decimalNumbers: true
    });

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
    await addColumnIfMissing('panel_users', 'balance', "DECIMAL(10,2) NOT NULL DEFAULT 0.00");
    await addColumnIfMissing('panel_users', 'suspended', "TINYINT(1) NOT NULL DEFAULT 0");

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
    await addColumnIfMissing('panel_servers', 'plan_type', "VARCHAR(32) NOT NULL DEFAULT 'standard'");
    await addColumnIfMissing('panel_servers', 'expires_at', "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
    await addColumnIfMissing('panel_servers', 'suspended', "TINYINT(1) NOT NULL DEFAULT 0");
    await addColumnIfMissing('panel_servers', 'rcon_password', "VARCHAR(255) NULL");

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
    await addColumnIfMissing('panel_settings', 'name', 'VARCHAR(255) NULL');
    await addColumnIfMissing('panel_settings', 'type', "VARCHAR(50) DEFAULT 'text'");
    await addColumnIfMissing('panel_settings', 'description', 'TEXT NULL');
    await addColumnIfMissing('panel_settings', 'options', 'TEXT NULL');

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

    await pool.query(`
        CREATE TABLE IF NOT EXISTS panel_schema_migrations (
            version INT PRIMARY KEY,
            name VARCHAR(128) NOT NULL,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

// Each migration runs exactly once. They are written to be safe to re-run
// (IF NOT EXISTS / column checks) in case a previous attempt died midway.
const MIGRATIONS = [
    {
        version: 1,
        name: 'membership columns',
        async up() {
            await addColumnIfMissing('panel_users', 'email', 'VARCHAR(190) NULL');
            if (!(await indexExists('panel_users', 'uq_panel_users_email'))) {
                await pool.query('ALTER TABLE panel_users ADD UNIQUE INDEX uq_panel_users_email (email)');
            }
            await addColumnIfMissing('panel_users', 'token_version', 'INT NOT NULL DEFAULT 0');
            await addColumnIfMissing('panel_users', 'failed_logins', 'INT NOT NULL DEFAULT 0');
            await addColumnIfMissing('panel_users', 'locked_until', 'DATETIME NULL');
            await addColumnIfMissing('panel_users', 'last_login_at', 'DATETIME NULL');
            await addColumnIfMissing('panel_users', 'last_login_ip', 'VARCHAR(64) NULL');
            await addColumnIfMissing('panel_users', 'accepted_terms_at', 'DATETIME NULL');
            await addColumnIfMissing('panel_users', 'password_changed_at', 'DATETIME NULL');
            await addColumnIfMissing('panel_users', 'must_change_password', 'TINYINT(1) NOT NULL DEFAULT 0');
            await addColumnIfMissing('panel_users', 'admin_note', 'VARCHAR(500) NULL');
        }
    },
    {
        version: 2,
        name: 'server subscription columns',
        async up() {
            await pool.query("ALTER TABLE panel_servers MODIFY COLUMN plan_type VARCHAR(32) NOT NULL DEFAULT 'standard'");
            await addColumnIfMissing('panel_servers', 'is_pool', 'TINYINT(1) NOT NULL DEFAULT 0');
            await addColumnIfMissing('panel_servers', 'auto_renew', 'TINYINT(1) NOT NULL DEFAULT 0');
            await addColumnIfMissing('panel_servers', 'suspended_reason', 'VARCHAR(255) NULL');
            await addColumnIfMissing('panel_servers', 'rented_at', 'DATETIME NULL');
            await addColumnIfMissing('panel_servers', 'last_renewed_at', 'DATETIME NULL');
            await addColumnIfMissing('panel_servers', 'expiry_notice_stage', 'INT NOT NULL DEFAULT 0');
            await addColumnIfMissing('panel_servers', 'php_domain', 'VARCHAR(190) NULL');
            if (!(await indexExists('panel_servers', 'uq_panel_servers_php_domain'))) {
                await pool.query('ALTER TABLE panel_servers ADD UNIQUE INDEX uq_panel_servers_php_domain (php_domain)');
            }
            // Legacy data: unrented pool servers were simply "owned by admin".
            const { isProtectedPort } = require('./serverProtection');
            const [admins] = await pool.query("SELECT id FROM panel_users WHERE role = 'admin' ORDER BY id LIMIT 1");
            if (admins[0]) {
                const [rows] = await pool.query('SELECT id, port FROM panel_servers WHERE owner_id = ?', [admins[0].id]);
                for (const row of rows) {
                    if (!isProtectedPort(row.port)) {
                        await pool.query('UPDATE panel_servers SET is_pool = 1 WHERE id = ?', [row.id]);
                    }
                }
            }
        }
    },
    {
        version: 3,
        name: 'billing tables',
        async up() {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS panel_plans (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    slug VARCHAR(32) NOT NULL UNIQUE,
                    name VARCHAR(80) NOT NULL,
                    description VARCHAR(500) NULL,
                    price DECIMAL(10,2) NOT NULL DEFAULT 0,
                    duration_days INT NOT NULL DEFAULT 30,
                    max_players INT NOT NULL DEFAULT 24,
                    features TEXT NULL,
                    is_trial TINYINT(1) NOT NULL DEFAULT 0,
                    highlighted TINYINT(1) NOT NULL DEFAULT 0,
                    active TINYINT(1) NOT NULL DEFAULT 1,
                    sort_order INT NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS panel_transactions (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    type VARCHAR(24) NOT NULL,
                    amount DECIMAL(10,2) NOT NULL,
                    balance_after DECIMAL(10,2) NOT NULL,
                    description VARCHAR(255) NULL,
                    reference_type VARCHAR(32) NULL,
                    reference_id VARCHAR(64) NULL,
                    actor_id INT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_panel_transactions_user (user_id, created_at),
                    INDEX idx_panel_transactions_created (created_at),
                    CONSTRAINT fk_panel_transactions_user FOREIGN KEY (user_id)
                        REFERENCES panel_users(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS panel_coupons (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    code VARCHAR(40) NOT NULL UNIQUE,
                    type ENUM('percent', 'fixed') NOT NULL DEFAULT 'percent',
                    value DECIMAL(10,2) NOT NULL,
                    max_uses INT NULL,
                    used_count INT NOT NULL DEFAULT 0,
                    per_user_limit INT NOT NULL DEFAULT 1,
                    plan_slug VARCHAR(32) NULL,
                    expires_at DATETIME NULL,
                    active TINYINT(1) NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS panel_coupon_redemptions (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    coupon_id INT NOT NULL,
                    user_id INT NOT NULL,
                    server_port INT NULL,
                    discount DECIMAL(10,2) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_coupon_user (coupon_id, user_id),
                    CONSTRAINT fk_redemption_coupon FOREIGN KEY (coupon_id) REFERENCES panel_coupons(id) ON DELETE CASCADE,
                    CONSTRAINT fk_redemption_user FOREIGN KEY (user_id) REFERENCES panel_users(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
            await addColumnIfMissing('panel_payments', 'reference_code', 'VARCHAR(32) NULL');
            await addColumnIfMissing('panel_payments', 'admin_note', 'VARCHAR(255) NULL');
            await addColumnIfMissing('panel_payments', 'reviewed_by', 'INT NULL');
            await addColumnIfMissing('panel_payments', 'reviewed_at', 'DATETIME NULL');
            await addColumnIfMissing('panel_payments', 'credited_amount', 'DECIMAL(10,2) NULL');

            // Seed plans from the legacy key/value settings so existing prices survive.
            const legacy = {};
            const [rows] = await pool.query('SELECT `key`, `value` FROM panel_settings');
            rows.forEach(r => { legacy[r.key] = r.value; });
            const [existing] = await pool.query('SELECT COUNT(*) AS c FROM panel_plans');
            if (!existing[0].c) {
                const plans = [
                    ['free', 'Deneme', '7 günlük ücretsiz deneme sunucusu. Hesap başına bir kez.', 0, 7,
                        parseInt(legacy.max_players_free || '12', 10), 'Tam panel erişimi\nFastDL, MySQL ve PHP alanı\n7 gün süre', 1, 0, 0, 0],
                    ['standard', 'Standart', 'Topluluk sunucuları için dengeli paket.', parseFloat(legacy.price_standard || '250'), 30,
                        parseInt(legacy.max_players_standard || '24', 10), '1000 FPS ReHLDS\nAMX Mod X + eklenti yöneticisi\nFastDL, MySQL ve PHP web sitesi\nGünlük yedek dostu dosya yönetimi', 0, 0, 1, 10],
                    ['pro', 'Pro', 'Yoğun ve rekabetçi sunucular için en yüksek slot.', parseFloat(legacy.price_pro || '350'), 30,
                        parseInt(legacy.max_players_pro || '32', 10), '32 slota kadar\n1000 FPS ReHLDS\nÖncelikli destek\nÖzel alan adıyla web sitesi', 0, 1, 1, 20]
                ];
                for (const p of plans) {
                    await pool.query(
                        `INSERT INTO panel_plans (slug, name, description, price, duration_days, max_players, features, is_trial, highlighted, active, sort_order)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, p
                    );
                }
            }
            await pool.query("DELETE FROM panel_settings WHERE `key` IN ('price_standard','price_pro','max_players_free','max_players_standard','max_players_pro')");
        }
    },
    {
        version: 4,
        name: 'notifications, audit, resets, kv',
        async up() {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS panel_notifications (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    type VARCHAR(32) NOT NULL DEFAULT 'info',
                    title VARCHAR(160) NOT NULL,
                    body VARCHAR(1000) NULL,
                    link VARCHAR(255) NULL,
                    read_at DATETIME NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_notifications_user (user_id, read_at, created_at),
                    CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES panel_users(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS panel_announcements (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    title VARCHAR(160) NOT NULL,
                    body VARCHAR(2000) NULL,
                    level ENUM('info', 'success', 'warning', 'danger') NOT NULL DEFAULT 'info',
                    active TINYINT(1) NOT NULL DEFAULT 1,
                    created_by INT NULL,
                    expires_at DATETIME NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS panel_audit_log (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    actor_id INT NULL,
                    actor_name VARCHAR(64) NULL,
                    action VARCHAR(64) NOT NULL,
                    target_type VARCHAR(32) NULL,
                    target_id VARCHAR(128) NULL,
                    details TEXT NULL,
                    ip VARCHAR(64) NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_audit_created (created_at),
                    INDEX idx_audit_actor (actor_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS panel_password_resets (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    token_hash CHAR(64) NOT NULL UNIQUE,
                    user_id INT NOT NULL,
                    created_by INT NULL,
                    expires_at DATETIME NOT NULL,
                    used_at DATETIME NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id) REFERENCES panel_users(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS panel_kv (
                    \`key\` VARCHAR(64) PRIMARY KEY,
                    \`value\` TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
        }
    }
];

async function runMigrations() {
    const [rows] = await pool.query('SELECT version FROM panel_schema_migrations');
    const applied = new Set(rows.map(r => r.version));
    for (const migration of MIGRATIONS) {
        if (applied.has(migration.version)) continue;
        console.log(`[DB] Applying migration ${migration.version}: ${migration.name}`);
        await migration.up();
        await pool.query('INSERT INTO panel_schema_migrations (version, name) VALUES (?, ?)', [migration.version, migration.name]);
    }
}

const DEFAULT_SETTINGS = [
    ['site_name', 'CS 1.6 Panel', 'Site Adı', 'text', 'Panelde ve e-postalarda görünen marka adı.', null],
    ['iban_details', 'TR00 0000 0000 0000 0000 0000 00 - Hesap Sahibi', 'IBAN ve Banka Bilgisi', 'textarea', 'Bakiye yükleme sayfasında gösterilen havale/EFT bilgileri.', null],
    ['currency', 'TL', 'Para Birimi', 'text', 'Fiyatların yanında gösterilen para birimi kısaltması.', null],
    ['min_deposit', '10', 'Minimum Bakiye Yükleme', 'number', 'Tek bir ödeme bildiriminde kabul edilen en düşük tutar.', null],
    ['global_free_limit', '15', 'Toplam Deneme Sunucusu Limiti', 'number', 'Aynı anda aktif olabilecek en fazla deneme sunucusu.', null],
    ['renewal_period_discounts', '3:5,6:10,12:15', 'Dönem İndirimleri', 'text', 'Ay:yüzde biçiminde uzun dönem indirimleri (örn. 3:5,6:10,12:15).', null],
    ['grace_days', '3', 'Askı Süresi (gün)', 'number', 'Süresi biten sunucu silinmeden önce askıda bekletilecek gün sayısı.', null],
    ['registration_enabled', '1', 'Yeni Üyelik', 'select', 'Yeni kullanıcı kaydına izin verilsin mi? (1 = açık, 0 = kapalı)', '1,0'],
    ['maintenance_mode', '0', 'Bakım Modu', 'select', 'Açıkken yalnızca yöneticiler panele erişebilir. (1 = açık)', '0,1'],
    ['maintenance_message', 'Planlı bakım çalışması yapılıyor. Kısa süre içinde tekrar hizmetinizdeyiz.', 'Bakım Mesajı', 'textarea', 'Bakım modunda kullanıcılara gösterilen metin.', null],
    ['support_contact', 'destek@example.com', 'Destek İletişim', 'text', 'Kullanıcılara gösterilen destek e-postası veya Discord bağlantısı.', null],
    ['pool_ports', '27015-27024', 'Havuz Portları', 'text', 'Kiralamaya hazır tutulacak oyun sunucusu portları (örn. 27015-27024,27030).', null]
];

async function seedSettings() {
    for (const [key, val, name, type, desc, opts] of DEFAULT_SETTINGS) {
        await pool.query(`
            INSERT INTO panel_settings (\`key\`, \`value\`, \`name\`, \`type\`, \`description\`, \`options\`)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                \`name\` = VALUES(\`name\`),
                \`type\` = VALUES(\`type\`),
                \`description\` = VALUES(\`description\`),
                \`options\` = VALUES(\`options\`)
        `, [key, val, name, type, desc, opts]);
    }
}

async function getKv(key) {
    const [rows] = await assertPool().query('SELECT `value` FROM panel_kv WHERE `key` = ? LIMIT 1', [key]);
    return rows[0] ? rows[0].value : null;
}

async function setKv(key, value) {
    await assertPool().query(
        'INSERT INTO panel_kv (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
        [key, String(value)]
    );
}

async function initTokenSecret() {
    const fromEnv = process.env.PANEL_AUTH_SECRET || '';
    if (fromEnv && !INSECURE_SECRETS.has(fromEnv) && fromEnv.length >= 16) {
        tokenSecret = fromEnv;
        return;
    }
    if (fromEnv) {
        console.warn('[Auth] PANEL_AUTH_SECRET is a known default or too short; using a generated secret instead.');
    }
    let stored = await getKv('auth_secret');
    if (!stored) {
        stored = crypto.randomBytes(48).toString('base64url');
        await setKv('auth_secret', stored);
        console.log('[Auth] Generated a new random session signing secret.');
    }
    tokenSecret = stored;
}

// ============================================================================
//  Seed users
// ============================================================================

function defaultSeedUsers() {
    return [
        { username: process.env.PANEL_ADMIN_USERNAME || 'admin', password: process.env.PANEL_ADMIN_PASSWORD || 'admin123', role: 'admin' },
        { username: process.env.PANEL_USER_USERNAME || 'user', password: process.env.PANEL_USER_PASSWORD || 'user123', role: 'user' }
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

/**
 * Seed accounts are created once. Earlier versions re-wrote their password on
 * every boot, which silently reverted any password the owner changed in the
 * panel back to the (public) default.
 */
async function seedUsers() {
    const db = assertPool();
    const weakDefaults = new Set(['admin123', 'user123']);
    for (const user of parseSeedUsers()) {
        if (!/^[a-zA-Z0-9_.-]{2,64}$/.test(user.username)) {
            console.log(`Skipping invalid seed user: ${user.username}`);
            continue;
        }
        const [exists] = await db.query('SELECT id FROM panel_users WHERE username = ? LIMIT 1', [user.username]);
        if (exists.length) continue;
        await db.query(
            'INSERT INTO panel_users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, ?)',
            [user.username, await hashPassword(user.password), user.role, weakDefaults.has(user.password) ? 1 : 0]
        );
        if (weakDefaults.has(user.password)) {
            console.warn(`[Security] Seed account "${user.username}" uses a public default password. Change it immediately.`);
        }
    }
}

// ============================================================================
//  Users & authentication
// ============================================================================

const SAFE_USER_FIELDS = `id, username, email, role, balance, suspended, token_version, created_at,
    last_login_at, last_login_ip, must_change_password, password_changed_at`;

async function getUserByUsername(username) {
    const [rows] = await assertPool().query('SELECT * FROM panel_users WHERE username = ? LIMIT 1', [username]);
    return rows[0] || null;
}

async function getUserById(id) {
    const [rows] = await assertPool().query(`SELECT ${SAFE_USER_FIELDS} FROM panel_users WHERE id = ? LIMIT 1`, [id]);
    return rows[0] || null;
}

function publicUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        email: user.email || null,
        role: user.role,
        balance: money(user.balance),
        suspended: !!user.suspended,
        created_at: user.created_at,
        last_login_at: user.last_login_at || null,
        must_change_password: !!user.must_change_password
    };
}

async function authenticate(login, password, ip = null) {
    const db = assertPool();
    const value = String(login || '').trim();
    if (!value || !password) return null;
    const [rows] = await db.query(
        'SELECT * FROM panel_users WHERE username = ? OR (email IS NOT NULL AND email = ?) LIMIT 1',
        [value, value.toLowerCase()]
    );
    const user = rows[0];
    if (!user) {
        // Spend comparable CPU time so response timing does not reveal accounts.
        await verifyPassword(password, 'scrypt$00000000000000000000000000000000$' + '0'.repeat(128));
        return null;
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
        throw httpError(429, 'Çok fazla başarısız deneme. Hesap geçici olarak kilitlendi, lütfen daha sonra tekrar deneyin.');
    }
    if (!(await verifyPassword(password, user.password_hash))) {
        const failed = (user.failed_logins || 0) + 1;
        if (failed >= MAX_FAILED_LOGINS) {
            await db.query(
                'UPDATE panel_users SET failed_logins = 0, locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?',
                [LOCKOUT_MINUTES, user.id]
            );
            await logAudit({ actorId: user.id, actorName: user.username, action: 'auth.lockout', targetType: 'user', targetId: user.id, ip });
        } else {
            await db.query('UPDATE panel_users SET failed_logins = ? WHERE id = ?', [failed, user.id]);
        }
        return null;
    }
    if (user.suspended) {
        throw httpError(403, 'Bu hesap askıya alınmış. Lütfen destek ile iletişime geçin.');
    }
    await db.query(
        'UPDATE panel_users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW(), last_login_ip = ? WHERE id = ?',
        [ip ? String(ip).slice(0, 64) : null, user.id]
    );
    return getUserById(user.id);
}

async function createUser(username, password, { email = null, role = 'user', requireEmail = false, acceptTerms = false, balance = 0, skipStrength = false } = {}) {
    const name = normalizeUsername(username);
    const mail = normalizeEmail(email, { required: requireEmail });
    if (!skipStrength) validatePasswordStrength(password);
    else if (!password || String(password).length < 6) throw httpError(400, 'Şifre en az 6 karakter olmalıdır.');
    if (!['admin', 'user'].includes(role)) throw httpError(400, 'Geçersiz rol.');

    const db = assertPool();
    const [exists] = await db.query(
        'SELECT username, email FROM panel_users WHERE username = ? OR (email IS NOT NULL AND email = ?) LIMIT 1',
        [name, mail || '']
    );
    if (exists.length) {
        if (exists[0].username.toLowerCase() === name.toLowerCase()) throw httpError(409, 'Bu kullanıcı adı zaten alınmış.');
        throw httpError(409, 'Bu e-posta adresiyle kayıtlı bir hesap zaten var.');
    }
    const [result] = await db.query(
        `INSERT INTO panel_users (username, email, password_hash, role, balance, accepted_terms_at, password_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [name, mail, await hashPassword(password), role, money(balance), acceptTerms ? new Date() : null]
    );
    return getUserById(result.insertId);
}

async function changePassword(userId, currentPassword, newPassword) {
    const db = assertPool();
    const [rows] = await db.query('SELECT password_hash FROM panel_users WHERE id = ? LIMIT 1', [userId]);
    if (!rows[0]) throw httpError(404, 'Kullanıcı bulunamadı.');
    if (!(await verifyPassword(currentPassword, rows[0].password_hash))) {
        throw httpError(400, 'Mevcut şifre hatalı.');
    }
    validatePasswordStrength(newPassword);
    await setPassword(userId, newPassword);
    return getUserById(userId);
}

async function setPassword(userId, newPassword) {
    await assertPool().query(
        `UPDATE panel_users SET password_hash = ?, password_changed_at = NOW(), must_change_password = 0,
            token_version = token_version + 1, failed_logins = 0, locked_until = NULL
         WHERE id = ?`,
        [await hashPassword(newPassword), userId]
    );
}

async function updateProfile(userId, { email }) {
    const mail = normalizeEmail(email, { required: false });
    const db = assertPool();
    if (mail) {
        const [rows] = await db.query('SELECT id FROM panel_users WHERE email = ? AND id <> ? LIMIT 1', [mail, userId]);
        if (rows.length) throw httpError(409, 'Bu e-posta adresi başka bir hesapta kullanılıyor.');
    }
    await db.query('UPDATE panel_users SET email = ? WHERE id = ?', [mail, userId]);
    return getUserById(userId);
}

async function revokeSessions(userId) {
    await assertPool().query('UPDATE panel_users SET token_version = token_version + 1 WHERE id = ?', [userId]);
    return getUserById(userId);
}

async function createPasswordReset(userId, createdBy = null) {
    const token = crypto.randomBytes(32).toString('base64url');
    await assertPool().query(
        'INSERT INTO panel_password_resets (token_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))',
        [sha256(token), userId, createdBy, PASSWORD_RESET_TTL_SECONDS]
    );
    return { token, expiresIn: PASSWORD_RESET_TTL_SECONDS };
}

async function consumePasswordReset(token, newPassword) {
    if (!token || typeof token !== 'string' || token.length > 256) throw httpError(400, 'Sıfırlama bağlantısı geçersiz.');
    validatePasswordStrength(newPassword);
    const passwordHash = await hashPassword(newPassword);
    return withTransaction(async conn => {
        const [rows] = await conn.query(
            'SELECT id, user_id FROM panel_password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at >= NOW() LIMIT 1 FOR UPDATE',
            [sha256(token)]
        );
        if (!rows[0]) throw httpError(400, 'Sıfırlama bağlantısı geçersiz veya süresi dolmuş.');
        await conn.query('UPDATE panel_password_resets SET used_at = NOW() WHERE id = ?', [rows[0].id]);
        await conn.query(
            `UPDATE panel_users SET password_hash = ?, password_changed_at = NOW(), must_change_password = 0,
                token_version = token_version + 1, failed_logins = 0, locked_until = NULL WHERE id = ?`,
            [passwordHash, rows[0].user_id]
        );
        return rows[0].user_id;
    });
}

async function getAdminUser() {
    const [rows] = await assertPool().query("SELECT id, username, role FROM panel_users WHERE role = 'admin' ORDER BY id LIMIT 1");
    if (rows[0]) return rows[0];
    throw new Error('No admin user is seeded');
}

/** Unrented pool servers belong to the first admin account. */
async function getPoolOwnerId() {
    if (poolOwnerIdCache) return poolOwnerIdCache;
    poolOwnerIdCache = (await getAdminUser()).id;
    return poolOwnerIdCache;
}

function hashAuthHandoffCode(code) {
    return sha256(code);
}

async function cleanupAuthHandoffs() {
    const db = assertPool();
    await db.query(`
        DELETE FROM panel_auth_handoffs
        WHERE expires_at < NOW(3) OR (used_at IS NOT NULL AND used_at < DATE_SUB(NOW(3), INTERVAL 5 MINUTE))
    `);
    await db.query('DELETE FROM panel_password_resets WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)');
}

async function createAuthHandoff(userId) {
    const code = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + AUTH_HANDOFF_TTL_SECONDS * 1000);
    await cleanupAuthHandoffs().catch(() => {});
    await assertPool().query(
        'INSERT INTO panel_auth_handoffs (code_hash, user_id, expires_at) VALUES (?, ?, ?)',
        [hashAuthHandoffCode(code), userId, expiresAt]
    );
    return { code, expiresIn: AUTH_HANDOFF_TTL_SECONDS };
}

async function consumeAuthHandoff(code) {
    if (!code || typeof code !== 'string' || code.length > 256) return null;
    const userId = await withTransaction(async conn => {
        const [rows] = await conn.query(`
            SELECT h.id, u.id AS user_id, u.suspended
            FROM panel_auth_handoffs h
            INNER JOIN panel_users u ON u.id = h.user_id
            WHERE h.code_hash = ? AND h.used_at IS NULL AND h.expires_at >= NOW(3)
            LIMIT 1 FOR UPDATE
        `, [hashAuthHandoffCode(code)]);
        if (!rows[0] || rows[0].suspended) return null;
        const [result] = await conn.query('UPDATE panel_auth_handoffs SET used_at = NOW(3) WHERE id = ? AND used_at IS NULL', [rows[0].id]);
        return result.affectedRows === 1 ? rows[0].user_id : null;
    });
    return userId ? getUserById(userId) : null;
}

// ============================================================================
//  Servers
// ============================================================================

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
    return {
        db_name: existing.db_name || `cs_srv_${port}`,
        db_username: existing.db_username || `csu_${port}`,
        db_password: existing.db_password || randomPassword(),
        php_path: existing.php_path || `servers/${port}`,
        // URLs are always derived from current configuration so a changed
        // FASTDL_HOST / PHP_PUBLIC_BASE_URL never leaves stale links behind.
        php_url: cfg.phpSiteUrl(port, existing.php_domain || null),
        fastdl_path: existing.fastdl_path || String(port),
        sv_downloadurl: cfg.fastdlUrl(port)
    };
}

const SERVER_SELECT = `
    SELECT s.*, u.username AS owner_username, u.role AS owner_role
    FROM panel_servers s
    JOIN panel_users u ON u.id = s.owner_id`;

async function getServerByContainerId(containerId) {
    const [rows] = await assertPool().query(`${SERVER_SELECT} WHERE s.container_id = ? LIMIT 1`, [containerId]);
    return rows[0] || null;
}

async function getServerByPort(port) {
    const [rows] = await assertPool().query(`${SERVER_SELECT} WHERE s.port = ? LIMIT 1`, [parseInt(port, 10)]);
    return rows[0] || null;
}

async function getServerById(id) {
    const [rows] = await assertPool().query(`${SERVER_SELECT} WHERE s.id = ? LIMIT 1`, [parseInt(id, 10)]);
    return rows[0] || null;
}

async function listServersForUser(user) {
    const isAdmin = user.role === 'admin';
    const [rows] = await assertPool().query(
        `${SERVER_SELECT} ${isAdmin ? '' : 'WHERE s.owner_id = ? AND s.is_pool = 0'} ORDER BY s.port ASC`,
        isAdmin ? [] : [user.id]
    );
    return rows;
}

async function listUnrentedPoolServers() {
    const { PROTECTED_SERVER_PORTS } = require('./serverProtection');
    const ports = [...PROTECTED_SERVER_PORTS];
    const [rows] = await assertPool().query(
        `${SERVER_SELECT} WHERE s.is_pool = 1 ${ports.length ? `AND s.port NOT IN (${ports.map(() => '?').join(',')})` : ''} ORDER BY s.port ASC`,
        ports
    );
    return rows;
}

async function upsertServerRecord(data) {
    const resources = buildServerResources(data.port, data);
    const planType = data.plan_type || 'standard';
    const expiresAt = data.expires_at || new Date(Date.now() + (planType === 'free' ? 7 : 30) * 86400000);
    const rconPassword = data.rcon_password || randomPassword(12);

    await assertPool().query(
        `INSERT INTO panel_servers
            (container_id, port, owner_id, name, plan_type, expires_at, db_name, db_username, db_password,
             php_path, php_url, fastdl_path, sv_downloadurl, rcon_password, is_pool)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            container_id = VALUES(container_id),
            owner_id = VALUES(owner_id),
            name = VALUES(name),
            plan_type = VALUES(plan_type),
            expires_at = VALUES(expires_at),
            is_pool = VALUES(is_pool),
            db_name = COALESCE(panel_servers.db_name, VALUES(db_name)),
            db_username = COALESCE(panel_servers.db_username, VALUES(db_username)),
            db_password = COALESCE(panel_servers.db_password, VALUES(db_password)),
            php_path = COALESCE(panel_servers.php_path, VALUES(php_path)),
            php_url = VALUES(php_url),
            fastdl_path = COALESCE(panel_servers.fastdl_path, VALUES(fastdl_path)),
            sv_downloadurl = VALUES(sv_downloadurl),
            rcon_password = COALESCE(panel_servers.rcon_password, VALUES(rcon_password))`,
        [
            data.container_id, parseInt(data.port, 10), data.owner_id, data.name || `Server ${data.port}`,
            planType, expiresAt, resources.db_name, resources.db_username, resources.db_password,
            resources.php_path, resources.php_url, resources.fastdl_path, resources.sv_downloadurl,
            rconPassword, data.is_pool ? 1 : 0
        ]
    );
    return getServerByContainerId(data.container_id);
}

const UPDATABLE_SERVER_FIELDS = new Set([
    'container_id', 'owner_id', 'name', 'plan_type', 'expires_at', 'db_name', 'db_username', 'db_password',
    'php_path', 'php_url', 'fastdl_path', 'sv_downloadurl', 'rcon_password', 'suspended', 'suspended_reason',
    'is_pool', 'auto_renew', 'rented_at', 'last_renewed_at', 'expiry_notice_stage', 'php_domain'
]);

async function updateServerContainer(containerId, fields) {
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(fields)) {
        if (!UPDATABLE_SERVER_FIELDS.has(key)) throw new Error(`Unknown server field: ${key}`);
        sets.push(`\`${key}\` = ?`);
        params.push(value);
    }
    if (!sets.length) return getServerByContainerId(containerId);
    params.push(containerId);
    await assertPool().query(`UPDATE panel_servers SET ${sets.join(', ')} WHERE container_id = ?`, params);
    return getServerByContainerId(fields.container_id || containerId);
}

async function deleteServerRecord(containerId) {
    await assertPool().query('DELETE FROM panel_servers WHERE container_id = ?', [containerId]);
}

function canAccessServer(user, serverRecord) {
    if (!user || !serverRecord) return false;
    if (user.role === 'admin') return true;
    return !serverRecord.is_pool && Number(serverRecord.owner_id) === Number(user.id);
}

async function adoptContainer(docker, containerId) {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    const port = extractServerPortFromInspect(info);
    if (!port) throw httpError(400, 'Server port mapping not found');

    let existing = await getServerByPort(port);
    if (existing) {
        if (existing.container_id !== containerId) {
            existing = await updateServerContainer(existing.container_id, { container_id: containerId });
        }
        return existing;
    }

    const ownerId = await getPoolOwnerId();
    const { isProtectedPort } = require('./serverProtection');
    return upsertServerRecord({
        container_id: containerId,
        port,
        owner_id: ownerId,
        name: getEnvValue(info.Config.Env, 'SERVER_NAME', `Server ${port}`),
        rcon_password: getEnvValue(info.Config.Env, 'RCON_PASSWORD', null),
        plan_type: 'free',
        expires_at: new Date('2035-01-01T00:00:00Z'),
        is_pool: !isProtectedPort(port)
    });
}

/**
 * Resolve a server for the current user. Suspended servers (expired or
 * blocked by an admin) answer 402 for customers so every per-server feature
 * sits behind the paywall until the subscription is renewed.
 */
async function requireServerAccess(user, docker, containerId, { allowSuspended = false } = {}) {
    if (!containerId || !/^[a-zA-Z0-9_.-]{1,128}$/.test(String(containerId))) {
        throw httpError(400, 'Invalid server id');
    }
    let record = await getServerByContainerId(containerId);
    if (!record) {
        if (!docker) throw httpError(404, 'Server not found');
        record = await adoptContainer(docker, containerId);
    }
    if (!canAccessServer(user, record)) {
        throw httpError(403, 'Bu sunucuya erişim yetkiniz yok.');
    }
    if (record.suspended && user.role !== 'admin' && !allowSuspended) {
        throw httpError(402, record.suspended_reason === 'expired'
            ? 'Sunucunuzun kiralama süresi doldu. Kullanmaya devam etmek için süreyi uzatın.'
            : 'Bu sunucu yönetici tarafından askıya alındı.', { code: 'SERVER_SUSPENDED', reason: record.suspended_reason || 'admin' });
    }
    return record;
}

async function requirePortAccess(user, docker, port, options = {}) {
    let record = await getServerByPort(port);
    if (!record && docker) {
        const containers = await docker.listContainers({ all: true });
        const match = containers.find(c => c.Ports && c.Ports.some(p => p.PublicPort == port && p.Type === 'udp'));
        if (match) record = await adoptContainer(docker, match.Id);
    }
    if (!record) throw httpError(404, 'Server resource not found');
    return requireServerAccess(user, docker, record.container_id, options);
}

// ============================================================================
//  Per-server MySQL accounts
// ============================================================================

async function ensureSqlAccount(dbName, username, password) {
    validateSqlName(dbName, 'Database name');
    validateSqlName(username, 'Database username');
    const conn = await rootConnection();
    try {
        await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        try {
            // AMX Mod X's bundled MySQL client only speaks mysql_native_password.
            await conn.query(`CREATE USER IF NOT EXISTS '${username}'@'%' IDENTIFIED WITH mysql_native_password BY ?`, [password]);
            await conn.query(`ALTER USER '${username}'@'%' IDENTIFIED WITH mysql_native_password BY ?`, [password]);
        } catch (e) {
            if (!/syntax|plugin/i.test(e.message)) throw e;
            await conn.query(`CREATE USER IF NOT EXISTS '${username}'@'%' IDENTIFIED BY ?`, [password]);
            await conn.query(`ALTER USER '${username}'@'%' IDENTIFIED BY ?`, [password]);
        }
        await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${username}'@'%'`);
        await conn.query('FLUSH PRIVILEGES');
    } finally {
        await conn.end();
    }
}

async function dropSqlAccount(dbName, username) {
    const conn = await rootConnection();
    try {
        if (dbName) {
            validateSqlName(dbName, 'Database name');
            if (dbName === PANEL_DB_NAME || ['mysql', 'sys', 'information_schema', 'performance_schema'].includes(dbName)) {
                throw httpError(400, 'Refusing to drop a system database');
            }
            await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
        }
        if (username && username !== 'root') {
            validateSqlName(username, 'Database username');
            await conn.query(`DROP USER IF EXISTS '${username}'@'%'`);
        }
        await conn.query('FLUSH PRIVILEGES');
    } finally {
        await conn.end();
    }
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

function sqlResourceFromRecord(row) {
    const endpoints = cfg.mysqlEndpoints();
    return {
        serverId: row.container_id,
        serverName: row.name,
        port: row.port,
        database: row.db_name,
        username: row.db_username,
        password: row.db_password,
        host: endpoints.internal.host,
        mysqlPort: endpoints.internal.port,
        externalHost: endpoints.external ? endpoints.external.host : null,
        externalPort: endpoints.external ? endpoints.external.port : null,
        owner: row.owner_username
    };
}

async function listSqlResourcesForUser(user) {
    const rows = await listServersForUser(user);
    return rows
        .filter(row => row.db_name && row.db_username && (user.role === 'admin' || !row.suspended))
        .map(sqlResourceFromRecord);
}

async function canAccessDatabase(user, database) {
    if (!database) return user.role === 'admin';
    validateSqlName(database, 'Database name');
    if (user.role === 'admin') return true;
    const [rows] = await assertPool().query(
        'SELECT id FROM panel_servers WHERE owner_id = ? AND db_name = ? AND is_pool = 0 AND suspended = 0 LIMIT 1',
        [user.id, database]
    );
    return rows.length > 0;
}

// ============================================================================
//  Balance ledger
// ============================================================================

/**
 * The only function that changes a balance. It must run inside the caller's
 * transaction; the user row is locked so concurrent purchases cannot overdraw.
 */
async function adjustBalance(conn, userId, delta, { type, description = null, referenceType = null, referenceId = null, actorId = null, allowNegative = false } = {}) {
    const amount = money(delta);
    const [users] = await conn.query('SELECT balance FROM panel_users WHERE id = ? FOR UPDATE', [userId]);
    if (!users[0]) throw httpError(404, 'Kullanıcı bulunamadı.');
    const after = money(Number(users[0].balance) + amount);
    if (after < 0 && !allowNegative) {
        throw httpError(402, `Yetersiz bakiye. Gerekli: ${money(-amount).toFixed(2)}, mevcut: ${money(users[0].balance).toFixed(2)}.`, { code: 'INSUFFICIENT_BALANCE' });
    }
    await conn.query('UPDATE panel_users SET balance = ? WHERE id = ?', [after, userId]);
    await conn.query(
        `INSERT INTO panel_transactions (user_id, type, amount, balance_after, description, reference_type, reference_id, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, type || 'adjustment', amount, after, description ? String(description).slice(0, 255) : null,
            referenceType, referenceId === null || referenceId === undefined ? null : String(referenceId), actorId]
    );
    return after;
}

async function listTransactions({ userId = null, limit = 50, offset = 0, type = null } = {}) {
    const where = [];
    const params = [];
    if (userId) { where.push('t.user_id = ?'); params.push(userId); }
    if (type) { where.push('t.type = ?'); params.push(type); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await assertPool().query(
        `SELECT t.*, u.username FROM panel_transactions t JOIN panel_users u ON u.id = t.user_id
         ${clause} ORDER BY t.id DESC LIMIT ? OFFSET ?`,
        [...params, Math.min(parseInt(limit, 10) || 50, 500), Math.max(parseInt(offset, 10) || 0, 0)]
    );
    const [count] = await assertPool().query(`SELECT COUNT(*) AS total FROM panel_transactions t ${clause}`, params);
    return { transactions: rows, total: count[0].total };
}

// ============================================================================
//  Payments (bank transfer reports)
// ============================================================================

function depositReferenceCode(userId) {
    return `CS${String(userId).padStart(5, '0')}`;
}

async function createPaymentReport(userId, amount, senderName, receiptPath) {
    const [result] = await assertPool().query(
        `INSERT INTO panel_payments (user_id, amount, sender_name, receipt_path, status, reference_code)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        [userId, money(amount), senderName, receiptPath, depositReferenceCode(userId)]
    );
    return result.insertId;
}

async function listPayments({ status = null, userId = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('p.status = ?'); params.push(status); }
    if (userId) { where.push('p.user_id = ?'); params.push(userId); }
    const [rows] = await assertPool().query(
        `SELECT p.*, u.username, r.username AS reviewed_by_name
         FROM panel_payments p
         JOIN panel_users u ON u.id = p.user_id
         LEFT JOIN panel_users r ON r.id = p.reviewed_by
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY p.created_at DESC LIMIT ?`,
        [...params, Math.min(parseInt(limit, 10) || 100, 500)]
    );
    return rows;
}

async function getPendingPayments() {
    return listPayments({ status: 'pending' });
}

async function getUserPayments(userId) {
    return listPayments({ userId });
}

async function getPaymentByReceiptPath(receiptPath) {
    const [rows] = await assertPool().query(
        'SELECT id, user_id, receipt_path FROM panel_payments WHERE receipt_path = ? LIMIT 1',
        [receiptPath]
    );
    return rows[0] || null;
}

async function approvePayment(paymentId, { actorId = null, creditedAmount = null, note = null } = {}) {
    return withTransaction(async conn => {
        const [payments] = await conn.query('SELECT * FROM panel_payments WHERE id = ? FOR UPDATE', [paymentId]);
        if (!payments.length) throw httpError(404, 'Ödeme bulunamadı.');
        const payment = payments[0];
        if (payment.status !== 'pending') throw httpError(409, 'Bu ödeme zaten işlenmiş.');
        const amount = creditedAmount !== null && creditedAmount !== undefined && creditedAmount !== ''
            ? money(creditedAmount) : money(payment.amount);
        if (!(amount > 0)) throw httpError(400, 'Yüklenecek tutar sıfırdan büyük olmalı.');
        await conn.query(
            `UPDATE panel_payments SET status = 'approved', reviewed_by = ?, reviewed_at = NOW(), admin_note = ?, credited_amount = ? WHERE id = ?`,
            [actorId, note ? String(note).slice(0, 255) : null, amount, paymentId]
        );
        await adjustBalance(conn, payment.user_id, amount, {
            type: 'deposit', description: `Havale/EFT bildirimi #${paymentId} onaylandı`,
            referenceType: 'payment', referenceId: paymentId, actorId
        });
        return { userId: payment.user_id, amount };
    });
}

async function rejectPayment(paymentId, { actorId = null, note = null } = {}) {
    const [result] = await assertPool().query(
        `UPDATE panel_payments SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), admin_note = ?
         WHERE id = ? AND status = 'pending'`,
        [actorId, note ? String(note).slice(0, 255) : null, paymentId]
    );
    if (result.affectedRows === 0) throw httpError(404, 'Ödeme bulunamadı veya bekleyen durumda değil.');
    const [rows] = await assertPool().query('SELECT user_id FROM panel_payments WHERE id = ?', [paymentId]);
    return { userId: rows[0] && rows[0].user_id };
}

// ============================================================================
//  Plans & coupons
// ============================================================================

function normalizePlan(row) {
    if (!row) return null;
    return {
        ...row,
        price: money(row.price),
        is_trial: !!row.is_trial,
        highlighted: !!row.highlighted,
        active: !!row.active,
        features: String(row.features || '').split('\n').map(s => s.trim()).filter(Boolean)
    };
}

async function listPlans({ activeOnly = true } = {}) {
    const [rows] = await assertPool().query(
        `SELECT * FROM panel_plans ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort_order ASC, price ASC`
    );
    return rows.map(normalizePlan);
}

async function getPlan(slug) {
    const [rows] = await assertPool().query('SELECT * FROM panel_plans WHERE slug = ? LIMIT 1', [String(slug || '')]);
    return normalizePlan(rows[0]);
}

function validatePlanInput(input, { partial = false } = {}) {
    const out = {};
    if (input.slug !== undefined || !partial) {
        const slug = String(input.slug || '').trim().toLowerCase();
        if (!/^[a-z0-9_-]{2,32}$/.test(slug)) throw httpError(400, 'Paket kodu 2-32 karakter (a-z, 0-9, _ -) olmalı.');
        out.slug = slug;
    }
    if (input.name !== undefined || !partial) {
        const name = String(input.name || '').trim();
        if (!name || name.length > 80) throw httpError(400, 'Paket adı 1-80 karakter olmalı.');
        out.name = name;
    }
    if (input.description !== undefined) out.description = String(input.description || '').slice(0, 500);
    if (input.price !== undefined || !partial) {
        const price = money(input.price);
        if (!(price >= 0) || price > 1000000) throw httpError(400, 'Geçersiz fiyat.');
        out.price = price;
    }
    if (input.duration_days !== undefined || !partial) {
        const days = parseInt(input.duration_days, 10);
        if (!(days >= 1 && days <= 3650)) throw httpError(400, 'Süre 1-3650 gün olmalı.');
        out.duration_days = days;
    }
    if (input.max_players !== undefined || !partial) {
        const slots = parseInt(input.max_players, 10);
        if (!(slots >= 2 && slots <= 32)) throw httpError(400, 'Slot sayısı 2-32 arasında olmalı.');
        out.max_players = slots;
    }
    if (input.features !== undefined) {
        const list = Array.isArray(input.features) ? input.features : String(input.features || '').split('\n');
        out.features = list.map(s => String(s).trim()).filter(Boolean).slice(0, 20).join('\n');
    }
    for (const flag of ['is_trial', 'highlighted', 'active']) {
        if (input[flag] !== undefined) out[flag] = input[flag] === true || input[flag] === 1 || input[flag] === '1' || input[flag] === 'true' ? 1 : 0;
    }
    if (input.sort_order !== undefined) out.sort_order = parseInt(input.sort_order, 10) || 0;
    return out;
}

async function createPlan(input) {
    const data = validatePlanInput(input);
    const cols = Object.keys(data);
    try {
        await assertPool().query(
            `INSERT INTO panel_plans (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            cols.map(c => data[c])
        );
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') throw httpError(409, 'Bu paket kodu zaten kullanılıyor.');
        throw e;
    }
    return getPlan(data.slug);
}

async function updatePlan(id, input) {
    const data = validatePlanInput(input, { partial: true });
    delete data.slug; // slugs are referenced by servers; keep them immutable
    const cols = Object.keys(data);
    if (cols.length) {
        await assertPool().query(
            `UPDATE panel_plans SET ${cols.map(c => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
            [...cols.map(c => data[c]), parseInt(id, 10)]
        );
    }
    const [rows] = await assertPool().query('SELECT * FROM panel_plans WHERE id = ?', [parseInt(id, 10)]);
    if (!rows[0]) throw httpError(404, 'Paket bulunamadı.');
    return normalizePlan(rows[0]);
}

async function deletePlan(id) {
    const [rows] = await assertPool().query('SELECT slug FROM panel_plans WHERE id = ?', [parseInt(id, 10)]);
    if (!rows[0]) throw httpError(404, 'Paket bulunamadı.');
    const [used] = await assertPool().query('SELECT COUNT(*) AS c FROM panel_servers WHERE plan_type = ? AND is_pool = 0', [rows[0].slug]);
    if (used[0].c) throw httpError(409, `Bu paketi kullanan ${used[0].c} sunucu var. Silmek yerine pasif hale getirin.`);
    await assertPool().query('DELETE FROM panel_plans WHERE id = ?', [parseInt(id, 10)]);
}

function normalizeCouponCode(code) {
    return String(code || '').trim().toUpperCase();
}

async function listCoupons() {
    const [rows] = await assertPool().query('SELECT * FROM panel_coupons ORDER BY created_at DESC');
    return rows.map(r => ({ ...r, value: money(r.value), active: !!r.active }));
}

async function createCoupon(input) {
    const code = normalizeCouponCode(input.code);
    if (!/^[A-Z0-9_-]{3,40}$/.test(code)) throw httpError(400, 'Kupon kodu 3-40 karakter (A-Z, 0-9, _ -) olmalı.');
    const type = input.type === 'fixed' ? 'fixed' : 'percent';
    const value = money(input.value);
    if (!(value > 0) || (type === 'percent' && value > 100)) throw httpError(400, 'Geçersiz indirim değeri.');
    const maxUses = input.max_uses === '' || input.max_uses === null || input.max_uses === undefined ? null : Math.max(1, parseInt(input.max_uses, 10) || 1);
    const perUser = Math.max(1, parseInt(input.per_user_limit, 10) || 1);
    const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
    if (expiresAt && isNaN(expiresAt.getTime())) throw httpError(400, 'Geçersiz bitiş tarihi.');
    const planSlug = input.plan_slug ? String(input.plan_slug) : null;
    try {
        await assertPool().query(
            `INSERT INTO panel_coupons (code, type, value, max_uses, per_user_limit, plan_slug, expires_at, active)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
            [code, type, value, maxUses, perUser, planSlug, expiresAt]
        );
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') throw httpError(409, 'Bu kupon kodu zaten var.');
        throw e;
    }
}

async function setCouponActive(id, active) {
    await assertPool().query('UPDATE panel_coupons SET active = ? WHERE id = ?', [active ? 1 : 0, parseInt(id, 10)]);
}

async function deleteCoupon(id) {
    await assertPool().query('DELETE FROM panel_coupons WHERE id = ?', [parseInt(id, 10)]);
}

/** Validate a coupon for a user/plan. `conn` may be a transaction connection. */
async function resolveCoupon(code, { userId, planSlug, conn = null, lock = false } = {}) {
    const normalized = normalizeCouponCode(code);
    if (!normalized) return null;
    const db = conn || assertPool();
    const [rows] = await db.query(`SELECT * FROM panel_coupons WHERE code = ? LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`, [normalized]);
    const coupon = rows[0];
    if (!coupon || !coupon.active) throw httpError(400, 'Kupon kodu geçersiz.');
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) throw httpError(400, 'Kuponun süresi dolmuş.');
    if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) throw httpError(400, 'Kupon kullanım limiti dolmuş.');
    if (coupon.plan_slug && coupon.plan_slug !== planSlug) throw httpError(400, 'Bu kupon seçilen pakette geçerli değil.');
    if (userId) {
        const [used] = await db.query('SELECT COUNT(*) AS c FROM panel_coupon_redemptions WHERE coupon_id = ? AND user_id = ?', [coupon.id, userId]);
        if (used[0].c >= coupon.per_user_limit) throw httpError(400, 'Bu kuponu daha önce kullandınız.');
    }
    return { ...coupon, value: money(coupon.value) };
}

async function redeemCoupon(conn, coupon, { userId, serverPort, discount }) {
    await conn.query('UPDATE panel_coupons SET used_count = used_count + 1 WHERE id = ?', [coupon.id]);
    await conn.query(
        'INSERT INTO panel_coupon_redemptions (coupon_id, user_id, server_port, discount) VALUES (?, ?, ?, ?)',
        [coupon.id, userId, serverPort || null, money(discount)]
    );
}

// ============================================================================
//  Notifications, announcements, audit
// ============================================================================

async function notify(userId, { type = 'info', title, body = null, link = null }) {
    if (!userId || !title) return;
    await assertPool().query(
        'INSERT INTO panel_notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)',
        [userId, String(type).slice(0, 32), String(title).slice(0, 160), body ? String(body).slice(0, 1000) : null, link ? String(link).slice(0, 255) : null]
    );
}

async function notifyAdmins(payload) {
    const [admins] = await assertPool().query("SELECT id FROM panel_users WHERE role = 'admin' AND suspended = 0");
    for (const admin of admins) await notify(admin.id, payload);
}

async function listNotifications(userId, { limit = 30 } = {}) {
    const [rows] = await assertPool().query(
        'SELECT * FROM panel_notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?',
        [userId, Math.min(parseInt(limit, 10) || 30, 100)]
    );
    const [unread] = await assertPool().query('SELECT COUNT(*) AS c FROM panel_notifications WHERE user_id = ? AND read_at IS NULL', [userId]);
    return { notifications: rows, unread: unread[0].c };
}

async function markNotificationsRead(userId, ids = null) {
    if (Array.isArray(ids) && ids.length) {
        const clean = ids.map(id => parseInt(id, 10)).filter(Number.isInteger).slice(0, 200);
        if (!clean.length) return;
        await assertPool().query(
            `UPDATE panel_notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL AND id IN (${clean.map(() => '?').join(',')})`,
            [userId, ...clean]
        );
    } else {
        await assertPool().query('UPDATE panel_notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [userId]);
    }
}

async function listAnnouncements({ activeOnly = true } = {}) {
    const [rows] = await assertPool().query(
        `SELECT a.*, u.username AS created_by_name FROM panel_announcements a LEFT JOIN panel_users u ON u.id = a.created_by
         ${activeOnly ? 'WHERE a.active = 1 AND (a.expires_at IS NULL OR a.expires_at > NOW())' : ''}
         ORDER BY a.id DESC LIMIT 50`
    );
    return rows;
}

async function createAnnouncement({ title, body, level = 'info', expiresAt = null, createdBy = null }) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle || cleanTitle.length > 160) throw httpError(400, 'Başlık 1-160 karakter olmalı.');
    const lvl = ['info', 'success', 'warning', 'danger'].includes(level) ? level : 'info';
    const exp = expiresAt ? new Date(expiresAt) : null;
    const [result] = await assertPool().query(
        'INSERT INTO panel_announcements (title, body, level, expires_at, created_by) VALUES (?, ?, ?, ?, ?)',
        [cleanTitle, body ? String(body).slice(0, 2000) : null, lvl, exp && !isNaN(exp.getTime()) ? exp : null, createdBy]
    );
    return result.insertId;
}

async function setAnnouncementActive(id, active) {
    await assertPool().query('UPDATE panel_announcements SET active = ? WHERE id = ?', [active ? 1 : 0, parseInt(id, 10)]);
}

async function deleteAnnouncement(id) {
    await assertPool().query('DELETE FROM panel_announcements WHERE id = ?', [parseInt(id, 10)]);
}

async function logAudit({ actorId = null, actorName = null, action, targetType = null, targetId = null, details = null, ip = null }) {
    try {
        await assertPool().query(
            'INSERT INTO panel_audit_log (actor_id, actor_name, action, target_type, target_id, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [actorId, actorName, String(action).slice(0, 64), targetType, targetId === null || targetId === undefined ? null : String(targetId).slice(0, 128),
                details === null || details === undefined ? null : (typeof details === 'string' ? details : JSON.stringify(details)).slice(0, 4000),
                ip ? String(ip).slice(0, 64) : null]
        );
    } catch (e) {
        console.error('[Audit] write failed:', e.message);
    }
}

async function listAudit({ limit = 100, offset = 0, action = null, actorId = null } = {}) {
    const where = [];
    const params = [];
    if (action) { where.push('action LIKE ?'); params.push(`${String(action).replace(/[%_]/g, '')}%`); }
    if (actorId) { where.push('actor_id = ?'); params.push(parseInt(actorId, 10)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await assertPool().query(
        `SELECT * FROM panel_audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
        [...params, Math.min(parseInt(limit, 10) || 100, 500), Math.max(parseInt(offset, 10) || 0, 0)]
    );
    const [count] = await assertPool().query(`SELECT COUNT(*) AS total FROM panel_audit_log ${clause}`, params);
    return { entries: rows, total: count[0].total };
}

// ============================================================================
//  Counters used by billing rules
// ============================================================================

async function countFreeServersGlobal() {
    const [rows] = await assertPool().query("SELECT COUNT(*) AS count FROM panel_servers s JOIN panel_plans p ON p.slug = s.plan_type WHERE p.is_trial = 1 AND s.is_pool = 0");
    return rows[0].count;
}

async function countTrialUsesForUser(userId) {
    const [rows] = await assertPool().query(
        "SELECT COUNT(*) AS count FROM panel_transactions WHERE user_id = ? AND type = 'trial'",
        [userId]
    );
    return rows[0].count;
}

// ============================================================================
//  Settings
// ============================================================================

async function getSetting(key) {
    const [rows] = await assertPool().query('SELECT `value` FROM panel_settings WHERE `key` = ? LIMIT 1', [key]);
    return rows[0] ? rows[0].value : null;
}

async function getSettingsMap(keys = null) {
    const [rows] = keys && keys.length
        ? await assertPool().query(`SELECT \`key\`, \`value\` FROM panel_settings WHERE \`key\` IN (${keys.map(() => '?').join(',')})`, keys)
        : await assertPool().query('SELECT `key`, `value` FROM panel_settings');
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    return map;
}

async function setSetting(key, value) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(String(key))) throw httpError(400, 'Geçersiz ayar anahtarı.');
    await assertPool().query(
        'INSERT INTO panel_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
        [key, String(value)]
    );
    return true;
}

async function listAllSettings() {
    const [rows] = await assertPool().query('SELECT * FROM panel_settings ORDER BY `key` ASC');
    return rows;
}

async function createSetting(key, value, name, type, description, options) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(String(key))) throw httpError(400, 'Geçersiz ayar anahtarı.');
    if (!['text', 'number', 'textarea', 'select'].includes(type)) throw httpError(400, 'Geçersiz ayar tipi.');
    try {
        await assertPool().query(
            'INSERT INTO panel_settings (`key`, `value`, `name`, `type`, `description`, `options`) VALUES (?, ?, ?, ?, ?, ?)',
            [key, value, name, type, description, options]
        );
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') throw httpError(409, 'Bu ayar anahtarı zaten var.');
        throw e;
    }
    return true;
}

async function updateSetting(key, fields) {
    const allowedFields = ['value', 'name', 'type', 'description', 'options'];
    const updateParts = [];
    const values = [];
    for (const field of allowedFields) {
        if (fields[field] !== undefined) {
            updateParts.push(`\`${field}\` = ?`);
            values.push(fields[field]);
        }
    }
    if (!updateParts.length) return false;
    values.push(key);
    await assertPool().query(`UPDATE panel_settings SET ${updateParts.join(', ')} WHERE \`key\` = ?`, values);
    return true;
}

async function deleteSetting(key) {
    await assertPool().query('DELETE FROM panel_settings WHERE `key` = ?', [key]);
    return true;
}

function isSystemSettingKey(key) {
    return DEFAULT_SETTINGS.some(([k]) => k === key);
}

// ============================================================================
//  Admin user management
// ============================================================================

async function listAllUsers({ search = '', limit = 200, offset = 0 } = {}) {
    const params = [];
    let where = '';
    if (search) {
        where = 'WHERE u.username LIKE ? OR u.email LIKE ?';
        const term = `%${String(search).replace(/[%_]/g, '')}%`;
        params.push(term, term);
    }
    const [rows] = await assertPool().query(
        `SELECT u.id, u.username, u.email, u.role, u.balance, u.suspended, u.created_at, u.last_login_at, u.last_login_ip,
                u.locked_until, u.admin_note,
                (SELECT COUNT(*) FROM panel_servers s WHERE s.owner_id = u.id AND s.is_pool = 0) AS server_count
         FROM panel_users u ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
        [...params, Math.min(parseInt(limit, 10) || 200, 1000), Math.max(parseInt(offset, 10) || 0, 0)]
    );
    return rows.map(r => ({ ...r, balance: money(r.balance), suspended: !!r.suspended }));
}

async function countAdmins(excludeId = null) {
    const [rows] = await assertPool().query(
        "SELECT COUNT(*) AS c FROM panel_users WHERE role = 'admin' AND suspended = 0 AND id <> ?",
        [excludeId || 0]
    );
    return rows[0].c;
}

async function updateUserAdmin(userId, fields, docker = null) {
    const id = parseInt(userId, 10);
    const current = await getUserById(id);
    if (!current) throw httpError(404, 'Kullanıcı bulunamadı.');
    const sets = [];
    const params = [];
    if (fields.username !== undefined && fields.username !== current.username) {
        const name = normalizeUsername(fields.username);
        const [dupe] = await assertPool().query('SELECT id FROM panel_users WHERE username = ? AND id <> ?', [name, id]);
        if (dupe.length) throw httpError(409, 'Bu kullanıcı adı zaten alınmış.');
        sets.push('username = ?'); params.push(name);
    }
    if (fields.email !== undefined) {
        const mail = normalizeEmail(fields.email, { required: false });
        if (mail) {
            const [dupe] = await assertPool().query('SELECT id FROM panel_users WHERE email = ? AND id <> ?', [mail, id]);
            if (dupe.length) throw httpError(409, 'Bu e-posta başka bir hesapta kullanılıyor.');
        }
        sets.push('email = ?'); params.push(mail);
    }
    if (fields.role !== undefined && fields.role !== current.role) {
        if (!['admin', 'user'].includes(fields.role)) throw httpError(400, 'Geçersiz rol.');
        if (current.role === 'admin' && (await countAdmins(id)) === 0) throw httpError(409, 'Son yönetici hesabının rolü değiştirilemez.');
        sets.push('role = ?', 'token_version = token_version + 1'); params.push(fields.role);
    }
    if (fields.suspended !== undefined) {
        const suspended = fields.suspended ? 1 : 0;
        if (suspended && current.role === 'admin' && (await countAdmins(id)) === 0) throw httpError(409, 'Son yönetici hesabı askıya alınamaz.');
        sets.push('suspended = ?'); params.push(suspended);
        if (suspended) sets.push('token_version = token_version + 1');
    }
    if (fields.admin_note !== undefined) { sets.push('admin_note = ?'); params.push(String(fields.admin_note || '').slice(0, 500) || null); }
    if (fields.unlock) sets.push('locked_until = NULL', 'failed_logins = 0');
    if (sets.length) {
        params.push(id);
        await assertPool().query(`UPDATE panel_users SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    if (fields.suspended && docker) {
        const servers = await listServersForUser({ id, role: 'user' });
        for (const s of servers) {
            try { await docker.getContainer(s.container_id).stop({ t: 3 }); } catch (_) { /* already stopped */ }
        }
    }
    return getUserById(id);
}

async function deleteUserAdmin(userId, docker) {
    const id = parseInt(userId, 10);
    const user = await getUserById(id);
    if (!user) throw httpError(404, 'Kullanıcı bulunamadı.');
    if (user.role === 'admin' && (await countAdmins(id)) === 0) throw httpError(409, 'Son yönetici hesabı silinemez.');
    if (id === (await getPoolOwnerId())) throw httpError(409, 'Havuz sunucularının sahibi olan yönetici hesabı silinemez.');

    const servers = await listServersForUser({ id, role: 'user' });
    const { isProtectedPort } = require('./serverProtection');
    const protectedServer = servers.find(server => isProtectedPort(server.port));
    if (protectedServer) {
        throw httpError(409, `Kullanıcı korumalı ${protectedServer.port} portuna sahip; silme iptal edildi.`);
    }
    const lifecycle = require('./lifecycleService');
    for (const s of servers) {
        await lifecycle.destroyServerResources(docker, s).catch(err => console.log(`User deletion cleanup warning: ${err.message}`));
    }
    await assertPool().query('DELETE FROM panel_users WHERE id = ?', [id]);
    return true;
}

// ============================================================================
//  Init
// ============================================================================

async function init(docker = null) {
    if (initialized) return;
    await ensureBaseSchema();
    await runMigrations();
    await seedSettings();
    await initTokenSecret();
    await seedUsers();
    if (docker) {
        try {
            await require('./poolService').ensurePool(docker);
        } catch (e) {
            console.error('[Pool Service] initial reconciliation failed:', e.message);
        }
    }
    initialized = true;
}

async function close() {
    if (pool) await pool.end().catch(() => {});
    pool = null;
    initialized = false;
}

module.exports = {
    // lifecycle
    init, close, assertPool, withTransaction, httpError, money,
    // auth
    makeToken, verifyToken, hashPassword, verifyPassword, validatePasswordStrength,
    createAuthHandoff, consumeAuthHandoff, cleanupAuthHandoffs,
    authenticate, createUser, changePassword, setPassword, updateProfile, revokeSessions,
    createPasswordReset, consumePasswordReset, publicUser,
    getUserById, getUserByUsername, getAdminUser, getPoolOwnerId,
    // servers
    getServerByContainerId, getServerByPort, getServerById, listServersForUser, listUnrentedPoolServers,
    upsertServerRecord, updateServerContainer, deleteServerRecord, canAccessServer,
    requireServerAccess, requirePortAccess, adoptContainer,
    extractServerPortFromInspect, getEnvValue, buildServerResources,
    // sql
    ensureSqlAccount, provisionSqlForRecord, dropSqlAccount, rotateSqlPassword,
    listSqlResourcesForUser, sqlResourceFromRecord, canAccessDatabase, validateSqlName,
    // billing
    adjustBalance, listTransactions, depositReferenceCode,
    createPaymentReport, listPayments, getPendingPayments, getUserPayments, getPaymentByReceiptPath,
    approvePayment, rejectPayment,
    listPlans, getPlan, createPlan, updatePlan, deletePlan,
    listCoupons, createCoupon, setCouponActive, deleteCoupon, resolveCoupon, redeemCoupon,
    countFreeServersGlobal, countTrialUsesForUser,
    // comms
    notify, notifyAdmins, listNotifications, markNotificationsRead,
    listAnnouncements, createAnnouncement, setAnnouncementActive, deleteAnnouncement,
    logAudit, listAudit,
    // settings
    getSetting, getSettingsMap, setSetting, listAllSettings, createSetting, updateSetting, deleteSetting, isSystemSettingKey,
    getKv, setKv,
    // admin users
    listAllUsers, updateUserAdmin, deleteUserAdmin, countAdmins
};

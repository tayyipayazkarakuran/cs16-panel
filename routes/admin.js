// Operator tooling. Every route here requires the admin role and every
// state-changing action is written to the audit log.
const express = require('express');
const cfg = require('../config');
const security = require('../security');
const billing = require('../billingService');
const gameContainer = require('../gameContainer');
const queryHelper = require('../queryHelper');
const poolService = require('../poolService');
const lifecycle = require('../lifecycleService');
const { isProtectedPort, assertDestructiveOperationAllowed } = require('../serverProtection');

const router = express.Router();

router.use((req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Bu işlem için yönetici yetkisi gerekir.' });
    }
    next();
});

function sendError(res, e) {
    const status = e.statusCode || 500;
    if (status >= 500) console.error('[Admin]', e);
    res.status(status).json({ error: e.message });
}

function audit(req, action, targetType, targetId, details = null) {
    return req.panelDb.logAudit({
        actorId: req.user.id, actorName: req.user.username, action, targetType, targetId, details, ip: security.clientIp(req)
    });
}

function badRequest(message) {
    const e = new Error(message);
    e.statusCode = 400;
    return e;
}

const INFRA_CONTAINERS = ['cs-panel', 'cs-mysql', cfg.php.containerName, 'cs-fastdl'];
const RESTARTABLE = new Set([cfg.php.containerName, 'cs-fastdl']);

async function infraStatus(docker) {
    let containers = [];
    try { containers = await docker.listContainers({ all: true }); } catch (_) { /* docker unavailable */ }
    return INFRA_CONTAINERS.map(name => {
        const c = containers.find(x => (x.Names || []).includes(`/${name}`));
        return { name, found: !!c, state: c ? c.State : 'missing', status: c ? c.Status : 'Bulunamadı', image: c ? c.Image : null, restartable: RESTARTABLE.has(name) };
    });
}

// ---------------------------------------------------------------------------
//  Overview dashboard
// ---------------------------------------------------------------------------

router.get('/overview', async (req, res) => {
    try {
        const db = req.panelDb.assertPool();
        const q = async (sql, params = []) => (await db.query(sql, params))[0];
        const [
            users, servers, revenue, pending, plans, expiring, recentUsers, recentAudit, infra, pool, containers
        ] = await Promise.all([
            q(`SELECT COUNT(*) AS total,
                      SUM(created_at >= NOW() - INTERVAL 7 DAY) AS new7d,
                      SUM(suspended = 1) AS suspended,
                      SUM(last_login_at >= NOW() - INTERVAL 1 DAY) AS active24h,
                      COALESCE(SUM(balance), 0) AS totalBalance
               FROM panel_users WHERE role = 'user'`),
            q(`SELECT COUNT(*) AS total,
                      SUM(is_pool = 0) AS rented,
                      SUM(is_pool = 1) AS pool,
                      SUM(suspended = 1) AS suspended,
                      SUM(is_pool = 0 AND auto_renew = 1) AS autoRenew
               FROM panel_servers`),
            q(`SELECT COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL 30 DAY THEN -amount END), 0) AS sales30d,
                      COALESCE(SUM(-amount), 0) AS salesTotal,
                      COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL 1 DAY THEN -amount END), 0) AS sales24h
               FROM panel_transactions WHERE type IN ('purchase', 'renewal')`),
            q(`SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM panel_payments WHERE status = 'pending'`),
            q(`SELECT s.plan_type AS plan, COUNT(*) AS count FROM panel_servers s WHERE s.is_pool = 0 GROUP BY s.plan_type`),
            q(`SELECT s.container_id, s.port, s.name, s.expires_at, s.auto_renew, u.username
               FROM panel_servers s JOIN panel_users u ON u.id = s.owner_id
               WHERE s.is_pool = 0 AND u.role = 'user' AND s.suspended = 0 AND s.expires_at <= NOW() + INTERVAL 7 DAY
               ORDER BY s.expires_at ASC LIMIT 10`),
            q(`SELECT id, username, email, created_at, balance FROM panel_users ORDER BY id DESC LIMIT 6`),
            q(`SELECT * FROM panel_audit_log ORDER BY id DESC LIMIT 12`),
            infraStatus(req.docker),
            poolService.getPoolPorts(),
            req.docker.listContainers({ all: true }).catch(() => [])
        ]);
        const deposits = await q(`SELECT DATE(created_at) AS day, SUM(-amount) AS amount FROM panel_transactions
                                  WHERE type IN ('purchase','renewal') AND created_at >= CURDATE() - INTERVAL 13 DAY
                                  GROUP BY DATE(created_at) ORDER BY day`);
        const gameContainers = containers.filter(c => (c.Names || []).some(n => /cs16-server-\d+$/.test(n)));
        res.json({
            users: users[0],
            servers: { ...servers[0], running: gameContainers.filter(c => c.State === 'running').length, containers: gameContainers.length },
            revenue: revenue[0],
            salesByDay: deposits,
            pendingPayments: pending[0],
            planDistribution: plans,
            expiringSoon: expiring,
            recentUsers,
            recentAudit,
            infra,
            poolPorts: pool
        });
    } catch (e) {
        sendError(res, e);
    }
});

// ---------------------------------------------------------------------------
//  Users
// ---------------------------------------------------------------------------

router.get('/users', async (req, res) => {
    try {
        res.json({ success: true, users: await req.panelDb.listAllUsers({ search: req.query.search || '', limit: req.query.limit || 500 }) });
    } catch (e) {
        sendError(res, e);
    }
});

router.get('/users/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const user = await req.panelDb.getUserById(id);
        if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
        const db = req.panelDb.assertPool();
        const [[extra]] = await db.query('SELECT admin_note, locked_until, failed_logins FROM panel_users WHERE id = ?', [id]);
        const [servers, txs, payments, auditLog] = await Promise.all([
            req.panelDb.listServersForUser({ id, role: 'user' }),
            req.panelDb.listTransactions({ userId: id, limit: 30 }),
            req.panelDb.listPayments({ userId: id, limit: 20 }),
            req.panelDb.listAudit({ actorId: id, limit: 20 })
        ]);
        res.json({
            user: { ...req.panelDb.publicUser(user), last_login_ip: user.last_login_ip, ...extra },
            servers: servers.map(s => ({ id: s.container_id, port: s.port, name: s.name, plan_type: s.plan_type, expires_at: s.expires_at, suspended: !!s.suspended, auto_renew: !!s.auto_renew })),
            transactions: txs.transactions,
            payments,
            audit: auditLog.entries
        });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/users', async (req, res) => {
    try {
        const { username, password, role = 'user', balance = 0, email = null } = req.body || {};
        const user = await req.panelDb.createUser(username, password, { email, role, balance: 0 });
        const amount = parseFloat(balance) || 0;
        if (amount > 0) {
            await req.panelDb.withTransaction(conn => req.panelDb.adjustBalance(conn, user.id, amount, {
                type: 'adjustment', description: 'Hesap açılışı başlangıç bakiyesi', actorId: req.user.id
            }));
        }
        await audit(req, 'user.create', 'user', user.id, { username: user.username, role });
        res.status(201).json({ success: true, message: 'Kullanıcı oluşturuldu.', user: req.panelDb.publicUser(user) });
    } catch (e) {
        sendError(res, e);
    }
});

router.put('/users/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const body = req.body || {};
        if (id === req.user.id && (body.role === 'user' || body.suspended)) {
            return res.status(400).json({ error: 'Kendi yönetici yetkinizi kaldıramaz veya hesabınızı askıya alamazsınız.' });
        }
        const fields = {};
        ['username', 'email', 'role', 'suspended', 'admin_note', 'unlock'].forEach(k => {
            if (body[k] !== undefined) fields[k] = k === 'suspended' ? !!body[k] && body[k] !== 'false' : body[k];
        });
        const updated = await req.panelDb.updateUserAdmin(id, fields, req.docker);
        await audit(req, 'user.update', 'user', id, fields);
        res.json({ success: true, user: req.panelDb.publicUser(updated) });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/users/:id/balance', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const amount = Math.round(parseFloat(req.body && req.body.amount) * 100) / 100;
        const reason = String((req.body && req.body.reason) || '').trim();
        if (!amount || !Number.isFinite(amount) || Math.abs(amount) > 1000000) throw badRequest('Geçerli bir tutar girin (eksi değer bakiyeden düşer).');
        if (!reason) throw badRequest('Bakiye düzeltmesi için açıklama zorunludur.');
        const after = await req.panelDb.withTransaction(conn => req.panelDb.adjustBalance(conn, id, amount, {
            type: amount > 0 ? 'adjustment' : 'charge', description: reason, actorId: req.user.id
        }));
        await audit(req, 'user.balance', 'user', id, { amount, reason });
        await req.panelDb.notify(id, {
            type: amount > 0 ? 'success' : 'warning',
            title: amount > 0 ? 'Bakiyenize ekleme yapıldı' : 'Bakiyenizden düşüm yapıldı',
            body: `${Math.abs(amount).toFixed(2)} · ${reason}`,
            link: '#/billing'
        });
        res.json({ success: true, balance: after });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/users/:id/reset-link', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const user = await req.panelDb.getUserById(id);
        if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
        const reset = await req.panelDb.createPasswordReset(id, req.user.id);
        const origin = `${req.protocol}://${req.get('host')}`;
        await audit(req, 'user.reset_link', 'user', id);
        res.json({
            success: true,
            url: `${origin}/#/reset?token=${encodeURIComponent(reset.token)}`,
            expiresInHours: Math.round(reset.expiresIn / 3600)
        });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/users/:id/logout', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        await req.panelDb.revokeSessions(id);
        await audit(req, 'user.force_logout', 'user', id);
        res.json({ success: true, message: 'Kullanıcının tüm oturumları kapatıldı.' });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/users/:id/stop-servers', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const servers = await req.panelDb.listServersForUser({ id, role: 'user' });
        let stopped = 0;
        for (const s of servers) {
            try {
                const container = req.docker.getContainer(s.container_id);
                const info = await container.inspect();
                if (info.State.Running) { await container.stop({ t: 5 }); stopped++; }
            } catch (_) { /* already stopped / missing */ }
        }
        await audit(req, 'user.stop_servers', 'user', id, { stopped });
        res.json({ success: true, message: `${stopped} sunucu durduruldu.` });
    } catch (e) {
        sendError(res, e);
    }
});

router.delete('/users/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (id === req.user.id) return res.status(400).json({ error: 'Kendi hesabınızı silemezsiniz.' });
        await req.panelDb.deleteUserAdmin(id, req.docker);
        await audit(req, 'user.delete', 'user', id);
        res.json({ success: true, message: 'Kullanıcı ve tüm kaynakları silindi.' });
    } catch (e) {
        sendError(res, e);
    }
});

// ---------------------------------------------------------------------------
//  Servers
// ---------------------------------------------------------------------------

async function loadServer(req) {
    const record = await req.panelDb.getServerByContainerId(req.params.id);
    if (!record) {
        const e = new Error('Sunucu bulunamadı.');
        e.statusCode = 404;
        throw e;
    }
    return record;
}

router.post('/servers/:id/extend', async (req, res) => {
    try {
        const record = await loadServer(req);
        const days = parseInt(req.body && req.body.days, 10);
        if (!days || Math.abs(days) > 3650) throw badRequest('Gün sayısı -3650 ile 3650 arasında olmalı.');
        const base = new Date(record.expires_at) > new Date() ? new Date(record.expires_at) : new Date();
        const expiresAt = new Date(base.getTime() + days * 86400000);
        const fields = { expires_at: expiresAt, expiry_notice_stage: 0 };
        if (record.suspended && record.suspended_reason === 'expired' && expiresAt > new Date()) {
            fields.suspended = 0;
            fields.suspended_reason = null;
        }
        await req.panelDb.updateServerContainer(record.container_id, fields);
        if (fields.suspended === 0) {
            try { await req.docker.getContainer(record.container_id).start(); } catch (_) { /* running */ }
        }
        await audit(req, 'server.extend', 'server', record.port, { days, reason: req.body.reason || null });
        if (!record.is_pool && record.owner_role !== 'admin') {
            await req.panelDb.notify(record.owner_id, {
                type: 'success',
                title: `Port ${record.port} süresi güncellendi`,
                body: `Yeni bitiş: ${expiresAt.toLocaleDateString('tr-TR')}${req.body.reason ? ` · ${String(req.body.reason).slice(0, 200)}` : ''}`,
                link: `#/servers/${record.container_id}`
            });
        }
        res.json({ success: true, expires_at: expiresAt });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/servers/:id/suspend', async (req, res) => {
    try {
        const record = await loadServer(req);
        const reason = String((req.body && req.body.reason) || 'admin').slice(0, 200);
        await req.panelDb.updateServerContainer(record.container_id, { suspended: 1, suspended_reason: reason === 'expired' ? 'admin' : reason });
        try { await req.docker.getContainer(record.container_id).stop({ t: 5 }); } catch (_) { /* stopped */ }
        await audit(req, 'server.suspend', 'server', record.port, { reason });
        if (!record.is_pool) {
            await req.panelDb.notify(record.owner_id, { type: 'danger', title: `Port ${record.port} askıya alındı`, body: reason, link: `#/servers/${record.container_id}` });
        }
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/servers/:id/unsuspend', async (req, res) => {
    try {
        const record = await loadServer(req);
        if (record.suspended_reason === 'expired' && new Date(record.expires_at) < new Date()) {
            throw badRequest('Süresi dolmuş sunucuyu açmak için önce süreyi uzatın.');
        }
        await req.panelDb.updateServerContainer(record.container_id, { suspended: 0, suspended_reason: null });
        try { await req.docker.getContainer(record.container_id).start(); } catch (_) { /* running */ }
        await audit(req, 'server.unsuspend', 'server', record.port);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/servers/:id/transfer', async (req, res) => {
    try {
        const record = await loadServer(req);
        const target = await req.panelDb.getUserById(parseInt(req.body && req.body.userId, 10));
        if (!target) throw badRequest('Hedef kullanıcı bulunamadı.');
        await req.panelDb.updateServerContainer(record.container_id, { owner_id: target.id, is_pool: 0 });
        await audit(req, 'server.transfer', 'server', record.port, { from: record.owner_id, to: target.id });
        await req.panelDb.notify(target.id, { type: 'info', title: `Port ${record.port} hesabınıza aktarıldı`, link: `#/servers/${record.container_id}` });
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/servers/:id/plan', async (req, res) => {
    try {
        const record = await loadServer(req);
        const plan = await req.panelDb.getPlan(req.body && req.body.plan);
        if (!plan) throw badRequest('Paket bulunamadı.');
        const oldPlan = await req.panelDb.getPlan(record.plan_type);
        await req.panelDb.updateServerContainer(record.container_id, { plan_type: plan.slug });
        let updated = await req.panelDb.getServerByContainerId(record.container_id);
        if (!oldPlan || oldPlan.max_players !== plan.max_players) {
            updated = await billing.recreateContainerKeepingData(req.docker, updated, { maxPlayers: plan.max_players });
        }
        await audit(req, 'server.plan', 'server', record.port, { from: record.plan_type, to: plan.slug });
        res.json({ success: true, containerId: updated.container_id });
    } catch (e) {
        sendError(res, e);
    }
});

// Wipe the server and return its port to the rental pool.
router.post('/servers/:id/release', async (req, res) => {
    try {
        const record = await loadServer(req);
        assertDestructiveOperationAllowed(record.port, 'released');
        const errors = await lifecycle.destroyServerResources(req.docker, record);
        const report = await poolService.ensurePool(req.docker);
        await audit(req, 'server.release', 'server', record.port);
        if (!record.is_pool && record.owner_role !== 'admin') {
            await req.panelDb.notify(record.owner_id, { type: 'danger', title: `Port ${record.port} kaldırıldı`, body: 'Sunucu yönetici tarafından havuza geri alındı.' });
        }
        res.json({ success: true, cleanupErrors: errors, pool: report });
    } catch (e) {
        sendError(res, e);
    }
});

// Start/stop/restart many servers or broadcast an in-game message.
router.post('/servers/bulk', async (req, res) => {
    try {
        const { action, ids, message } = req.body || {};
        if (!['start', 'stop', 'restart', 'say'].includes(action)) throw badRequest('Geçersiz toplu işlem.');
        if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw badRequest('Sunucu seçin.');
        const text = String(message || '').replace(/["\r\n;]/g, '').slice(0, 150);
        if (action === 'say' && !text) throw badRequest('Mesaj boş olamaz.');
        const results = [];
        for (const id of ids) {
            try {
                const record = await req.panelDb.getServerByContainerId(String(id));
                if (!record) throw new Error('bulunamadı');
                const container = req.docker.getContainer(record.container_id);
                if (action === 'say') {
                    const info = await container.inspect();
                    await queryHelper.sendRconCommand(queryHelper.getServerIp(info), record.port, record.rcon_password || '', `say "${text}"`);
                } else {
                    try { await container[action]({ t: 10 }); } catch (err) { if (err.statusCode !== 304) throw err; }
                }
                results.push({ port: record.port, ok: true });
            } catch (err) {
                results.push({ id, ok: false, error: err.message });
            }
        }
        await audit(req, `server.bulk_${action}`, 'server', ids.length, { ok: results.filter(r => r.ok).length });
        res.json({ success: true, results });
    } catch (e) {
        sendError(res, e);
    }
});

// ---------------------------------------------------------------------------
//  Pool & infrastructure
// ---------------------------------------------------------------------------

router.get('/pool', async (req, res) => {
    try {
        const ports = await poolService.getPoolPorts();
        const [rows] = await req.panelDb.assertPool().query(
            'SELECT s.port, s.is_pool, s.container_id, s.name, u.username AS owner FROM panel_servers s JOIN panel_users u ON u.id = s.owner_id'
        );
        const containers = await req.docker.listContainers({ all: true }).catch(() => []);
        const byPort = new Map(rows.map(r => [r.port, r]));
        res.json({
            ports: ports.map(port => {
                const r = byPort.get(port);
                const c = r && containers.find(x => x.Id === r.container_id);
                return {
                    port,
                    protected: isProtectedPort(port),
                    status: !r ? 'missing' : (r.is_pool ? 'available' : 'rented'),
                    owner: r && !r.is_pool ? r.owner : null,
                    containerState: c ? c.State : 'missing'
                };
            })
        });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/pool/ensure', async (req, res) => {
    try {
        const report = await poolService.ensurePool(req.docker);
        await audit(req, 'pool.ensure', 'pool', null, report);
        res.json({ success: true, report });
    } catch (e) {
        sendError(res, e);
    }
});

router.get('/infra', async (req, res) => {
    try {
        let mysqlVersion = null;
        try {
            const [rows] = await req.panelDb.assertPool().query('SELECT VERSION() AS v');
            mysqlVersion = rows[0].v;
        } catch (_) { /* reported as offline */ }
        res.json({
            containers: await infraStatus(req.docker),
            mysql: { online: !!mysqlVersion, version: mysqlVersion, internal: cfg.mysqlEndpoints().internal, external: cfg.mysqlEndpoints().external },
            fastdl: { baseUrl: cfg.fastdlBaseUrl(), path: cfg.fastdl.path },
            php: { baseUrl: cfg.php.publicBaseUrl, path: cfg.php.wwwPath },
            node: process.version,
            uptimeSeconds: Math.round(process.uptime())
        });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/infra/:name/restart', async (req, res) => {
    try {
        const name = req.params.name;
        if (!RESTARTABLE.has(name)) throw badRequest('Bu servis panelden yeniden başlatılamaz.');
        const containers = await req.docker.listContainers({ all: true });
        const c = containers.find(x => (x.Names || []).includes(`/${name}`));
        if (!c) return res.status(404).json({ error: 'Konteyner bulunamadı.' });
        await req.docker.getContainer(c.Id).restart();
        await audit(req, 'infra.restart', 'container', name);
        res.json({ success: true, message: `${name} yeniden başlatıldı.` });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/lifecycle/run', async (req, res) => {
    try {
        await lifecycle.runLifecycle(req.docker);
        await audit(req, 'lifecycle.run', 'system', null);
        res.json({ success: true, message: 'Süre kontrolü çalıştırıldı.' });
    } catch (e) {
        sendError(res, e);
    }
});

// ---------------------------------------------------------------------------
//  Plans, coupons, announcements, transactions, audit
// ---------------------------------------------------------------------------

router.get('/plans', async (req, res) => {
    try {
        const plans = await req.panelDb.listPlans({ activeOnly: false });
        const [usage] = await req.panelDb.assertPool().query('SELECT plan_type, COUNT(*) AS c FROM panel_servers WHERE is_pool = 0 GROUP BY plan_type');
        const counts = new Map(usage.map(u => [u.plan_type, u.c]));
        res.json({ plans: plans.map(p => ({ ...p, servers: counts.get(p.slug) || 0 })), periodDiscounts: await billing.getPeriodDiscounts() });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/plans', async (req, res) => {
    try {
        const plan = await req.panelDb.createPlan(req.body || {});
        await audit(req, 'plan.create', 'plan', plan.slug, req.body);
        res.status(201).json({ success: true, plan });
    } catch (e) {
        sendError(res, e);
    }
});

router.put('/plans/:id', async (req, res) => {
    try {
        const plan = await req.panelDb.updatePlan(req.params.id, req.body || {});
        await audit(req, 'plan.update', 'plan', plan.slug, req.body);
        res.json({ success: true, plan });
    } catch (e) {
        sendError(res, e);
    }
});

router.delete('/plans/:id', async (req, res) => {
    try {
        await req.panelDb.deletePlan(req.params.id);
        await audit(req, 'plan.delete', 'plan', req.params.id);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.get('/coupons', async (req, res) => {
    try {
        res.json({ coupons: await req.panelDb.listCoupons() });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/coupons', async (req, res) => {
    try {
        await req.panelDb.createCoupon(req.body || {});
        await audit(req, 'coupon.create', 'coupon', req.body && req.body.code, req.body);
        res.status(201).json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.put('/coupons/:id', async (req, res) => {
    try {
        await req.panelDb.setCouponActive(req.params.id, !!(req.body && req.body.active));
        await audit(req, 'coupon.update', 'coupon', req.params.id, req.body);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.delete('/coupons/:id', async (req, res) => {
    try {
        await req.panelDb.deleteCoupon(req.params.id);
        await audit(req, 'coupon.delete', 'coupon', req.params.id);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.get('/announcements', async (req, res) => {
    try {
        res.json({ announcements: await req.panelDb.listAnnouncements({ activeOnly: false }) });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/announcements', async (req, res) => {
    try {
        const body = req.body || {};
        const id = await req.panelDb.createAnnouncement({ title: body.title, body: body.body, level: body.level, expiresAt: body.expires_at, createdBy: req.user.id });
        if (body.notify === true || body.notify === 'true') {
            const [users] = await req.panelDb.assertPool().query('SELECT id FROM panel_users WHERE suspended = 0');
            for (const u of users) {
                await req.panelDb.notify(u.id, { type: body.level === 'danger' ? 'danger' : (body.level || 'info'), title: String(body.title).slice(0, 160), body: body.body });
            }
        }
        await audit(req, 'announcement.create', 'announcement', id, { title: body.title });
        res.status(201).json({ success: true, id });
    } catch (e) {
        sendError(res, e);
    }
});

router.put('/announcements/:id', async (req, res) => {
    try {
        await req.panelDb.setAnnouncementActive(req.params.id, !!(req.body && req.body.active));
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.delete('/announcements/:id', async (req, res) => {
    try {
        await req.panelDb.deleteAnnouncement(req.params.id);
        await audit(req, 'announcement.delete', 'announcement', req.params.id);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.get('/transactions', async (req, res) => {
    try {
        res.json(await req.panelDb.listTransactions({ limit: req.query.limit || 100, offset: req.query.offset || 0, type: req.query.type || null }));
    } catch (e) {
        sendError(res, e);
    }
});

router.get('/audit', async (req, res) => {
    try {
        res.json(await req.panelDb.listAudit({ limit: req.query.limit || 100, offset: req.query.offset || 0, action: req.query.action || null }));
    } catch (e) {
        sendError(res, e);
    }
});

// ---------------------------------------------------------------------------
//  System settings
// ---------------------------------------------------------------------------

router.get('/settings', async (req, res) => {
    try {
        const all = await req.panelDb.listAllSettings();
        res.json({
            success: true,
            allSettings: all.map(s => ({ ...s, system: req.panelDb.isSystemSettingKey(s.key) }))
        });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/settings', async (req, res) => {
    try {
        const { key, value, name, type, description, options } = req.body || {};
        if (!key) return res.status(400).json({ error: 'Ayar anahtarı zorunludur.' });
        await req.panelDb.createSetting(String(key).trim(), value || '', name || key, type || 'text', description || '', options || null);
        await audit(req, 'setting.create', 'setting', key);
        res.json({ success: true, message: 'Ayar oluşturuldu.' });
    } catch (e) {
        sendError(res, e);
    }
});

// PUT /api/admin/settings — batch update values (only existing keys)
router.put('/settings', async (req, res) => {
    try {
        const body = req.body || {};
        const existing = new Set((await req.panelDb.listAllSettings()).map(s => s.key));
        const changed = [];
        for (const [key, value] of Object.entries(body)) {
            if (!existing.has(key) || value === undefined || value === null) continue;
            if (key === 'pool_ports' && !poolService.parsePoolPorts(value).length) throw badRequest('Havuz portları geçersiz.');
            if (key === 'renewal_period_discounts' && String(value).trim() && !/^\s*\d+\s*:\s*\d+(\.\d+)?(\s*,\s*\d+\s*:\s*\d+(\.\d+)?)*\s*$/.test(String(value))) {
                throw badRequest('Dönem indirimleri "ay:yüzde" biçiminde olmalı (örn. 3:5,6:10).');
            }
            await req.panelDb.setSetting(key, String(value).slice(0, 5000));
            changed.push(key);
        }
        await audit(req, 'setting.update', 'setting', changed.join(','));
        res.json({ success: true, message: 'Sistem ayarları güncellendi.' });
    } catch (e) {
        sendError(res, e);
    }
});

router.delete('/settings/:key', async (req, res) => {
    try {
        if (req.panelDb.isSystemSettingKey(req.params.key)) return res.status(400).json({ error: 'Sistem ayarları silinemez.' });
        await req.panelDb.deleteSetting(req.params.key);
        await audit(req, 'setting.delete', 'setting', req.params.key);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

module.exports = router;

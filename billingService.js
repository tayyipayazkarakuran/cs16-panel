// Subscription & paywall logic: price quotes, atomic rental, renewal and plan
// changes. Money only moves through panelDb.adjustBalance inside a DB
// transaction, and every provisioning failure after payment is compensated.
const crypto = require('crypto');
const panelDb = require('./panelDb');
const gameContainer = require('./gameContainer');
const fastdl = require('./fastdlService');
const phpSite = require('./phpSiteService');
const { PROTECTED_SERVER_PORTS, isProtectedPort } = require('./serverProtection');

const { httpError, money } = panelDb;
const ALLOWED_PERIODS = [1, 3, 6, 12];

function parsePeriodDiscounts(value) {
    const map = { 1: 0 };
    String(value || '').split(',').forEach(part => {
        const [m, pct] = part.split(':').map(s => parseFloat(String(s).trim()));
        if (ALLOWED_PERIODS.includes(m) && pct >= 0 && pct < 100) map[m] = pct;
    });
    return map;
}

async function getPeriodDiscounts() {
    return parsePeriodDiscounts(await panelDb.getSetting('renewal_period_discounts'));
}

function normalizeMonths(months) {
    const m = parseInt(months, 10) || 1;
    if (!ALLOWED_PERIODS.includes(m)) throw httpError(400, 'Geçersiz dönem. 1, 3, 6 veya 12 ay seçebilirsiniz.');
    return m;
}

/**
 * Compute the price of `months` periods of `plan`. Trial plans are always a
 * single free period. Returns every component so the UI can explain the total.
 */
async function quote({ plan, months = 1, couponCode = null, userId = null, conn = null }) {
    if (!plan) throw httpError(404, 'Paket bulunamadı.');
    const periods = plan.is_trial ? 1 : normalizeMonths(months);
    const discounts = await getPeriodDiscounts();
    const subtotal = money(plan.price * periods);
    const periodDiscountPct = plan.is_trial ? 0 : (discounts[periods] || 0);
    const periodDiscount = money(subtotal * periodDiscountPct / 100);
    let coupon = null;
    let couponDiscount = 0;
    if (couponCode && !plan.is_trial) {
        coupon = await panelDb.resolveCoupon(couponCode, { userId, planSlug: plan.slug, conn, lock: !!conn });
        const afterPeriod = subtotal - periodDiscount;
        couponDiscount = coupon.type === 'percent'
            ? money(afterPeriod * coupon.value / 100)
            : money(Math.min(coupon.value, afterPeriod));
    }
    const total = money(Math.max(0, subtotal - periodDiscount - couponDiscount));
    return {
        plan: { slug: plan.slug, name: plan.name, price: plan.price, duration_days: plan.duration_days, max_players: plan.max_players, is_trial: plan.is_trial },
        months: periods,
        days: plan.duration_days * periods,
        subtotal,
        periodDiscountPct,
        periodDiscount,
        coupon: coupon ? { code: coupon.code, type: coupon.type, value: coupon.value } : null,
        couponDiscount,
        total,
        _coupon: coupon
    };
}

function publicQuote(q) {
    const copy = { ...q };
    delete copy._coupon;
    return copy;
}

function validateRconPassword(value) {
    const pw = String(value || '').trim();
    if (!/^[A-Za-z0-9!@#$%^&*()_+\-=.,:?]{8,64}$/.test(pw)) {
        throw httpError(400, 'RCON şifresi 8-64 karakter olmalı; boşluk ve tırnak içeremez.');
    }
    return pw;
}

async function assertTrialAllowed(userId, conn) {
    const [used] = await conn.query("SELECT COUNT(*) AS c FROM panel_transactions WHERE user_id = ? AND type = 'trial'", [userId]);
    if (used[0].c > 0) throw httpError(409, 'Deneme paketini daha önce kullandınız. Lütfen ücretli bir paket seçin.');
    const limit = parseInt(await panelDb.getSetting('global_free_limit') || '0', 10);
    const [active] = await conn.query(
        'SELECT COUNT(*) AS c FROM panel_servers s JOIN panel_plans p ON p.slug = s.plan_type WHERE p.is_trial = 1 AND s.is_pool = 0'
    );
    if (active[0].c >= limit) throw httpError(409, 'Şu anda deneme sunucusu kontenjanı dolu. Lütfen daha sonra tekrar deneyin.');
}

/**
 * Rent a server from the always-on pool.
 *  1. One transaction locks the user and a free pool row, charges the
 *     balance, redeems the coupon and assigns ownership.
 *  2. The container is rebuilt from a clean volume with fresh credentials.
 *  3. If provisioning fails, the charge is refunded and the slot returned.
 */
async function rentServer(docker, user, input, { ip = null } = {}) {
    const plan = await panelDb.getPlan(input.plan);
    if (!plan || !plan.active) throw httpError(400, 'Lütfen geçerli bir paket seçin.');
    const rconPassword = validateRconPassword(input.rconPassword);
    const requestedPort = input.port ? parseInt(input.port, 10) : null;
    if (requestedPort && isProtectedPort(requestedPort)) throw httpError(409, `Port ${requestedPort} kiralamaya kapalı.`);
    const startMap = gameContainer.sanitizeMapName(input.map);
    const requestedName = gameContainer.sanitizeServerName(input.name, '');

    const purchase = await panelDb.withTransaction(async conn => {
        if (plan.is_trial) await assertTrialAllowed(user.id, conn);
        const q = await quote({ plan, months: input.months, couponCode: input.coupon, userId: user.id, conn });

        const protectedPorts = [...PROTECTED_SERVER_PORTS];
        const params = [];
        let sql = 'SELECT * FROM panel_servers WHERE is_pool = 1';
        if (protectedPorts.length) {
            sql += ` AND port NOT IN (${protectedPorts.map(() => '?').join(',')})`;
            params.push(...protectedPorts);
        }
        if (requestedPort) { sql += ' AND port = ?'; params.push(requestedPort); }
        sql += ' ORDER BY port ASC LIMIT 1 FOR UPDATE';
        const [rows] = await conn.query(sql, params);
        if (!rows[0]) {
            throw httpError(409, requestedPort
                ? `Port ${requestedPort} artık müsait değil. Lütfen başka bir sunucu seçin.`
                : 'Şu anda kiralanabilir boş sunucu yok. Lütfen daha sonra tekrar deneyin.');
        }
        const slot = rows[0];
        const name = requestedName || `CS 1.6 Server ${slot.port}`;

        if (q.total > 0) {
            await panelDb.adjustBalance(conn, user.id, -q.total, {
                type: 'purchase',
                description: `${plan.name} paketi · ${q.months} ay · port ${slot.port}`,
                referenceType: 'server', referenceId: slot.port, actorId: user.id
            });
        } else {
            await panelDb.adjustBalance(conn, user.id, 0, {
                type: plan.is_trial ? 'trial' : 'purchase',
                description: `${plan.name} paketi · port ${slot.port}`,
                referenceType: 'server', referenceId: slot.port, actorId: user.id
            });
        }
        if (q._coupon) {
            await panelDb.redeemCoupon(conn, q._coupon, { userId: user.id, serverPort: slot.port, discount: q.couponDiscount });
        }
        const expiresAt = new Date(Date.now() + q.days * 86400000);
        await conn.query(
            `UPDATE panel_servers SET owner_id = ?, plan_type = ?, name = ?, rcon_password = ?, expires_at = ?, is_pool = 0,
                suspended = 0, suspended_reason = NULL, auto_renew = 0, expiry_notice_stage = 0, rented_at = NOW(),
                last_renewed_at = NOW(), php_domain = NULL, db_password = ?
             WHERE id = ?`,
            [user.id, plan.slug, name, rconPassword, expiresAt, crypto.randomBytes(18).toString('base64url'), slot.id]
        );
        return { slot, quote: q, name, expiresAt };
    });

    const { slot, quote: q } = purchase;
    try {
        const record = await provisionFreshServer(docker, slot, { maxPlayers: plan.max_players, startMap });
        await panelDb.logAudit({ actorId: user.id, actorName: user.username, action: 'server.rent', targetType: 'server', targetId: slot.port, details: { plan: plan.slug, months: q.months, total: q.total }, ip });
        await panelDb.notify(user.id, {
            type: 'success',
            title: `Sunucunuz hazırlanıyor (port ${slot.port})`,
            body: `${plan.name} paketi aktif. Kurulum 30-60 saniye içinde tamamlanır.`,
            link: `#/servers/${record.container_id}`
        });
        return { record, quote: publicQuote(q) };
    } catch (error) {
        console.error(`[Rental] provisioning failed for port ${slot.port}:`, error);
        await compensateFailedRental(docker, user, slot, q).catch(e => console.error('[Rental] compensation failed:', e));
        throw httpError(500, 'Sunucu hazırlanırken bir hata oluştu. Ücret bakiyenize iade edildi, lütfen tekrar deneyin.');
    }
}

async function compensateFailedRental(docker, user, slot, q) {
    const poolOwner = await panelDb.getPoolOwnerId();
    await panelDb.withTransaction(async conn => {
        if (q.total > 0) {
            await panelDb.adjustBalance(conn, user.id, q.total, {
                type: 'refund', description: `Port ${slot.port} kurulumu başarısız oldu, otomatik iade`,
                referenceType: 'server', referenceId: slot.port
            });
        }
        await conn.query(
            `UPDATE panel_servers SET owner_id = ?, is_pool = 1, plan_type = 'free', name = ?, expires_at = '2035-01-01 00:00:00'
             WHERE id = ?`,
            [poolOwner, `CS 1.6 Server ${slot.port}`, slot.id]
        );
    });
    try { await require('./poolService').ensurePool(docker); } catch (_) { /* best effort */ }
}

/**
 * Wipe a slot and start a clean container for its (already updated) record.
 * Used by rental and by "clean reset".
 */
async function provisionFreshServer(docker, slot, { maxPlayers, startMap = 'de_dust2', keepVolume = false } = {}) {
    const record = await panelDb.getServerById(slot.id);
    await gameContainer.removeContainerQuietly(docker, record.container_id);
    if (!keepVolume) {
        await gameContainer.removeVolumeWithRetry(docker, record.port);
        await panelDb.dropSqlAccount(record.db_name, record.db_username).catch(() => {});
        fastdl.ensureCleanFastdlTree(record.port);
        phpSite.resetSite(record);
    }
    const provisioned = await panelDb.provisionSqlForRecord(record);
    const container = await gameContainer.createGameContainer(docker, {
        port: record.port,
        name: record.name,
        rconPassword: record.rcon_password,
        maxPlayers,
        startMap,
        sql: provisioned
    });
    const updated = await panelDb.updateServerContainer(record.container_id, { container_id: container.id });
    await phpSite.ensureSite(updated);
    gameContainer.finishProvisioningInBackground(container, updated);
    return updated;
}

/** Recreate the container with new limits while keeping the game files. */
async function recreateContainerKeepingData(docker, record, { maxPlayers }) {
    let startMap = 'de_dust2';
    try {
        const info = await docker.getContainer(record.container_id).inspect();
        startMap = panelDb.getEnvValue(info.Config.Env, 'START_MAP', startMap);
    } catch (_) { /* container missing: defaults are fine */ }
    await gameContainer.removeContainerQuietly(docker, record.container_id);
    const container = await gameContainer.createGameContainer(docker, {
        port: record.port, name: record.name, rconPassword: record.rcon_password, maxPlayers, startMap, sql: record
    });
    const updated = await panelDb.updateServerContainer(record.container_id, { container_id: container.id });
    gameContainer.finishProvisioningInBackground(container, updated, { syncFastdl: false });
    return updated;
}

/**
 * Extend a rental (optionally switching to another paid plan). Expired /
 * suspended-for-expiry servers are reactivated and started again.
 */
async function renewServer(docker, actor, containerId, { months = 1, couponCode = null, planSlug = null, auto = false, ip = null } = {}) {
    const current = await panelDb.getServerByContainerId(containerId);
    if (!current || current.is_pool) throw httpError(404, 'Sunucu bulunamadı.');
    if (actor.role !== 'admin' && Number(current.owner_id) !== Number(actor.id)) throw httpError(403, 'Bu sunucuya erişim yetkiniz yok.');

    const targetPlan = await panelDb.getPlan(planSlug || current.plan_type);
    if (!targetPlan) throw httpError(400, 'Sunucunun paketi artık mevcut değil. Lütfen yeni bir paket seçin.');
    if (targetPlan.is_trial) throw httpError(400, 'Deneme paketi uzatılamaz. Devam etmek için ücretli bir paket seçin.');
    if (planSlug && planSlug !== current.plan_type && !targetPlan.active) throw httpError(400, 'Seçilen paket satışta değil.');
    const payerId = current.owner_id;

    const result = await panelDb.withTransaction(async conn => {
        const [rows] = await conn.query('SELECT * FROM panel_servers WHERE id = ? FOR UPDATE', [current.id]);
        const server = rows[0];
        const q = await quote({ plan: targetPlan, months, couponCode, userId: payerId, conn });
        await panelDb.adjustBalance(conn, payerId, -q.total, {
            type: 'renewal',
            description: `${auto ? 'Otomatik yenileme' : 'Süre uzatma'} · ${targetPlan.name} · ${q.months} ay · port ${server.port}`,
            referenceType: 'server', referenceId: server.port, actorId: actor.id
        });
        if (q._coupon) await panelDb.redeemCoupon(conn, q._coupon, { userId: payerId, serverPort: server.port, discount: q.couponDiscount });
        const base = new Date(server.expires_at) > new Date() ? new Date(server.expires_at) : new Date();
        const newExpiry = new Date(base.getTime() + q.days * 86400000);
        const wasExpired = !!server.suspended && server.suspended_reason === 'expired';
        await conn.query(
            `UPDATE panel_servers SET expires_at = ?, plan_type = ?, last_renewed_at = NOW(), expiry_notice_stage = 0
                ${wasExpired ? ", suspended = 0, suspended_reason = NULL" : ''}
             WHERE id = ?`,
            [newExpiry, targetPlan.slug, server.id]
        );
        return { quote: q, newExpiry, wasExpired, planChanged: targetPlan.slug !== server.plan_type };
    });

    let record = await panelDb.getServerById(current.id);
    if (result.planChanged) {
        const oldPlan = await panelDb.getPlan(current.plan_type);
        if (!oldPlan || oldPlan.max_players !== targetPlan.max_players) {
            record = await recreateContainerKeepingData(docker, record, { maxPlayers: targetPlan.max_players });
        }
    } else if (result.wasExpired) {
        try { await docker.getContainer(record.container_id).start(); } catch (_) { /* already running */ }
    }
    await panelDb.logAudit({
        actorId: actor.id, actorName: actor.username, action: auto ? 'server.auto_renew' : 'server.renew',
        targetType: 'server', targetId: record.port, details: { plan: targetPlan.slug, months: result.quote.months, total: result.quote.total }, ip
    });
    await panelDb.notify(payerId, {
        type: 'success',
        title: `Port ${record.port} süresi uzatıldı`,
        body: `Yeni bitiş tarihi: ${result.newExpiry.toLocaleDateString('tr-TR')}. Tahsil edilen: ${result.quote.total.toFixed(2)}.`,
        link: `#/servers/${record.container_id}`
    });
    return { record, quote: publicQuote(result.quote), expires_at: result.newExpiry };
}

module.exports = {
    ALLOWED_PERIODS,
    parsePeriodDiscounts,
    getPeriodDiscounts,
    quote,
    publicQuote,
    rentServer,
    renewServer,
    provisionFreshServer,
    recreateContainerKeepingData,
    validateRconPassword
};

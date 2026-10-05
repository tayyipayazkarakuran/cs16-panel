// Subscription lifecycle job: expiry reminders, auto-renew, suspension after
// expiry (paywall) and reclamation into the rental pool after the grace period.
const fs = require('fs');
const panelDb = require('./panelDb');
const gameContainer = require('./gameContainer');
const fastdl = require('./fastdlService');
const phpSite = require('./phpSiteService');
const { isProtectedPort } = require('./serverProtection');

const REMINDER_STAGES = [
    { stage: 1, withinDays: 7 },
    { stage: 2, withinDays: 3 },
    { stage: 3, withinDays: 1 }
];

let running = false;

/** Remove every resource that belongs to a server record, then the record. */
async function destroyServerResources(docker, server) {
    if (isProtectedPort(server.port)) {
        throw panelDb.httpError(409, `Port ${server.port} korumalı; silme işlemi atlandı.`);
    }
    const errors = [];
    await gameContainer.removeContainerQuietly(docker, server.container_id);
    if (!(await gameContainer.removeVolumeWithRetry(docker, server.port))) errors.push('volume');
    try { await panelDb.dropSqlAccount(server.db_name, server.db_username); } catch (e) { errors.push(`mysql: ${e.message}`); }
    try {
        const dir = fastdl.fastdlDir(server.port);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) { errors.push(`fastdl: ${e.message}`); }
    try { phpSite.removeSite(server); } catch (e) { errors.push(`php: ${e.message}`); }
    await panelDb.deleteServerRecord(server.container_id);
    try { await phpSite.writeDomainMap(); } catch (_) { /* best effort */ }
    return errors;
}

async function suspendForExpiry(docker, server) {
    await panelDb.updateServerContainer(server.container_id, { suspended: 1, suspended_reason: 'expired', expiry_notice_stage: 4 });
    try { await docker.getContainer(server.container_id).stop({ t: 5 }); } catch (_) { /* already stopped */ }
    const graceDays = parseInt(await panelDb.getSetting('grace_days') || '3', 10);
    await panelDb.notify(server.owner_id, {
        type: 'danger',
        title: `Port ${server.port} süresi doldu ve askıya alındı`,
        body: `Sunucunuz durduruldu. ${graceDays} gün içinde süreyi uzatmazsanız tüm dosyalar silinip sunucu havuza geri alınacak.`,
        link: `#/servers/${server.container_id}`
    });
    await panelDb.logAudit({ action: 'server.suspend_expired', targetType: 'server', targetId: server.port });
}

async function runLifecycle(docker) {
    if (running) return;
    running = true;
    try {
        const db = panelDb.assertPool();
        const [servers] = await db.query(`
            SELECT s.*, u.username AS owner_username, u.role AS owner_role, u.balance AS owner_balance
            FROM panel_servers s JOIN panel_users u ON u.id = s.owner_id
            WHERE s.is_pool = 0`);
        const graceDays = parseInt(await panelDb.getSetting('grace_days') || '3', 10);
        const now = Date.now();
        let reclaimed = 0;

        for (const server of servers) {
            // Operator-owned and protected servers never expire automatically.
            if (server.owner_role === 'admin' || isProtectedPort(server.port)) continue;
            const expiresAt = new Date(server.expires_at).getTime();
            const msLeft = expiresAt - now;

            try {
                if (msLeft > 0) {
                    const daysLeft = msLeft / 86400000;
                    const due = REMINDER_STAGES.filter(s => daysLeft <= s.withinDays && server.expiry_notice_stage < s.stage).pop();
                    if (due) {
                        await panelDb.updateServerContainer(server.container_id, { expiry_notice_stage: due.stage });
                        await panelDb.notify(server.owner_id, {
                            type: 'warning',
                            title: `Port ${server.port} için ${Math.ceil(daysLeft)} gün kaldı`,
                            body: server.auto_renew
                                ? 'Otomatik yenileme açık. Bitiş tarihinde bakiyeniz yeterliyse süre kendiliğinden uzatılacak.'
                                : 'Kesinti yaşamamak için süreyi uzatın veya otomatik yenilemeyi açın.',
                            link: `#/servers/${server.container_id}`
                        });
                    }
                    continue;
                }

                if (!server.suspended) {
                    if (server.auto_renew) {
                        try {
                            await require('./billingService').renewServer(docker, { id: server.owner_id, username: server.owner_username, role: 'user' }, server.container_id, { months: 1, auto: true });
                            continue;
                        } catch (renewError) {
                            await panelDb.notify(server.owner_id, {
                                type: 'danger',
                                title: `Port ${server.port} otomatik yenilenemedi`,
                                body: renewError.message,
                                link: '#/billing'
                            });
                        }
                    }
                    await suspendForExpiry(docker, server);
                    continue;
                }

                if (server.suspended_reason === 'expired' && now - expiresAt > graceDays * 86400000) {
                    console.log(`[Lifecycle] Reclaiming expired server on port ${server.port}`);
                    await destroyServerResources(docker, server);
                    await panelDb.notify(server.owner_id, {
                        type: 'danger',
                        title: `Port ${server.port} silindi`,
                        body: 'Askı süresi içinde yenilenmediği için sunucu dosyaları silindi ve port havuza geri alındı.'
                    });
                    await panelDb.logAudit({ action: 'server.reclaim', targetType: 'server', targetId: server.port });
                    reclaimed++;
                }
            } catch (error) {
                console.error(`[Lifecycle] port ${server.port}:`, error.message);
            }
        }

        if (reclaimed) await require('./poolService').ensurePool(docker);
    } catch (error) {
        console.error('[Lifecycle] run failed:', error);
    } finally {
        running = false;
    }
}

module.exports = {
    runLifecycle,
    destroyServerResources,
    suspendForExpiry
};

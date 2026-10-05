// Self-service account endpoints for the signed-in user.
const express = require('express');
const security = require('../security');

const router = express.Router();

function sendError(res, e) {
    const status = e.statusCode || 500;
    if (status >= 500) console.error('[Account]', e);
    res.status(status).json({ error: status >= 500 ? 'Beklenmeyen bir hata oluştu.' : e.message });
}

// Everything the shell needs after login in one round trip.
router.get('/summary', async (req, res) => {
    try {
        const db = req.panelDb;
        const [user, notifications, announcements, settings, servers] = await Promise.all([
            db.getUserById(req.user.id),
            db.listNotifications(req.user.id, { limit: 10 }),
            db.listAnnouncements({ activeOnly: true }),
            db.getSettingsMap(['site_name', 'currency', 'support_contact', 'maintenance_mode', 'maintenance_message']),
            db.listServersForUser(req.user)
        ]);
        const owned = servers.filter(s => !s.is_pool && (req.user.role === 'admin' ? true : Number(s.owner_id) === Number(req.user.id)));
        const now = Date.now();
        res.json({
            user: db.publicUser(user),
            depositReference: db.depositReferenceCode(req.user.id),
            unreadNotifications: notifications.unread,
            notifications: notifications.notifications,
            announcements: announcements.map(a => ({ id: a.id, title: a.title, body: a.body, level: a.level, created_at: a.created_at })),
            settings: {
                siteName: settings.site_name || 'CS 1.6 Panel',
                currency: settings.currency || 'TL',
                supportContact: settings.support_contact || '',
                maintenance: settings.maintenance_mode === '1' ? settings.maintenance_message : null
            },
            stats: {
                servers: owned.filter(s => req.user.role === 'admin' ? Number(s.owner_id) === Number(req.user.id) : true).length,
                suspended: owned.filter(s => s.suspended).length,
                expiringSoon: owned.filter(s => !s.suspended && new Date(s.expires_at).getTime() - now < 7 * 86400000 && new Date(s.expires_at).getTime() > now).length
            }
        });
    } catch (e) {
        sendError(res, e);
    }
});

router.put('/profile', async (req, res) => {
    try {
        const user = await req.panelDb.updateProfile(req.user.id, { email: req.body && req.body.email });
        await req.panelDb.logAudit({ actorId: req.user.id, actorName: req.user.username, action: 'account.profile', targetType: 'user', targetId: req.user.id, ip: security.clientIp(req) });
        res.json({ success: true, user: req.panelDb.publicUser(user) });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/password', security.rateLimit({ name: 'pwchange', windowMs: 15 * 60 * 1000, max: 10, keys: req => [String(req.user.id)] }), async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        const user = await req.panelDb.changePassword(req.user.id, currentPassword, newPassword);
        // Password changes revoke every other session; re-issue this one.
        security.setSessionCookie(req, res, req.panelDb.makeToken(user));
        await req.panelDb.logAudit({ actorId: req.user.id, actorName: req.user.username, action: 'account.password', targetType: 'user', targetId: req.user.id, ip: security.clientIp(req) });
        res.json({ success: true, message: 'Şifreniz güncellendi. Diğer tüm oturumlar kapatıldı.' });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/logout-all', async (req, res) => {
    try {
        await req.panelDb.revokeSessions(req.user.id);
        security.clearSessionCookie(req, res);
        await req.panelDb.logAudit({ actorId: req.user.id, actorName: req.user.username, action: 'account.logout_all', targetType: 'user', targetId: req.user.id, ip: security.clientIp(req) });
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.get('/notifications', async (req, res) => {
    try {
        res.json(await req.panelDb.listNotifications(req.user.id, { limit: req.query.limit || 50 }));
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/notifications/read', async (req, res) => {
    try {
        await req.panelDb.markNotificationsRead(req.user.id, req.body && req.body.ids);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.get('/transactions', async (req, res) => {
    try {
        res.json(await req.panelDb.listTransactions({
            userId: req.user.id,
            limit: req.query.limit || 50,
            offset: req.query.offset || 0
        }));
    } catch (e) {
        sendError(res, e);
    }
});

module.exports = router;

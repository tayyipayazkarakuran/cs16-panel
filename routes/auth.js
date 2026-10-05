// Public authentication endpoints (mounted before the auth middleware).
const express = require('express');
const panelDb = require('../panelDb');
const security = require('../security');
const cfg = require('../config');

const router = express.Router();

const FIFTEEN_MIN = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const loginLimiter = security.rateLimit({
    name: 'login',
    windowMs: FIFTEEN_MIN,
    max: 10,
    keys: req => [
        security.clientIp(req),
        `${security.clientIp(req)}|${String((req.body && req.body.username) || '').toLowerCase().slice(0, 190)}`
    ],
    message: 'Çok fazla giriş denemesi. Lütfen 15 dakika sonra tekrar deneyin.'
});
const registerLimiter = security.rateLimit({
    name: 'register', windowMs: HOUR, max: 5,
    message: 'Bu ağdan çok fazla kayıt denemesi yapıldı. Lütfen daha sonra tekrar deneyin.'
});
const resetLimiter = security.rateLimit({ name: 'reset', windowMs: HOUR, max: 10 });

function sendError(res, e) {
    const status = e.statusCode || 500;
    if (status >= 500) console.error('[Auth]', e);
    res.status(status).json({ error: status >= 500 ? 'Beklenmeyen bir hata oluştu.' : e.message });
}

async function issueSession(req, res, user) {
    const token = panelDb.makeToken(user);
    security.setSessionCookie(req, res, token);
    return token;
}

// Public branding/pricing used by the login screen and landing page.
router.get('/public/config', async (req, res) => {
    try {
        const settings = await panelDb.getSettingsMap(['site_name', 'registration_enabled', 'support_contact', 'currency', 'maintenance_mode', 'maintenance_message']);
        const plans = await panelDb.listPlans({ activeOnly: true });
        res.set('Cache-Control', 'public, max-age=30');
        res.json({
            siteName: settings.site_name || 'CS 1.6 Panel',
            registrationEnabled: settings.registration_enabled !== '0',
            supportContact: settings.support_contact || '',
            currency: settings.currency || 'TL',
            maintenance: settings.maintenance_mode === '1' ? (settings.maintenance_message || 'Bakım') : null,
            gameHost: cfg.gameServerHost,
            plans: plans.map(p => ({
                slug: p.slug, name: p.name, description: p.description, price: p.price,
                duration_days: p.duration_days, max_players: p.max_players, features: p.features,
                is_trial: p.is_trial, highlighted: p.highlighted
            }))
        });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/auth/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body || {};
        const ip = security.clientIp(req);
        const user = await panelDb.authenticate(username, password, ip);
        if (!user) return res.status(401).json({ error: 'Kullanıcı adı/e-posta veya şifre hatalı.' });
        const token = await issueSession(req, res, user);
        await panelDb.logAudit({ actorId: user.id, actorName: user.username, action: 'auth.login', targetType: 'user', targetId: user.id, ip });
        res.json({ success: true, token, user: panelDb.publicUser(user) });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/auth/register', registerLimiter, async (req, res) => {
    try {
        const settings = await panelDb.getSettingsMap(['registration_enabled', 'maintenance_mode']);
        if (settings.registration_enabled === '0') {
            return res.status(403).json({ error: 'Yeni üyelik alımı şu anda kapalı.' });
        }
        if (settings.maintenance_mode === '1') {
            return res.status(503).json({ error: 'Panel bakımda olduğu için yeni üyelik alınamıyor.' });
        }
        const { username, email, password, acceptTerms } = req.body || {};
        if (!(acceptTerms === true || acceptTerms === 'true' || acceptTerms === 'on')) {
            return res.status(400).json({ error: 'Devam etmek için kullanım koşullarını kabul etmelisiniz.' });
        }
        const user = await panelDb.createUser(username, password, { email, requireEmail: true, acceptTerms: true });
        const ip = security.clientIp(req);
        await panelDb.logAudit({ actorId: user.id, actorName: user.username, action: 'auth.register', targetType: 'user', targetId: user.id, ip });
        await panelDb.notify(user.id, {
            type: 'success',
            title: 'Hoş geldiniz!',
            body: 'Hesabınız oluşturuldu. Bakiye yükleyip hemen bir sunucu kiralayabilirsiniz.',
            link: '#/rent'
        });
        const token = await issueSession(req, res, user);
        res.status(201).json({ success: true, token, user: panelDb.publicUser(user) });
    } catch (e) {
        sendError(res, e);
    }
});

// Without an e-mail transport we cannot mail reset links; instead the request
// is surfaced to administrators who issue a single-use link from the panel.
router.post('/auth/forgot-password', resetLimiter, async (req, res) => {
    try {
        const login = String((req.body && req.body.login) || '').trim().slice(0, 190);
        if (login) {
            const [rows] = await panelDb.assertPool().query(
                'SELECT id, username FROM panel_users WHERE username = ? OR email = ? LIMIT 1',
                [login, login.toLowerCase()]
            );
            if (rows[0]) {
                await panelDb.notifyAdmins({
                    type: 'warning',
                    title: 'Şifre sıfırlama talebi',
                    body: `"${rows[0].username}" kullanıcısı şifre sıfırlama talep etti. Kullanıcılar sayfasından sıfırlama bağlantısı oluşturabilirsiniz.`,
                    link: `#/admin/users?u=${rows[0].id}`
                });
                await panelDb.logAudit({ actorId: rows[0].id, actorName: rows[0].username, action: 'auth.forgot_password', targetType: 'user', targetId: rows[0].id, ip: security.clientIp(req) });
            }
        }
        // Same answer whether or not the account exists (no user enumeration).
        res.json({ success: true, message: 'Talebiniz alındı. Hesabınız varsa destek ekibi size güvenli bir sıfırlama bağlantısı iletecek.' });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/auth/reset-password', resetLimiter, async (req, res) => {
    try {
        const { token, password } = req.body || {};
        const userId = await panelDb.consumePasswordReset(token, password);
        await panelDb.logAudit({ actorId: userId, action: 'auth.password_reset', targetType: 'user', targetId: userId, ip: security.clientIp(req) });
        res.json({ success: true, message: 'Şifreniz güncellendi. Yeni şifrenizle giriş yapabilirsiniz.' });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/auth/exchange', async (req, res) => {
    try {
        if (!security.requestHasTrustedOrigin(req)) {
            return res.status(403).json({ error: 'Invalid panel origin' });
        }
        const user = await panelDb.consumeAuthHandoff(req.body && req.body.code);
        if (!user) return res.status(401).json({ error: 'Giriş bağlantısı geçersiz, süresi dolmuş veya daha önce kullanılmış.' });
        await issueSession(req, res, user);
        res.json({ success: true, user: panelDb.publicUser(user) });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/auth/logout', (req, res) => {
    if (!security.requestHasTrustedOrigin(req)) {
        return res.status(403).json({ error: 'Invalid panel origin' });
    }
    security.clearSessionCookie(req, res);
    res.json({ success: true });
});

router.get('/auth/me', async (req, res) => {
    const { token } = security.getAuthToken(req);
    let user = null;
    if (token) {
        const payload = panelDb.verifyToken(token);
        if (payload) {
            const record = await panelDb.getUserById(payload.sub).catch(() => null);
            if (record && !record.suspended && Number(record.token_version || 0) === Number(payload.ver || 0)) {
                user = panelDb.publicUser(record);
            }
        }
    }
    res.json({ user });
});

module.exports = router;

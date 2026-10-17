// Refund requests, balance withdrawals and receipts.
// Mounted at /api (after authentication); /admin/* paths require the admin role.
const express = require('express');
const refunds = require('../refundService');
const security = require('../security');

const router = express.Router();

function sendError(res, e) {
    const status = e.statusCode || 500;
    if (status >= 500) console.error('[Refunds]', e);
    res.status(status).json({ error: e.message, code: e.code });
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Bu işlem için yönetici yetkisi gerekir.' });
    next();
}

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'paid'];
const status = v => (STATUSES.includes(v) ? v : null);
const writeLimit = security.rateLimit({ name: 'billing-requests', windowMs: 3600000, max: 10, keys: req => [String(req.user.id)] });

// ---------------------------------------------------------------------------
//  Customer
// ---------------------------------------------------------------------------

router.get('/refunds', async (req, res) => {
    try {
        res.json(await req.panelDb.listRefundRequests({ userId: req.user.id, limit: req.query.limit || 50 }));
    } catch (e) { sendError(res, e); }
});

router.post('/refunds', writeLimit, async (req, res) => {
    try {
        const { serverId, reason } = req.body || {};
        const record = await req.panelDb.requireServerAccess(req.user, req.docker, String(serverId || ''), { allowSuspended: true });
        const result = await refunds.requestRefund(req.user, record, reason, { ip: security.clientIp(req) });
        res.status(201).json({ success: true, id: result.id, amount: result.quote.total, message: 'İade talebiniz alındı. Sonuç bildirim olarak iletilecek.' });
    } catch (e) { sendError(res, e); }
});

router.post('/refunds/:id/cancel', async (req, res) => {
    try {
        await refunds.cancelRefund(req.user, req.params.id);
        res.json({ success: true });
    } catch (e) { sendError(res, e); }
});

router.get('/withdrawals', async (req, res) => {
    try {
        const settings = await refunds.refundSettings();
        const data = await req.panelDb.listWithdrawals({ userId: req.user.id, limit: req.query.limit || 50 });
        res.json({ ...data, enabled: settings.withdrawalEnabled, minAmount: settings.withdrawalMin });
    } catch (e) { sendError(res, e); }
});

router.post('/withdrawals', writeLimit, async (req, res) => {
    try {
        const result = await refunds.requestWithdrawal(req.user, req.body || {}, { ip: security.clientIp(req) });
        res.status(201).json({ success: true, id: result.id, message: 'Çekim talebiniz alındı; tutar onaylanana kadar bakiyenizden ayrıldı.' });
    } catch (e) { sendError(res, e); }
});

router.get('/receipts', async (req, res) => {
    try {
        const userId = req.user.role === 'admin' && req.query.userId ? parseInt(req.query.userId, 10) : req.user.id;
        res.json({ receipts: await req.panelDb.listReceipts({ userId, limit: req.query.limit || 100, offset: req.query.offset || 0 }) });
    } catch (e) { sendError(res, e); }
});

// GET /api/receipts/:id  or  /api/receipts/by-transaction/:txId
async function sendReceipt(req, res, lookup) {
    try {
        const receipt = await req.panelDb.getReceipt(lookup);
        if (!receipt || (req.user.role !== 'admin' && Number(receipt.user_id) !== Number(req.user.id))) {
            return res.status(404).json({ error: 'Makbuz bulunamadı.' });
        }
        res.json({ receipt });
    } catch (e) { sendError(res, e); }
}
router.get('/receipts/by-transaction/:txId', (req, res) => sendReceipt(req, res, { transactionId: parseInt(req.params.txId, 10) }));
router.get('/receipts/:id', (req, res) => sendReceipt(req, res, { id: parseInt(req.params.id, 10) }));

// ---------------------------------------------------------------------------
//  Admin
// ---------------------------------------------------------------------------

router.get('/admin/refunds', requireAdmin, async (req, res) => {
    try {
        res.json(await req.panelDb.listRefundRequests({ status: status(req.query.status), limit: req.query.limit || 50, offset: req.query.offset || 0 }));
    } catch (e) { sendError(res, e); }
});

router.get('/admin/refunds/counts', requireAdmin, async (req, res) => {
    try {
        res.json(await req.panelDb.countPendingBillingRequests());
    } catch (e) { sendError(res, e); }
});

// Current refund quote for a request or a server (shown in the approve dialog).
router.get('/admin/refunds/quote', requireAdmin, async (req, res) => {
    try {
        let serverId = req.query.serverId ? parseInt(req.query.serverId, 10) : null;
        if (req.query.requestId) {
            const [rows] = await req.panelDb.assertPool().query('SELECT server_id FROM panel_refund_requests WHERE id = ?', [parseInt(req.query.requestId, 10)]);
            serverId = rows[0] && rows[0].server_id;
        }
        const record = serverId ? await req.panelDb.getServerById(serverId) : null;
        if (!record) return res.status(404).json({ error: 'Sunucu artık mevcut değil.' });
        res.json({ quote: await refunds.quoteForServer(record), server: { id: record.id, port: record.port, name: record.name, expires_at: record.expires_at } });
    } catch (e) { sendError(res, e); }
});

router.post('/admin/refunds/:id/approve', requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const result = await refunds.approveRefund(req.docker, req.user, { requestId: req.params.id, amount: body.amount, serverAction: body.serverAction, note: body.note, ip: security.clientIp(req) });
        res.json({ success: true, ...result });
    } catch (e) { sendError(res, e); }
});

router.post('/admin/refunds/:id/reject', requireAdmin, async (req, res) => {
    try {
        await refunds.rejectRefund(req.user, req.params.id, req.body && req.body.note, { ip: security.clientIp(req) });
        res.json({ success: true });
    } catch (e) { sendError(res, e); }
});

// Refund without a customer request (e.g. outage compensation).
router.post('/admin/refunds/direct', requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const record = await req.panelDb.getServerByContainerId(String(body.containerId || ''));
        if (!record) return res.status(404).json({ error: 'Sunucu bulunamadı.' });
        const result = await refunds.approveRefund(req.docker, req.user, { serverId: record.id, amount: body.amount, serverAction: body.serverAction, note: body.note, ip: security.clientIp(req) });
        res.json({ success: true, ...result });
    } catch (e) { sendError(res, e); }
});

router.get('/admin/withdrawals', requireAdmin, async (req, res) => {
    try {
        res.json(await req.panelDb.listWithdrawals({ status: status(req.query.status), limit: req.query.limit || 50, offset: req.query.offset || 0 }));
    } catch (e) { sendError(res, e); }
});

router.post('/admin/withdrawals/:id/paid', requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const result = await refunds.markWithdrawalPaid(req.user, req.params.id, { reference: body.reference, note: body.note, ip: security.clientIp(req) });
        res.json({ success: true, receipt: result.receipt });
    } catch (e) { sendError(res, e); }
});

router.post('/admin/withdrawals/:id/reject', requireAdmin, async (req, res) => {
    try {
        await refunds.rejectWithdrawal(req.user, req.params.id, req.body && req.body.note, { ip: security.clientIp(req) });
        res.json({ success: true });
    } catch (e) { sendError(res, e); }
});

module.exports = router;

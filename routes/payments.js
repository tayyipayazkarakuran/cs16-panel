const express = require('express');
const security = require('../security');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, '..', 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + require('crypto').randomInt(1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname).toLowerCase());
    }
});

const fileFilter = (req, file, cb) => {
    // Only allow images and PDFs
    const allowedTypes = /^(jpeg|jpg|png|pdf)$/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase().slice(1));
    const mimetype = /^(image\/(jpeg|png)|application\/pdf)$/.test(file.mimetype);

    if (extname && mimetype) {
        return cb(null, true);
    } else {
        cb(Object.assign(new Error('Dekont yalnızca JPG, PNG veya PDF olabilir.'), { statusCode: 400 }));
    }
};

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: fileFilter
});

function hasAllowedSignature(filePath, extension) {
    const header = Buffer.alloc(8);
    const fd = fs.openSync(filePath, 'r');
    try {
        fs.readSync(fd, header, 0, header.length, 0);
    } finally {
        fs.closeSync(fd);
    }
    const hex = header.toString('hex');
    if (extension === '.png') return hex === '89504e470d0a1a0a';
    if (extension === '.jpg' || extension === '.jpeg') return hex.startsWith('ffd8ff');
    if (extension === '.pdf') return header.toString('ascii', 0, 5) === '%PDF-';
    return false;
}

function removeUploadedReceipt(req) {
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
        fs.rmSync(req.file.path, { force: true });
    }
}

// Helper for admin auth check
function requireAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Access denied: Admin role required' });
    }
}


// ---------------------------------------------------------------------------
//  Payment intents: "renew my server once this transfer is approved"
// ---------------------------------------------------------------------------

const INTENT_MONTHS = [1, 3, 6, 12];

/** Shape-only validation (pure, unit-tested). */
function parseIntent(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    let data = raw;
    if (typeof raw === 'string') {
        try { data = JSON.parse(raw); } catch (_) { throw Object.assign(new Error('Geçersiz ödeme amacı.'), { statusCode: 400 }); }
    }
    if (!data || data.type !== 'renew') throw Object.assign(new Error('Desteklenmeyen ödeme amacı.'), { statusCode: 400 });
    const months = parseInt(data.months, 10);
    if (!INTENT_MONTHS.includes(months)) throw Object.assign(new Error('Geçersiz dönem.'), { statusCode: 400 });
    const serverId = String(data.serverId || '');
    if (!/^[a-f0-9]{12,64}$/i.test(serverId)) throw Object.assign(new Error('Geçersiz sunucu.'), { statusCode: 400 });
    const plan = data.plan ? String(data.plan).slice(0, 32) : null;
    const coupon = data.coupon ? String(data.coupon).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32).toUpperCase() : null;
    return { type: 'renew', serverId, months, plan, coupon };
}

async function validateIntent(req, raw) {
    const intent = parseIntent(raw);
    if (!intent) return null;
    const record = await req.panelDb.requireServerAccess(req.user, req.docker, intent.serverId, { allowSuspended: true });
    if (Number(record.owner_id) !== Number(req.user.id)) throw Object.assign(new Error('Bu sunucu size ait değil.'), { statusCode: 403 });
    // Store the stable DB id: the container id changes when a server is recreated.
    return { ...intent, serverDbId: record.id };
}

/** Run a stored intent after the deposit is credited; failures never undo the deposit. */
async function runIntent(req, result) {
    const intent = result.intent;
    if (!intent || intent.type !== 'renew') return null;
    const billing = require('../billingService');
    try {
        const record = intent.serverDbId ? await req.panelDb.getServerById(intent.serverDbId) : await req.panelDb.getServerByContainerId(intent.serverId);
        if (!record || Number(record.owner_id) !== Number(result.userId)) throw new Error('Sunucu artık hesabınızda değil.');
        const owner = await req.panelDb.getUserById(result.userId);
        const renewal = await billing.renewServer(req.docker, { id: owner.id, username: owner.username, role: 'user' }, record.container_id,
            { months: intent.months, planSlug: intent.plan, couponCode: intent.coupon, ip: security.clientIp(req) });
        return `Port ${renewal.record.port} ${intent.months} ay uzatıldı.`;
    } catch (error) {
        await req.panelDb.notify(result.userId, {
            type: 'warning',
            title: 'Ödeme yüklendi, süre otomatik uzatılamadı',
            body: `${result.amount.toFixed(2)} bakiyenize eklendi ancak uzatma yapılamadı: ${error.message}. Sunucu sayfasından tekrar deneyebilirsiniz.`,
            link: '#/billing'
        });
        return `Bakiye yüklendi; otomatik uzatma başarısız: ${error.message}`;
    }
}

// GET /api/payments/iban - Fetch current dynamic IBAN details (User)
router.get('/iban', async (req, res) => {
    try {
        const settings = await req.panelDb.getSettingsMap(['iban_details', 'min_deposit', 'currency']);
        res.json({
            success: true,
            iban_details: settings.iban_details || '',
            min_deposit: parseFloat(settings.min_deposit || '10'),
            currency: settings.currency || 'TL',
            reference_code: req.panelDb.depositReferenceCode(req.user.id)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/payments/report - Report a new bank transfer / payment (User)
router.post('/report', upload.single('receipt'), async (req, res) => {
    try {
        const { amount, senderName } = req.body;
        if (!amount || !senderName) {
            removeUploadedReceipt(req);
            return res.status(400).json({ error: 'Amount and Sender Name are required' });
        }

        const parsedAmount = Math.round(parseFloat(amount) * 100) / 100;
        const minDeposit = parseFloat(await req.panelDb.getSetting('min_deposit') || '10');
        if (isNaN(parsedAmount) || parsedAmount < minDeposit || parsedAmount > 1000000) {
            removeUploadedReceipt(req);
            return res.status(400).json({ error: `Tutar en az ${minDeposit.toFixed(2)} olmalıdır.` });
        }
        const [pendingRows] = await req.panelDb.assertPool().query("SELECT COUNT(*) AS c FROM panel_payments WHERE user_id = ? AND status = 'pending'", [req.user.id]);
        if (pendingRows[0].c >= 5) {
            removeUploadedReceipt(req);
            return res.status(429).json({ error: 'Onay bekleyen 5 bildiriminiz var. Lütfen önce bunların sonuçlanmasını bekleyin.' });
        }
        if (String(senderName).trim().length > 120) {
            removeUploadedReceipt(req);
            return res.status(400).json({ error: 'Sender Name is too long' });
        }

        if (req.file) {
            const extension = path.extname(req.file.filename).toLowerCase();
            if (!hasAllowedSignature(req.file.path, extension)) {
                removeUploadedReceipt(req);
                return res.status(400).json({ error: 'Receipt content does not match its file type' });
            }
        }

        const receiptPath = req.file ? `/uploads/${req.file.filename}` : null;
        let intent = null;
        try {
            intent = await validateIntent(req, req.body.intent);
        } catch (intentError) {
            removeUploadedReceipt(req);
            return res.status(intentError.statusCode || 400).json({ error: intentError.message });
        }

        const paymentId = await req.panelDb.createPaymentReport(
            req.user.id,
            parsedAmount,
            String(senderName).trim(),
            receiptPath,
            intent
        );

        await req.panelDb.notifyAdmins({
            type: 'info',
            title: 'Yeni ödeme bildirimi',
            body: `${req.user.username}: ${parsedAmount.toFixed(2)} (${String(senderName).trim()})`,
            link: '#/admin/payments'
        });
        res.status(201).json({
            success: true,
            message: intent
                ? 'Ödeme bildiriminiz alındı. Onaylandığında bakiyenize yüklenecek ve sunucunuzun süresi otomatik uzatılacak.'
                : 'Ödeme bildiriminiz alındı. Yönetici onayından sonra bakiyenize yansıyacak.',
            paymentId
        });
    } catch (e) {
        removeUploadedReceipt(req);
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// GET /api/payments/my - View my payment history (User)
router.get('/my', async (req, res) => {
    try {
        const payments = await req.panelDb.getUserPayments(req.user.id);
        res.json({ success: true, payments });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/payments/receipt/:filename - Owner/admin-only receipt delivery
router.get('/receipt/:filename', async (req, res) => {
    try {
        const filename = String(req.params.filename || '');
        if (path.basename(filename) !== filename || !/^\d+-\d+\.(?:jpe?g|png|pdf)$/i.test(filename)) {
            return res.status(400).json({ error: 'Invalid receipt filename' });
        }

        const receiptPath = `/uploads/${filename}`;
        const payment = await req.panelDb.getPaymentByReceiptPath(receiptPath);
        if (!payment) return res.status(404).json({ error: 'Receipt not found' });
        if (req.user.role !== 'admin' && Number(payment.user_id) !== Number(req.user.id)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const absolutePath = path.join(__dirname, '..', 'uploads', filename);
        if (!fs.existsSync(absolutePath)) return res.status(404).json({ error: 'Receipt file not found' });
        res.set('Cache-Control', 'private, no-store');
        res.sendFile(absolutePath);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/payments/admin/list?status=pending|approved|rejected
router.get('/admin/list', requireAdmin, async (req, res) => {
    try {
        const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
        const search = String(req.query.search || '').trim();
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const [payments, total] = await Promise.all([
            req.panelDb.listPayments({ status, search, limit, offset }),
            req.panelDb.countPayments({ status, search })
        ]);
        res.json({ success: true, payments, total, limit, offset });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Kept for older clients.
router.get('/admin/pending', requireAdmin, async (req, res) => {
    try {
        res.json({ success: true, payments: await req.panelDb.getPendingPayments() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/payments/admin/:id/approve { amount?, note? }
router.post('/admin/:id/approve', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const body = req.body || {};
        const result = await req.panelDb.approvePayment(id, { actorId: req.user.id, creditedAmount: body.amount, note: body.note });
        await req.panelDb.logAudit({ actorId: req.user.id, actorName: req.user.username, action: 'payment.approve', targetType: 'payment', targetId: id, details: { amount: result.amount }, ip: req.ip });
        await req.panelDb.notify(result.userId, {
            type: 'success',
            title: 'Ödemeniz onaylandı',
            body: `${result.amount.toFixed(2)} bakiyenize eklendi.${body.note ? ` Not: ${String(body.note).slice(0, 200)}` : ''}`,
            link: '#/billing'
        });
        let intentResult = null;
        if (result.intent) intentResult = await runIntent(req, result);
        res.json({ success: true, message: intentResult ? `Ödeme onaylandı. ${intentResult}` : 'Ödeme onaylandı ve bakiye yüklendi.', receipt: result.receipt });
    } catch (e) {
        res.status(e.statusCode || 400).json({ error: e.message });
    }
});

// POST /api/payments/admin/:id/reject { note? }
router.post('/admin/:id/reject', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const note = req.body && req.body.note;
        const result = await req.panelDb.rejectPayment(id, { actorId: req.user.id, note });
        await req.panelDb.logAudit({ actorId: req.user.id, actorName: req.user.username, action: 'payment.reject', targetType: 'payment', targetId: id, ip: req.ip });
        if (result.userId) {
            await req.panelDb.notify(result.userId, {
                type: 'danger',
                title: 'Ödeme bildiriminiz reddedildi',
                body: note ? String(note).slice(0, 300) : 'Ayrıntı için destek ile iletişime geçin.',
                link: '#/billing'
            });
        }
        res.json({ success: true, message: 'Ödeme bildirimi reddedildi.' });
    } catch (e) {
        res.status(e.statusCode || 400).json({ error: e.message });
    }
});

module.exports = router;
module.exports._test = { hasAllowedSignature, parseIntent };

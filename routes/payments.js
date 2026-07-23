const express = require('express');
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
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    // Only allow images and PDFs
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (extname && mimetype) {
        return cb(null, true);
    } else {
        cb(new Error('Only images (jpg/png) and PDFs are allowed!'));
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

// GET /api/payments/iban - Fetch current dynamic IBAN details (User)
router.get('/iban', async (req, res) => {
    try {
        const iban = await req.panelDb.getSetting('iban_details');
        res.json({ success: true, iban_details: iban || 'TR00 0000 0000 0000 0000 0000 00' });
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

        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > 1000000) {
            removeUploadedReceipt(req);
            return res.status(400).json({ error: 'Valid amount is required' });
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

        const paymentId = await req.panelDb.createPaymentReport(
            req.user.id,
            parsedAmount,
            String(senderName).trim(),
            receiptPath
        );

        res.status(201).json({ 
            success: true, 
            message: 'Payment report submitted successfully. Waiting for admin approval.',
            paymentId
        });
    } catch (e) {
        removeUploadedReceipt(req);
        res.status(500).json({ error: e.message });
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

// GET /api/payments/admin/pending - View pending payments (Admin)
router.get('/admin/pending', requireAdmin, async (req, res) => {
    try {
        const payments = await req.panelDb.getPendingPayments();
        res.json({ success: true, payments });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/payments/admin/:id/approve - Approve a payment (Admin)
router.post('/admin/:id/approve', requireAdmin, async (req, res) => {
    try {
        await req.panelDb.approvePayment(req.params.id);
        res.json({ success: true, message: 'Payment approved and user balance updated.' });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// POST /api/payments/admin/:id/reject - Reject a payment (Admin)
router.post('/admin/:id/reject', requireAdmin, async (req, res) => {
    try {
        await req.panelDb.rejectPayment(req.params.id);
        res.json({ success: true, message: 'Payment rejected successfully.' });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
module.exports._test = { hasAllowedSignature };

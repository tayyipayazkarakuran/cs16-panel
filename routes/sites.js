// Per-server PHP website management: /api/sites/:id/*
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const phpSite = require('../phpSiteService');
const { readZip, commonRootFolder } = require('../zipReader');
const security = require('../security');

const router = express.Router();
const MAX_SITE_UPLOAD = parseInt(process.env.MAX_SITE_UPLOAD_BYTES || String(64 * 1024 * 1024), 10);
const MAX_ZIP_UPLOAD = parseInt(process.env.MAX_SITE_ZIP_BYTES || String(128 * 1024 * 1024), 10);
const MAX_EDIT_BYTES = 5 * 1024 * 1024;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SITE_UPLOAD, files: 200, fields: 500 } });
const zipUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ZIP_UPLOAD, files: 1 } });

function httpError(status, message) {
    const err = new Error(message);
    err.statusCode = status;
    return err;
}

function sendError(res, e) {
    const status = e.statusCode || 500;
    if (status >= 500) console.error('[Sites]', e);
    res.status(status).json({ error: e.message || 'Beklenmeyen hata' });
}

function cleanRel(rel) {
    const value = String(rel || '').replace(/\\/g, '/').trim();
    if (value.includes('\0')) throw httpError(400, 'Geçersiz dosya yolu');
    const normalized = path.posix.normalize(value).replace(/^\/+/, '').replace(/\/+$/, '');
    if (normalized === '.' || normalized === '') return '';
    if (normalized === '..' || normalized.startsWith('../')) throw httpError(403, 'Site klasörünün dışına çıkılamaz');
    return normalized;
}

function safeName(value, label = 'ad') {
    const name = String(value || '').trim();
    if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name) || name.length > 200) throw httpError(400, `Geçersiz ${label}`);
    return name;
}

/** Resolve inside the site root, refusing to traverse symlinks. */
function resolveSitePath(root, rel) {
    const relPath = cleanRel(rel);
    let current = root;
    for (const part of relPath.split('/').filter(Boolean)) {
        current = path.join(current, part);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
            throw httpError(403, 'Sembolik bağlantılar desteklenmiyor');
        }
    }
    return { relPath, fullPath: phpSite.resolveInside(root, relPath) };
}

function mkdirOwned(dir, root) {
    const missing = [];
    let cursor = dir;
    while (!fs.existsSync(cursor) && cursor.startsWith(root)) {
        missing.unshift(cursor);
        cursor = path.dirname(cursor);
    }
    fs.mkdirSync(dir, { recursive: true });
    missing.forEach(phpSite.fixOwnership);
}

function writeOwned(file, data) {
    fs.writeFileSync(file, data);
    phpSite.fixOwnership(file);
}

router.use('/:id', async (req, res, next) => {
    try {
        req.serverRecord = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        req.siteRoot = phpSite.siteDir(req.serverRecord);
        if (!fs.existsSync(req.siteRoot)) await phpSite.ensureSite(req.serverRecord);
        next();
    } catch (e) {
        sendError(res, e);
    }
});

router.get('/:id', (req, res) => {
    try {
        res.json(phpSite.siteInfo(req.serverRecord));
    } catch (e) {
        sendError(res, e);
    }
});

router.get('/:id/files', (req, res) => {
    try {
        const { relPath, fullPath } = resolveSitePath(req.siteRoot, req.query.path);
        if (!fs.existsSync(fullPath)) return res.json({ path: relPath, files: [] });
        if (!fs.statSync(fullPath).isDirectory()) throw httpError(400, 'Bu yol bir klasör değil');
        const files = fs.readdirSync(fullPath, { withFileTypes: true })
            .filter(entry => !entry.isSymbolicLink())
            .map(entry => {
                const stat = fs.statSync(path.join(fullPath, entry.name));
                return {
                    name: entry.name,
                    path: relPath ? `${relPath}/${entry.name}` : entry.name,
                    isDir: entry.isDirectory(),
                    size: entry.isFile() ? stat.size : 0,
                    mtime: stat.mtime
                };
            })
            .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
        res.json({ path: relPath, files });
    } catch (e) {
        sendError(res, e);
    }
});

router.get('/:id/files/view', (req, res) => {
    try {
        const { relPath, fullPath } = resolveSitePath(req.siteRoot, req.query.file);
        if (!relPath || !fs.existsSync(fullPath)) throw httpError(404, 'Dosya bulunamadı');
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) throw httpError(400, 'Bu yol bir dosya değil');
        if (stat.size > MAX_EDIT_BYTES) throw httpError(413, 'Dosya düzenlemek için çok büyük (en fazla 5 MB)');
        res.json({ file: relPath, content: fs.readFileSync(fullPath, 'utf8') });
    } catch (e) {
        sendError(res, e);
    }
});

router.get('/:id/files/download', (req, res) => {
    try {
        const { relPath, fullPath } = resolveSitePath(req.siteRoot, req.query.file);
        if (!relPath || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) throw httpError(404, 'Dosya bulunamadı');
        res.download(fullPath, path.basename(fullPath));
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/:id/files/edit', (req, res) => {
    try {
        const { relPath, fullPath } = resolveSitePath(req.siteRoot, req.body.file);
        if (!relPath) throw httpError(400, 'Dosya yolu eksik');
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) throw httpError(400, 'Bu yol bir klasör');
        const content = req.body.content === undefined ? '' : String(req.body.content);
        if (Buffer.byteLength(content) > MAX_EDIT_BYTES) throw httpError(413, 'İçerik çok büyük (en fazla 5 MB)');
        mkdirOwned(path.dirname(fullPath), req.siteRoot);
        writeOwned(fullPath, content);
        res.json({ success: true, message: 'Dosya kaydedildi.' });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/:id/files/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) throw httpError(400, 'Dosya seçilmedi');
        const { fullPath } = resolveSitePath(req.siteRoot, req.body.path);
        mkdirOwned(fullPath, req.siteRoot);
        const name = safeName(path.basename(req.file.originalname), 'dosya adı');
        writeOwned(phpSite.resolveInside(fullPath, name), req.file.buffer);
        res.json({ success: true, message: `${name} yüklendi.` });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/:id/files/upload-folder', upload.array('files', 200), (req, res) => {
    try {
        if (!req.files || !req.files.length) throw httpError(400, 'Dosya seçilmedi');
        const { fullPath: base } = resolveSitePath(req.siteRoot, req.body.basePath);
        const rel = Array.isArray(req.body.relativePaths) ? req.body.relativePaths : [req.body.relativePaths];
        if (rel.length !== req.files.length) throw httpError(400, 'Klasör yol bilgisi eksik');
        let uploaded = 0;
        req.files.forEach((file, i) => {
            const relative = cleanRel(rel[i] || file.originalname);
            if (!relative) throw httpError(400, 'Geçersiz dosya yolu');
            const target = resolveSitePath(base, relative).fullPath;
            mkdirOwned(path.dirname(target), req.siteRoot);
            writeOwned(target, file.buffer);
            uploaded++;
        });
        res.json({ success: true, uploaded, message: `${uploaded} dosya yüklendi.` });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/:id/files/mkdir', (req, res) => {
    try {
        const { relPath, fullPath } = resolveSitePath(req.siteRoot, req.body.path);
        const name = safeName(req.body.name, 'klasör adı');
        const target = phpSite.resolveInside(fullPath, name);
        if (fs.existsSync(target)) throw httpError(409, 'Bu isimde bir dosya veya klasör zaten var');
        mkdirOwned(target, req.siteRoot);
        res.status(201).json({ success: true, path: relPath ? `${relPath}/${name}` : name });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/:id/files/rename', (req, res) => {
    try {
        const from = resolveSitePath(req.siteRoot, req.body.from);
        const to = resolveSitePath(req.siteRoot, req.body.to);
        if (!from.relPath || !to.relPath) throw httpError(400, 'Kaynak ve hedef zorunludur');
        if (!fs.existsSync(from.fullPath)) throw httpError(404, 'Kaynak bulunamadı');
        if (fs.existsSync(to.fullPath)) throw httpError(409, 'Hedef zaten var');
        mkdirOwned(path.dirname(to.fullPath), req.siteRoot);
        fs.renameSync(from.fullPath, to.fullPath);
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.delete('/:id/files', (req, res) => {
    try {
        const { relPath, fullPath } = resolveSitePath(req.siteRoot, req.query.path);
        if (!relPath) throw httpError(403, 'Site kök klasörü silinemez');
        if (fs.existsSync(fullPath)) fs.rmSync(fullPath, { recursive: true, force: true });
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

// Upload a .zip and extract it into a folder (optionally replacing the site).
router.post('/:id/zip', zipUpload.single('file'), (req, res) => {
    try {
        if (!req.file) throw httpError(400, 'ZIP dosyası seçilmedi');
        const entries = readZip(req.file.buffer, { maxTotalBytes: 256 * 1024 * 1024 });
        const strip = (req.body.stripRoot !== 'false') ? commonRootFolder(entries) : null;
        const { fullPath: base, relPath } = resolveSitePath(req.siteRoot, req.body.path);
        if (req.body.wipe === 'true' && !relPath) {
            for (const name of fs.readdirSync(req.siteRoot)) fs.rmSync(path.join(req.siteRoot, name), { recursive: true, force: true });
        }
        let files = 0;
        for (const entry of entries) {
            let rel = entry.path;
            if (strip) rel = rel === strip ? '' : rel.slice(strip.length + 1);
            if (!rel) continue;
            const target = resolveSitePath(base, rel).fullPath;
            if (entry.isDir) { mkdirOwned(target, req.siteRoot); continue; }
            mkdirOwned(path.dirname(target), req.siteRoot);
            writeOwned(target, entry.data);
            files++;
        }
        res.json({ success: true, files, message: `${files} dosya çıkarıldı.` });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/:id/template', async (req, res) => {
    try {
        const template = String((req.body && req.body.template) || '');
        await phpSite.installTemplate(req.serverRecord, template, { wipe: req.body.wipe === true || req.body.wipe === 'true' });
        await req.panelDb.logAudit({ actorId: req.user.id, actorName: req.user.username, action: 'site.template', targetType: 'server', targetId: req.serverRecord.port, details: { template }, ip: security.clientIp(req) });
        res.json({ success: true, message: 'Şablon kuruldu.' });
    } catch (e) {
        sendError(res, e);
    }
});

router.put('/:id/domain', async (req, res) => {
    try {
        const updated = await phpSite.setDomain(req.serverRecord, req.body && req.body.domain);
        await req.panelDb.logAudit({ actorId: req.user.id, actorName: req.user.username, action: 'site.domain', targetType: 'server', targetId: updated.port, details: { domain: updated.php_domain }, ip: security.clientIp(req) });
        res.json({ success: true, site: phpSite.siteInfo(updated) });
    } catch (e) {
        sendError(res, e);
    }
});

// Rewrites config.php and fixes ownership/permissions (e.g. after manual copies).
router.post('/:id/repair', async (req, res) => {
    try {
        await phpSite.ensureSite(req.serverRecord);
        phpSite.chownTree(req.siteRoot);
        await phpSite.writeDomainMap();
        res.json({ success: true, message: 'Site yapılandırması ve dosya izinleri onarıldı.' });
    } catch (e) {
        sendError(res, e);
    }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const fastdl = require('../fastdlService');

const cfg = require('../config');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1024 * 1024, files: 1 } });
const UPLOAD_EXTS = /\.(bsp|wad|mdl|spr|wav|mp3|tga|res|txt|bmp)$/i;

function routeError(res, e) {
    res.status(e.statusCode || 500).json({ error: e.message });
}

function parsePort(raw) {
    if (!/^\d+$/.test(String(raw))) {
        const err = new Error('Invalid server port');
        err.statusCode = 400;
        throw err;
    }
    return parseInt(raw, 10);
}

// GET /api/fastdl/status - health check + config
router.get('/status', (req, res) => {
    const ok = fs.existsSync(fastdl.FASTDL_PATH);
    res.json({
        available: ok,
        fastdlPath: req.user.role === 'admin' ? fastdl.FASTDL_PATH : 'scoped',
        fastdlUrl: cfg.fastdlBaseUrl(),
        host: fastdl.FASTDL_HOST,
        port: fastdl.FASTDL_PORT
    });
});

router.use('/:port', async (req, res, next) => {
    try {
        const port = parsePort(req.params.port);
        req.serverRecord = await req.panelDb.requirePortAccess(req.user, req.docker, port);
        next();
    } catch (e) {
        routeError(res, e);
    }
});

// GET /api/fastdl/:port/files - list FastDL files for a server port
router.get('/:port/files', (req, res) => {
    try {
        const port = parsePort(req.params.port);
        res.json({
            port,
            url: fastdl.fastdlUrl(port),
            files: fastdl.listFastdlFiles(port)
        });
    } catch (e) {
        routeError(res, e);
    }
});

// DELETE /api/fastdl/:port/file - delete a file from FastDL
router.delete('/:port/file', (req, res) => {
    try {
        const port = parsePort(req.params.port);
        const relFile = req.query.path;
        if (!relFile) return res.status(400).json({ error: 'Missing path' });

        const fullPath = fastdl.resolveInside(fastdl.fastdlDir(port), String(relFile));
        if (fullPath === fastdl.resolveInside(fastdl.fastdlDir(port), '')) return res.status(400).json({ error: 'FastDL kök klasörü silinemez' });
        if (fs.existsSync(fullPath)) {
            fs.rmSync(fullPath, { recursive: true, force: true });
        }
        res.json({ success: true });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/fastdl/:port/upload - upload file directly to FastDL
router.post('/:port/upload', upload.single('file'), (req, res) => {
    try {
        const port = parsePort(req.params.port);
        if (!req.file) return res.status(400).json({ error: 'No file' });

        const subDir = String(req.body.subdir || '').replace(/\\/g, '/');
        const dir = fastdl.resolveInside(fastdl.fastdlDir(port), subDir);
        fastdl.ensureDir(dir);
        const filename = path.basename(req.file.originalname);
        if (!UPLOAD_EXTS.test(filename)) return res.status(400).json({ error: 'Yalnızca oyun istemcisinin indirdiği dosya türleri yüklenebilir (bsp, wad, mdl, spr, wav, mp3, tga, res, txt, bmp).' });
        const destPath = fastdl.resolveInside(dir, filename);
        fs.writeFileSync(destPath, req.file.buffer);

        res.json({ success: true, message: `${req.file.originalname} uploaded to FastDL.` });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/fastdl/:port/sync - copy maps/models/sound/sprites from CS container to FastDL
router.post('/:port/sync', async (req, res) => {
    try {
        const port = parsePort(req.params.port);
        const result = await fastdl.syncFastdlByPort(req.docker, port, req.body.categories);
        res.json(result);
    } catch (e) {
        routeError(res, e);
    }
});

// GET /api/fastdl/:port/downloadurl - get the sv_downloadurl for this server
router.get('/:port/downloadurl', (req, res) => {
    try {
        const port = parsePort(req.params.port);
        res.json({ sv_downloadurl: fastdl.svDownloadUrl(port) });
    } catch (e) {
        routeError(res, e);
    }
});

module.exports = router;
module.exports.fastdlDir = fastdl.fastdlDir;
module.exports.ensureDir = fastdl.ensureDir;
module.exports.FASTDL_PATH = fastdl.FASTDL_PATH;
module.exports.FASTDL_HOST = fastdl.FASTDL_HOST;
module.exports.FASTDL_PORT = fastdl.FASTDL_PORT;

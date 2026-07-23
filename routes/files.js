const express = require('express');
const path = require('path');
const multer = require('multer');
const cFs = require('../containerFsHelper');
const fastdlService = require('../fastdlService');

const router = express.Router();
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || String(256 * 1024 * 1024), 10);
const MAX_FOLDER_BATCH_BYTES = parseInt(process.env.MAX_FOLDER_BATCH_BYTES || String(96 * 1024 * 1024), 10);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 500 }
});

function safeResolve(relative) {
    return cFs.safeRelativePath(String(relative || ''));
}

function safeUploadName(name) {
    const filename = cFs.safeRelativePath(String(name || ''), { allowEmpty: false });
    if (filename.includes('/')) throw new Error('Upload filename must not contain a path');
    return filename;
}

function sendError(res, error) {
    const isBadRequest = /^(Access denied|Invalid|Missing|Upload filename)/.test(error.message);
    res.status(error.statusCode || (isBadRequest ? 400 : 500)).json({ error: error.message });
}

async function requireRunning(container) {
    const info = await container.inspect();
    if (!info.State.Running) {
        const error = new Error('Server is not running. Start the server to manage files.');
        error.statusCode = 503;
        throw error;
    }
    return info;
}

function gamePort(inspect) {
    const bindings = inspect.HostConfig && inspect.HostConfig.PortBindings || {};
    for (const [key, values] of Object.entries(bindings)) {
        if (key.endsWith('/udp') && values && values[0] && values[0].HostPort) {
            return parseInt(values[0].HostPort, 10);
        }
    }
    return null;
}

async function syncUploadedAssets(container, inspect, relPaths) {
    const assets = fastdlService.normalizeFastdlAssetPaths(relPaths);
    const port = gamePort(inspect);
    if (!assets.length || !port) return null;
    return fastdlService.syncFastdlFilesFromContainer(container, port, assets);
}

router.use('/:id', async (req, res, next) => {
    try {
        req.serverRecord = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        next();
    } catch (error) {
        sendError(res, error);
    }
});

// GET /api/files/:id/list
router.get('/:id/list', async (req, res) => {
    try {
        const container = req.docker.getContainer(req.params.id);
        await requireRunning(container);
        const relPath = safeResolve(req.query.path || '');
        const files = (await cFs.listFiles(container, relPath)).map(file => ({
            ...file,
            mtime: new Date(file.mtime),
            path: relPath ? `${relPath}/${file.name}` : file.name
        }));

        files.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        res.json({ currentPath: relPath, files });
    } catch (error) {
        sendError(res, error);
    }
});

// GET /api/files/:id/view
router.get('/:id/view', async (req, res) => {
    try {
        const container = req.docker.getContainer(req.params.id);
        await requireRunning(container);
        const relFile = safeResolve(req.query.file);
        if (!relFile) return res.status(400).json({ error: 'Missing file path' });
        const content = await cFs.readFile(container, relFile);
        res.json({ file: relFile, content });
    } catch (error) {
        sendError(res, error);
    }
});

// POST /api/files/:id/edit
router.post('/:id/edit', async (req, res) => {
    try {
        const container = req.docker.getContainer(req.params.id);
        await requireRunning(container);
        const relFile = safeResolve(req.body.file);
        if (!relFile) return res.status(400).json({ error: 'Missing file path' });
        const content = req.body.content === undefined ? '' : String(req.body.content);
        await cFs.writeFile(container, relFile, content);
        res.json({ success: true, message: 'File saved successfully' });
    } catch (error) {
        sendError(res, error);
    }
});

// GET /api/files/:id/download
router.get('/:id/download', async (req, res) => {
    try {
        const container = req.docker.getContainer(req.params.id);
        await requireRunning(container);
        const relFile = safeResolve(req.query.file);
        if (!relFile) return res.status(400).json({ error: 'Missing file path' });
        const targetFile = cFs.cstrikePath(relFile, { allowEmpty: false });
        const script = 'import base64, sys; sys.stdout.write(base64.b64encode(open(sys.argv[1], "rb").read()).decode("ascii"))';
        const result = await cFs.runExec(container, { Cmd: ['python3', '-c', script, targetFile] }, { timeoutMs: 120000 });
        const buffer = Buffer.from(result.output.trim(), 'base64');
        res.setHeader('Content-Disposition', `attachment; filename="${path.posix.basename(relFile).replace(/"/g, '')}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(buffer);
    } catch (error) {
        sendError(res, error);
    }
});

// POST /api/files/:id/upload
router.post('/:id/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const container = req.docker.getContainer(req.params.id);
        const inspect = await requireRunning(container);
        const relPath = safeResolve(req.body.path || '');
        const filename = safeUploadName(req.file.originalname);
        const targetFile = relPath ? `${relPath}/${filename}` : filename;
        await cFs.writeFile(container, targetFile, req.file.buffer);
        const fastdlSync = await syncUploadedAssets(container, inspect, [targetFile]);
        const warning = fastdlSync && !fastdlSync.success ? fastdlSync.message : undefined;
        res.json({ success: true, message: `File ${filename} uploaded successfully`, fastdlSync, warning });
    } catch (error) {
        sendError(res, error);
    }
});

// POST /api/files/:id/upload-folder
router.post('/:id/upload-folder', upload.array('files', 500), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }
        const requestBytes = req.files.reduce((sum, file) => sum + file.size, 0);
        if (requestBytes > MAX_FOLDER_BATCH_BYTES) {
            return res.status(413).json({
                error: `Folder batch exceeds ${Math.round(MAX_FOLDER_BATCH_BYTES / 1024 / 1024)} MB. Upload fewer files per batch.`
            });
        }
        const container = req.docker.getContainer(req.params.id);
        const inspect = await requireRunning(container);
        const basePath = safeResolve(req.body.basePath || '');
        const submittedPaths = Array.isArray(req.body.relativePaths)
            ? req.body.relativePaths
            : [req.body.relativePaths];
        const errors = [];
        const entries = [];

        for (let index = 0; index < req.files.length; index++) {
            const file = req.files[index];
            try {
                const relFile = submittedPaths[index]
                    ? cFs.safeRelativePath(String(submittedPaths[index]), { allowEmpty: false })
                    : safeUploadName(file.originalname);
                const targetFile = basePath ? `${basePath}/${relFile}` : relFile;
                entries.push({ relPath: targetFile, content: file.buffer });
            } catch (error) {
                errors.push({ file: file.originalname, error: error.message });
            }
        }

        const batchResult = entries.length
            ? await cFs.writeFiles(container, entries)
            : { written: [], errors: [] };
        errors.push(...batchResult.errors);
        const uploadedPaths = batchResult.written;
        const successCount = uploadedPaths.length;

        const fastdlSync = await syncUploadedAssets(container, inspect, uploadedPaths);
        const warning = fastdlSync && !fastdlSync.success ? fastdlSync.message : undefined;
        if (errors.length) {
            return res.status(successCount ? 207 : 500).json({
                success: successCount > 0,
                uploaded: successCount,
                total: req.files.length,
                message: `Uploaded ${successCount}/${req.files.length} files. ${errors.length} failed.`,
                errors,
                fastdlSync,
                warning
            });
        }
        res.json({
            success: true,
            uploaded: successCount,
            total: req.files.length,
            message: `Folder uploaded successfully: ${successCount} files written.`,
            fastdlSync,
            warning
        });
    } catch (error) {
        sendError(res, error);
    }
});

// DELETE /api/files/:id
router.delete('/:id', async (req, res) => {
    try {
        const container = req.docker.getContainer(req.params.id);
        await requireRunning(container);
        const relFile = safeResolve(req.query.file);
        if (!relFile) return res.status(400).json({ error: 'Missing path to delete' });
        await cFs.removePath(container, relFile, { recursive: true });
        res.json({ success: true, message: 'Item deleted successfully' });
    } catch (error) {
        sendError(res, error);
    }
});

module.exports = router;

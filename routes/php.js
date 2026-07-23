const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 64 * 1024 * 1024,
        files: 100,
        fields: 200
    }
});

const PHP_WWW_PATH = process.env.PHP_WWW_PATH || path.join(__dirname, '..', 'php-www');

function routeError(res, e) {
    res.status(e.statusCode || 500).json({ error: e.message });
}

function httpError(status, message) {
    const err = new Error(message);
    err.statusCode = status;
    return err;
}

function safePhpPath(rel) {
    const normalized = path.normalize(rel || '').replace(/\\/g, '/');
    if (normalized === '.' || normalized === '/') return '';
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
        throw httpError(403, 'Path traversal denied');
    }
    return normalized.replace(/^\/+/, '');
}

function resolveInside(base, rel = '') {
    const resolvedBase = path.resolve(base);
    const resolved = path.resolve(resolvedBase, rel);
    if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
        throw httpError(403, 'Access denied');
    }
    return resolved;
}

function assertNoSymlinkSegments(base, rel = '') {
    let current = path.resolve(base);
    const parts = safePhpPath(rel).split('/').filter(Boolean);
    for (const part of parts) {
        current = path.join(current, part);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
            throw httpError(403, 'Symbolic links are not available in the file manager');
        }
    }
}

function resolvePhpPath(rel = '') {
    const relPath = safePhpPath(rel);
    assertNoSymlinkSegments(PHP_WWW_PATH, relPath);
    return { relPath, fullPath: resolveInside(PHP_WWW_PATH, relPath) };
}

function safeEntryName(value, label = 'name') {
    const name = String(value || '').trim();
    if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
        throw httpError(400, `Invalid ${label}`);
    }
    return name;
}

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function getOwnedPhpRoots(req) {
    const rows = await req.panelDb.listServersForUser(req.user);
    return rows
        .filter(row => row.php_path)
        .map(row => ({
            name: String(row.port),
            path: row.php_path.replace(/\\/g, '/'),
            url: row.php_url,
            serverId: row.container_id
        }));
}

async function getScopedPath(req, rel, options = {}) {
    const relPath = safePhpPath(rel);
    if (req.user.role === 'admin') {
        return { ...resolvePhpPath(relPath), virtual: false };
    }

    const roots = await getOwnedPhpRoots(req);
    if (!relPath && options.allowVirtualRoot) {
        return { relPath, roots, virtual: true };
    }

    const allowed = roots.find(root => relPath === root.path || relPath.startsWith(`${root.path}/`));
    if (!allowed) throw httpError(403, 'Access denied for this PHP path');
    return { ...resolvePhpPath(relPath), roots, virtual: false };
}

// GET /api/php/status - PHP container status via Docker
router.get('/status', async (req, res) => {
    try {
        const containers = await req.docker.listContainers({ all: true });
        const php = containers.find(c => c.Names && c.Names.some(n => n.includes('cs-php')));
        const roots = req.user.role === 'admin' ? [] : await getOwnedPhpRoots(req);
        if (!php) {
            return res.json({ running: false, message: 'cs-php container not found. Start with docker-compose.', roots });
        }
        const userUrl = roots.length === 1 ? roots[0].url : null;
        res.json({
            running: php.State === 'running',
            status: php.Status,
            id: php.Id,
            url: userUrl || `http://localhost:8081/?p={port}`,
            wwwPath: req.user.role === 'admin' ? PHP_WWW_PATH : 'scoped',
            roots
        });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/php/restart - restart PHP container (admin only)
router.post('/restart', async (req, res) => {
    try {
        if (req.user.role !== 'admin') throw httpError(403, 'Admin access required');
        const containers = await req.docker.listContainers({ all: true });
        const phpInfo = containers.find(c => c.Names && c.Names.some(n => n.includes('cs-php')));
        if (!phpInfo) return res.status(404).json({ error: 'cs-php container not found' });

        const container = req.docker.getContainer(phpInfo.Id);
        await container.restart();
        res.json({ success: true, message: 'PHP container restarted.' });
    } catch (e) {
        routeError(res, e);
    }
});

// GET /api/php/files - list files in php-www volume or scoped user roots
router.get('/files', async (req, res) => {
    try {
        ensureDir(PHP_WWW_PATH);
        const scoped = await getScopedPath(req, req.query.path || '', { allowVirtualRoot: true });

        if (scoped.virtual) {
            scoped.roots.forEach(root => ensureDir(resolveInside(PHP_WWW_PATH, root.path)));
            return res.json({
                path: '',
                files: scoped.roots.map(root => ({
                    name: root.name,
                    path: root.path,
                    isDir: true,
                    size: 0,
                    mtime: new Date()
                }))
            });
        }

        const dir = scoped.fullPath;
        if (!fs.existsSync(dir)) return res.json({ path: scoped.relPath, files: [] });
        if (!fs.statSync(dir).isDirectory()) throw httpError(400, 'Path is not a directory');

        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files = entries.map(e => {
            const fullPath = path.join(dir, e.name);
            const stat = fs.statSync(fullPath);
            return {
                name: e.name,
                path: scoped.relPath ? `${scoped.relPath}/${e.name}` : e.name,
                isDir: e.isDirectory(),
                size: e.isFile() ? stat.size : 0,
                mtime: stat.mtime
            };
        }).sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        res.json({ path: scoped.relPath, files });
    } catch (e) {
        routeError(res, e);
    }
});

// GET /api/php/files/view - read file content
router.get('/files/view', async (req, res) => {
    try {
        const scoped = await getScopedPath(req, req.query.file);
        if (!fs.existsSync(scoped.fullPath)) return res.status(404).json({ error: 'File not found' });
        const stat = fs.statSync(scoped.fullPath);
        if (!stat.isFile()) throw httpError(400, 'Path is not a file');
        if (stat.size > 5 * 1024 * 1024) throw httpError(413, 'File is too large to edit (maximum 5 MB)');
        const content = fs.readFileSync(scoped.fullPath, 'utf8');
        res.json({ file: scoped.relPath, content });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/php/files/edit - create or edit file
router.post('/files/edit', async (req, res) => {
    try {
        if (!req.body.file) return res.status(400).json({ error: 'Missing file path' });
        const scoped = await getScopedPath(req, req.body.file);
        if (!scoped.relPath) throw httpError(400, 'Missing file path');
        if (fs.existsSync(scoped.fullPath) && fs.statSync(scoped.fullPath).isDirectory()) {
            throw httpError(400, 'Path is a directory');
        }
        ensureDir(path.dirname(scoped.fullPath));
        fs.writeFileSync(scoped.fullPath, req.body.content || '');
        res.json({ success: true, message: 'File saved.' });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/php/files/upload - upload file(s) to php-www
router.post('/files/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const scoped = await getScopedPath(req, req.body.path || '');
        ensureDir(scoped.fullPath);
        if (!fs.statSync(scoped.fullPath).isDirectory()) throw httpError(400, 'Upload path is not a directory');
        const filename = safeEntryName(path.basename(req.file.originalname), 'file name');
        const destPath = resolveInside(scoped.fullPath, filename);
        fs.writeFileSync(destPath, req.file.buffer);
        res.json({ success: true, message: `${req.file.originalname} uploaded.` });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/php/files/upload-folder - upload a directory tree while preserving paths
router.post('/files/upload-folder', upload.array('files', 100), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) throw httpError(400, 'No files uploaded');

        const scoped = await getScopedPath(req, req.body.basePath || '');
        ensureDir(scoped.fullPath);
        if (!fs.statSync(scoped.fullPath).isDirectory()) throw httpError(400, 'Upload path is not a directory');

        const rawPaths = Array.isArray(req.body.relativePaths)
            ? req.body.relativePaths
            : [req.body.relativePaths];
        if (rawPaths.length !== req.files.length) throw httpError(400, 'Folder path metadata is incomplete');

        let uploaded = 0;
        for (let i = 0; i < req.files.length; i++) {
            const relativePath = safePhpPath(rawPaths[i] || req.files[i].originalname);
            if (!relativePath) throw httpError(400, 'Invalid folder file path');

            assertNoSymlinkSegments(scoped.fullPath, relativePath);
            const destPath = resolveInside(scoped.fullPath, relativePath);
            ensureDir(path.dirname(destPath));
            fs.writeFileSync(destPath, req.files[i].buffer);
            uploaded++;
        }

        res.json({ success: true, uploaded, message: `${uploaded} file(s) uploaded.` });
    } catch (e) {
        routeError(res, e);
    }
});

// POST /api/php/files/mkdir - create a directory in the current PHP root
router.post('/files/mkdir', async (req, res) => {
    try {
        const scoped = await getScopedPath(req, req.body.path || '');
        const name = safeEntryName(req.body.name, 'directory name');
        ensureDir(scoped.fullPath);
        if (!fs.statSync(scoped.fullPath).isDirectory()) throw httpError(400, 'Parent path is not a directory');

        const relDir = scoped.relPath ? `${scoped.relPath}/${name}` : name;
        const target = resolvePhpPath(relDir);
        if (fs.existsSync(target.fullPath)) throw httpError(409, 'A file or directory with this name already exists');

        fs.mkdirSync(target.fullPath);
        res.status(201).json({ success: true, path: target.relPath, message: `Directory ${name} created.` });
    } catch (e) {
        routeError(res, e);
    }
});

// DELETE /api/php/files - delete file or folder
router.delete('/files', async (req, res) => {
    try {
        if (!req.query.path) return res.status(400).json({ error: 'Missing path' });
        const scoped = await getScopedPath(req, req.query.path);
        if (!scoped.relPath) throw httpError(403, 'The PHP root cannot be deleted');
        if (req.user.role !== 'admin' && (scoped.roots || []).some(root => root.path === scoped.relPath)) {
            throw httpError(403, 'The assigned server root cannot be deleted');
        }
        if (fs.existsSync(scoped.fullPath)) {
            fs.rmSync(scoped.fullPath, { recursive: true, force: true });
        }
        res.json({ success: true });
    } catch (e) {
        routeError(res, e);
    }
});

module.exports = router;

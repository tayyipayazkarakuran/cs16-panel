const express = require('express');
const router = express.Router();
const multer = require('multer');
const cFs = require('../containerFsHelper');

const MAX_MAP_BYTES = parseInt(process.env.MAX_MAP_BYTES || String(256 * 1024 * 1024), 10);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MAP_BYTES, files: 1 } });
const fastdlService = require('../fastdlService');
const fs = require('fs');
const path = require('path');

function safeMapFilename(value) {
    const filename = cFs.safeRelativePath(String(value || ''), { allowEmpty: false });
    if (filename.includes('/') || !filename.toLowerCase().endsWith('.bsp')) {
        const error = new Error('Map must be a .bsp filename without a path');
        error.statusCode = 400;
        throw error;
    }
    return filename;
}

router.use('/:id', async (req, res, next) => {
    try {
        req.serverRecord = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        next();
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// GET /api/maps/:id - List maps and mapcycle
router.get('/:id', async (req, res) => {
    try {
        const container = req.docker.getContainer(req.params.id);
        const inspect = await container.inspect();

        if (!inspect.State.Running) {
            return res.json({ maps: [], mapcycle: [], offline: true });
        }

        // 1. Scan maps folder
        const allFiles = await cFs.listFiles(container, 'maps');
        const maps = allFiles
            .filter(f => f.name.endsWith('.bsp'))
            .map(m => ({
                name: m.name.slice(0, -4),
                filename: m.name,
                size: m.size
            }));

        // 2. Read mapcycle.txt
        let mapcycle = [];
        const mapcyclePath = 'mapcycle.txt';
        if (await cFs.fileExists(container, mapcyclePath)) {
            const content = await cFs.readFile(container, mapcyclePath);
            mapcycle = content.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith(';') && !line.startsWith('//'));
        }

        maps.sort((a, b) => a.name.localeCompare(b.name));

        res.json({ maps, mapcycle });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// POST /api/maps/:id/mapcycle - Save mapcycle.txt
router.post('/:id/mapcycle', async (req, res) => {
    try {
        const container = req.docker.getContainer(req.params.id);
        const { mapcycle } = req.body;

        if (!Array.isArray(mapcycle) || mapcycle.length > 500) {
            return res.status(400).json({ error: 'mapcycle must be an array (max 500 maps)' });
        }
        const invalid = mapcycle.map(m => String(m).trim()).filter(Boolean).find(m => !/^[A-Za-z0-9_.-]{1,64}$/.test(m));
        if (invalid) return res.status(400).json({ error: `Geçersiz harita adı: ${invalid}` });

        const mapcyclePath = 'mapcycle.txt';
        await cFs.writeFile(container, mapcyclePath, `${mapcycle.map(m => String(m).trim()).filter(Boolean).join('\n')}\n`);

        res.json({ success: true, message: 'mapcycle.txt updated successfully' });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// POST /api/maps/:id/upload - Upload new .bsp map file
router.post('/:id/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const filename = safeMapFilename(req.file.originalname);

        const container = req.docker.getContainer(req.params.id);
        const destPath = 'maps/' + filename;

        await cFs.writeFile(container, destPath, req.file.buffer);

        // Optionally add to mapcycle
        if (req.body.addToCycle === 'true') {
            const mapcyclePath = 'mapcycle.txt';
            const mapName = filename.slice(0, -4);
            
            let currentCycle = '';
            if (await cFs.fileExists(container, mapcyclePath)) {
                currentCycle = await cFs.readFile(container, mapcyclePath);
            }

            const cycleEntries = currentCycle.split(/\r?\n/).map(line => line.trim());
            if (!cycleEntries.includes(mapName)) {
                const separator = currentCycle && !currentCycle.endsWith('\n') ? '\n' : '';
                await cFs.writeFile(container, mapcyclePath, `${currentCycle}${separator}${mapName}\n`);
            }
        }

        // Auto Sync with FastDL
        let fastdlSync = null;
        try {
            const inspect = await container.inspect();
            let port = null;
            const portBindings = inspect.HostConfig.PortBindings;
            for (const key in portBindings) {
                if (key.endsWith('/udp')) {
                    port = parseInt(portBindings[key][0].HostPort, 10);
                    break;
                }
            }
            if (port) {
                fastdlSync = await fastdlService.syncFastdlFilesFromContainer(container, port, [destPath]);
            }
        } catch (syncErr) {
            console.log('Auto FastDL sync failed:', syncErr.message);
            fastdlSync = { success: false, message: `FastDL sync failed: ${syncErr.message}` };
        }

        const warning = fastdlSync && !fastdlSync.success ? fastdlSync.message : undefined;
        res.json({ success: true, message: `Map ${filename} uploaded successfully`, fastdlSync, warning });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// DELETE /api/maps/:id - Delete a map
router.delete('/:id', async (req, res) => {
    try {
        const filename = safeMapFilename(req.query.filename);

        const container = req.docker.getContainer(req.params.id);
        await cFs.removePath(container, `maps/${filename}`);

        // Remove from mapcycle.txt
        const mapcyclePath = 'mapcycle.txt';
        const mapName = filename.slice(0, -4);
        if (await cFs.fileExists(container, mapcyclePath)) {
            const content = await cFs.readFile(container, mapcyclePath);
            const lines = content.split('\n');
            const newLines = lines.filter(line => line.trim() !== mapName);
            await cFs.writeFile(container, mapcyclePath, newLines.join('\n'));
        }

        // Remove from FastDL directory as well
        try {
            const inspect = await container.inspect();
            let port = null;
            const portBindings = inspect.HostConfig.PortBindings;
            for (const key in portBindings) {
                if (key.endsWith('/udp')) {
                    port = parseInt(portBindings[key][0].HostPort, 10);
                    break;
                }
            }
            if (port) {
                const localMapBsp = path.join(fastdlService.fastdlDir(port), 'maps', filename);
                const localMapRes = path.join(fastdlService.fastdlDir(port), 'maps', filename.replace('.bsp', '.res'));
                if (fs.existsSync(localMapBsp)) fs.unlinkSync(localMapBsp);
                if (fs.existsSync(localMapRes)) fs.unlinkSync(localMapRes);
            }
        } catch (err) {
            console.log('Failed to delete map from FastDL:', err.message);
        }

        res.json({ success: true, message: 'Map deleted successfully' });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

module.exports = router;

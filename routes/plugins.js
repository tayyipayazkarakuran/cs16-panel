const express = require('express');
const router = express.Router();
const multer = require('multer');
const cFs = require('../containerFsHelper');

const MAX_PLUGIN_BYTES = parseInt(process.env.MAX_PLUGIN_BYTES || String(16 * 1024 * 1024), 10);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PLUGIN_BYTES, files: 1 } });

function safePluginFilename(value, extension = null) {
    const filename = cFs.safeRelativePath(String(value || ''), { allowEmpty: false });
    if (filename.includes('/') || /[\r\n]/.test(filename)) {
        const error = new Error('Plugin filename must not contain a path or line break');
        error.statusCode = 400;
        throw error;
    }
    if (extension && !filename.toLowerCase().endsWith(extension)) {
        const error = new Error(`Plugin filename must end with ${extension}`);
        error.statusCode = 400;
        throw error;
    }
    return filename;
}

function hasPluginEntry(content, filename) {
    return content.split(/\r?\n/).some(line => {
        const clean = line.trim().replace(/^[;//\s]+/, '').trim();
        return clean.split(/\s+/)[0] === filename;
    });
}

router.use('/:id', async (req, res, next) => {
    try {
        req.serverRecord = await req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
        next();
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// GET /api/plugins/:id - List all plugins
router.get('/:id', async (req, res) => {
    try {
        const container = req.docker.getContainer(req.params.id);
        const inspect = await container.inspect();

        if (!inspect.State.Running) {
            return res.json({ plugins: [], sourceFiles: [], offline: true });
        }

        const pluginsIniPath = 'addons/amxmodx/configs/plugins.ini';
        const pluginsDirPath = 'addons/amxmodx/plugins';
        const scriptingDirPath = 'addons/amxmodx/scripting';

        // 1. Read plugins.ini
        let iniContent = '';
        if (await cFs.fileExists(container, pluginsIniPath)) {
            iniContent = await cFs.readFile(container, pluginsIniPath);
        }

        const iniLines = iniContent.split('\n').map(l => l.trim());
        const plugins = [];
        const seenInIni = new Set();

        iniLines.forEach((line) => {
            if (!line) return;
            const isComment = line.startsWith(';') || line.startsWith('//');
            const cleanLine = line.replace(/^[;//\s]+/, '').trim();
            const parts = cleanLine.split(/\s+/);
            const filename = parts[0];
            const description = parts.slice(1).join(' ') || '';

            if (filename.endsWith('.amxx')) {
                plugins.push({
                    filename,
                    enabled: !isComment,
                    description,
                    inIni: true
                });
                seenInIni.add(filename);
            }
        });

        // 2. Scan plugins folder
        const allPluginsFiles = await cFs.listFiles(container, pluginsDirPath);
        allPluginsFiles.forEach(file => {
            if (file.name.endsWith('.amxx') && !seenInIni.has(file.name)) {
                plugins.push({
                    filename: file.name,
                    enabled: false,
                    description: 'Not in plugins.ini',
                    inIni: false
                });
            }
        });

        // 3. Scan scripting folder
        const allScriptingFiles = await cFs.listFiles(container, scriptingDirPath);
        const sourceFiles = allScriptingFiles
            .filter(f => f.name.endsWith('.sma'))
            .map(f => f.name);

        res.json({ plugins, sourceFiles });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// POST /api/plugins/:id/toggle - Enable/Disable plugin
router.post('/:id/toggle', async (req, res) => {
    try {
        const container = req.docker.getContainer(req.params.id);
        const { enable } = req.body;
        const filename = safePluginFilename(req.body.filename, '.amxx');

        if (!filename) return res.status(400).json({ error: 'Missing filename' });

        const pluginsIniPath = 'addons/amxmodx/configs/plugins.ini';
        let content = '';
        if (await cFs.fileExists(container, pluginsIniPath)) {
            content = await cFs.readFile(container, pluginsIniPath);
        }

        const lines = content.split('\n');
        let found = false;

        const newLines = lines.map((line) => {
            const cleanLine = line.trim();
            const isComment = cleanLine.startsWith(';') || cleanLine.startsWith('//');
            const lineFilename = cleanLine.replace(/^[;//\s]+/, '').trim().split(/\s+/)[0];

            if (lineFilename === filename) {
                found = true;
                if (enable && isComment) {
                    return line.replace(/^[;//\s]+/, '');
                } else if (!enable && !isComment) {
                    return ';' + line;
                }
            }
            return line;
        });

        if (!found && enable) {
            newLines.push(filename);
        }

        await cFs.writeFile(container, pluginsIniPath, newLines.join('\n'));
        res.json({ success: true, message: `Plugin ${enable ? 'enabled' : 'disabled'} successfully` });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// POST /api/plugins/:id/order - Save plugin order
router.post('/:id/order', async (req, res) => {
    try {
        const container = req.docker.getContainer(req.params.id);
        const { orderedFilenames } = req.body;

        if (!Array.isArray(orderedFilenames)) {
            return res.status(400).json({ error: 'orderedFilenames must be an array' });
        }
        const safeOrderedFilenames = orderedFilenames.map(file => safePluginFilename(file, '.amxx'));

        const pluginsIniPath = 'addons/amxmodx/configs/plugins.ini';
        let originalContent = '';
        if (await cFs.fileExists(container, pluginsIniPath)) {
            originalContent = await cFs.readFile(container, pluginsIniPath);
        }

        const lines = originalContent.split('\n');
        const nonPluginLines = [];
        const pluginMap = new Map();

        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) {
                nonPluginLines.push(line);
                return;
            }
            const clean = trimmed.replace(/^[;//\s]+/, '');
            const filename = clean.split(/\s+/)[0];

            if (filename.endsWith('.amxx')) {
                pluginMap.set(filename, line);
            } else {
                nonPluginLines.push(line);
            }
        });

        const newLines = [];
        nonPluginLines.forEach(l => {
            if (l.trim().startsWith(';')) newLines.push(l);
        });

        safeOrderedFilenames.forEach(file => {
            if (pluginMap.has(file)) {
                newLines.push(pluginMap.get(file));
            } else {
                newLines.push(file);
            }
        });

        nonPluginLines.forEach(l => {
            if (!l.trim().startsWith(';')) newLines.push(l);
        });

        await cFs.writeFile(container, pluginsIniPath, newLines.join('\n'));
        res.json({ success: true, message: 'Plugin order updated successfully' });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// POST /api/plugins/:id/upload - Upload SMA/AMXX
router.post('/:id/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const container = req.docker.getContainer(req.params.id);
        const filename = safePluginFilename(req.file.originalname);
        
        let relPath = '';
        if (filename.toLowerCase().endsWith('.sma')) {
            relPath = 'addons/amxmodx/scripting/' + filename;
        } else if (filename.toLowerCase().endsWith('.amxx')) {
            relPath = 'addons/amxmodx/plugins/' + filename;
        } else {
            return res.status(400).json({ error: 'Only .sma and .amxx files allowed' });
        }

        await cFs.writeFile(container, relPath, req.file.buffer);

        const addToIni = req.body.addToIni === true || req.body.addToIni === 'true';
        if (filename.toLowerCase().endsWith('.amxx') && addToIni) {
            const pluginsIniPath = 'addons/amxmodx/configs/plugins.ini';
            let iniContent = '';
            if (await cFs.fileExists(container, pluginsIniPath)) {
                iniContent = await cFs.readFile(container, pluginsIniPath);
            }
            if (!hasPluginEntry(iniContent, filename)) {
                await cFs.writeFile(container, pluginsIniPath, iniContent + `\n${filename}`);
            }
        }

        res.json({ success: true, message: `${filename} uploaded successfully` });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// POST /api/plugins/:id/compile - Compile SMA to AMXX inside container
router.post('/:id/compile', async (req, res) => {
    try {
        const filename = safePluginFilename(req.body.filename, '.sma');

        const container = req.docker.getContainer(req.params.id);
        const inspect = await container.inspect();

        if (!inspect.State.Running) {
            return res.status(400).json({ error: 'Server must be running to compile plugins' });
        }

        const amxxFilename = filename.replace(/\.sma$/i, '.amxx');
        const sourcePath = `addons/amxmodx/scripting/${filename}`;
        if (!await cFs.fileExists(container, sourcePath)) {
            return res.status(404).json({ error: 'Selected .sma source file was not found' });
        }
        const tempFilename = `.cspanel-compile-${process.pid}-${Date.now()}-${amxxFilename}`;
        const tempPath = `addons/amxmodx/scripting/${tempFilename}`;

        // Older/restored cstrike volumes may lose the executable bit even
        // though the compiler binary itself is valid. Repair only this fixed,
        // trusted AMXX compiler path before execution.
        const compilerPath = cFs.cstrikePath('addons/amxmodx/scripting/amxxpc', { allowEmpty: false });
        if (!await cFs.fileExists(container, 'addons/amxmodx/scripting/amxxpc')) {
            return res.status(409).json({ error: 'AMX Mod X compiler (amxxpc) is missing from this server' });
        }
        await cFs.runExec(container, {
            Cmd: ['python3', '-c', 'import os, sys; os.chmod(sys.argv[1], 0o755)', compilerPath]
        });

        // Compile to a temporary file first so a failed compile never destroys
        // the last known-good .amxx binary.
        const compile = await cFs.runExec(container, {
            Cmd: ['./amxxpc', filename, `-o${tempFilename}`],
            WorkingDir: '/hlds/cstrike/addons/amxmodx/scripting'
        }, { timeoutMs: 60000, allowNonZero: true });
        const output = compile.output;
        const success = compile.info.ExitCode === 0;

        if (success) {
            if (!await cFs.fileExists(container, tempPath)) {
                return res.json({ success: false, message: 'Compiler did not produce an .amxx file.', output });
            }
            const finalPath = cFs.cstrikePath(`addons/amxmodx/plugins/${amxxFilename}`, { allowEmpty: false });
            const compiledPath = cFs.cstrikePath(tempPath, { allowEmpty: false });
            await cFs.runExec(container, {
                Cmd: ['python3', '-c', 'import os, sys; os.replace(sys.argv[1], sys.argv[2])', compiledPath, finalPath]
            });
            if (req.body.addToIni === true || req.body.addToIni === 'true') {
                const pluginsIniPath = 'addons/amxmodx/configs/plugins.ini';
                let iniContent = '';
                if (await cFs.fileExists(container, pluginsIniPath)) {
                    iniContent = await cFs.readFile(container, pluginsIniPath);
                }
                if (!hasPluginEntry(iniContent, amxxFilename)) {
                    await cFs.writeFile(container, pluginsIniPath, iniContent + `\n${amxxFilename}`);
                }
            }
            res.json({ success: true, message: 'Compilation successful!', output });
        } else {
            try { await cFs.removePath(container, tempPath); } catch (_) { /* best effort cleanup */ }
            res.json({ success: false, message: 'Compilation failed!', output });
        }
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

module.exports = router;

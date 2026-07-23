const fs = require('fs');
const path = require('path');
const containerFs = require('./containerFsHelper');

const FASTDL_PATH = process.env.FASTDL_PATH || path.join(__dirname, 'fastdl-data');
const FASTDL_HOST = process.env.FASTDL_HOST || '127.0.0.1';
const FASTDL_PORT = process.env.FASTDL_PORT || '8080';

const CATEGORY_MAP = {
    maps: { source: 'maps', dest: 'maps' },
    models: { source: 'models', dest: 'models' },
    sound: { source: 'sound', dest: 'sound' },
    sounds: { source: 'sound', dest: 'sound' },
    sprites: { source: 'sprites', dest: 'sprites' },
    gfx: { source: 'gfx', dest: 'gfx' }
};

const DEFAULT_CATEGORIES = ['maps', 'models', 'sound', 'sprites', 'gfx'];
const FASTDL_DIRS = ['maps', 'models', 'sound', 'sprites', 'gfx'];
const ALLOWED_EXTS = new Set(['.bsp', '.wad', '.mdl', '.spr', '.wav', '.mp3', '.tga', '.res', '.txt', '.cfg', '.bmp']);
const ROOT_ASSET_EXTS = new Set(['.wad', '.tga', '.bsp', '.res', '.txt', '.cfg']);

function fastdlDir(port) {
    return path.join(FASTDL_PATH, String(port));
}

function fastdlUrl(port) {
    const portStr = (FASTDL_PORT === '80' || FASTDL_PORT === '443') ? '' : `:${FASTDL_PORT}`;
    return `http://${FASTDL_HOST}${portStr}/${port}`;
}

function svDownloadUrl(port) {
    return `${fastdlUrl(port)}/`;
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function resolveInside(base, rel = '') {
    const resolvedBase = path.resolve(base);
    const resolved = path.resolve(resolvedBase, rel);
    if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
        const err = new Error('Access denied');
        err.statusCode = 403;
        throw err;
    }
    return resolved;
}

function ensureFastdlTree(port) {
    const base = fastdlDir(port);
    ensureDir(base);
    FASTDL_DIRS.forEach(dir => ensureDir(path.join(base, dir)));
    return base;
}

function ensureCleanFastdlTree(port) {
    removeFastdlTree(port);
    return ensureFastdlTree(port);
}

function removeFastdlTree(port) {
    const dir = resolveInside(FASTDL_PATH, String(port));
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function normalizeCategories(categories) {
    const requested = Array.isArray(categories) && categories.length ? categories : DEFAULT_CATEGORIES;
    const normalized = [];
    const seen = new Set();
    requested.forEach(cat => {
        const key = String(cat || '').toLowerCase();
        const mapped = CATEGORY_MAP[key];
        if (mapped && !seen.has(mapped.dest)) {
            seen.add(mapped.dest);
            normalized.push(mapped);
        }
    });
    return normalized.length ? normalized : DEFAULT_CATEGORIES.map(cat => CATEGORY_MAP[cat]);
}

function demuxDockerChunk(chunk) {
    if (chunk.length >= 8 && (chunk[0] === 1 || chunk[0] === 2)) {
        let offset = 0;
        let text = '';
        while (offset + 8 <= chunk.length) {
            const size = chunk.readUInt32BE(offset + 4);
            text += chunk.toString('utf8', offset + 8, offset + 8 + size);
            offset += 8 + size;
        }
        return text;
    }
    return chunk.toString('utf8');
}

async function collectExecOutput(exec) {
    const stream = await exec.start({});
    let output = '';
    await new Promise((resolve, reject) => {
        stream.on('data', chunk => { output += demuxDockerChunk(chunk); });
        stream.on('end', resolve);
        stream.on('error', reject);
    });
    return output;
}

async function listContainerFiles(container, sourceRoot, allowedExts) {
    const pythonScript = `
import os, json, sys
root = sys.argv[1]
allowed = set(sys.argv[2].split(","))
items = []
if os.path.exists(root):
    for current, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            ext = os.path.splitext(name)[1].lower()
            if ext not in allowed:
                continue
            full = os.path.join(current, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            try:
                items.append({"rel": rel, "size": os.path.getsize(full)})
            except Exception:
                pass
print(json.dumps(items))
`;
    const exec = await container.exec({
        Cmd: ['python3', '-c', pythonScript, `/hlds/cstrike/${sourceRoot}`, Array.from(allowedExts).join(',')],
        AttachStdout: true,
        AttachStderr: true
    });
    const output = await collectExecOutput(exec);
    try {
        return JSON.parse(output.trim() || '[]');
    } catch (e) {
        return [];
    }
}

async function listContainerRootAssets(container) {
    const pythonScript = `
import os, json, sys
root = sys.argv[1]
allowed = set(sys.argv[2].split(","))
items = []
if os.path.exists(root):
    for name in os.listdir(root):
        full = os.path.join(root, name)
        if not os.path.isfile(full):
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext in allowed:
            items.append({"rel": name, "size": os.path.getsize(full)})
print(json.dumps(items))
`;
    const exec = await container.exec({
        Cmd: ['python3', '-c', pythonScript, '/hlds/cstrike', Array.from(ROOT_ASSET_EXTS).join(',')],
        AttachStdout: true,
        AttachStderr: true
    });
    const output = await collectExecOutput(exec);
    try {
        return JSON.parse(output.trim() || '[]');
    } catch (e) {
        return [];
    }
}

async function readContainerFile(container, absolutePath) {
    const pythonScript = `
import sys, base64
try:
    with open(sys.argv[1], "rb") as f:
        sys.stdout.write(base64.b64encode(f.read()).decode("ascii"))
except Exception as e:
    sys.stderr.write(str(e))
`;
    const exec = await container.exec({
        Cmd: ['python3', '-c', pythonScript, absolutePath],
        AttachStdout: true,
        AttachStderr: true
    });
    const output = await collectExecOutput(exec);
    return Buffer.from(output.trim(), 'base64');
}

function writeFastdlFile(port, relPath, buffer) {
    const fullPath = resolveInside(fastdlDir(port), relPath);
    ensureDir(path.dirname(fullPath));
    // A same-size file can still have different content after an overwrite.
    if (fs.existsSync(fullPath)) {
        const stat = fs.statSync(fullPath);
        if (stat.size === buffer.length && fs.readFileSync(fullPath).equals(buffer)) return false;
    }
    fs.writeFileSync(fullPath, buffer);
    return true;
}

async function findRunningContainerByPort(docker, port) {
    const containers = await docker.listContainers({ all: false });
    return containers.find(c => c.Ports && c.Ports.some(p => p.PublicPort == port && p.Type === 'udp')) || null;
}

async function syncFastdlFromContainer(container, port, categories = null) {
    ensureFastdlTree(port);
    const foldersList = normalizeCategories(categories).map(c => c.source).join(',');
    
    const pythonScript = `
import sys, os, shutil, json, filecmp
allowed_exts = {'.bsp', '.res', '.wav', '.mp3', '.mdl', '.spr', '.txt', '.cfg', '.tga', '.wad', '.bmp'}
src_root = '/hlds/cstrike'
dst_root = '/fastdl-data'
folders = sys.argv[1].split(',') if len(sys.argv) > 1 and sys.argv[1] else ['maps', 'models', 'sound', 'sprites']
total_copied = 0
total_errors = 0
logs = []
for folder in folders:
    src_dir = os.path.join(src_root, folder)
    if not os.path.exists(src_dir):
        continue
    for root, dirs, files in os.walk(src_dir):
        for file in files:
            ext = os.path.splitext(file)[1].lower()
            if ext not in allowed_exts:
                continue
            src_file = os.path.join(root, file)
            rel_path = os.path.relpath(src_file, src_root)
            dst_file = os.path.join(dst_root, rel_path)
            if os.path.exists(dst_file) and filecmp.cmp(dst_file, src_file, shallow=False):
                logs.append("SKIP: " + rel_path + " (unchanged)")
                continue
            os.makedirs(os.path.dirname(dst_file), exist_ok=True)
            try:
                shutil.copy2(src_file, dst_file)
                total_copied += 1
                logs.append("OK: " + rel_path)
            except Exception as e:
                total_errors += 1
                logs.append("ERR: " + rel_path + " - " + str(e))
if 'maps' in folders:
    for file in os.listdir(src_root):
        full_src = os.path.join(src_root, file)
        if not os.path.isfile(full_src):
            continue
        ext = os.path.splitext(file)[1].lower()
        if ext in {'.wad', '.tga', '.bsp', '.res', '.txt', '.cfg'}:
            dst_file = os.path.join(dst_root, file)
            if os.path.exists(dst_file) and filecmp.cmp(dst_file, full_src, shallow=False):
                logs.append("SKIP: " + file + " (unchanged)")
                continue
            try:
                shutil.copy2(full_src, dst_file)
                total_copied += 1
                logs.append("OK: " + file)
            except Exception as e:
                total_errors += 1
                logs.append("ERR: " + file + " - " + str(e))
print(json.dumps({
    "success": True,
    "totalCopied": total_copied,
    "totalErrors": total_errors,
    "log": logs
}))
`;

    try {
        const exec = await container.exec({
            Cmd: ['python3', '-c', pythonScript, foldersList],
            AttachStdout: true,
            AttachStderr: true
        });
        const output = await collectExecOutput(exec);
        const result = JSON.parse(output.trim());
        result.fastdlUrl = fastdlUrl(port);
        result.message = `Sync complete. ${result.totalCopied} files copied, ${result.totalErrors} errors.`;
        return result;
    } catch (e) {
        console.error('Error executing FastDL sync python script in container:', e);
        return {
            success: false,
            totalCopied: 0,
            totalErrors: 1,
            message: `Sync failed: ${e.message}`,
            fastdlUrl: fastdlUrl(port),
            log: [`ERR: FastDL sync failed - ${e.message}`]
        };
    }
}

function normalizeFastdlAssetPaths(relPaths) {
    const accepted = [];
    const seen = new Set();
    for (const input of Array.isArray(relPaths) ? relPaths : []) {
        let rel;
        try {
            rel = containerFs.safeRelativePath(String(input), { allowEmpty: false });
        } catch (_) {
            continue;
        }
        const ext = path.posix.extname(rel).toLowerCase();
        const topLevel = rel.toLowerCase().split('/')[0];
        const inAssetFolder = ['maps', 'models', 'sound', 'sprites', 'gfx'].includes(topLevel);
        const rootAsset = !rel.includes('/') && ROOT_ASSET_EXTS.has(ext);
        if (ALLOWED_EXTS.has(ext) && (inAssetFolder || rootAsset) && !seen.has(rel)) {
            seen.add(rel);
            accepted.push(rel);
        }
    }
    return accepted;
}

/** Copy only newly uploaded/overwritten assets instead of scanning every folder. */
async function syncFastdlFilesFromContainer(container, port, relPaths) {
    ensureFastdlTree(port);
    const files = normalizeFastdlAssetPaths(relPaths);
    if (!files.length) {
        return { success: true, totalCopied: 0, totalErrors: 0, log: [], fastdlUrl: fastdlUrl(port), message: 'No FastDL assets to sync.' };
    }

    const pythonScript = `
import filecmp, json, os, shutil, sys
src_root = '/hlds/cstrike'
dst_root = '/fastdl-data'
files = json.loads(sys.argv[1])
copied = 0
errors = 0
logs = []
for rel in files:
    src = os.path.join(src_root, rel)
    dst = os.path.join(dst_root, rel)
    try:
        if not os.path.isfile(src):
            raise FileNotFoundError(src)
        if os.path.exists(dst) and filecmp.cmp(dst, src, shallow=False):
            logs.append('SKIP: ' + rel + ' (unchanged)')
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        temp = dst + '.cspanel-' + str(os.getpid()) + '.tmp'
        shutil.copy2(src, temp)
        os.replace(temp, dst)
        copied += 1
        logs.append('OK: ' + rel)
    except Exception as error:
        errors += 1
        logs.append('ERR: ' + rel + ' - ' + str(error))
print(json.dumps({'success': errors == 0, 'totalCopied': copied, 'totalErrors': errors, 'log': logs}))
`;

    const execResult = await containerFs.runExec(container, {
        Cmd: ['python3', '-c', pythonScript, JSON.stringify(files)]
    }, { timeoutMs: 120000 });
    const result = JSON.parse(execResult.output.trim());
    result.fastdlUrl = fastdlUrl(port);
    result.message = `FastDL sync complete. ${result.totalCopied} file(s) copied, ${result.totalErrors} error(s).`;
    return result;
}

async function syncFastdlByPort(docker, port, categories = null) {
    const info = await findRunningContainerByPort(docker, port);
    if (!info) {
        const err = new Error(`No running CS server found on port ${port}`);
        err.statusCode = 404;
        throw err;
    }
    const container = docker.getContainer(info.Id);
    return syncFastdlFromContainer(container, port, categories);
}

function listFastdlFiles(port) {
    const dir = fastdlDir(port);
    ensureFastdlTree(port);

    function walk(dirPath, base = '') {
        const items = [];
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        
        // Sort entries alphabetically
        entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

        const dirEntries = [];
        const fileEntries = [];

        entries.forEach(entry => {
            const relPath = base ? `${base}/${entry.name}` : entry.name;
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                dirEntries.push({
                    name: entry.name,
                    path: relPath,
                    isDir: true,
                    size: 0,
                    children: walk(fullPath, relPath)
                });
            } else {
                const stat = fs.statSync(fullPath);
                fileEntries.push({
                    name: entry.name,
                    path: relPath,
                    isDir: false,
                    size: stat.size,
                    mtime: stat.mtime
                });
            }
        });

        // Combine directories first, then files
        return [...dirEntries, ...fileEntries];
    }

    return walk(dir);
}

module.exports = {
    FASTDL_PATH,
    FASTDL_HOST,
    FASTDL_PORT,
    fastdlDir,
    fastdlUrl,
    svDownloadUrl,
    ensureDir,
    resolveInside,
    ensureFastdlTree,
    ensureCleanFastdlTree,
    removeFastdlTree,
    normalizeCategories,
    normalizeFastdlAssetPaths,
    syncFastdlFromContainer,
    syncFastdlFilesFromContainer,
    syncFastdlByPort,
    listFastdlFiles
};

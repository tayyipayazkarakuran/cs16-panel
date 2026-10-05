const fs = require('fs');
const path = require('path');
const containerFs = require('./containerFsHelper');

const cfg = require('./config');

const FASTDL_PATH = cfg.fastdl.path;
const FASTDL_HOST = cfg.fastdl.host;
const FASTDL_PORT = cfg.fastdl.port;

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
// Only files a GoldSrc client downloads. Config files (.cfg/.ini) must never be
// mirrored: the FastDL host is public and server.cfg holds rcon_password.
const ALLOWED_EXTS = new Set(['.bsp', '.wad', '.mdl', '.spr', '.wav', '.mp3', '.tga', '.res', '.txt', '.bmp']);
const ROOT_ASSET_EXTS = new Set(['.wad']);
const PY_ALLOWED_EXTS = "{'.bsp', '.res', '.wav', '.mp3', '.mdl', '.spr', '.txt', '.tga', '.wad', '.bmp'}";
const PY_SENSITIVE_EXTS = "('.cfg', '.ini', '.sma', '.amxx', '.log', '.so', '.dll', '.sq3', '.vault', '.json', '.php')";

function fastdlDir(port) {
    return path.join(FASTDL_PATH, String(port));
}

function fastdlUrl(port) {
    return cfg.fastdlUrl(port).replace(/\/$/, '');
}

function svDownloadUrl(port) {
    return cfg.fastdlUrl(port);
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

async function findRunningContainerByPort(docker, port) {
    const containers = await docker.listContainers({ all: false });
    return containers.find(c => c.Ports && c.Ports.some(p => p.PublicPort == port && p.Type === 'udp')) || null;
}

async function syncFastdlFromContainer(container, port, categories = null) {
    ensureFastdlTree(port);
    const foldersList = normalizeCategories(categories).map(c => c.source).join(',');
    
    const pythonScript = `
import sys, os, shutil, json, filecmp
allowed_exts = ${PY_ALLOWED_EXTS}
sensitive_exts = ${PY_SENSITIVE_EXTS}
src_root = '/hlds/cstrike'
dst_root = '/fastdl-data'
folders = sys.argv[1].split(',') if len(sys.argv) > 1 and sys.argv[1] else ['maps', 'models', 'sound', 'sprites']
total_copied = 0
total_errors = 0
logs = []
# Purge anything that should never be public (older panel versions mirrored
# server.cfg and other configs into FastDL).
for root, dirs, files in os.walk(dst_root):
    for name in files:
        if name.lower().endswith(sensitive_exts):
            try:
                os.unlink(os.path.join(root, name))
                logs.append("PURGE: " + os.path.relpath(os.path.join(root, name), dst_root))
            except Exception:
                pass
def copy_one(src_file, rel_path):
    global total_copied, total_errors
    if os.path.islink(src_file):
        return
    dst_file = os.path.join(dst_root, rel_path)
    if os.path.exists(dst_file) and filecmp.cmp(dst_file, src_file, shallow=False):
        return
    try:
        os.makedirs(os.path.dirname(dst_file), exist_ok=True)
        tmp = dst_file + '.cspanel-tmp'
        shutil.copyfile(src_file, tmp)
        os.replace(tmp, dst_file)
        total_copied += 1
        logs.append("OK: " + rel_path)
    except Exception as e:
        total_errors += 1
        logs.append("ERR: " + rel_path + " - " + str(e))
for folder in folders:
    src_dir = os.path.join(src_root, folder)
    if not os.path.isdir(src_dir):
        continue
    for root, dirs, files in os.walk(src_dir):
        for file in files:
            if os.path.splitext(file)[1].lower() not in allowed_exts:
                continue
            src_file = os.path.join(root, file)
            copy_one(src_file, os.path.relpath(src_file, src_root))
if 'maps' in folders:
    for file in os.listdir(src_root):
        full_src = os.path.join(src_root, file)
        if os.path.isfile(full_src) and os.path.splitext(file)[1].lower() == '.wad':
            copy_one(full_src, file)
print(json.dumps({
    "success": True,
    "totalCopied": total_copied,
    "totalErrors": total_errors,
    "log": logs
}))
`;

    try {
        const exec = await containerFs.runExec(container, {
            Cmd: ['python3', '-c', pythonScript, foldersList]
        }, { timeoutMs: 600000 });
        const result = JSON.parse(exec.output.trim().split('\n').pop());
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
        if os.path.islink(src) or not os.path.isfile(src):
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

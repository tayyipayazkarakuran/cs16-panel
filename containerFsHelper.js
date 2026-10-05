const path = require('path');
const crypto = require('crypto');
const tar = require('tar-stream');

const CSTRIKE_ROOT = '/hlds/cstrike';
const EXEC_POLL_INTERVAL_MS = 25;
const DEFAULT_EXEC_TIMEOUT_MS = 30000;
const WRITE_TIMEOUT_MS = 120000;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendExecInput(stream, input) {
    // Dockerode's hijacked exec stdin can close early when it receives several
    // writes. Folder requests are size-bounded by the route, so send one frame.
    const payload = Array.isArray(input)
        ? Buffer.concat(input)
        : (Buffer.isBuffer(input) ? input : Buffer.from(String(input)));
    stream.end(payload);
}

/**
 * Normalize a user-controlled path while keeping it below /hlds/cstrike.
 */
function safeRelativePath(relPath, { allowEmpty = true } = {}) {
    if (typeof relPath !== 'string') {
        const error = new Error('Invalid file path');
        error.statusCode = 400;
        throw error;
    }

    const value = relPath.replace(/\\/g, '/').trim();
    if (value.includes('\0')) {
        const error = new Error('Invalid file path');
        error.statusCode = 400;
        throw error;
    }
    if (value.startsWith('/') || value.split('/').includes('..')) {
        const error = new Error('Access denied: path must stay inside cstrike');
        error.statusCode = 400;
        throw error;
    }

    const normalized = path.posix.normalize(value);
    const result = normalized === '.' ? '' : normalized;
    if (!allowEmpty && !result) {
        const error = new Error('Missing file path');
        error.statusCode = 400;
        throw error;
    }
    return result;
}

function cstrikePath(relPath, options) {
    const safePath = safeRelativePath(relPath, options);
    return safePath ? `${CSTRIKE_ROOT}/${safePath}` : CSTRIKE_ROOT;
}

function decodeDockerOutput(buffer) {
    if (!buffer || buffer.length === 0) return '';

    const parts = [];
    let offset = 0;
    while (offset + 8 <= buffer.length && (buffer[offset] === 1 || buffer[offset] === 2)) {
        const size = buffer.readUInt32BE(offset + 4);
        if (offset + 8 + size > buffer.length) break;
        parts.push(buffer.subarray(offset + 8, offset + 8 + size));
        offset += 8 + size;
    }

    // TTY/raw streams do not contain Docker's 8-byte multiplex headers.
    return (parts.length && offset === buffer.length ? Buffer.concat(parts) : buffer).toString('utf8');
}

async function waitForExec(exec, timeoutMs) {
    const startedAt = Date.now();
    while (true) {
        const info = await exec.inspect();
        if (info.Running === false || info.ExitCode !== null && info.ExitCode !== undefined) {
            return info;
        }
        if (Date.now() - startedAt >= timeoutMs) {
            throw new Error(`Container command timed out after ${timeoutMs} ms`);
        }
        await delay(EXEC_POLL_INTERVAL_MS);
    }
}

/**
 * Run a Docker exec command and wait for the process itself, not merely for the
 * local stdin stream to finish. Docker duplex streams emit "finish" as soon as
 * input is sent, which previously made uploads report success before disk I/O.
 */
async function runExec(container, execOptions, { input, timeoutMs = DEFAULT_EXEC_TIMEOUT_MS, allowNonZero = false } = {}) {
    const hasInput = input !== undefined;
    const exec = await container.exec({
        ...execOptions,
        AttachStdin: hasInput,
        AttachStdout: true,
        AttachStderr: true
    });
    const stream = await exec.start(hasInput ? { hijack: true, stdin: true } : {});
    const chunks = [];
    let streamError = null;
    let streamSettled = false;

    const streamDone = new Promise(resolve => {
        const done = () => {
            if (streamSettled) return;
            streamSettled = true;
            resolve();
        };
        stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
        stream.on('end', done);
        stream.on('close', done);
        stream.on('error', error => {
            streamError = error;
            done();
        });
    });

    if (hasInput) {
        await sendExecInput(stream, input);
    } else {
        stream.resume();
    }

    let info;
    try {
        info = await waitForExec(exec, timeoutMs);
        // Give Docker a short grace period to flush the final output frame.
        await Promise.race([streamDone, delay(250)]);
    } catch (error) {
        try { stream.destroy(); } catch (_) { /* ignore */ }
        throw error;
    }

    const output = decodeDockerOutput(Buffer.concat(chunks)).trimEnd();
    if (streamError) throw streamError;
    if (info.ExitCode !== 0 && !allowNonZero) {
        const detail = output ? `: ${output}` : '';
        throw new Error(`Container command failed with exit code ${info.ExitCode}${detail}`);
    }
    return { output, info };
}

/** Read a UTF-8 text file from the running container's cstrike directory. */
async function readFile(container, relPath) {
    const targetFile = cstrikePath(relPath, { allowEmpty: false });
    const pythonScript = `
import sys
with open(sys.argv[1], "r", encoding="utf-8", errors="ignore") as f:
    sys.stdout.write(f.read())
`;
    const result = await runExec(container, {
        Cmd: ['python3', '-c', pythonScript, targetFile]
    });
    return result.output;
}

/**
 * Atomically write binary or text data. The temporary file is fully flushed
 * before os.replace(), so readers see either the old complete file or the new
 * complete file and an overwrite never exposes a zero-byte intermediate file.
 */
async function writeFile(container, relPath, content) {
    const targetFile = cstrikePath(relPath, { allowEmpty: false });
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    const pythonScript = `
import os, stat, sys, tempfile
target_file = sys.argv[1]
target_dir = os.path.dirname(target_file)
os.makedirs(target_dir, exist_ok=True)
old_mode = stat.S_IMODE(os.stat(target_file).st_mode) if os.path.exists(target_file) else 0o644
fd, temp_file = tempfile.mkstemp(prefix='.cspanel-upload-', dir=target_dir)
try:
    with os.fdopen(fd, 'wb') as f:
        while True:
            chunk = sys.stdin.buffer.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(temp_file, old_mode)
    os.replace(temp_file, target_file)
except Exception:
    try:
        os.unlink(temp_file)
    except FileNotFoundError:
        pass
    raise
`;

    await runExec(container, {
        Cmd: ['python3', '-c', pythonScript, targetFile]
    }, { input: data, timeoutMs: WRITE_TIMEOUT_MS });
}

/**
 * Stage many files with one Docker archive upload, then atomically replace
 * each target. Staging lives on the cstrike filesystem so named volumes and
 * bind mounts never trigger cross-device rename failures.
 */
async function writeFiles(container, entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return { written: [], errors: [] };
    }

    const seen = new Set();
    const normalized = entries.map(entry => {
        const relPath = safeRelativePath(String(entry.relPath || ''), { allowEmpty: false });
        if (seen.has(relPath)) {
            const error = new Error(`Duplicate upload path: ${relPath}`);
            error.statusCode = 400;
            throw error;
        }
        seen.add(relPath);
        return {
            relPath,
            content: Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content ?? ''))
        };
    });

    const batchId = crypto.randomBytes(12).toString('hex');
    const stageRoot = `/hlds/cstrike/.cspanel-upload-${batchId}`;
    const pathsJson = JSON.stringify(normalized.map(entry => entry.relPath));
    const createStage = 'import os, sys; os.makedirs(sys.argv[1], mode=0o700, exist_ok=False)';
    const cleanupStage = 'import shutil, sys; shutil.rmtree(sys.argv[1], ignore_errors=True)';

    await runExec(container, { Cmd: ['python3', '-c', createStage, stageRoot] });
    try {
        const pack = tar.pack();
        const archiveUpload = container.putArchive(pack, { path: stageRoot });
        for (const entry of normalized) {
            await new Promise((resolve, reject) => {
                pack.entry({ name: entry.relPath, mode: 0o600, size: entry.content.length }, entry.content, error => {
                    if (error) reject(error); else resolve();
                });
            });
        }
        pack.finalize();
        await archiveUpload;

        const commitScript = `
import json, os, stat, sys
stage_root, target_root = sys.argv[1], '/hlds/cstrike'
paths = json.loads(sys.argv[2])
written, errors = [], []
for rel_path in paths:
    source = os.path.normpath(os.path.join(stage_root, rel_path))
    target = os.path.normpath(os.path.join(target_root, rel_path))
    try:
        if os.path.commonpath([stage_root, source]) != stage_root or os.path.commonpath([target_root, target]) != target_root:
            raise ValueError('Path escapes upload roots')
        if not os.path.isfile(source):
            raise FileNotFoundError(source)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        mode = stat.S_IMODE(os.stat(target).st_mode) if os.path.exists(target) else 0o644
        os.chmod(source, mode)
        os.replace(source, target)
        written.append(rel_path)
    except Exception as error:
        errors.append({'file': rel_path, 'error': str(error)})
print(json.dumps({'written': written, 'errors': errors}))
`;
        const result = await runExec(container, {
            Cmd: ['python3', '-c', commitScript, stageRoot, pathsJson]
        }, { timeoutMs: 300000 });
        try {
            return JSON.parse(result.output.trim() || '{"written":[],"errors":[]}');
        } catch (_) {
            throw new Error('Container returned an invalid batch upload result');
        }
    } finally {
        try { await runExec(container, { Cmd: ['python3', '-c', cleanupStage, stageRoot] }); }
        catch (error) { console.warn(`Could not remove upload staging directory ${stageRoot}:`, error.message); }
    }
}

async function fileExists(container, relPath) {
    const targetFile = cstrikePath(relPath, { allowEmpty: false });
    try {
        await runExec(container, {
            Cmd: ['python3', '-c', 'import os, sys; sys.exit(0 if os.path.exists(sys.argv[1]) else 1)', targetFile]
        });
        return true;
    } catch (error) {
        if (/exit code 1(?:\D|$)/.test(error.message)) return false;
        throw error;
    }
}

async function listFiles(container, relPath) {
    const targetDir = cstrikePath(relPath || '');
    const pythonScript = `
import os, json, sys
path = sys.argv[1]
if not os.path.isdir(path):
    print(json.dumps([]))
    sys.exit(0)
items = []
for name in os.listdir(path):
    full = os.path.join(path, name)
    try:
        st = os.stat(full)
        items.append({
            "name": name,
            "isDir": os.path.isdir(full),
            "size": st.st_size if os.path.isfile(full) else 0,
            "mtime": int(st.st_mtime * 1000)
        })
    except OSError:
        pass
print(json.dumps(items))
`;
    const result = await runExec(container, {
        Cmd: ['python3', '-c', pythonScript, targetDir]
    });
    try {
        return JSON.parse(result.output || '[]');
    } catch (_) {
        throw new Error('Container returned an invalid directory listing');
    }
}

async function removePath(container, relPath, { recursive = false } = {}) {
    const targetPath = cstrikePath(relPath, { allowEmpty: false });
    const pythonScript = recursive ? `
import os, shutil, sys
target = sys.argv[1]
if os.path.isdir(target) and not os.path.islink(target):
    shutil.rmtree(target)
elif os.path.lexists(target):
    os.unlink(target)
` : `
import os, sys
target = sys.argv[1]
if os.path.lexists(target):
    os.unlink(target)
`;
    await runExec(container, { Cmd: ['python3', '-c', pythonScript, targetPath] });
}

async function makeDir(container, relPath) {
    const targetPath = cstrikePath(relPath, { allowEmpty: false });
    await runExec(container, {
        Cmd: ['python3', '-c', 'import os, sys; os.makedirs(sys.argv[1], exist_ok=False)', targetPath]
    });
}

/** Rename/move inside cstrike. Refuses to overwrite an existing target. */
async function movePath(container, fromRel, toRel) {
    const from = cstrikePath(fromRel, { allowEmpty: false });
    const to = cstrikePath(toRel, { allowEmpty: false });
    const script = `
import os, sys
src, dst = sys.argv[1], sys.argv[2]
if not os.path.lexists(src):
    sys.exit('Source does not exist')
if os.path.lexists(dst):
    sys.exit('Target already exists')
os.makedirs(os.path.dirname(dst), exist_ok=True)
os.rename(src, dst)
`;
    await runExec(container, { Cmd: ['python3', '-c', script, from, to] });
}

/**
 * Extract a .zip that already lives inside cstrike into a target folder.
 * Entries escaping the target, symlinks and oversized archives are rejected.
 */
async function extractZip(container, zipRel, destRel) {
    const zipPath = cstrikePath(zipRel, { allowEmpty: false });
    const destPath = cstrikePath(destRel || '');
    const script = `
import json, os, stat, sys, zipfile
zip_path, dest = sys.argv[1], os.path.realpath(sys.argv[2])
limit = 1024 * 1024 * 1024
written = 0
count = 0
with zipfile.ZipFile(zip_path) as archive:
    infos = archive.infolist()
    if sum(i.file_size for i in infos) > limit:
        sys.exit('Archive expands beyond 1 GB')
    for info in infos:
        mode = (info.external_attr >> 16) & 0xFFFF
        if stat.S_ISLNK(mode):
            continue
        target = os.path.realpath(os.path.join(dest, info.filename))
        if os.path.commonpath([dest, target]) != dest:
            sys.exit('Unsafe path in archive: ' + info.filename)
        if info.is_dir():
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with archive.open(info) as src, open(target, 'wb') as out:
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > limit:
                    sys.exit('Archive expands beyond 1 GB')
                out.write(chunk)
        count += 1
print(json.dumps({'files': count, 'bytes': written}))
`;
    const result = await runExec(container, { Cmd: ['python3', '-c', script, zipPath, destPath] }, { timeoutMs: 300000 });
    return JSON.parse(result.output.trim().split('\n').pop() || '{}');
}

/**
 * Stream one regular file out of the container via the archive API (no
 * base64 round trip, no full in-memory copy). Resolves with { name, size, stream }.
 */
function openFileStream(container, relPath) {
    const targetFile = cstrikePath(relPath, { allowEmpty: false });
    return new Promise((resolve, reject) => {
        container.getArchive({ path: targetFile }, (error, archive) => {
            if (error) return reject(error);
            const extract = tar.extract();
            let found = false;
            extract.on('entry', (header, stream, next) => {
                if (found || header.type !== 'file') {
                    stream.on('end', next);
                    stream.resume();
                    return;
                }
                found = true;
                resolve({ name: path.posix.basename(header.name), size: header.size, stream, done: next });
            });
            extract.on('finish', () => { if (!found) reject(Object.assign(new Error('Not a regular file'), { statusCode: 400 })); });
            extract.on('error', reject);
            archive.on('error', reject);
            archive.pipe(extract);
        });
    });
}

module.exports = {
    makeDir,
    movePath,
    extractZip,
    openFileStream,
    decodeDockerOutput,
    cstrikePath,
    fileExists,
    listFiles,
    readFile,
    removePath,
    runExec,
    safeRelativePath,
    writeFile,
    writeFiles
};

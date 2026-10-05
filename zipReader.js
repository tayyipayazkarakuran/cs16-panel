// Minimal, dependency-free ZIP reader used to unpack website archives.
// Supports stored (0) and deflate (8) entries, rejects path traversal,
// symlinks, encrypted entries and archives that would expand beyond limits.
const zlib = require('zlib');
const path = require('path');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function zipError(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

function findEndOfCentralDirectory(buffer) {
    const min = Math.max(0, buffer.length - 0xffff - 22);
    for (let i = buffer.length - 22; i >= min; i--) {
        if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
    }
    throw zipError('Geçerli bir ZIP arşivi değil.');
}

function safeEntryPath(name) {
    const normalized = path.posix.normalize(String(name).replace(/\\/g, '/'));
    if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized) || normalized.includes('\0')) {
        throw zipError(`Arşivde güvenli olmayan dosya yolu: ${name}`);
    }
    return normalized.replace(/\/+$/, '');
}

/**
 * Returns [{ path, isDir, data }] for every entry.
 * @param {Buffer} buffer
 * @param {{maxEntries?: number, maxTotalBytes?: number}} limits
 */
function readZip(buffer, { maxEntries = 5000, maxTotalBytes = 512 * 1024 * 1024 } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw zipError('Geçerli bir ZIP arşivi değil.');
    const eocd = findEndOfCentralDirectory(buffer);
    const entryCount = buffer.readUInt16LE(eocd + 10);
    const centralOffset = buffer.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || centralOffset === 0xffffffff) throw zipError('ZIP64 arşivleri desteklenmiyor.');
    if (entryCount > maxEntries) throw zipError(`Arşivde çok fazla dosya var (en fazla ${maxEntries}).`);

    const entries = [];
    let offset = centralOffset;
    let totalBytes = 0;
    for (let i = 0; i < entryCount; i++) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw zipError('ZIP merkez dizini bozuk.');
        const flags = buffer.readUInt16LE(offset + 8);
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const externalAttrs = buffer.readUInt32LE(offset + 38);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const rawName = buffer.toString((flags & 0x800) ? 'utf8' : 'latin1', offset + 46, offset + 46 + nameLength);
        offset += 46 + nameLength + extraLength + commentLength;

        if (flags & 0x1) throw zipError('Şifreli ZIP arşivleri desteklenmiyor.');
        const unixMode = (externalAttrs >>> 16) & 0xffff;
        if ((unixMode & 0xf000) === 0xa000) continue; // skip symlinks entirely
        if (rawName.startsWith('__MACOSX/')) continue;

        const isDir = rawName.endsWith('/');
        const entryPath = safeEntryPath(rawName);
        if (isDir) { entries.push({ path: entryPath, isDir: true }); continue; }

        totalBytes += uncompressedSize;
        if (totalBytes > maxTotalBytes) throw zipError('Arşiv açıldığında izin verilen boyutu aşıyor.');

        if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw zipError('ZIP yerel başlığı bozuk.');
        const localName = buffer.readUInt16LE(localOffset + 26);
        const localExtra = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localName + localExtra;
        const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
        if (compressed.length !== compressedSize) throw zipError('ZIP verisi eksik.');

        let data;
        if (method === 0) data = Buffer.from(compressed);
        else if (method === 8) data = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(uncompressedSize, 1) });
        else throw zipError(`Desteklenmeyen sıkıştırma yöntemi (${method}) : ${rawName}`);
        if (data.length !== uncompressedSize) throw zipError(`ZIP girdisi boyutu uyuşmuyor: ${rawName}`);
        entries.push({ path: entryPath, isDir: false, data });
    }
    return entries;
}

/**
 * If every file sits inside one top-level folder (common for "site.zip"),
 * return that folder name so callers can strip it.
 */
function commonRootFolder(entries) {
    const files = entries.filter(e => !e.isDir);
    if (!files.length) return null;
    const first = files[0].path.split('/')[0];
    if (!files.every(e => e.path.includes('/') && e.path.split('/')[0] === first)) return null;
    return first;
}

module.exports = { readZip, commonRootFolder };

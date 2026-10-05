const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');

const security = require('../security');
const { readZip, commonRootFolder } = require('../zipReader');
const { parsePeriodDiscounts } = require('../billingService');
const { parsePoolPorts } = require('../poolService');
const fastdl = require('../fastdlService');
const serversRoute = require('../routes/servers');
const gameContainer = require('../gameContainer');
const cfg = require('../config');

/** Build a minimal ZIP (deflate) in memory. */
function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name);
        const raw = Buffer.from(data);
        const compressed = zlib.deflateRawSync(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x800, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(0x800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, compressed);
        centrals.push(central, nameBuf);
        offset += local.length + nameBuf.length + compressed.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuf, eocd]);
}

test('session cookies are host-only so customer PHP subdomains never receive them', () => {
    let captured = null;
    const res = { cookie: (name, value, options) => { captured = { name, value, options }; } };
    security.setSessionCookie({ secure: true }, res, 'token');
    assert.equal(captured.name, security.COOKIE_NAME);
    assert.equal(captured.options.domain, undefined);
    assert.equal(captured.options.httpOnly, true);
    assert.equal(captured.options.sameSite, 'lax');
});

test('origin check accepts same-host requests and rejects sibling subdomains', () => {
    assert.equal(security.isTrustedOrigin('http://localhost:3000', 'localhost:3000'), true);
    assert.equal(security.isTrustedOrigin('http://203.0.113.5:3000', '203.0.113.5:3000'), true);
    assert.equal(security.isTrustedOrigin('http://php-27015.example.com', 'panel.example.com'), false);
    assert.equal(security.isTrustedOrigin('https://evil.test', 'panel.example.com'), false);
    assert.equal(security.isTrustedOrigin('', 'panel.example.com'), false);
});

test('rate limiter answers 429 after the configured number of hits', () => {
    const limiter = security.rateLimit({ name: `t-${Date.now()}`, windowMs: 60000, max: 2, keys: () => ['k'] });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
        const res = { set() {}, status(code) { statuses.push(code); return { json() {} }; } };
        limiter({}, res, () => statuses.push('next'));
    }
    assert.deepEqual(statuses, ['next', 'next', 429]);
});

test('zip reader extracts files and strips a single wrapper folder', () => {
    const entries = readZip(makeZip([{ name: 'site/index.php', data: '<?php echo 1;' }, { name: 'site/css/a.css', data: 'body{}' }]));
    assert.deepEqual(entries.map(e => e.path), ['site/index.php', 'site/css/a.css']);
    assert.equal(entries[0].data.toString(), '<?php echo 1;');
    assert.equal(commonRootFolder(entries), 'site');
});

test('zip reader rejects path traversal entries', () => {
    assert.throws(() => readZip(makeZip([{ name: '../../escape.php', data: 'x' }])), /güvenli olmayan/);
    assert.throws(() => readZip(makeZip([{ name: '/etc/passwd', data: 'x' }])), /güvenli olmayan/);
    assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /ZIP/);
});

test('FastDL never mirrors configuration files that may contain rcon_password', () => {
    assert.deepEqual(
        fastdl.normalizeFastdlAssetPaths(['server.cfg', 'maps/de_x.bsp', 'addons/amxmodx/configs/sql.cfg', 'listip.cfg', 'cs_custom.wad', 'motd.txt']),
        ['maps/de_x.bsp', 'cs_custom.wad']
    );
    const source = fs.readFileSync(path.join(__dirname, '..', 'fastdlService.js'), 'utf8');
    assert.doesNotMatch(source.split('PY_ALLOWED_EXTS =')[1].split('\n')[0], /\.cfg/);
    const nginx = fs.readFileSync(path.join(__dirname, '..', 'nginx-fastdl', 'nginx.conf'), 'utf8');
    assert.match(nginx, /autoindex off/);
    assert.match(nginx, /cfg\|ini/);
});

test('server.cfg values cannot inject extra console commands', () => {
    const { validateCvarValue, updateOrAppendCfg } = serversRoute._test;
    assert.throws(() => validateCvarValue('mp_timelimit', 'mp_timelimit', 'number', '20; quit'), /içeremez/);
    assert.throws(() => validateCvarValue('name', 'hostname', 'text', 'evil"\nrcon_password x'), /içeremez/);
    assert.throws(() => validateCvarValue('rconPassword', 'rcon_password', 'secret', 'short'), /RCON/);
    assert.equal(validateCvarValue('sv_alltalk', 'sv_alltalk', 'bool', '1'), '1');
    const updated = updateOrAppendCfg('hostname "Blog Server"\nlog on\n', 'log', 'off', 'text');
    assert.match(updated, /hostname "Blog Server"/);
});

test('game server names are sanitized before reaching env/server.cfg', () => {
    assert.equal(gameContainer.sanitizeServerName('Pro "Server"; quit\n', 'x'), 'Pro Server quit');
    assert.equal(gameContainer.sanitizeMapName('de_dust2; rm -rf'), 'de_dust2');
    assert.equal(gameContainer.sanitizeMapName('de_dust2'), 'de_dust2');
});

test('billing and pool parsers accept only sane values', () => {
    assert.deepEqual(parsePeriodDiscounts('3:5,6:10,12:15,7:50,1:200'), { 1: 0, 3: 5, 6: 10, 12: 15 });
    assert.deepEqual(parsePoolPorts('27015-27017,27030,abc,80'), [27015, 27016, 27017, 27030]);
    assert.equal(parsePoolPorts('27000-29999').length, 200);
});

test('public URLs are built from one configuration source', () => {
    assert.match(cfg.fastdlUrl(27017), /\/27017\/$/);
    assert.match(cfg.phpSiteUrl(27017), /\/27017\/$/);
    assert.equal(cfg.phpSiteUrl(27017, 'www.example.com'), 'http://www.example.com/');
});

test('PHP hosting isolates sites and strips the panel cookie', () => {
    const ini = fs.readFileSync(path.join(__dirname, '..', 'php', 'panel-php.ini'), 'utf8');
    const prepend = fs.readFileSync(path.join(__dirname, '..', 'php', 'panel-prepend.php'), 'utf8');
    const vhost = fs.readFileSync(path.join(__dirname, '..', 'php', 'apache-vhost.conf'), 'utf8');
    assert.match(ini, /^user_ini\.filename =\s*$/m);
    assert.match(ini, /disable_functions = .*shell_exec/);
    assert.match(prepend, /ini_set\('open_basedir'/);
    assert.match(vhost, /RequestHeader edit\* Cookie .*cs_panel_session/);
    assert.doesNotMatch(vhost, /AllowOverride All/);
});

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scheduler = require('../schedulerService');
const { _test: servers } = require('../routes/servers');
const serverOps = require('../serverOps');

const TZ = 'Europe/Istanbul'; // UTC+3, no DST

test('daily schedules fire at the next local wall-clock time', () => {
    const now = new Date('2026-10-17T01:30:00Z'); // 04:30 in Istanbul
    const next = scheduler.computeNextRun({ schedule_type: 'daily', time_of_day: '05:00' }, now, TZ);
    assert.equal(next.toISOString(), '2026-10-17T02:00:00.000Z');
    const later = scheduler.computeNextRun({ schedule_type: 'daily', time_of_day: '04:00' }, now, TZ);
    assert.equal(later.toISOString(), '2026-10-18T01:00:00.000Z');
});

test('weekly schedules pick the next selected weekday and handle DST zones', () => {
    // 2026-10-17 is a Saturday.
    const now = new Date('2026-10-17T12:00:00Z');
    const next = scheduler.computeNextRun({ schedule_type: 'weekly', time_of_day: '20:00', weekdays: '1,3' }, now, TZ);
    assert.equal(next.toISOString(), '2026-10-19T17:00:00.000Z'); // Monday 20:00 local
    const berlin = scheduler.computeNextRun({ schedule_type: 'daily', time_of_day: '03:00' }, new Date('2026-10-24T12:00:00Z'), 'Europe/Berlin');
    assert.equal(berlin.toISOString(), '2026-10-25T02:00:00.000Z'); // after the switch to CET (UTC+1)
    assert.equal(scheduler.computeNextRun({ schedule_type: 'weekly', time_of_day: '20:00', weekdays: '' }, now, TZ), null);
});

test('interval schedules add the configured minutes', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    assert.equal(scheduler.computeNextRun({ schedule_type: 'interval', interval_minutes: 30 }, now).toISOString(), '2026-10-17T12:30:00.000Z');
});

test('task input is validated and normalised', () => {
    const task = scheduler.normalizeTask({ name: 'Gece restart', action: 'restart', schedule_type: 'weekly', time_of_day: '5:00', weekdays: [3, 1, 1] });
    assert.equal(task.time_of_day, '05:00');
    assert.equal(task.weekdays, '1,3');
    assert.equal(task.payload, null);
    assert.ok(task.next_run_at instanceof Date);
    assert.throws(() => scheduler.normalizeTask({ name: 'x', action: 'rcon', payload: 'quit', schedule_type: 'interval', interval_minutes: 10 }), /kullanılamaz/);
    assert.throws(() => scheduler.normalizeTask({ name: 'x', action: 'rcon', payload: 'say hi; quit', schedule_type: 'interval', interval_minutes: 10 }), /tek komut/);
    assert.throws(() => scheduler.normalizeTask({ name: 'x', action: 'map', payload: 'de_dust2;quit', schedule_type: 'daily', time_of_day: '10:00' }), /harita/);
    assert.throws(() => scheduler.normalizeTask({ name: 'x', action: 'restart', schedule_type: 'interval', interval_minutes: 1 }), /Aralık/);
    const say = scheduler.normalizeTask({ name: 'Reklam', action: 'say', payload: 'Discord: "abc"', schedule_type: 'interval', interval_minutes: 15, enabled: false });
    assert.equal(say.payload, 'Discord: abc');
    assert.equal(say.next_run_at, null);
});

test('partial task updates keep stored fields', () => {
    const existing = { name: 'Restart', action: 'restart', payload: null, schedule_type: 'daily', time_of_day: '06:00', weekdays: null, interval_minutes: null, enabled: 1 };
    const updated = scheduler.normalizeTask({ enabled: false }, existing);
    assert.equal(updated.time_of_day, '06:00');
    assert.equal(updated.enabled, 0);
});

test('chat log lines are parsed into structured messages', () => {
    const line = 'L 10/17/2026 - 21:04:11: "Ali <Pro>"<12><STEAM_0:1:123456><CT>" say_team "rush b" (dead)';
    const msg = servers.parseChatLine(line);
    assert.equal(msg.name, 'Ali <Pro>"');
    assert.equal(msg.steamId, 'STEAM_0:1:123456');
    assert.equal(msg.channel, 'team');
    assert.equal(msg.dead, true);
    assert.equal(msg.message, 'rush b');
    assert.equal(servers.parseChatLine('L 10/17/2026 - 21:04:11: Server cvar "mp_timelimit" = "20"'), null);
});

test('log file downloads only accept HLDS log names', () => {
    assert.equal(servers.assertLogFileName('L1017001.log'), 'L1017001.log');
    assert.throws(() => servers.assertLogFileName('../server.cfg'), /Geçersiz/);
    assert.throws(() => servers.assertLogFileName('L1017001.log/../../x'), /Geçersiz/);
});

test('startup parameters are validated and round-trip through the file format', () => {
    assert.throws(() => servers.normalizeStartup({ sysTicrate: 5000 }), /sys_ticrate/);
    assert.throws(() => servers.normalizeStartup({ pingboost: '2 -insecure' }), /pingboost/);
    const values = servers.normalizeStartup({ pingboost: 3, sysTicrate: 500, fpsMax: '500', insecure: true });
    assert.deepEqual(servers.parseStartupFile(servers.renderStartupFile(values)), values);
    assert.equal(servers.parseStartupFile('PINGBOOST=9\nSYS_TICRATE=1000; quit').pingboost, 2);
});

test('entrypoint only passes whitelisted, validated launch options to hlds_run', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'entrypoint.sh'), 'utf8');
    const block = script.slice(script.indexOf('PINGBOOST=2'), script.indexOf('cd /hlds\necho "Launching'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-startup-'));
    const file = path.join(dir, 'panel_startup.cfg');
    fs.writeFileSync(file, 'PINGBOOST=3\nSYS_TICRATE=500\nINSECURE=1\nFPS_MAX=99999\nNOMASTER=1;rm -rf /\nEVIL=1\n');
    const out = execFileSync('bash', ['-c', `PORT=27015 MAXPLAYERS=12 START_MAP=de_dust2\n${block.replace('/hlds/cstrike/panel_startup.cfg', file)}\nprintf '%s\\n' "$@"`]).toString().trim().split('\n');
    assert.deepEqual(out, ['-game', 'cstrike', '-console', '-pingboost', '3', '-insecure', '+port', '27015', '+maxplayers', '12', '+map', 'de_dust2', '+sys_ticrate', '500', '+fps_max', '1000']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('docker stats are converted to CPU %, memory without page cache, and traffic', () => {
    const stats = {
        cpu_stats: { cpu_usage: { total_usage: 2e9 }, system_cpu_usage: 20e9, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: 1e9 }, system_cpu_usage: 10e9 },
        memory_stats: { usage: 300, limit: 1000, stats: { inactive_file: 100 } },
        networks: { a: { rx_bytes: 5, tx_bytes: 7 }, b: { rx_bytes: 1, tx_bytes: 1 } }
    };
    assert.deepEqual(serverOps.cpuPercentFromStats(stats), { percent: 40, cores: 4 });
    assert.deepEqual(serverOps.memoryFromStats(stats, 0), { used: 200, limit: 1000, limited: false });
    assert.deepEqual(serverOps.networkFromStats(stats), { rx: 6, tx: 8 });
});

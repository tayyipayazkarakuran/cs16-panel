// Scheduled server tasks: timed restarts, RCON commands, in-game messages
// and map changes. Schedules are evaluated in the panel's time zone
// (PANEL_TIMEZONE, default Europe/Istanbul) so "every day at 05:00" means
// 05:00 local time for the customer, regardless of the host's TZ.
const panelDb = require('./panelDb');
const serverOps = require('./serverOps');

const TIME_ZONE = process.env.PANEL_TIMEZONE || 'Europe/Istanbul';
const ACTIONS = ['restart', 'rcon', 'say', 'map'];
const SCHEDULE_TYPES = ['daily', 'weekly', 'interval'];
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 7 * 24 * 60;
// Commands that would lock the customer out or kill the process outright.
const BLOCKED_RCON = /^\s*(quit|exit|restart|_restart|rcon_password|rcon_|logaddress|sv_rcon|developer|exec\s+.*\.\.)/i;

function httpError(status, message) {
    const e = new Error(message);
    e.statusCode = status;
    return e;
}

// ---------------------------------------------------------------------------
//  Time zone helpers (no external dependency)
// ---------------------------------------------------------------------------

const formatters = new Map();
function wallClock(date, timeZone) {
    if (!formatters.has(timeZone)) {
        formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
        }));
    }
    const parts = Object.fromEntries(formatters.get(timeZone).formatToParts(date).map(p => [p.type, p.value]));
    return { y: +parts.year, m: +parts.month - 1, d: +parts.day, hh: +parts.hour, mm: +parts.minute, ss: +parts.second };
}

/** UTC instant for a wall-clock time in `timeZone` (handles DST shifts). */
function zonedTimeToUtc(y, m, d, hh, mm, timeZone) {
    const target = Date.UTC(y, m, d, hh, mm);
    let guess = target;
    for (let i = 0; i < 3; i++) {
        const w = wallClock(new Date(guess), timeZone);
        const asUtc = Date.UTC(w.y, w.m, w.d, w.hh, w.mm);
        const diff = target - asUtc;
        if (diff === 0) break;
        guess += diff;
    }
    return new Date(guess);
}

function parseWeekdays(value) {
    if (Array.isArray(value)) return [...new Set(value.map(v => parseInt(v, 10)).filter(v => v >= 0 && v <= 6))].sort();
    if (!value) return [];
    return parseWeekdays(String(value).split(','));
}

/** Next run strictly after `now`, or null when the schedule can never fire. */
function computeNextRun(task, now = new Date(), timeZone = TIME_ZONE) {
    if (task.schedule_type === 'interval') {
        const minutes = parseInt(task.interval_minutes, 10);
        if (!minutes || minutes < 1) return null;
        return new Date(now.getTime() + minutes * 60000);
    }
    const match = /^(\d{2}):(\d{2})$/.exec(task.time_of_day || '');
    if (!match) return null;
    const hh = +match[1];
    const mm = +match[2];
    const days = task.schedule_type === 'weekly' ? parseWeekdays(task.weekdays) : [0, 1, 2, 3, 4, 5, 6];
    if (!days.length) return null;
    const today = wallClock(now, timeZone);
    for (let offset = 0; offset <= 8; offset++) {
        const dayUtc = new Date(Date.UTC(today.y, today.m, today.d + offset));
        if (!days.includes(dayUtc.getUTCDay())) continue;
        const candidate = zonedTimeToUtc(dayUtc.getUTCFullYear(), dayUtc.getUTCMonth(), dayUtc.getUTCDate(), hh, mm, timeZone);
        if (candidate.getTime() > now.getTime()) return candidate;
    }
    return null;
}

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

/**
 * Normalise user input into DB columns. With `existing`, missing fields are
 * taken from the stored task (partial update).
 */
function normalizeTask(input = {}, existing = null) {
    const pick = key => (input[key] !== undefined ? input[key] : (existing ? existing[key] : undefined));
    const out = {};

    const name = String(pick('name') || '').trim();
    if (!name || name.length > 80) throw httpError(400, 'Görev adı 1-80 karakter olmalı.');
    out.name = name;

    const action = String(pick('action') || '');
    if (!ACTIONS.includes(action)) throw httpError(400, 'Geçersiz görev eylemi.');
    out.action = action;

    const payload = String(pick('payload') || '').trim();
    if (action === 'restart') out.payload = null;
    else if (action === 'rcon') {
        if (!payload || payload.length > 200) throw httpError(400, 'RCON komutu 1-200 karakter olmalı.');
        if (/[\r\n;"]/.test(payload)) throw httpError(400, 'RCON komutu ; " veya satır sonu içeremez; her görev tek komut çalıştırır.');
        if (BLOCKED_RCON.test(payload)) throw httpError(400, 'Bu komut zamanlanmış görevlerde kullanılamaz.');
        out.payload = payload;
    } else if (action === 'say') {
        const text = payload.replace(/["\r\n;]/g, '').slice(0, 150);
        if (!text) throw httpError(400, 'Mesaj boş olamaz.');
        out.payload = text;
    } else if (action === 'map') {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(payload)) throw httpError(400, 'Geçersiz harita adı.');
        out.payload = payload;
    }

    const scheduleType = String(pick('schedule_type') || '');
    if (!SCHEDULE_TYPES.includes(scheduleType)) throw httpError(400, 'Geçersiz zamanlama türü.');
    out.schedule_type = scheduleType;
    out.time_of_day = null;
    out.weekdays = null;
    out.interval_minutes = null;
    if (scheduleType === 'interval') {
        const minutes = parseInt(pick('interval_minutes'), 10);
        if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL || minutes > MAX_INTERVAL) {
            throw httpError(400, `Aralık ${MIN_INTERVAL}-${MAX_INTERVAL} dakika arasında olmalı.`);
        }
        out.interval_minutes = minutes;
    } else {
        const time = String(pick('time_of_day') || '').trim();
        const m = /^(\d{1,2}):(\d{2})$/.exec(time);
        if (!m || +m[1] > 23 || +m[2] > 59) throw httpError(400, 'Saat SS:DD biçiminde olmalı.');
        out.time_of_day = `${m[1].padStart(2, '0')}:${m[2]}`;
        if (scheduleType === 'weekly') {
            const days = parseWeekdays(pick('weekdays'));
            if (!days.length) throw httpError(400, 'En az bir gün seçin.');
            out.weekdays = days.join(',');
        }
    }

    const enabled = pick('enabled');
    out.enabled = enabled === undefined ? 1 : (enabled === true || enabled === 1 || enabled === '1' || enabled === 'true' ? 1 : 0);
    out.next_run_at = out.enabled ? computeNextRun(out) : null;
    return out;
}

function serializeTask(task) {
    return {
        id: task.id,
        name: task.name,
        action: task.action,
        payload: task.payload,
        schedule_type: task.schedule_type,
        time_of_day: task.time_of_day,
        weekdays: task.weekdays ? task.weekdays.split(',').map(Number) : [],
        interval_minutes: task.interval_minutes,
        enabled: !!task.enabled,
        next_run_at: task.next_run_at,
        last_run_at: task.last_run_at,
        last_status: task.last_status,
        last_message: task.last_message
    };
}

// ---------------------------------------------------------------------------
//  Execution
// ---------------------------------------------------------------------------

async function executeTask(docker, task) {
    const record = await panelDb.getServerById(task.server_id);
    if (!record) throw httpError(404, 'Sunucu bulunamadı.');
    if (record.suspended) throw httpError(402, 'Sunucu askıda.');
    if (task.action === 'restart') {
        await serverOps.powerAction(docker, record, 'restart');
        return 'Sunucu yeniden başlatıldı.';
    }
    const command = task.action === 'say' ? `say "${task.payload}"`
        : task.action === 'map' ? `changelevel ${task.payload}`
            : task.payload;
    const output = await serverOps.rcon(docker, record, command);
    return String(output || 'Komut gönderildi.').trim().slice(0, 240) || 'Komut gönderildi.';
}

/** Run one task now and store its result. Returns { status, message }. */
async function runTask(docker, task, { manual = false, actor = null } = {}) {
    let status = 'ok';
    let message;
    try {
        message = await executeTask(docker, task);
    } catch (error) {
        status = error.code === 'SERVER_NOT_RUNNING' ? 'skipped' : 'error';
        message = error.message;
    }
    // A manual run does not shift an interval schedule; an automatic one does.
    const nextRunAt = task.enabled ? (manual && task.next_run_at ? task.next_run_at : computeNextRun(task)) : null;
    await panelDb.recordTaskRun(task.id, { status, message, nextRunAt });
    await panelDb.logAudit({
        actorId: actor ? actor.id : null, actorName: actor ? actor.username : 'scheduler',
        action: manual ? 'task.run_manual' : 'task.run', targetType: 'server', targetId: task.port || null,
        details: { task: task.name, action: task.action, status }
    });
    return { status, message };
}

let running = false;
async function runDueTasks(docker) {
    if (running) return 0;
    running = true;
    let count = 0;
    try {
        const due = await panelDb.listDueTasks(50);
        for (const task of due) {
            await runTask(docker, task).catch(e => console.error(`[Scheduler] task ${task.id}:`, e.message));
            count++;
        }
    } catch (error) {
        console.error('[Scheduler] run failed:', error.message);
    } finally {
        running = false;
    }
    return count;
}

module.exports = {
    TIME_ZONE,
    ACTIONS,
    computeNextRun,
    normalizeTask,
    serializeTask,
    runTask,
    runDueTasks,
    _test: { zonedTimeToUtc, wallClock, parseWeekdays }
};

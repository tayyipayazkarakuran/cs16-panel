// /api/servers/:id/tasks — scheduled tasks of one server.
const express = require('express');
const scheduler = require('../schedulerService');
const security = require('../security');

const router = express.Router({ mergeParams: true });

function sendError(res, e) {
    const status = e.statusCode || 500;
    if (status >= 500) console.error('[Tasks]', e.message);
    res.status(status).json({ error: e.message, code: e.code });
}

function audit(req, action, record, details) {
    return req.panelDb.logAudit({
        actorId: req.user.id, actorName: req.user.username, action,
        targetType: 'server', targetId: record.port, details, ip: security.clientIp(req)
    });
}

async function loadServer(req) {
    return req.panelDb.requireServerAccess(req.user, req.docker, req.params.id);
}

async function loadTask(req, record) {
    const task = await req.panelDb.getServerTask(record.id, req.params.taskId);
    if (!task) {
        const e = new Error('Görev bulunamadı.');
        e.statusCode = 404;
        throw e;
    }
    return task;
}

router.get('/', async (req, res) => {
    try {
        const record = await loadServer(req);
        const tasks = await req.panelDb.listServerTasks(record.id);
        res.json({ success: true, timeZone: scheduler.TIME_ZONE, tasks: tasks.map(scheduler.serializeTask) });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/', async (req, res) => {
    try {
        const record = await loadServer(req);
        const task = await req.panelDb.createServerTask(record.id, scheduler.normalizeTask(req.body || {}), req.user.id);
        await audit(req, 'task.create', record, { name: task.name, action: task.action });
        res.status(201).json({ success: true, task: scheduler.serializeTask(task) });
    } catch (e) {
        sendError(res, e);
    }
});

router.put('/:taskId', async (req, res) => {
    try {
        const record = await loadServer(req);
        const existing = await loadTask(req, record);
        const existingForMerge = { ...existing, weekdays: existing.weekdays };
        const task = await req.panelDb.updateServerTask(record.id, existing.id, scheduler.normalizeTask(req.body || {}, existingForMerge));
        await audit(req, 'task.update', record, { name: task.name });
        res.json({ success: true, task: scheduler.serializeTask(task) });
    } catch (e) {
        sendError(res, e);
    }
});

router.delete('/:taskId', async (req, res) => {
    try {
        const record = await loadServer(req);
        const task = await loadTask(req, record);
        await req.panelDb.deleteServerTask(record.id, task.id);
        await audit(req, 'task.delete', record, { name: task.name });
        res.json({ success: true });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/:taskId/run', security.rateLimit({ name: 'task-run', windowMs: 60000, max: 10, keys: req => [String(req.user.id)] }), async (req, res) => {
    try {
        const record = await loadServer(req);
        const task = await loadTask(req, record);
        const result = await scheduler.runTask(req.docker, { ...task, port: record.port }, { manual: true, actor: req.user });
        const fresh = await req.panelDb.getServerTask(record.id, task.id);
        res.json({ success: result.status === 'ok', ...result, task: scheduler.serializeTask(fresh) });
    } catch (e) {
        sendError(res, e);
    }
});

module.exports = router;

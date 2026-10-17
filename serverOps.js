// Server operations shared by HTTP routes and background jobs (scheduler):
// power actions with automatic container recovery, and RCON commands.
const queryHelper = require('./queryHelper');
const gameContainer = require('./gameContainer');
const panelDb = require('./panelDb');

const RCON_FAILURE = /^(RCON (Connection failed|failed|Error)|Bad rcon_password)/i;

function rconError(message) {
    const e = new Error(message);
    e.statusCode = 502;
    return e;
}

/**
 * Start/stop/restart a game container. A container that vanished is rebuilt
 * on the existing volume (no data loss). Returns the (possibly new) record.
 */
async function powerAction(docker, record, action) {
    let container = docker.getContainer(record.container_id);
    let recreated = false;
    try {
        if (action === 'start') await container.start();
        else if (action === 'stop') await container.stop({ t: 10 });
        else await container.restart({ t: 10 });
    } catch (e) {
        if (e.statusCode === 404 && action !== 'stop') {
            const plan = await panelDb.getPlan(record.plan_type);
            record = await require('./billingService').recreateContainerKeepingData(docker, record, { maxPlayers: (plan && plan.max_players) || 24 });
            container = docker.getContainer(record.container_id);
            recreated = true;
        } else if (e.statusCode !== 304) {
            // 304 = already in the requested state; that's success.
            throw e;
        }
    }
    if (action !== 'stop') gameContainer.finishProvisioningInBackground(container, record);
    return { record, container, recreated };
}

/** Send an RCON command to a running server; throws when RCON is unreachable. */
async function rcon(docker, record, command) {
    const info = await docker.getContainer(record.container_id).inspect();
    if (!info.State || !info.State.Running) {
        const e = new Error('Sunucu çalışmıyor.');
        e.statusCode = 409;
        e.code = 'SERVER_NOT_RUNNING';
        throw e;
    }
    const port = gameContainer.gamePortFromInspect(info) || record.port;
    const output = await queryHelper.sendRconCommand(queryHelper.getServerIp(info), port, record.rcon_password || '', command);
    if (RCON_FAILURE.test(String(output).trim())) throw rconError(String(output).trim().slice(0, 200));
    return output;
}

// ---------------------------------------------------------------------------
//  docker stats helpers
// ---------------------------------------------------------------------------

function cpuPercentFromStats(stats) {
    const cpu = stats.cpu_stats || {};
    const pre = stats.precpu_stats || {};
    const cpuDelta = ((cpu.cpu_usage || {}).total_usage || 0) - ((pre.cpu_usage || {}).total_usage || 0);
    const systemDelta = (cpu.system_cpu_usage || 0) - (pre.system_cpu_usage || 0);
    const cores = cpu.online_cpus || ((cpu.cpu_usage || {}).percpu_usage || []).length || 1;
    if (systemDelta <= 0 || cpuDelta < 0) return { percent: 0, cores };
    return { percent: Math.round((cpuDelta / systemDelta) * cores * 1000) / 10, cores };
}

function memoryFromStats(stats, hostLimit) {
    const mem = stats.memory_stats || {};
    const detail = mem.stats || {};
    // Page cache is reclaimable; docker CLI subtracts it the same way.
    const cache = detail.inactive_file !== undefined ? detail.inactive_file : (detail.cache || 0);
    const used = Math.max(0, (mem.usage || 0) - cache);
    return { used, limit: hostLimit || mem.limit || 0, limited: !!hostLimit };
}

function networkFromStats(stats) {
    let rx = 0;
    let tx = 0;
    for (const n of Object.values(stats.networks || {})) {
        rx += n.rx_bytes || 0;
        tx += n.tx_bytes || 0;
    }
    return { rx, tx };
}

/** One stats sample for a container, or null if it is not running / times out. */
async function sampleStats(docker, containerId, timeoutMs = 5000) {
    const container = docker.getContainer(containerId);
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), timeoutMs));
    const stats = await Promise.race([container.stats({ stream: false }).catch(() => null), timeout]);
    if (!stats) return null;
    return { cpu: cpuPercentFromStats(stats), memory: memoryFromStats(stats, null), network: networkFromStats(stats) };
}

module.exports = { powerAction, rcon, cpuPercentFromStats, memoryFromStats, networkFromStats, sampleStats };

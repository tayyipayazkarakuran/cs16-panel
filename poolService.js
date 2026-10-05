// Keeps the always-on rental pool healthy: every configured port has a
// running container and a database record, ready to be rented instantly.
const panelDb = require('./panelDb');
const fastdl = require('./fastdlService');
const gameContainer = require('./gameContainer');
const { isProtectedPort } = require('./serverProtection');

const DEFAULT_POOL_PORTS = '27015-27024';
const MAX_POOL_SIZE = 200;

/** Parse "27015-27024,27030" into a sorted, de-duplicated port list. */
function parsePoolPorts(value) {
    const ports = new Set();
    String(value || '').split(',').forEach(part => {
        const [a, b] = part.split('-').map(s => parseInt(String(s).trim(), 10));
        if (!Number.isInteger(a)) return;
        const end = Number.isInteger(b) ? b : a;
        for (let p = Math.min(a, end); p <= Math.max(a, end) && ports.size < MAX_POOL_SIZE; p++) {
            if (p >= 1024 && p <= 65535) ports.add(p);
        }
    });
    return [...ports].sort((x, y) => x - y);
}

async function getPoolPorts() {
    const setting = await panelDb.getSetting('pool_ports').catch(() => null);
    return parsePoolPorts(setting || process.env.POOL_PORTS || DEFAULT_POOL_PORTS);
}

let ensuring = null;

async function ensurePool(docker) {
    // Concurrent callers (startup, expiry job, admin button) share one run.
    if (ensuring) return ensuring;
    ensuring = doEnsurePool(docker).finally(() => { ensuring = null; });
    return ensuring;
}

async function doEnsurePool(docker) {
    const report = { created: [], started: [], skipped: [], errors: [] };
    const ownerId = await panelDb.getPoolOwnerId();
    const ports = await getPoolPorts();

    const containers = await docker.listContainers({ all: true });
    const containersByPort = new Map();
    for (const c of containers) {
        const match = (c.Names || []).find(n => /cs16-server-\d+$/.test(n));
        if (match) containersByPort.set(parseInt(match.split('-').pop(), 10), c);
    }
    const [records] = await panelDb.assertPool().query('SELECT * FROM panel_servers');
    const recordsByPort = new Map(records.map(r => [r.port, r]));

    for (const port of ports) {
        if (isProtectedPort(port)) { report.skipped.push(port); continue; }
        const container = containersByPort.get(port);
        const record = recordsByPort.get(port);

        // A rented server is never touched here; its owner controls power state.
        if (record && !record.is_pool) {
            if (!container) report.errors.push({ port, error: 'Kiralanmış sunucunun konteyneri bulunamadı.' });
            continue;
        }

        try {
            if (!container || !record) {
                console.log(`[Pool Service] Port ${port} incomplete (container: ${!!container}, record: ${!!record}); rebuilding.`);
                if (container) await gameContainer.removeContainerQuietly(docker, container.Id);
                if (record) await panelDb.deleteServerRecord(record.container_id);

                const resources = panelDb.buildServerResources(port);
                try {
                    await panelDb.ensureSqlAccount(resources.db_name, resources.db_username, resources.db_password);
                } catch (e) {
                    console.log(`[Pool Service] SQL account for ${port}:`, e.message);
                }
                fastdl.ensureCleanFastdlTree(port);
                const rconPassword = require('crypto').randomBytes(12).toString('base64url');
                const created = await gameContainer.createGameContainer(docker, {
                    port, name: `CS 1.6 Server ${port}`, rconPassword, maxPlayers: 32, sql: resources
                });
                await panelDb.upsertServerRecord({
                    container_id: created.id,
                    port,
                    owner_id: ownerId,
                    name: `CS 1.6 Server ${port}`,
                    ...resources,
                    rcon_password: rconPassword,
                    plan_type: 'free',
                    expires_at: new Date('2035-01-01T00:00:00Z'),
                    is_pool: true
                });
                report.created.push(port);
            } else if (container.State !== 'running') {
                await docker.getContainer(container.Id).start();
                report.started.push(port);
            }
        } catch (error) {
            console.error(`[Pool Service] port ${port}:`, error.message);
            report.errors.push({ port, error: error.message });
        }
    }
    return report;
}

module.exports = {
    DEFAULT_POOL_PORTS,
    parsePoolPorts,
    getPoolPorts,
    ensurePool
};

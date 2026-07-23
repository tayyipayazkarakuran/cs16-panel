const panelDb = require('./panelDb');
const fastdl = require('./fastdlService');
const fs = require('fs');
const path = require('path');
const { isProtectedPort } = require('./serverProtection');

const POOL_PORTS = [27015, 27016, 27017, 27018, 27019, 27020, 27021, 27022, 27023, 27024];

async function ensurePool(docker) {
    console.log('[Pool Service] Checking and seeding 10 servers pool...');
    
    // Ensure admin user exists to assign default ownership
    const admin = await panelDb.getAdminUser();
    if (!admin) {
        console.log('[Pool Service] Admin user not found. Seeding skipped.');
        return;
    }

    const containers = await docker.listContainers({ all: true });
    const containersByPort = new Map();
    for (const c of containers) {
        const match = c.Names.find(n => n.includes('cs16-server-'));
        if (match) {
            const parts = match.split('-');
            const port = parseInt(parts[parts.length - 1]);
            if (port) containersByPort.set(port, c);
        }
    }

    const db = panelDb.assertPool();
    const [records] = await db.query('SELECT * FROM panel_servers');
    const recordsByPort = new Map(records.map(r => [r.port, r]));

    for (const port of POOL_PORTS) {
        if (isProtectedPort(port)) {
            console.log(`[Pool Service] Port ${port} is protected; automatic repair/start is skipped.`);
            continue;
        }
        const container = containersByPort.get(port);
        const record = recordsByPort.get(port);

        // Distribute 5-5 across 2 cores: odd ports to Core 0, even ports to Core 1
        const cpuset = (port % 2 === 1) ? '0' : '1';

        if (!container || !record) {
            console.log(`[Pool Service] Server on port ${port} is incomplete (Docker: ${!!container}, DB: ${!!record}). Recreating...`);
            
            // Clean any partial remains
            if (container) {
                try {
                    const c = docker.getContainer(container.Id);
                    await c.remove({ force: true });
                } catch (e) {}
            }
            if (record) {
                try {
                    await panelDb.deleteServerRecord(record.container_id);
                } catch (e) {}
            }

            // Create server resources
            const rconPassword = `rcon${port}`;
            const dbName = `cs_srv_${port}`;
            const dbUser = `csu_${port}`;
            const dbPass = cryptoRandomPassword();
            const phpPath = `servers/${port}`;
            const hostIp = process.env.FASTDL_HOST || 'YOUR_SERVER_IP';
            const phpUrl = `http://${hostIp}:8081/?p=${port}`;
            const svDownloadUrl = `http://${hostIp}:80/${port}/`;

            // Prepare docker options
            const volumeName = `cs16-server-${port}-cstrike`;
            const ExposedPorts = {};
            ExposedPorts[`${port}/udp`] = {};
            ExposedPorts[`${port}/tcp`] = {};

            const PortBindings = {};
            PortBindings[`${port}/udp`] = [{ HostPort: port.toString() }];
            PortBindings[`${port}/tcp`] = [{ HostPort: port.toString() }];

            const fastdlPath = process.env.FASTDL_HOST_PATH || '/opt/cspanel/fastdl-data';
            const phpWwwPath = process.env.PHP_WWW_HOST_PATH || '/opt/cspanel/php-www';

            const cOpts = {
                Image: 'cs16-server-base',
                name: `cs16-server-${port}`,
                ExposedPorts,
                Env: [
                    `PORT=${port}`,
                    `SERVER_NAME=CS 1.6 Server ${port}`,
                    `RCON_PASSWORD=${rconPassword}`,
                    `MAXPLAYERS=32`,
                    `START_MAP=de_dust2`,
                    `SV_DOWNLOADURL=${svDownloadUrl}`
                ],
                HostConfig: {
                    PortBindings,
                    Binds: [
                        `${volumeName}:/hlds/cstrike`,
                        `${fastdlPath}/${port}:/fastdl-data`,
                        `${phpWwwPath}/${port}:/php-www`
                    ],
                    RestartPolicy: { Name: 'always' },
                    CapAdd: ['SYS_NICE'],
                    CpusetCpus: cpuset,
                    Ulimits: [
                        { Name: 'rtprio', Soft: 99, Hard: 99 }
                    ]
                }
            };

            // Provision SQL schema and account
            try {
                await panelDb.ensureSqlAccount(dbName, dbUser, dbPass);
            } catch (e) {
                console.log(`[Pool Service] SQL Account creation error on port ${port}:`, e.message);
            }

            // Provision FastDL files directory
            fastdl.ensureCleanFastdlTree(port);

            // Recreate container and add to network
            try {
                const newC = await docker.createContainer(cOpts);
                await newC.start();
                try {
                    const network = docker.getNetwork('cs-network');
                    await network.connect({ Container: newC.id });
                } catch (e) {}

                // Save record to DB (assigned to Admin initially, infinite expiry)
                await panelDb.upsertServerRecord({
                    container_id: newC.id,
                    port,
                    owner_id: admin.id,
                    name: `CS 1.6 Server ${port}`,
                    db_name: dbName,
                    db_username: dbUser,
                    db_password: dbPass,
                    php_path: phpPath,
                    php_url: phpUrl,
                    fastdl_path: String(port),
                    sv_downloadurl: svDownloadUrl,
                    plan_type: 'free',
                    expires_at: '2035-01-01 00:00:00'
                });
                console.log(`[Pool Service] Server on port ${port} created and running on CPU Core ${cpuset}.`);
            } catch (dockerErr) {
                console.error(`[Pool Service] Failed to create container for port ${port}:`, dockerErr.message);
            }
        } else {
            // Container and record exist, ensure it is running
            try {
                const c = docker.getContainer(container.Id);
                const info = await c.inspect();
                if (!info.State.Running) {
                    console.log(`[Pool Service] Server on port ${port} was offline. Starting it...`);
                    await c.start();
                }
            } catch (inspectErr) {
                console.log(`[Pool Service] Check container error on port ${port}:`, inspectErr.message);
            }
        }
    }
}

function cryptoRandomPassword() {
    return require('crypto').randomBytes(12).toString('hex');
}

module.exports = {
    POOL_PORTS,
    ensurePool
};

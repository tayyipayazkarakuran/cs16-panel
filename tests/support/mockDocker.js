// In-process stand-in for dockerode used by tests and by `PANEL_MOCK_DOCKER=1`
// UI development. Game containers are simulated; their /hlds/cstrike and
// /fastdl-data trees are real directories under MOCK_DOCKER_ROOT so the file
// manager, FastDL sync and config editors run their actual Python scripts.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const tar = require('tar-stream');

function create({ root = process.env.MOCK_DOCKER_ROOT || path.join(os.tmpdir(), 'cspanel-mock-docker'), fastdlRoot = process.env.FASTDL_PATH } = {}) {
    fs.mkdirSync(root, { recursive: true });
    const containers = new Map();
    const networks = new Set(['cs-network']);

    function volumeDir(name) {
        return path.join(root, 'volumes', name);
    }

    function seedVolume(dir, env) {
        if (fs.existsSync(path.join(dir, 'server.cfg'))) return;
        fs.mkdirSync(path.join(dir, 'maps'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'addons/amxmodx/configs'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'addons/amxmodx/plugins'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'addons/amxmodx/scripting'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'server.cfg'), `hostname "${env.SERVER_NAME || 'CS 1.6 Server'}"\nrcon_password "${env.RCON_PASSWORD || ''}"\nsys_ticrate 1000\nmp_timelimit 20\n`);
        fs.writeFileSync(path.join(dir, 'mapcycle.txt'), 'de_dust2\nde_inferno\nde_nuke\n');
        fs.writeFileSync(path.join(dir, 'addons/amxmodx/configs/plugins.ini'), '; AMX Mod X plugins\nadmin.amxx\nadmincmd.amxx\n;statsx.amxx\n');
        fs.writeFileSync(path.join(dir, 'addons/amxmodx/configs/users.ini'), '; Users\n"STEAM_0:1:12345" "" "abcdefghijklmnopqrstu" "ce" ; Kurucu\n');
        fs.writeFileSync(path.join(dir, 'addons/amxmodx/plugins/admin.amxx'), 'x');
        fs.writeFileSync(path.join(dir, 'addons/amxmodx/plugins/admincmd.amxx'), 'x');
        fs.writeFileSync(path.join(dir, 'addons/amxmodx/scripting/hello.sma'), '#include <amxmodx>\npublic plugin_init() { register_plugin("Hello", "1.0", "panel"); }\n');
        fs.writeFileSync(path.join(dir, 'maps/de_dust2.bsp'), crypto.randomBytes(2048));
        fs.writeFileSync(path.join(dir, 'maps/de_inferno.bsp'), crypto.randomBytes(1024));
        fs.writeFileSync(path.join(dir, 'liblist.gam'), 'game "Counter-Strike"\n');
    }

    function envMap(list) {
        const out = {};
        (list || []).forEach(e => { const i = e.indexOf('='); out[e.slice(0, i)] = e.slice(i + 1); });
        return out;
    }

    function pathsFor(c) {
        const port = c.port;
        return {
            cstrike: volumeDir(`cs16-server-${port}-cstrike`),
            fastdl: path.join(fastdlRoot || path.join(root, 'fastdl'), String(port)),
            hlds: path.join(root, 'hlds', String(port))
        };
    }

    function remap(value, c) {
        const p = pathsFor(c);
        return String(value)
            .split('/hlds/cstrike').join(p.cstrike)
            .split('/fastdl-data').join(p.fastdl)
            .split('/hlds/').join(`${p.hlds}/`);
    }

    function makeContainer(c) {
        const api = {
            id: c.Id,
            async inspect() {
                if (!containers.has(c.Id)) throw Object.assign(new Error('no such container'), { statusCode: 404 });
                return {
                    Id: c.Id,
                    Name: `/${c.name}`,
                    State: { Running: c.state === 'running', Status: c.state },
                    Config: { Env: c.env, Image: c.image, ExposedPorts: {} },
                    HostConfig: { PortBindings: { [`${c.port}/udp`]: [{ HostPort: String(c.port) }] }, Binds: [] },
                    NetworkSettings: { IPAddress: '127.0.0.1', Networks: { 'cs-network': { IPAddress: '127.0.0.1' } } }
                };
            },
            async start() {
                if (c.state === 'running') throw Object.assign(new Error('already started'), { statusCode: 304 });
                c.state = 'running';
                c.startedAt = Date.now();
            },
            async stop() {
                if (c.state !== 'running') throw Object.assign(new Error('already stopped'), { statusCode: 304 });
                c.state = 'exited';
            },
            async restart() { c.state = 'running'; c.startedAt = Date.now(); },
            async remove() { containers.delete(c.Id); },
            async wait() { return { StatusCode: 0 }; },
            logs(opts, cb) {
                const lines = `ReHLDS version: 3.13\nExecuting server.cfg\nPort ${c.port} ready, map ${envMap(c.env).START_MAP || 'de_dust2'}\n`;
                if (typeof cb === 'function') {
                    const stream = new PassThrough();
                    cb(null, stream);
                    stream.write(lines);
                    return undefined;
                }
                return Promise.resolve(Buffer.from(lines));
            },
            async exec(options) {
                const cmd = options.Cmd.map(part => remap(part, c));
                const cwd = options.WorkingDir ? remap(options.WorkingDir, c) : pathsFor(c).cstrike;
                const state = { Running: true, ExitCode: null };
                return {
                    async start() {
                        const stream = new PassThrough();
                        fs.mkdirSync(pathsFor(c).cstrike, { recursive: true });
                        fs.mkdirSync(pathsFor(c).fastdl, { recursive: true });
                        let child;
                        try {
                            child = spawn(cmd[0], cmd.slice(1), { cwd: fs.existsSync(cwd) ? cwd : pathsFor(c).cstrike });
                        } catch (e) {
                            state.Running = false; state.ExitCode = 127;
                            setImmediate(() => stream.end());
                            return stream;
                        }
                        const output = new PassThrough();
                        child.stdout.on('data', d => output.write(d));
                        child.stderr.on('data', d => output.write(d));
                        child.on('error', () => { state.Running = false; state.ExitCode = 127; output.end(); });
                        child.on('close', code => {
                            // Output first, then mark the process finished.
                            output.end();
                            setImmediate(() => { state.Running = false; state.ExitCode = code; });
                        });
                        if (options.AttachStdin) {
                            const duplex = new PassThrough();
                            duplex.on('finish', () => {});
                            const originalEnd = duplex.end.bind(duplex);
                            duplex.end = payload => { if (payload) child.stdin.write(payload); child.stdin.end(); return duplex; };
                            output.on('data', d => duplex.push(d));
                            output.on('end', () => originalEnd());
                            return duplex;
                        }
                        output.pipe(stream);
                        return stream;
                    },
                    async inspect() { return { ...state }; }
                };
            },
            async putArchive(pack, opts) {
                const dest = remap(opts.path, c);
                const extract = tar.extract();
                await new Promise((resolve, reject) => {
                    extract.on('entry', (header, stream, next) => {
                        const target = path.join(dest, header.name);
                        fs.mkdirSync(path.dirname(target), { recursive: true });
                        const chunks = [];
                        stream.on('data', d => chunks.push(d));
                        stream.on('end', () => { fs.writeFileSync(target, Buffer.concat(chunks)); next(); });
                    });
                    extract.on('finish', resolve);
                    extract.on('error', reject);
                    pack.pipe(extract);
                });
            },
            getArchive(opts, cb) {
                const file = remap(opts.path, c);
                try {
                    const data = fs.readFileSync(file);
                    const pack = tar.pack();
                    pack.entry({ name: path.basename(file), size: data.length }, data);
                    pack.finalize();
                    cb(null, pack);
                } catch (e) {
                    cb(Object.assign(e, { statusCode: 404 }));
                }
            }
        };
        return api;
    }

    const docker = {
        _containers: containers,
        async listContainers(opts = {}) {
            return [...containers.values()]
                .filter(c => opts.all || c.state === 'running')
                .filter(c => !(opts.filters && opts.filters.name) || opts.filters.name.some(n => new RegExp(n).test(`/${c.name}`)))
                .map(c => ({
                    Id: c.Id,
                    Names: [`/${c.name}`],
                    Image: c.image,
                    State: c.state,
                    Status: c.state === 'running' ? `Up ${Math.max(1, Math.round((Date.now() - (c.startedAt || Date.now())) / 60000))} minutes` : 'Exited (0)',
                    Ports: c.port ? [{ PublicPort: c.port, PrivatePort: c.port, Type: 'udp' }] : []
                }));
        },
        getContainer(id) {
            const c = containers.get(id) || [...containers.values()].find(x => x.Id.startsWith(id));
            if (!c) {
                const missing = { Id: id, name: 'missing', state: 'missing', env: [], port: 0 };
                const api = makeContainer(missing);
                const fail = async () => { throw Object.assign(new Error('no such container'), { statusCode: 404 }); };
                return { ...api, inspect: fail, start: fail, stop: fail, restart: fail, remove: fail, exec: fail };
            }
            return makeContainer(c);
        },
        async createContainer(opts) {
            const id = crypto.randomBytes(32).toString('hex');
            const env = envMap(opts.Env);
            const c = { Id: id, name: opts.name, image: opts.Image, env: opts.Env, port: parseInt(env.PORT, 10) || 0, state: 'created' };
            containers.set(id, c);
            seedVolume(pathsFor(c).cstrike, env);
            return makeContainer(c);
        },
        getVolume(name) {
            return { async remove() { fs.rmSync(volumeDir(name), { recursive: true, force: true }); } };
        },
        getNetwork(name) {
            return {
                async inspect() { if (!networks.has(name)) throw Object.assign(new Error('no network'), { statusCode: 404 }); return { Name: name }; },
                async connect() {}
            };
        },
        /** Add infrastructure containers so the admin infra view has data. */
        addService(name, state = 'running') {
            const id = crypto.randomBytes(32).toString('hex');
            containers.set(id, { Id: id, name, image: name, env: [], port: 0, state, startedAt: Date.now() - 3600000 });
            return id;
        }
    };
    return docker;
}

module.exports = { create };

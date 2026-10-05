// Central runtime configuration. Every module that needs a public URL, host or
// path reads it from here so FastDL, PHP and MySQL addresses can never drift
// apart between the panel, the database records and the game containers.
const path = require('path');

function env(name, fallback = '') {
    const value = process.env[name];
    return value === undefined || value === '' ? fallback : value;
}

function intEnv(name, fallback) {
    const parsed = parseInt(env(name, ''), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function stripSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

const HOST_IP = env('HOST_IP', '127.0.0.1');
const GAME_SERVER_HOST = env('GAME_SERVER_HOST', HOST_IP);

const FASTDL_HOST = env('FASTDL_HOST', HOST_IP);
const FASTDL_PORT = env('FASTDL_PORT', '8080');
// Optional explicit base (e.g. http://fastdl.example.com). GoldSrc clients only
// reliably download over plain HTTP, so keep this http:// in production.
const FASTDL_PUBLIC_URL = stripSlash(env('FASTDL_PUBLIC_URL', ''));

const PHP_PUBLIC_BASE_URL = stripSlash(env('PHP_PUBLIC_BASE_URL', `http://${HOST_IP}:8081`));

const MYSQL_HOST = env('MYSQL_HOST', '127.0.0.1');
const MYSQL_PORT = intEnv('MYSQL_PORT', 3306);
// Host game servers and PHP sites use (they all live on cs-network).
const MYSQL_INTERNAL_HOST = env('MYSQL_INTERNAL_HOST', MYSQL_HOST);
const MYSQL_INTERNAL_PORT = intEnv('MYSQL_INTERNAL_PORT', MYSQL_PORT);
// Host shown to customers for remote tools; empty means "not exposed".
const MYSQL_PUBLIC_HOST = env('MYSQL_PUBLIC_HOST', '');
const MYSQL_PUBLIC_PORT = intEnv('MYSQL_PUBLIC_PORT', 3306);

const config = {
    port: intEnv('PORT', 3000),
    nodeEnv: env('NODE_ENV', 'development'),
    isProduction: env('NODE_ENV', 'development') === 'production',
    panelPublicUrl: stripSlash(env('PANEL_PUBLIC_URL', 'http://localhost:3000')),
    hostIp: HOST_IP,
    gameServerHost: GAME_SERVER_HOST,

    fastdl: {
        path: env('FASTDL_PATH', path.join(__dirname, 'fastdl-data')),
        hostPath: env('FASTDL_HOST_PATH', '/opt/cspanel/fastdl-data'),
        host: FASTDL_HOST,
        port: FASTDL_PORT
    },
    php: {
        wwwPath: env('PHP_WWW_PATH', path.join(__dirname, 'php-www')),
        hostPath: env('PHP_WWW_HOST_PATH', '/opt/cspanel/php-www'),
        publicBaseUrl: PHP_PUBLIC_BASE_URL,
        fileUid: intEnv('PHP_FILE_UID', 33),
        fileGid: intEnv('PHP_FILE_GID', 33),
        containerName: env('PHP_CONTAINER_NAME', 'cs-php')
    },
    mysql: {
        host: MYSQL_HOST,
        port: MYSQL_PORT,
        rootPassword: env('MYSQL_ROOT_PASSWORD', 'cs_root_2024'),
        internalHost: MYSQL_INTERNAL_HOST,
        internalPort: MYSQL_INTERNAL_PORT,
        publicHost: MYSQL_PUBLIC_HOST,
        publicPort: MYSQL_PUBLIC_PORT
    },
    docker: {
        network: env('DOCKER_NETWORK', 'cs-network'),
        gameImage: env('GAME_IMAGE', 'cs16-server-base')
    }
};

function fastdlBaseUrl() {
    if (FASTDL_PUBLIC_URL) return FASTDL_PUBLIC_URL;
    const portPart = (FASTDL_PORT === '80') ? '' : `:${FASTDL_PORT}`;
    return `http://${FASTDL_HOST}${portPart}`;
}

/** Public FastDL URL for one game server, always with a trailing slash. */
function fastdlUrl(port) {
    return `${fastdlBaseUrl()}/${parseInt(port, 10)}/`;
}

/**
 * Public URL of a server's PHP site. PHP_PUBLIC_BASE_URL may contain a
 * `{port}` placeholder (e.g. https://php-{port}.example.com) for per-site
 * subdomains; otherwise sites live under /<port>/ of the PHP host.
 */
function phpSiteUrl(port, domain = null) {
    if (domain) return `http://${domain}/`;
    const p = parseInt(port, 10);
    if (PHP_PUBLIC_BASE_URL.includes('{port}')) {
        return `${PHP_PUBLIC_BASE_URL.replace(/\{port\}/g, p)}/`;
    }
    return `${PHP_PUBLIC_BASE_URL}/${p}/`;
}

function mysqlEndpoints() {
    return {
        internal: { host: MYSQL_INTERNAL_HOST, port: MYSQL_INTERNAL_PORT },
        external: MYSQL_PUBLIC_HOST ? { host: MYSQL_PUBLIC_HOST, port: MYSQL_PUBLIC_PORT } : null
    };
}

module.exports = {
    ...config,
    config,
    fastdlBaseUrl,
    fastdlUrl,
    phpSiteUrl,
    mysqlEndpoints
};

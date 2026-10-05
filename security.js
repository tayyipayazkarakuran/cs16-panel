// HTTP-level security helpers shared by the Express app and the WebSocket
// server: session cookies, same-origin checks and a small in-memory rate
// limiter (good enough for a single panel process).
const cfg = require('./config');

const COOKIE_NAME = 'cs_panel_session';
const SESSION_MAX_AGE_MS = parseInt(process.env.PANEL_TOKEN_TTL_SECONDS || '86400', 10) * 1000;

const PANEL_URL = new URL(cfg.panelPublicUrl);

function originOf(value) {
    try { return new URL(String(value).trim()).origin; } catch (_) { return null; }
}

const ALLOWED_ORIGINS = new Set([
    PANEL_URL.origin,
    ...String(process.env.PANEL_ADDITIONAL_ORIGINS || '').split(',').map(originOf)
].filter(Boolean));

// Landing page on the bare domain (panel.example.com -> example.com).
if (/^panel\./i.test(PANEL_URL.hostname)) {
    ALLOWED_ORIGINS.add(`${PANEL_URL.protocol}//${PANEL_URL.hostname.replace(/^panel\./i, '')}${PANEL_URL.port ? `:${PANEL_URL.port}` : ''}`);
}

function parseCookies(header = '') {
    return String(header).split(';').reduce((cookies, part) => {
        const separator = part.indexOf('=');
        if (separator < 0) return cookies;
        const key = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        if (!key) return cookies;
        try { cookies[key] = decodeURIComponent(value); } catch (_) { cookies[key] = value; }
        return cookies;
    }, {});
}

function requestIsSecure(req) {
    if (process.env.PANEL_COOKIE_SECURE) return process.env.PANEL_COOKIE_SECURE === 'true';
    return !!req.secure;
}

/**
 * Host-only cookie. A Domain=.example.com cookie used to be sent to every
 * customer PHP site on php-<port>.example.com, where any user's PHP code could
 * read the panel session (including an administrator's).
 */
function cookieOptions(req) {
    return {
        httpOnly: true,
        secure: requestIsSecure(req),
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_MAX_AGE_MS
    };
}

function setSessionCookie(req, res, token) {
    res.cookie(COOKIE_NAME, token, cookieOptions(req));
}

function clearSessionCookie(req, res) {
    const options = cookieOptions(req);
    delete options.maxAge;
    res.clearCookie(COOKIE_NAME, options);
}

function getAuthToken(req) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) return { token: header.slice(7).trim(), source: 'bearer' };
    const cookieToken = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    if (cookieToken) return { token: cookieToken, source: 'cookie' };
    return { token: null, source: null };
}

/**
 * Cookie-authenticated state changes must come from the panel itself. The
 * request's own Host counts as same-origin so IP/port deployments work
 * without extra configuration.
 */
function isTrustedOrigin(origin, hostHeader) {
    const o = originOf(origin);
    if (!o) return false;
    if (ALLOWED_ORIGINS.has(o)) return true;
    try {
        return new URL(o).host.toLowerCase() === String(hostHeader || '').toLowerCase();
    } catch (_) {
        return false;
    }
}

function requestHasTrustedOrigin(req) {
    const origin = req.get('origin');
    if (origin) return isTrustedOrigin(origin, req.get('host'));
    // Some browsers omit Origin on same-origin form posts; fall back to Referer.
    const referer = req.get('referer');
    return referer ? isTrustedOrigin(referer, req.get('host')) : false;
}

function clientIp(req) {
    return (req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}

// ---------------------------------------------------------------------------
//  Rate limiting
// ---------------------------------------------------------------------------

const buckets = new Map();

function hit(key, windowMs) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket;
}

/**
 * Express middleware. `keys(req)` returns one or more bucket keys; the request
 * is rejected if any of them exceeds `max` within `windowMs`.
 */
function rateLimit({ name, windowMs, max, keys = req => [clientIp(req)], message }) {
    return (req, res, next) => {
        for (const key of keys(req).filter(Boolean)) {
            const bucket = hit(`${name}:${key}`, windowMs);
            if (bucket.count > max) {
                const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000));
                res.set('Retry-After', String(retryAfter));
                return res.status(429).json({
                    error: message || `Çok fazla istek. ${Math.ceil(retryAfter / 60)} dakika sonra tekrar deneyin.`
                });
            }
        }
        next();
    };
}

setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
    }
}, 60000).unref();

const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
].join('; ');

module.exports = {
    COOKIE_NAME,
    ALLOWED_ORIGINS,
    CSP,
    parseCookies,
    setSessionCookie,
    clearSessionCookie,
    getAuthToken,
    isTrustedOrigin,
    requestHasTrustedOrigin,
    clientIp,
    rateLimit,
    _test: { buckets }
};

const express = require('express');
const router = express.Router();
const http = require('http');
const url = require('url');

function routeError(res, e) {
    res.status(e.statusCode || 500).json({ error: e.message });
}

function proxyPhpRequest(targetUrl, req, res) {
    return new Promise((resolve, reject) => {
        const parsed = url.parse(targetUrl);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 80,
            path: parsed.path,
            method: req.method,
            headers: { ...req.headers, host: parsed.host }
        };
        // Do not leak any panel auth token / cookies to the PHP container
        delete options.headers.authorization;
        delete options.headers.cookie;

        const proxyReq = http.request(options, (proxyRes) => {
            res.statusCode = proxyRes.statusCode;
            Object.keys(proxyRes.headers).forEach(key => {
                // Skip hop-by-hop headers
                if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(key.toLowerCase())) return;
                res.setHeader(key, proxyRes.headers[key]);
            });
            proxyRes.pipe(res);
            proxyRes.on('end', resolve);
            proxyRes.on('error', reject);
        });
        proxyReq.on('error', reject);

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            req.pipe(proxyReq);
        } else {
            proxyReq.end();
        }
    });
}

// Public PHP proxy: no auth required, but only existing server ports are reachable.
router.all('/:port/*', async (req, res) => {
    try {
        const port = parseInt(req.params.port, 10);
        if (!port) return res.status(400).json({ error: 'Invalid port' });

        // Verify the server exists in the panel (running or not)
        const record = await req.panelDb.getServerByPort(port);
        if (!record) return res.status(404).json({ error: 'Server not found' });

        const relPath = req.params[0] || '';
        const query = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
        const targetUrl = `http://cs-php:80/servers/${port}/${relPath}${query}`;
        await proxyPhpRequest(targetUrl, req, res);
    } catch (e) {
        routeError(res, e);
    }
});

module.exports = router;

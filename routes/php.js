// PHP host status for every user and container controls for administrators.
const express = require('express');
const cfg = require('../config');
const phpSite = require('../phpSiteService');

const router = express.Router();

function sendError(res, e) {
    res.status(e.statusCode || 500).json({ error: e.message });
}

async function findPhpContainer(docker) {
    const containers = await docker.listContainers({ all: true });
    return containers.find(c => (c.Names || []).some(n => n === `/${cfg.php.containerName}`)) || null;
}

router.get('/status', async (req, res) => {
    try {
        const info = await findPhpContainer(req.docker);
        const servers = await req.panelDb.listServersForUser(req.user);
        const sites = servers
            .filter(s => !s.is_pool && (req.user.role === 'admin' || !s.suspended))
            .map(s => ({ serverId: s.container_id, port: s.port, name: s.name, url: cfg.phpSiteUrl(s.port), domain: s.php_domain || null }));
        res.json({
            running: !!info && info.State === 'running',
            status: info ? info.Status : 'cs-php container not found',
            baseUrl: cfg.php.publicBaseUrl,
            wwwPath: req.user.role === 'admin' ? cfg.php.wwwPath : undefined,
            sites
        });
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/restart', async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
        const info = await findPhpContainer(req.docker);
        if (!info) return res.status(404).json({ error: 'cs-php container not found' });
        await req.docker.getContainer(info.Id).restart();
        res.json({ success: true, message: 'PHP container restarted.' });
    } catch (e) {
        sendError(res, e);
    }
});

// Re-create every site's skeleton/config and the custom domain map.
router.post('/repair-all', async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
        const servers = await req.panelDb.listServersForUser(req.user);
        let repaired = 0;
        for (const s of servers.filter(row => !row.is_pool)) {
            await phpSite.ensureSite(s);
            repaired++;
        }
        await phpSite.writeDomainMap();
        res.json({ success: true, message: `${repaired} site onarıldı.` });
    } catch (e) {
        sendError(res, e);
    }
});

module.exports = router;

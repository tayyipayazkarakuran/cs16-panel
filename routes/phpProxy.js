// Legacy /api/php/proxy/:port/* links. Customer PHP used to be proxied through
// the panel origin, which let any site run scripts with the panel's cookies.
// Sites are now served only from the isolated PHP host, so just redirect.
const express = require('express');
const cfg = require('../config');

const router = express.Router();

router.all('/:port/*?', (req, res) => {
    const port = parseInt(req.params.port, 10);
    if (!port) return res.status(400).json({ error: 'Invalid port' });
    const rest = String(req.params[0] || '').replace(/^\/+/, '');
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(301, `${cfg.phpSiteUrl(port)}${rest}${query}`);
});

module.exports = router;

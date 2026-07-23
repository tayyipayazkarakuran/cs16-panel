const express = require('express');
const router = express.Router();

// Enforce admin permission for all routes in this router
router.use((req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied. Admin role required.' });
    }
    next();
});

// GET /api/admin/users - List all users
router.get('/users', async (req, res) => {
    try {
        const users = await req.panelDb.listAllUsers();
        res.json({ success: true, users });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/admin/users - Create new user
router.post('/users', async (req, res) => {
    try {
        const { username, password, role, balance } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required.' });
        }
        const newUser = await req.panelDb.createUser(username, password);
        
        // If role or balance is specified, update them
        const fields = {};
        if (role !== undefined) fields.role = role;
        if (balance !== undefined) fields.balance = parseFloat(balance) || 0;
        
        if (Object.keys(fields).length > 0) {
            await req.panelDb.updateUserAdmin(newUser.id, fields, req.docker);
        }
        
        res.json({ success: true, message: 'User created successfully.', user: newUser });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/admin/users/:id/stop-servers - Stop all servers of a user
router.post('/users/:id/stop-servers', async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        const user = { id: userId, role: 'user' };
        const servers = await req.panelDb.listServersForUser(user);
        
        let stoppedCount = 0;
        for (const s of servers) {
            try {
                const container = req.docker.getContainer(s.container_id);
                const info = await container.inspect();
                if (info.State.Running) {
                    await container.stop({ t: 5 }).catch(() => {});
                    stoppedCount++;
                }
            } catch (err) {
                console.log(`Failed to stop container ${s.container_id}: ${err.message}`);
            }
        }
        res.json({ success: true, message: `Successfully stopped ${stoppedCount} server(s).` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/admin/users/:id - Update user details
router.put('/users/:id', async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        const { username, role, balance, suspended } = req.body;
        
        const fields = {};
        if (username !== undefined) fields.username = username;
        if (role !== undefined) fields.role = role;
        if (balance !== undefined) fields.balance = parseFloat(balance);
        if (suspended !== undefined) fields.suspended = suspended ? 1 : 0;

        const updated = await req.panelDb.updateUserAdmin(userId, fields, req.docker);
        res.json({ success: true, user: updated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/admin/users/:id - Delete user and their resources
router.delete('/users/:id', async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (userId === req.user.id) {
            return res.status(400).json({ error: 'You cannot delete yourself.' });
        }
        await req.panelDb.deleteUserAdmin(userId, req.docker);
        res.json({ success: true, message: 'User and all their servers deleted.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/admin/settings - Get all system settings
router.get('/settings', async (req, res) => {
    try {
        const allSettingsList = await req.panelDb.listAllSettings();
        
        // Build compatibility object
        const settingsObj = {};
        for (const s of allSettingsList) {
            settingsObj[s.key] = s.value;
        }

        res.json({
            success: true,
            settings: {
                iban_details: settingsObj.iban_details || '',
                global_free_limit: parseInt(settingsObj.global_free_limit || '15', 10),
                price_standard: parseFloat(settingsObj.price_standard || '250'),
                price_pro: parseFloat(settingsObj.price_pro || '350'),
                max_players_free: parseInt(settingsObj.max_players_free || '24', 10),
                max_players_standard: parseInt(settingsObj.max_players_standard || '24', 10),
                max_players_pro: parseInt(settingsObj.max_players_pro || '32', 10)
            },
            allSettings: allSettingsList
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/admin/settings - Create a new setting
router.post('/settings', async (req, res) => {
    try {
        const { key, value, name, type, description, options } = req.body;
        if (!key) {
            return res.status(400).json({ error: 'Setting key is required.' });
        }
        await req.panelDb.createSetting(
            key, 
            value || '', 
            name || key, 
            type || 'text', 
            description || '', 
            options || null
        );
        res.json({ success: true, message: 'Setting created successfully.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/admin/settings/:key - Update a specific setting
router.put('/settings/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const { value, name, type, description, options } = req.body;
        
        const fields = {};
        if (value !== undefined) fields.value = String(value);
        if (name !== undefined) fields.name = name;
        if (type !== undefined) fields.type = type;
        if (description !== undefined) fields.description = description;
        if (options !== undefined) fields.options = options;

        await req.panelDb.updateSetting(key, fields);
        res.json({ success: true, message: `Setting '${key}' updated successfully.` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/admin/settings/:key - Delete a specific setting
router.delete('/settings/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const defaults = ['iban_details', 'global_free_limit', 'price_standard', 'price_pro', 'max_players_free', 'max_players_standard', 'max_players_pro'];
        if (defaults.includes(key)) {
            return res.status(400).json({ error: 'Cannot delete a default system setting.' });
        }
        await req.panelDb.deleteSetting(key);
        res.json({ success: true, message: `Setting '${key}' deleted successfully.` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/admin/settings - Batch update system setting values
router.put('/settings', async (req, res) => {
    try {
        const body = req.body;
        for (const [key, value] of Object.entries(body)) {
            if (value !== undefined) {
                await req.panelDb.setSetting(key, value);
            }
        }
        res.json({ success: true, message: 'System settings updated successfully.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;

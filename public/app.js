// CS 1.6 Dedicated Server Panel – Frontend Logic

// ---- State ----
let servers        = [];
let activeServerId = null;
let currentPage    = 'servers'; // 'servers' | 'fastdl' | 'mysql' | 'php'
let currentFilePath  = '';
let phpCurrentPath   = '';
let phpRoots         = [];
let mysqlCurrentDb     = '';
let mysqlCurrentTable  = '';
let mysqlCurrentOffset = 0;
let consoleWs      = null;
let statsInterval  = null;
let activeTab      = 'tab-console';
let authToken      = localStorage.getItem('cs_panel_token') || '';
let currentUser    = null;
let pendingHandoffCode = null;
let activeFileUploadXhr = null;
let fileUploadCancelled = false;
let fileUploadTimer = null;
let fileTransferState = null;

if (window.location.hash) {
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    pendingHandoffCode = hashParams.get('code');
    if (pendingHandoffCode) {
        history.replaceState(null, document.title, window.location.pathname + window.location.search);
    }
}

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    
    // Build a plain object of headers to ensure full cross-browser compatibility
    const headersObj = {};
    if (init.headers) {
        if (init.headers instanceof Headers) {
            for (const [key, val] of init.headers.entries()) {
                headersObj[key.toLowerCase()] = val;
            }
        } else if (Array.isArray(init.headers)) {
            for (const [key, val] of init.headers) {
                headersObj[key.toLowerCase()] = val;
            }
        } else {
            for (const key in init.headers) {
                headersObj[key.toLowerCase()] = init.headers[key];
            }
        }
    }

    const isApiRequest = url.startsWith('/api') || url.includes('/api/') || url.startsWith('api/');
    if (authToken && isApiRequest && !url.includes('/api/auth/login') && !url.includes('/api/auth/register')) {
        headersObj['authorization'] = `Bearer ${authToken}`;
    }

    const apiTimeoutMs = init.apiTimeoutMs || 120000;
    const requestInit = { ...init, headers: headersObj };
    delete requestInit.apiTimeoutMs;
    let timeoutId = null;
    let requestTimedOut = false;
    if (isApiRequest && !requestInit.signal) {
        const controller = new AbortController();
        requestInit.signal = controller.signal;
        timeoutId = setTimeout(() => {
            requestTimedOut = true;
            controller.abort();
        }, apiTimeoutMs);
    }

    let res;
    try {
        res = await nativeFetch(input, requestInit);
    } catch (error) {
        if (requestTimedOut) {
            const timeoutError = new Error(`API isteği ${Math.round(apiTimeoutMs / 1000)} saniye içinde tamamlanamadı. Bağlantıyı kontrol edip yeniden deneyin.`);
            timeoutError.name = 'ApiTimeoutError';
            throw timeoutError;
        }
        if (requestInit.signal && requestInit.signal.aborted) {
            const cancelledError = new Error('API isteği tarayıcı veya başka bir işlem tarafından iptal edildi. Sayfayı yenileyip yeniden deneyin.');
            cancelledError.name = 'RequestCancelledError';
            throw cancelledError;
        }
        throw error;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
    if (res.status === 401 && !url.includes('/api/auth/login') && !url.includes('/api/auth/register') && !url.includes('/api/auth/exchange')) {
        authToken = '';
        currentUser = null;
        localStorage.removeItem('cs_panel_token');
        localStorage.removeItem('cs_panel_user');
        saveState();
        showLogin('Oturum süreniz doldu. Lütfen yeniden giriş yapın.');
    }
    return res;
};

// ---- Restore state from localStorage (F5 persistence) ----
try {
    const saved = JSON.parse(localStorage.getItem('cs_panel_state') || '{}');
    if (saved.activeServerId) activeServerId = saved.activeServerId;
    if (saved.activeTab)      activeTab      = saved.activeTab;
    if (saved.currentPage)    currentPage    = saved.currentPage;
} catch (e) { /* ignore */ }

function saveState() {
    try {
        localStorage.setItem('cs_panel_state', JSON.stringify({
            activeServerId,
            activeTab,
            currentPage
        }));
    } catch (e) { /* ignore */ }
}

// ---- DOM refs ----
const serverList       = document.getElementById('server-list');
const noServerSelected = document.getElementById('no-server-selected');
const serverDashboard  = document.getElementById('server-dashboard');
const serverRentPanel  = document.getElementById('server-rent-panel');
const formRentServer   = document.getElementById('form-rent-server');
const rentServerPort   = document.getElementById('rent-server-port');
const rentPortDisplay  = document.getElementById('rent-port-display');
const rentServerName   = document.getElementById('rent-server-name');
const rentServerPlan   = document.getElementById('rent-server-plan');
const rentServerRcon   = document.getElementById('rent-server-rcon');
const rentServerMap    = document.getElementById('rent-server-map');
const pageFastdl       = document.getElementById('page-fastdl');
const pageMysql        = document.getElementById('page-mysql');
const pagePhp          = document.getElementById('page-php');

const dbServerName   = document.getElementById('db-server-name');
const dbServerIp     = document.getElementById('db-server-ip');
const dbServerPort   = document.getElementById('db-server-port');
const dbServerStatus = document.getElementById('db-server-status');

const statPlayers = document.getElementById('stat-players');
const statMap     = document.getElementById('stat-map');
const statFps     = document.getElementById('stat-fps');
const statCpu     = document.getElementById('stat-cpu');

const btnStart   = document.getElementById('btn-start');
const btnStop    = document.getElementById('btn-stop');
const btnRestart = document.getElementById('btn-restart');
const btnDelete  = document.getElementById('btn-delete');
const btnReset   = document.getElementById('btn-reset');

const btnCreateServerModal  = document.getElementById('btn-create-server-modal');
const btnCreateServerHero   = document.getElementById('btn-create-server-hero');
const modalCreateServer     = document.getElementById('modal-create-server');
const btnCloseCreateModal   = document.getElementById('btn-close-create-modal');
const btnCancelCreateModal  = document.getElementById('btn-cancel-create-modal');
const formCreateServer      = document.getElementById('form-create-server');

const modalFileEditor      = document.getElementById('modal-file-editor');
const btnCloseEditorModal  = document.getElementById('btn-close-editor-modal');
const btnCancelEditorModal = document.getElementById('btn-cancel-editor-modal');
const btnSaveEditorFile    = document.getElementById('btn-save-editor-file');
const editorFilenameHeader = document.getElementById('editor-filename');
const fileEditorTextarea   = document.getElementById('file-editor-textarea');
let currentlyEditingFile   = '';
let currentlyEditingTarget = 'cs'; // 'cs' | 'php'

const loginScreen  = document.getElementById('login-screen');
const formLogin    = document.getElementById('form-login');
const loginError   = document.getElementById('login-error');
const authBar      = document.getElementById('auth-bar');
const authUsername = document.getElementById('auth-username');
const authRole     = document.getElementById('auth-role');
const btnLogout    = document.getElementById('btn-logout');
const pageBilling  = document.getElementById('tab-billing');
const pageAdminDashboard = document.getElementById('tab-admin-dashboard');
const authBalance  = document.getElementById('auth-balance');

function isAdmin() {
    return currentUser && currentUser.role === 'admin';
}

function showLogin(message = '') {
    document.body.classList.add('auth-locked');
    loginScreen.style.display = 'flex';
    authBar.style.display = 'none';
    if (loginError) loginError.textContent = message;
}

function showApp() {
    document.body.classList.remove('auth-locked');
    loginScreen.style.display = 'none';
    authBar.style.display = 'flex';
    authUsername.textContent = currentUser ? currentUser.username : '-';
    authRole.textContent = currentUser ? currentUser.role : '-';
    authBalance.textContent = currentUser && currentUser.balance !== undefined ? parseFloat(currentUser.balance).toFixed(2) : '0.00';
    applyRoleUi();
}

function applyRoleUi() {
    const fastdlNavRow = document.getElementById('btn-nav-fastdl').closest('tr');
    if (fastdlNavRow) fastdlNavRow.style.display = isAdmin() ? '' : 'none';

    const phpRestartBtn = document.getElementById('btn-php-restart');
    if (phpRestartBtn) phpRestartBtn.style.display = isAdmin() ? '' : 'none';

    const createDbForm = document.getElementById('form-mysql-create-db');
    if (createDbForm) createDbForm.style.display = isAdmin() ? '' : 'none';

    const createUserForm = document.getElementById('form-mysql-create-user');
    if (createUserForm) createUserForm.style.display = isAdmin() ? '' : 'none';

    const adminNavRow = document.getElementById('admin-nav-row');
    if (adminNavRow) adminNavRow.style.display = isAdmin() ? '' : 'none';

    const btnDelete = document.getElementById('btn-delete');
    if (btnDelete) btnDelete.style.display = isAdmin() ? '' : 'none';

    if (!isAdmin() && (currentPage === 'fastdl' || currentPage === 'admin-dashboard')) {
        currentPage = 'servers';
    }
}

function setupAuthListeners() {
    // Show/hide toggle bindings
    const btnShowRegister = document.getElementById('btn-show-register');
    const btnShowLogin = document.getElementById('btn-show-login');
    const formRegister = document.getElementById('form-register');

    if (btnShowRegister) {
        btnShowRegister.addEventListener('click', () => {
            formLogin.style.display = 'none';
            if (formRegister) formRegister.style.display = 'block';
            document.getElementById('register-error').textContent = '';
        });
    }

    if (btnShowLogin) {
        btnShowLogin.addEventListener('click', () => {
            if (formRegister) formRegister.style.display = 'none';
            formLogin.style.display = 'block';
            loginError.textContent = '';
        });
    }

    // Login submit
    formLogin.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginError.textContent = '';
        try {
            const res = await nativeFetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: document.getElementById('login-username').value,
                    password: document.getElementById('login-password').value
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                loginError.textContent = data.error || 'Login failed';
                return;
            }
            authToken = data.token || '';
            currentUser = data.user;
            if (data.token) {
                localStorage.setItem('cs_panel_token', data.token);
            } else {
                localStorage.removeItem('cs_panel_token');
            }
            localStorage.setItem('cs_panel_user', JSON.stringify(data.user));
            showApp();
            await loadServers(true);
        } catch (err) {
            loginError.textContent = err.message;
        }
    });

    // Register submit
    if (formRegister) {
        formRegister.addEventListener('submit', async (e) => {
            e.preventDefault();
            const errEl = document.getElementById('register-error');
            errEl.textContent = '';

            const username = document.getElementById('register-username').value.trim();
            const password = document.getElementById('register-password').value;
            const confirmPassword = document.getElementById('register-confirm-password').value;

            if (password !== confirmPassword) {
                errEl.textContent = 'Passwords do not match.';
                return;
            }

            const btn = e.target.querySelector('button[type="submit"]');
            btn.setAttribute('disabled', '');
            btn.textContent = 'Registering...';

            try {
                const res = await nativeFetch('/api/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    errEl.textContent = data.error || 'Registration failed.';
                    return;
                }
                // Automatically log in on successful registration
                authToken = data.token || '';
                currentUser = data.user;
                if (data.token) {
                    localStorage.setItem('cs_panel_token', data.token);
                } else {
                    localStorage.removeItem('cs_panel_token');
                }
                localStorage.setItem('cs_panel_user', JSON.stringify(data.user));
                showApp();
                await loadServers(true);
            } catch (err) {
                errEl.textContent = err.message;
            } finally {
                btn.removeAttribute('disabled');
                btn.textContent = 'Register';
            }
        });
    }

    btnLogout.addEventListener('click', async () => {
        try {
            await nativeFetch('/api/auth/logout', { method: 'POST' });
        } catch (_) { /* local state is still cleared below */ }
        authToken = '';
        currentUser = null;
        activeServerId = null;
        localStorage.removeItem('cs_panel_token');
        localStorage.removeItem('cs_panel_user');
        saveState();
        window.location.href = 'https://example.com/';
    });
}

async function exchangeHandoff() {
    if (!pendingHandoffCode) return true;
    const code = pendingHandoffCode;
    pendingHandoffCode = null;
    try {
        const res = await nativeFetch('/api/auth/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            showLogin(data.error || 'Giriş bağlantısı geçersiz veya süresi dolmuş.');
            return false;
        }
        authToken = data.token;
        currentUser = data.user;
        localStorage.setItem('cs_panel_token', data.token);
        localStorage.setItem('cs_panel_user', JSON.stringify(data.user));
        return true;
    } catch (e) {
        showLogin(e.message);
        return false;
    }
}

async function initAuth() {
    try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (!res.ok || !data.user) {
            authToken = '';
            localStorage.removeItem('cs_panel_token');
            showLogin('');
            return;
        }
        currentUser = data.user;
        showApp();
        await loadServers(true);
    } catch (e) {
        showLogin(e.message);
    }
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    setupAuthListeners();
    exchangeHandoff().then((ok) => {
        if (ok) initAuth();
    });
});

// ========================== SERVER LIST ==========================
async function loadServers(isFirstLoad = false) {
    try {
        const res = await fetch('/api/servers');
        const data = await res.json();
        if (!res.ok || !Array.isArray(data)) {
            throw new Error(data.error || `Server returned ${res.status}`);
        }
        servers = data;
        renderServerList();

        if (activeServerId && currentPage === 'servers') {
            const active = servers.find(s => s.id === activeServerId);
            if (active) {
                if (isFirstLoad) {
                    showPage('servers');
                } else {
                    updateDashboardStats(active);
                }
            } else {
                // Server gone — fall back
                activeServerId = null;
                saveState();
                showPage('servers');
            }
        } else if (currentPage !== 'servers' && isFirstLoad) {
            showPage(currentPage);
        }
    } catch (e) {
        console.error('Error loading servers:', e);
        serverList.innerHTML = `<div style="font-size:12px;color:var(--color-danger);padding:10px 0;">Error: ${e.message}</div>`;
    }
}

function renderServerList() {
    if (servers.length === 0) {
        serverList.innerHTML = `<div style="font-size:12px;color:#666;padding:10px 0;">No servers found.</div>`;
        return;
    }
    serverList.innerHTML = servers.map(s => {
        const isOnline = s.state === 'running' && s.online;
        let dotClass   = 'stopped', textClass = 'state-text-stopped', stateText = 'Stopped';
        if (s.state === 'running') {
            if (s.online) { dotClass = 'online';  textClass = 'state-text-online';  stateText = 'Online'; }
            else           { dotClass = 'offline'; textClass = 'state-text-offline'; stateText = 'Starting...'; }
        }

        const isAvailable = s.owner_id === 1 && s.port !== 27015;
        const itemClass = (s.id === activeServerId && currentPage === 'servers') ? 'active' : '';
        const rentBadge = isAvailable ? `<span class="badge badge-rent" style="background:#28a745; color:#fff; font-size:10px; padding:2px 6px; border-radius:4px; margin-left:8px; font-weight:bold;">Rent</span>` : '';
        const nameText = isAvailable ? `CS 1.6 Server ${s.port}` : s.name;

        return `
            <div class="server-item ${itemClass}" onclick="selectServer('${s.id}')" style="${isAvailable ? 'border-left: 3px solid #28a745;' : ''}">
                <div class="server-item-header">
                    <span>${nameText} ${rentBadge}</span>
                    <span class="server-item-port">${s.port}</span>
                </div>
                <div class="server-item-body">
                    <span>${isAvailable ? 'Available' : (s.map || 'de_dust2')}</span>
                    <span>${isAvailable ? '-' : `${s.players || 0} / ${s.maxPlayers || 32}`}</span>
                </div>
                <div class="server-item-footer">
                    <span><span class="state-dot ${isAvailable ? 'online' : dotClass}"></span><span class="${isAvailable ? 'state-text-online' : textClass}">${isAvailable ? 'Online' : stateText}</span></span>
                    ${!isAvailable && isOnline && s.fps ? `<span style="color:var(--color-primary);font-weight:bold;">${Math.round(s.fps)} FPS</span>` : ''}
                </div>
            </div>`;
    }).join('');
}

// ========================== PAGE ROUTER ==========================
function showPage(page, serverId) {
    // Hide all panels
    noServerSelected.style.display = 'none';
    serverDashboard.style.display  = 'none';
    serverRentPanel.style.display  = 'none';
    pageFastdl.style.display       = 'none';
    pageMysql.style.display        = 'none';
    pagePhp.style.display          = 'none';
    pageBilling.style.display      = 'none';
    pageAdminDashboard.style.display = 'none';

    // Remove active from nav buttons
    document.querySelectorAll('.btn-nav').forEach(b => b.style.fontWeight = 'normal');

    currentPage = page;
    saveState();

    if (page === 'servers') {
        if (serverId) activeServerId = serverId;
        if (!activeServerId) {
            noServerSelected.style.display = 'block';
        } else {
            const server = servers.find(s => s.id === activeServerId);
            if (server) {
                // If unrented (owner_id === 1) and user is not admin, show rent page
                if (server.owner_id === 1 && (!currentUser || currentUser.role !== 'admin')) {
                    serverRentPanel.style.display = 'block';
                    rentServerPort.value = server.port;
                    rentPortDisplay.textContent = server.port;
                    rentServerName.value = `CS 1.6 Server ${server.port}`;
                    rentServerRcon.value = Math.random().toString(36).substring(2, 10);
                } else {
                    serverDashboard.style.display = 'block';
                    updateDashboardStats(server);
                    connectConsoleWebSocket(activeServerId);
                    switchTab(activeTab);
                }
            } else {
                noServerSelected.style.display = 'block';
            }
            if (!statsInterval) {
                statsInterval = setInterval(loadServers, 60000);
            }
        }
        renderServerList();
    } else if (page === 'fastdl') {
        pageFastdl.style.display = 'block';
        document.getElementById('btn-nav-fastdl').style.fontWeight = 'bold';
        loadFastdlStatus();
        if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    } else if (page === 'mysql') {
        pageMysql.style.display = 'block';
        document.getElementById('btn-nav-mysql').style.fontWeight = 'bold';
        loadMysqlPage();
        if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    } else if (page === 'php') {
        pagePhp.style.display = 'block';
        document.getElementById('btn-nav-php').style.fontWeight = 'bold';
        loadPhpPage();
        if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    } else if (page === 'billing') {
        pageBilling.style.display = 'block';
        document.getElementById('btn-nav-billing').style.fontWeight = 'bold';
        loadBillingTab();
        if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    } else if (page === 'admin-dashboard') {
        pageAdminDashboard.style.display = 'block';
        document.getElementById('btn-nav-admin').style.fontWeight = 'bold';
        loadAdminDashboardTab();
        if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    }
}

function selectServer(serverId) {
    if (consoleWs) { consoleWs.close(); consoleWs = null; }
    if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    showPage('servers', serverId);
}

// ========================== DASHBOARD ==========================
function updateDashboardStats(server) {
    dbServerName.textContent = server.name;
    dbServerIp.textContent   = `IP: ${server.ip || 'cs.example.com'}`;
    dbServerPort.textContent = `PORT: ${server.port}`;
    const isOnline = server.state === 'running' && server.online;
    if (server.state === 'running') {
        dbServerStatus.textContent = server.online ? 'Online'       : 'Starting...';
        dbServerStatus.className   = server.online ? 'status-badge status-online' : 'status-badge status-offline';
    } else {
        dbServerStatus.textContent = 'Offline';
        dbServerStatus.className   = 'status-badge status-offline';
    }
    statPlayers.textContent = `${server.players || 0} / ${server.maxPlayers || 32}`;
    statMap.textContent     = server.map || '-';
    statFps.textContent     = isOnline && server.fps ? `${Math.round(server.fps)} FPS` : '0 FPS';
    statCpu.textContent     = isOnline && server.cpu !== undefined ? `${server.cpu.toFixed(1)}%` : '0%';

    // Update package and expiration info
    const planSpan = document.getElementById('db-server-plan');
    const expirySpan = document.getElementById('db-server-expiry');
    const renewBtn = document.getElementById('btn-renew-server');

    if (planSpan && expirySpan && server.plan_type && server.expires_at) {
        const planLabels = {
            'free': 'Deneme (7 Gün)',
            'standard': 'Standard (24 Slot)',
            'pro': 'Pro (32 Slot)'
        };
        planSpan.textContent = planLabels[server.plan_type] || server.plan_type.toUpperCase();
        planSpan.style.background = server.plan_type === 'free' ? '#6c757d' : (server.plan_type === 'pro' ? '#28a745' : '#007bff');

        const expiryDate = new Date(server.expires_at);
        const now = new Date();
        const diffMs = expiryDate - now;
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays <= 0) {
            expirySpan.textContent = `${expiryDate.toLocaleDateString()} (Süresi Doldu - Silinecek)`;
            expirySpan.style.color = 'var(--color-danger)';
        } else {
            expirySpan.textContent = `${expiryDate.toLocaleDateString()} (${diffDays} gün kaldı)`;
            expirySpan.style.color = diffDays <= 3 ? 'var(--color-warning)' : '';
        }

        // Hide renew button for free plans
        if (renewBtn) {
            renewBtn.style.display = server.plan_type === 'free' ? 'none' : 'block';
        }
    }

    if (server.state === 'running') {
        btnStart.setAttribute('disabled', ''); btnStop.removeAttribute('disabled'); btnRestart.removeAttribute('disabled');
    } else {
        btnStart.removeAttribute('disabled'); btnStop.setAttribute('disabled', ''); btnRestart.setAttribute('disabled', '');
    }
}

// ========================== EVENT LISTENERS ==========================
function setupEventListeners() {
    // Tab switching
    document.querySelectorAll('.tab-link').forEach(link => {
        link.addEventListener('click', () => switchTab(link.getAttribute('data-tab')));
    });

    // Power
    btnStart.addEventListener('click',   () => powerAction('start'));
    btnStop.addEventListener('click',    () => powerAction('stop'));
    btnRestart.addEventListener('click', () => powerAction('restart'));
    btnDelete.addEventListener('click',  deleteActiveServer);
    btnReset.addEventListener('click',   resetActiveServer);

    // Create Server modal
    const openCreate  = () => { modalCreateServer.classList.add('open'); formCreateServer.reset(); };
    const closeCreate = () =>  modalCreateServer.classList.remove('open');
    btnCreateServerModal.addEventListener('click',  openCreate);
    btnCreateServerHero.addEventListener('click',   openCreate);
    btnCloseCreateModal.addEventListener('click',   closeCreate);
    btnCancelCreateModal.addEventListener('click',  closeCreate);
    formCreateServer.addEventListener('submit',     createServerSubmit);
    formRentServer.addEventListener('submit',       rentServerSubmit);

    // Console
    document.getElementById('console-input-form').addEventListener('submit', sendConsoleCommandSubmit);

    // File editor
    const closeEditor = () => { modalFileEditor.classList.remove('open'); currentlyEditingTarget = 'cs'; };
    btnCloseEditorModal.addEventListener('click',  closeEditor);
    btnCancelEditorModal.addEventListener('click', closeEditor);
    btnSaveEditorFile.addEventListener('click',    saveEditorFileSubmit);

    // Files tab
    document.getElementById('file-uploader').addEventListener('change',   uploadFileSelected);
    document.getElementById('folder-uploader').addEventListener('change', uploadFolderSelected);
    document.getElementById('btn-upload-cancel').addEventListener('click', cancelOrCloseFileUpload);
    document.getElementById('btn-create-file').addEventListener('click',  createNewFilePrompt);

    // Plugins tab
    document.getElementById('form-plugin-upload').addEventListener('submit', uploadPluginSubmit);
    document.getElementById('btn-compile-plugin').addEventListener('click',  compilePluginSubmit);
    document.getElementById('btn-save-plugin-order').addEventListener('click', savePluginOrderFromDom);

    // Maps tab
    document.getElementById('form-map-upload').addEventListener('submit',  uploadMapSubmit);
    document.getElementById('btn-save-mapcycle').addEventListener('click', saveMapcycleSubmit);

    // Players tab
    document.getElementById('btn-refresh-players').addEventListener('click', () => loadPlayersTab(activeServerId));
    document.getElementById('btn-refresh-leaderboard').addEventListener('click', () => loadLeaderboard(activeServerId));
    document.getElementById('btn-refresh-history').addEventListener('click', () => loadConnectionHistory(activeServerId));

    // Console logs tab
    document.getElementById('btn-refresh-logs').addEventListener('click', () => loadLogsTab(activeServerId));

    // Admins tab
    document.getElementById('form-add-admin').addEventListener('submit', addAdminSubmit);
    document.getElementById('form-add-ban').addEventListener('submit',   addBanSubmit);

    // FastDL tab (per server)
    document.getElementById('btn-fastdl-sync').addEventListener('click',    syncFastdl);
    document.getElementById('btn-fastdl-refresh').addEventListener('click', () => loadFastdlTab(activeServerId));

    // Settings tab
    document.getElementById('form-server-settings').addEventListener('submit', saveSettingsSubmit);
    document.getElementById('btn-settings-config-save').addEventListener('click', saveConfigContentSubmit);

    // Infrastructure nav
    document.getElementById('btn-nav-fastdl').addEventListener('click', () => showPage('fastdl'));
    document.getElementById('btn-nav-mysql').addEventListener('click',  () => showPage('mysql'));
    document.getElementById('btn-nav-php').addEventListener('click',    () => showPage('php'));
    document.getElementById('btn-nav-billing').addEventListener('click', () => showPage('billing'));
    document.getElementById('btn-nav-admin').addEventListener('click',  () => showPage('admin-dashboard'));

    // Admin Subtabs Link navigation
    document.querySelectorAll('.admin-subtab-link').forEach(link => {
        link.addEventListener('click', () => switchAdminSubtab(link.getAttribute('data-subtab')));
    });

    // Admin System Settings forms
    const dynForm = document.getElementById('form-admin-dynamic-settings');
    if (dynForm) dynForm.addEventListener('submit', saveAdminDynamicSettingsSubmit);

    const regForm = document.getElementById('form-register-setting');
    if (regForm) regForm.addEventListener('submit', registerSettingSubmit);

    const regType = document.getElementById('reg-setting-type');
    if (regType) {
        regType.addEventListener('change', () => {
            const row = document.getElementById('reg-setting-options-row');
            if (row) row.style.display = regType.value === 'select' ? 'table-row' : 'none';
        });
    }

    // Create User Modal listeners
    const openCreateUserModal = () => {
        document.getElementById('create-user-username').value = '';
        document.getElementById('create-user-password').value = '';
        document.getElementById('create-user-role').value = 'user';
        document.getElementById('create-user-balance').value = '0.00';
        document.getElementById('modal-create-user').classList.add('open');
    };
    const closeCreateUserModal = () => document.getElementById('modal-create-user').classList.remove('open');
    
    const openCreateUserBtn = document.getElementById('btn-open-create-user-modal');
    if (openCreateUserBtn) openCreateUserBtn.addEventListener('click', openCreateUserModal);
    
    const closeCreateUserBtn = document.getElementById('btn-close-create-user-modal');
    if (closeCreateUserBtn) closeCreateUserBtn.addEventListener('click', closeCreateUserModal);
    
    const cancelCreateUserBtn = document.getElementById('btn-cancel-create-user-modal');
    if (cancelCreateUserBtn) cancelCreateUserBtn.addEventListener('click', closeCreateUserModal);

    const createUserForm = document.getElementById('form-create-user');
    if (createUserForm) createUserForm.addEventListener('submit', saveCreateUserSubmit);

    // Edit User Modal Close listeners
    const closeEditUserModal = () => document.getElementById('modal-edit-user').classList.remove('open');
    document.getElementById('btn-close-edit-user-modal').addEventListener('click', closeEditUserModal);
    document.getElementById('btn-cancel-edit-user-modal').addEventListener('click', closeEditUserModal);
    document.getElementById('form-edit-user').addEventListener('submit', saveEditUserSubmit);

    // Server renewal button
    const renewBtn = document.getElementById('btn-renew-server');
    if (renewBtn) renewBtn.addEventListener('click', () => renewServer(activeServerId));

    // Billing form
    document.getElementById('form-report-payment').addEventListener('submit', reportPaymentSubmit);

    // View Receipt modal close
    const closeReceiptModal = () => document.getElementById('modal-view-receipt').classList.remove('open');
    document.getElementById('btn-close-receipt-modal').addEventListener('click', closeReceiptModal);
    document.getElementById('btn-close-receipt-modal-footer').addEventListener('click', closeReceiptModal);

    // MySQL page
    document.getElementById('btn-mysql-refresh-dbs').addEventListener('click',   loadMysqlDatabases);
    document.getElementById('btn-mysql-refresh-users').addEventListener('click',  loadMysqlUsers);
    document.getElementById('form-mysql-create-db').addEventListener('submit',   mysqlCreateDb);
    document.getElementById('form-mysql-create-user').addEventListener('submit', mysqlCreateUser);
    document.getElementById('btn-mysql-run-query').addEventListener('click',     mysqlRunQuery);
    document.getElementById('btn-mysql-prev').addEventListener('click',          () => loadMysqlTableData(mysqlCurrentDb, mysqlCurrentTable, mysqlCurrentOffset - 100));
    document.getElementById('btn-mysql-next').addEventListener('click',          () => loadMysqlTableData(mysqlCurrentDb, mysqlCurrentTable, mysqlCurrentOffset + 100));

    // PHP page
    document.getElementById('btn-php-restart').addEventListener('click',     phpRestart);
    document.getElementById('btn-php-new-file').addEventListener('click',    phpNewFilePrompt);
    document.getElementById('btn-php-new-folder').addEventListener('click',  phpNewFolderPrompt);
    document.getElementById('btn-php-refresh-files').addEventListener('click', () => loadPhpFiles(phpCurrentPath));
    document.getElementById('btn-php-upload-trigger').addEventListener('click', () => document.getElementById('php-file-uploader').click());
    document.getElementById('btn-php-upload-folder-trigger').addEventListener('click', () => document.getElementById('php-folder-uploader').click());
    document.getElementById('php-file-uploader').addEventListener('change',  phpUploadFileSelected);
    document.getElementById('php-folder-uploader').addEventListener('change', phpUploadFolderSelected);
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-link').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const link = document.querySelector(`.tab-link[data-tab="${tabId}"]`);
    if (link) link.classList.add('active');
    const content = document.getElementById(tabId);
    if (content) content.classList.add('active');
    activeTab = tabId;
    saveState();
    loadTabContent(tabId);
}

// ========================== TAB ROUTER ==========================
function loadTabContent(tabId) {
    if (!activeServerId) return;
    switch (tabId) {
        case 'tab-console': break;
        case 'tab-logs':    loadLogsTab(activeServerId); break;
        case 'tab-files':   loadFilesTab(activeServerId, currentFilePath); break;
        case 'tab-plugins': loadPluginsTab(activeServerId); break;
        case 'tab-maps':    loadMapsTab(activeServerId); break;
        case 'tab-players': loadPlayersTab(activeServerId); break;
        case 'tab-admins':  loadAdminsTab(activeServerId); break;
        case 'tab-fastdl':  loadFastdlTab(activeServerId); break;
        case 'tab-settings': loadSettingsTab(activeServerId); break;
    }
}

// ========================== POWER ACTIONS ==========================
async function powerAction(action) {
    if (!activeServerId) return;
    try {
        const res  = await fetch(`/api/servers/${activeServerId}/${action}`, { method: 'POST' });
        const data = await res.json();
        if (data.success) loadServers(); else alert(`Error: ${data.error}`);
    } catch (e) { console.error(e); }
}

async function deleteActiveServer() {
    if (!activeServerId) return;
    if (!confirm('Permanently delete this server and all its files?')) return;
    try {
        const res  = await fetch(`/api/servers/${activeServerId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) { activeServerId = null; saveState(); loadServers(); showPage('servers'); }
        else alert(`Delete error: ${data.error}`);
    } catch (e) { console.error(e); }
}

async function resetActiveServer() {
    if (!activeServerId) return;
    if (!confirm('CLEAN RESET\n\nThis will permanently DELETE all server files (plugins, maps, configs, admins, bans) and reinstall from the base image.\n\nThe server port and RCON password will be kept.\n\nAre you sure?')) return;
    if (!confirm('Last warning: ALL custom files will be lost. Proceed with clean reset?')) return;

    btnReset.setAttribute('disabled', ''); btnReset.textContent = 'Resetting...';
    try {
        const res  = await fetch(`/api/servers/${activeServerId}/reset`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            alert(data.message + '\n\nClean installation is now starting (30-60 sec).');
            if (data.containerId) {
                activeServerId = data.containerId;
                saveState();
            }
            loadServers();
        }
        else alert(`Reset error: ${data.error}`);
    } catch (e) { alert(`Connection error: ${e.message}`); }
    finally { btnReset.removeAttribute('disabled'); btnReset.textContent = 'Clean Reset'; }
}

// ========================== CREATE SERVER ==========================
async function createServerSubmit(e) {
    e.preventDefault();
    const name         = document.getElementById('create-server-name').value;
    const plan         = document.getElementById('create-server-plan').value;
    const rconPassword = document.getElementById('create-server-rcon').value;
    const map          = document.getElementById('create-server-map').value;

    const btn = document.getElementById('btn-submit-create-server');
    btn.setAttribute('disabled', ''); btn.textContent = 'Creating...';

    try {
        const res  = await fetch('/api/servers/create', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, plan, rconPassword, map })
        });
        const data = await res.json();
        if (data.success) {
            modalCreateServer.classList.remove('open');
            servers.push({ id: data.containerId, name, port: data.port, state: 'running', online: false });
            if (data.sql || data.php || data.fastdl) {
                const lines = [`Server created on port ${data.port}`];
                if (data.sql) lines.push(`SQL: ${data.sql.host}:${data.sql.port} / ${data.sql.database} / ${data.sql.username} / ${data.sql.password}`);
                if (data.php) lines.push(`PHP: ${data.php.url}`);
                if (data.fastdl) lines.push(`FastDL: ${data.fastdl.url}`);
                alert(lines.join('\n'));
            }
            // Update balance after server purchase
            loadUserBalance();
            selectServer(data.containerId);
        } else { alert(`Create error: ${data.error}`); }
    } catch (e) { console.error(e); }
    finally { btn.removeAttribute('disabled'); btn.textContent = 'Create Server'; }
}

async function rentServerSubmit(e) {
    e.preventDefault();
    const port         = rentServerPort.value;
    const name         = rentServerName.value;
    const plan         = rentServerPlan.value;
    const rconPassword = rentServerRcon.value;
    const map          = rentServerMap.value;

    const btn = formRentServer.querySelector('button[type="submit"]');
    const oldText = btn.textContent;
    btn.setAttribute('disabled', ''); btn.textContent = 'Renting...';

    try {
        const res  = await fetch('/api/servers/create', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port, name, plan, rconPassword, map })
        });
        const data = await res.json();
        if (data.success) {
            alert(`Server rented successfully! Port: ${data.port}`);
            // Update balance after server purchase
            loadUserBalance();
            await loadServers();
            selectServer(data.containerId);
        } else {
            alert(`Rental error: ${data.error}`);
        }
    } catch (e) {
        console.error(e);
        alert(`Connection error: ${e.message}`);
    } finally {
        btn.removeAttribute('disabled'); btn.textContent = oldText;
    }
}

// ========================== WEBSOCKET CONSOLE ==========================
function connectConsoleWebSocket(containerId) {
    const consoleBox = document.getElementById('console-output');
    consoleBox.innerHTML = `<div class="console-line system">Connecting to console...</div>`;
    if (consoleWs) { consoleWs.close(); consoleWs = null; }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    consoleWs = new WebSocket(`${protocol}//${window.location.host}?containerId=${encodeURIComponent(containerId)}`);

    consoleWs.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if      (msg.type === 'log')           appendConsoleLine(msg.data);
        else if (msg.type === 'rcon_response') appendConsoleLine(`\n[RCON]\n${msg.data}\n`, 'system');
        else if (msg.type === 'error')         appendConsoleLine(`Error: ${msg.data}`, 'error');
    };
    consoleWs.onclose = () => appendConsoleLine('Console connection lost.', 'error');
    consoleWs.onerror = () => appendConsoleLine('WebSocket error.', 'error');
}

function appendConsoleLine(text, type = '') {
    const box  = document.getElementById('console-output');
    const line = document.createElement('div');
    line.className   = `console-line ${type}`;
    line.textContent = text;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
}

function sendConsoleCommandSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('console-input');
    const cmd   = input.value.trim();
    if (!cmd) return;
    if (consoleWs && consoleWs.readyState === WebSocket.OPEN) {
        appendConsoleLine(`> ${cmd}`, 'command');
        consoleWs.send(JSON.stringify({ type: 'command', data: cmd }));
        input.value = '';
    } else { alert('Console WebSocket is not connected.'); }
}

// ========================== TAB: FILES ==========================
async function loadFilesTab(serverId, relPath) {
    currentFilePath = relPath;
    const tbody = document.querySelector('#files-table tbody');
    tbody.innerHTML = `<tr><td colspan="4" class="loading-spinner">Loading files...</td></tr>`;

    // Breadcrumb
    const bc    = document.getElementById('files-breadcrumb');
    const parts = relPath.split('/').filter(Boolean);
    let cum = '';
    let bcHtml = `<span class="crumb" onclick="loadFilesTab('${serverId}','')">cstrike</span>`;
    parts.forEach(p => { cum += (cum ? '/' : '') + p; bcHtml += `<span class="crumb" onclick="loadFilesTab('${serverId}','${cum}')">${p}</span>`; });
    bc.innerHTML = bcHtml;

    try {
        const res  = await fetch(`/api/files/${serverId}/list?path=${encodeURIComponent(relPath)}`);
        const data = await res.json();
        if (data.error) { tbody.innerHTML = `<tr><td colspan="4" style="color:var(--color-danger);text-align:center;">Error: ${data.error}</td></tr>`; return; }

        let rows = '';
        if (relPath) {
            const parent = relPath.substring(0, relPath.lastIndexOf('/'));
            rows += `<tr style="cursor:pointer;" onclick="loadFilesTab('${serverId}','${parent}')"><td colspan="4">📁 .. (Parent folder)</td></tr>`;
        }
        if (!data.files.length) {
            rows += `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">Folder is empty.</td></tr>`;
        } else {
            data.files.forEach(f => {
                const sizeText    = f.isDir ? '-' : formatBytes(f.size);
                const mtime       = new Date(f.mtime).toLocaleString();
                const editBtn     = (!f.isDir && isEditableFile(f.name)) ? `<button class="btn btn-secondary btn-sm" onclick="openFileEditor('${f.path}','cs')">Edit</button>` : '';
                const downloadBtn = !f.isDir ? `<a href="/api/files/${serverId}/download?file=${encodeURIComponent(f.path)}" class="btn btn-secondary btn-sm" download>DL</a>` : '';
                const deleteBtn   = `<button class="btn btn-danger-outline btn-sm" onclick="deleteFile('${f.path}')">Del</button>`;
                const nameClick   = f.isDir ? `onclick="loadFilesTab('${serverId}','${f.path}')" style="cursor:pointer;"` : '';
                rows += `<tr><td ${nameClick}>${f.isDir ? '📁' : '📄'} ${f.name}</td><td>${sizeText}</td><td>${mtime}</td><td style="white-space:nowrap;">${editBtn} ${downloadBtn} ${deleteBtn}</td></tr>`;
            });
        }
        tbody.innerHTML = rows;
    } catch (e) { tbody.innerHTML = `<tr><td colspan="4" style="color:var(--color-danger);text-align:center;">Connection error.</td></tr>`; }
}

function isEditableFile(filename) {
    const lower = String(filename || '').toLowerCase();
    return ['.cfg','.ini','.txt','.sma','.lst','.rc','.php','.html','.htm','.css','.js','.json','.xml','.md','.env','.yml','.yaml','.sql','.conf','.htaccess']
        .some(ext => lower.endsWith(ext));
}
function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024, sizes = ['B','KB','MB','GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function openFileEditor(filePath, target = 'cs') {
    currentlyEditingFile   = filePath;
    currentlyEditingTarget = target;
    editorFilenameHeader.textContent = `File Editor: ${filePath.split('/').pop()}`;
    fileEditorTextarea.value = 'Loading file...';
    modalFileEditor.classList.add('open');

    try {
        let url;
        if (target === 'php') {
            url = `/api/php/files/view?file=${encodeURIComponent(filePath)}`;
        } else {
            url = `/api/files/${activeServerId}/view?file=${encodeURIComponent(filePath)}`;
        }
        const res  = await fetch(url);
        const data = await res.json();
        fileEditorTextarea.value = data.content !== undefined ? data.content : `Load error: ${data.error}`;
    } catch (e) { fileEditorTextarea.value = 'Error loading file.'; }
}

async function saveEditorFileSubmit() {
    const originalText = btnSaveEditorFile.textContent;
    btnSaveEditorFile.setAttribute('disabled', '');
    btnSaveEditorFile.textContent = 'Saving...';
    const content = fileEditorTextarea.value;
    try {
        let url, body;
        if (currentlyEditingTarget === 'php') {
            url  = '/api/php/files/edit';
            body = JSON.stringify({ file: currentlyEditingFile, content });
        } else {
            url  = `/api/files/${activeServerId}/edit`;
            body = JSON.stringify({ file: currentlyEditingFile, content });
        }
        const res  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        let data;
        try {
            data = await res.json();
        } catch (parseErr) {
            const text = await res.text();
            throw new Error(`Server returned ${res.status}: ${text.slice(0, 200)}`);
        }
        if (data.success) {
            modalFileEditor.classList.remove('open');
            if (currentlyEditingTarget === 'php') loadPhpFiles(phpCurrentPath);
            else loadFilesTab(activeServerId, currentFilePath);
        } else {
            alert(`Save error: ${data.error || 'Unknown error'}`);
        }
    } catch (e) {
        console.error(e);
        alert(`Save failed: ${e.message}`);
    } finally {
        btnSaveEditorFile.removeAttribute('disabled');
        btnSaveEditorFile.textContent = originalText;
    }
}

function formatTransferElapsed(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function setFileUploadButtonsDisabled(disabled) {
    ['btn-upload-file-trigger', 'btn-upload-folder-trigger', 'btn-create-file']
        .forEach(id => { const button = document.getElementById(id); if (button) button.disabled = disabled; });
}

function paintFileTransfer() {
    if (!fileTransferState) return;
    const panel = document.getElementById('file-upload-progress');
    const percent = Math.max(0, Math.min(100, fileTransferState.percent || 0));
    panel.hidden = false;
    panel.className = `transfer-panel ${fileTransferState.mode ? `is-${fileTransferState.mode}` : ''}`.trim();
    document.getElementById('file-upload-status').textContent = fileTransferState.status;
    document.getElementById('file-upload-detail').textContent = fileTransferState.detail;
    document.getElementById('file-upload-bar').style.width = `${percent}%`;
    const rail = panel.querySelector('.transfer-rail');
    rail.setAttribute('aria-valuenow', String(Math.round(percent)));
    document.getElementById('file-upload-percent').textContent = `${Math.round(percent)}%`;
    document.getElementById('file-upload-count').textContent = `${fileTransferState.completedFiles} / ${fileTransferState.totalFiles} dosya`;
    document.getElementById('file-upload-bytes').textContent = `${formatBytes(fileTransferState.transferredBytes)} / ${formatBytes(fileTransferState.totalBytes)}`;
    document.getElementById('file-upload-speed').textContent = fileTransferState.speed > 0 ? `${formatBytes(fileTransferState.speed)}/sn` : '—';
    document.getElementById('file-upload-elapsed').textContent = formatTransferElapsed(Date.now() - fileTransferState.startedAt);
    document.getElementById('file-upload-message').textContent = fileTransferState.message;
    document.getElementById('btn-upload-cancel').textContent = activeFileUploadXhr ? 'İptal' : 'Kapat';
}

function beginFileTransfer(totalFiles, totalBytes, detail) {
    if (fileUploadTimer) clearInterval(fileUploadTimer);
    fileUploadCancelled = false;
    fileTransferState = {
        status: 'Yükleme hazırlanıyor', detail, message: 'Dosyalar batch’lere ayrılıyor.', mode: '',
        totalFiles, completedFiles: 0, totalBytes, transferredBytes: 0, speed: 0, percent: 0,
        startedAt: Date.now()
    };
    setFileUploadButtonsDisabled(true);
    paintFileTransfer();
    fileUploadTimer = setInterval(paintFileTransfer, 500);
}

function updateFileTransfer(patch) {
    if (!fileTransferState) return;
    Object.assign(fileTransferState, patch);
    paintFileTransfer();
}

function finishFileTransfer(mode, status, message) {
    if (fileUploadTimer) clearInterval(fileUploadTimer);
    fileUploadTimer = null;
    activeFileUploadXhr = null;
    setFileUploadButtonsDisabled(false);
    updateFileTransfer({
        mode,
        status,
        message,
        percent: mode === 'success' ? 100 : fileTransferState.percent,
        transferredBytes: mode === 'success' ? fileTransferState.totalBytes : fileTransferState.transferredBytes,
        speed: 0
    });
}

function cancelOrCloseFileUpload() {
    if (activeFileUploadXhr) {
        fileUploadCancelled = true;
        activeFileUploadXhr.abort();
        return;
    }
    document.getElementById('file-upload-progress').hidden = true;
}

function uploadMultipart(url, formData, { onProgress, onUploaded, timeoutMs = 300000 } = {}) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        activeFileUploadXhr = xhr;
        xhr.open('POST', url);
        xhr.timeout = timeoutMs;
        if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
        xhr.upload.onprogress = event => {
            if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total);
        };
        xhr.upload.onload = () => { if (onUploaded) onUploaded(); };
        xhr.onload = () => {
            let data;
            try { data = JSON.parse(xhr.responseText || '{}'); }
            catch (_) { return reject(new Error(`Sunucu geçersiz yanıt verdi (HTTP ${xhr.status}).`)); }
            if (xhr.status === 401) {
                authToken = '';
                localStorage.removeItem('cs_panel_token');
                showLogin('Oturum süreniz doldu. Lütfen yeniden giriş yapın.');
            }
            if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
            reject(new Error(data.error || data.message || `Yükleme HTTP ${xhr.status} ile başarısız oldu.`));
        };
        xhr.onerror = () => reject(new Error('Ağ bağlantısı kesildi. Yüklenen dosyalar korunur; kaldığınız batch’i yeniden deneyin.'));
        xhr.ontimeout = () => reject(new Error(`Bu batch ${Math.round(timeoutMs / 60000)} dakika içinde tamamlanamadı. Daha küçük bir klasör grubu deneyin.`));
        xhr.onabort = () => {
            const error = new Error(fileUploadCancelled ? 'Yükleme kullanıcı tarafından iptal edildi.' : 'Yükleme tarayıcı tarafından durduruldu.');
            error.name = 'UploadCancelledError';
            reject(error);
        };
        xhr.send(formData);
    });
}

function createUploadBatches(files, maxFiles = 24, maxBytes = 64 * 1024 * 1024) {
    const batches = [];
    let batch = [];
    let bytes = 0;
    for (const file of files) {
        if (batch.length && (batch.length >= maxFiles || bytes + file.size > maxBytes)) {
            batches.push(batch);
            batch = [];
            bytes = 0;
        }
        batch.push(file);
        bytes += file.size;
    }
    if (batch.length) batches.push(batch);
    return batches;
}

async function uploadFileSelected(e) {
    const file = e.target.files[0];
    if (!file || activeFileUploadXhr) return;
    beginFileTransfer(1, file.size, file.name);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('path', currentFilePath);
    try {
        const data = await uploadMultipart(`/api/files/${activeServerId}/upload`, formData, {
            onProgress: loaded => {
                const elapsed = Math.max(1, (Date.now() - fileTransferState.startedAt) / 1000);
                updateFileTransfer({
                    mode: '', status: 'Dosya gönderiliyor', message: 'Tarayıcıdan panele aktarılıyor.',
                    transferredBytes: loaded, percent: file.size ? loaded / file.size * 100 : 0, speed: loaded / elapsed
                });
            },
            onUploaded: () => updateFileTransfer({
                mode: 'processing', status: 'Sunucuda işleniyor', detail: file.name,
                message: 'Dosya atomik olarak yazılıyor; gerekiyorsa FastDL güncelleniyor.'
            })
        });
        updateFileTransfer({ completedFiles: 1 });
        finishFileTransfer(data.warning ? 'error' : 'success', data.warning ? 'Dosya yüklendi, FastDL uyarısı var' : 'Dosya yüklendi', data.warning || data.message);
    } catch (error) {
        finishFileTransfer('error', error.name === 'UploadCancelledError' ? 'Yükleme durduruldu' : 'Yükleme başarısız', error.message);
    } finally {
        e.target.value = '';
        loadFilesTab(activeServerId, currentFilePath);
    }
}

async function uploadFolderSelected(e) {
    const files = Array.from(e.target.files);
    if (!files.length || activeFileUploadXhr) return;
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const batches = createUploadBatches(files);
    beginFileTransfer(files.length, totalBytes, `${files.length} dosya · ${batches.length} batch`);
    let completedFiles = 0;
    let completedBytes = 0;
    const warnings = [];
    const errors = [];

    try {
        for (let index = 0; index < batches.length; index++) {
            if (fileUploadCancelled) throw Object.assign(new Error('Yükleme kullanıcı tarafından iptal edildi.'), { name: 'UploadCancelledError' });
            const batch = batches[index];
            const batchBytes = batch.reduce((sum, file) => sum + file.size, 0);
            const formData = new FormData();
            formData.append('basePath', currentFilePath);
            batch.forEach(file => {
                formData.append('files', file);
                formData.append('relativePaths', file.webkitRelativePath || file.name);
            });
            updateFileTransfer({
                mode: '', status: `Batch ${index + 1}/${batches.length} gönderiliyor`,
                detail: `${completedFiles + 1}–${completedFiles + batch.length}. dosyalar`,
                message: `${batch.length} dosya panele aktarılıyor.`
            });
            const data = await uploadMultipart(`/api/files/${activeServerId}/upload-folder`, formData, {
                onProgress: loaded => {
                    const transferred = completedBytes + loaded;
                    const elapsed = Math.max(1, (Date.now() - fileTransferState.startedAt) / 1000);
                    updateFileTransfer({
                        mode: '', transferredBytes: transferred,
                        percent: totalBytes ? transferred / totalBytes * 100 : completedFiles / files.length * 100,
                        speed: transferred / elapsed
                    });
                },
                onUploaded: () => updateFileTransfer({
                    mode: 'processing', status: `Batch ${index + 1}/${batches.length} sunucuda işleniyor`,
                    message: 'Dosyalar tek işlemde atomik yazılıyor ve FastDL varlıkları eşitleniyor.'
                })
            });
            completedFiles += Number.isInteger(data.uploaded) ? data.uploaded : batch.length;
            completedBytes += batchBytes;
            if (Array.isArray(data.errors)) errors.push(...data.errors);
            if (data.warning) warnings.push(data.warning);
            updateFileTransfer({
                completedFiles, transferredBytes: completedBytes,
                percent: totalBytes ? completedBytes / totalBytes * 100 : completedFiles / files.length * 100,
                detail: `${completedFiles}/${files.length} dosya tamamlandı`,
                message: `Batch ${index + 1}/${batches.length} tamamlandı.`
            });
        }

        if (errors.length || warnings.length) {
            const firstProblem = errors[0]?.error || warnings[0] || '';
            finishFileTransfer(errors.length ? 'error' : 'warning', `${completedFiles}/${files.length} dosya yüklendi`,
                `${errors.length} dosya hatası${warnings.length ? `, ${warnings.length} FastDL uyarısı` : ''}.${firstProblem ? ` İlk ayrıntı: ${firstProblem}` : ''}`);
            if (errors.length) console.error('Folder upload file errors:', errors);
            if (warnings.length) console.warn('Folder upload warnings:', warnings);
        } else {
            finishFileTransfer('success', 'Klasör yüklemesi tamamlandı', `${completedFiles} dosya ${formatTransferElapsed(Date.now() - fileTransferState.startedAt)} içinde yazıldı.`);
        }
    } catch (error) {
        finishFileTransfer('error', error.name === 'UploadCancelledError' ? 'Klasör yüklemesi durduruldu' : 'Klasör yüklemesi kesildi',
            `${completedFiles}/${files.length} dosya tamamlandı. ${error.message}`);
    } finally {
        e.target.value = '';
        loadFilesTab(activeServerId, currentFilePath);
    }
}

async function createNewFilePrompt() {
    const name = prompt('New file name (e.g. server.cfg):'); if (!name) return;
    const fullPath = currentFilePath ? `${currentFilePath}/${name}` : name;
    try {
        const res  = await fetch(`/api/files/${activeServerId}/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: fullPath, content: '' }) });
        const data = await res.json();
        if (data.success) openFileEditor(fullPath, 'cs'); else alert(data.error);
    } catch (e) { console.error(e); }
}

async function deleteFile(filePath) {
    if (!confirm(`Delete "${filePath.split('/').pop()}"?`)) return;
    try {
        const res  = await fetch(`/api/files/${activeServerId}?file=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) loadFilesTab(activeServerId, currentFilePath); else alert(data.error);
    } catch (e) { console.error(e); }
}

// ========================== TAB: PLUGINS ==========================
async function loadPluginsTab(serverId) {
    const orderList = document.getElementById('plugin-order-list');
    const smaSelect = document.getElementById('select-sma-files');
    orderList.innerHTML = `<div class="loading-spinner">Loading plugins...</div>`;

    try {
        const res  = await fetch(`/api/plugins/${serverId}`);
        const data = await res.json();
        if (data.offline) { orderList.innerHTML = `<p style="padding:15px;color:var(--text-muted);text-align:center;">Server is offline. Start the server to manage plugins.</p>`; smaSelect.innerHTML = `<option value="">Server offline</option>`; return; }
        if (data.error)   { orderList.innerHTML = `<p style="padding:15px;color:var(--color-danger);">Error: ${data.error}</p>`; return; }

        if (!data.plugins.length) {
            orderList.innerHTML = `<p style="padding:15px;color:var(--text-muted);text-align:center;">No plugins found.</p>`;
        } else {
            let html = `<table width="100%" border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;"><thead><tr style="background:#eee;"><th align="left" style="width:30px;">#</th><th align="left">Plugin</th><th align="left">Status</th><th align="left">In .ini</th><th align="left">Actions</th></tr></thead><tbody>`;
            data.plugins.forEach((p, idx) => {
                html += `<tr id="plugin-row-${idx}" data-filename="${p.filename}">
                    <td style="text-align:center;color:var(--text-muted);">${idx+1}</td>
                    <td style="font-family:var(--font-mono);font-size:13px;">${p.filename}<br><small style="color:var(--text-muted);">${p.description||''}</small></td>
                    <td><strong style="color:${p.enabled?'#28a745':'#dc3545'};">${p.enabled?'Active':'Disabled'}</strong></td>
                    <td>${p.inIni?'Yes':'No'}</td>
                    <td style="white-space:nowrap;">
                        <button class="btn btn-sm" onclick="movePlugin('${p.filename}',-1)">[Up]</button>
                        <button class="btn btn-sm" onclick="movePlugin('${p.filename}',1)">[Dn]</button>
                        <button class="btn btn-sm ${p.enabled?'btn-danger':'btn-success'}" onclick="togglePlugin('${p.filename}',${!p.enabled})">${p.enabled?'Disable':'Enable'}</button>
                    </td></tr>`;
            });
            html += `</tbody></table>`;
            orderList.innerHTML = html;
        }
        smaSelect.innerHTML = `<option value="">Select...</option>` + data.sourceFiles.map(f => `<option value="${f}">${f}</option>`).join('');
    } catch (e) { orderList.innerHTML = `<p style="color:var(--color-danger);padding:15px;">Connection error: ${e.message}</p>`; }
}

async function togglePlugin(filename, enable) {
    try {
        const res  = await fetch(`/api/plugins/${activeServerId}/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename, enable }) });
        const data = await res.json();
        if (data.success) loadPluginsTab(activeServerId); else alert(data.error);
    } catch (e) { console.error(e); }
}

function movePlugin(filename, direction) {
    const rows = Array.from(document.querySelectorAll('#plugin-order-list tr[data-filename]'));
    const index = rows.findIndex(r => r.getAttribute('data-filename') === filename);
    if (index === -1) return;
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    const ordered = rows.map(r => r.getAttribute('data-filename'));
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    saveNewPluginOrder(ordered);
}

function savePluginOrderFromDom() {
    const ordered = Array.from(document.querySelectorAll('#plugin-order-list tr[data-filename]')).map(r => r.getAttribute('data-filename'));
    if (ordered.length) saveNewPluginOrder(ordered);
}

async function saveNewPluginOrder(orderedFilenames) {
    try {
        const res  = await fetch(`/api/plugins/${activeServerId}/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderedFilenames }) });
        const data = await res.json();
        if (data.success) loadPluginsTab(activeServerId); else alert(data.error);
    } catch (e) { console.error(e); }
}

async function uploadPluginSubmit(e) {
    e.preventDefault();
    const fileInput = document.getElementById('plugin-file-input');
    const addToIni  = document.getElementById('plugin-add-to-ini').checked;
    if (!fileInput.files.length) return;
    const formData = new FormData();
    formData.append('file', fileInput.files[0]); formData.append('addToIni', addToIni);
    const submitButton = e.currentTarget.querySelector('button[type="submit"]');
    const originalText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = 'Uploading...';
    try {
        const res  = await fetch(`/api/plugins/${activeServerId}/upload`, { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) { alert('Plugin uploaded successfully.'); loadPluginsTab(activeServerId); fileInput.value = ''; }
        else alert(data.error);
    } catch (err) {
        alert(`Plugin upload failed: ${err.message}`);
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = originalText;
    }
}

async function compilePluginSubmit() {
    const filename = document.getElementById('select-sma-files').value;
    const addToIni = document.getElementById('compile-add-to-ini').checked;
    if (!filename) { alert('Please select a .sma source file.'); return; }

    const outputBox  = document.querySelector('.compiler-output-box');
    const outputPre  = document.getElementById('compiler-output');
    const btnCompile = document.getElementById('btn-compile-plugin');
    outputBox.style.display = 'block'; outputPre.textContent = 'Compiling...'; outputPre.style.color = '';
    btnCompile.setAttribute('disabled', ''); btnCompile.textContent = 'Compiling...';

    try {
        const res  = await fetch(`/api/plugins/${activeServerId}/compile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename, addToIni }) });
        const data = await res.json();
        outputPre.textContent = data.output || data.error || data.message || 'No output received.';
        outputPre.style.color = data.success ? 'var(--color-success)' : 'var(--color-danger)';
        if (data.success) loadPluginsTab(activeServerId);
    } catch (e) {
        outputPre.textContent = `Connection error: ${e.message}`;
        outputPre.style.color = 'var(--color-danger)';
    }
    finally { btnCompile.removeAttribute('disabled'); btnCompile.textContent = 'Compile Plugin'; }
}

// ========================== TAB: MAPS ==========================
async function loadMapsTab(serverId) {
    const tbody = document.querySelector('#maps-table tbody');
    tbody.innerHTML = `<tr><td colspan="3" class="loading-spinner">Loading maps...</td></tr>`;
    try {
        const res  = await fetch(`/api/maps/${serverId}`);
        const data = await res.json();
        tbody.innerHTML = data.maps.length === 0
            ? `<tr><td colspan="3" style="text-align:center;">No maps found.</td></tr>`
            : data.maps.map(m => `<tr><td style="font-family:var(--font-mono);font-weight:bold;">${m.name}</td><td>${formatBytes(m.size)}</td><td><button class="btn btn-success btn-sm" style="margin-right:5px;" onclick="changeMap('${m.name}')">Change Map</button><button class="btn btn-danger-outline btn-sm" onclick="deleteMap('${m.filename}')">Delete</button></td></tr>`).join('');
        document.getElementById('mapcycle-editor').value = data.mapcycle.join('\n');
    } catch (e) { tbody.innerHTML = `<tr><td colspan="3" style="color:var(--color-danger);text-align:center;">Error loading maps.</td></tr>`; }
}

async function changeMap(mapName) {
    if (!confirm(`Change level/map to "${mapName}"?`)) return;
    try {
        const res = await fetch(`/api/servers/${activeServerId}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ map: mapName })
        });
        const data = await res.json();
        if (data.success) {
            alert('Map change command sent successfully.');
            loadServers();
        } else {
            alert(data.error);
        }
    } catch (e) {
        console.error(e);
        alert('Failed to send map change command.');
    }
}

async function saveMapcycleSubmit() {
    const mapcycle = document.getElementById('mapcycle-editor').value.split('\n').map(m=>m.trim()).filter(Boolean);
    try {
        const res  = await fetch(`/api/maps/${activeServerId}/mapcycle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mapcycle }) });
        const data = await res.json();
        if (data.success) { alert('Map cycle saved.'); loadMapsTab(activeServerId); } else alert(data.error);
    } catch (e) { console.error(e); }
}

async function uploadMapSubmit(e) {
    e.preventDefault();
    const fileInput = document.getElementById('map-file-input');
    const addToCycle = document.getElementById('map-add-to-cycle').checked;
    if (!fileInput.files.length) return;
    const formData = new FormData(); formData.append('file', fileInput.files[0]); formData.append('addToCycle', addToCycle);
    const submitButton = e.currentTarget.querySelector('button[type="submit"]');
    const originalText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = 'Uploading...';
    try {
        const res  = await fetch(`/api/maps/${activeServerId}/upload`, { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) {
            alert(data.warning ? `Map uploaded, but ${data.warning}` : 'Map uploaded.');
            loadMapsTab(activeServerId);
            fileInput.value = '';
        } else alert(data.error);
    } catch (error) {
        alert(`Map upload failed: ${error.message}`);
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = originalText;
    }
}

async function deleteMap(filename) {
    if (!confirm(`Delete map "${filename}"?`)) return;
    try {
        const res  = await fetch(`/api/maps/${activeServerId}?filename=${encodeURIComponent(filename)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) loadMapsTab(activeServerId); else alert(data.error);
    } catch (e) { console.error(e); }
}

// ========================== TAB: PLAYERS ==========================
async function loadPlayersTab(serverId) {
    const tbody = document.querySelector('#players-table tbody');
    tbody.innerHTML = `<tr><td colspan="5" class="loading-spinner">Querying players...</td></tr>`;
    try {
        const res  = await fetch(`/api/players/${serverId}`);
        const data = await res.json();
        if (data.error || !data.players.length) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">${data.error ? 'Server offline.' : 'No active players.'}</td></tr>`; return;
        }
        tbody.innerHTML = data.players.map(p => `<tr>
            <td style="font-family:var(--font-mono);">${p.index}</td>
            <td style="font-weight:600;">${escapeHtml(p.name)}</td>
            <td style="font-weight:bold;color:var(--color-primary);">${p.frags}</td>
            <td>${p.time}</td>
            <td style="white-space:nowrap;">
                <button class="btn btn-secondary btn-sm" onclick="playerAction('slap','${escapeHtml(p.name)}')">Slap</button>
                <button class="btn btn-secondary btn-sm" onclick="playerAction('slay','${escapeHtml(p.name)}')">Slay</button>
                <button class="btn btn-warning btn-sm"   onclick="playerActionPrompt('kick','${escapeHtml(p.name)}')">Kick</button>
                <button class="btn btn-danger btn-sm"    onclick="playerActionPrompt('ban','${escapeHtml(p.name)}')">Ban</button>
            </td></tr>`).join('');
    } catch (e) { tbody.innerHTML = `<tr><td colspan="5" style="color:var(--color-danger);text-align:center;">Connection error.</td></tr>`; }
    
    // Automatically load SQL Leaderboard as well
    loadLeaderboard(serverId);
    // Automatically load Connection History as well
    loadConnectionHistory(serverId);
}

async function loadLeaderboard(serverId) {
    const table = document.getElementById('leaderboard-table');
    const tbody = table.querySelector('tbody');
    const loading = document.getElementById('leaderboard-loading');
    const info = document.getElementById('leaderboard-info');
    const dbInfoPre = document.getElementById('leaderboard-db-info');

    loading.style.display = 'block';
    table.style.display = 'none';
    info.style.display = 'none';
    dbInfoPre.textContent = '';
    tbody.innerHTML = '';

    try {
        const res = await fetch(`/api/players/${serverId}/stats`);
        const data = await res.json();
        loading.style.display = 'none';

        if (data.success && data.enabled) {
            table.style.display = 'table';
            if (!data.stats || !data.stats.length) {
                tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);">Leaderboard is empty. Real-time stats will appear as players play on the server.</td></tr>`;
            } else {
                tbody.innerHTML = data.stats.map(s => `<tr>
                    <td style="font-family:var(--font-mono);font-weight:bold;">${s.rank}</td>
                    <td style="font-weight:600;">${escapeHtml(s.name)}</td>
                    <td style="font-weight:bold;color:var(--color-success);">${s.kills}</td>
                    <td style="font-weight:bold;color:var(--color-danger);">${s.deaths}</td>
                    <td style="font-family:var(--font-mono);">${s.kd}</td>
                    <td>${s.hs}</td>
                    <td>${s.accuracy} (${s.hits}/${s.shots})</td>
                </tr>`).join('');
            }
        } else {
            // MySQL not configured, or stats table not found
            info.style.display = 'block';
            if (data.dbInfo) {
                const db = data.dbInfo;
                dbInfoPre.textContent = `// Paste this configuration into cstrike/addons/amxmodx/configs/sql.cfg\n` +
                                      `amx_sql_host "${db.host}"\n` +
                                      `amx_sql_user "${db.username}"\n` +
                                      `amx_sql_pass "${db.password}"\n` +
                                      `amx_sql_db "${db.database}"\n` +
                                      `amx_sql_table "csstats"\n` +
                                      `amx_sql_type "mysql"`;
            } else {
                dbInfoPre.textContent = `MySQL database is not active for this server. Enable MySQL under the Infrastructure page to use SQL Stats features.`;
            }
        }
    } catch (err) {
        console.error(err);
        loading.style.display = 'none';
        info.style.display = 'block';
        dbInfoPre.textContent = `Error connecting to stats API: ${err.message}`;
    }
}

async function loadConnectionHistory(serverId) {
    const table = document.getElementById('history-table');
    const tbody = table.querySelector('tbody');
    const loading = document.getElementById('history-loading');
    const info = document.getElementById('history-info');

    loading.style.display = 'block';
    table.style.display = 'none';
    info.style.display = 'none';
    tbody.innerHTML = '';

    try {
        const res = await fetch(`/api/players/${serverId}/history`);
        const data = await res.json();
        loading.style.display = 'none';

        if (data.success && data.enabled && data.history.length > 0) {
            table.style.display = 'table';
            tbody.innerHTML = data.history.map(h => `<tr>
                <td style="font-weight:600;">${escapeHtml(h.name)}</td>
                <td style="font-family:var(--font-mono); font-size:12px;">${escapeHtml(h.steamid)}</td>
                <td style="color:var(--text-muted); font-size:13px;">${h.lastSeen}</td>
            </tr>`).join('');
        } else {
            info.style.display = 'block';
        }
    } catch (err) {
        console.error(err);
        loading.style.display = 'none';
        info.style.display = 'block';
    }
}

let activeLogSubTab = 'console';

function switchLogSubTab(subTab) {
    activeLogSubTab = subTab;
    
    const btnConsole = document.getElementById('btn-log-sub-console');
    const btnCrash = document.getElementById('btn-log-sub-crash');
    const containerConsole = document.getElementById('logs-console-container');
    const containerCrash = document.getElementById('logs-crash-container');
    
    if (subTab === 'console') {
        btnConsole.className = 'btn btn-primary btn-sm sub-tab-link active';
        btnCrash.className = 'btn btn-secondary btn-sm sub-tab-link';
        containerConsole.style.display = 'block';
        containerCrash.style.display = 'none';
        loadLogsTab(activeServerId);
    } else {
        btnConsole.className = 'btn btn-secondary btn-sm sub-tab-link';
        btnCrash.className = 'btn btn-primary btn-sm sub-tab-link active';
        containerConsole.style.display = 'none';
        containerCrash.style.display = 'block';
        loadCrashLogs(activeServerId);
    }
}

async function loadCrashLogs(serverId) {
    const sysPre = document.getElementById('crash-sys-pre');
    const debugPre = document.getElementById('crash-debug-pre');
    const amxxPre = document.getElementById('crash-amxx-pre');
    
    sysPre.textContent = "Loading HLDS engine fatal errors...";
    debugPre.textContent = "Loading core crash dump logs...";
    amxxPre.textContent = "Loading AMX Mod X plugin errors...";
    
    try {
        const res = await fetch(`/api/servers/${serverId}/crash-logs`);
        const data = await res.json();
        
        if (data.success) {
            sysPre.textContent = data.sys_error || "No engine errors recorded in sys_error.log (Healthy).";
            debugPre.textContent = data.debug_log || "No debug logs recorded in debug.log (Healthy).";
            amxxPre.textContent = data.amxx_errors || "No AMXX errors recorded in plugin logs (Healthy).";
        } else {
            const errMsg = `Error loading: ${data.error}`;
            sysPre.textContent = errMsg;
            debugPre.textContent = errMsg;
            amxxPre.textContent = errMsg;
        }
    } catch (err) {
        const errMsg = `Connection error: ${err.message}`;
        sysPre.textContent = errMsg;
        debugPre.textContent = errMsg;
        amxxPre.textContent = errMsg;
    }
}

async function loadLogsTab(serverId) {
    if (activeLogSubTab === 'crash') {
        return loadCrashLogs(serverId);
    }
    const pre = document.getElementById('console-logs-pre');
    pre.textContent = "Fetching console logs...";
    try {
        const res = await fetch(`/api/servers/${serverId}/logs`);
        const data = await res.json();
        if (data.success) {
            pre.textContent = data.logs || "Console is empty.";
            pre.scrollTop = pre.scrollHeight;
        } else {
            pre.textContent = `Error: ${data.error}`;
        }
    } catch (err) {
        pre.textContent = `Connection error: ${err.message}`;
    }
}

async function playerAction(action, name, duration = 0, reason = '') {
    try {
        const res  = await fetch(`/api/players/${activeServerId}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, name, duration, reason }) });
        const data = await res.json();
        if (data.success) loadPlayersTab(activeServerId); else alert(data.error);
    } catch (e) { console.error(e); }
}

function playerActionPrompt(action, name) {
    if (action === 'kick') { const reason = prompt('Kick reason:', 'Kicked'); if (reason===null) return; playerAction('kick', name, 0, reason); }
    else { const dur = prompt('Ban duration in minutes (0=permanent):', '0'); if (dur===null) return; const reason = prompt('Ban reason:', 'Rule violation'); if (reason===null) return; playerAction('ban', name, parseInt(dur)||0, reason); }
}

// ========================== TAB: ADMINS ==========================
async function loadAdminsTab(serverId) {
    const aTbody = document.querySelector('#admins-table tbody');
    const bTbody = document.querySelector('#bans-table tbody');
    aTbody.innerHTML = `<tr><td colspan="5" class="loading-spinner">Loading...</td></tr>`;
    bTbody.innerHTML = `<tr><td colspan="4" class="loading-spinner">Loading...</td></tr>`;
    try {
        const res  = await fetch(`/api/admins/${serverId}`);
        const data = await res.json();
        aTbody.innerHTML = !data.admins.length ? `<tr><td colspan="5" style="text-align:center;">No administrators.</td></tr>` :
            data.admins.map(a => `<tr><td style="font-family:var(--font-mono);font-weight:bold;">${a.auth}</td><td style="font-family:var(--font-mono);color:var(--color-primary);">${a.access}</td><td>${a.flags.includes('ce')?'SteamID':'Nick'}</td><td style="color:var(--text-muted);font-size:12px;">${a.raw.includes(';')?a.raw.split(';').slice(1).join(';'):'-'}</td><td><button class="btn btn-danger-outline btn-sm" onclick="deleteAdmin('${a.auth}')">Del</button></td></tr>`).join('');
        bTbody.innerHTML = !data.bans.length ? `<tr><td colspan="4" style="text-align:center;">No bans.</td></tr>` :
            data.bans.map(b => { const target = b.type==='IP'?b.ip:b.steamId; return `<tr><td style="font-family:var(--font-mono);font-weight:bold;">${target}</td><td>${b.duration==='0'||b.duration==='0.0'?'Permanent':b.duration+' min'}</td><td>${b.type}</td><td><button class="btn btn-secondary btn-sm" onclick="unbanPlayer('${target}',${b.type==='IP'})">Unban</button></td></tr>`; }).join('');
    } catch (e) { aTbody.innerHTML = `<tr><td colspan="5" style="color:var(--color-danger);text-align:center;">Error.</td></tr>`; }
}

async function addAdminSubmit(e) {
    e.preventDefault();
    const auth = document.getElementById('admin-auth').value, password = document.getElementById('admin-password').value,
          access = document.getElementById('admin-access').value, flags = document.getElementById('admin-flags').value,
          comment = document.getElementById('admin-comment').value;
    try {
        const res  = await fetch(`/api/admins/${activeServerId}/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auth, password, access, flags, comment }) });
        const data = await res.json();
        if (data.success) { alert('Administrator saved.'); loadAdminsTab(activeServerId); document.getElementById('form-add-admin').reset(); document.getElementById('admin-access').value = 'abcdefghijklmnopqrstu'; }
        else alert(data.error);
    } catch (e) { console.error(e); }
}

async function deleteAdmin(auth) {
    if (!confirm(`Remove admin "${auth}"?`)) return;
    try { const res = await fetch(`/api/admins/${activeServerId}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auth }) }); const data = await res.json(); if (data.success) loadAdminsTab(activeServerId); else alert(data.error); } catch (e) { console.error(e); }
}

async function addBanSubmit(e) {
    e.preventDefault();
    const target = document.getElementById('ban-target').value, duration = document.getElementById('ban-duration').value, isIp = document.getElementById('ban-is-ip').checked;
    try { const res = await fetch(`/api/admins/${activeServerId}/ban`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, duration, isIp }) }); const data = await res.json(); if (data.success) { alert('Ban added.'); loadAdminsTab(activeServerId); document.getElementById('form-add-ban').reset(); } else alert(data.error); } catch (e) { console.error(e); }
}

async function unbanPlayer(target, isIp) {
    if (!confirm(`Remove ban for "${target}"?`)) return;
    try { const res = await fetch(`/api/admins/${activeServerId}/unban`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, isIp }) }); const data = await res.json(); if (data.success) loadAdminsTab(activeServerId); else alert(data.error); } catch (e) { console.error(e); }
}

// ========================== TAB: FASTDL (per-server) ==========================
async function loadFastdlTab(serverId) {
    const server   = servers.find(s => s.id === serverId);
    const port     = server ? server.port : '?';
    document.getElementById('fastdl-server-port').textContent = port;

    try {
        const res  = await fetch(`/api/fastdl/${port}/downloadurl`);
        const data = await res.json();
        document.getElementById('fastdl-sv-url').textContent = data.sv_downloadurl || '-';
    } catch (e) { document.getElementById('fastdl-sv-url').textContent = 'Error fetching URL'; }

    const tree = document.getElementById('fastdl-file-tree');
    tree.innerHTML = `<div class="loading-spinner">Loading FastDL files...</div>`;

    try {
        const res  = await fetch(`/api/fastdl/${port}/files`);
        const data = await res.json();
        if (!data.files || !data.files.length) { tree.innerHTML = `<p style="color:var(--text-muted);text-align:center;">No FastDL files yet. Use "Sync" to copy server files.</p>`; return; }
        tree.innerHTML = renderFastdlTree(data.files, port);
    } catch (e) { tree.innerHTML = `<p style="color:var(--color-danger);">Error loading FastDL files: ${e.message}</p>`; }
}

function renderFastdlTree(files, port) {
    let html = `<table width="100%" border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;">
        <thead><tr style="background:#eee;"><th align="left">Name</th><th align="left">Size</th><th align="left">Type</th><th align="left">Action</th></tr></thead><tbody>`;
    function addRows(items, indent = 0) {
        items.forEach(f => {
            const pad = '&nbsp;'.repeat(indent * 4);
            html += `<tr>
                <td>${pad}${f.isDir ? '📁' : '📄'} ${f.name}</td>
                <td>${f.isDir ? '-' : formatBytes(f.size)}</td>
                <td style="color:var(--text-muted);">${f.isDir ? 'Folder' : 'File'}</td>
                <td>${!f.isDir ? `<button class="btn btn-danger-outline btn-sm" onclick="deleteFastdlFile('${port}','${f.path}')">Del</button>` : ''}</td>
            </tr>`;
            if (f.children && f.children.length) addRows(f.children, indent + 1);
        });
    }
    addRows(files);
    html += '</tbody></table>';
    return html;
}

async function deleteFastdlFile(port, filePath) {
    if (!confirm(`Delete FastDL file "${filePath}"?`)) return;
    try {
        const res  = await fetch(`/api/fastdl/${port}/file?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) loadFastdlTab(activeServerId); else alert(data.error);
    } catch (e) { console.error(e); }
}

async function syncFastdl() {
    const server = servers.find(s => s.id === activeServerId);
    if (!server) return;

    const btn    = document.getElementById('btn-fastdl-sync');
    const logBox = document.getElementById('fastdl-sync-log');
    const logPre = document.getElementById('fastdl-sync-output');

    btn.setAttribute('disabled', ''); btn.textContent = 'Syncing...';
    logBox.style.display = 'block'; logPre.textContent = 'Starting full sync (maps, models, sounds, sprites, gfx)...';

    try {
        const res  = await fetch(`/api/fastdl/${server.port}/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const data = await res.json();
        logPre.textContent = data.log ? data.log.join('\n') : (data.message || JSON.stringify(data));
        if (data.success) { alert(data.message); loadFastdlTab(activeServerId); }
        else alert(`Sync error: ${data.error}`);
    } catch (e) { logPre.textContent = `Error: ${e.message}`; }
    finally { btn.removeAttribute('disabled'); btn.textContent = 'Sync Maps/Models/Sounds'; }
}

// ========================== TAB: SETTINGS ==========================
let currentlyEditingConfigPath = '';

async function loadSettingsTab(serverId) {
    const server = servers.find(s => s.id === serverId); if (!server) return;
    document.getElementById('settings-maxplayers').value = server.maxPlayers || 32;

    // Reset quick editor
    currentlyEditingConfigPath = '';
    document.getElementById('settings-config-filepath').textContent = 'Select a file from the left menu';
    document.getElementById('settings-config-textarea').value = '';
    document.getElementById('settings-config-textarea').setAttribute('disabled', '');
    document.getElementById('btn-settings-config-save').setAttribute('disabled', '');

    loadConfigsList(serverId);

    try {
        const res  = await fetch(`/api/servers/${serverId}/settings`);
        const data = await res.json();
        if (data.success && data.settings) {
            const cfg = data.settings;
            document.getElementById('settings-name').value       = cfg.name || '';
            document.getElementById('settings-rcon').value       = cfg.rconPassword || '';
            document.getElementById('settings-password').value   = cfg.sv_password || '';
            document.getElementById('settings-fps').value        = cfg.fpsLimit || '1000';
            document.getElementById('settings-timelimit').value  = cfg.mp_timelimit || '20';
            document.getElementById('settings-roundtime').value  = cfg.mp_roundtime || '2.5';
            document.getElementById('settings-freezetime').value = cfg.mp_freezetime || '1';
            document.getElementById('settings-friendlyfire').value = cfg.mp_friendlyfire || '0';
            document.getElementById('settings-c4timer').value     = cfg.mp_c4timer || '35';
            document.getElementById('settings-gravity').value     = cfg.sv_gravity || '800';
            document.getElementById('settings-maxspeed').value    = cfg.sv_maxspeed || '320';
            document.getElementById('settings-pausable').value    = cfg.pausable || '0';
            
            // New settings fields
            document.getElementById('settings-cheats').value            = cfg.sv_cheats || '0';
            document.getElementById('settings-autoteambalance').value   = cfg.mp_autoteambalance || '1';
            document.getElementById('settings-limitteams').value        = cfg.mp_limitteams || '2';
            document.getElementById('settings-startmoney').value        = cfg.mp_startmoney || '800';
            document.getElementById('settings-buytime').value           = cfg.mp_buytime || '1.5';
            document.getElementById('settings-forcechasecam').value     = cfg.mp_forcechasecam || '0';
            document.getElementById('settings-footsteps').value        = cfg.mp_footsteps || '1';
            document.getElementById('settings-flashlight').value       = cfg.mp_flashlight || '0';
            document.getElementById('settings-decalfrequency').value    = cfg.decalfrequency || '60';
            document.getElementById('settings-voiceenable').value       = cfg.sv_voiceenable || '1';
            document.getElementById('settings-alltalk').value          = cfg.sv_alltalk || '0';
            document.getElementById('settings-startup-map').value       = cfg.startupMap || '';
        }
    } catch (e) {
        console.error('Error loading config from container server.cfg:', e);
    }
}

async function saveSettingsSubmit(e) {
    e.preventDefault();
    const name = document.getElementById('settings-name').value;
    const rconPassword = document.getElementById('settings-rcon').value;
    const sv_password = document.getElementById('settings-password').value;
    const fpsLimit = document.getElementById('settings-fps').value;
    const mp_timelimit = document.getElementById('settings-timelimit').value;
    const mp_roundtime = document.getElementById('settings-roundtime').value;
    const mp_freezetime = document.getElementById('settings-freezetime').value;
    const mp_friendlyfire = document.getElementById('settings-friendlyfire').value;
    const mp_c4timer = document.getElementById('settings-c4timer').value;
    const sv_gravity = document.getElementById('settings-gravity').value;
    const sv_maxspeed = document.getElementById('settings-maxspeed').value;
    const pausable = document.getElementById('settings-pausable').value;

    // New settings
    const sv_cheats = document.getElementById('settings-cheats').value;
    const mp_autoteambalance = document.getElementById('settings-autoteambalance').value;
    const mp_limitteams = document.getElementById('settings-limitteams').value;
    const mp_startmoney = document.getElementById('settings-startmoney').value;
    const mp_buytime = document.getElementById('settings-buytime').value;
    const mp_forcechasecam = document.getElementById('settings-forcechasecam').value;
    const mp_footsteps = document.getElementById('settings-footsteps').value;
    const mp_flashlight = document.getElementById('settings-flashlight').value;
    const decalfrequency = document.getElementById('settings-decalfrequency').value;
    const sv_voiceenable = document.getElementById('settings-voiceenable').value;
    const sv_alltalk = document.getElementById('settings-alltalk').value;
    const startupMap = document.getElementById('settings-startup-map').value;

    try {
        const res  = await fetch(`/api/servers/${activeServerId}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name, rconPassword, sv_password, fpsLimit,
                mp_timelimit, mp_roundtime, mp_freezetime,
                mp_friendlyfire, mp_c4timer, sv_gravity, sv_maxspeed, pausable,
                sv_cheats, mp_autoteambalance, mp_limitteams, mp_startmoney,
                mp_buytime, mp_forcechasecam, mp_footsteps, mp_flashlight,
                decalfrequency, sv_voiceenable, sv_alltalk, startupMap
            })
        });
        const data = await res.json();
        if (data.success) { alert('Settings saved and applied successfully.'); loadServers(); } else alert(data.error);
    } catch (e) { console.error(e); }
}

async function loadConfigsList(serverId) {
    const listDiv = document.getElementById('settings-configs-list');
    listDiv.innerHTML = `<div class="loading-spinner">Loading list...</div>`;
    try {
        const res = await fetch(`/api/servers/${serverId}/configs`);
        const data = await res.json();
        if (!data.success || !data.configs || !data.configs.length) {
            listDiv.innerHTML = `<div style="padding:10px; font-size:11px; color:#666;">No config files found.</div>`;
            return;
        }

        listDiv.innerHTML = data.configs.map(filePath => {
            // Priority list names to make them look distinct
            const isPriority = [
                'server.cfg',
                'addons/amxmodx/configs/amxx.cfg',
                'addons/amxmodx/configs/plugins.ini',
                'addons/amxmodx/configs/users.ini',
                'mapcycle.txt',
                'motd.txt'
            ].includes(filePath);

            const displayLabel = filePath.split('/').pop();
            const badge = isPriority ? `<span style="font-size:9px; background:#007bff; color:#fff; padding:1px 4px; border-radius:3px; margin-left:4px; font-weight:normal;">Fav</span>` : '';

            return `
                <div class="config-list-item" style="padding: 8px; border-bottom: 1px solid #eee; cursor: pointer; display: flex; justify-content: space-between; align-items: center;" 
                     data-path="${filePath}" onclick="loadConfigContent('${filePath}', this)">
                    <span style="font-weight: ${isPriority ? 'bold' : 'normal'}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${filePath}">${displayLabel}</span>
                    ${badge}
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error(e);
        listDiv.innerHTML = `<div style="padding:10px; font-size:11px; color:var(--color-danger);">Error loading list.</div>`;
    }
}

async function loadConfigContent(filePath, element) {
    // Styling selected item
    document.querySelectorAll('#settings-configs-list .config-list-item').forEach(el => {
        el.style.background = '';
    });
    if (element) {
        element.style.background = '#e9ecef';
    }

    const textarea = document.getElementById('settings-config-textarea');
    const saveBtn = document.getElementById('btn-settings-config-save');
    const pathSpan = document.getElementById('settings-config-filepath');

    pathSpan.textContent = 'Loading content...';
    textarea.value = 'Loading...';
    textarea.setAttribute('disabled', '');
    saveBtn.setAttribute('disabled', '');

    try {
        const res = await fetch(`/api/files/${activeServerId}/view?file=${encodeURIComponent(filePath)}`);
        const data = await res.json();
        if (res.ok) {
            currentlyEditingConfigPath = filePath;
            pathSpan.textContent = filePath;
            textarea.value = data.content;
            textarea.removeAttribute('disabled');
            saveBtn.removeAttribute('disabled');
            textarea.focus();
        } else {
            pathSpan.textContent = 'Failed to load file';
            textarea.value = data.error || 'Failed to read file.';
        }
    } catch (e) {
        console.error(e);
        pathSpan.textContent = 'Connection error';
        textarea.value = 'Failed to connect to panel API.';
    }
}

async function saveConfigContentSubmit() {
    if (!currentlyEditingConfigPath) return;
    const textarea = document.getElementById('settings-config-textarea');
    const saveBtn = document.getElementById('btn-settings-config-save');
    
    saveBtn.setAttribute('disabled', '');
    saveBtn.textContent = 'Saving...';
    textarea.setAttribute('disabled', '');

    try {
        const res = await fetch(`/api/files/${activeServerId}/edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file: currentlyEditingConfigPath,
                content: textarea.value
            })
        });
        const data = await res.json();
        if (data.success) {
            alert(`File "${currentlyEditingConfigPath}" saved successfully!`);
        } else {
            alert(`Error saving file: ${data.error}`);
        }
    } catch (e) {
        console.error(e);
        alert('Connection error occurred while saving file.');
    } finally {
        saveBtn.removeAttribute('disabled');
        saveBtn.textContent = 'Save File';
        textarea.removeAttribute('disabled');
    }
}

// ========================== FASTDL GLOBAL PAGE ==========================
async function loadFastdlStatus() {
    try {
        const res  = await fetch('/api/fastdl/status');
        const data = await res.json();
        document.getElementById('fst-status').textContent = data.available ? '✔ Online' : '✘ Unavailable';
        const urlEl = document.getElementById('fst-url');
        urlEl.textContent = data.fastdlUrl; urlEl.href = data.fastdlUrl;
        document.getElementById('fst-path').textContent = data.fastdlPath;
    } catch (e) { document.getElementById('fst-status').textContent = 'Error: ' + e.message; }
}

// ========================== MYSQL PAGE ==========================
async function loadMysqlPage() {
    await Promise.all([loadMysqlStatus(), loadMysqlResources(), loadMysqlDatabases(), loadMysqlUsers()]);
}

async function loadMysqlStatus() {
    try {
        const res  = await fetch('/api/mysql/status');
        const data = await res.json();
        document.getElementById('mst-status').innerHTML  = data.online ? '<strong style="color:#28a745;">Online</strong>' : `<strong style="color:#dc3545;">Offline</strong> — ${data.error}`;
        document.getElementById('mst-version').textContent = data.version || '-';
        document.getElementById('mst-host').textContent  = data.host ? `${data.host}:${data.port}` : '-';
    } catch (e) { document.getElementById('mst-status').textContent = 'Error: ' + e.message; }
}

async function loadMysqlDatabases() {
    const tbody = document.querySelector('#mysql-db-table tbody');
    tbody.innerHTML = `<tr><td colspan="3" class="loading-spinner">Loading...</td></tr>`;
    try {
        const res  = await fetch('/api/mysql/databases');
        const data = await res.json();
        if (data.error) { tbody.innerHTML = `<tr><td colspan="3" style="color:var(--color-danger);">Error: ${data.error}</td></tr>`; return; }
        tbody.innerHTML = data.databases.map(db => {
            const action = isAdmin() && !db.system ? `<button class="btn btn-danger-outline btn-sm" onclick="mysqlDropDb('${db.name}')">Drop</button>` : '-';
            return `<tr><td style="font-family:var(--font-mono);font-weight:bold;cursor:pointer;color:var(--color-primary);text-decoration:underline;" onclick="loadMysqlTables('${db.name}')">${db.name}</td><td>${db.system ? 'System' : 'User'}</td><td>${action}</td></tr>`;
        }).join('') || `<tr><td colspan="3" style="text-align:center;color:var(--text-muted);">No databases assigned.</td></tr>`;

        // Populate database selects
        const userDbSel   = document.getElementById('mysql-new-user-db');
        const queryDbSel  = document.getElementById('mysql-query-db');
        const userDbs     = data.databases.filter(d => !d.system);
        const opts        = `<option value="">No database</option>` + userDbs.map(d => `<option value="${d.name}">${d.name}</option>`).join('');
        userDbSel.innerHTML  = opts;
        queryDbSel.innerHTML = opts;
    } catch (e) { tbody.innerHTML = `<tr><td colspan="3" style="color:var(--color-danger);">Connection error.</td></tr>`; }
}

async function loadMysqlResources() {
    const tbody = document.querySelector('#mysql-resource-table tbody');
    tbody.innerHTML = `<tr><td colspan="6" class="loading-spinner">Loading...</td></tr>`;
    try {
        const res = await fetch('/api/mysql/resources');
        const data = await res.json();
        if (data.error) {
            tbody.innerHTML = `<tr><td colspan="6" style="color:var(--color-danger);">Error: ${data.error}</td></tr>`;
            return;
        }
        tbody.innerHTML = data.resources.map(r => `
            <tr>
                <td>${escapeHtml(r.serverName || String(r.port))} (${r.port})</td>
                <td style="font-family:var(--font-mono);">${escapeHtml(r.database)}</td>
                <td style="font-family:var(--font-mono);">${escapeHtml(r.username)}</td>
                <td style="font-family:var(--font-mono);">${escapeHtml(r.password || '')}</td>
                <td>${escapeHtml(r.host)}:${r.mysqlPort}</td>
                <td><button class="btn btn-secondary btn-sm" onclick="mysqlRotateResource('${r.serverId}')">Rotate</button></td>
            </tr>
        `).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">No SQL resources assigned.</td></tr>`;
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6" style="color:var(--color-danger);">Connection error.</td></tr>`;
    }
}

async function loadMysqlUsers() {
    const tbody = document.querySelector('#mysql-users-table tbody');
    tbody.innerHTML = `<tr><td colspan="3" class="loading-spinner">Loading...</td></tr>`;
    try {
        const res  = await fetch('/api/mysql/users');
        const data = await res.json();
        if (data.error) { tbody.innerHTML = `<tr><td colspan="3" style="color:var(--color-danger);">Error: ${data.error}</td></tr>`; return; }
        tbody.innerHTML = data.users.map(u => {
            const action = isAdmin() && u.user !== 'root' ? `<button class="btn btn-danger-outline btn-sm" onclick="mysqlDropUser('${u.user}','${u.host}')">Drop</button>` : '-';
            return `<tr><td style="font-family:var(--font-mono);font-weight:bold;">${u.user}</td><td>${u.host}</td><td>${action}</td></tr>`;
        }).join('') || `<tr><td colspan="3" style="text-align:center;color:var(--text-muted);">No users assigned.</td></tr>`;
    } catch (e) { tbody.innerHTML = `<tr><td colspan="3" style="color:var(--color-danger);">Connection error.</td></tr>`; }
}

async function mysqlRotateResource(serverId) {
    if (!confirm('Rotate this SQL password? Existing applications using the old password must be updated.')) return;
    try {
        const res = await fetch(`/api/mysql/resources/${serverId}/rotate-password`, { method: 'POST' });
        const data = await res.json();
        if (!data.success) { alert(data.error); return; }
        alert(`New SQL password:\n${data.resource.password}`);
        loadMysqlResources();
    } catch (e) { alert('Error: ' + e.message); }
}

async function mysqlCreateDb(e) {
    e.preventDefault();
    const name = document.getElementById('mysql-new-db-name').value;
    try {
        const res  = await fetch('/api/mysql/databases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        const data = await res.json();
        if (data.success) { alert(data.message); document.getElementById('mysql-new-db-name').value = ''; loadMysqlDatabases(); }
        else alert(data.error);
    } catch (e) { alert('Error: ' + e.message); }
}

async function mysqlDropDb(name) {
    if (!confirm(`Drop database "${name}"? This cannot be undone.`)) return;
    try {
        const res  = await fetch(`/api/mysql/databases/${name}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) { alert(data.message); loadMysqlDatabases(); } else alert(data.error);
    } catch (e) { alert('Error: ' + e.message); }
}

async function mysqlCreateUser(e) {
    e.preventDefault();
    const username = document.getElementById('mysql-new-username').value;
    const password = document.getElementById('mysql-new-password').value;
    const database = document.getElementById('mysql-new-user-db').value;
    try {
        const res  = await fetch('/api/mysql/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, database }) });
        const data = await res.json();
        if (data.success) { alert(data.message); document.getElementById('form-mysql-create-user').reset(); loadMysqlUsers(); }
        else alert(data.error);
    } catch (e) { alert('Error: ' + e.message); }
}

async function mysqlDropUser(username, host) {
    if (!confirm(`Drop user "${username}"@"${host}"?`)) return;
    try {
        const res  = await fetch('/api/mysql/users', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, host }) });
        const data = await res.json();
        if (data.success) { alert(data.message); loadMysqlUsers(); } else alert(data.error);
    } catch (e) { alert('Error: ' + e.message); }
}

async function mysqlRunQuery() {
    const sql = document.getElementById('mysql-query-input').value.trim();
    const db  = document.getElementById('mysql-query-db').value;
    const resultDiv = document.getElementById('mysql-query-result');
    if (!sql) { alert('Enter a SQL query.'); return; }

    resultDiv.innerHTML = `<div class="loading-spinner">Running query...</div>`;
    try {
        const res  = await fetch('/api/mysql/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, database: db || null }) });
        const data = await res.json();
        if (data.error) { resultDiv.innerHTML = `<p style="color:var(--color-danger);">${data.error}</p>`; return; }
        if (!data.rows.length) { resultDiv.innerHTML = `<p style="color:var(--text-muted);">Query returned 0 rows.</p>`; return; }

        let table = `<table width="100%" border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;font-size:12px;"><thead><tr style="background:#eee;">`;
        data.columns.forEach(c => { table += `<th align="left">${escapeHtml(c)}</th>`; });
        table += `</tr></thead><tbody>`;
        data.rows.forEach(row => {
            table += `<tr>`;
            data.columns.forEach(c => { table += `<td>${escapeHtml(String(row[c] ?? 'NULL'))}</td>`; });
            table += `</tr>`;
        });
        table += `</tbody></table><small style="color:var(--text-muted);">${data.rows.length} row(s) returned.</small>`;
        resultDiv.innerHTML = table;
    } catch (e) { resultDiv.innerHTML = `<p style="color:var(--color-danger);">Error: ${e.message}</p>`; }
}

async function loadMysqlTables(dbName) {
    mysqlCurrentDb = dbName;
    document.getElementById('mysql-selected-db').textContent = dbName;
    document.getElementById('mysql-tables-panel').style.display = 'block';
    document.getElementById('mysql-data-panel').style.display    = 'none';

    const tbody = document.querySelector('#mysql-tables-table tbody');
    tbody.innerHTML = `<tr><td colspan="4" class="loading-spinner">Loading tables...</td></tr>`;

    try {
        const res  = await fetch(`/api/mysql/databases/${encodeURIComponent(dbName)}/tables`);
        const data = await res.json();
        if (data.error) { tbody.innerHTML = `<tr><td colspan="4" style="color:var(--color-danger);">Error: ${data.error}</td></tr>`; return; }

        if (!data.tables.length) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">No tables found.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.tables.map(t => `
            <tr style="cursor:pointer;" onclick="loadMysqlTableData('${dbName}', '${t.name}', 0)">
                <td style="font-family:var(--font-mono);font-weight:bold;color:var(--color-primary);">${t.name}</td>
                <td>${t.engine || '-'}</td>
                <td>${t.rows || 0}</td>
                <td>${formatBytes(t.size)}</td>
            </tr>
        `).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" style="color:var(--color-danger);">Error: ${e.message}</td></tr>`;
    }
}

async function loadMysqlTableData(dbName, tableName, offset = 0) {
    mysqlCurrentDb = dbName;
    mysqlCurrentTable = tableName;
    mysqlCurrentOffset = Math.max(0, offset);

    document.getElementById('mysql-selected-table').textContent = `${dbName}.${tableName}`;
    document.getElementById('mysql-data-panel').style.display = 'block';

    const wrapper = document.getElementById('mysql-data-table-wrapper');
    wrapper.innerHTML = `<div class="loading-spinner">Loading data...</div>`;

    const prevBtn = document.getElementById('btn-mysql-prev');
    const nextBtn = document.getElementById('btn-mysql-next');
    const pagination = document.getElementById('mysql-pagination');
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    pagination.textContent = '-';

    try {
        const res = await fetch(`/api/mysql/databases/${encodeURIComponent(dbName)}/tables/${encodeURIComponent(tableName)}/data?limit=100&offset=${mysqlCurrentOffset}`);
        const data = await res.json();
        if (data.error) { wrapper.innerHTML = `<p style="color:var(--color-danger);">Error: ${data.error}</p>`; return; }

        if (!data.columns.length) {
            wrapper.innerHTML = `<p style="color:var(--text-muted);">Table has no columns.</p>`;
            return;
        }

        let html = `<table width="100%" border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;font-size:12px;"><thead><tr style="background:#eee;">`;
        data.columns.forEach(c => { html += `<th align="left">${escapeHtml(c)}</th>`; });
        html += `</tr></thead><tbody>`;

        if (!data.rows.length) {
            html += `<tr><td colspan="${data.columns.length}" style="text-align:center;color:var(--text-muted);">No rows.</td></tr>`;
        } else {
            data.rows.forEach(row => {
                html += `<tr>`;
                data.columns.forEach(c => { html += `<td>${escapeHtml(String(row[c] ?? 'NULL'))}</td>`; });
                html += `</tr>`;
            });
        }
        html += `</tbody></table>`;
        wrapper.innerHTML = html;

        const start = data.total ? mysqlCurrentOffset + 1 : 0;
        const end = Math.min(mysqlCurrentOffset + data.rows.length, data.total);
        pagination.textContent = `${start}-${end} of ${data.total}`;

        prevBtn.disabled = mysqlCurrentOffset <= 0;
        nextBtn.disabled = mysqlCurrentOffset + data.rows.length >= data.total;
    } catch (e) {
        wrapper.innerHTML = `<p style="color:var(--color-danger);">Error: ${e.message}</p>`;
    }
}

// ========================== PHP PAGE ==========================
async function loadPhpPage() {
    await phpStatus();
    loadPhpFiles('');
}

async function phpStatus() {
    try {
        const res  = await fetch('/api/php/status');
        const data = await res.json();
        phpRoots = data.roots || [];
        document.getElementById('php-st-status').innerHTML = data.running
            ? '<strong style="color:#28a745;">Running</strong>'
            : `<strong style="color:#dc3545;">Stopped</strong> — ${data.message || ''}`;
        document.getElementById('php-st-url').textContent = data.url || '-';
        document.getElementById('php-st-url').href        = data.url || '#';
        document.getElementById('php-st-path').textContent = data.wwwPath || '-';
    } catch (e) { document.getElementById('php-st-url').textContent = 'Error: ' + e.message; }
}

async function phpRestart() {
    try {
        const res  = await fetch('/api/php/restart', { method: 'POST' });
        const data = await res.json();
        alert(data.success ? 'PHP container restarted.' : data.error);
        phpStatus();
    } catch (e) { alert('Error: ' + e.message); }
}

async function legacyLoadPhpFiles(relPath) {
    phpCurrentPath = relPath;
    const tbody = document.querySelector('#php-files-table tbody');
    tbody.innerHTML = `<tr><td colspan="4" class="loading-spinner">Loading...</td></tr>`;
    const phpAtVirtualRoot = !isAdmin() && !relPath;
    const phpNewBtn = document.getElementById('btn-php-new-file');
    const phpUploadBtn = document.getElementById('btn-php-upload-trigger');
    if (phpNewBtn) phpNewBtn.disabled = phpAtVirtualRoot;
    if (phpUploadBtn) phpUploadBtn.disabled = phpAtVirtualRoot;

    // Breadcrumb
    const bc    = document.getElementById('php-breadcrumb');
    const parts = relPath.split('/').filter(Boolean);
    let cum = '';
    let bcHtml = `<span class="crumb" onclick="loadPhpFiles('')">/</span>`;
    parts.forEach(p => { cum += (cum ? '/' : '') + p; bcHtml += `<span class="crumb" onclick="loadPhpFiles('${cum}')">${p}</span>`; });
    bc.innerHTML = bcHtml;

    try {
        const res  = await fetch(`/api/php/files?path=${encodeURIComponent(relPath)}`);
        const data = await res.json();
        if (data.error) { tbody.innerHTML = `<tr><td colspan="4" style="color:var(--color-danger);">${data.error}</td></tr>`; return; }

        let rows = '';
        if (relPath) {
            const parent = relPath.substring(0, relPath.lastIndexOf('/'));
            rows += `<tr style="cursor:pointer;" onclick="loadPhpFiles('${parent}')"><td colspan="4">📁 .. (Parent)</td></tr>`;
        }
        if (!data.files.length) {
            rows += `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">Empty folder.</td></tr>`;
        } else {
            data.files.forEach(f => {
                const nameClick = f.isDir ? `onclick="loadPhpFiles('${f.path}')" style="cursor:pointer;"` : '';
                const editBtn   = (!f.isDir && isEditableFile(f.name)) ? `<button class="btn btn-secondary btn-sm" onclick="openFileEditor('${f.path}','php')">Edit</button>` : '';
                const openUrl   = phpRoots.length === 1 ? (phpRoots[0].url + (phpCurrentPath ? phpCurrentPath + '/' : '') + f.name) : '';
                const openBtn   = (!f.isDir && openUrl) ? `<a href="${openUrl}" target="_blank" class="btn btn-secondary btn-sm">Open</a>` : '';
                const delBtn    = `<button class="btn btn-danger-outline btn-sm" onclick="phpDeleteFile('${f.path}')">Del</button>`;
                rows += `<tr><td ${nameClick}>${f.isDir?'📁':'📄'} ${f.name}</td><td>${f.isDir?'-':formatBytes(f.size)}</td><td>${new Date(f.mtime).toLocaleString()}</td><td style="white-space:nowrap;">${openBtn} ${editBtn} ${delBtn}</td></tr>`;
            });
        }
        tbody.innerHTML = rows;
    } catch (e) { tbody.innerHTML = `<tr><td colspan="4" style="color:var(--color-danger);">Error: ${e.message}</td></tr>`; }
}

async function loadPhpFiles(relPath) {
    phpCurrentPath = relPath;
    const tbody = document.querySelector('#php-files-table tbody');
    tbody.innerHTML = `<tr><td colspan="4" class="loading-spinner">Loading...</td></tr>`;
    phpSetActionState(!isAdmin() && !relPath);
    renderPhpBreadcrumb(relPath);

    try {
        const res = await fetch(`/api/php/files?path=${encodeURIComponent(relPath)}`);
        const data = await phpReadResponse(res);
        tbody.replaceChildren();

        if (relPath) {
            const parent = relPath.substring(0, relPath.lastIndexOf('/'));
            const row = document.createElement('tr');
            row.className = 'php-parent-row';
            const cell = document.createElement('td');
            cell.colSpan = 4;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'php-file-entry';
            button.innerHTML = '<span class="php-file-glyph">&#128193;</span><span>.. (Parent)</span>';
            button.addEventListener('click', () => loadPhpFiles(parent));
            cell.appendChild(button);
            row.appendChild(cell);
            tbody.appendChild(row);
        }

        if (!data.files.length) {
            const row = document.createElement('tr');
            row.className = 'php-empty-row';
            const cell = document.createElement('td');
            cell.colSpan = 4;
            cell.textContent = 'This folder is empty. Upload a folder or create your first file.';
            row.appendChild(cell);
            tbody.appendChild(row);
        } else {
            data.files.forEach(file => tbody.appendChild(createPhpFileRow(file)));
        }
    } catch (e) {
        tbody.replaceChildren();
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 4;
        cell.style.color = 'var(--color-danger)';
        cell.textContent = `Error: ${e.message}`;
        row.appendChild(cell);
        tbody.appendChild(row);
        phpSetOperationStatus(e.message, 'error');
    }
}

function phpSetActionState(disabled) {
    ['btn-php-upload-trigger', 'btn-php-upload-folder-trigger', 'btn-php-new-file', 'btn-php-new-folder']
        .forEach(id => {
            const button = document.getElementById(id);
            if (button) button.disabled = disabled;
        });
}

function phpSetOperationStatus(message = '', type = '') {
    const status = document.getElementById('php-file-operation-status');
    if (!status) return;
    status.textContent = message;
    status.className = `php-operation-status${type ? ` ${type}` : ''}`;
}

async function phpReadResponse(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
}

function renderPhpBreadcrumb(relPath) {
    const breadcrumb = document.getElementById('php-breadcrumb');
    breadcrumb.replaceChildren();

    const addCrumb = (label, targetPath, root = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'crumb';
        button.textContent = label;
        button.setAttribute('aria-label', root ? 'PHP root directory' : `Open ${label}`);
        button.addEventListener('click', () => loadPhpFiles(targetPath));
        breadcrumb.appendChild(button);
    };

    addCrumb('/var/www/html', '', true);
    let current = '';
    relPath.split('/').filter(Boolean).forEach(part => {
        current += (current ? '/' : '') + part;
        addCrumb(part, current);
    });
}

function makePhpAction(label, className, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
}

function phpPublicUrlFor(file) {
    if (file.isDir || file.name.toLowerCase() !== 'index.php') return '';
    const root = phpRoots.find(item => file.path === `${item.path}/index.php`);
    return root ? root.url : '';
}

function createPhpFileRow(file) {
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    const nameEntry = document.createElement(file.isDir ? 'button' : 'span');
    if (file.isDir) {
        nameEntry.type = 'button';
        nameEntry.addEventListener('click', () => loadPhpFiles(file.path));
    }
    nameEntry.className = 'php-file-entry';
    const glyph = document.createElement('span');
    glyph.className = 'php-file-glyph';
    glyph.textContent = file.isDir ? '\u{1F4C1}' : '\u{1F4C4}';
    const name = document.createElement('span');
    name.textContent = file.name;
    nameEntry.append(glyph, name);
    nameCell.appendChild(nameEntry);

    const sizeCell = document.createElement('td');
    sizeCell.textContent = file.isDir ? '—' : formatBytes(file.size);

    const modifiedCell = document.createElement('td');
    modifiedCell.textContent = new Date(file.mtime).toLocaleString();

    const actionsCell = document.createElement('td');
    actionsCell.className = 'php-file-actions';
    const publicUrl = phpPublicUrlFor(file);
    if (publicUrl) {
        const view = document.createElement('a');
        view.className = 'btn btn-secondary btn-sm';
        view.href = publicUrl;
        view.target = '_blank';
        view.rel = 'noopener';
        view.textContent = 'View';
        actionsCell.appendChild(view);
    }
    if (!file.isDir && isEditableFile(file.name)) {
        actionsCell.appendChild(makePhpAction('Edit', 'btn btn-secondary btn-sm', () => openFileEditor(file.path, 'php')));
    }
    actionsCell.appendChild(makePhpAction('Delete', 'btn btn-danger-outline btn-sm', () => phpDeleteFile(file.path)));

    row.append(nameCell, sizeCell, modifiedCell, actionsCell);
    return row;
}

async function phpNewFilePrompt() {
    const name = prompt('New file name (for example: index.php):'); if (!name) return;
    const fullPath = phpCurrentPath ? `${phpCurrentPath}/${name}` : name;
    const content = name.toLowerCase().endsWith('.php') ? '<?php\n\n' : '';
    phpSetOperationStatus(`Creating ${name}...`);
    try {
        const res = await fetch('/api/php/files/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: fullPath, content })
        });
        await phpReadResponse(res);
        phpSetOperationStatus(`${name} created.`, 'success');
        await loadPhpFiles(phpCurrentPath);
        openFileEditor(fullPath, 'php');
    } catch (e) { phpSetOperationStatus(e.message, 'error'); }
}

async function phpNewFolderPrompt() {
    const name = prompt('New folder name:'); if (!name) return;
    phpSetOperationStatus(`Creating ${name}...`);
    try {
        const res = await fetch('/api/php/files/mkdir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: phpCurrentPath, name })
        });
        await phpReadResponse(res);
        phpSetOperationStatus(`${name} folder created.`, 'success');
        await loadPhpFiles(phpCurrentPath);
    } catch (e) { phpSetOperationStatus(e.message, 'error'); }
}

async function phpUploadFileSelected(e) {
    const file = e.target.files[0]; if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('path', phpCurrentPath);
    phpSetActionState(true);
    phpSetOperationStatus(`Uploading ${file.name}...`);
    try {
        const res = await fetch('/api/php/files/upload', { method: 'POST', body: formData });
        await phpReadResponse(res);
        phpSetOperationStatus(`${file.name} uploaded.`, 'success');
        await loadPhpFiles(phpCurrentPath);
    } catch (err) { phpSetOperationStatus(err.message, 'error'); }
    finally {
        e.target.value = '';
        phpSetActionState(!isAdmin() && !phpCurrentPath);
    }
}

async function phpUploadFolderSelected(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const batchSize = 40;
    let uploaded = 0;
    phpSetActionState(true);
    phpSetOperationStatus(`Uploading folder: 0 / ${files.length} files...`);

    try {
        for (let offset = 0; offset < files.length; offset += batchSize) {
            const batch = files.slice(offset, offset + batchSize);
            const formData = new FormData();
            formData.append('basePath', phpCurrentPath);
            batch.forEach(file => {
                formData.append('files', file);
                formData.append('relativePaths', file.webkitRelativePath || file.name);
            });

            const res = await fetch('/api/php/files/upload-folder', { method: 'POST', body: formData });
            const data = await phpReadResponse(res);
            uploaded += data.uploaded || batch.length;
            phpSetOperationStatus(`Uploading folder: ${uploaded} / ${files.length} files...`);
        }

        phpSetOperationStatus(`Folder uploaded: ${uploaded} files.`, 'success');
        await loadPhpFiles(phpCurrentPath);
    } catch (err) {
        phpSetOperationStatus(`Upload stopped after ${uploaded} files: ${err.message}`, 'error');
    } finally {
        e.target.value = '';
        phpSetActionState(!isAdmin() && !phpCurrentPath);
    }
}

async function phpDeleteFile(filePath) {
    const name = filePath.split('/').pop();
    if (!confirm(`Delete "${name}" and all of its contents?`)) return;
    phpSetOperationStatus(`Deleting ${name}...`);
    try {
        const res = await fetch(`/api/php/files?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
        await phpReadResponse(res);
        phpSetOperationStatus(`${name} deleted.`, 'success');
        await loadPhpFiles(phpCurrentPath);
    } catch (e) { phpSetOperationStatus(e.message, 'error'); }
}

// ========================== UTILS ==========================
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// ========================== BILLING & ADMIN PAYMENTS ==========================
async function loadUserBalance() {
    try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (res.ok && data.user) {
            currentUser = data.user;
            const balanceSpan = document.getElementById('auth-balance');
            if (balanceSpan) {
                balanceSpan.textContent = parseFloat(currentUser.balance || 0).toFixed(2);
            }
        }
    } catch (e) {
        console.error('Error loading user balance:', e);
    }
}

async function renewServer(serverId) {
    if (!serverId) return;
    const server = servers.find(s => s.id === serverId);
    if (!server) return;

    let price = 250;
    if (server.plan_type === 'pro') price = 350;

    if (!confirm(`Süreyi 30 gün uzatmak istediğinize emin misiniz? Bakiyenizden ${price} TL düşülecektir.`)) return;

    try {
        const res = await fetch(`/api/servers/${serverId}/renew`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            alert('Sunucu süresi 30 gün uzatıldı!');
            await loadUserBalance();
            await loadServers();
        } else {
            alert(`Süre uzatma hatası: ${data.error}`);
        }
    } catch (e) {
        alert(`Bağlantı hatası: ${e.message}`);
    }
}

async function reportPaymentSubmit(e) {
    e.preventDefault();
    const senderName = document.getElementById('report-sender-name').value;
    const amount = document.getElementById('report-amount').value;
    const receiptFile = document.getElementById('report-receipt').files[0];

    const formData = new FormData();
    formData.append('senderName', senderName);
    formData.append('amount', amount);
    if (receiptFile) {
        formData.append('receipt', receiptFile);
    }

    const btn = e.target.querySelector('button[type="submit"]');
    btn.setAttribute('disabled', '');
    btn.textContent = 'Submitting...';

    try {
        const res = await fetch('/api/payments/report', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            alert('Ödeme bildirimi başarıyla gönderildi. Admin onayından sonra bakiyeniz güncellenecektir.');
            e.target.reset();
            loadBillingTab();
        } else {
            alert(`Bildirim hatası: ${data.error}`);
        }
    } catch (err) {
        alert(`Bağlantı hatası: ${err.message}`);
    } finally {
        btn.removeAttribute('disabled');
        btn.textContent = 'Submit Report';
    }
}

async function loadBillingTab() {
    // Dynamically load IBAN details first
    try {
        const resIban = await fetch('/api/payments/iban');
        const dataIban = await resIban.json();
        if (dataIban.success && dataIban.iban_details) {
            const ibanSpan = document.getElementById('billing-iban-details');
            if (ibanSpan) {
                ibanSpan.textContent = dataIban.iban_details;
            }
        }
    } catch (err) {
        console.error('Error fetching dynamic IBAN details:', err);
    }

    const tbody = document.querySelector('#billing-history-table tbody');
    tbody.innerHTML = `<tr><td colspan="5" class="loading-spinner">Ödeme geçmişi yükleniyor...</td></tr>`;

    try {
        const res = await fetch('/api/payments/my');
        const data = await res.json();
        if (!data.success || !data.payments || !data.payments.length) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">Henüz bir ödeme bildiriminiz bulunmuyor.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.payments.map(p => {
            const statusColors = {
                'pending': '#ffc107',
                'approved': '#28a745',
                'rejected': '#dc3545'
            };
            const receiptLink = p.receipt_path 
                ? `<a href="#" onclick="viewReceipt('${p.receipt_path}')">Görüntüle</a>` 
                : 'Yok';

            return `<tr>
                <td>${new Date(p.created_at).toLocaleString()}</td>
                <td>${escapeHtml(p.sender_name)}</td>
                <td style="font-weight:bold;">${parseFloat(p.amount).toFixed(2)} TL</td>
                <td>${receiptLink}</td>
                <td style="font-weight:bold; color:${statusColors[p.status] || '#666'};">${p.status.toUpperCase()}</td>
            </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" style="color:var(--color-danger);text-align:center;">Geçmiş yüklenirken hata oluştu.</td></tr>`;
    }
}

async function loadAdminDashboardTab() {
    const tbody = document.querySelector('#admin-payments-table tbody');
    tbody.innerHTML = `<tr><td colspan="6" class="loading-spinner">Bekleyen ödemeler yükleniyor...</td></tr>`;

    try {
        const res = await fetch('/api/payments/admin/pending');
        const data = await res.json();
        if (!data.success || !data.payments || !data.payments.length) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">Bekleyen ödeme doğrulaması bulunmuyor.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.payments.map(p => {
            const receiptLink = p.receipt_path 
                ? `<button class="btn btn-secondary btn-sm" onclick="viewReceipt('${p.receipt_path}')">Dekont Gör</button>` 
                : 'Yüklenmedi';

            return `<tr>
                <td>${new Date(p.created_at).toLocaleString()}</td>
                <td style="font-weight:bold;">${escapeHtml(p.username)}</td>
                <td>${escapeHtml(p.sender_name)}</td>
                <td style="font-weight:bold;color:var(--color-primary);">${parseFloat(p.amount).toFixed(2)} TL</td>
                <td>${receiptLink}</td>
                <td>
                    <button class="btn btn-success btn-sm" onclick="approvePayment(${p.id})">Onayla</button>
                    <button class="btn btn-danger btn-sm" onclick="rejectPayment(${p.id})">Reddet</button>
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6" style="color:var(--color-danger);text-align:center;">Ödemeler listelenirken hata oluştu.</td></tr>`;
    }
}

function viewReceipt(receiptPath) {
    const modal = document.getElementById('modal-view-receipt');
    const img = document.getElementById('receipt-image-preview');
    const pdfLink = document.getElementById('receipt-pdf-link');
    const noFile = document.getElementById('receipt-no-file');

    img.style.display = 'none';
    pdfLink.style.display = 'none';
    noFile.style.display = 'none';

    if (!receiptPath) {
        noFile.style.display = 'block';
    } else if (receiptPath.toLowerCase().endsWith('.pdf')) {
        pdfLink.href = receiptPath;
        pdfLink.style.display = 'inline-block';
    } else {
        img.src = receiptPath;
        img.style.display = 'block';
    }
    modal.classList.add('open');
}

async function approvePayment(paymentId) {
    if (!confirm('Bu ödemeyi onaylamak istiyor musunuz? Kullanıcının bakiyesine yüklenecektir.')) return;
    try {
        const res = await fetch(`/api/payments/admin/${paymentId}/approve`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            alert('Ödeme onaylandı ve bakiye eklendi.');
            await loadAdminDashboardTab();
            await loadUserBalance();
        } else {
            alert(`Hata: ${data.error}`);
        }
    } catch (e) {
        alert(`Bağlantı hatası: ${e.message}`);
    }
}

async function rejectPayment(paymentId) {
    if (!confirm('Bu ödeme bildirimini reddetmek istediğinize emin misiniz?')) return;
    try {
        const res = await fetch(`/api/payments/admin/${paymentId}/reject`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            alert('Ödeme bildirimi reddedildi.');
            await loadAdminDashboardTab();
        } else {
            alert(`Hata: ${data.error}`);
        }
    } catch (e) {
        alert(`Bağlantı hatası: ${e.message}`);
    }
}

// ========================== ADVANCED ADMIN PANEL UI LOGIC ==========================
let activeAdminSubtab = 'admin-subtab-payments';

function switchAdminSubtab(subtabId) {
    document.querySelectorAll('.admin-subtab-link').forEach(link => {
        if (link.getAttribute('data-subtab') === subtabId) {
            link.classList.add('active');
            link.style.fontWeight = 'bold';
        } else {
            link.classList.remove('active');
            link.style.fontWeight = 'normal';
        }
    });

    document.querySelectorAll('.admin-subtab-content').forEach(content => {
        content.style.display = content.id === subtabId ? 'block' : 'none';
    });

    activeAdminSubtab = subtabId;
    loadAdminSubtabContent(subtabId);
}

function loadAdminSubtabContent(subtabId) {
    switch (subtabId) {
        case 'admin-subtab-payments':
            loadAdminPaymentsList();
            break;
        case 'admin-subtab-users':
            loadAdminUsersList();
            break;
        case 'admin-subtab-settings':
            loadAdminSettings();
            break;
    }
}

// Override original loadAdminDashboardTab
async function loadAdminDashboardTab() {
    switchAdminSubtab(activeAdminSubtab);
}

async function loadAdminPaymentsList() {
    const tbody = document.querySelector('#admin-payments-table tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="6" class="loading-spinner">Loading pending transfers...</td></tr>`;

    try {
        const res = await fetch('/api/payments/admin/pending');
        const data = await res.json();
        if (!data.success || !data.payments || !data.payments.length) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">No pending bank transfer notifications.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.payments.map(p => {
            const receiptLink = p.receipt_path 
                ? `<button class="btn btn-secondary btn-sm" onclick="viewReceipt('${p.receipt_path}')">View Receipt</button>` 
                : 'Not Uploaded';

            return `<tr>
                <td>${new Date(p.created_at).toLocaleString()}</td>
                <td style="font-weight:bold;">${escapeHtml(p.username)}</td>
                <td>${escapeHtml(p.sender_name)}</td>
                <td style="font-weight:bold;color:var(--color-primary);">${parseFloat(p.amount).toFixed(2)} TL</td>
                <td>${receiptLink}</td>
                <td>
                    <button class="btn btn-success btn-sm" onclick="approvePayment(${p.id})">Approve</button>
                    <button class="btn btn-danger btn-sm" onclick="rejectPayment(${p.id})">Reject</button>
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6" style="color:var(--color-danger);text-align:center;">Error loading payments.</td></tr>`;
    }
}

async function loadAdminUsersList() {
    const tbody = document.querySelector('#admin-users-table tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="7" class="loading-spinner">Loading users list...</td></tr>`;

    try {
        const res = await fetch('/api/admin/users');
        const data = await res.json();
        if (!data.success || !data.users || !data.users.length) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);">No users found in system.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.users.map(u => {
            const statusText = u.suspended 
                ? `<span class="status-badge status-offline" style="background:#dc3545; color:#fff; border:none; padding:2px 6px;">SUSPENDED</span>`
                : `<span class="status-badge status-online" style="background:#28a745; color:#fff; border:none; padding:2px 6px;">ACTIVE</span>`;

            return `<tr>
                <td>${u.id}</td>
                <td style="font-weight:bold;">${escapeHtml(u.username)}</td>
                <td><span class="role-badge" style="background:${u.role === 'admin' ? '#ffc107; color:#212529;' : '#e2e3e5; color:#383d41;'}">${u.role.toUpperCase()}</span></td>
                <td style="font-weight:bold;color:var(--color-primary);">${parseFloat(u.balance).toFixed(2)} TL</td>
                <td>${statusText}</td>
                <td>${new Date(u.created_at).toLocaleDateString()}</td>
                <td>
                    <button class="btn btn-secondary btn-sm" onclick="editUserPrompt(${u.id}, '${escapeHtml(u.username)}', '${u.role}', ${u.balance}, ${u.suspended})">Edit</button>
                    <button class="btn btn-warning btn-sm" onclick="stopUserServersAdmin(${u.id}, '${escapeHtml(u.username)}')">Stop Servers</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteUserAdmin(${u.id}, '${escapeHtml(u.username)}')">Delete</button>
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" style="color:var(--color-danger);text-align:center;">Error loading user accounts.</td></tr>`;
    }
}

async function saveCreateUserSubmit(e) {
    e.preventDefault();
    const username = document.getElementById('create-user-username').value;
    const password = document.getElementById('create-user-password').value;
    const role = document.getElementById('create-user-role').value;
    const balance = parseFloat(document.getElementById('create-user-balance').value) || 0;

    const btn = e.target.querySelector('button[type="submit"]');
    btn.setAttribute('disabled', '');
    btn.textContent = 'Creating...';

    try {
        const res = await fetch('/api/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, role, balance })
        });
        const data = await res.json();
        if (data.success) {
            alert('User account created successfully!');
            document.getElementById('modal-create-user').classList.remove('open');
            await loadAdminUsersList();
        } else {
            alert(`Creation error: ${data.error}`);
        }
    } catch (err) {
        alert(`Connection error: ${err.message}`);
    } finally {
        btn.removeAttribute('disabled');
        btn.textContent = 'Create';
    }
}

async function stopUserServersAdmin(userId, username) {
    if (!confirm(`Are you sure you want to stop all active game servers for user "${username}"?`)) return;
    try {
        const res = await fetch(`/api/admin/users/${userId}/stop-servers`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            alert(data.message);
        } else {
            alert(`Error: ${data.error}`);
        }
    } catch (e) {
        alert(`Connection error: ${e.message}`);
    }
}

async function loadAdminSettings() {
    const paymentContainer = document.getElementById('dynamic-settings-payment');
    const limitsContainer = document.getElementById('dynamic-settings-limits');
    const customContainer = document.getElementById('dynamic-settings-custom');
    const registryTbody = document.querySelector('#table-settings-registry tbody');

    if (paymentContainer) paymentContainer.innerHTML = '';
    if (limitsContainer) limitsContainer.innerHTML = '';
    if (customContainer) customContainer.innerHTML = '';
    if (registryTbody) registryTbody.innerHTML = '<tr><td colspan="3" class="loading-spinner">Loading...</td></tr>';

    try {
        const res = await fetch('/api/admin/settings');
        const data = await res.json();
        if (!data.success || !data.allSettings) {
            if (registryTbody) registryTbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--color-danger);">Failed to load registry.</td></tr>';
            return;
        }

        const paymentKeys = ['iban_details', 'price_standard', 'price_pro'];
        const limitsKeys = ['global_free_limit', 'max_players_free', 'max_players_standard', 'max_players_pro'];
        let customCount = 0;

        registryTbody.innerHTML = '';

        for (const s of data.allSettings) {
            // Build setting inputs dynamically
            const optList = s.options ? s.options.split(',').map(o => o.trim()) : [];
            let inputHtml = '';
            
            if (s.type === 'textarea') {
                inputHtml = `<textarea name="${s.key}" rows="3" style="width:98%; font-family:inherit; padding:6px; border:1px solid #ccc; border-radius:3px;" required>${escapeHtml(s.value)}</textarea>`;
            } else if (s.type === 'number') {
                inputHtml = `<input type="number" name="${s.key}" value="${escapeHtml(s.value)}" style="width:120px; padding:6px; border:1px solid #ccc; border-radius:3px;" required>`;
            } else if (s.type === 'select') {
                const optionsHtml = optList.map(opt => `<option value="${escapeHtml(opt)}"${opt === s.value ? ' selected' : ''}>${escapeHtml(opt)}</option>`).join('');
                inputHtml = `<select name="${s.key}" style="width:160px; padding:6px; border:1px solid #ccc; border-radius:3px;">${optionsHtml}</select>`;
            } else {
                inputHtml = `<input type="text" name="${s.key}" value="${escapeHtml(s.value)}" style="width:98%; padding:6px; border:1px solid #ccc; border-radius:3px;" required>`;
            }

            const fieldHtml = `
                <div style="display:flex; flex-direction:column; gap:4px; margin-bottom:12px; border-bottom: 1px solid #f0f0f0; padding-bottom: 12px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <label style="font-weight:bold; font-size:13px; color:#333;">${escapeHtml(s.name || s.key)}</label>
                        <span style="font-size:11px; color:#999; font-family:var(--font-mono);">${escapeHtml(s.key)}</span>
                    </div>
                    <div>${inputHtml}</div>
                    ${s.description ? `<small style="color:#666; font-size:11px;">${escapeHtml(s.description)}</small>` : ''}
                </div>
            `;

            // Append to appropriate card container
            if (paymentKeys.includes(s.key)) {
                if (paymentContainer) paymentContainer.insertAdjacentHTML('beforeend', fieldHtml);
            } else if (limitsKeys.includes(s.key)) {
                if (limitsContainer) limitsContainer.insertAdjacentHTML('beforeend', fieldHtml);
            } else {
                customCount++;
                if (customContainer) customContainer.insertAdjacentHTML('beforeend', fieldHtml);
            }

            // Append to registry list
            const isDefault = paymentKeys.includes(s.key) || limitsKeys.includes(s.key);
            const deleteBtn = isDefault 
                ? '<span style="color:#aaa; font-style:italic;">System</span>' 
                : `<button class="btn btn-danger btn-sm" onclick="deleteSettingAdmin('${escapeHtml(s.key)}')">Delete</button>`;
            
            const registryRow = `<tr>
                <td style="font-weight:bold; font-family:var(--font-mono); padding:6px;">${escapeHtml(s.key)}</td>
                <td style="padding:6px; text-transform:uppercase;"><span class="role-badge" style="background:#e9ecef; border:none; padding:2px 5px;">${escapeHtml(s.type)}</span></td>
                <td style="padding:6px;">${deleteBtn}</td>
            </tr>`;
            registryTbody.insertAdjacentHTML('beforeend', registryRow);
        }

        // Show/hide Custom Configurations card based on custom count
        const customCard = document.getElementById('card-dynamic-custom');
        if (customCard) {
            customCard.style.display = customCount > 0 ? 'block' : 'none';
        }
    } catch (e) {
        console.error('Error loading admin settings:', e);
        if (registryTbody) registryTbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--color-danger);">Error loading registry data.</td></tr>';
    }
}

async function saveAdminDynamicSettingsSubmit(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.setAttribute('disabled', '');
    btn.textContent = 'Saving...';

    const formData = new FormData(e.target);
    const payload = {};
    for (const [key, value] of formData.entries()) {
        payload[key] = value;
    }

    try {
        const res = await fetch('/api/admin/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            alert('All system settings updated successfully!');
            await loadAdminSettings();
        } else {
            alert(`Error: ${data.error}`);
        }
    } catch (err) {
        alert(`Connection error: ${err.message}`);
    } finally {
        btn.removeAttribute('disabled');
        btn.textContent = 'Save Settings';
    }
}

async function registerSettingSubmit(e) {
    e.preventDefault();
    const key = document.getElementById('reg-setting-key').value.trim();
    const name = document.getElementById('reg-setting-name').value.trim();
    const type = document.getElementById('reg-setting-type').value;
    const value = document.getElementById('reg-setting-value').value;
    const description = document.getElementById('reg-setting-description').value.trim();
    const options = document.getElementById('reg-setting-options').value.trim();

    const btn = e.target.querySelector('button[type="submit"]');
    btn.setAttribute('disabled', '');
    btn.textContent = 'Registering...';

    try {
        const res = await fetch('/api/admin/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, name, type, value, description, options: options || null })
        });
        const data = await res.json();
        if (data.success) {
            alert('Custom configuration registered successfully!');
            e.target.reset();
            const optionsRow = document.getElementById('reg-setting-options-row');
            if (optionsRow) optionsRow.style.display = 'none';
            await loadAdminSettings();
        } else {
            alert(`Registration error: ${data.error}`);
        }
    } catch (err) {
        alert(`Connection error: ${err.message}`);
    } finally {
        btn.removeAttribute('disabled');
        btn.textContent = 'Register';
    }
}

async function deleteSettingAdmin(key) {
    if (!confirm(`Are you sure you want to delete the configuration "${key}"?\n\nThis will remove the setting permanently from the database.`)) return;
    try {
        const res = await fetch(`/api/admin/settings/${key}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            alert('Setting deleted successfully.');
            await loadAdminSettings();
        } else {
            alert(`Error: ${data.error}`);
        }
    } catch (e) {
        alert(`Connection error: ${e.message}`);
    }
}

function editUserPrompt(id, username, role, balance, suspended) {
    document.getElementById('edit-user-id').value = id;
    document.getElementById('edit-user-username').value = username;
    document.getElementById('edit-user-role').value = role;
    document.getElementById('edit-user-balance').value = balance;
    document.getElementById('edit-user-suspended').checked = suspended === 1;

    document.getElementById('modal-edit-user').classList.add('open');
}

async function saveEditUserSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('edit-user-id').value;
    const username = document.getElementById('edit-user-username').value;
    const role = document.getElementById('edit-user-role').value;
    const balance = document.getElementById('edit-user-balance').value;
    const suspended = document.getElementById('edit-user-suspended').checked;

    const btn = e.target.querySelector('button[type="submit"]');
    btn.setAttribute('disabled', '');
    btn.textContent = 'Updating...';

    try {
        const res = await fetch(`/api/admin/users/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, role, balance, suspended })
        });
        const data = await res.json();
        if (data.success) {
            alert('User profile updated successfully!');
            document.getElementById('modal-edit-user').classList.remove('open');
            await loadAdminUsersList();
            await loadUserBalance();
        } else {
            alert(`Update error: ${data.error}`);
        }
    } catch (err) {
        alert(`Connection error: ${err.message}`);
    } finally {
        btn.removeAttribute('disabled');
        btn.textContent = 'Update';
    }
}

async function deleteUserAdmin(userId, username) {
    if (!confirm(`Are you sure you want to permanently delete user "${username}"?\n\nWARNING: All CS 1.6 servers, databases, files, and resources associated with this user will be PERMANENTLY REMOVED!`)) return;
    try {
        const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            alert('User and all associated resources deleted successfully.');
            await loadAdminUsersList();
        } else {
            alert(`Error: ${data.error}`);
        }
    } catch (e) {
        alert(`Connection error: ${e.message}`);
    }
}

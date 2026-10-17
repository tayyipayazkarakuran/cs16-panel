import {
    state, api, h, clear, icon, btn, linkBtn, emit, on, toast, toastError, dropdown, menuItem, menuSep, parseRoute, navigate,
    fmtMoney, fmtRelative, serverStatus, loading, errorBox, emptyState
} from './core.js';
import { renderAuth } from './views/auth.js';

const app = document.getElementById('app');
const SERVER_POLL_MS = 30000;

let contentEl = null;
let titleEl = null;
let cleanups = [];
let serverPollTimer = null;
let summaryPollTimer = null;
let serverFilter = '';

// ---------------------------------------------------------------------------
//  Data loading
// ---------------------------------------------------------------------------

/** Load the server list; concurrent callers share one in-flight request. */
export function loadServers() {
    if (state.serversLoadPromise) return state.serversLoadPromise;
    state.serversLoadPromise = api('/api/servers')
        .then(list => {
            state.servers = Array.isArray(list) ? list : [];
            emit('servers-updated', state.servers);
            return state.servers;
        })
        .finally(() => { state.serversLoadPromise = null; });
    return state.serversLoadPromise;
}

export async function loadSummary() {
    state.summary = await api('/api/account/summary');
    state.user = state.summary.user;
    emit('summary-updated', state.summary);
    return state.summary;
}

function startServerPolling() {
    stopServerPolling();
    serverPollTimer = setInterval(() => loadServers().catch(() => {}), SERVER_POLL_MS);
    summaryPollTimer = setInterval(() => loadSummary().catch(() => {}), 60000);
}

function stopServerPolling() {
    if (serverPollTimer) clearInterval(serverPollTimer);
    if (summaryPollTimer) clearInterval(summaryPollTimer);
    serverPollTimer = null;
    summaryPollTimer = null;
}

document.addEventListener('visibilitychange', () => {
    if (!state.user) return;
    if (document.hidden) stopServerPolling();
    else {
        loadServers().catch(() => {});
        loadSummary().catch(() => {});
        startServerPolling();
    }
});

// ---------------------------------------------------------------------------
//  Shell
// ---------------------------------------------------------------------------

function isAdmin() {
    return state.user && state.user.role === 'admin';
}

function navLink(path, label, iconName, { count = 0, meta = null } = {}) {
    return h('a', { class: 'nav-item', href: `#${path}`, dataset: { path } },
        icon(iconName), h('span', { class: 'label' }, label),
        meta ? h('span', { class: 'meta' }, meta) : null,
        count ? h('span', { class: 'count-pill' }, String(count)) : null);
}

function renderServerNav(container) {
    const term = serverFilter.trim().toLowerCase();
    // Unrented pool slots live in the admin "Tüm Sunucular" table, not here.
    const servers = state.servers
        .filter(s => !s.is_pool)
        .filter(s => !term || `${s.name} ${s.port} ${s.owner}`.toLowerCase().includes(term));
    clear(container);
    if (!servers.length) {
        container.appendChild(h('div', { class: 'nav-empty' }, term ? 'Eşleşen sunucu yok' : 'Henüz sunucunuz yok'));
        return;
    }
    servers.slice(0, 60).forEach(s => {
        const status = serverStatus(s);
        container.appendChild(h('a', { class: 'nav-item', href: `#/servers/${s.id}`, dataset: { path: `/servers/${s.id}` }, title: `${s.name} (${s.port})` },
            h('span', { class: 'nav-dot', title: status.label }, h('span', { class: `dot dot-${status.key}` })),
            h('span', { class: 'label' }, s.name),
            h('span', { class: 'meta' }, s.online ? `${s.players}/${s.maxPlayers}` : String(s.port))));
    });
}

function renderShell() {
    const serverNav = h('div', { class: 'nav' });
    const pendingCount = h('span');
    const billingCount = h('span');
    const filterInput = h('input', {
        class: 'input', type: 'search', placeholder: 'Sunucu ara…', 'aria-label': 'Sunucu ara',
        value: serverFilter, onInput: e => { serverFilter = e.target.value; renderServerNav(serverNav); markActiveNav(); }
    });

    const adminNav = isAdmin() ? h('div', { class: 'nav' },
        h('div', { class: 'nav-section eyebrow' }, 'Yönetim'),
        navLink('/admin', 'Genel Bakış', 'gauge'),
        navLink('/admin/users', 'Kullanıcılar', 'users'),
        navLink('/admin/servers', 'Tüm Sunucular', 'server'),
        h('a', { class: 'nav-item', href: '#/admin/payments', dataset: { path: '/admin/payments' } }, icon('receipt'), h('span', { class: 'label' }, 'Ödemeler'), pendingCount),
        h('a', { class: 'nav-item', href: '#/admin/refunds', dataset: { path: '/admin/refunds' } }, icon('refresh'), h('span', { class: 'label' }, 'İadeler & Çekimler'), billingCount),
        navLink('/admin/transactions', 'Hesap Hareketleri', 'activity'),
        navLink('/admin/plans', 'Paketler & Kuponlar', 'tag'),
        navLink('/admin/announcements', 'Duyurular', 'megaphone'),
        navLink('/admin/infra', 'Altyapı', 'layers'),
        navLink('/admin/settings', 'Sistem Ayarları', 'settings'),
        navLink('/admin/audit', 'Denetim Kaydı', 'list')) : null;

    const userInitial = (state.user.username || '?').slice(0, 1);
    const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Ana menü' },
        h('div', { class: 'sidebar-head' },
            h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, 'CS'),
                h('span', {}, (state.summary && state.summary.settings.siteName) || 'CS 1.6 Panel', h('small', {}, 'Sunucu Yönetim Paneli'))),
            btn(null, { variant: 'ghost', iconName: 'x', title: 'Menüyü kapat', className: 'sidebar-close', onClick: () => setDrawer(false) })),
        h('nav', { class: 'nav' },
            navLink('/', 'Panelim', 'home'),
            navLink('/rent', 'Sunucu Kirala', 'cart'),
            navLink('/billing', 'Bakiye & Ödemeler', 'wallet'),
            navLink('/account', 'Hesabım', 'user')),
        h('div', { class: 'nav-section eyebrow' }, isAdmin() ? 'Kiralanan Sunucular' : 'Sunucularım',
            h('a', { href: '#/rent', title: 'Yeni sunucu kirala', 'aria-label': 'Yeni sunucu kirala' }, icon('plus', 'icon-sm'))),
        h('div', { class: 'server-nav-filter' }, filterInput),
        serverNav,
        adminNav,
        h('div', { class: 'sidebar-foot' },
            h('div', { class: 'user-chip' },
                h('span', { class: 'avatar' }, userInitial),
                h('div', { class: 'who' }, h('strong', {}, state.user.username), h('span', {}, isAdmin() ? 'Yönetici' : 'Müşteri')),
                btn(null, { variant: 'ghost', size: 'sm', iconName: 'logout', title: 'Çıkış yap', onClick: logout }))));

    titleEl = h('div', { class: 'title' });
    const balanceChip = h('a', { class: 'balance-chip', href: '#/billing', title: 'Bakiye yükle' }, icon('wallet', 'icon-sm'), h('span', { class: 'label' }, 'Bakiye'), h('span', { id: 'balance-value' }, fmtMoney(state.user.balance)));
    const bellBtn = btn(null, { variant: 'ghost', iconName: 'bell', title: 'Bildirimler', className: 'icon-btn' });
    const bell = dropdown(bellBtn, close => buildNotificationPanel(close), { className: 'notif-panel' });
    const userBtn = h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': 'Hesap menüsü', title: 'Hesap menüsü' }, h('span', { class: 'avatar avatar-sm' }, userInitial));
    const userMenu = dropdown(userBtn, close => h('div', {},
        h('div', { class: 'menu-head' }, h('strong', {}, state.user.username), h('div', { class: 'small muted' }, state.user.email || '')),
        menuSep(),
        menuItem('Hesabım', () => { close(); navigate('/account'); }, { iconName: 'user' }),
        menuItem('Bakiye & Ödemeler', () => { close(); navigate('/billing'); }, { iconName: 'wallet' }),
        menuSep(),
        menuItem('Çıkış yap', () => { close(); logout(); }, { iconName: 'logout', danger: true })));

    menuToggle = btn(null, { variant: 'ghost', iconName: 'menu', title: 'Menüyü aç', className: 'menu-toggle', attrs: { 'aria-controls': 'sidebar', 'aria-expanded': 'false' }, onClick: () => setDrawer(!document.body.classList.contains('nav-open')) });
    const topbar = h('header', { class: 'topbar' }, menuToggle, titleEl, balanceChip, bell, userMenu);

    const announcements = h('div', { class: 'stack', id: 'announcements' });
    contentEl = h('main', { class: 'content', id: 'content', tabindex: '-1' });
    clear(app, h('div', { class: 'shell' }, sidebar, h('div', { class: 'main' }, topbar, h('div', { class: 'content banner-zone', id: 'banner-zone' }, announcements), contentEl)));

    const paintBell = () => {
        const unread = state.summary ? state.summary.unreadNotifications : 0;
        bellBtn.querySelectorAll('.badge-count').forEach(e => e.remove());
        if (unread) bellBtn.appendChild(h('span', { class: 'badge-count' }, unread > 9 ? '9+' : String(unread)));
    };
    const paintSummary = () => {
        const value = document.getElementById('balance-value');
        if (value) value.textContent = fmtMoney(state.user.balance);
        paintBell();
        renderAnnouncements(announcements);
    };
    paintSummary();
    renderServerNav(serverNav);
    cleanupsGlobal.forEach(fn => fn());
    cleanupsGlobal = [
        on('servers-updated', () => { renderServerNav(serverNav); markActiveNav(); }),
        on('summary-updated', paintSummary)
    ];
    if (isAdmin()) {
        const paintPending = () => api('/api/payments/admin/list?status=pending&limit=200').then(data => {
            const count = (data.payments || []).length;
            clear(pendingCount, count ? h('span', { class: 'count-pill' }, String(count)) : null);
        }).catch(() => {});
        const paintBilling = () => api('/api/admin/refunds/counts').then(c => {
            const total = (c.refunds || 0) + (c.withdrawals || 0);
            clear(billingCount, total ? h('span', { class: 'count-pill' }, String(total)) : null);
        }).catch(() => {});
        paintPending();
        paintBilling();
        cleanupsGlobal.push(on('payments-changed', paintPending), on('summary-updated', paintPending), on('billing-changed', paintBilling), on('summary-updated', paintBilling));
    }
    // Close the mobile drawer after navigating.
    sidebar.addEventListener('click', e => { if (e.target.closest('a')) setDrawer(false); });
}
let cleanupsGlobal = [];
let menuToggle = null;

/** Mobile navigation drawer: scroll lock, Escape to close, focus moves into it. */
function setDrawer(open) {
    document.body.classList.toggle('nav-open', open);
    document.body.classList.toggle('scroll-locked', open);
    if (menuToggle) menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    const sidebar = document.getElementById('sidebar');
    if (open && sidebar) {
        const first = sidebar.querySelector('.nav-item');
        if (first) setTimeout(() => first.focus(), 50);
    } else if (!open && menuToggle && sidebar && sidebar.contains(document.activeElement)) {
        menuToggle.focus();
    }
}
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('nav-open') && !document.querySelector('.modal-backdrop')) setDrawer(false);
});

function renderAnnouncements(container) {
    clear(container);
    const summary = state.summary;
    if (!summary) return;
    const dismissed = new Set(JSON.parse(sessionStorageGet('dismissed-announcements') || '[]'));
    if (summary.settings.maintenance && isAdmin()) {
        container.appendChild(h('div', { class: 'alert alert-warning' }, icon('alert'), h('div', {}, h('strong', {}, 'Bakım modu açık'), h('p', {}, 'Yönetici olmayan kullanıcılar şu anda panele erişemiyor.')),
            h('div', { class: 'alert-actions' }, linkBtn('Ayarlar', '#/admin/settings', { size: 'sm' }))));
    }
    if (state.user.must_change_password) {
        container.appendChild(h('div', { class: 'alert alert-danger' }, icon('lock'), h('div', {}, h('strong', {}, 'Varsayılan şifre kullanıyorsunuz'), h('p', {}, 'Hesabınızın güvenliği için şifrenizi hemen değiştirin.')),
            h('div', { class: 'alert-actions' }, linkBtn('Şifreyi değiştir', '#/account', { size: 'sm', variant: 'primary' }))));
    }
    (summary.announcements || []).filter(a => !dismissed.has(a.id)).forEach(a => {
        const el = h('div', { class: `alert alert-${a.level || 'info'}` }, icon(a.level === 'danger' || a.level === 'warning' ? 'alert' : 'megaphone'),
            h('div', {}, h('strong', {}, a.title), a.body ? h('p', {}, a.body) : null),
            h('div', { class: 'alert-dismiss' }, btn(null, { variant: 'ghost', size: 'sm', iconName: 'x', title: 'Gizle', onClick: () => {
                dismissed.add(a.id);
                sessionStorageSet('dismissed-announcements', JSON.stringify([...dismissed]));
                el.remove();
            } })));
        container.appendChild(el);
    });
    document.getElementById('banner-zone').hidden = !container.children.length;
}

function sessionStorageGet(key) { try { return sessionStorage.getItem(key); } catch (_) { return null; } }
function sessionStorageSet(key, value) { try { sessionStorage.setItem(key, value); } catch (_) { /* ignore */ } }

function buildNotificationPanel(close) {
    const list = h('div', {}, loading('Bildirimler yükleniyor…'));
    const markAll = btn('Tümünü okundu say', { size: 'xs', variant: 'ghost', onClick: async () => {
        await api('/api/account/notifications/read', { method: 'POST', body: {} }).catch(toastError);
        await loadSummary().catch(() => {});
        close();
    } });
    api('/api/account/notifications?limit=30').then(data => {
        clear(list);
        if (!data.notifications.length) {
            list.appendChild(h('div', { class: 'table-empty' }, 'Bildiriminiz yok.'));
            return;
        }
        data.notifications.forEach(n => {
            const variant = { success: 'online', warning: 'starting', danger: 'offline' }[n.type] || 'suspended';
            list.appendChild(h('button', { class: `notif-item ${n.read_at ? '' : 'unread'}`, type: 'button', onClick: async () => {
                if (!n.read_at) api('/api/account/notifications/read', { method: 'POST', body: { ids: [n.id] } }).then(() => loadSummary()).catch(() => {});
                close();
                if (n.link && n.link.startsWith('#/')) window.location.hash = n.link;
            } },
            h('span', { class: `dot dot-${variant}` }),
            h('div', { class: 'body' }, h('strong', {}, n.title), n.body ? h('p', {}, n.body) : null, h('time', {}, fmtRelative(n.created_at)))));
        });
    }).catch(e => clear(list, h('div', { class: 'table-empty' }, e.message)));
    return h('div', {}, h('div', { class: 'notif-head' }, h('strong', {}, 'Bildirimler'), h('div', { class: 'btn-group' }, markAll, linkBtn('Tümü', '#/account', { size: 'xs', variant: 'ghost', attrs: { onClick: () => close() } }))), list);
}

function markActiveNav() {
    const { path } = parseRoute();
    document.querySelectorAll('.sidebar .nav-item[data-path]').forEach(a => {
        const p = a.dataset.path;
        const active = p === '/' ? path === '/' : (p === '/admin' ? path === '/admin' : path === p || path.startsWith(`${p}/`));
        a.classList.toggle('active', active);
        if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
}

export function setTitle(title, crumbs = []) {
    if (!titleEl) return;
    document.title = `${title} · ${(state.summary && state.summary.settings.siteName) || 'CS 1.6 Panel'}`;
    clear(titleEl, h('nav', { class: 'crumbs', 'aria-label': 'Konum' },
        crumbs.map(c => [h('a', { href: c.href }, c.label), h('span', { class: 'sep', 'aria-hidden': 'true' }, '/')]),
        h('span', { class: 'current', 'aria-current': 'page' }, title)));
}

// ---------------------------------------------------------------------------
//  Routing
// ---------------------------------------------------------------------------

const VIEWS = {
    overview: () => import('./views/overview.js'),
    rent: () => import('./views/rent.js'),
    server: () => import('./views/server.js'),
    billing: () => import('./views/billing.js'),
    account: () => import('./views/account.js'),
    admin: () => import('./views/admin.js')
};

let routeToken = 0;
async function route() {
    const { parts, query } = parseRoute();
    if (parts[0] === 'reset') return renderAuth(app, 'reset', { query, onAuthenticated });
    if (!state.user) {
        const mode = ['register', 'forgot'].includes(parts[0]) ? parts[0] : 'login';
        return renderAuth(app, mode, { query, onAuthenticated });
    }
    if (!contentEl || !document.body.contains(contentEl)) renderShell();
    cleanups.forEach(fn => { try { fn(); } catch (_) { /* ignore */ } });
    cleanups = [];
    markActiveNav();

    const token = ++routeToken;
    let viewName = 'overview';
    let params = {};
    if (parts[0] === 'rent') viewName = 'rent';
    else if (parts[0] === 'servers' && parts[1]) { viewName = 'server'; params = { id: parts[1], tab: parts[2] || 'console' }; }
    else if (parts[0] === 'billing') viewName = 'billing';
    else if (parts[0] === 'account') viewName = 'account';
    else if (parts[0] === 'admin') {
        if (!isAdmin()) return navigate('/');
        viewName = 'admin';
        params = { section: parts[1] || 'overview', sub: parts[2] };
    }

    clear(contentEl, loading());
    try {
        const module = await VIEWS[viewName]();
        if (token !== routeToken) return;
        clear(contentEl);
        await module.render({
            root: contentEl,
            params,
            query,
            setTitle,
            onCleanup: fn => cleanups.push(fn),
            isCurrent: () => token === routeToken
        });
    } catch (error) {
        if (token !== routeToken) return;
        console.error(error);
        clear(contentEl, errorBox(error));
    }
    window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
// Tapping outside the mobile drawer closes it.
document.addEventListener('click', e => {
    if (document.body.classList.contains('nav-open') && !e.target.closest('#sidebar') && !e.target.closest('.menu-toggle')) {
        document.body.classList.remove('nav-open');
    }
});
on('route', route);

// ---------------------------------------------------------------------------
//  Session lifecycle
// ---------------------------------------------------------------------------

async function onAuthenticated(user) {
    state.user = user;
    contentEl = null;
    try {
        await Promise.all([loadSummary(), loadServers().catch(() => [])]);
    } catch (error) {
        toastError(error);
    }
    startServerPolling();
    const { parts } = parseRoute();
    if (['login', 'register', 'forgot', 'reset'].includes(parts[0])) navigate('/');
    else route();
}

async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) { /* clear locally anyway */ }
    endSession();
    navigate('/login');
}

function endSession(message) {
    stopServerPolling();
    state.user = null;
    state.summary = null;
    state.servers = [];
    contentEl = null;
    // Older panel versions kept a bearer token in localStorage; remove it.
    try { localStorage.removeItem('cs_panel_token'); localStorage.removeItem('cs_panel_user'); } catch (_) { /* ignore */ }
    if (message) toast(message, 'warning');
}

on('session-expired', message => {
    if (!state.user) return;
    endSession(typeof message === 'string' ? message : 'Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın.');
    navigate('/login');
});

// Billing errors from any screen get a direct way to fix them.
on('insufficient-balance', error => {
    toast(error.message, 'warning', 9000, { action: { label: 'Bakiye yükle', onClick: () => import('./components/deposit.js').then(m => m.openDepositDialog()) } });
});
on('paywall', () => {
    // The server list carries the suspension; the server page re-routes to its paywall.
    loadServers().catch(() => {});
});

on('maintenance', message => {
    if (state.user && state.user.role !== 'admin') {
        clear(app, h('div', { class: 'auth-panel full-page' },
            h('div', { class: 'auth-card' }, emptyState({ iconName: 'settings', title: 'Bakım çalışması', text: message, action: btn('Tekrar dene', { variant: 'primary', onClick: () => window.location.reload() }) }))));
        stopServerPolling();
    }
});

async function exchangeHandoffCode() {
    // Landing → panel login handoff: /auth/callback#code=...
    if (!window.location.hash.startsWith('#code=')) return;
    const code = new URLSearchParams(window.location.hash.slice(1)).get('code');
    history.replaceState(null, document.title, '/');
    try {
        await api('/api/auth/exchange', { method: 'POST', body: { code } });
    } catch (error) {
        toast(error.message, 'error');
    }
}

async function boot() {
    try { localStorage.removeItem('cs_panel_token'); } catch (_) { /* ignore */ }
    await exchangeHandoffCode();
    try {
        const [config, me] = await Promise.all([api('/api/public/config'), api('/api/auth/me')]);
        state.config = config;
        if (me.user) {
            await onAuthenticated(me.user);
            return;
        }
    } catch (error) {
        clear(app, h('div', { class: 'auth-panel full-page' }, h('div', { class: 'auth-card' }, errorBox(error),
            btn('Tekrar dene', { variant: 'primary', onClick: () => window.location.reload() }))));
        return;
    }
    route();
}

boot();

import { append,
    state, api, h, clear, icon, btn, card, badge, table, field, input, select, fmtMoney, fmtDate, fmtDateTime, fmtRelative,
    fmtBytes, daysLeft, statusBadge, toast, toastError, confirmDialog, promptDialog, formDialog, openModal, withBusy, loading,
    errorBox, copyable, dropdown, menuItem, navigate, switchControl, on
} from '../core.js';
import { loadServers } from '../main.js';
import { TX_TYPES, paymentStatusBadge, viewReceipt } from './billing.js';

const enc = encodeURIComponent;

const SECTIONS = {
    overview: ['Genel Bakış', renderOverview],
    users: ['Kullanıcılar', renderUsers],
    servers: ['Tüm Sunucular', renderServers],
    payments: ['Ödemeler', renderPayments],
    plans: ['Paketler & Kuponlar', renderPlans],
    announcements: ['Duyurular', renderAnnouncements],
    infra: ['Altyapı', renderInfra],
    settings: ['Sistem Ayarları', renderSettings],
    audit: ['Denetim Kaydı', renderAudit]
};

export async function render(ctx) {
    const [title, fn] = SECTIONS[ctx.params.section] || SECTIONS.overview;
    ctx.setTitle(title, [{ label: 'Yönetim', href: '#/admin' }]);
    await fn(ctx);
}

function head(title, lead, actions = []) {
    return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), lead ? h('p', { class: 'lead' }, lead) : null), h('div', { class: 'btn-group' }, actions));
}

function kpi(label, value, iconName, meta, href) {
    const tile = h(href ? 'a' : 'div', { class: 'card stat', href, style: href ? { textDecoration: 'none', color: 'inherit' } : {} },
        h('div', { class: 'stat-label' }, icon(iconName, 'icon-sm'), label),
        h('div', { class: 'stat-value' }, value),
        meta ? h('div', { class: 'stat-meta' }, meta) : null);
    return tile;
}

/** Single-series bar chart: last 14 days of sales. Hover shows the value. */
function salesChart(rows) {
    const days = [];
    for (let i = 13; i >= 0; i--) {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - i);
        days.push(d);
    }
    const byDay = new Map(rows.map(r => [new Date(r.day).toDateString(), Number(r.amount) || 0]));
    const values = days.map(d => byDay.get(d.toDateString()) || 0);
    const max = Math.max(...values, 1);
    const plot = h('div', { class: 'chart-plot', role: 'img', 'aria-label': 'Son 14 günün satışları' },
        h('div', { class: 'chart-grid' }, h('div'), h('div'), h('div'), h('div')),
        values.map((v, i) => h('div', { class: 'chart-bar-hit', tabindex: '0', 'aria-label': `${fmtDate(days[i])}: ${fmtMoney(v)}` },
            h('div', { class: 'chart-bar', style: { height: `${(v / max) * 100}%` } }),
            h('div', { class: 'chart-tooltip' }, `${fmtDate(days[i])} · ${fmtMoney(v)}`))));
    const labels = h('div', { class: 'chart-labels' }, days.map((d, i) => h('span', {}, i % 2 === 0 ? d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' }) : '')));
    return h('div', { class: 'chart' }, h('div', { class: 'row small muted', style: { marginBottom: '6px' } }, `En yüksek gün: ${fmtMoney(max === 1 && !values.some(Boolean) ? 0 : max)}`), plot, labels);
}

// ---------------------------------------------------------------------------
//  Overview
// ---------------------------------------------------------------------------

async function renderOverview({ root, isCurrent }) {
    root.appendChild(loading());
    let o;
    try { o = await api('/api/admin/overview'); } catch (error) { clear(root, errorBox(error)); return; }
    if (!isCurrent()) return;
    clear(root);
    const n = v => Number(v) || 0;
    append(root, 
        head('Genel Bakış', 'İşletmenizin anlık durumu: müşteriler, sunucular, gelir ve altyapı.', [
            h('a', { class: 'btn', href: '#/admin/payments' }, icon('receipt'), 'Ödemeler'),
            h('a', { class: 'btn btn-primary', href: '#/admin/users' }, icon('users'), 'Kullanıcılar')]),
        h('div', { class: 'grid grid-4' },
            kpi('Müşteriler', String(n(o.users.total)), 'users', `${n(o.users.new7d)} yeni (7 gün) · ${n(o.users.active24h)} aktif (24 sa)`, '#/admin/users'),
            kpi('Kiralık sunucular', `${n(o.servers.rented)} / ${n(o.servers.total)}`, 'server', `${n(o.servers.pool)} boşta · ${n(o.servers.running)} çalışıyor · ${n(o.servers.suspended)} askıda`, '#/admin/servers'),
            kpi('Satış (30 gün)', fmtMoney(o.revenue.sales30d), 'activity', `Bugün: ${fmtMoney(o.revenue.sales24h)} · Toplam: ${fmtMoney(o.revenue.salesTotal)}`),
            kpi('Bekleyen ödeme', String(n(o.pendingPayments.count)), 'receipt', `${fmtMoney(o.pendingPayments.amount)} onay bekliyor`, '#/admin/payments')),
        h('div', { class: 'grid grid-aside' },
            card({ title: 'Satışlar', sub: 'Son 14 gün · kiralama + yenileme', iconName: 'activity', body: salesChart(o.salesByDay || []) }),
            card({ title: 'Altyapı', iconName: 'layers', actions: [h('a', { class: 'btn btn-sm', href: '#/admin/infra' }, 'Detay')], bodyClass: 'tight',
                body: table([
                    { label: 'Servis', render: c => h('span', { class: 'mono' }, c.name) },
                    { label: 'Durum', render: c => badge(c.state === 'running' ? 'Çalışıyor' : c.state === 'missing' ? 'Bulunamadı' : c.state, c.state === 'running' ? 'success' : 'danger') }
                ], o.infra) })),
        h('div', { class: 'grid grid-2' },
            card({ title: 'Süresi yaklaşanlar', sub: '7 gün içinde bitecek müşteri sunucuları', iconName: 'clock', bodyClass: 'tight',
                body: table([
                    { label: 'Sunucu', render: s => h('a', { href: `#/servers/${s.container_id}` }, `${s.name} (${s.port})`) },
                    { label: 'Müşteri', key: 'username' },
                    { label: 'Bitiş', class: 'nowrap', render: s => h('span', { class: daysLeft(s.expires_at) <= 1 ? 'text-danger' : 'text-warning' }, `${fmtDate(s.expires_at)} (${Math.max(0, daysLeft(s.expires_at))} gün)`) },
                    { label: 'Oto.', render: s => (s.auto_renew ? badge('Açık', 'success') : badge('Kapalı')) }
                ], o.expiringSoon, { empty: 'Yakında süresi dolacak sunucu yok.' }) }),
            card({ title: 'Son kayıtlar', iconName: 'users', bodyClass: 'tight',
                body: table([
                    { label: 'Kullanıcı', render: u => h('a', { href: `#/admin/users/${u.id}` }, u.username) },
                    { label: 'E-posta', render: u => h('span', { class: 'small' }, u.email || '—') },
                    { label: 'Bakiye', class: 'num', render: u => fmtMoney(u.balance) },
                    { label: 'Kayıt', class: 'small muted nowrap', render: u => fmtRelative(u.created_at) }
                ], o.recentUsers) })),
        card({ title: 'Son işlemler', iconName: 'list', actions: [h('a', { class: 'btn btn-sm', href: '#/admin/audit' }, 'Tümü')], bodyClass: 'tight', body: auditTable(o.recentAudit) }));
}

const AUDIT_LABELS = {
    'auth.login': 'Giriş yaptı', 'auth.register': 'Üye oldu', 'auth.lockout': 'Hesap kilitlendi', 'auth.password_reset': 'Şifre sıfırlandı', 'auth.forgot_password': 'Şifre sıfırlama istedi',
    'server.rent': 'Sunucu kiraladı', 'server.renew': 'Süre uzattı', 'server.auto_renew': 'Otomatik yenilendi', 'server.reset': 'Sunucu sıfırlandı', 'server.delete': 'Sunucu silindi',
    'server.suspend_expired': 'Süre doldu → askı', 'server.reclaim': 'Havuza geri alındı', 'server.settings': 'Ayar değiştirdi', 'server.start': 'Başlattı', 'server.stop': 'Durdurdu', 'server.restart': 'Yeniden başlattı',
    'payment.approve': 'Ödeme onayladı', 'payment.reject': 'Ödeme reddetti', 'user.balance': 'Bakiye düzeltti', 'user.update': 'Kullanıcı düzenledi', 'user.delete': 'Kullanıcı sildi',
    'user.create': 'Kullanıcı oluşturdu', 'user.reset_link': 'Sıfırlama bağlantısı üretti', 'user.force_logout': 'Oturumları kapattı',
    'user.stop_servers': 'Sunucularını durdurdu', 'server.extend': 'Süre ekledi', 'server.suspend': 'Askıya aldı', 'server.unsuspend': 'Askıyı kaldırdı',
    'server.transfer': 'Sahip değiştirdi', 'server.plan': 'Paket değiştirdi', 'server.release': 'Havuza aldı', 'coupon.create': 'Kupon oluşturdu',
    'coupon.delete': 'Kupon sildi', 'plan.create': 'Paket oluşturdu', 'plan.update': 'Paket güncelledi', 'announcement.create': 'Duyuru yayınladı',
    'setting.update': 'Ayar güncelledi', 'pool.ensure': 'Havuzu onardı', 'lifecycle.run': 'Süre kontrolü çalıştırdı', 'mysql.rotate': 'DB şifresi yeniledi',
    'mysql.query': 'SQL çalıştırdı', 'site.template': 'Site şablonu kurdu', 'site.domain': 'Alan adı bağladı', 'account.password': 'Şifresini değiştirdi',
    'account.logout_all': 'Tüm oturumları kapattı', 'account.profile': 'Profilini güncelledi', 'infra.restart': 'Servis yeniden başlattı'
};

function auditTable(entries) {
    return table([
        { label: 'Zaman', class: 'nowrap small muted', render: e => fmtDateTime(e.created_at) },
        { label: 'Kim', render: e => e.actor_name || (e.actor_id ? `#${e.actor_id}` : h('span', { class: 'muted' }, 'Sistem')) },
        { label: 'İşlem', render: e => h('span', {}, AUDIT_LABELS[e.action] || e.action) },
        { label: 'Hedef', render: e => (e.target_type ? h('span', { class: 'small mono' }, `${e.target_type}:${e.target_id || ''}`) : '') },
        { label: 'IP', class: 'small muted mono', render: e => e.ip || '' }
    ], entries || [], { empty: 'Kayıt yok.' });
}

// ---------------------------------------------------------------------------
//  Users
// ---------------------------------------------------------------------------

async function renderUsers({ root, params, query }) {
    const search = input({ type: 'search', placeholder: 'Kullanıcı adı veya e-posta ara…', value: query.get('q') || '', style: { maxWidth: '320px' } });
    const listBox = h('div', {}, loading());
    let timer = null;

    async function load() {
        clear(listBox, loading());
        try {
            const data = await api(`/api/admin/users?search=${enc(search.value.trim())}`);
            clear(listBox, table([
                { label: 'Kullanıcı', render: u => h('div', {}, h('strong', {}, u.username), h('div', { class: 'small muted' }, u.email || 'e-posta yok')) },
                { label: 'Rol', render: u => badge(u.role === 'admin' ? 'Yönetici' : 'Müşteri', u.role === 'admin' ? 'accent' : '') },
                { label: 'Bakiye', class: 'num', render: u => fmtMoney(u.balance) },
                { label: 'Sunucu', class: 'num', render: u => String(u.server_count) },
                { label: 'Durum', render: u => (u.suspended ? badge('Askıda', 'danger') : (u.locked_until && new Date(u.locked_until) > new Date() ? badge('Kilitli', 'warning') : badge('Aktif', 'success'))) },
                { label: 'Son giriş', class: 'nowrap small muted', render: u => (u.last_login_at ? fmtRelative(u.last_login_at) : 'Hiç') },
                { label: '', class: 'actions', render: u => btn('Yönet', { size: 'xs', onClick: () => navigate(`/admin/users/${u.id}`) }) }
            ], data.users, { empty: 'Kullanıcı bulunamadı.', rowAttrs: u => ({ class: 'clickable', onClick: e => { if (!e.target.closest('button')) navigate(`/admin/users/${u.id}`); } }) }));
        } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });

    const create = () => formDialog({
        title: 'Kullanıcı oluştur',
        fields: [
            { name: 'username', label: 'Kullanıcı adı', required: true },
            { name: 'email', label: 'E-posta', type: 'email' },
            { name: 'password', label: 'Şifre', type: 'text', value: generatePw(), help: 'Kullanıcıya iletin; ilk girişte değiştirmesini isteyin.' },
            { name: 'role', label: 'Rol', type: 'select', value: 'user', options: [{ value: 'user', label: 'Müşteri' }, { value: 'admin', label: 'Yönetici' }] },
            { name: 'balance', label: 'Başlangıç bakiyesi', type: 'number', value: '0', step: '0.01' }
        ],
        submitText: 'Oluştur',
        onSubmit: values => api('/api/admin/users', { method: 'POST', body: values })
    }).then(r => { if (r) { toast('Kullanıcı oluşturuldu.', 'success'); load(); } });

    append(root, head('Kullanıcılar', 'Müşteri hesaplarını arayın, bakiyelerini yönetin, şifre sıfırlama bağlantısı üretin.', [btn('Kullanıcı oluştur', { variant: 'primary', iconName: 'plus', onClick: create })]),
        card({ title: 'Hesaplar', iconName: 'users', actions: [search], bodyClass: 'tight', body: listBox }));
    load();
    if (params.sub) openUserDrawer(params.sub, load);
}

function generatePw() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    return Array.from(crypto.getRandomValues(new Uint8Array(12)), b => chars[b % chars.length]).join('') + '7';
}

async function openUserDrawer(userId, onChange) {
    const body = h('div', {}, loading());
    const modal = openModal({ title: 'Kullanıcı', size: 'lg', body, onClose: () => { if (window.location.hash.startsWith(`#/admin/users/${userId}`)) history.replaceState(null, '', '#/admin/users'); } });
    async function load() {
        let d;
        try { d = await api(`/api/admin/users/${userId}`); } catch (error) { clear(body, errorBox(error)); return; }
        const u = d.user;
        modal.dialog.querySelector('.modal-head h2').textContent = u.username;
        const refresh = () => { load(); onChange && onChange(); };
        const act = (label, iconName, fn, opts = {}) => menuItem(label, async () => { try { await fn(); } catch (error) { toastError(error); } }, { iconName, ...opts });
        const actions = dropdown(btn('İşlemler', { size: 'sm', iconName: 'more' }), close => h('div', {},
            act('Bakiye ekle / düş', 'wallet', async () => {
                close();
                const r = await formDialog({ title: 'Bakiye düzeltme', fields: [
                    { name: 'amount', label: 'Tutar (eksi değer düşer)', type: 'number', step: '0.01', required: true },
                    { name: 'reason', label: 'Açıklama (müşteri görür)', required: true, full: true }
                ], submitText: 'Uygula', onSubmit: v => api(`/api/admin/users/${u.id}/balance`, { method: 'POST', body: v }) });
                if (r) { toast('Bakiye güncellendi.', 'success'); refresh(); }
            }),
            act('Şifre sıfırlama bağlantısı', 'key', async () => {
                close();
                const r = await api(`/api/admin/users/${u.id}/reset-link`, { method: 'POST' });
                openModal({ title: 'Sıfırlama bağlantısı', body: h('div', { class: 'form-stack' }, h('p', { class: 'text-2' }, `Bu bağlantıyı kullanıcıya güvenli bir kanaldan iletin. ${r.expiresInHours} saat geçerli ve tek kullanımlık.`), copyable(r.url)) });
            }),
            act('Tüm oturumları kapat', 'logout', async () => { close(); await api(`/api/admin/users/${u.id}/logout`, { method: 'POST' }); toast('Oturumlar kapatıldı.', 'success'); }),
            u.locked_until && new Date(u.locked_until) > new Date() ? act('Kilidi aç', 'lock', async () => { close(); await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { unlock: true } }); refresh(); }) : null,
            act('Sunucularını durdur', 'stop', async () => { close(); const r = await api(`/api/admin/users/${u.id}/stop-servers`, { method: 'POST' }); toast(r.message, 'success'); }),
            h('div', { class: 'sep' }),
            act(u.suspended ? 'Askıyı kaldır' : 'Hesabı askıya al', 'shield', async () => {
                close();
                if (!u.suspended && !(await confirmDialog({ title: 'Hesap askıya alınsın mı?', message: 'Kullanıcı panele giremez ve tüm sunucuları durdurulur.', confirmText: 'Askıya al', danger: true }))) return;
                await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { suspended: !u.suspended } });
                refresh();
            }, { danger: !u.suspended }),
            act('Kullanıcıyı sil', 'trash', async () => {
                close();
                if (!(await confirmDialog({ title: 'Kullanıcı silinsin mi?', message: `${u.username} ve tüm sunucuları, veritabanları, web siteleri kalıcı olarak silinecek.`, confirmText: 'Kalıcı olarak sil', danger: true, requireText: u.username }))) return;
                await api(`/api/admin/users/${u.id}`, { method: 'DELETE', timeoutMs: 300000 });
                toast('Kullanıcı silindi.', 'success');
                modal.close();
                onChange && onChange();
            }, { danger: true })));

        const edit = btn('Düzenle', { size: 'sm', iconName: 'edit', onClick: async () => {
            const r = await formDialog({ title: 'Kullanıcıyı düzenle', fields: [
                { name: 'username', label: 'Kullanıcı adı', value: u.username },
                { name: 'email', label: 'E-posta', type: 'email', value: u.email || '' },
                { name: 'role', label: 'Rol', type: 'select', value: u.role, options: [{ value: 'user', label: 'Müşteri' }, { value: 'admin', label: 'Yönetici' }] },
                { name: 'admin_note', label: 'Yönetici notu (yalnızca yöneticiler görür)', type: 'textarea', value: u.admin_note || '' }
            ], onSubmit: v => api(`/api/admin/users/${u.id}`, { method: 'PUT', body: v }) });
            if (r) { toast('Kaydedildi.', 'success'); refresh(); }
        } });

        clear(body, h('div', { class: 'stack' },
            h('div', { class: 'row' },
                h('span', { class: 'avatar', style: { width: '44px', height: '44px', fontSize: '17px' } }, u.username.slice(0, 1)),
                h('div', { style: { flex: '1', minWidth: '0' } }, h('h2', {}, u.username), h('div', { class: 'small muted' }, u.email || 'e-posta yok')),
                u.suspended ? badge('Askıda', 'danger') : badge('Aktif', 'success'), edit, actions),
            h('div', { class: 'grid grid-4' },
                kpi('Bakiye', fmtMoney(u.balance), 'wallet'),
                kpi('Sunucu', String(d.servers.length), 'server'),
                kpi('Kayıt', fmtDate(u.created_at), 'user'),
                kpi('Son giriş', u.last_login_at ? fmtRelative(u.last_login_at) : 'Hiç', 'clock', u.last_login_ip || '')),
            u.admin_note ? h('div', { class: 'alert alert-info' }, icon('info'), h('div', {}, h('strong', {}, 'Yönetici notu'), h('p', {}, u.admin_note))) : null,
            card({ title: 'Sunucuları', iconName: 'server', bodyClass: 'tight', body: table([
                { label: 'Sunucu', render: s => h('a', { href: `#/servers/${s.id}`, onClick: () => modal.close() }, `${s.name} (${s.port})`) },
                { label: 'Paket', key: 'plan_type' },
                { label: 'Bitiş', class: 'nowrap', render: s => fmtDate(s.expires_at) },
                { label: 'Durum', render: s => (s.suspended ? badge('Askıda', 'danger') : badge('Aktif', 'success')) }
            ], d.servers, { empty: 'Sunucusu yok.' }) }),
            card({ title: 'Hesap hareketleri', iconName: 'activity', bodyClass: 'tight', body: table([
                { label: 'Tarih', class: 'nowrap small', render: t => fmtDateTime(t.created_at) },
                { label: 'İşlem', render: t => { const [l, v] = TX_TYPES[t.type] || [t.type, '']; return badge(l, v); } },
                { label: 'Açıklama', render: t => h('span', { class: 'small' }, t.description || '') },
                { label: 'Tutar', class: 'num nowrap', render: t => h('strong', { class: t.amount > 0 ? 'text-success' : 'text-danger' }, fmtMoney(t.amount)) }
            ], d.transactions, { empty: 'Hareket yok.' }) }),
            card({ title: 'Ödeme bildirimleri', iconName: 'receipt', bodyClass: 'tight', body: table([
                { label: 'Tarih', class: 'nowrap small', render: p => fmtDateTime(p.created_at) },
                { label: 'Tutar', class: 'num', render: p => fmtMoney(p.amount) },
                { label: 'Durum', render: p => paymentStatusBadge(p.status) },
                { label: '', class: 'actions', render: p => (p.receipt_path ? btn('Dekont', { size: 'xs', onClick: () => viewReceipt(p.receipt_path) }) : '') }
            ], d.payments, { empty: 'Bildirim yok.' }) }),
            card({ title: 'Etkinlik', iconName: 'list', bodyClass: 'tight', body: auditTable(d.audit) })));
    }
    load();
}

// ---------------------------------------------------------------------------
//  Servers
// ---------------------------------------------------------------------------

async function renderServers({ root, onCleanup }) {
    const listBox = h('div', {}, loading());
    const filter = select([{ value: 'rented', label: 'Kiralık' }, { value: 'pool', label: 'Boşta (havuz)' }, { value: 'suspended', label: 'Askıda' }, { value: 'all', label: 'Tümü' }], { value: 'rented', style: { width: 'auto' } });
    const search = input({ type: 'search', placeholder: 'Ara: ad, port, müşteri…', style: { maxWidth: '240px' } });
    const selected = new Set();
    const bulkBar = h('div', { class: 'btn-group' });

    function filtered() {
        const term = search.value.trim().toLowerCase();
        return state.servers.filter(s => {
            if (filter.value === 'rented' && s.is_pool) return false;
            if (filter.value === 'pool' && !s.is_pool) return false;
            if (filter.value === 'suspended' && !s.suspended) return false;
            return !term || `${s.name} ${s.port} ${s.owner}`.toLowerCase().includes(term);
        });
    }

    async function bulk(action) {
        const ids = [...selected];
        let message;
        if (action === 'say') {
            message = await promptDialog({ title: 'Oyun içi duyuru', label: `${ids.length} sunucuya gönderilecek mesaj`, placeholder: 'Sunucular 5 dakika içinde güncellenecek.' });
            if (!message) return;
        } else if (!(await confirmDialog({ title: 'Toplu işlem', message: `${ids.length} sunucuya "${action}" uygulanacak.`, confirmText: 'Uygula' }))) return;
        try {
            const r = await api('/api/admin/servers/bulk', { method: 'POST', body: { action, ids, message }, timeoutMs: 300000 });
            const failed = r.results.filter(x => !x.ok);
            toast(`${r.results.length - failed.length} başarılı${failed.length ? `, ${failed.length} hata` : ''}.`, failed.length ? 'warning' : 'success');
            selected.clear();
            loadServers().catch(() => {});
        } catch (error) { toastError(error); }
    }

    function paintBulk() {
        clear(bulkBar, selected.size ? [
            h('span', { class: 'small muted' }, `${selected.size} seçili`),
            btn('Başlat', { size: 'sm', iconName: 'play', onClick: () => bulk('start') }),
            btn('Yeniden başlat', { size: 'sm', iconName: 'refresh', onClick: () => bulk('restart') }),
            btn('Durdur', { size: 'sm', iconName: 'stop', onClick: () => bulk('stop') }),
            btn('Duyuru gönder', { size: 'sm', iconName: 'megaphone', onClick: () => bulk('say') })
        ] : []);
    }

    async function serverAction(s, kind) {
        try {
            if (kind === 'extend') {
                const r = await formDialog({ title: `Süre ekle · ${s.port}`, fields: [
                    { name: 'days', label: 'Gün (eksi değer düşer)', type: 'number', value: '7', required: true },
                    { name: 'reason', label: 'Not (müşteri görür)', full: true, placeholder: 'Örn. Bakım telafisi' }
                ], submitText: 'Uygula', onSubmit: v => api(`/api/admin/servers/${s.id}/extend`, { method: 'POST', body: v }) });
                if (r) toast(`Yeni bitiş: ${fmtDate(r.expires_at)}`, 'success');
            } else if (kind === 'suspend') {
                const reason = await promptDialog({ title: `Askıya al · ${s.port}`, label: 'Sebep (müşteri görür)', value: 'Kural ihlali' });
                if (reason === null) return;
                await api(`/api/admin/servers/${s.id}/suspend`, { method: 'POST', body: { reason } });
                toast('Sunucu askıya alındı.', 'success');
            } else if (kind === 'unsuspend') {
                await api(`/api/admin/servers/${s.id}/unsuspend`, { method: 'POST' });
                toast('Askı kaldırıldı.', 'success');
            } else if (kind === 'transfer') {
                const users = (await api('/api/admin/users')).users;
                const r = await formDialog({ title: `Sahip değiştir · ${s.port}`, fields: [
                    { name: 'userId', label: 'Yeni sahip', type: 'select', value: String(s.owner_id), options: users.map(u => ({ value: u.id, label: `${u.username}${u.email ? ` (${u.email})` : ''}` })) }
                ], submitText: 'Aktar', onSubmit: v => api(`/api/admin/servers/${s.id}/transfer`, { method: 'POST', body: v }) });
                if (r) toast('Sunucu aktarıldı.', 'success');
            } else if (kind === 'plan') {
                const plans = (await api('/api/admin/plans')).plans;
                const r = await formDialog({ title: `Paket değiştir · ${s.port}`, intro: 'Ücret alınmaz. Slot sayısı değişirse sunucu verileri korunarak yeniden oluşturulur.', fields: [
                    { name: 'plan', label: 'Paket', type: 'select', value: s.plan_type, options: plans.map(p => ({ value: p.slug, label: `${p.name} · ${p.max_players} slot` })) }
                ], submitText: 'Değiştir', onSubmit: v => api(`/api/admin/servers/${s.id}/plan`, { method: 'POST', body: v, timeoutMs: 180000 }) });
                if (r) toast('Paket değiştirildi.', 'success');
            } else if (kind === 'release') {
                if (!(await confirmDialog({ title: 'Havuza geri al', message: `Port ${s.port}: tüm dosyalar, veritabanı ve web sitesi silinip sunucu boş havuza alınacak.`, confirmText: 'Sil ve havuza al', danger: true, requireText: String(s.port) }))) return;
                await api(`/api/admin/servers/${s.id}/release`, { method: 'POST', timeoutMs: 300000 });
                toast('Sunucu havuza alındı.', 'success');
            }
            loadServers().catch(() => {});
        } catch (error) { toastError(error); }
    }

    function paint() {
        const rows = filtered();
        const allBox = h('input', { type: 'checkbox', 'aria-label': 'Tümünü seç', checked: rows.length > 0 && rows.every(r => selected.has(r.id)), onChange: e => {
            rows.forEach(r => (e.target.checked ? selected.add(r.id) : selected.delete(r.id)));
            paint();
        } });
        clear(listBox, table([
            { label: allBox, class: 'check-col', render: s => h('input', { type: 'checkbox', checked: selected.has(s.id), 'aria-label': `${s.port} seç`, onChange: e => { e.target.checked ? selected.add(s.id) : selected.delete(s.id); paintBulk(); } }) },
            { label: 'Sunucu', render: s => h('div', {}, h('a', { href: `#/servers/${s.id}` }, s.name), h('div', { class: 'small muted mono' }, s.address)) },
            { label: 'Müşteri', render: s => (s.is_pool ? h('span', { class: 'muted' }, 'Havuz') : s.owner) },
            { label: 'Paket', render: s => (s.is_pool ? '' : s.plan_name) },
            { label: 'Durum', render: s => statusBadge(s) },
            { label: 'Oyuncu', class: 'num', render: s => (s.online ? `${s.players}/${s.maxPlayers}` : '—') },
            { label: 'Bitiş', class: 'nowrap', render: s => (s.is_pool || daysLeft(s.expires_at) > 3650 ? '—' : h('span', { class: daysLeft(s.expires_at) <= 3 ? 'text-warning' : '' }, fmtDate(s.expires_at))) },
            { label: '', class: 'actions', render: s => dropdown(btn(null, { size: 'xs', iconName: 'more', title: 'İşlemler' }), close => h('div', {},
                menuItem('Yönet', () => { close(); navigate(`/servers/${s.id}`); }, { iconName: 'settings' }),
                s.is_pool ? null : [
                    menuItem('Süre ekle / düş', () => { close(); serverAction(s, 'extend'); }, { iconName: 'clock' }),
                    menuItem('Paket değiştir', () => { close(); serverAction(s, 'plan'); }, { iconName: 'tag' }),
                    menuItem('Sahip değiştir', () => { close(); serverAction(s, 'transfer'); }, { iconName: 'users' }),
                    s.suspended ? menuItem('Askıyı kaldır', () => { close(); serverAction(s, 'unsuspend'); }, { iconName: 'play' }) : menuItem('Askıya al', () => { close(); serverAction(s, 'suspend'); }, { iconName: 'lock' })],
                s.protected ? null : [h('div', { class: 'sep' }), menuItem('Sil ve havuza al', () => { close(); serverAction(s, 'release'); }, { iconName: 'trash', danger: true })])) }
        ], rows, { empty: 'Bu filtrede sunucu yok.' }));
        paintBulk();
    }
    filter.addEventListener('change', paint);
    search.addEventListener('input', paint);
    onCleanup(on('servers-updated', paint));

    append(root, head('Tüm Sunucular', 'Müşteri sunucularını yönetin: süre ekleyin, askıya alın, paket veya sahip değiştirin, toplu işlem yapın.',
        [h('a', { class: 'btn', href: '#/admin/infra' }, icon('layers'), 'Havuz durumu')]),
    card({ title: 'Sunucular', iconName: 'server', actions: [bulkBar, search, filter], bodyClass: 'tight', body: listBox }));
    try { await loadServers(); } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); return; }
    paint();
}

// ---------------------------------------------------------------------------
//  Payments
// ---------------------------------------------------------------------------

async function renderPayments({ root }) {
    let status = 'pending';
    const seg = h('div', { class: 'segmented' });
    const listBox = h('div', {}, loading());
    function paintSeg() {
        clear(seg, [['pending', 'Bekleyen'], ['approved', 'Onaylanan'], ['rejected', 'Reddedilen'], ['', 'Tümü']].map(([v, l]) =>
            h('button', { type: 'button', class: status === v ? 'active' : '', onClick: () => { status = v; paintSeg(); load(); } }, l)));
    }
    async function load() {
        clear(listBox, loading());
        try {
            const data = await api(`/api/payments/admin/list${status ? `?status=${status}` : ''}`);
            clear(listBox, table([
                { label: 'Tarih', class: 'nowrap small', render: p => fmtDateTime(p.created_at) },
                { label: 'Kullanıcı', render: p => h('a', { href: `#/admin/users/${p.user_id}` }, p.username) },
                { label: 'Gönderen', key: 'sender_name' },
                { label: 'Referans', render: p => h('span', { class: 'mono small' }, p.reference_code || '—') },
                { label: 'Tutar', class: 'num', render: p => h('strong', {}, fmtMoney(p.amount)) },
                { label: 'Durum', render: p => h('div', {}, paymentStatusBadge(p.status), p.reviewed_by_name ? h('div', { class: 'small muted' }, `${p.reviewed_by_name} · ${fmtRelative(p.reviewed_at)}`) : null, p.admin_note ? h('div', { class: 'small muted' }, p.admin_note) : null) },
                { label: '', class: 'actions', render: p => h('div', { class: 'btn-group', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
                    p.receipt_path ? btn('Dekont', { size: 'xs', iconName: 'receipt', onClick: () => viewReceipt(p.receipt_path) }) : null,
                    p.status === 'pending' ? [
                        btn('Onayla', { size: 'xs', variant: 'success', onClick: () => approve(p) }),
                        btn('Reddet', { size: 'xs', variant: 'danger', onClick: () => reject(p) })] : null) }
            ], data.payments, { empty: 'Bu durumda ödeme bildirimi yok.' }));
        } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }
    async function approve(p) {
        const r = await formDialog({ title: `Ödemeyi onayla · ${p.username}`, intro: `Bildirilen tutar: ${fmtMoney(p.amount)}. Banka hesabınızdaki tutar farklıysa düzeltin.`, fields: [
            { name: 'amount', label: 'Yüklenecek tutar', type: 'number', step: '0.01', value: String(p.amount), required: true },
            { name: 'note', label: 'Not (isteğe bağlı, müşteri görür)', full: true }
        ], submitText: 'Onayla ve yükle', onSubmit: v => api(`/api/payments/admin/${p.id}/approve`, { method: 'POST', body: v }) });
        if (r) { toast('Ödeme onaylandı.', 'success'); load(); }
    }
    async function reject(p) {
        const r = await formDialog({ title: `Ödemeyi reddet · ${p.username}`, fields: [
            { name: 'note', label: 'Red sebebi (müşteri görür)', value: 'Hesabımıza bu bilgilerle bir ödeme ulaşmadı.', full: true, type: 'textarea' }
        ], submitText: 'Reddet', onSubmit: v => api(`/api/payments/admin/${p.id}/reject`, { method: 'POST', body: v }) });
        if (r) { toast('Ödeme reddedildi.', 'success'); load(); }
    }
    paintSeg();
    append(root, head('Ödemeler', 'Havale/EFT bildirimlerini banka hesabınızla karşılaştırıp onaylayın veya reddedin.'),
        card({ title: 'Ödeme bildirimleri', iconName: 'receipt', actions: [seg], bodyClass: 'tight', body: listBox }));
    load();
}

// ---------------------------------------------------------------------------
//  Plans & coupons
// ---------------------------------------------------------------------------

function planFields(p = {}) {
    return [
        { name: 'slug', label: 'Kod (değiştirilemez)', value: p.slug || '', placeholder: 'ornek: premium' },
        { name: 'name', label: 'Paket adı', value: p.name || '' },
        { name: 'price', label: 'Fiyat (dönem başına)', type: 'number', step: '0.01', value: p.price ?? '' },
        { name: 'duration_days', label: 'Dönem (gün)', type: 'number', value: p.duration_days ?? 30 },
        { name: 'max_players', label: 'Slot', type: 'number', value: p.max_players ?? 24, min: 2, max: 32 },
        { name: 'sort_order', label: 'Sıra', type: 'number', value: p.sort_order ?? 0 },
        { name: 'description', label: 'Kısa açıklama', value: p.description || '', full: true },
        { name: 'features', label: 'Özellikler (her satıra bir tane)', type: 'textarea', value: (p.features || []).join('\n') },
        { name: 'active', type: 'checkbox', checkLabel: 'Satışta', value: p.active !== false },
        { name: 'highlighted', type: 'checkbox', checkLabel: '"En popüler" olarak öne çıkar', value: !!p.highlighted },
        { name: 'is_trial', type: 'checkbox', checkLabel: 'Deneme paketi (hesap başına bir kez, uzatılamaz)', value: !!p.is_trial }
    ];
}

async function renderPlans({ root }) {
    const plansBox = h('div', {}, loading());
    const couponsBox = h('div', {}, loading());

    async function loadPlans() {
        try {
            const data = await api('/api/admin/plans');
            clear(plansBox, table([
                { label: 'Paket', render: p => h('div', {}, h('strong', {}, p.name), h('div', { class: 'small muted mono' }, p.slug)) },
                { label: 'Fiyat', class: 'num nowrap', render: p => `${fmtMoney(p.price)} / ${p.duration_days} gün` },
                { label: 'Slot', class: 'num', key: 'max_players' },
                { label: 'Sunucu', class: 'num', render: p => String(p.servers) },
                { label: 'Durum', render: p => h('div', { class: 'row', style: { gap: '6px' } }, p.active ? badge('Satışta', 'success') : badge('Pasif'), p.is_trial ? badge('Deneme', 'info') : null, p.highlighted ? badge('Öne çıkan', 'accent') : null) },
                { label: '', class: 'actions', render: p => h('div', { class: 'btn-group', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
                    btn(null, { size: 'xs', iconName: 'edit', title: 'Düzenle', onClick: async () => {
                        const r = await formDialog({ title: `${p.name} paketini düzenle`, size: 'lg', fields: planFields(p).filter(f => f.name !== 'slug'), onSubmit: v => api(`/api/admin/plans/${p.id}`, { method: 'PUT', body: v }) });
                        if (r) { toast('Paket güncellendi.', 'success'); loadPlans(); }
                    } }),
                    btn(null, { size: 'xs', variant: 'danger', iconName: 'trash', title: 'Sil', onClick: async () => {
                        if (!(await confirmDialog({ title: 'Paket silinsin mi?', message: 'Kullanımdaki paketler silinemez; pasif yapabilirsiniz.', confirmText: 'Sil', danger: true }))) return;
                        try { await api(`/api/admin/plans/${p.id}`, { method: 'DELETE' }); loadPlans(); } catch (error) { toastError(error); }
                    } })) }
            ], data.plans));
        } catch (error) { clear(plansBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    async function loadCoupons() {
        try {
            const data = await api('/api/admin/coupons');
            clear(couponsBox, table([
                { label: 'Kod', render: c => h('strong', { class: 'mono' }, c.code) },
                { label: 'İndirim', render: c => (c.type === 'percent' ? `%${c.value}` : fmtMoney(c.value)) },
                { label: 'Kullanım', class: 'num', render: c => `${c.used_count}${c.max_uses ? ` / ${c.max_uses}` : ''}` },
                { label: 'Paket', render: c => c.plan_slug || 'Tümü' },
                { label: 'Bitiş', class: 'nowrap', render: c => (c.expires_at ? fmtDate(c.expires_at) : 'Süresiz') },
                { label: 'Aktif', render: c => switchControl('', c.active, async (checked, el) => {
                    try { await api(`/api/admin/coupons/${c.id}`, { method: 'PUT', body: { active: checked } }); } catch (error) { el.checked = !checked; toastError(error); }
                }) },
                { label: '', class: 'actions', render: c => btn(null, { size: 'xs', variant: 'danger', iconName: 'trash', title: 'Sil', onClick: async () => {
                    if (!(await confirmDialog({ title: 'Kupon silinsin mi?', message: c.code, confirmText: 'Sil', danger: true }))) return;
                    await api(`/api/admin/coupons/${c.id}`, { method: 'DELETE' }).catch(toastError);
                    loadCoupons();
                } }) }
            ], data.coupons, { empty: 'Kupon yok.' }));
        } catch (error) { clear(couponsBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    const newPlan = async () => {
        const r = await formDialog({ title: 'Yeni paket', size: 'lg', fields: planFields(), submitText: 'Oluştur', onSubmit: v => api('/api/admin/plans', { method: 'POST', body: v }) });
        if (r) { toast('Paket oluşturuldu.', 'success'); loadPlans(); }
    };
    const newCoupon = async () => {
        const plans = (await api('/api/admin/plans')).plans;
        const r = await formDialog({ title: 'Yeni kupon', fields: [
            { name: 'code', label: 'Kod', placeholder: 'YAZ25', required: true },
            { name: 'type', label: 'Tür', type: 'select', value: 'percent', options: [{ value: 'percent', label: 'Yüzde (%)' }, { value: 'fixed', label: 'Sabit tutar' }] },
            { name: 'value', label: 'Değer', type: 'number', step: '0.01', required: true },
            { name: 'max_uses', label: 'Toplam kullanım limiti', type: 'number', placeholder: 'Boş = sınırsız' },
            { name: 'per_user_limit', label: 'Kişi başı limit', type: 'number', value: '1' },
            { name: 'plan_slug', label: 'Geçerli paket', type: 'select', value: '', options: [{ value: '', label: 'Tüm paketler' }, ...plans.map(p => ({ value: p.slug, label: p.name }))] },
            { name: 'expires_at', label: 'Bitiş tarihi', type: 'date' }
        ], submitText: 'Oluştur', onSubmit: v => api('/api/admin/coupons', { method: 'POST', body: v }) });
        if (r) { toast('Kupon oluşturuldu.', 'success'); loadCoupons(); }
    };

    append(root, 
        head('Paketler & Kuponlar', 'Satış paketlerinizi, fiyatlarınızı ve kampanya kuponlarınızı yönetin.'),
        card({ title: 'Paketler', iconName: 'tag', sub: 'Dönem indirimleri Sistem Ayarları > Dönem İndirimleri alanından yönetilir.', actions: [btn('Yeni paket', { size: 'sm', variant: 'primary', iconName: 'plus', onClick: newPlan })], bodyClass: 'tight', body: plansBox }),
        card({ title: 'Kuponlar', iconName: 'receipt', actions: [btn('Yeni kupon', { size: 'sm', variant: 'primary', iconName: 'plus', onClick: newCoupon })], bodyClass: 'tight', body: couponsBox }));
    loadPlans();
    loadCoupons();
}

// ---------------------------------------------------------------------------
//  Announcements
// ---------------------------------------------------------------------------

async function renderAnnouncements({ root }) {
    const listBox = h('div', {}, loading());
    const LEVELS = { info: ['Bilgi', 'info'], success: ['Başarı', 'success'], warning: ['Uyarı', 'warning'], danger: ['Kritik', 'danger'] };
    async function load() {
        try {
            const data = await api('/api/admin/announcements');
            clear(listBox, table([
                { label: 'Duyuru', render: a => h('div', {}, h('strong', {}, a.title), a.body ? h('div', { class: 'small text-2', style: { whiteSpace: 'pre-line' } }, a.body) : null) },
                { label: 'Seviye', render: a => badge(...(LEVELS[a.level] || [a.level, ''])) },
                { label: 'Yayın', class: 'nowrap small muted', render: a => `${fmtDate(a.created_at)}${a.expires_at ? ` → ${fmtDate(a.expires_at)}` : ''}` },
                { label: 'Aktif', render: a => switchControl('', !!a.active, async (checked, el) => {
                    try { await api(`/api/admin/announcements/${a.id}`, { method: 'PUT', body: { active: checked } }); } catch (error) { el.checked = !checked; toastError(error); }
                }) },
                { label: '', class: 'actions', render: a => btn(null, { size: 'xs', variant: 'danger', iconName: 'trash', title: 'Sil', onClick: async () => {
                    await api(`/api/admin/announcements/${a.id}`, { method: 'DELETE' }).catch(toastError);
                    load();
                } }) }
            ], data.announcements, { empty: 'Duyuru yok.' }));
        } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }
    const create = async () => {
        const r = await formDialog({ title: 'Yeni duyuru', fields: [
            { name: 'title', label: 'Başlık', required: true, full: true },
            { name: 'body', label: 'Metin', type: 'textarea' },
            { name: 'level', label: 'Seviye', type: 'select', value: 'info', options: Object.entries(LEVELS).map(([v, [l]]) => ({ value: v, label: l })) },
            { name: 'expires_at', label: 'Bitiş (isteğe bağlı)', type: 'date' },
            { name: 'notify', type: 'checkbox', checkLabel: 'Tüm kullanıcılara bildirim olarak da gönder', value: false }
        ], submitText: 'Yayınla', onSubmit: v => api('/api/admin/announcements', { method: 'POST', body: v }) });
        if (r) { toast('Duyuru yayınlandı.', 'success'); load(); }
    };
    append(root, head('Duyurular', 'Panelin üstünde tüm kullanıcılara gösterilen bant duyuruları.', [btn('Yeni duyuru', { variant: 'primary', iconName: 'plus', onClick: create })]),
        card({ title: 'Yayındaki ve geçmiş duyurular', iconName: 'megaphone', bodyClass: 'tight', body: listBox }));
    load();
}

// ---------------------------------------------------------------------------
//  Infrastructure
// ---------------------------------------------------------------------------

async function renderInfra({ root, isCurrent }) {
    root.appendChild(loading());
    let infra;
    let pool;
    try {
        [infra, pool] = await Promise.all([api('/api/admin/infra'), api('/api/admin/pool')]);
    } catch (error) { clear(root, errorBox(error)); return; }
    if (!isCurrent()) return;
    clear(root);

    const dbBox = h('div', {}, loading());
    async function loadDbs() {
        try {
            const data = await api('/api/mysql/databases');
            clear(dbBox, table([
                { label: 'Veritabanı', render: d => h('span', { class: 'mono' }, d.name) },
                { label: 'Tablo', class: 'num', render: d => String(d.tables ?? '') },
                { label: 'Boyut', class: 'num', render: d => fmtBytes(d.size) },
                { label: '', class: 'actions', render: d => (d.system ? badge('Sistem') : btn(null, { size: 'xs', variant: 'danger', iconName: 'trash', title: 'Sil', onClick: async () => {
                    if (!(await confirmDialog({ title: 'Veritabanı silinsin mi?', message: `${d.name} kalıcı olarak silinecek.`, confirmText: 'Sil', danger: true, requireText: d.name }))) return;
                    try { await api(`/api/mysql/databases/${enc(d.name)}`, { method: 'DELETE' }); loadDbs(); } catch (error) { toastError(error); }
                } })) }
            ], data.databases));
        } catch (error) { clear(dbBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    const statusVariant = { available: 'success', rented: 'accent', missing: 'danger' };
    const statusLabel = { available: 'Boşta', rented: 'Kiralık', missing: 'Eksik' };
    append(root, 
        head('Altyapı', 'Konteynerler, kiralama havuzu, MySQL, PHP ve FastDL servislerinin durumu.', [
            btn('Süre kontrolünü çalıştır', { iconName: 'clock', onClick: async e => withBusy(e.currentTarget, async () => { try { const r = await api('/api/admin/lifecycle/run', { method: 'POST', timeoutMs: 300000 }); toast(r.message, 'success'); } catch (error) { toastError(error); } }) }),
            btn('Havuzu onar', { variant: 'primary', iconName: 'refresh', onClick: async e => withBusy(e.currentTarget, async () => {
                try {
                    const r = await api('/api/admin/pool/ensure', { method: 'POST', timeoutMs: 600000 });
                    toast(`Oluşturulan: ${r.report.created.length}, başlatılan: ${r.report.started.length}, hata: ${r.report.errors.length}`, r.report.errors.length ? 'warning' : 'success');
                    navigate('/admin/infra');
                } catch (error) { toastError(error); }
            }) })]),
        h('div', { class: 'grid grid-4' }, infra.containers.map(c => h('div', { class: 'card stat' },
            h('div', { class: 'stat-label' }, h('span', { class: `dot dot-${c.state === 'running' ? 'online' : 'offline'}` }), c.name),
            h('div', { class: 'stat-value', style: { fontSize: '17px' } }, c.state === 'running' ? 'Çalışıyor' : c.state === 'missing' ? 'Bulunamadı' : c.state),
            h('div', { class: 'stat-meta row' }, h('span', { class: 'truncate' }, c.status),
                c.restartable ? btn('Yeniden başlat', { size: 'xs', onClick: async e => withBusy(e.currentTarget, async () => { try { const r = await api(`/api/admin/infra/${enc(c.name)}/restart`, { method: 'POST' }); toast(r.message, 'success'); } catch (error) { toastError(error); } }) }) : null)))),
        card({ title: 'Kiralama havuzu', iconName: 'server', sub: 'Port listesi Sistem Ayarları > Havuz Portları alanından değiştirilir.',
            body: h('div', { class: 'pool-grid' }, pool.ports.map(p => h('div', { class: 'pool-slot' },
                h('strong', {}, String(p.port)),
                p.protected ? badge('Korumalı', 'info') : badge(statusLabel[p.status] || p.status, statusVariant[p.status] || ''),
                h('span', {}, p.owner || ({ running: 'Çalışıyor', exited: 'Durdu', created: 'Oluşturuldu', missing: 'Konteyner yok' }[p.containerState] || p.containerState)))) ) }),
        h('div', { class: 'grid grid-2' },
            card({ title: 'Servis adresleri', iconName: 'globe', body: h('dl', { class: 'kv' },
                h('dt', {}, 'FastDL'), h('dd', {}, copyable(`${infra.fastdl.baseUrl}/<port>/`)),
                h('dt', {}, 'PHP siteleri'), h('dd', {}, copyable(infra.php.baseUrl)),
                h('dt', {}, 'MySQL (iç ağ)'), h('dd', {}, copyable(`${infra.mysql.internal.host}:${infra.mysql.internal.port}`)),
                h('dt', {}, 'MySQL (dış)'), h('dd', {}, infra.mysql.external ? copyable(`${infra.mysql.external.host}:${infra.mysql.external.port}`) : h('span', { class: 'muted' }, 'Dışarıya kapalı (önerilen)')),
                h('dt', {}, 'MySQL sürümü'), h('dd', {}, infra.mysql.version || 'Çevrimdışı'),
                h('dt', {}, 'Panel'), h('dd', {}, `Node ${infra.node} · çalışma süresi ${Math.round(infra.uptimeSeconds / 3600)} sa`)),
                footer: [btn('Tüm PHP sitelerini onar', { size: 'sm', iconName: 'refresh', onClick: async e => withBusy(e.currentTarget, async () => { try { const r = await api('/api/php/repair-all', { method: 'POST', timeoutMs: 300000 }); toast(r.message, 'success'); } catch (error) { toastError(error); } }) })] }),
            card({ title: 'MySQL veritabanları', iconName: 'database', actions: [btn('Yeni', { size: 'sm', iconName: 'plus', onClick: async () => {
                const name = await promptDialog({ title: 'Yeni veritabanı', label: 'Ad (harf, rakam, _)' });
                if (!name) return;
                try { await api('/api/mysql/databases', { method: 'POST', body: { name } }); loadDbs(); } catch (error) { toastError(error); }
            } })], bodyClass: 'tight', body: dbBox })));
    loadDbs();
}

// ---------------------------------------------------------------------------
//  Settings
// ---------------------------------------------------------------------------

const SETTING_GROUPS = [
    ['Genel', ['site_name', 'support_contact', 'currency']],
    ['Üyelik ve erişim', ['registration_enabled', 'maintenance_mode', 'maintenance_message']],
    ['Ödeme', ['iban_details', 'min_deposit']],
    ['Abonelik kuralları', ['renewal_period_discounts', 'grace_days', 'global_free_limit', 'pool_ports']]
];

async function renderSettings({ root }) {
    root.appendChild(loading());
    let data;
    try { data = await api('/api/admin/settings'); } catch (error) { clear(root, errorBox(error)); return; }
    clear(root);
    const byKey = new Map(data.allSettings.map(s => [s.key, s]));
    const controls = new Map();

    function control(s) {
        const opts = s.options ? s.options.split(',').map(o => o.trim()) : [];
        let el;
        if (s.type === 'textarea') el = h('textarea', { class: 'textarea', rows: 3, value: s.value || '' });
        else if (s.type === 'select') {
            const labels = { '1': 'Açık', '0': 'Kapalı' };
            el = select(opts.map(o => ({ value: o, label: labels[o] || o })), { value: s.value });
        } else el = input({ type: s.type === 'number' ? 'number' : 'text', value: s.value || '' });
        controls.set(s.key, el);
        return field(s.name || s.key, el, { help: s.description });
    }

    const used = new Set();
    const groups = SETTING_GROUPS.map(([title, keys]) => {
        const fields = keys.map(k => byKey.get(k)).filter(Boolean);
        fields.forEach(f => used.add(f.key));
        return card({ title, body: h('div', { class: 'form-grid' }, fields.map(f => { const w = control(f); if (f.type === 'textarea') w.classList.add('full'); return w; })) });
    });
    const custom = data.allSettings.filter(s => !used.has(s.key));
    const saveBtn = btn('Tüm ayarları kaydet', { variant: 'primary', iconName: 'check' });
    saveBtn.addEventListener('click', () => withBusy(saveBtn, async () => {
        const body = {};
        controls.forEach((el, key) => { body[key] = el.value; });
        try { await api('/api/admin/settings', { method: 'PUT', body }); toast('Ayarlar kaydedildi.', 'success'); } catch (error) { toastError(error); }
    }));
    const addCustom = async () => {
        const r = await formDialog({ title: 'Özel ayar ekle', fields: [
            { name: 'key', label: 'Anahtar', placeholder: 'ornek_ayar', required: true },
            { name: 'name', label: 'Görünen ad', required: true },
            { name: 'type', label: 'Tür', type: 'select', value: 'text', options: [{ value: 'text', label: 'Metin' }, { value: 'number', label: 'Sayı' }, { value: 'textarea', label: 'Uzun metin' }, { value: 'select', label: 'Seçim listesi' }] },
            { name: 'options', label: 'Seçenekler (virgülle)', placeholder: 'a,b,c' },
            { name: 'value', label: 'Değer' },
            { name: 'description', label: 'Açıklama', full: true }
        ], submitText: 'Ekle', onSubmit: v => api('/api/admin/settings', { method: 'POST', body: v }) });
        if (r) { toast('Ayar eklendi.', 'success'); navigate('/admin/settings'); }
    };

    append(root, 
        head('Sistem Ayarları', 'Marka, üyelik, ödeme ve abonelik kurallarını yapılandırın.', [btn('Özel ayar ekle', { iconName: 'plus', onClick: addCustom }), saveBtn]),
        h('div', { class: 'grid grid-2' }, groups),
        custom.length ? card({ title: 'Özel ayarlar', iconName: 'sliders', body: h('div', { class: 'form-grid' }, custom.map(s => {
            const w = control(s);
            w.appendChild(h('div', { class: 'row' }, h('code', { class: 'small muted' }, s.key), btn('Sil', { size: 'xs', variant: 'ghost', onClick: async () => {
                if (!(await confirmDialog({ title: 'Ayar silinsin mi?', message: s.key, confirmText: 'Sil', danger: true }))) return;
                try { await api(`/api/admin/settings/${enc(s.key)}`, { method: 'DELETE' }); navigate('/admin/settings'); } catch (error) { toastError(error); }
            } })));
            return w;
        })) }) : null);
}

// ---------------------------------------------------------------------------
//  Audit log
// ---------------------------------------------------------------------------

async function renderAudit({ root }) {
    let offset = 0;
    const filter = select([
        { value: '', label: 'Tüm işlemler' }, { value: 'auth', label: 'Oturum' }, { value: 'server', label: 'Sunucu' },
        { value: 'payment', label: 'Ödeme' }, { value: 'user', label: 'Kullanıcı' }, { value: 'mysql', label: 'MySQL' },
        { value: 'plan', label: 'Paket' }, { value: 'setting', label: 'Ayar' }
    ], { value: '', style: { width: 'auto' } });
    const box = h('div', {}, loading());
    async function load() {
        clear(box, loading());
        try {
            const data = await api(`/api/admin/audit?limit=50&offset=${offset}${filter.value ? `&action=${filter.value}` : ''}`);
            clear(box, auditTable(data.entries), h('div', { class: 'card-foot' },
                h('span', { class: 'small muted', style: { marginRight: 'auto' } }, `${data.total} kayıt`),
                btn('Önceki', { size: 'sm', disabled: offset === 0, onClick: () => { offset = Math.max(0, offset - 50); load(); } }),
                btn('Sonraki', { size: 'sm', disabled: offset + 50 >= data.total, onClick: () => { offset += 50; load(); } })));
        } catch (error) { clear(box, h('div', { class: 'card-body' }, errorBox(error))); }
    }
    filter.addEventListener('change', () => { offset = 0; load(); });
    append(root, head('Denetim Kaydı', 'Panelde yapılan tüm kritik işlemlerin kim, ne zaman ve hangi IP\'den yaptığı.'),
        card({ title: 'Kayıtlar', iconName: 'list', actions: [filter], bodyClass: 'tight', body: box }));
    load();
}

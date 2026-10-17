import { append,
    state, api, h, clear, icon, btn, linkBtn, card, badge, table, tableActions, field, input, select, fmtMoney, fmtDate, fmtDateTime, fmtRelative,
    fmtBytes, fmtNumber, daysLeft, statusBadge, toast, toastError, confirmDialog, promptDialog, formDialog, openModal, withBusy, loading,
    errorBox, copyable, dropdown, menuItem, menuSep, moreMenu, navigate, switchControl, on, emit, searchInput, pager, downloadCsv, validators,
    generatePassword
} from '../core.js';
import { loadServers } from '../main.js';
import { TX_TYPES, RECEIPT_TYPES, paymentStatusBadge, requestStatusBadge, viewReceipt } from './billing.js';
import { openReceipt } from '../components/receipt.js';

const enc = encodeURIComponent;
const PAGE = 50;

const SECTIONS = {
    overview: ['Genel Bakış', renderOverview],
    users: ['Kullanıcılar', renderUsers],
    servers: ['Tüm Sunucular', renderServers],
    payments: ['Ödemeler', renderPayments],
    refunds: ['İadeler & Çekimler', renderRefunds],
    transactions: ['Hesap Hareketleri', renderTransactions],
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
    return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), lead ? h('p', { class: 'lead' }, lead) : null), actions.length ? h('div', { class: 'btn-group' }, actions) : null);
}

function kpi(label, value, iconName, meta, href) {
    return h(href ? 'a' : 'div', { class: `card stat ${href ? 'link-tile' : ''}`.trim(), href },
        h('div', { class: 'stat-label' }, icon(iconName, 'icon-sm'), label),
        h('div', { class: 'stat-value' }, value),
        meta ? h('div', { class: 'stat-meta' }, meta) : null);
}

/** Poll `fn` while the section is shown and the tab is visible. */
function autoRefresh(onCleanup, fn, ms) {
    const timer = setInterval(() => { if (!document.hidden) fn(); }, ms);
    onCleanup(() => clearInterval(timer));
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
    const total = values.reduce((s, v) => s + v, 0);
    const plot = h('div', { class: 'chart-plot', role: 'img', 'aria-label': 'Son 14 günün satışları' },
        h('div', { class: 'chart-grid' }, h('div'), h('div'), h('div'), h('div')),
        values.map((v, i) => h('div', { class: 'chart-bar-hit', tabindex: '0', 'aria-label': `${fmtDate(days[i])}: ${fmtMoney(v)}` },
            h('div', { class: 'chart-bar', style: { height: `${(v / max) * 100}%` } }),
            h('div', { class: 'chart-tooltip' }, `${fmtDate(days[i])} · ${fmtMoney(v)}`))));
    const labels = h('div', { class: 'chart-labels' }, days.map((d, i) => h('span', {}, i % 2 === 0 ? d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' }) : '')));
    return h('div', { class: 'chart' },
        h('div', { class: 'row small muted mb-2' }, h('span', {}, `14 gün toplamı: ${fmtMoney(total)}`), h('span', { class: 'spacer' }), h('span', {}, `En yüksek gün: ${fmtMoney(total ? max : 0)}`)),
        plot, labels);
}

// ---------------------------------------------------------------------------
//  Overview
// ---------------------------------------------------------------------------

async function renderOverview({ root, isCurrent, onCleanup }) {
    root.appendChild(loading());
    const body = h('div', { class: 'stack' });
    let plansBySlug = new Map();

    async function load() {
        let o;
        try {
            const [overview, plans] = await Promise.all([api('/api/admin/overview'), plansBySlug.size ? null : api('/api/admin/plans').catch(() => ({ plans: [] }))]);
            o = overview;
            if (plans) plansBySlug = new Map(plans.plans.map(p => [p.slug, p.name]));
        } catch (error) { clear(body, errorBox(error)); return; }
        if (!isCurrent()) return;
        const n = v => Number(v) || 0;
        const planTotal = (o.planDistribution || []).reduce((s, p) => s + n(p.count), 0);
        clear(body,
            h('div', { class: 'grid grid-4' },
                kpi('Müşteriler', fmtNumber(o.users.total), 'users', `${n(o.users.new7d)} yeni (7 gün) · ${n(o.users.active24h)} aktif (24 sa)`, '#/admin/users'),
                kpi('Kiralık sunucular', `${n(o.servers.rented)} / ${n(o.servers.total)}`, 'server', `${n(o.servers.pool)} boşta · ${n(o.servers.running)} çalışıyor · ${n(o.servers.suspended)} askıda`, '#/admin/servers'),
                kpi('Net satış (30 gün)', fmtMoney(o.revenue.sales30d), 'activity', `İadeler: ${fmtMoney(o.revenue.refunds30d || 0)} · Bugün: ${fmtMoney(o.revenue.sales24h)}`, '#/admin/transactions'),
                kpi('Bekleyen ödeme', fmtNumber(o.pendingPayments.count), 'receipt', `${fmtMoney(o.pendingPayments.amount)} onay bekliyor`, '#/admin/payments')),
            h('div', { class: 'grid grid-4' },
                kpi('Müşteri bakiyeleri', fmtMoney(o.users.totalBalance), 'wallet', 'Hesaplarda bekleyen toplam bakiye'),
                kpi('Otomatik yenileme', fmtNumber(o.servers.autoRenew), 'refresh', `${n(o.servers.rented) ? Math.round(n(o.servers.autoRenew) / n(o.servers.rented) * 100) : 0}% kiralık sunucuda açık`),
                kpi('Bekleyen iade / çekim', `${fmtNumber((o.pendingBilling || {}).refunds || 0)} / ${fmtNumber((o.pendingBilling || {}).withdrawals || 0)}`, 'refresh', 'Onayınızı bekleyen talepler', '#/admin/refunds'),
                kpi('Oyun konteynerleri', `${n(o.servers.running)} / ${n(o.servers.containers)}`, 'cpu', 'Çalışan / toplam', '#/admin/infra')),
            h('div', { class: 'grid grid-aside' },
                card({ title: 'Satışlar', sub: 'Son 14 gün · kiralama + yenileme', iconName: 'activity', body: salesChart(o.salesByDay || []) }),
                card({ title: 'Paket dağılımı', sub: `${planTotal} kiralık sunucu`, iconName: 'tag',
                    body: planTotal ? h('div', { class: 'dist' }, (o.planDistribution || []).sort((a, b) => b.count - a.count).map(p => h('div', { class: 'dist-row' },
                        h('span', { class: 'truncate' }, plansBySlug.get(p.plan) || p.plan),
                        h('div', { class: 'meter-bar' }, h('div', { style: { width: `${n(p.count) / planTotal * 100}%` } })),
                        h('span', { class: 'num' }, String(p.count))))) : h('p', { class: 'muted' }, 'Henüz kiralık sunucu yok.') })),
            h('div', { class: 'grid grid-2' },
                card({ title: 'Süresi yaklaşanlar', sub: '7 gün içinde bitecek müşteri sunucuları', iconName: 'clock', bodyClass: 'tight',
                    body: table([
                        { label: 'Sunucu', render: s => h('a', { href: `#/servers/${s.container_id}` }, `${s.name} (${s.port})`) },
                        { label: 'Müşteri', key: 'username' },
                        { label: 'Bitiş', type: 'date', render: s => h('span', { class: daysLeft(s.expires_at) <= 1 ? 'text-danger' : 'text-warning' }, `${fmtDate(s.expires_at)} (${Math.max(0, daysLeft(s.expires_at))} gün)`) },
                        { label: 'Oto.', render: s => (s.auto_renew ? badge('Açık', 'success') : badge('Kapalı')) }
                    ], o.expiringSoon, { empty: 'Yakında süresi dolacak sunucu yok.' }) }),
                card({ title: 'Son kayıtlar', iconName: 'users', actions: [linkBtn('Tümü', '#/admin/users', { size: 'sm' })], bodyClass: 'tight',
                    body: table([
                        { label: 'Kullanıcı', render: u => h('a', { href: `#/admin/users/${u.id}` }, u.username) },
                        { label: 'E-posta', key: 'email', hideSm: true },
                        { label: 'Bakiye', type: 'num', render: u => fmtMoney(u.balance) },
                        { label: 'Kayıt', type: 'date', render: u => fmtRelative(u.created_at) }
                    ], o.recentUsers) })),
            h('div', { class: 'grid grid-aside' },
                card({ title: 'Son işlemler', iconName: 'list', actions: [linkBtn('Tümü', '#/admin/audit', { size: 'sm' })], bodyClass: 'tight', body: auditTable(o.recentAudit) }),
                card({ title: 'Altyapı', iconName: 'layers', actions: [linkBtn('Detay', '#/admin/infra', { size: 'sm' })], bodyClass: 'tight',
                    body: table([
                        { label: 'Servis', key: 'name', type: 'mono' },
                        { label: 'Durum', render: c => badge(c.state === 'running' ? 'Çalışıyor' : c.state === 'missing' ? 'Bulunamadı' : c.state, c.state === 'running' ? 'success' : 'danger') }
                    ], o.infra) })));
    }

    clear(root,
        head('Genel Bakış', 'İşletmenizin anlık durumu: müşteriler, sunucular, gelir ve altyapı. 30 saniyede bir yenilenir.', [
            linkBtn('Ödemeler', '#/admin/payments', { iconName: 'receipt' }),
            linkBtn('Kullanıcılar', '#/admin/users', { variant: 'primary', iconName: 'users' })]),
        body);
    await load();
    autoRefresh(onCleanup, load, 30000);
}

const AUDIT_LABELS = {
    'auth.login': 'Giriş yaptı', 'auth.register': 'Üye oldu', 'auth.lockout': 'Hesap kilitlendi', 'auth.password_reset': 'Şifre sıfırlandı', 'auth.forgot_password': 'Şifre sıfırlama istedi',
    'server.rent': 'Sunucu kiraladı', 'server.renew': 'Süre uzattı', 'server.auto_renew': 'Otomatik yenilendi', 'server.reset': 'Sunucu sıfırlandı', 'server.delete': 'Sunucu silindi',
    'server.suspend_expired': 'Süre doldu → askı', 'server.reclaim': 'Havuza geri alındı', 'server.settings': 'Ayar değiştirdi', 'server.start': 'Başlattı', 'server.stop': 'Durdurdu', 'server.restart': 'Yeniden başlattı',
    'server.recreate': 'Konteyneri yeniden oluşturdu', 'server.startup': 'Başlatma parametrelerini değiştirdi',
    'server.bulk_start': 'Toplu başlattı', 'server.bulk_stop': 'Toplu durdurdu', 'server.bulk_restart': 'Toplu yeniden başlattı', 'server.bulk_say': 'Toplu duyuru gönderdi',
    'payment.approve': 'Ödeme onayladı', 'payment.reject': 'Ödeme reddetti', 'payment.report': 'Ödeme bildirdi', 'user.balance': 'Bakiye düzeltti', 'user.update': 'Kullanıcı düzenledi', 'user.delete': 'Kullanıcı sildi',
    'user.create': 'Kullanıcı oluşturdu', 'user.reset_link': 'Sıfırlama bağlantısı üretti', 'user.force_logout': 'Oturumları kapattı',
    'user.stop_servers': 'Sunucularını durdurdu', 'server.extend': 'Süre ekledi', 'server.suspend': 'Askıya aldı', 'server.unsuspend': 'Askıyı kaldırdı',
    'server.transfer': 'Sahip değiştirdi', 'server.plan': 'Paket değiştirdi', 'server.release': 'Havuza aldı',
    'coupon.create': 'Kupon oluşturdu', 'coupon.update': 'Kupon güncelledi', 'coupon.delete': 'Kupon sildi',
    'plan.create': 'Paket oluşturdu', 'plan.update': 'Paket güncelledi', 'plan.delete': 'Paket sildi',
    'announcement.create': 'Duyuru yayınladı', 'announcement.update': 'Duyuru güncelledi', 'announcement.delete': 'Duyuru sildi',
    'setting.update': 'Ayar güncelledi', 'setting.create': 'Ayar ekledi', 'setting.delete': 'Ayar sildi',
    'pool.ensure': 'Havuzu onardı', 'lifecycle.run': 'Süre kontrolü çalıştırdı',
    'mysql.rotate': 'DB şifresi yeniledi', 'mysql.query': 'SQL çalıştırdı', 'mysql.drop_database': 'Veritabanı sildi', 'mysql.repair': 'DB hesabını onardı',
    'site.template': 'Site şablonu kurdu', 'site.domain': 'Alan adı bağladı', 'site.zip': 'Siteye ZIP yükledi', 'site.repair': 'Site izinlerini onardı',
    'account.password': 'Şifresini değiştirdi', 'account.logout_all': 'Tüm oturumları kapattı', 'account.profile': 'Profilini güncelledi',
    'infra.restart': 'Servis yeniden başlattı',
    'refund.request': 'İade talep etti', 'refund.cancel': 'İade talebini iptal etti', 'refund.approve': 'İade onayladı', 'refund.reject': 'İade reddetti', 'refund.direct': 'Doğrudan iade yaptı',
    'withdrawal.request': 'Para çekme talep etti', 'withdrawal.paid': 'Çekimi ödendi işaretledi', 'withdrawal.reject': 'Çekimi reddetti',
    'task.create': 'Görev oluşturdu', 'task.update': 'Görev düzenledi', 'task.delete': 'Görev sildi', 'task.run': 'Zamanlanmış görev çalıştı', 'task.run_manual': 'Görevi elle çalıştırdı'
};

const AUDIT_FILTERS = [
    ['', 'Tüm işlemler'], ['auth', 'Oturum'], ['account', 'Hesap'], ['server', 'Sunucu'], ['task', 'Görevler'], ['payment', 'Ödeme'], ['user', 'Kullanıcı'],
    ['mysql', 'MySQL'], ['site', 'Web sitesi'], ['plan', 'Paket'], ['coupon', 'Kupon'], ['announcement', 'Duyuru'], ['setting', 'Ayar'],
    ['refund', 'İade'], ['withdrawal', 'Para çekme'], ['infra', 'Altyapı'], ['pool', 'Havuz'], ['lifecycle', 'Süre kontrolü']
];

function auditDetails(e) {
    if (!e.details) return null;
    let text = e.details;
    try { text = Object.entries(JSON.parse(e.details)).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '); } catch (_) { /* plain text */ }
    return h('span', { class: 'small muted' }, text.length > 120 ? `${text.slice(0, 120)}…` : text);
}

function auditTable(entries) {
    return table([
        { label: 'Zaman', type: 'date', render: e => h('span', { title: fmtDateTime(e.created_at) }, fmtRelative(e.created_at)) },
        { label: 'Kim', render: e => e.actor_name || (e.actor_id ? `#${e.actor_id}` : h('span', { class: 'muted' }, 'Sistem')) },
        { label: 'İşlem', render: e => h('div', { class: 'cell-title' }, h('span', {}, AUDIT_LABELS[e.action] || e.action), auditDetails(e)) },
        { label: 'Hedef', type: 'mono', hideSm: true, render: e => (e.target_type ? `${e.target_type}:${e.target_id || ''}` : null) },
        { label: 'IP', type: 'mono', hideSm: true, key: 'ip' }
    ], entries || [], { empty: 'Kayıt yok.' });
}

// ---------------------------------------------------------------------------
//  Users
// ---------------------------------------------------------------------------

async function renderUsers({ root, params, query }) {
    let offset = 0;
    let lastPage = [];
    const search = searchInput({ placeholder: 'Ad, e-posta veya IP ara…', value: query.get('q') || '', onSearch: () => { offset = 0; load(); } });
    const listBox = h('div', {}, loading());

    async function load() {
        clear(listBox, loading());
        try {
            const data = await api(`/api/admin/users?limit=${PAGE}&offset=${offset}&search=${enc(search.control.value.trim())}`);
            lastPage = data.users;
            clear(listBox, table([
                { label: 'Kullanıcı', render: u => h('div', { class: 'cell-title' }, h('strong', {}, u.username), h('span', {}, u.email || 'e-posta yok')), sort: u => u.username.toLowerCase() },
                { label: 'Rol', render: u => badge(u.role === 'admin' ? 'Yönetici' : 'Müşteri', u.role === 'admin' ? 'accent' : ''), hideSm: true },
                { label: 'Bakiye', type: 'money', render: u => fmtMoney(u.balance), sort: u => Number(u.balance) },
                { label: 'Sunucu', type: 'num', render: u => String(u.server_count), sort: u => u.server_count },
                { label: 'Durum', render: u => (u.suspended ? badge('Askıda', 'danger') : (u.locked_until && new Date(u.locked_until) > new Date() ? badge('Kilitli', 'warning') : badge('Aktif', 'success'))) },
                { label: 'Son giriş', type: 'date', hideSm: true, render: u => (u.last_login_at ? fmtRelative(u.last_login_at) : 'Hiç'), sort: u => (u.last_login_at ? new Date(u.last_login_at).getTime() : 0) },
                { label: '', type: 'actions', render: u => btn('Yönet', { size: 'xs', iconName: 'arrowRight', onClick: () => navigate(`/admin/users/${u.id}`) }) }
            ], data.users, { empty: 'Kullanıcı bulunamadı.', onRowClick: u => navigate(`/admin/users/${u.id}`) }),
            pager({ offset, limit: PAGE, count: data.users.length, total: data.total, onChange: next => { offset = next; load(); } }));
        } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    const create = () => formDialog({
        title: 'Kullanıcı oluştur',
        fields: [
            { name: 'username', label: 'Kullanıcı adı', required: true, pattern: '[A-Za-z0-9_.\\-]{3,32}', help: '3-32 karakter; harf, rakam, _ . -' },
            { name: 'email', label: 'E-posta', type: 'email' },
            { name: 'password', label: 'Şifre', type: 'text', value: `${generatePassword(11)}7`, code: true, help: 'Kullanıcıya iletin; ilk girişte değiştirmesini isteyin.', validate: v => (v.length < 8 ? 'En az 8 karakter.' : null) },
            { name: 'role', label: 'Rol', type: 'select', value: 'user', options: [{ value: 'user', label: 'Müşteri' }, { value: 'admin', label: 'Yönetici' }] },
            { name: 'balance', label: 'Başlangıç bakiyesi', type: 'number', value: '0', step: '0.01', min: 0 }
        ],
        submitText: 'Oluştur',
        onSubmit: values => api('/api/admin/users', { method: 'POST', body: values })
    }).then(r => { if (r) { toast('Kullanıcı oluşturuldu.', 'success'); load(); } });

    append(root, head('Kullanıcılar', 'Müşteri hesaplarını arayın, bakiyelerini yönetin, şifre sıfırlama bağlantısı üretin.', [
        btn('CSV', { iconName: 'download', title: 'Bu sayfayı CSV olarak indir', onClick: () => downloadCsv('kullanicilar.csv', [
            { key: 'id', label: 'ID' }, { key: 'username', label: 'Kullanıcı' }, { key: 'email', label: 'E-posta' }, { key: 'role', label: 'Rol' },
            { key: 'balance', label: 'Bakiye' }, { key: 'server_count', label: 'Sunucu' }, { label: 'Durum', value: u => (u.suspended ? 'askıda' : 'aktif') },
            { key: 'created_at', label: 'Kayıt' }, { key: 'last_login_at', label: 'Son giriş' }, { key: 'last_login_ip', label: 'Son IP' }], lastPage) }),
        btn('Kullanıcı oluştur', { variant: 'primary', iconName: 'plus', onClick: create })]),
    card({ title: 'Hesaplar', iconName: 'users', actions: [search], bodyClass: 'tight', body: listBox }));
    load();
    if (params.sub) openUserDrawer(params.sub, load);
}

async function openUserDrawer(userId, onChange) {
    const body = h('div', {}, loading());
    const modal = openModal({ title: 'Kullanıcı', size: 'lg', body, onClose: () => { if (window.location.hash.startsWith(`#/admin/users/${userId}`)) history.replaceState(null, '', '#/admin/users'); } });
    async function load() {
        let d;
        try { d = await api(`/api/admin/users/${userId}`); } catch (error) { clear(body, errorBox(error)); return; }
        const u = d.user;
        modal.dialog.querySelector('.modal-head h2').textContent = u.username;
        const refresh = () => { load(); if (onChange) onChange(); };
        const act = (label, iconName, fn, opts = {}) => menuItem(label, async () => { try { await fn(); } catch (error) { toastError(error); } }, { iconName, ...opts });
        const locked = u.locked_until && new Date(u.locked_until) > new Date();
        const actions = dropdown(btn('İşlemler', { size: 'sm', iconName: 'more' }), close => h('div', {},
            act('Bakiye ekle / düş', 'wallet', async () => {
                close();
                const r = await formDialog({ title: 'Bakiye düzeltme', intro: `Mevcut bakiye: ${fmtMoney(u.balance)}`, fields: [
                    { name: 'amount', label: 'Tutar (eksi değer düşer)', type: 'number', step: '0.01', required: true, validate: v => (Number(v) === 0 ? 'Sıfırdan farklı bir tutar girin.' : null) },
                    { name: 'reason', label: 'Açıklama (müşteri görür)', required: true, full: true, maxlength: 200 }
                ], submitText: 'Uygula', onSubmit: v => api(`/api/admin/users/${u.id}/balance`, { method: 'POST', body: v }) });
                if (r) { toast('Bakiye güncellendi.', 'success'); refresh(); }
            }),
            act('Şifre sıfırlama bağlantısı', 'key', async () => {
                close();
                const r = await api(`/api/admin/users/${u.id}/reset-link`, { method: 'POST' });
                openModal({ title: 'Sıfırlama bağlantısı', body: h('div', { class: 'form-stack' }, h('p', { class: 'text-2' }, `Bu bağlantıyı kullanıcıya güvenli bir kanaldan iletin. ${r.expiresInHours} saat geçerli ve tek kullanımlık.`), copyable(r.url)) });
            }),
            act('Tüm oturumları kapat', 'logout', async () => {
                close();
                if (!(await confirmDialog({ title: 'Oturumlar kapatılsın mı?', message: `${u.username} tüm cihazlarda çıkış yapacak.`, confirmText: 'Oturumları kapat' }))) return;
                await api(`/api/admin/users/${u.id}/logout`, { method: 'POST' });
                toast('Oturumlar kapatıldı.', 'success');
            }),
            locked ? act('Kilidi aç', 'lock', async () => { close(); await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { unlock: true } }); toast('Hesap kilidi açıldı.', 'success'); refresh(); }) : null,
            act('Sunucularını durdur', 'stop', async () => {
                close();
                if (!(await confirmDialog({ title: 'Sunucular durdurulsun mu?', message: `${u.username} kullanıcısının çalışan tüm sunucuları durdurulacak.`, confirmText: 'Durdur', danger: true }))) return;
                const r = await api(`/api/admin/users/${u.id}/stop-servers`, { method: 'POST' });
                toast(r.message, 'success');
            }),
            menuSep(),
            act(u.suspended ? 'Askıyı kaldır' : 'Hesabı askıya al', 'shield', async () => {
                close();
                if (!u.suspended && !(await confirmDialog({ title: 'Hesap askıya alınsın mı?', message: 'Kullanıcı panele giremez ve tüm sunucuları durdurulur.', confirmText: 'Askıya al', danger: true }))) return;
                await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { suspended: !u.suspended } });
                toast(u.suspended ? 'Hesap yeniden etkinleştirildi.' : 'Hesap askıya alındı.', 'success');
                refresh();
            }, { danger: !u.suspended }),
            act('Kullanıcıyı sil', 'trash', async () => {
                close();
                if (!(await confirmDialog({ title: 'Kullanıcı silinsin mi?', message: `${u.username} ve tüm sunucuları, veritabanları, web siteleri kalıcı olarak silinecek.`, confirmText: 'Kalıcı olarak sil', danger: true, requireText: u.username }))) return;
                await api(`/api/admin/users/${u.id}`, { method: 'DELETE', timeoutMs: 300000 });
                toast('Kullanıcı silindi.', 'success');
                modal.close();
                if (onChange) onChange();
            }, { danger: true })));

        const edit = btn('Düzenle', { size: 'sm', iconName: 'edit', onClick: async () => {
            const r = await formDialog({ title: 'Kullanıcıyı düzenle', fields: [
                { name: 'username', label: 'Kullanıcı adı', value: u.username, required: true, pattern: '[A-Za-z0-9_.\\-]{3,32}' },
                { name: 'email', label: 'E-posta', type: 'email', value: u.email || '' },
                { name: 'role', label: 'Rol', type: 'select', value: u.role, options: [{ value: 'user', label: 'Müşteri' }, { value: 'admin', label: 'Yönetici' }] },
                { name: 'admin_note', label: 'Yönetici notu (yalnızca yöneticiler görür)', type: 'textarea', value: u.admin_note || '' }
            ], onSubmit: v => api(`/api/admin/users/${u.id}`, { method: 'PUT', body: v }) });
            if (r) { toast('Kaydedildi.', 'success'); refresh(); }
        } });

        clear(body, h('div', { class: 'stack' },
            h('div', { class: 'user-head' },
                h('span', { class: 'avatar avatar-lg' }, u.username.slice(0, 1)),
                h('div', {}, h('h2', {}, u.username), h('div', { class: 'small muted' }, u.email || 'e-posta yok')),
                u.suspended ? badge('Askıda', 'danger') : locked ? badge('Kilitli', 'warning') : badge('Aktif', 'success'),
                h('div', { class: 'btn-group' }, edit, actions)),
            h('div', { class: 'grid grid-4' },
                kpi('Bakiye', fmtMoney(u.balance), 'wallet'),
                kpi('Sunucu', String(d.servers.length), 'server'),
                kpi('Kayıt', fmtDate(u.created_at), 'user'),
                kpi('Son giriş', u.last_login_at ? fmtRelative(u.last_login_at) : 'Hiç', 'clock', u.last_login_ip || '')),
            u.admin_note ? h('div', { class: 'alert alert-info' }, icon('info'), h('div', {}, h('strong', {}, 'Yönetici notu'), h('p', {}, u.admin_note))) : null,
            card({ title: 'Sunucuları', iconName: 'server', bodyClass: 'tight', body: table([
                { label: 'Sunucu', render: s => h('a', { href: `#/servers/${s.id}`, onClick: () => modal.close() }, `${s.name} (${s.port})`) },
                { label: 'Paket', key: 'plan_type' },
                { label: 'Bitiş', type: 'date', render: s => fmtDate(s.expires_at) },
                { label: 'Durum', render: s => (s.suspended ? badge('Askıda', 'danger') : badge('Aktif', 'success')) }
            ], d.servers, { empty: 'Sunucusu yok.' }) }),
            card({ title: 'Hesap hareketleri', iconName: 'activity', bodyClass: 'tight', body: table([
                { label: 'Tarih', type: 'date', render: t => fmtDateTime(t.created_at) },
                { label: 'İşlem', render: t => { const [l, v] = TX_TYPES[t.type] || [t.type, '']; return badge(l, v); } },
                { label: 'Açıklama', key: 'description', type: 'wrap' },
                { label: 'Tutar', type: 'money', render: t => h('strong', { class: t.amount > 0 ? 'text-success' : 'text-danger' }, fmtMoney(t.amount)) },
                { label: '', type: 'actions', render: t => (RECEIPT_TYPES.has(t.type) && Number(t.amount) !== 0 ? btn(null, { size: 'xs', variant: 'ghost', iconName: 'receipt', title: 'Makbuz', onClick: () => openReceipt({ transactionId: t.id }) }) : null) }
            ], d.transactions, { empty: 'Hareket yok.', scrollY: true }) }),
            card({ title: 'Ödeme bildirimleri', iconName: 'receipt', bodyClass: 'tight', body: table([
                { label: 'Tarih', type: 'date', render: p => fmtDateTime(p.created_at) },
                { label: 'Tutar', type: 'money', render: p => fmtMoney(p.amount) },
                { label: 'Durum', render: p => paymentStatusBadge(p.status) },
                { label: '', type: 'actions', render: p => (p.receipt_path ? btn('Dekont', { size: 'xs', iconName: 'receipt', onClick: () => viewReceipt(p.receipt_path) }) : null) }
            ], d.payments, { empty: 'Bildirim yok.' }) }),
            card({ title: 'Etkinlik', iconName: 'list', bodyClass: 'tight', body: auditTable(d.audit) })));
    }
    load();
}

// ---------------------------------------------------------------------------
//  Servers
// ---------------------------------------------------------------------------

async function pickUser(title, currentId) {
    const users = (await api('/api/admin/users?limit=500')).users;
    return formDialog({ title, fields: [
        { name: 'userId', label: 'Yeni sahip', type: 'select', value: String(currentId), full: true, options: users.map(u => ({ value: u.id, label: `${u.username}${u.email ? ` (${u.email})` : ''}` })) }
    ], submitText: 'Aktar' });
}

async function renderServers({ root, onCleanup }) {
    const listBox = h('div', {}, loading());
    const filter = select([{ value: 'rented', label: 'Kiralık' }, { value: 'pool', label: 'Boşta (havuz)' }, { value: 'suspended', label: 'Askıda' }, { value: 'expiring', label: '7 gün içinde bitecek' }, { value: 'offline', label: 'Kapalı' }, { value: 'all', label: 'Tümü' }], { value: 'rented', 'aria-label': 'Filtre' });
    const search = searchInput({ placeholder: 'Ad, port, müşteri…', onSearch: () => paint() });
    const selected = new Set();
    const bulkBar = h('div', { class: 'fm-toolbar', hidden: true });

    function filtered() {
        const term = search.control.value.trim().toLowerCase();
        return state.servers.filter(s => {
            if (filter.value === 'rented' && s.is_pool) return false;
            if (filter.value === 'pool' && !s.is_pool) return false;
            if (filter.value === 'suspended' && !s.suspended) return false;
            if (filter.value === 'expiring' && (s.is_pool || s.suspended || daysLeft(s.expires_at) > 7)) return false;
            if (filter.value === 'offline' && s.state === 'running') return false;
            return !term || `${s.name} ${s.port} ${s.owner}`.toLowerCase().includes(term);
        });
    }

    async function bulk(action) {
        const ids = [...selected];
        let message;
        const labels = { start: 'başlatılacak', stop: 'durdurulacak', restart: 'yeniden başlatılacak' };
        if (action === 'say') {
            message = await promptDialog({ title: 'Oyun içi duyuru', label: `${ids.length} sunucuya gönderilecek mesaj`, placeholder: 'Sunucular 5 dakika içinde güncellenecek.' });
            if (!message) return;
        } else if (!(await confirmDialog({ title: 'Toplu işlem', message: `${ids.length} sunucu ${labels[action]}. Çevrimiçi oyuncuların bağlantısı kopabilir.`, confirmText: 'Uygula', danger: action === 'stop' }))) return;
        const t = toast(`${ids.length} sunucuya işlem uygulanıyor…`, 'info', 0);
        try {
            const r = await api('/api/admin/servers/bulk', { method: 'POST', body: { action, ids, message }, timeoutMs: 300000 });
            const failed = r.results.filter(x => !x.ok);
            toast(`${r.results.length - failed.length} başarılı${failed.length ? `, ${failed.length} hata (ilk: ${failed[0].error})` : ''}.`, failed.length ? 'warning' : 'success');
            selected.clear();
            loadServers().catch(() => {});
        } catch (error) { toastError(error); } finally { t.remove(); }
    }

    function paintBulk() {
        bulkBar.hidden = !selected.size;
        clear(bulkBar, selected.size ? [
            h('strong', { class: 'small' }, `${selected.size} sunucu seçili`),
            h('span', { class: 'spacer' }),
            btn('Başlat', { size: 'sm', iconName: 'play', onClick: () => bulk('start') }),
            btn('Yeniden başlat', { size: 'sm', iconName: 'refresh', onClick: () => bulk('restart') }),
            btn('Durdur', { size: 'sm', iconName: 'stop', onClick: () => bulk('stop') }),
            btn('Duyuru gönder', { size: 'sm', iconName: 'megaphone', onClick: () => bulk('say') }),
            btn('Seçimi temizle', { size: 'sm', variant: 'ghost', onClick: () => { selected.clear(); paint(); } })
        ] : []);
    }

    async function serverAction(s, kind) {
        try {
            if (kind === 'extend') {
                const r = await formDialog({ title: `Süre ekle · ${s.port}`, intro: `Mevcut bitiş: ${fmtDate(s.expires_at)}`, fields: [
                    { name: 'days', label: 'Gün (eksi değer düşer)', type: 'number', value: '7', required: true, validate: v => (Number(v) === 0 ? 'Sıfırdan farklı bir değer girin.' : null) },
                    { name: 'reason', label: 'Not (müşteri görür)', full: true, placeholder: 'Örn. Bakım telafisi' }
                ], submitText: 'Uygula', onSubmit: v => api(`/api/admin/servers/${s.id}/extend`, { method: 'POST', body: v }) });
                if (r) toast(`Yeni bitiş: ${fmtDate(r.expires_at)}`, 'success');
            } else if (kind === 'suspend') {
                const reason = await promptDialog({ title: `Askıya al · ${s.port}`, label: 'Sebep (müşteri görür)', value: 'Kural ihlali', confirmText: 'Askıya al' });
                if (reason === null) return;
                await api(`/api/admin/servers/${s.id}/suspend`, { method: 'POST', body: { reason } });
                toast('Sunucu askıya alındı.', 'success');
            } else if (kind === 'unsuspend') {
                if (!(await confirmDialog({ title: 'Askı kaldırılsın mı?', message: `Port ${s.port} yeniden kullanıma açılacak.`, confirmText: 'Askıyı kaldır' }))) return;
                await api(`/api/admin/servers/${s.id}/unsuspend`, { method: 'POST' });
                toast('Askı kaldırıldı.', 'success');
            } else if (kind === 'transfer') {
                const choice = await pickUser(`Sahip değiştir · ${s.port}`, s.owner_id);
                if (!choice) return;
                await api(`/api/admin/servers/${s.id}/transfer`, { method: 'POST', body: choice });
                toast('Sunucu aktarıldı.', 'success');
            } else if (kind === 'plan') {
                const plans = (await api('/api/admin/plans')).plans;
                const r = await formDialog({ title: `Paket değiştir · ${s.port}`, intro: 'Ücret alınmaz. Slot sayısı değişirse sunucu verileri korunarak yeniden oluşturulur.', fields: [
                    { name: 'plan', label: 'Paket', type: 'select', value: s.plan_type, full: true, options: plans.map(p => ({ value: p.slug, label: `${p.name} · ${p.max_players} slot` })) }
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
            { label: allBox, type: 'check', render: s => h('input', { type: 'checkbox', checked: selected.has(s.id), 'aria-label': `${s.port} seç`, onChange: e => { if (e.target.checked) selected.add(s.id); else selected.delete(s.id); paintBulk(); } }) },
            { label: 'Sunucu', key: 'name', render: s => h('div', { class: 'cell-title' }, h('a', { href: `#/servers/${s.id}` }, s.name), h('span', { class: 'mono' }, s.address)), sort: s => s.port },
            { label: 'Müşteri', key: 'owner', render: s => (s.is_pool ? h('span', { class: 'muted' }, 'Havuz') : s.owner), sort: s => (s.is_pool ? '' : String(s.owner || '').toLowerCase()) },
            { label: 'Paket', key: 'plan', hideSm: true, render: s => (s.is_pool ? null : s.plan_name), sort: s => s.plan_name },
            { label: 'Durum', key: 'state', render: s => statusBadge(s), sort: s => (s.suspended ? 3 : s.online ? 0 : s.state === 'running' ? 1 : 2) },
            { label: 'Oyuncu', key: 'players', type: 'num', render: s => (s.online ? `${s.players}/${s.maxPlayers}` : null), sort: s => (s.online ? s.players : -1) },
            { label: 'Bitiş', key: 'expires', type: 'date', render: s => (s.is_pool || daysLeft(s.expires_at) > 3650 ? null : h('span', { class: daysLeft(s.expires_at) <= 3 ? 'text-warning' : '' }, fmtDate(s.expires_at))), sort: s => (s.is_pool ? Infinity : new Date(s.expires_at).getTime()) },
            { label: '', type: 'actions', render: s => moreMenu(close => [
                menuItem('Yönet', () => { close(); navigate(`/servers/${s.id}`); }, { iconName: 'settings' }),
                s.is_pool ? null : [
                    menuItem('Süre ekle / düş', () => { close(); serverAction(s, 'extend'); }, { iconName: 'clock' }),
                    menuItem('Paket değiştir', () => { close(); serverAction(s, 'plan'); }, { iconName: 'tag' }),
                    menuItem('Sahip değiştir', () => { close(); serverAction(s, 'transfer'); }, { iconName: 'users' }),
                    s.suspended ? menuItem('Askıyı kaldır', () => { close(); serverAction(s, 'unsuspend'); }, { iconName: 'play' }) : menuItem('Askıya al', () => { close(); serverAction(s, 'suspend'); }, { iconName: 'lock' }),
                    menuItem('İade et', () => { close(); openRefundApproval({ server: s }).then(ok => { if (ok) loadServers().catch(() => {}); }); }, { iconName: 'wallet' })],
                s.protected ? null : [menuSep(), menuItem('Sil ve havuza al', () => { close(); serverAction(s, 'release'); }, { iconName: 'trash', danger: true })]
            ]) }
        ], rows, { empty: 'Bu filtrede sunucu yok.', initialSort: { key: 'name', dir: 'asc' } }),
        h('div', { class: 'table-foot' }, h('span', {}, `${rows.length} sunucu`)));
        paintBulk();
    }
    filter.addEventListener('change', paint);
    onCleanup(on('servers-updated', paint));

    append(root, head('Tüm Sunucular', 'Müşteri sunucularını yönetin: süre ekleyin, askıya alın, paket veya sahip değiştirin, toplu işlem yapın.', [
        btn('CSV', { iconName: 'download', onClick: () => downloadCsv('sunucular.csv', [
            { key: 'port', label: 'Port' }, { key: 'name', label: 'Ad' }, { label: 'Müşteri', value: s => (s.is_pool ? 'havuz' : s.owner) }, { key: 'plan_name', label: 'Paket' },
            { key: 'state', label: 'Konteyner' }, { label: 'Askıda', value: s => (s.suspended ? 'evet' : 'hayır') }, { key: 'expires_at', label: 'Bitiş' }, { label: 'Oto. yenileme', value: s => (s.auto_renew ? 'açık' : 'kapalı') }], filtered()) }),
        linkBtn('Havuz durumu', '#/admin/infra', { iconName: 'layers' })]),
    card({ title: 'Sunucular', iconName: 'server', actions: [search, filter], bodyClass: 'tight', body: [bulkBar, listBox] }));
    try { await loadServers(); } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); return; }
    paint();
}

// ---------------------------------------------------------------------------
//  Payments
// ---------------------------------------------------------------------------

async function renderPayments({ root, onCleanup }) {
    let status = 'pending';
    let offset = 0;
    let lastPage = [];
    const seg = h('div', { class: 'segmented' });
    const search = searchInput({ placeholder: 'Kullanıcı, gönderen, referans…', onSearch: () => { offset = 0; load(); } });
    const listBox = h('div', {}, loading());
    function paintSeg() {
        clear(seg, [['pending', 'Bekleyen'], ['approved', 'Onaylanan'], ['rejected', 'Reddedilen'], ['', 'Tümü']].map(([v, l]) =>
            h('button', { type: 'button', class: status === v ? 'active' : '', onClick: () => { status = v; offset = 0; paintSeg(); load(); } }, l)));
    }
    async function load(quiet = false) {
        if (!quiet) clear(listBox, loading());
        try {
            const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
            if (status) params.set('status', status);
            if (search.control.value.trim()) params.set('search', search.control.value.trim());
            const data = await api(`/api/payments/admin/list?${params}`);
            lastPage = data.payments;
            clear(listBox, table([
                { label: 'Tarih', type: 'date', render: p => fmtDateTime(p.created_at), sort: p => new Date(p.created_at).getTime() },
                { label: 'Kullanıcı', render: p => h('a', { href: `#/admin/users/${p.user_id}` }, p.username) },
                { label: 'Gönderen', key: 'sender_name', hideSm: true },
                { label: 'Referans', key: 'reference_code', type: 'mono', hideSm: true },
                { label: 'Tutar', type: 'money', render: p => h('strong', {}, fmtMoney(p.amount)), sort: p => Number(p.amount) },
                { label: 'Durum', render: p => h('div', { class: 'cell-title' }, paymentStatusBadge(p.status), p.reviewed_by_name ? h('span', {}, `${p.reviewed_by_name} · ${fmtRelative(p.reviewed_at)}`) : null, p.admin_note ? h('span', {}, p.admin_note) : null) },
                { label: '', type: 'actions', render: p => tableActions(
                    p.receipt_path ? btn('Dekont', { size: 'xs', iconName: 'receipt', onClick: () => viewReceipt(p.receipt_path) }) : null,
                    p.status === 'pending' ? [
                        btn('Onayla', { size: 'xs', variant: 'success', onClick: () => approve(p) }),
                        btn('Reddet', { size: 'xs', variant: 'danger', onClick: () => reject(p) })] : null) }
            ], data.payments, { empty: 'Bu filtrede ödeme bildirimi yok.' }),
            pager({ offset, limit: PAGE, count: data.payments.length, total: data.total, onChange: next => { offset = next; load(); } }));
        } catch (error) { if (!quiet) clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }
    async function approve(p) {
        const r = await formDialog({ title: `Ödemeyi onayla · ${p.username}`, intro: `Bildirilen tutar: ${fmtMoney(p.amount)} · Referans: ${p.reference_code || '—'}. Banka hesabınızdaki tutar farklıysa düzeltin.`, fields: [
            { name: 'amount', label: 'Yüklenecek tutar', type: 'number', step: '0.01', value: String(p.amount), required: true, validate: v => (Number(v) <= 0 ? 'Tutar pozitif olmalı.' : null) },
            { name: 'note', label: 'Not (isteğe bağlı, müşteri görür)', full: true }
        ], submitText: 'Onayla ve yükle', onSubmit: v => api(`/api/payments/admin/${p.id}/approve`, { method: 'POST', body: v }) });
        if (r) { toast('Ödeme onaylandı, bakiye yüklendi.', 'success'); emit('payments-changed'); load(); }
    }
    async function reject(p) {
        const r = await formDialog({ title: `Ödemeyi reddet · ${p.username}`, fields: [
            { name: 'note', label: 'Red sebebi (müşteri görür)', value: 'Hesabımıza bu bilgilerle bir ödeme ulaşmadı.', full: true, type: 'textarea', required: true }
        ], submitText: 'Reddet', danger: true, onSubmit: v => api(`/api/payments/admin/${p.id}/reject`, { method: 'POST', body: v }) });
        if (r) { toast('Ödeme reddedildi.', 'success'); emit('payments-changed'); load(); }
    }
    paintSeg();
    append(root, head('Ödemeler', 'Havale/EFT bildirimlerini banka hesabınızla karşılaştırıp onaylayın veya reddedin.', [
        btn('CSV', { iconName: 'download', onClick: () => downloadCsv('odemeler.csv', [
            { key: 'id', label: 'ID' }, { key: 'created_at', label: 'Tarih' }, { key: 'username', label: 'Kullanıcı' }, { key: 'sender_name', label: 'Gönderen' },
            { key: 'reference_code', label: 'Referans' }, { key: 'amount', label: 'Tutar' }, { key: 'credited_amount', label: 'Yüklenen' }, { key: 'status', label: 'Durum' }, { key: 'admin_note', label: 'Not' }], lastPage) })]),
    card({ title: 'Ödeme bildirimleri', iconName: 'receipt', actions: [search, seg], bodyClass: 'tight', body: listBox }));
    load();
    autoRefresh(onCleanup, () => { if (status === 'pending' && offset === 0) load(true); }, 30000);
}

// ---------------------------------------------------------------------------
//  Refunds & withdrawals
// ---------------------------------------------------------------------------

const SERVER_ACTION_OPTIONS = [
    { value: 'shorten', label: 'İade edilen süreyi düş (önerilen)' },
    { value: 'keep', label: 'Süreye dokunma (iyi niyet iadesi)' },
    { value: 'release', label: 'Sunucuyu sil ve havuza al' }
];

/**
 * Approve a customer request (request) or refund a server directly (server).
 * Shows the prorated breakdown, lets the operator lower the amount and pick
 * what happens to the subscription. Resolves true when money moved.
 */
async function openRefundApproval({ request = null, server = null }) {
    const params = request ? `requestId=${request.id}` : `serverId=${server.dbId}`;
    let data;
    try { data = await api(`/api/admin/refunds/quote?${params}`); } catch (error) { toastError(error); return false; }
    const q = data.quote;
    const breakdown = q.items.length ? h('div', { class: 'refund-breakdown' }, table([
        { label: 'Dönem', render: i => h('div', { class: 'cell-title' }, h('strong', {}, `${i.planName} · ${{ purchase: 'kiralama', renewal: 'uzatma', auto_renewal: 'oto. uzatma' }[i.kind] || i.kind}`), h('span', {}, `${fmtDate(i.startsAt)} → ${fmtDate(i.endsAt)}`)) },
        { label: 'Kalan', type: 'num', render: i => `${i.remainingDays}/${i.totalDays} gün` },
        { label: 'Ödenen', type: 'money', render: i => fmtMoney(i.paid - i.alreadyRefunded) },
        { label: 'İade', type: 'money', render: i => h('strong', {}, fmtMoney(i.amount)) }
    ], q.items)) : h('div', { class: 'alert alert-warning' }, icon('alert'), h('div', {}, h('strong', {}, q.legacy ? 'Ödeme dökümü yok' : 'İade edilebilir süre yok'),
        h('p', {}, q.legacy ? 'Bu kiralama dönem kaydı tutulmadan önce yapılmış. Tutarı elle girin; "İade edilen süreyi düş" seçilirse abonelik hemen sona erer.' : 'Ödenmiş ve kullanılmamış süre kalmamış. Gerekirse iyi niyet iadesi için tutarı elle girin.')));
    const result = await formDialog({
        title: request ? `İade talebi #${request.id} · ${request.username}` : `İade et · Port ${data.server.port}`,
        size: 'lg',
        intro: request ? `Sebep: ${request.reason || '—'}` : `${data.server.name} · bitiş ${fmtDate(data.server.expires_at)}`,
        fields: [
            { name: 'breakdown', type: 'custom', full: true, render: () => h('div', { class: 'stack stack-sm' }, breakdown,
                q.fee ? h('div', { class: 'summary-line' }, h('span', {}, `İade kesintisi (%${q.feePercent})`), h('span', { class: 'text-danger' }, `-${fmtMoney(q.fee)}`)) : null,
                h('div', { class: 'summary-line total' }, h('span', {}, 'Hesaplanan iade'), h('span', {}, fmtMoney(q.total)))) },
            { name: 'amount', label: 'İade tutarı', type: 'number', step: '0.01', min: 0.01, value: q.total ? String(q.total) : '', required: true,
                help: q.legacy ? 'Ödeme dökümü olmadığı için tutarı siz belirleyin.' : `En fazla ${fmtMoney(q.total)}.`,
                validate: v => (Number(v) <= 0 ? 'Tutar pozitif olmalı.' : (!q.legacy && Number(v) > q.total + 0.001 ? `En fazla ${fmtMoney(q.total)} iade edilebilir.` : null)) },
            { name: 'serverAction', label: 'Sunucuya ne olsun?', type: 'select', value: 'shorten', options: SERVER_ACTION_OPTIONS },
            { name: 'note', label: 'Not (müşteri görür)', full: true, maxlength: 255 }
        ],
        submitText: 'İadeyi onayla',
        onSubmit: async v => {
            if (v.serverAction === 'release' && !(await confirmDialog({ title: 'Sunucu silinecek', message: 'İade sonrası sunucunun tüm dosyaları, veritabanı ve web sitesi silinip port havuza alınacak.', confirmText: 'Sil ve iade et', danger: true }))) {
                throw new Error('İşlem iptal edildi.');
            }
            const body = { amount: v.amount, serverAction: v.serverAction, note: v.note };
            return request
                ? api(`/api/admin/refunds/${request.id}/approve`, { method: 'POST', body, timeoutMs: 180000 })
                : api('/api/admin/refunds/direct', { method: 'POST', body: { ...body, containerId: server.id }, timeoutMs: 180000 });
        }
    });
    if (!result) return false;
    toast(`${fmtMoney(result.amount)} iade edildi · makbuz ${result.receipt.number}`, 'success');
    emit('billing-changed');
    return true;
}

async function renderRefunds({ root, query, onCleanup }) {
    let tab = query.get('tab') === 'withdrawals' ? 'withdrawals' : 'refunds';
    let status = 'pending';
    let offset = 0;
    const seg = h('div', { class: 'segmented' });
    const statusSeg = h('div', { class: 'segmented' });
    const box = h('div', {}, loading());

    function paintSeg() {
        clear(seg, [['refunds', 'İade talepleri'], ['withdrawals', 'Para çekme']].map(([v, l]) =>
            h('button', { type: 'button', class: tab === v ? 'active' : '', onClick: () => { tab = v; offset = 0; paintSeg(); load(); } }, l)));
        const statuses = tab === 'refunds'
            ? [['pending', 'Bekleyen'], ['approved', 'Onaylanan'], ['rejected', 'Reddedilen'], ['', 'Tümü']]
            : [['pending', 'Bekleyen'], ['paid', 'Ödenen'], ['rejected', 'Reddedilen'], ['', 'Tümü']];
        if (!statuses.some(([v]) => v === status)) status = 'pending';
        clear(statusSeg, statuses.map(([v, l]) => h('button', { type: 'button', class: status === v ? 'active' : '', onClick: () => { status = v; offset = 0; paintSeg(); load(); } }, l)));
    }

    async function load() {
        clear(box, loading());
        const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
        if (status) params.set('status', status);
        try {
            if (tab === 'refunds') {
                const data = await api(`/api/admin/refunds?${params}`);
                clear(box, table([
                    { label: 'Tarih', type: 'date', render: r => fmtDateTime(r.created_at) },
                    { label: 'Müşteri', render: r => h('a', { href: `#/admin/users/${r.user_id}` }, r.username) },
                    { label: 'Sunucu', render: r => (r.container_id ? h('a', { href: `#/servers/${r.container_id}` }, r.server_name || `Port ${r.port}`) : `Port ${r.port || '—'}`) },
                    { label: 'Sebep', type: 'wrap', key: 'reason', hideSm: true },
                    { label: 'Tutar', type: 'money', render: r => h('div', { class: 'cell-title' }, h('strong', {}, fmtMoney(r.approved_amount ?? r.quoted_amount)), r.approved_amount !== null && r.approved_amount !== r.quoted_amount ? h('span', {}, `talep: ${fmtMoney(r.quoted_amount)}`) : null) },
                    { label: 'Durum', render: r => h('div', { class: 'cell-title' }, requestStatusBadge(r.status), r.reviewed_by_name ? h('span', {}, `${r.reviewed_by_name} · ${fmtRelative(r.reviewed_at)}`) : null, r.admin_note ? h('span', {}, r.admin_note) : null) },
                    { label: '', type: 'actions', render: r => (r.status === 'pending' ? tableActions(
                        btn('İncele ve onayla', { size: 'xs', variant: 'success', onClick: async () => { if (await openRefundApproval({ request: r })) load(); } }),
                        btn('Reddet', { size: 'xs', variant: 'danger', onClick: async () => {
                            const ok = await formDialog({ title: `İade talebini reddet · ${r.username}`, fields: [{ name: 'note', label: 'Red sebebi (müşteri görür)', type: 'textarea', required: true, full: true }],
                                submitText: 'Reddet', danger: true, onSubmit: v => api(`/api/admin/refunds/${r.id}/reject`, { method: 'POST', body: v }) });
                            if (ok) { toast('Talep reddedildi.', 'success'); emit('billing-changed'); load(); }
                        } })) : (r.transaction_id ? btn(null, { size: 'xs', variant: 'ghost', iconName: 'receipt', title: 'Makbuz', onClick: () => openReceipt({ transactionId: r.transaction_id }) }) : null)) }
                ], data.requests, { empty: 'Bu filtrede iade talebi yok.' }),
                pager({ offset, limit: PAGE, count: data.requests.length, total: data.total, onChange: n => { offset = n; load(); } }));
            } else {
                const data = await api(`/api/admin/withdrawals?${params}`);
                clear(box, table([
                    { label: 'Tarih', type: 'date', render: w => fmtDateTime(w.created_at) },
                    { label: 'Müşteri', render: w => h('a', { href: `#/admin/users/${w.user_id}` }, w.username) },
                    { label: 'Hesap', render: w => h('div', { class: 'cell-title' }, h('strong', {}, w.account_holder), h('span', { class: 'mono' }, w.iban.replace(/(.{4})/g, '$1 ').trim())) },
                    { label: 'Tutar', type: 'money', render: w => h('strong', {}, fmtMoney(w.amount)) },
                    { label: 'Durum', render: w => h('div', { class: 'cell-title' }, requestStatusBadge(w.status), w.payout_reference ? h('span', {}, `Ref. ${w.payout_reference}`) : null, w.admin_note ? h('span', {}, w.admin_note) : null) },
                    { label: '', type: 'actions', render: w => (w.status === 'pending' ? tableActions(
                        btn('Kopyala', { size: 'xs', iconName: 'copy', title: 'IBAN ve tutarı kopyala', onClick: () => navigator.clipboard.writeText(`${w.account_holder}\n${w.iban}\n${Number(w.amount).toFixed(2)}`).then(() => toast('Ödeme bilgileri kopyalandı.', 'success', 1800)).catch(() => {}) }),
                        btn('Ödendi', { size: 'xs', variant: 'success', onClick: async () => {
                            const ok = await formDialog({ title: `Ödendi olarak işaretle · ${fmtMoney(w.amount)}`, intro: `${w.account_holder} · ${w.iban}`, fields: [
                                { name: 'reference', label: 'Banka işlem referansı', placeholder: 'Örn. EFT sorgu no', maxlength: 100 },
                                { name: 'note', label: 'Not (müşteri görür)', full: true, maxlength: 255 }
                            ], submitText: 'Ödendi', onSubmit: v => api(`/api/admin/withdrawals/${w.id}/paid`, { method: 'POST', body: v }) });
                            if (ok) { toast('Çekim ödendi olarak işaretlendi; makbuz kesildi.', 'success'); emit('billing-changed'); load(); }
                        } }),
                        btn('Reddet', { size: 'xs', variant: 'danger', onClick: async () => {
                            const ok = await formDialog({ title: 'Çekimi reddet', intro: 'Tutar müşterinin bakiyesine geri yüklenir.', fields: [{ name: 'note', label: 'Red sebebi (müşteri görür)', type: 'textarea', required: true, full: true }],
                                submitText: 'Reddet', danger: true, onSubmit: v => api(`/api/admin/withdrawals/${w.id}/reject`, { method: 'POST', body: v }) });
                            if (ok) { toast('Çekim reddedildi, tutar bakiyeye iade edildi.', 'success'); emit('billing-changed'); load(); }
                        } })) : null) }
                ], data.withdrawals, { empty: 'Bu filtrede çekim talebi yok.' }),
                pager({ offset, limit: PAGE, count: data.withdrawals.length, total: data.total, onChange: n => { offset = n; load(); } }));
            }
        } catch (error) { clear(box, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    paintSeg();
    append(root,
        head('İadeler & Çekimler', 'Müşterilerin kalan süre iadesi taleplerini ve bakiye çekme taleplerini yönetin. Onaylanan her işlem için numaralı makbuz kesilir.', [
            linkBtn('İade ayarları', '#/admin/settings', { iconName: 'settings' })]),
        card({ title: 'Talepler', iconName: 'refresh', actions: [statusSeg, seg], bodyClass: 'tight', body: box }));
    load();
    autoRefresh(onCleanup, () => { if (status === 'pending' && offset === 0) load(); }, 30000);
}

// ---------------------------------------------------------------------------
//  Transactions (global ledger)
// ---------------------------------------------------------------------------

async function renderTransactions({ root }) {
    let offset = 0;
    let lastPage = [];
    const type = select([{ value: '', label: 'Tüm hareketler' }, ...Object.entries(TX_TYPES).map(([v, [l]]) => ({ value: v, label: l }))], { value: '', 'aria-label': 'Hareket türü' });
    const listBox = h('div', {}, loading());
    const summary = h('span', { class: 'small muted' });
    async function load() {
        clear(listBox, loading());
        try {
            const data = await api(`/api/admin/transactions?limit=${PAGE}&offset=${offset}${type.value ? `&type=${type.value}` : ''}`);
            lastPage = data.transactions;
            const sum = data.transactions.reduce((s, t) => s + Number(t.amount), 0);
            summary.textContent = `Bu sayfa: ${fmtMoney(sum)}`;
            clear(listBox, table([
                { label: 'Tarih', type: 'date', render: t => fmtDateTime(t.created_at) },
                { label: 'Kullanıcı', render: t => h('a', { href: `#/admin/users/${t.user_id}` }, t.username) },
                { label: 'İşlem', render: t => { const [l, v] = TX_TYPES[t.type] || [t.type, '']; return badge(l, v); } },
                { label: 'Açıklama', key: 'description', type: 'wrap', hideSm: true },
                { label: 'Tutar', type: 'money', render: t => h('strong', { class: t.amount > 0 ? 'text-success' : 'text-danger' }, fmtMoney(t.amount)) },
                { label: 'Sonraki bakiye', type: 'money', hideSm: true, render: t => fmtMoney(t.balance_after) }
            ], data.transactions, { empty: 'Hareket yok.' }),
            pager({ offset, limit: PAGE, count: data.transactions.length, total: data.total, onChange: next => { offset = next; load(); } }));
        } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }
    type.addEventListener('change', () => { offset = 0; load(); });
    append(root, head('Hesap Hareketleri', 'Tüm müşterilerin bakiye defteri: yüklemeler, kiralamalar, yenilemeler, iadeler ve düzeltmeler.', [
        btn('CSV', { iconName: 'download', onClick: () => downloadCsv('hesap-hareketleri.csv', [
            { key: 'id', label: 'ID' }, { key: 'created_at', label: 'Tarih' }, { key: 'username', label: 'Kullanıcı' }, { key: 'type', label: 'Tür' },
            { key: 'description', label: 'Açıklama' }, { key: 'amount', label: 'Tutar' }, { key: 'balance_after', label: 'Sonraki bakiye' }], lastPage) })]),
    card({ title: 'Defter', iconName: 'activity', actions: [summary, type], bodyClass: 'tight', body: listBox }));
    load();
}

// ---------------------------------------------------------------------------
//  Plans & coupons
// ---------------------------------------------------------------------------

function planFields(p = {}) {
    return [
        { name: 'slug', label: 'Kod (değiştirilemez)', value: p.slug || '', placeholder: 'ornek: premium', required: true, help: 'Küçük harf, rakam, - ve _ (2-32 karakter).', validate: v => (validators.slug(v.trim()) ? null : 'Geçersiz kod.') },
        { name: 'name', label: 'Paket adı', value: p.name || '', required: true, maxlength: 64 },
        { name: 'price', label: 'Fiyat (dönem başına)', type: 'number', step: '0.01', min: 0, value: p.price ?? '', required: true },
        { name: 'duration_days', label: 'Dönem (gün)', type: 'number', min: 1, value: p.duration_days ?? 30, required: true },
        { name: 'max_players', label: 'Slot', type: 'number', value: p.max_players ?? 24, min: 2, max: 32, required: true },
        { name: 'sort_order', label: 'Sıra', type: 'number', value: p.sort_order ?? 0 },
        { name: 'description', label: 'Kısa açıklama', value: p.description || '', full: true },
        { name: 'features', label: 'Özellikler (her satıra bir tane)', type: 'textarea', value: (p.features || []).join('\n') },
        { name: 'active', type: 'checkbox', checkLabel: 'Satışta', value: p.active !== false },
        { name: 'highlighted', type: 'checkbox', checkLabel: '"En popüler" olarak öne çıkar', value: !!p.highlighted },
        { name: 'is_trial', type: 'checkbox', checkLabel: 'Deneme paketi (hesap başına bir kez, uzatılamaz)', value: !!p.is_trial }
    ];
}

function couponFields(plans, c = null) {
    const toDate = v => (v ? new Date(v).toISOString().slice(0, 10) : '');
    return [
        c ? null : { name: 'code', label: 'Kod', placeholder: 'YAZ25', required: true, pattern: '[A-Za-z0-9_-]{3,32}', help: '3-32 karakter; harf, rakam, - _' },
        c ? null : { name: 'type', label: 'Tür', type: 'select', value: 'percent', options: [{ value: 'percent', label: 'Yüzde (%)' }, { value: 'fixed', label: 'Sabit tutar' }] },
        { name: 'value', label: c && c.type === 'fixed' ? 'Tutar' : 'Değer', type: 'number', step: '0.01', min: 0, value: c ? String(c.value) : '', required: true,
            validate: (v, values) => (Number(v) <= 0 ? 'Pozitif bir değer girin.' : ((values.type || (c && c.type)) === 'percent' && Number(v) > 100 ? 'Yüzde 100\'ü geçemez.' : null)) },
        { name: 'max_uses', label: 'Toplam kullanım limiti', type: 'number', min: 1, value: c && c.max_uses ? String(c.max_uses) : '', placeholder: 'Boş = sınırsız' },
        { name: 'per_user_limit', label: 'Kişi başı limit', type: 'number', min: 1, value: c ? String(c.per_user_limit) : '1' },
        { name: 'plan_slug', label: 'Geçerli paket', type: 'select', value: c ? c.plan_slug || '' : '', options: [{ value: '', label: 'Tüm paketler' }, ...plans.map(p => ({ value: p.slug, label: p.name }))] },
        { name: 'expires_at', label: 'Bitiş tarihi', type: 'date', value: c ? toDate(c.expires_at) : '' }
    ].filter(Boolean);
}

async function renderPlans({ root }) {
    const plansBox = h('div', {}, loading());
    const couponsBox = h('div', {}, loading());
    let plans = [];

    async function loadPlans() {
        try {
            const data = await api('/api/admin/plans');
            plans = data.plans;
            clear(plansBox, table([
                { label: 'Paket', render: p => h('div', { class: 'cell-title' }, h('strong', {}, p.name), h('span', { class: 'mono' }, p.slug)) },
                { label: 'Fiyat', type: 'money', render: p => `${fmtMoney(p.price)} / ${p.duration_days} gün` },
                { label: 'Slot', type: 'num', key: 'max_players' },
                { label: 'Sunucu', type: 'num', render: p => String(p.servers) },
                { label: 'Durum', render: p => h('div', { class: 'row row-sm' }, p.active ? badge('Satışta', 'success') : badge('Pasif'), p.is_trial ? badge('Deneme', 'info') : null, p.highlighted ? badge('Öne çıkan', 'accent') : null) },
                { label: '', type: 'actions', render: p => tableActions(
                    btn(null, { size: 'xs', variant: 'ghost', iconName: 'edit', title: 'Düzenle', onClick: async () => {
                        const r = await formDialog({ title: `${p.name} paketini düzenle`, size: 'lg', fields: planFields(p).filter(f => f.name !== 'slug'), onSubmit: v => api(`/api/admin/plans/${p.id}`, { method: 'PUT', body: v }) });
                        if (r) { toast('Paket güncellendi.', 'success'); loadPlans(); }
                    } }),
                    btn(null, { size: 'xs', variant: 'danger', iconName: 'trash', title: 'Sil', disabled: p.servers > 0, onClick: async () => {
                        if (!(await confirmDialog({ title: 'Paket silinsin mi?', message: `${p.name} paketi kalıcı olarak silinecek.`, confirmText: 'Sil', danger: true }))) return;
                        try { await api(`/api/admin/plans/${p.id}`, { method: 'DELETE' }); toast('Paket silindi.', 'success'); loadPlans(); } catch (error) { toastError(error); }
                    } })) }
            ], data.plans));
        } catch (error) { clear(plansBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    async function loadCoupons() {
        try {
            const data = await api('/api/admin/coupons');
            clear(couponsBox, table([
                { label: 'Kod', key: 'code', type: 'mono' },
                { label: 'İndirim', type: 'num', render: c => (c.type === 'percent' ? `%${c.value}` : fmtMoney(c.value)) },
                { label: 'Kullanım', type: 'num', render: c => `${c.used_count}${c.max_uses ? ` / ${c.max_uses}` : ''}` },
                { label: 'Paket', render: c => c.plan_slug || 'Tümü', hideSm: true },
                { label: 'Bitiş', type: 'date', render: c => (c.expires_at ? fmtDate(c.expires_at) : 'Süresiz') },
                { label: 'Aktif', render: c => switchControl(h('span', { class: 'sr-only' }, `${c.code} aktif`), c.active, async (checked, el) => {
                    try { await api(`/api/admin/coupons/${c.id}`, { method: 'PUT', body: { active: checked } }); toast(checked ? 'Kupon etkin.' : 'Kupon durduruldu.', 'success', 1800); } catch (error) { el.checked = !checked; toastError(error); }
                }) },
                { label: '', type: 'actions', render: c => tableActions(
                    btn(null, { size: 'xs', variant: 'ghost', iconName: 'edit', title: 'Düzenle', onClick: async () => {
                        const r = await formDialog({ title: `${c.code} kuponunu düzenle`, fields: couponFields(plans, c), onSubmit: v => api(`/api/admin/coupons/${c.id}`, { method: 'PUT', body: v }) });
                        if (r) { toast('Kupon güncellendi.', 'success'); loadCoupons(); }
                    } }),
                    btn(null, { size: 'xs', variant: 'danger', iconName: 'trash', title: 'Sil', onClick: async () => {
                        if (!(await confirmDialog({ title: 'Kupon silinsin mi?', message: `${c.code} kuponu silinecek. Kullanım geçmişi korunur.`, confirmText: 'Sil', danger: true }))) return;
                        try { await api(`/api/admin/coupons/${c.id}`, { method: 'DELETE' }); toast('Kupon silindi.', 'success'); loadCoupons(); } catch (error) { toastError(error); }
                    } })) }
            ], data.coupons, { empty: 'Kupon yok.' }));
        } catch (error) { clear(couponsBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    const newPlan = async () => {
        const r = await formDialog({ title: 'Yeni paket', size: 'lg', fields: planFields(), submitText: 'Oluştur', onSubmit: v => api('/api/admin/plans', { method: 'POST', body: v }) });
        if (r) { toast('Paket oluşturuldu.', 'success'); loadPlans(); }
    };
    const newCoupon = async () => {
        const r = await formDialog({ title: 'Yeni kupon', fields: couponFields(plans), submitText: 'Oluştur', onSubmit: v => api('/api/admin/coupons', { method: 'POST', body: v }) });
        if (r) { toast('Kupon oluşturuldu.', 'success'); loadCoupons(); }
    };

    append(root,
        head('Paketler & Kuponlar', 'Satış paketlerinizi, fiyatlarınızı ve kampanya kuponlarınızı yönetin.'),
        card({ title: 'Paketler', iconName: 'tag', sub: 'Dönem indirimleri Sistem Ayarları > Dönem İndirimleri alanından yönetilir. Kullanımdaki paketler silinemez; pasif yapabilirsiniz.', actions: [btn('Yeni paket', { variant: 'primary', iconName: 'plus', onClick: newPlan })], bodyClass: 'tight', body: plansBox }),
        card({ title: 'Kuponlar', iconName: 'receipt', actions: [btn('Yeni kupon', { variant: 'primary', iconName: 'plus', onClick: newCoupon })], bodyClass: 'tight', body: couponsBox }));
    await loadPlans();
    loadCoupons();
}

// ---------------------------------------------------------------------------
//  Announcements
// ---------------------------------------------------------------------------

async function renderAnnouncements({ root }) {
    const listBox = h('div', {}, loading());
    const LEVELS = { info: ['Bilgi', 'info'], success: ['Başarı', 'success'], warning: ['Uyarı', 'warning'], danger: ['Kritik', 'danger'] };
    const fields = (a = null) => [
        { name: 'title', label: 'Başlık', required: true, full: true, maxlength: 160, value: a ? a.title : '' },
        { name: 'body', label: 'Metin', type: 'textarea', maxlength: 2000, value: a ? a.body || '' : '' },
        { name: 'level', label: 'Seviye', type: 'select', value: a ? a.level : 'info', options: Object.entries(LEVELS).map(([v, [l]]) => ({ value: v, label: l })) },
        { name: 'expires_at', label: 'Bitiş (isteğe bağlı)', type: 'date', value: a && a.expires_at ? new Date(a.expires_at).toISOString().slice(0, 10) : '' },
        a ? null : { name: 'notify', type: 'checkbox', checkLabel: 'Tüm kullanıcılara bildirim olarak da gönder', value: false }
    ].filter(Boolean);
    async function load() {
        try {
            const data = await api('/api/admin/announcements');
            clear(listBox, table([
                { label: 'Duyuru', type: 'wrap', render: a => h('div', { class: 'cell-title' }, h('strong', {}, a.title), a.body ? h('span', { class: 'pre-line' }, a.body) : null) },
                { label: 'Seviye', render: a => badge(...(LEVELS[a.level] || [a.level, ''])) },
                { label: 'Yayın', type: 'date', render: a => `${fmtDate(a.created_at)}${a.expires_at ? ` → ${fmtDate(a.expires_at)}` : ''}` },
                { label: 'Aktif', render: a => switchControl(h('span', { class: 'sr-only' }, 'Aktif'), !!a.active, async (checked, el) => {
                    try { await api(`/api/admin/announcements/${a.id}`, { method: 'PUT', body: { active: checked } }); toast(checked ? 'Duyuru yayında.' : 'Duyuru gizlendi.', 'success', 1800); } catch (error) { el.checked = !checked; toastError(error); }
                }) },
                { label: '', type: 'actions', render: a => tableActions(
                    btn(null, { size: 'xs', variant: 'ghost', iconName: 'edit', title: 'Düzenle', onClick: async () => {
                        const r = await formDialog({ title: 'Duyuruyu düzenle', fields: fields(a), onSubmit: v => api(`/api/admin/announcements/${a.id}`, { method: 'PUT', body: v }) });
                        if (r) { toast('Duyuru güncellendi.', 'success'); load(); }
                    } }),
                    btn(null, { size: 'xs', variant: 'danger', iconName: 'trash', title: 'Sil', onClick: async () => {
                        if (!(await confirmDialog({ title: 'Duyuru silinsin mi?', message: a.title, confirmText: 'Sil', danger: true }))) return;
                        try { await api(`/api/admin/announcements/${a.id}`, { method: 'DELETE' }); toast('Duyuru silindi.', 'success'); load(); } catch (error) { toastError(error); }
                    } })) }
            ], data.announcements, { empty: 'Duyuru yok.' }));
        } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }
    const create = async () => {
        const r = await formDialog({ title: 'Yeni duyuru', fields: fields(), submitText: 'Yayınla', onSubmit: v => api('/api/admin/announcements', { method: 'POST', body: v }) });
        if (r) { toast('Duyuru yayınlandı.', 'success'); load(); }
    };
    append(root, head('Duyurular', 'Panelin üstünde tüm kullanıcılara gösterilen bant duyuruları.', [btn('Yeni duyuru', { variant: 'primary', iconName: 'plus', onClick: create })]),
        card({ title: 'Yayındaki ve geçmiş duyurular', iconName: 'megaphone', bodyClass: 'tight', body: listBox }));
    load();
}

// ---------------------------------------------------------------------------
//  Infrastructure
// ---------------------------------------------------------------------------

function usageMeter(label, used, total, meta) {
    const pct = total ? used / total * 100 : 0;
    return h('div', { class: 'meter' },
        h('div', { class: 'row row-sm' }, h('span', { class: 'small text-2' }, label), h('span', { class: 'spacer' }), h('strong', { class: 'small tabular' }, `%${pct.toFixed(0)}`)),
        h('div', { class: `meter-bar ${pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : ''}` }, h('div', { style: { width: `${Math.min(100, pct)}%` } })),
        h('span', { class: 'small muted' }, meta));
}

async function renderInfra({ root, isCurrent, onCleanup }) {
    const body = h('div', { class: 'stack' }, loading());
    const resourcesBox = h('div', {}, loading('Sunucu kaynakları ölçülüyor…'));
    const dbBox = h('div', {}, loading());
    const dbUsersBox = h('div', {}, loading());

    async function loadResources() {
        try {
            const data = await api('/api/admin/resources', { timeoutMs: 30000 });
            clear(resourcesBox, table([
                { label: 'Sunucu', key: 'port', render: s => h('div', { class: 'cell-title' }, h('a', { href: `#/servers/${s.containerId}` }, s.name || `Port ${s.port}`), h('span', { class: 'mono' }, String(s.port))), sort: s => s.port },
                { label: 'Müşteri', key: 'owner', render: s => (s.isPool ? h('span', { class: 'muted' }, 'Havuz') : s.owner), sort: s => s.owner || '' },
                { label: 'CPU', key: 'cpu', type: 'num', render: s => (s.cpu === null ? null : h('span', { class: s.cpu >= 80 ? 'text-danger' : s.cpu >= 50 ? 'text-warning' : '' }, `%${s.cpu.toFixed(1)}`)), sort: s => s.cpu || 0 },
                { label: 'Bellek', key: 'memory', type: 'num', render: s => (s.memory === null ? null : fmtBytes(s.memory)), sort: s => s.memory || 0 },
                { label: 'Ağ (toplam)', type: 'num', hideSm: true, render: s => (s.network ? `↓${fmtBytes(s.network.rx)} ↑${fmtBytes(s.network.tx)}` : null) }
            ], data.servers, { empty: 'Çalışan oyun sunucusu yok.', scrollY: true, initialSort: { key: 'cpu', dir: 'desc' } }),
            h('div', { class: 'table-foot' }, h('span', {}, `${data.servers.length} çalışan · ${data.stopped} kapalı`)));
        } catch (error) { clear(resourcesBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    async function loadDbs() {
        try {
            const data = await api('/api/mysql/databases');
            clear(dbBox, table([
                { label: 'Veritabanı', key: 'name', type: 'mono', sort: d => d.name },
                { label: 'Tablo', type: 'num', render: d => String(d.tables ?? 0) },
                { label: 'Boyut', type: 'num', render: d => fmtBytes(d.size), sort: d => d.size || 0 },
                { label: '', type: 'actions', render: d => (d.system ? badge('Sistem') : btn(null, { size: 'xs', variant: 'danger', iconName: 'trash', title: 'Sil', onClick: async () => {
                    if (!(await confirmDialog({ title: 'Veritabanı silinsin mi?', message: `${d.name} kalıcı olarak silinecek. Bir sunucuya aitse o sunucunun eklentileri ve web sitesi veritabanına erişemez.`, confirmText: 'Sil', danger: true, requireText: d.name }))) return;
                    try { await api(`/api/mysql/databases/${enc(d.name)}`, { method: 'DELETE' }); toast('Veritabanı silindi.', 'success'); loadDbs(); } catch (error) { toastError(error); }
                } })) }
            ], data.databases, { scrollY: true }));
        } catch (error) { clear(dbBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    async function loadDbUsers() {
        try {
            const data = await api('/api/mysql/users');
            const serverUsers = new Map(state.servers.filter(s => s.sql).map(s => [s.sql.username, s]));
            const SYSTEM = new Set(['root', 'mysql', 'mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys', 'debian-sys-maint']);
            clear(dbUsersBox, table([
                { label: 'Kullanıcı', render: u => h('span', { class: 'mono' }, `${u.user}@${u.host}`), sort: u => u.user },
                { label: 'Bağlı olduğu', render: u => (SYSTEM.has(u.user) ? badge('Sistem') : serverUsers.has(u.user) ? h('a', { href: `#/servers/${serverUsers.get(u.user).id}` }, `Port ${serverUsers.get(u.user).port}`) : h('span', { class: 'muted' }, 'Manuel')) },
                { label: '', type: 'actions', render: u => (SYSTEM.has(u.user) ? null : btn(null, { size: 'xs', variant: 'danger', iconName: 'trash', title: 'Sil', onClick: async () => {
                    const linked = serverUsers.get(u.user);
                    if (!(await confirmDialog({ title: 'MySQL kullanıcısı silinsin mi?', message: linked ? `Bu hesap Port ${linked.port} sunucusuna ait! Silinirse eklentiler ve web sitesi veritabanına bağlanamaz (sunucu sayfasından "Hesabı onar" ile geri oluşturulabilir).` : `${u.user}@${u.host} silinecek.`, confirmText: 'Sil', danger: true, requireText: u.user }))) return;
                    try { await api('/api/mysql/users', { method: 'DELETE', body: { username: u.user, host: u.host } }); toast('Kullanıcı silindi.', 'success'); loadDbUsers(); } catch (error) { toastError(error); }
                } })) }
            ], data.users, { scrollY: true }));
        } catch (error) { clear(dbUsersBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    async function load() {
        let infra;
        let pool;
        let health = null;
        try {
            [infra, pool, health] = await Promise.all([api('/api/admin/infra'), api('/api/admin/pool'), api('/api/health').catch(() => null)]);
        } catch (error) { clear(body, errorBox(error)); return; }
        if (!isCurrent()) return;
        const statusVariant = { available: 'success', rented: 'accent', missing: 'danger' };
        const statusLabel = { available: 'Boşta', rented: 'Kiralık', missing: 'Eksik' };
        const host = infra.host || {};
        const restart = c => async e => {
            if (!(await confirmDialog({ title: `${c.name} yeniden başlatılsın mı?`, message: c.name.includes('php') ? 'Tüm müşteri web siteleri birkaç saniye erişilemez olacak.' : 'FastDL indirmeleri birkaç saniye kesilecek.', confirmText: 'Yeniden başlat' }))) return;
            await withBusy(e.currentTarget, async () => {
                try { const r = await api(`/api/admin/infra/${enc(c.name)}/restart`, { method: 'POST', timeoutMs: 120000 }); toast(r.message, 'success'); setTimeout(load, 1500); } catch (error) { toastError(error); }
            });
        };
        clear(body,
            h('div', { class: 'grid grid-aside' },
                card({ title: 'Sunucu makinesi', iconName: 'cpu', sub: host.hostname ? `${host.hostname} · ${host.cpus} çekirdek · ${Math.round((host.uptimeSeconds || 0) / 86400)} gün çalışıyor` : null,
                    body: h('div', { class: 'grid grid-3' },
                        usageMeter('İşlemci yükü (1 dk)', (host.loadavg || [0])[0], host.cpus || 1, `Yük: ${(host.loadavg || []).map(v => v.toFixed(2)).join(' / ')}`),
                        usageMeter('Bellek', (host.totalmem || 0) - (host.freemem || 0), host.totalmem || 1, `${fmtBytes((host.totalmem || 0) - (host.freemem || 0))} / ${fmtBytes(host.totalmem)}`),
                        host.disk ? usageMeter('Veri diski', host.disk.total - host.disk.free, host.disk.total, `${fmtBytes(host.disk.free)} boş / ${fmtBytes(host.disk.total)}`) : h('div', { class: 'small muted' }, 'Disk bilgisi alınamadı'))
                }),
                card({ title: 'Panel', iconName: 'activity', body: h('dl', { class: 'kv' },
                    h('dt', {}, 'Durum'), h('dd', {}, health && health.ok !== false ? badge('Sağlıklı', 'success') : badge('Sorunlu', 'danger')),
                    h('dt', {}, 'Node.js'), h('dd', {}, infra.node),
                    h('dt', {}, 'Çalışma süresi'), h('dd', {}, `${Math.floor(infra.uptimeSeconds / 3600)} sa ${Math.floor((infra.uptimeSeconds % 3600) / 60)} dk`),
                    h('dt', {}, 'MySQL'), h('dd', {}, infra.mysql.version ? `${infra.mysql.version}` : badge('Çevrimdışı', 'danger'))) })),
            card({ title: 'Servis konteynerleri', iconName: 'layers', bodyClass: 'tight', body: table([
                { label: 'Servis', render: c => h('span', { class: 'row row-sm' }, h('span', { class: `dot dot-${c.state === 'running' ? 'online' : 'offline'}` }), h('span', { class: 'mono' }, c.name)) },
                { label: 'Durum', render: c => h('div', { class: 'cell-title' }, h('span', {}, c.state === 'running' ? 'Çalışıyor' : c.state === 'missing' ? 'Bulunamadı' : c.state), h('span', {}, c.status)) },
                { label: 'CPU', type: 'num', render: c => (c.stats ? `%${c.stats.cpu.percent.toFixed(1)}` : null) },
                { label: 'Bellek', type: 'num', render: c => (c.stats ? fmtBytes(c.stats.memory.used) : null) },
                { label: 'İmaj', key: 'image', type: 'mono', hideSm: true },
                { label: '', type: 'actions', render: c => (c.restartable && c.found ? btn('Yeniden başlat', { size: 'xs', iconName: 'refresh', onClick: restart(c) }) : null) }
            ], infra.containers) }),
            card({ title: 'Oyun sunucusu kaynakları', iconName: 'gauge', sub: 'Çalışan tüm oyun konteynerlerinin anlık CPU ve bellek kullanımı.', actions: [btn(null, { size: 'sm', iconName: 'refresh', title: 'Yenile', onClick: loadResources })], bodyClass: 'tight', body: resourcesBox }),
            card({ title: 'Kiralama havuzu', iconName: 'server', sub: `${pool.ports.filter(p => p.status === 'available').length} boş · ${pool.ports.filter(p => p.status === 'rented').length} kiralık · ${pool.ports.filter(p => p.status === 'missing').length} eksik. Port listesi Sistem Ayarları > Havuz Portları alanından değiştirilir.`,
                body: h('div', { class: 'pool-grid' }, pool.ports.map(p => {
                    const server = state.servers.find(s => s.port === p.port);
                    return h(server ? 'a' : 'div', { class: 'pool-slot', href: server ? `#/servers/${server.id}` : null },
                        h('strong', {}, String(p.port)),
                        p.protected ? badge('Korumalı', 'info') : badge(statusLabel[p.status] || p.status, statusVariant[p.status] || ''),
                        h('span', {}, p.owner || ({ running: 'Çalışıyor', exited: 'Durdu', created: 'Oluşturuldu', missing: 'Konteyner yok' }[p.containerState] || p.containerState)));
                })) }),
            h('div', { class: 'grid grid-2 align-start' },
                card({ title: 'Servis adresleri', iconName: 'globe', body: h('dl', { class: 'kv' },
                    h('dt', {}, 'FastDL'), h('dd', {}, copyable(`${infra.fastdl.baseUrl}/<port>/`)),
                    h('dt', {}, 'PHP siteleri'), h('dd', {}, copyable(infra.php.baseUrl)),
                    h('dt', {}, 'MySQL (iç ağ)'), h('dd', {}, copyable(`${infra.mysql.internal.host}:${infra.mysql.internal.port}`)),
                    h('dt', {}, 'MySQL (dış)'), h('dd', {}, infra.mysql.external ? copyable(`${infra.mysql.external.host}:${infra.mysql.external.port}`) : h('span', { class: 'muted' }, 'Dışarıya kapalı (önerilen)'))),
                    footer: [btn('Tüm PHP sitelerini onar', { size: 'sm', iconName: 'refresh', onClick: async e => {
                        if (!(await confirmDialog({ title: 'Tüm siteler onarılsın mı?', message: 'Her sitenin klasörü, izinleri, yapılandırması ve alan adı eşlemesi yeniden yazılır. Site içerikleri korunur.', confirmText: 'Onar' }))) return;
                        await withBusy(e.currentTarget, async () => { try { const r = await api('/api/php/repair-all', { method: 'POST', timeoutMs: 300000 }); toast(r.message, 'success'); } catch (error) { toastError(error); } });
                    } })] }),
                card({ title: 'MySQL veritabanları', iconName: 'database', actions: [btn('Yeni', { size: 'sm', iconName: 'plus', onClick: async () => {
                    const r = await formDialog({ title: 'Yeni veritabanı', fields: [{ name: 'name', label: 'Ad', required: true, full: true, pattern: '[A-Za-z0-9_]{1,64}', help: 'Harf, rakam ve _' }],
                        submitText: 'Oluştur', onSubmit: v => api('/api/mysql/databases', { method: 'POST', body: v }) });
                    if (r) { toast('Veritabanı oluşturuldu.', 'success'); loadDbs(); }
                } })], bodyClass: 'tight', body: dbBox })),
            card({ title: 'MySQL kullanıcıları', iconName: 'key', sub: 'Sunucuya bağlı hesaplar panel tarafından yönetilir; manuel hesapları buradan ekleyip silebilirsiniz.',
                actions: [btn('Yeni kullanıcı', { size: 'sm', iconName: 'plus', onClick: async () => {
                    const r = await formDialog({ title: 'Yeni MySQL kullanıcısı', fields: [
                        { name: 'username', label: 'Kullanıcı adı', required: true, pattern: '[A-Za-z0-9_]{1,32}' },
                        { name: 'host', label: 'Host', value: '%', required: true, help: '% = her yerden; 172.% = iç ağ' },
                        { name: 'password', label: 'Şifre', value: generatePassword(16), code: true, required: true, validate: v => (v.length < 8 ? 'En az 8 karakter.' : null) },
                        { name: 'database', label: 'Yetki verilecek veritabanı', placeholder: 'Boş = yetki verme' }
                    ], submitText: 'Oluştur', onSubmit: v => api('/api/mysql/users', { method: 'POST', body: v }) });
                    if (r) { toast('MySQL kullanıcısı oluşturuldu.', 'success'); loadDbUsers(); }
                } })], bodyClass: 'tight', body: dbUsersBox }));
        loadResources();
        loadDbs();
        loadDbUsers();
    }

    append(root,
        head('Altyapı', 'Sunucu makinesi, konteynerler, kiralama havuzu, MySQL, PHP ve FastDL servislerinin durumu.', [
            btn('Süre kontrolünü çalıştır', { iconName: 'clock', onClick: async e => {
                if (!(await confirmDialog({ title: 'Süre kontrolü çalıştırılsın mı?', message: 'Hatırlatmalar gönderilir, süresi dolan sunucular askıya alınır, askı süresi geçenler silinip havuza alınır. Normalde her 10 dakikada otomatik çalışır.', confirmText: 'Çalıştır' }))) return;
                await withBusy(e.currentTarget, async () => { try { const r = await api('/api/admin/lifecycle/run', { method: 'POST', timeoutMs: 300000 }); toast(r.message, 'success'); load(); } catch (error) { toastError(error); } });
            } }),
            btn('Havuzu onar', { variant: 'primary', iconName: 'refresh', onClick: async e => {
                if (!(await confirmDialog({ title: 'Havuz onarılsın mı?', message: 'Eksik havuz konteynerleri oluşturulur, duranlar başlatılır. Kiralık sunuculara dokunulmaz.', confirmText: 'Onar' }))) return;
                await withBusy(e.currentTarget, async () => {
                    try {
                        const r = await api('/api/admin/pool/ensure', { method: 'POST', timeoutMs: 600000 });
                        toast(`Oluşturulan: ${r.report.created.length}, başlatılan: ${r.report.started.length}, hata: ${r.report.errors.length}`, r.report.errors.length ? 'warning' : 'success');
                        await loadServers().catch(() => {});
                        load();
                    } catch (error) { toastError(error); }
                });
            } })]),
        body);
    await loadServers().catch(() => {});
    await load();
    autoRefresh(onCleanup, loadResources, 15000);
}

// ---------------------------------------------------------------------------
//  Settings
// ---------------------------------------------------------------------------

const SETTING_GROUPS = [
    ['Genel', 'settings', ['site_name', 'support_contact', 'currency']],
    ['Üyelik ve erişim', 'users', ['registration_enabled', 'maintenance_mode', 'maintenance_message']],
    ['Ödeme', 'wallet', ['iban_details', 'min_deposit']],
    ['Abonelik kuralları', 'clock', ['renewal_period_discounts', 'grace_days', 'global_free_limit', 'pool_ports']],
    ['İade, çekim ve makbuz', 'receipt', ['refund_enabled', 'refund_fee_percent', 'refund_min_amount', 'withdrawal_enabled', 'withdrawal_min_amount', 'receipt_prefix', 'seller_info']]
];

async function renderSettings({ root, onCleanup }) {
    root.appendChild(loading());
    let data;
    try { data = await api('/api/admin/settings'); } catch (error) { clear(root, errorBox(error)); return; }
    clear(root);
    const byKey = new Map(data.allSettings.map(s => [s.key, s]));
    const controls = new Map();
    const initial = new Map();
    const dirtyNote = h('span', { class: 'small text-warning', hidden: true }, 'Kaydedilmemiş değişiklikler var');

    function markDirty() {
        const dirty = [...controls].some(([key, el]) => el.value !== initial.get(key));
        dirtyNote.hidden = !dirty;
    }

    function control(s) {
        const opts = s.options ? s.options.split(',').map(o => o.trim()) : [];
        let el;
        if (s.type === 'textarea') el = h('textarea', { class: 'textarea', rows: 3, value: s.value || '' });
        else if (s.type === 'select') {
            const labels = { '1': 'Açık', '0': 'Kapalı' };
            el = select(opts.map(o => ({ value: o, label: labels[o] || o })), { value: s.value });
        } else el = input({ type: s.type === 'number' ? 'number' : 'text', value: s.value || '' });
        controls.set(s.key, el);
        initial.set(s.key, el.value);
        el.addEventListener('input', markDirty);
        el.addEventListener('change', markDirty);
        return field(s.name || s.key, el, { help: s.description });
    }

    const used = new Set();
    const groups = SETTING_GROUPS.map(([title, iconName, keys]) => {
        const fields = keys.map(k => byKey.get(k)).filter(Boolean);
        fields.forEach(f => used.add(f.key));
        return card({ title, iconName, body: h('div', { class: 'form-grid' }, fields.map(f => { const w = control(f); if (f.type === 'textarea') w.classList.add('full'); return w; })) });
    });
    const custom = data.allSettings.filter(s => !used.has(s.key));
    const saveBtn = btn('Tüm ayarları kaydet', { variant: 'primary', iconName: 'check' });
    saveBtn.addEventListener('click', () => withBusy(saveBtn, async () => {
        const body = {};
        controls.forEach((el, key) => { body[key] = el.value; });
        try {
            await api('/api/admin/settings', { method: 'PUT', body });
            controls.forEach((el, key) => initial.set(key, el.value));
            markDirty();
            toast('Ayarlar kaydedildi.', 'success');
        } catch (error) { toastError(error); }
    }));
    const beforeUnload = e => { if (!dirtyNote.hidden) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    onCleanup(() => window.removeEventListener('beforeunload', beforeUnload));
    const addCustom = async () => {
        const r = await formDialog({ title: 'Özel ayar ekle', fields: [
            { name: 'key', label: 'Anahtar', placeholder: 'ornek_ayar', required: true, pattern: '[a-z0-9_]{2,64}', help: 'Küçük harf, rakam ve _' },
            { name: 'name', label: 'Görünen ad', required: true },
            { name: 'type', label: 'Tür', type: 'select', value: 'text', options: [{ value: 'text', label: 'Metin' }, { value: 'number', label: 'Sayı' }, { value: 'textarea', label: 'Uzun metin' }, { value: 'select', label: 'Seçim listesi' }] },
            { name: 'options', label: 'Seçenekler (virgülle)', placeholder: 'a,b,c', showIf: v => v.type === 'select', required: true },
            { name: 'value', label: 'Değer' },
            { name: 'description', label: 'Açıklama', full: true }
        ], submitText: 'Ekle', onSubmit: v => api('/api/admin/settings', { method: 'POST', body: v }) });
        if (r) { toast('Ayar eklendi.', 'success'); navigate('/admin/settings'); }
    };

    append(root,
        head('Sistem Ayarları', 'Marka, üyelik, ödeme ve abonelik kurallarını yapılandırın.', [dirtyNote, btn('Özel ayar ekle', { iconName: 'plus', onClick: addCustom }), saveBtn]),
        h('div', { class: 'grid grid-2' }, groups),
        custom.length ? card({ title: 'Özel ayarlar', iconName: 'sliders', body: h('div', { class: 'form-grid' }, custom.map(s => {
            const w = control(s);
            w.appendChild(h('div', { class: 'row row-sm' }, h('code', { class: 'small muted' }, s.key), h('span', { class: 'spacer' }), btn('Sil', { size: 'xs', variant: 'ghost', iconName: 'trash', onClick: async () => {
                if (!(await confirmDialog({ title: 'Ayar silinsin mi?', message: s.key, confirmText: 'Sil', danger: true }))) return;
                try { await api(`/api/admin/settings/${enc(s.key)}`, { method: 'DELETE' }); toast('Ayar silindi.', 'success'); navigate('/admin/settings'); } catch (error) { toastError(error); }
            } })));
            return w;
        })) }) : null);
}

// ---------------------------------------------------------------------------
//  Audit log
// ---------------------------------------------------------------------------

async function renderAudit({ root }) {
    let offset = 0;
    let lastPage = [];
    const filter = select(AUDIT_FILTERS.map(([value, label]) => ({ value, label })), { value: '', 'aria-label': 'İşlem türü' });
    const box = h('div', {}, loading());
    async function load() {
        clear(box, loading());
        try {
            const data = await api(`/api/admin/audit?limit=${PAGE}&offset=${offset}${filter.value ? `&action=${filter.value}` : ''}`);
            lastPage = data.entries;
            clear(box, auditTable(data.entries), pager({ offset, limit: PAGE, count: data.entries.length, total: data.total, onChange: next => { offset = next; load(); } }));
        } catch (error) { clear(box, h('div', { class: 'card-body' }, errorBox(error))); }
    }
    filter.addEventListener('change', () => { offset = 0; load(); });
    append(root, head('Denetim Kaydı', 'Panelde yapılan tüm kritik işlemlerin kim, ne zaman ve hangi IP\'den yaptığı.', [
        btn('CSV', { iconName: 'download', onClick: () => downloadCsv('denetim-kaydi.csv', [
            { key: 'created_at', label: 'Zaman' }, { key: 'actor_name', label: 'Kim' }, { key: 'action', label: 'İşlem' }, { key: 'target_type', label: 'Hedef türü' },
            { key: 'target_id', label: 'Hedef' }, { key: 'details', label: 'Ayrıntı' }, { key: 'ip', label: 'IP' }], lastPage) })]),
    card({ title: 'Kayıtlar', iconName: 'list', actions: [filter], bodyClass: 'tight', body: box }));
    load();
}

import { append,
    state, api, h, clear, icon, btn, linkBtn, card, badge, table, fmtMoney, fmtDate, fmtDateTime, daysLeft, statusBadge, toast, toastError,
    confirmDialog, openModal, withBusy, loading, errorBox, emptyState, copyable, copyText, switchControl, dropdown, menuItem, menuSep,
    on, input, field, select, navigate
} from '../core.js';
import { loadServers, loadSummary } from '../main.js';
import { openDepositDialog } from '../components/deposit.js';
import * as tabs from './serverTabs.js';

const TABS = [
    { id: 'overview', label: 'Genel Bakış', icon: 'gauge' },
    { id: 'console', label: 'Konsol', icon: 'terminal' },
    { id: 'logs', label: 'Loglar', icon: 'list' },
    { id: 'files', label: 'Dosyalar', icon: 'folder' },
    { id: 'plugins', label: 'Eklentiler', icon: 'puzzle' },
    { id: 'maps', label: 'Haritalar', icon: 'map' },
    { id: 'players', label: 'Oyuncular', icon: 'users' },
    { id: 'admins', label: 'Yetkililer & Banlar', icon: 'shield' },
    { id: 'website', label: 'Web Sitesi', icon: 'globe' },
    { id: 'database', label: 'Veritabanı', icon: 'database' },
    { id: 'fastdl', label: 'FastDL', icon: 'download' },
    { id: 'tasks', label: 'Görevler', icon: 'calendar' },
    { id: 'settings', label: 'Ayarlar', icon: 'sliders' }
];

const PERIODS = [1, 3, 6, 12];

/** Renewal / upgrade checkout dialog. Resolves true when paid. */
export function openRenewDialog(server) {
    return new Promise(resolve => {
        const plans = ((state.config && state.config.plans) || []).filter(p => !p.is_trial);
        const choice = { months: 1, plan: plans.some(p => p.slug === server.plan_type) ? server.plan_type : (plans[0] && plans[0].slug), coupon: '' };
        const summary = h('div');
        const periodBox = h('div', { class: 'segmented' });
        const planSelect = select(plans.map(p => ({ value: p.slug, label: `${p.name} · ${p.max_players} slot · ${fmtMoney(p.price)}/${p.duration_days} gün` })), { value: choice.plan });
        const couponInput = input({ placeholder: 'Kupon kodu (isteğe bağlı)', autocomplete: 'off' });
        const payBtn = btn('Öde ve uzat', { variant: 'primary', iconName: 'check' });
        let seq = 0;

        function paintPeriods() {
            clear(periodBox, PERIODS.map(m => h('button', { type: 'button', class: m === choice.months ? 'active' : '', onClick: () => { choice.months = m; paintPeriods(); quote(); } }, `${m} ay`)));
        }
        async function quote() {
            const mine = ++seq;
            clear(summary, loading('Hesaplanıyor…'));
            const params = new URLSearchParams({ plan: choice.plan, months: String(choice.months), renew: '1' });
            if (choice.coupon) params.set('coupon', choice.coupon);
            try {
                const q = await api(`/api/servers/quote?${params}`);
                if (mine !== seq) return;
                const base = new Date(server.expires_at) > new Date() ? new Date(server.expires_at) : new Date();
                const newExpiry = new Date(base.getTime() + q.days * 86400000);
                const enough = Number(state.user.balance) >= q.total;
                clear(summary,
                    h('div', { class: 'summary-line' }, h('span', {}, `${q.plan.name} × ${q.months} ay`), h('span', {}, fmtMoney(q.subtotal))),
                    q.periodDiscount ? h('div', { class: 'summary-line' }, h('span', {}, `Dönem indirimi (%${q.periodDiscountPct})`), h('span', { class: 'discount' }, `-${fmtMoney(q.periodDiscount)}`)) : null,
                    q.couponDiscount ? h('div', { class: 'summary-line' }, h('span', {}, `Kupon ${q.coupon.code}`), h('span', { class: 'discount' }, `-${fmtMoney(q.couponDiscount)}`)) : null,
                    h('div', { class: 'summary-line total' }, h('span', {}, 'Toplam'), h('span', {}, fmtMoney(q.total))),
                    h('div', { class: 'summary-line small' }, h('span', { class: 'muted' }, 'Yeni bitiş tarihi'), h('span', {}, fmtDate(newExpiry))),
                    h('div', { class: 'summary-line small' }, h('span', { class: 'muted' }, 'Bakiyeniz'), h('span', { class: enough ? '' : 'text-danger' }, fmtMoney(state.user.balance))),
                    choice.plan !== server.plan_type ? h('p', { class: 'small text-warning mt-2' }, 'Paket değişikliğinde slot sayısı güncellenir; sunucu kısa süreliğine yeniden başlatılır. Dosyalarınız korunur.') : null,
                    enough ? null : h('div', { class: 'alert alert-warning mt-2' }, icon('wallet'), h('div', {}, h('strong', {}, 'Bakiye yetersiz'),
                        h('p', {}, `${fmtMoney(q.total - state.user.balance)} eksik. Eksik tutarı havale ile bildirin; ödeme onaylanınca süre otomatik uzatılır.`)),
                        h('div', { class: 'alert-actions' }, btn('Havale bildir', { size: 'sm', variant: 'primary', iconName: 'send', onClick: () => {
                            modal.close();
                            openDepositDialog({
                                suggestedAmount: q.total - state.user.balance,
                                intent: { type: 'renew', serverId: server.id, months: choice.months, plan: choice.plan, coupon: choice.coupon || undefined },
                                intentLabel: `Ödeme onaylanınca ${q.months} ay otomatik uzat (${fmtMoney(q.total)})`
                            });
                        } }))));
                payBtn.disabled = !enough;
            } catch (error) {
                if (mine !== seq) return;
                if (choice.coupon) { toast(error.message, 'error'); choice.coupon = ''; couponInput.value = ''; return quote(); }
                clear(summary, h('div', { class: 'form-error' }, error.message));
                payBtn.disabled = true;
            }
        }
        planSelect.addEventListener('change', () => { choice.plan = planSelect.value; quote(); });
        payBtn.addEventListener('click', () => withBusy(payBtn, async () => {
            try {
                const data = await api(`/api/servers/${server.id}/renew`, { method: 'POST', body: { months: choice.months, plan: choice.plan, coupon: choice.coupon || undefined }, timeoutMs: 180000 });
                toast(`Süre uzatıldı. Yeni bitiş: ${fmtDate(data.expires_at)}`, 'success');
                await Promise.all([loadSummary(), loadServers()]);
                modal.close(true);
                if (data.containerId && data.containerId !== server.id) navigate(`/servers/${data.containerId}`);
            } catch (error) { toastError(error); }
        }));
        const modal = openModal({
            title: `Süreyi uzat · Port ${server.port}`,
            body: h('div', { class: 'form-stack' },
                field('Paket', planSelect),
                h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Dönem'), periodBox),
                h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Kupon'),
                    h('div', { class: 'input-group' }, couponInput, btn('Uygula', { onClick: () => { choice.coupon = couponInput.value.trim().toUpperCase(); quote(); } }))),
                h('hr', { class: 'mt-1 mb-2' }),
                summary),
            footer: [btn('Vazgeç', { variant: 'ghost', onClick: () => modal.close(false) }), payBtn],
            onClose: result => resolve(result === true)
        });
        paintPeriods();
        quote();
    });
}

function canRequestRefund(server) {
    return !server.is_pool && !server.plan_is_trial && Number(server.owner_id) === Number(state.user.id) && !(state.config && state.config.refundsDisabled);
}

/** Customer refund request: shows the prorated breakdown before asking for a reason. */
async function openRefundDialog(server) {
    const body = h('div', {}, loading('İade tutarı hesaplanıyor…'));
    const reason = h('textarea', { class: 'textarea', rows: 3, maxlength: 500, placeholder: 'Örn. Sunucuyu artık kullanmayacağım / beklediğim performansı alamadım…', 'aria-label': 'İade sebebi' });
    const submit = btn('İade talebi gönder', { variant: 'danger-solid', disabled: true });
    const modal = openModal({ title: `İade talebi · Port ${server.port}`, body, footer: [btn('Vazgeç', { variant: 'ghost', onClick: () => modal.close() }), submit] });
    let data;
    try { data = await api(`/api/servers/${server.id}/refund-quote`); } catch (error) { clear(body, errorBox(error)); return; }
    const q = data.quote;
    if (data.pendingRequest) { clear(body, h('div', { class: 'alert alert-info' }, icon('info'), h('div', {}, h('strong', {}, 'Bekleyen talebiniz var'), h('p', {}, 'Bu sunucu için iade talebiniz inceleniyor. Durumunu Bakiye & Ödemeler sayfasından takip edebilirsiniz.')))); return; }
    if (!q.enabled) { clear(body, h('div', { class: 'alert alert-warning' }, icon('alert'), h('div', {}, h('strong', {}, 'İade talepleri kapalı'), h('p', {}, 'Lütfen destek ile iletişime geçin.')))); return; }
    if (q.legacy || q.total <= 0 || q.total < q.minAmount) {
        clear(body, h('div', { class: 'alert alert-warning' }, icon('alert'), h('div', {}, h('strong', {}, 'İade edilebilir tutar yok'),
            h('p', {}, q.legacy ? 'Bu kiralama yeni ödeme sistemi öncesinde yapıldığı için otomatik hesaplanamıyor; destek ile iletişime geçin.' : 'Ödenmiş ve henüz kullanılmamış bir süre bulunmuyor.'))));
        return;
    }
    submit.disabled = false;
    clear(body, h('div', { class: 'form-stack' },
        h('p', { class: 'text-2' }, 'Ödediğiniz tutarın kullanılmayan kısmı bakiyenize iade edilir. Talep yönetici onayından sonra işlenir; onaylanınca iade edilen süre aboneliğinizden düşülür.'),
        h('div', { class: 'refund-breakdown' }, table([
            { label: 'Dönem', render: i => h('div', { class: 'cell-title' }, h('strong', {}, i.planName), h('span', {}, `${fmtDate(i.startsAt)} → ${fmtDate(i.endsAt)}`)) },
            { label: 'Kalan', type: 'num', render: i => `${i.remainingDays} / ${i.totalDays} gün` },
            { label: 'Ödenen', type: 'money', render: i => fmtMoney(i.paid - i.alreadyRefunded), hideSm: true },
            { label: 'İade', type: 'money', render: i => h('strong', {}, fmtMoney(i.amount)) }
        ], q.items)),
        q.fee ? h('div', { class: 'summary-line' }, h('span', {}, `İade kesintisi (%${q.feePercent})`), h('span', { class: 'text-danger' }, `-${fmtMoney(q.fee)}`)) : null,
        h('div', { class: 'summary-line total' }, h('span', {}, 'Tahmini iade'), h('span', {}, fmtMoney(q.total))),
        field('İade sebebi', reason, { help: 'En az 10 karakter. Yönetici talebinizi bu açıklamaya göre değerlendirir.' })));
    submit.addEventListener('click', () => withBusy(submit, async () => {
        if (reason.value.trim().length < 10) { toast('Lütfen sebebi en az 10 karakterle açıklayın.', 'warning'); reason.focus(); return; }
        try {
            const res = await api('/api/refunds', { method: 'POST', body: { serverId: server.id, reason: reason.value.trim() } });
            toast(res.message, 'success');
            modal.close();
        } catch (error) { toastError(error); }
    }));
}

function subscriptionStrip(server) {
    const left = daysLeft(server.expires_at);
    const unlimited = left > 3650;
    const total = 30;
    const pct = unlimited ? 100 : Math.max(0, Math.min(100, left / total * 100));
    const isOwner = state.user.role !== 'admin' || server.owner_id === state.user.id;
    const autoRenew = switchControl('Otomatik yenile', server.auto_renew, async (checked, el) => {
        try {
            await api(`/api/servers/${server.id}/auto-renew`, { method: 'POST', body: { enabled: checked } });
            toast(checked ? 'Otomatik yenileme açıldı. Bitiş tarihinde bakiyenizden 1 aylık ücret çekilir.' : 'Otomatik yenileme kapatıldı.', 'success');
            loadServers().catch(() => {});
        } catch (error) {
            el.checked = !checked;
            toastError(error);
        }
    });
    return h('div', { class: 'subscription' },
        h('div', { class: 'info' },
            h('div', {}, h('span', {}, 'Paket'), h('strong', {}, server.plan_name, server.plan_is_trial ? badge('Deneme', 'info') : null)),
            h('div', {}, h('span', {}, 'Bitiş'), h('strong', { class: left <= 3 && !unlimited ? 'text-warning' : '' }, unlimited ? 'Süresiz' : `${fmtDate(server.expires_at)} · ${left > 0 ? `${left} gün` : 'doldu'}`)),
            unlimited ? null : h('div', {}, h('span', {}, 'Kalan süre'), h('div', { class: `progress ${left <= 3 ? 'danger' : left <= 7 ? 'warn' : ''}` }, h('div', { style: { width: `${pct}%` } }))),
            state.user.role === 'admin' ? h('div', {}, h('span', {}, 'Sahip'), h('strong', {}, server.owner)) : null),
        unlimited || server.is_pool ? h('div') : h('div', { class: 'btn-group' },
            server.plan_is_trial ? null : autoRenew,
            isOwner ? btn(server.plan_is_trial ? 'Pakete yükselt' : 'Süreyi uzat', { variant: 'primary', size: 'sm', iconName: 'clock', onClick: () => openRenewDialog(server) }) : null));
}

/** After a power action, poll quickly until the container reaches the expected state. */
function settleState(serverId, expectRunning) {
    let tries = 0;
    const tick = async () => {
        tries++;
        const list = await loadServers().catch(() => null);
        const s = list && list.find(x => x.id === serverId);
        const settled = s && ((s.state === 'running') === expectRunning) && (!expectRunning || s.online || tries > 8);
        if (!settled && tries < 15) setTimeout(tick, 2000);
    };
    setTimeout(tick, 1000);
}

function powerControls(server) {
    const running = server.state === 'running';
    const act = action => async e => {
        const button = e.currentTarget;
        if (action !== 'start' && server.online && server.players > 0) {
            const ok = await confirmDialog({
                title: action === 'stop' ? 'Sunucuyu durdur' : 'Sunucuyu yeniden başlat',
                message: `Sunucuda şu anda ${server.players} oyuncu var; bağlantıları kopacak. Devam edilsin mi?`,
                confirmText: action === 'stop' ? 'Durdur' : 'Yeniden başlat', danger: action === 'stop'
            });
            if (!ok) return;
        }
        await withBusy(button, async () => {
            try {
                const data = await api(`/api/servers/${server.id}/${action}`, { method: 'POST', timeoutMs: 180000 });
                toast(data.message, 'success', 2500);
                if (data.containerId && data.containerId !== server.id) {
                    await loadServers();
                    navigate(`/servers/${data.containerId}`);
                } else settleState(server.id, action !== 'stop');
            } catch (error) { toastError(error); }
        });
    };
    const more = dropdown(btn(null, { iconName: 'more', title: 'Diğer işlemler' }), close => h('div', {},
        menuItem('Temiz kurulum (sıfırla)', async () => {
            close();
            const ok = await confirmDialog({
                title: 'Temiz kurulum',
                message: 'Tüm oyun dosyaları (eklentiler, haritalar, ayarlar, yetkililer, banlar) silinip temiz imajdan yeniden kurulacak. Port, RCON şifresi, veritabanı ve web siteniz korunur.\n\nBu işlem geri alınamaz.',
                confirmText: 'Sunucuyu sıfırla', danger: true, requireText: String(server.port)
            });
            if (!ok) return;
            const t = toast('Sunucu sıfırlanıyor…', 'info', 0);
            try {
                const data = await api(`/api/servers/${server.id}/reset`, { method: 'POST', timeoutMs: 180000 });
                toast(data.message, 'success');
                await loadServers();
                navigate(`/servers/${data.containerId}`);
            } catch (error) { toastError(error); } finally { t.remove(); }
        }, { iconName: 'refresh', danger: true }),
        menuItem('Adresi kopyala', () => { close(); copyText(server.address); }, { iconName: 'copy' }),
        canRequestRefund(server) ? menuItem('İade talep et', () => { close(); openRefundDialog(server); }, { iconName: 'wallet' }) : null,
        menuItem('Steam ile bağlan', () => { close(); window.location.href = `steam://connect/${server.address}`; }, { iconName: 'play' }),
        state.user.role === 'admin' && !server.protected ? [menuSep(), menuItem('Sunucuyu sil', async () => {
            close();
            const ok = await confirmDialog({ title: 'Sunucuyu sil', message: `Port ${server.port} ve tüm kaynakları (dosyalar, veritabanı, web sitesi, FastDL) kalıcı olarak silinecek.`, confirmText: 'Kalıcı olarak sil', danger: true, requireText: String(server.port) });
            if (!ok) return;
            try {
                await api(`/api/servers/${server.id}`, { method: 'DELETE', timeoutMs: 180000 });
                toast('Sunucu silindi.', 'success');
                await loadServers();
                navigate('/');
            } catch (error) { toastError(error); }
        }, { iconName: 'trash', danger: true })] : null));
    return h('div', { class: 'power' },
        btn('Başlat', { variant: 'success', iconName: 'play', disabled: running, onClick: act('start') }),
        btn('Yeniden başlat', { iconName: 'refresh', disabled: !running, onClick: act('restart') }),
        btn('Durdur', { variant: 'danger', iconName: 'stop', disabled: !running, onClick: act('stop') }),
        more);
}

function statsStrip(server) {
    const tile = (label, value, iconName) => h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, icon(iconName, 'icon-sm'), label), h('div', { class: 'stat-value' }, value));
    return h('div', { class: 'stats-strip' },
        tile('Oyuncular', server.online ? `${server.players} / ${server.maxPlayers}` : `0 / ${server.maxPlayers}`, 'users'),
        tile('Harita', server.map || '—', 'map'),
        tile('Sunucu FPS', server.online && server.fps ? String(Math.round(server.fps)) : '—', 'zap'),
        tile('CPU', server.online ? `%${Number(server.cpu || 0).toFixed(1)}` : '—', 'cpu'));
}

function countdownText(target) {
    const ms = new Date(target).getTime() - Date.now();
    if (ms <= 0) return 'Silinmek üzere';
    const d = Math.floor(ms / 86400000);
    const hh = Math.floor((ms % 86400000) / 3600000);
    const mm = Math.floor((ms % 3600000) / 60000);
    return d ? `${d} gün ${hh} sa` : `${hh} sa ${String(mm).padStart(2, '0')} dk`;
}

function paywall(server, onCleanup) {
    const expired = server.suspended_reason === 'expired';
    const isOwner = Number(server.owner_id) === Number(state.user.id);
    const countdown = h('div', { class: 'countdown', 'aria-live': 'off' }, server.deletes_at ? countdownText(server.deletes_at) : '');
    if (server.deletes_at && onCleanup) {
        const timer = setInterval(() => { countdown.textContent = countdownText(server.deletes_at); }, 30000);
        onCleanup(() => clearInterval(timer));
    }
    return card({ body: h('div', { class: 'paywall' },
        h('div', { class: 'empty-icon' }, icon('lock', 'icon-lg')),
        h('h2', {}, expired ? 'Sunucunuzun süresi doldu' : 'Sunucu askıya alındı'),
        expired && server.deletes_at ? h('div', { class: 'stack stack-sm center' },
            h('span', { class: 'eyebrow' }, 'Kalıcı silinmeye kalan süre'),
            countdown,
            h('span', { class: 'small muted' }, `${fmtDateTime(server.deletes_at)} tarihinde tüm dosyalar, veritabanı ve web sitesi silinir.`)) : null,
        h('p', {}, expired
            ? 'Sunucunuz durduruldu ve yönetim araçları kilitlendi. Süreyi uzattığınız anda sunucu otomatik olarak yeniden başlar; dosyalarınız, veritabanınız ve web siteniz olduğu gibi korunur.'
            : `Bu sunucu yönetici tarafından askıya alındı${server.suspended_reason && server.suspended_reason !== 'admin' ? ` (sebep: ${server.suspended_reason})` : ''}. Bu durumda süre uzatılamaz; ayrıntı için destek ile iletişime geçin.`),
        expired && isOwner ? h('div', { class: 'btn-group center' },
            btn('Şimdi uzat', { variant: 'primary', iconName: 'clock', onClick: () => openRenewDialog(server) }),
            btn('Havale ile öde', { iconName: 'send', onClick: async () => {
                const plan = ((state.config && state.config.plans) || []).find(p => p.slug === server.plan_type);
                await openDepositDialog({
                    suggestedAmount: plan ? Math.max(0, plan.price - Number(state.user.balance)) : null,
                    intent: { type: 'renew', serverId: server.id, months: 1, plan: plan ? plan.slug : undefined },
                    intentLabel: 'Ödeme onaylanınca 1 ay otomatik uzat'
                });
            } }),
            linkBtn('Bakiye & makbuzlar', '#/billing', { variant: 'ghost', iconName: 'wallet' })) : null,
        state.config && state.config.supportContact ? h('p', { class: 'small muted' }, `Destek: ${state.config.supportContact}`) : null) });
}

export async function render({ root, params, setTitle, onCleanup, isCurrent }) {
    let server = state.servers.find(s => s.id === params.id);
    if (!server) {
        root.appendChild(loading());
        try { await loadServers(); } catch (error) { clear(root, errorBox(error)); return; }
        if (!isCurrent()) return;
        server = state.servers.find(s => s.id === params.id);
        clear(root);
    }
    if (!server) {
        root.appendChild(card({ body: emptyState({ iconName: 'server', title: 'Sunucu bulunamadı', text: 'Sunucu silinmiş, sıfırlanmış veya erişim yetkiniz kaldırılmış olabilir.', action: linkBtn('Panele dön', '#/', { variant: 'primary' }) }) }));
        setTitle('Sunucu bulunamadı');
        return;
    }
    const tabId = TABS.some(t => t.id === params.tab) ? params.tab : 'overview';
    setTitle(server.name, [{ label: 'Sunucular', href: '#/' }]);

    const header = h('section', { class: 'card' });
    function paintHeader() {
        const s = state.servers.find(x => x.id === params.id) || server;
        server = s;
        clear(header,
            h('div', { class: 'server-hero' },
                h('div', { class: 'identity' },
                    h('h1', {}, s.name),
                    h('div', { class: 'meta' }, statusBadge(s), copyable(s.address), s.protected ? badge('Korumalı', 'info') : null, s.is_pool ? badge('Havuz', '') : null)),
                s.suspended && state.user.role !== 'admin' ? null : powerControls(s)),
            s.is_pool ? null : subscriptionStrip(s),
            s.suspended ? null : statsStrip(s));
    }
    paintHeader();
    root.appendChild(header);

    if (server.suspended && state.user.role !== 'admin') {
        root.appendChild(paywall(server, onCleanup));
        onCleanup(on('servers-updated', () => {
            const s = state.servers.find(x => x.id === params.id);
            if (s && !s.suspended) navigate(`/servers/${s.id}/${tabId}`);
        }));
        return;
    }
    if (server.suspended) {
        root.appendChild(h('div', { class: 'alert alert-danger' }, icon('lock'), h('div', {}, h('strong', {}, 'Sunucu askıda'), h('p', {}, `Neden: ${server.suspended_reason || '—'}. Kullanıcı bu sunucuyu yönetemez; yönetici olarak erişiyorsunuz.`))));
    }

    const tabBar = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Sunucu bölümleri' },
        TABS.map(t => h('a', { class: `tab ${t.id === tabId ? 'active' : ''}`, role: 'tab', 'aria-selected': t.id === tabId ? 'true' : 'false', href: `#/servers/${server.id}/${t.id}` }, icon(t.icon, 'icon-sm'), t.label)));
    const tabWrap = h('div', { class: 'tabs-wrap' }, tabBar);
    const panel = h('div', { class: 'stack', role: 'tabpanel' });
    append(root, tabWrap, panel);
    const updateScrollHint = () => tabWrap.classList.toggle('has-more', tabBar.scrollLeft + tabBar.clientWidth < tabBar.scrollWidth - 4);
    tabBar.addEventListener('scroll', updateScrollHint, { passive: true });
    window.addEventListener('resize', updateScrollHint);
    onCleanup(() => window.removeEventListener('resize', updateScrollHint));
    // Keep the active tab visible on narrow screens.
    setTimeout(() => {
        const active = tabBar.querySelector('.active');
        if (active && tabBar.scrollWidth > tabBar.clientWidth) {
            tabBar.scrollLeft = Math.max(0, active.offsetLeft - (tabBar.clientWidth - active.offsetWidth) / 2);
        }
        updateScrollHint();
    }, 0);

    const renderers = {
        overview: tabs.overviewTab, console: tabs.consoleTab, logs: tabs.logsTab, files: tabs.filesTab, plugins: tabs.pluginsTab, maps: tabs.mapsTab,
        players: tabs.playersTab, admins: tabs.adminsTab, website: tabs.websiteTab, database: tabs.databaseTab,
        fastdl: tabs.fastdlTab, tasks: tabs.tasksTab, settings: tabs.settingsTab
    };
    // Tabs that show "server offline" states are re-rendered when the
    // running state flips, so buttons never stay disabled after a start.
    const STATE_SENSITIVE = new Set(['plugins', 'maps', 'players', 'admins', 'settings', 'console', 'overview']);
    let tabCleanups = [];
    let renderedState = server.state;
    async function renderTab() {
        tabCleanups.forEach(fn => { try { fn(); } catch (_) { /* ignore */ } });
        tabCleanups = [];
        clear(panel);
        const ctx = {
            server, panel, isCurrent,
            onCleanup: fn => tabCleanups.push(fn),
            refreshServers: () => loadServers().catch(() => {})
        };
        try {
            await renderers[tabId](ctx);
        } catch (error) {
            panel.appendChild(errorBox(error));
        }
    }
    onCleanup(() => tabCleanups.forEach(fn => { try { fn(); } catch (_) { /* ignore */ } }));
    onCleanup(on('servers-updated', () => {
        const s = state.servers.find(x => x.id === params.id);
        if (!s) return;
        if (!!s.suspended !== !!server.suspended) { navigate(`/servers/${s.id}/${tabId}`); return; }
        paintHeader();
        const runningNow = s.state === 'running';
        if (runningNow !== (renderedState === 'running') && STATE_SENSITIVE.has(tabId)) {
            renderedState = s.state;
            renderTab();
        }
    }));
    await renderTab();
}

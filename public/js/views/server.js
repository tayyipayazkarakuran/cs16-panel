import { append,
    state, api, h, clear, icon, btn, card, badge, fmtMoney, fmtDate, daysLeft, statusBadge, toast, toastError,
    confirmDialog, openModal, withBusy, loading, errorBox, emptyState, copyable, copyText, switchControl, dropdown, menuItem,
    on, input, field, select, navigate
} from '../core.js';
import { loadServers, loadSummary } from '../main.js';
import * as tabs from './serverTabs.js';

const TABS = [
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
                    choice.plan !== server.plan_type ? h('p', { class: 'small text-warning mt-8' }, 'Paket değişikliğinde slot sayısı güncellenir; sunucu kısa süreliğine yeniden başlatılır. Dosyalarınız korunur.') : null,
                    enough ? null : h('div', { class: 'alert alert-warning mt-8' }, icon('wallet'), h('div', {}, h('strong', {}, 'Bakiye yetersiz'), h('p', {}, `${fmtMoney(q.total - state.user.balance)} eksik.`)),
                        h('div', { class: 'alert-actions' }, h('a', { class: 'btn btn-sm btn-primary', href: '#/billing', onClick: () => modal.close() }, 'Bakiye yükle'))));
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
                h('hr', { style: { margin: '4px 0' } }),
                summary),
            footer: [btn('Vazgeç', { variant: 'ghost', onClick: () => modal.close(false) }), payBtn],
            onClose: result => resolve(result === true)
        });
        paintPeriods();
        quote();
    });
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

function powerControls(server, refresh) {
    const running = server.state === 'running';
    const act = action => async e => {
        const button = e.currentTarget;
        await withBusy(button, async () => {
            try {
                const data = await api(`/api/servers/${server.id}/${action}`, { method: 'POST', timeoutMs: 180000 });
                toast(data.message, 'success', 2500);
                if (data.containerId && data.containerId !== server.id) {
                    await loadServers();
                    navigate(`/servers/${data.containerId}`);
                } else setTimeout(refresh, 1200);
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
        menuItem('Steam ile bağlan', () => { close(); window.location.href = `steam://connect/${server.address}`; }, { iconName: 'play' }),
        state.user.role === 'admin' && !server.protected ? [h('div', { class: 'sep' }), menuItem('Sunucuyu sil', async () => {
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

function paywall(server) {
    const expired = server.suspended_reason === 'expired';
    return card({ body: h('div', { class: 'paywall' },
        h('div', { class: 'empty-icon' }, icon('lock', 'icon-lg')),
        h('h2', {}, expired ? 'Sunucunuzun süresi doldu' : 'Sunucu askıya alındı'),
        h('p', {}, expired
            ? 'Sunucunuz durduruldu ve yönetim araçları kilitlendi. Süreyi uzattığınız anda sunucu otomatik olarak yeniden başlar; dosyalarınız, veritabanınız ve web siteniz olduğu gibi korunur. Askı süresi içinde yenilenmezse tüm veriler silinir.'
            : `Bu sunucu yönetici tarafından askıya alındı${server.suspended_reason && server.suspended_reason !== 'admin' ? ` (sebep: ${server.suspended_reason})` : ''}. Ayrıntı için destek ile iletişime geçin.`),
        expired ? h('div', { class: 'btn-group', style: { justifyContent: 'center' } },
            btn('Şimdi uzat', { variant: 'primary', iconName: 'clock', onClick: () => openRenewDialog(server) }),
            h('a', { class: 'btn', href: '#/billing' }, icon('wallet'), 'Bakiye yükle')) : null,
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
        root.appendChild(card({ body: emptyState({ iconName: 'server', title: 'Sunucu bulunamadı', text: 'Sunucu silinmiş, sıfırlanmış veya erişim yetkiniz kaldırılmış olabilir.', action: h('a', { class: 'btn btn-primary', href: '#/' }, 'Panele dön') }) }));
        setTitle('Sunucu bulunamadı');
        return;
    }
    const tabId = TABS.some(t => t.id === params.tab) ? params.tab : 'console';
    setTitle(server.name, [{ label: 'Sunucular', href: '#/' }]);

    const header = h('section', { class: 'card' });
    const refresh = () => loadServers().catch(() => {});
    function paintHeader() {
        const s = state.servers.find(x => x.id === params.id) || server;
        server = s;
        clear(header,
            h('div', { class: 'server-hero' },
                h('div', { class: 'identity' },
                    h('h1', {}, s.name),
                    h('div', { class: 'meta' }, statusBadge(s), copyable(s.address), s.protected ? badge('Korumalı', 'info') : null, s.is_pool ? badge('Havuz', '') : null)),
                s.suspended && state.user.role !== 'admin' ? null : powerControls(s, refresh)),
            s.is_pool ? null : subscriptionStrip(s),
            s.suspended ? null : statsStrip(s));
    }
    paintHeader();
    onCleanup(on('servers-updated', () => {
        const s = state.servers.find(x => x.id === params.id);
        if (!s) return;
        const suspendedChanged = !!s.suspended !== !!server.suspended;
        paintHeader();
        if (suspendedChanged) navigate(`/servers/${s.id}/${tabId}`);
    }));
    root.appendChild(header);

    if (server.suspended && state.user.role !== 'admin') {
        root.appendChild(paywall(server));
        return;
    }
    if (server.suspended) {
        root.appendChild(h('div', { class: 'alert alert-danger' }, icon('lock'), h('div', {}, h('strong', {}, 'Sunucu askıda'), h('p', {}, `Neden: ${server.suspended_reason || '—'}. Kullanıcı bu sunucuyu yönetemez; yönetici olarak erişiyorsunuz.`))));
    }

    const tabBar = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Sunucu bölümleri' },
        TABS.map(t => h('a', { class: `tab ${t.id === tabId ? 'active' : ''}`, role: 'tab', 'aria-selected': t.id === tabId ? 'true' : 'false', href: `#/servers/${server.id}/${t.id}` }, icon(t.icon, 'icon-sm'), t.label)));
    const panel = h('div', { class: 'stack', role: 'tabpanel' });
    append(root, tabBar, panel);
    // Keep the active tab visible on narrow screens.
    setTimeout(() => {
        const active = tabBar.querySelector('.active');
        if (active && tabBar.scrollWidth > tabBar.clientWidth) {
            tabBar.scrollLeft = Math.max(0, active.offsetLeft - (tabBar.clientWidth - active.offsetWidth) / 2);
        }
    }, 0);

    const ctx = { server, panel, onCleanup, isCurrent, refreshServers: refresh };
    const renderers = {
        console: tabs.consoleTab, logs: tabs.logsTab, files: tabs.filesTab, plugins: tabs.pluginsTab, maps: tabs.mapsTab,
        players: tabs.playersTab, admins: tabs.adminsTab, website: tabs.websiteTab, database: tabs.databaseTab,
        fastdl: tabs.fastdlTab, settings: tabs.settingsTab
    };
    try {
        await renderers[tabId](ctx);
    } catch (error) {
        panel.appendChild(errorBox(error));
    }
}

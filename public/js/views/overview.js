import { append, state, h, icon, card, fmtMoney, fmtDate, daysLeft, statusBadge, emptyState, on, clear, copyButton } from '../core.js';
import { loadServers } from '../main.js';

function statTile(label, value, iconName, meta) {
    return h('div', { class: 'card stat' },
        h('div', { class: 'stat-label' }, icon(iconName, 'icon-sm'), label),
        h('div', { class: 'stat-value' }, value),
        meta ? h('div', { class: 'stat-meta' }, meta) : null);
}

export function serverCard(s) {
    const left = daysLeft(s.expires_at);
    const expiry = s.suspended
        ? h('span', { class: 'text-danger' }, s.suspended_reason === 'expired' ? 'Süresi doldu — yenileyin' : 'Askıya alındı')
        : h('span', { class: left <= 3 ? 'text-warning' : '' }, left > 3650 ? 'Süresiz' : `${left} gün kaldı`);
    return h('a', { class: 'card server-card', href: `#/servers/${s.id}` },
        h('div', { class: 'top' },
            h('div', { style: { minWidth: '0' } }, h('h3', {}, s.name), h('div', { class: 'addr' }, s.address)),
            statusBadge(s)),
        h('div', { class: 'figures' },
            h('div', {}, h('span', {}, 'Oyuncu'), h('strong', {}, s.online ? `${s.players}/${s.maxPlayers}` : `0/${s.maxPlayers}`)),
            h('div', {}, h('span', {}, 'Harita'), h('strong', {}, s.map || '—')),
            h('div', {}, h('span', {}, 'FPS'), h('strong', {}, s.online && s.fps ? String(Math.round(s.fps)) : '—'))),
        h('div', { class: 'bottom' },
            h('span', {}, icon('tag', 'icon-sm'), ` ${s.plan_name}`),
            expiry));
}

export async function render({ root, setTitle, onCleanup }) {
    setTitle('Panelim');
    const user = state.user;
    const stats = h('div', { class: 'grid grid-4' });
    const serversBox = h('div');

    function paint() {
        const mine = state.servers.filter(s => !s.is_pool && (user.role !== 'admin' || s.owner_id === user.id));
        const online = mine.filter(s => s.online);
        const players = online.reduce((sum, s) => sum + (s.players || 0), 0);
        const expiring = mine.filter(s => !s.suspended && daysLeft(s.expires_at) <= 7 && daysLeft(s.expires_at) < 3650);
        clear(stats,
            statTile('Sunucularım', String(mine.length), 'server', `${online.length} çevrimiçi`),
            statTile('Aktif oyuncu', String(players), 'users', 'Tüm sunucularınızda'),
            statTile('Bakiye', fmtMoney(state.user.balance), 'wallet', h('a', { href: '#/billing' }, 'Bakiye yükle →')),
            statTile('Yaklaşan bitiş', String(expiring.length), 'clock', expiring.length ? `En yakın: ${fmtDate(expiring.sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at))[0].expires_at)}` : 'Önümüzdeki 7 gün içinde yok'));

        const suspended = mine.filter(s => s.suspended);
        clear(serversBox,
            suspended.length ? h('div', { class: 'alert alert-danger', style: { marginBottom: '16px' } }, icon('alert'),
                h('div', {}, h('strong', {}, `${suspended.length} sunucunuz askıda`), h('p', {}, 'Süresi dolan sunucular durduruldu. Askı süresi içinde yenilemezseniz dosyalar silinir.')),
                h('div', { class: 'alert-actions' }, h('a', { class: 'btn btn-sm btn-primary', href: `#/servers/${suspended[0].id}` }, 'Hemen yenile'))) : null,
            mine.length
                ? h('div', { class: 'server-cards' }, mine.map(serverCard))
                : card({ body: emptyState({
                    iconName: 'server',
                    title: 'Henüz bir sunucunuz yok',
                    text: 'Paketinizi seçin, birkaç saniyede kiralayın. Sunucunuz FastDL, MySQL veritabanı ve PHP web sitesiyle birlikte hazır gelir.',
                    action: h('a', { class: 'btn btn-primary', href: '#/rent' }, icon('cart'), 'Sunucu kirala')
                }) }));
    }

    append(root, 
        h('div', { class: 'page-head' },
            h('div', {}, h('h1', {}, `Merhaba, ${user.username}`), h('p', { class: 'lead' }, 'Sunucularınızın anlık durumu ve hesabınızın özeti.')),
            h('div', { class: 'btn-group' }, h('a', { class: 'btn', href: '#/billing' }, icon('wallet'), 'Bakiye yükle'), h('a', { class: 'btn btn-primary', href: '#/rent' }, icon('plus'), 'Yeni sunucu'))),
        stats,
        h('div', { class: 'stack' }, h('div', { class: 'row' }, h('h2', {}, 'Sunucularım'), h('span', { class: 'spacer' }),
            state.config && state.config.gameHost ? h('span', { class: 'small muted' }, `Sunucu adresi: ${state.config.gameHost}`, copyButton(state.config.gameHost)) : null), serversBox));
    paint();
    onCleanup(on('servers-updated', paint));
    onCleanup(on('summary-updated', paint));
    loadServers().catch(() => {});
}

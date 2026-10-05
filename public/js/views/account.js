import { append, state, api, h, clear, btn, card, badge, field, input, fmtDateTime, fmtRelative, toast, toastError, withBusy, confirmDialog, passwordScore, navigate } from '../core.js';
import { loadSummary } from '../main.js';

export async function render({ root, setTitle }) {
    setTitle('Hesabım');
    const user = state.user;

    const email = input({ type: 'email', value: user.email || '', placeholder: 'ornek@mail.com', autocomplete: 'email' });
    const saveProfile = btn('Kaydet', { variant: 'primary' });
    saveProfile.addEventListener('click', () => withBusy(saveProfile, async () => {
        try {
            await api('/api/account/profile', { method: 'PUT', body: { email: email.value.trim() } });
            await loadSummary();
            toast('Profil güncellendi.', 'success');
        } catch (error) { toastError(error); }
    }));

    const current = input({ type: 'password', autocomplete: 'current-password', required: true });
    const next = input({ type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
    const confirmNext = input({ type: 'password', autocomplete: 'new-password', required: true });
    const meter = h('div', { class: 'strength', 'data-score': '0' }, h('span'), h('span'), h('span'), h('span'));
    next.addEventListener('input', () => meter.setAttribute('data-score', String(passwordScore(next.value))));
    const errorEl = h('div', { class: 'form-error', hidden: true });
    const changeBtn = btn('Şifreyi değiştir', { variant: 'primary', type: 'submit' });
    const pwForm = h('form', { class: 'form-stack', onSubmit: e => {
        e.preventDefault();
        errorEl.hidden = true;
        if (next.value !== confirmNext.value) { errorEl.textContent = 'Yeni şifreler eşleşmiyor.'; errorEl.hidden = false; return; }
        withBusy(changeBtn, async () => {
            try {
                const data = await api('/api/account/password', { method: 'POST', body: { currentPassword: current.value, newPassword: next.value } });
                toast(data.message, 'success');
                pwForm.reset();
                meter.setAttribute('data-score', '0');
                await loadSummary();
            } catch (error) { errorEl.textContent = error.message; errorEl.hidden = false; }
        });
    } }, errorEl, field('Mevcut şifre', current), field('Yeni şifre', h('div', {}, next, meter), { help: 'En az 8 karakter; harf ve rakam içermeli.' }), field('Yeni şifre (tekrar)', confirmNext), h('div', { class: 'form-actions' }, changeBtn));

    const notifBox = h('div');
    async function loadNotifications() {
        try {
            const data = await api('/api/account/notifications?limit=50');
            clear(notifBox, data.notifications.length ? data.notifications.map(n => h('div', { class: `notif-item ${n.read_at ? '' : 'unread'}`, style: { cursor: n.link ? 'pointer' : 'default' }, onClick: () => { if (n.link && n.link.startsWith('#/')) window.location.hash = n.link; } },
                h('span', { class: `dot dot-${{ success: 'online', warning: 'starting', danger: 'offline' }[n.type] || 'suspended'}` }),
                h('div', { style: { flex: '1', minWidth: '0' } }, h('strong', {}, n.title), n.body ? h('p', {}, n.body) : null, h('time', {}, fmtRelative(n.created_at)))))
                : h('div', { class: 'table-empty' }, 'Bildiriminiz yok.'));
        } catch (error) { clear(notifBox, h('div', { class: 'table-empty' }, error.message)); }
    }

    append(root, 
        h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Hesabım'), h('p', { class: 'lead' }, 'Profil, güvenlik ve bildirim tercihleriniz.'))),
        h('div', { class: 'grid grid-2' },
            h('div', { class: 'stack' },
                card({ title: 'Profil', iconName: 'user', body: h('div', { class: 'form-stack' },
                    h('dl', { class: 'kv' },
                        h('dt', {}, 'Kullanıcı adı'), h('dd', {}, h('strong', {}, user.username)),
                        h('dt', {}, 'Hesap türü'), h('dd', {}, badge(user.role === 'admin' ? 'Yönetici' : 'Müşteri', user.role === 'admin' ? 'accent' : '')),
                        h('dt', {}, 'Üyelik tarihi'), h('dd', {}, fmtDateTime(user.created_at)),
                        h('dt', {}, 'Son giriş'), h('dd', {}, fmtDateTime(user.last_login_at)),
                        h('dt', {}, 'Ödeme referansı'), h('dd', {}, h('code', {}, state.summary.depositReference))),
                    field('E-posta', h('div', { class: 'input-group' }, email, saveProfile))) }),
                card({ title: 'Oturumlar', iconName: 'shield', sub: 'Başka bir cihazda açık kalan oturumunuz olduğunu düşünüyorsanız hepsini kapatın.',
                    body: btn('Tüm cihazlardan çıkış yap', { variant: 'danger', iconName: 'logout', onClick: async () => {
                        if (!(await confirmDialog({ title: 'Tüm oturumlar kapatılsın mı?', message: 'Bu cihaz dahil tüm cihazlarda yeniden giriş yapmanız gerekecek.', confirmText: 'Hepsini kapat', danger: true }))) return;
                        try { await api('/api/account/logout-all', { method: 'POST' }); toast('Tüm oturumlar kapatıldı.', 'success'); state.user = null; navigate('/login'); window.location.reload(); } catch (error) { toastError(error); }
                    } }) })),
            card({ title: 'Şifre değiştir', iconName: 'lock', body: pwForm })),
        card({ title: 'Bildirimler', iconName: 'bell', actions: [btn('Tümünü okundu say', { size: 'sm', variant: 'ghost', iconName: 'check', onClick: async () => {
            await api('/api/account/notifications/read', { method: 'POST', body: {} }).catch(toastError);
            loadNotifications();
            loadSummary().catch(() => {});
        } })], bodyClass: 'tight', body: notifBox }));
    loadNotifications();
}

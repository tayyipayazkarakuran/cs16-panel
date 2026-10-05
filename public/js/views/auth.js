import { append, state, api, h, clear, icon, btn, field, input, withBusy, passwordScore, navigate } from '../core.js';

function passwordField(id, label, { autocomplete = 'current-password', meter = false } = {}) {
    const control = input({ id, type: 'password', autocomplete, required: true, minlength: meter ? 8 : null });
    const toggle = btn(null, {
        iconName: 'eye', title: 'Şifreyi göster', onClick: () => {
            control.type = control.type === 'password' ? 'text' : 'password';
        }
    });
    const group = h('div', { class: 'input-group' }, control, toggle);
    const strength = meter ? h('div', { class: 'strength', 'data-score': '0', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span')) : null;
    if (meter) control.addEventListener('input', () => strength.setAttribute('data-score', String(passwordScore(control.value))));
    const wrapper = h('div', { class: 'field' }, h('label', { for: id }, label), group, strength,
        meter ? h('div', { class: 'help' }, 'En az 8 karakter; harf ve rakam içermeli.') : null);
    return { wrapper, control };
}

function messageBox() {
    const el = h('div', { role: 'alert', hidden: true });
    return {
        el,
        error(text) { el.className = 'form-error'; el.textContent = text; el.hidden = false; },
        success(text) { el.className = 'form-success'; el.textContent = text; el.hidden = false; },
        clear() { el.hidden = true; }
    };
}

function visual(config) {
    const points = [
        ['zap', '1000 FPS ReHLDS altyapı'],
        ['terminal', 'Canlı konsol ve RCON'],
        ['globe', 'Hazır PHP web sitesi'],
        ['database', 'Sunucuya özel MySQL'],
        ['download', 'Otomatik FastDL'],
        ['shield', 'İzole ve güvenli barındırma']
    ];
    return h('div', { class: 'auth-visual' },
        h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, 'CS'), h('span', {}, config.siteName || 'CS 1.6 Panel')),
        h('div', {},
            h('h2', {}, 'Counter-Strike 1.6 sunucunuz dakikalar içinde hazır.'),
            h('p', {}, 'Kirala, yönet, büyüt. Eklentiler, haritalar, oyuncular, web sitesi ve veritabanı tek panelde.'),
            h('div', { class: 'auth-points' }, points.map(([i, text]) => h('div', {}, icon(i), text)))),
        h('div', { class: 'small muted' }, config.supportContact ? `Destek: ${config.supportContact}` : ''));
}

export function renderAuth(root, mode, { query, onAuthenticated }) {
    const config = state.config || {};
    const panel = h('div', { class: 'auth-card' });
    clear(root, h('div', { class: 'auth' }, visual(config), h('div', { class: 'auth-panel' }, panel)));
    document.title = `${{ login: 'Giriş', register: 'Üye Ol', forgot: 'Şifremi Unuttum', reset: 'Yeni Şifre' }[mode]} · ${config.siteName || 'CS 1.6 Panel'}`;

    if (config.maintenance && mode !== 'login') {
        panel.appendChild(h('div', { class: 'alert alert-warning' }, icon('alert'), h('div', {}, h('strong', {}, 'Bakım çalışması'), h('p', {}, config.maintenance))));
    }

    if (mode === 'login') {
        const msg = messageBox();
        const user = input({ id: 'login-username', autocomplete: 'username', required: true, autofocus: true, placeholder: 'kullaniciadi veya e-posta' });
        const pw = passwordField('login-password', 'Şifre');
        const submit = btn('Giriş yap', { variant: 'primary', type: 'submit', attrs: { class: 'btn btn-primary btn-block' } });
        const form = h('form', { class: 'form-stack', onSubmit: async e => {
            e.preventDefault();
            msg.clear();
            await withBusy(submit, async () => {
                try {
                    const data = await api('/api/auth/login', { method: 'POST', body: { username: user.value.trim(), password: pw.control.value } });
                    await onAuthenticated(data.user);
                } catch (error) {
                    msg.error(error.message);
                }
            });
        } },
        msg.el,
        field('Kullanıcı adı veya e-posta', user),
        pw.wrapper,
        h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('a', { href: '#/forgot', class: 'small' }, 'Şifremi unuttum')),
        submit);
        append(panel, 
            h('div', {}, h('h1', {}, 'Tekrar hoş geldiniz'), h('p', { class: 'lead' }, 'Sunucularınızı yönetmek için giriş yapın.')),
            config.maintenance ? h('div', { class: 'alert alert-warning' }, icon('alert'), h('div', {}, h('strong', {}, 'Bakım çalışması'), h('p', {}, config.maintenance))) : null,
            form,
            config.registrationEnabled !== false
                ? h('p', { class: 'auth-switch' }, 'Hesabınız yok mu? ', h('a', { href: '#/register' }, 'Hemen üye olun'))
                : null);
        setTimeout(() => user.focus(), 30);
        return;
    }

    if (mode === 'register') {
        if (config.registrationEnabled === false) {
            append(panel, h('h1', {}, 'Üyelik kapalı'), h('p', { class: 'lead' }, 'Yeni üyelik alımı geçici olarak durduruldu.'), h('a', { class: 'btn btn-primary', href: '#/login' }, 'Girişe dön'));
            return;
        }
        const msg = messageBox();
        const username = input({ id: 'reg-username', autocomplete: 'username', required: true, minlength: 3, maxlength: 32, pattern: '[A-Za-z0-9_.\\-]{3,32}', placeholder: 'ornek_oyuncu' });
        const email = input({ id: 'reg-email', type: 'email', autocomplete: 'email', required: true, placeholder: 'ornek@mail.com' });
        const pw = passwordField('reg-password', 'Şifre', { autocomplete: 'new-password', meter: true });
        const confirmPw = passwordField('reg-password2', 'Şifre (tekrar)', { autocomplete: 'new-password' });
        const terms = h('input', { type: 'checkbox', id: 'reg-terms', required: true });
        const submit = btn('Hesap oluştur', { variant: 'primary', type: 'submit', attrs: { class: 'btn btn-primary btn-block' } });
        const form = h('form', { class: 'form-stack', onSubmit: async e => {
            e.preventDefault();
            msg.clear();
            if (pw.control.value !== confirmPw.control.value) return msg.error('Şifreler eşleşmiyor.');
            if (!terms.checked) return msg.error('Kullanım koşullarını kabul etmelisiniz.');
            await withBusy(submit, async () => {
                try {
                    const data = await api('/api/auth/register', {
                        method: 'POST',
                        body: { username: username.value.trim(), email: email.value.trim(), password: pw.control.value, acceptTerms: true }
                    });
                    await onAuthenticated(data.user);
                    navigate('/rent');
                } catch (error) {
                    msg.error(error.message);
                }
            });
        } },
        msg.el,
        field('Kullanıcı adı', username, { help: '3-32 karakter; harf, rakam, _ . -' }),
        field('E-posta', email, { help: 'Fatura ve şifre işlemleri için kullanılır.' }),
        pw.wrapper,
        confirmPw.wrapper,
        h('label', { class: 'check', for: 'reg-terms' }, terms, 'Kullanım koşullarını ve hizmet sözleşmesini okudum, kabul ediyorum.'),
        submit);
        append(panel, 
            h('div', {}, h('h1', {}, 'Ücretsiz üye olun'), h('p', { class: 'lead' }, 'Hesabınızı oluşturun, bakiye yükleyin ve sunucunuzu anında kiralayın.')),
            form,
            h('p', { class: 'auth-switch' }, 'Zaten üye misiniz? ', h('a', { href: '#/login' }, 'Giriş yapın')));
        setTimeout(() => username.focus(), 30);
        return;
    }

    if (mode === 'forgot') {
        const msg = messageBox();
        const login = input({ id: 'forgot-login', required: true, autocomplete: 'username', placeholder: 'kullaniciadi veya e-posta' });
        const submit = btn('Sıfırlama talebi gönder', { variant: 'primary', type: 'submit', attrs: { class: 'btn btn-primary btn-block' } });
        const form = h('form', { class: 'form-stack', onSubmit: async e => {
            e.preventDefault();
            await withBusy(submit, async () => {
                try {
                    const data = await api('/api/auth/forgot-password', { method: 'POST', body: { login: login.value.trim() } });
                    msg.success(data.message);
                    form.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
                } catch (error) {
                    msg.error(error.message);
                }
            });
        } }, msg.el, field('Kullanıcı adı veya e-posta', login), submit);
        append(panel, 
            h('div', {}, h('h1', {}, 'Şifrenizi mi unuttunuz?'), h('p', { class: 'lead' }, 'Talebiniz destek ekibine iletilir ve hesabınıza özel, tek kullanımlık bir sıfırlama bağlantısı gönderilir.')),
            form,
            h('p', { class: 'auth-switch' }, h('a', { href: '#/login' }, 'Girişe dön')));
        return;
    }

    // reset
    const token = query.get('token') || '';
    const msg = messageBox();
    const pw = passwordField('reset-password', 'Yeni şifre', { autocomplete: 'new-password', meter: true });
    const confirmPw = passwordField('reset-password2', 'Yeni şifre (tekrar)', { autocomplete: 'new-password' });
    const submit = btn('Şifreyi güncelle', { variant: 'primary', type: 'submit', attrs: { class: 'btn btn-primary btn-block' } });
    const form = h('form', { class: 'form-stack', onSubmit: async e => {
        e.preventDefault();
        if (pw.control.value !== confirmPw.control.value) return msg.error('Şifreler eşleşmiyor.');
        await withBusy(submit, async () => {
            try {
                const data = await api('/api/auth/reset-password', { method: 'POST', body: { token, password: pw.control.value } });
                msg.success(data.message);
                form.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
                setTimeout(() => { state.user = null; navigate('/login'); }, 1800);
            } catch (error) {
                msg.error(error.message);
            }
        });
    } }, msg.el, pw.wrapper, confirmPw.wrapper, submit);
    append(panel, 
        h('div', {}, h('h1', {}, 'Yeni şifre belirleyin'), h('p', { class: 'lead' }, 'Güncellemeden sonra tüm cihazlardaki oturumlarınız kapatılır.')),
        token ? form : h('div', { class: 'form-error' }, 'Sıfırlama bağlantısı eksik veya hatalı.'),
        h('p', { class: 'auth-switch' }, h('a', { href: '#/login' }, 'Girişe dön')));
}

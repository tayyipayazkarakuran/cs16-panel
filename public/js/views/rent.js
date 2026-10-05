import { append, state, api, h, icon, btn, card, clear, field, input, select, fmtMoney, withBusy, toast, generatePassword, emptyState, navigate, loading, errorBox } from '../core.js';
import { loadServers, loadSummary } from '../main.js';

const PERIODS = [1, 3, 6, 12];

export function planCard(plan, { selected, onSelect, cta = null }) {
    const el = h('button', {
        type: 'button',
        class: `card plan ${selected ? 'selected' : ''} ${plan.highlighted ? 'highlight' : ''}`,
        'data-ribbon': 'EN POPÜLER',
        'aria-pressed': selected ? 'true' : 'false',
        onClick: () => onSelect && onSelect(plan)
    },
    h('div', {}, h('h3', {}, plan.name), plan.description ? h('p', { class: 'small muted', style: { marginTop: '4px' } }, plan.description) : null),
    h('div', { class: 'price' }, plan.price > 0 ? fmtMoney(plan.price) : 'Ücretsiz',
        h('small', {}, plan.is_trial ? ` / ${plan.duration_days} gün` : ` / ${plan.duration_days} gün`)),
    h('ul', {},
        h('li', {}, icon('check', 'icon-sm'), `${plan.max_players} oyuncu slotu`),
        (plan.features || []).map(f => h('li', {}, icon('check', 'icon-sm'), f))),
    cta);
    return el;
}

export async function render({ root, setTitle, isCurrent }) {
    setTitle('Sunucu Kirala');
    root.appendChild(loading());
    let available;
    try {
        available = (await api('/api/servers/available')).servers;
    } catch (error) {
        clear(root, errorBox(error));
        return;
    }
    if (!isCurrent()) return;
    const plans = (state.config && state.config.plans) || [];
    clear(root);

    const form = {
        plan: (plans.find(p => p.highlighted && !p.is_trial) || plans.find(p => !p.is_trial) || plans[0] || {}).slug,
        months: 1,
        port: '',
        coupon: ''
    };

    root.appendChild(h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, 'Sunucu Kirala'), h('p', { class: 'lead' }, 'Paketinizi seçin, ödeme dönemini belirleyin. Sunucunuz FastDL, sunucuya özel MySQL veritabanı ve PHP web sitesiyle birlikte hazırlanır.'))));

    if (!plans.length) {
        root.appendChild(card({ body: emptyState({ iconName: 'tag', title: 'Satışta paket yok', text: 'Şu anda satın alınabilecek bir paket bulunmuyor.' }) }));
        return;
    }

    const planGrid = h('div', { class: 'plans' });
    const periodBox = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Ödeme dönemi' });
    const summaryBody = h('div');
    const couponInput = input({ placeholder: 'KUPONKODU', autocomplete: 'off', style: { textTransform: 'uppercase' } });
    const couponMsg = h('div', { class: 'small' });
    const nameInput = input({ id: 'rent-name', required: true, maxlength: 64, placeholder: 'Örn: Efsane Public [1000 FPS]' });
    const rconInput = input({ id: 'rent-rcon', required: true, minlength: 8, maxlength: 64, value: generatePassword(14), class: 'code', autocomplete: 'off' });
    const mapSelect = select(['de_dust2', 'de_inferno', 'de_nuke', 'de_train', 'de_mirage', 'cs_office', 'cs_assault', 'de_aztec'], { id: 'rent-map', value: 'de_dust2' });
    const portSelect = select([{ value: '', label: `Otomatik seç (${available.length} müsait)` }, ...available.map(s => ({ value: s.port, label: `Port ${s.port}` }))], { id: 'rent-port' });
    const submit = btn('Ödemeyi onayla ve kirala', { variant: 'primary', iconName: 'cart', attrs: { class: 'btn btn-primary btn-block' } });

    let discounts = {};
    let quoteSeq = 0;

    function paintPlans() {
        clear(planGrid, plans.map(plan => planCard(plan, {
            selected: plan.slug === form.plan,
            onSelect: p => { form.plan = p.slug; if (p.is_trial) form.months = 1; paintPlans(); paintPeriods(); refreshQuote(); }
        })));
    }

    function paintPeriods() {
        const plan = plans.find(p => p.slug === form.plan) || {};
        clear(periodBox, PERIODS.map(m => h('button', {
            type: 'button', class: m === form.months ? 'active' : '', disabled: plan.is_trial && m !== 1,
            'aria-pressed': m === form.months ? 'true' : 'false',
            onClick: () => { form.months = m; paintPeriods(); refreshQuote(); }
        }, `${m} ay`, discounts[m] ? h('span', { class: 'tag' }, `-%${discounts[m]}`) : null)));
    }

    async function refreshQuote() {
        const seq = ++quoteSeq;
        clear(summaryBody, loading('Fiyat hesaplanıyor…'));
        const params = new URLSearchParams({ plan: form.plan, months: String(form.months) });
        if (form.coupon) params.set('coupon', form.coupon);
        try {
            const q = await api(`/api/servers/quote?${params}`);
            if (seq !== quoteSeq) return;
            if (q.months) discounts[q.months] = q.periodDiscountPct;
            const balance = Number(state.user.balance) || 0;
            const enough = balance >= q.total;
            couponMsg.className = 'small text-success';
            couponMsg.textContent = q.coupon ? `${q.coupon.code} uygulandı.` : '';
            clear(summaryBody,
                h('div', { class: 'summary-line' }, h('span', {}, `${q.plan.name} × ${q.months} ay`), h('span', {}, fmtMoney(q.subtotal))),
                q.periodDiscount ? h('div', { class: 'summary-line' }, h('span', {}, `Dönem indirimi (%${q.periodDiscountPct})`), h('span', { class: 'discount' }, `-${fmtMoney(q.periodDiscount)}`)) : null,
                q.couponDiscount ? h('div', { class: 'summary-line' }, h('span', {}, `Kupon (${q.coupon.code})`), h('span', { class: 'discount' }, `-${fmtMoney(q.couponDiscount)}`)) : null,
                h('div', { class: 'summary-line total' }, h('span', {}, 'Ödenecek'), h('span', {}, fmtMoney(q.total))),
                h('div', { class: 'summary-line small' }, h('span', { class: 'muted' }, 'Süre'), h('span', {}, `${q.days} gün`)),
                h('div', { class: 'summary-line small' }, h('span', { class: 'muted' }, 'Mevcut bakiye'), h('span', { class: enough ? '' : 'text-danger' }, fmtMoney(balance))),
                enough ? null : h('div', { class: 'alert alert-warning mt-8' }, icon('wallet'),
                    h('div', {}, h('strong', {}, 'Bakiye yetersiz'), h('p', {}, `${fmtMoney(q.total - balance)} daha yüklemeniz gerekiyor.`)),
                    h('div', { class: 'alert-actions' }, h('a', { class: 'btn btn-sm btn-primary', href: '#/billing' }, 'Bakiye yükle'))));
            submit.disabled = !enough || !available.length;
            paintPeriods();
        } catch (error) {
            if (seq !== quoteSeq) return;
            if (form.coupon) {
                couponMsg.className = 'small text-danger';
                couponMsg.textContent = error.message;
                form.coupon = '';
                return refreshQuote();
            }
            clear(summaryBody, h('div', { class: 'form-error' }, error.message));
            submit.disabled = true;
        }
    }

    submit.addEventListener('click', () => withBusy(submit, async () => {
        if (!nameInput.reportValidity() || !rconInput.reportValidity()) return;
        try {
            const data = await api('/api/servers/create', {
                method: 'POST',
                timeoutMs: 180000,
                body: {
                    plan: form.plan, months: form.months, coupon: form.coupon || undefined,
                    port: portSelect.value || undefined, name: nameInput.value.trim(),
                    rconPassword: rconInput.value.trim(), map: mapSelect.value
                }
            });
            toast(data.message, 'success');
            await Promise.all([loadSummary(), loadServers()]);
            navigate(`/servers/${data.containerId}`);
        } catch (error) {
            toast(error.message, 'error');
            refreshQuote();
        }
    }));

    const configCard = card({
        title: 'Sunucu bilgileri', iconName: 'server',
        body: h('div', { class: 'form-grid' },
            h('div', { class: 'full' }, field('Sunucu adı (hostname)', nameInput)),
            field('RCON şifresi', h('div', { class: 'input-group' }, rconInput, btn(null, { iconName: 'refresh', title: 'Yeni şifre üret', onClick: () => { rconInput.value = generatePassword(14); } })), { help: 'Konsoldan sunucu yönetimi için. 8-64 karakter.' }),
            field('Başlangıç haritası', mapSelect),
            h('div', { class: 'full' }, field('Port', portSelect, { help: available.length ? 'Belirli bir port istemiyorsanız otomatik seçimi bırakın.' : 'Şu anda boş sunucu yok.' })))
    });

    const summaryCard = card({
        title: 'Sipariş özeti', iconName: 'receipt',
        body: h('div', { class: 'stack' },
            summaryBody,
            h('div', { class: 'field' }, h('label', {}, 'İndirim kuponu'),
                h('div', { class: 'input-group' }, couponInput, btn('Uygula', { onClick: () => { form.coupon = couponInput.value.trim().toUpperCase(); refreshQuote(); } })),
                couponMsg),
            submit,
            h('p', { class: 'small muted' }, 'Ücret bakiyenizden düşülür. Kurulum başarısız olursa tutar otomatik olarak iade edilir.'))
    });

    append(root, 
        available.length ? null : h('div', { class: 'alert alert-warning' }, icon('alert'), h('div', {}, h('strong', {}, 'Tüm sunucular dolu'), h('p', {}, 'Şu anda kiralanabilir boş port yok. Yeni kapasite eklendiğinde tekrar deneyin.'))),
        h('div', { class: 'stack' }, h('h2', {}, '1. Paket seçin'), planGrid),
        h('div', { class: 'grid grid-aside' },
            h('div', { class: 'stack' },
                h('div', { class: 'stack' }, h('h2', {}, '2. Ödeme dönemi'), h('div', {}, periodBox), h('p', { class: 'small muted' }, 'Uzun dönemlerde indirim otomatik uygulanır.')),
                h('h2', {}, '3. Sunucuyu yapılandırın'),
                configCard),
            summaryCard));

    paintPlans();
    paintPeriods();
    // Fetch the discount table once so every period button shows its badge.
    Promise.all(PERIODS.map(m => api(`/api/servers/quote?plan=${encodeURIComponent(form.plan)}&months=${m}`).then(q => { discounts[m] = q.periodDiscountPct; }).catch(() => {})))
        .then(paintPeriods);
    refreshQuote();
}

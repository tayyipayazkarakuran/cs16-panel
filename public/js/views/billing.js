import { append, state, api, h, clear, icon, btn, linkBtn, card, badge, table, field, input, fmtMoney, fmtDateTime, toast, toastError, withBusy, loading, copyable, openModal, errorBox, confirmDialog, emptyState } from '../core.js';
import { loadSummary } from '../main.js';
import { openReceipt } from '../components/receipt.js';

export const TX_TYPES = {
    deposit: ['Bakiye yükleme', 'success'],
    purchase: ['Sunucu kiralama', 'accent'],
    renewal: ['Süre uzatma', 'accent'],
    refund: ['İade', 'success'],
    adjustment: ['Bakiye düzeltme', 'info'],
    charge: ['Bakiye düşümü', 'warning'],
    trial: ['Deneme', 'info'],
    withdrawal: ['Para çekme', 'warning'],
    withdrawal_reversal: ['Çekim iadesi', 'success']
};

/** Ledger types that get a numbered receipt (withdrawals only once paid). */
export const RECEIPT_TYPES = new Set(['purchase', 'renewal', 'refund', 'deposit', 'withdrawal']);

const REQUEST_STATUS = {
    pending: ['İnceleniyor', 'warning'],
    approved: ['Onaylandı', 'success'],
    paid: ['Ödendi', 'success'],
    rejected: ['Reddedildi', 'danger'],
    cancelled: ['İptal edildi', '']
};

export function requestStatusBadge(status) {
    const [label, variant] = REQUEST_STATUS[status] || [status, ''];
    return badge(label, variant);
}

const PAYMENT_STATUS = {
    pending: ['Onay bekliyor', 'warning'],
    approved: ['Onaylandı', 'success'],
    rejected: ['Reddedildi', 'danger']
};

export function paymentStatusBadge(status) {
    const [label, variant] = PAYMENT_STATUS[status] || [status, ''];
    return badge(label, variant);
}

/** Receipts are fetched with the session and shown from a Blob URL. */
export async function viewReceipt(receiptPath) {
    const filename = String(receiptPath || '').split('/').pop();
    try {
        const res = await fetch(`/api/payments/receipt/${encodeURIComponent(filename)}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Dekont açılamadı.');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const body = blob.type === 'application/pdf'
            ? h('iframe', { src: url, title: 'Dekont', class: 'receipt-frame' })
            : h('img', { src: url, alt: 'Dekont', class: 'receipt-img' });
        openModal({ title: 'Dekont', size: 'lg', body, footer: [linkBtn('İndir', url, { iconName: 'download', attrs: { download: filename } })], onClose: () => URL.revokeObjectURL(url) });
    } catch (error) {
        toastError(error);
    }
}

export async function render({ root, setTitle, isCurrent }) {
    setTitle('Bakiye & Ödemeler');
    root.appendChild(loading());
    let info;
    try { info = await api('/api/payments/iban'); } catch (error) { clear(root, errorBox(error)); return; }
    if (!isCurrent()) return;
    clear(root);

    const balanceValue = h('div', { class: 'stat-value stat-value-lg' }, fmtMoney(state.user.balance));
    const historyBox = h('div', {}, loading());
    const txBox = h('div', {}, loading());
    let txOffset = 0;

    async function loadPayments() {
        try {
            const data = await api('/api/payments/my');
            clear(historyBox, table([
                { label: 'Tarih', class: 'nowrap small', render: p => fmtDateTime(p.created_at) },
                { label: 'Gönderen', key: 'sender_name' },
                { label: 'Tutar', class: 'num', render: p => fmtMoney(p.amount) },
                { label: 'Durum', render: p => h('div', {}, paymentStatusBadge(p.status), p.admin_note ? h('div', { class: 'small muted mt-1' }, p.admin_note) : null) },
                { label: '', class: 'actions', render: p => (p.receipt_path ? btn('Dekont', { size: 'xs', iconName: 'receipt', onClick: () => viewReceipt(p.receipt_path) }) : '') }
            ], data.payments || [], { empty: 'Henüz ödeme bildiriminiz yok.' }));
        } catch (error) { clear(historyBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    async function loadTransactions() {
        try {
            const data = await api(`/api/account/transactions?limit=20&offset=${txOffset}`);
            const pager = h('div', { class: 'card-foot' },
                h('span', { class: 'left' }, `${data.total} hareket`),
                btn('Önceki', { size: 'sm', disabled: txOffset === 0, onClick: () => { txOffset = Math.max(0, txOffset - 20); loadTransactions(); } }),
                btn('Sonraki', { size: 'sm', disabled: txOffset + 20 >= data.total, onClick: () => { txOffset += 20; loadTransactions(); } }));
            clear(txBox, table([
                { label: 'Tarih', class: 'nowrap small', render: t => fmtDateTime(t.created_at) },
                { label: 'İşlem', render: t => { const [label, variant] = TX_TYPES[t.type] || [t.type, '']; return badge(label, variant); } },
                { label: 'Açıklama', render: t => h('span', { class: 'small' }, t.description || '') },
                { label: 'Tutar', class: 'num nowrap', render: t => h('strong', { class: t.amount > 0 ? 'text-success' : t.amount < 0 ? 'text-danger' : '' }, `${t.amount > 0 ? '+' : ''}${fmtMoney(t.amount)}`) },
                { label: 'Bakiye', class: 'num nowrap muted', render: t => fmtMoney(t.balance_after), hideSm: true },
                { label: '', type: 'actions', render: t => (RECEIPT_TYPES.has(t.type) && Number(t.amount) !== 0
                    ? btn(null, { size: 'xs', variant: 'ghost', iconName: 'receipt', title: 'Makbuzu görüntüle', onClick: () => openReceipt({ transactionId: t.id }) }) : null) }
            ], data.transactions || [], { empty: 'Henüz hesap hareketi yok.' }), data.total > 20 ? pager : null);
        } catch (error) { clear(txBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    const amount = input({ type: 'number', min: info.min_deposit, step: '0.01', placeholder: `En az ${info.min_deposit}`, required: true });
    const sender = input({ maxlength: 120, placeholder: 'Havaleyi gönderen ad soyad', required: true, autocomplete: 'name' });
    const receipt = h('input', { type: 'file', accept: 'image/png,image/jpeg,application/pdf', class: 'input' });
    const submit = btn('Ödeme bildirimi gönder', { variant: 'primary', iconName: 'send', block: true });
    submit.addEventListener('click', () => withBusy(submit, async () => {
        if (!amount.reportValidity() || !sender.reportValidity()) return;
        const form = new FormData();
        form.append('amount', amount.value);
        form.append('senderName', sender.value.trim());
        if (receipt.files[0]) form.append('receipt', receipt.files[0]);
        try {
            const data = await api('/api/payments/report', { method: 'POST', form });
            toast(data.message, 'success');
            amount.value = '';
            receipt.value = '';
            loadPayments();
        } catch (error) { toastError(error); }
    }));

    // ---- Refund requests & withdrawals -----------------------------------
    const refundsBox = h('div', {}, loading());
    async function loadRefunds() {
        try {
            const data = await api('/api/refunds');
            clear(refundsBox, data.requests.length ? table([
                { label: 'Tarih', type: 'date', render: r => fmtDateTime(r.created_at) },
                { label: 'Sunucu', render: r => h('div', { class: 'cell-title' }, h('strong', {}, r.server_name || `Port ${r.port}`), h('span', {}, r.reason || '')) },
                { label: 'Tutar', type: 'money', render: r => fmtMoney(r.approved_amount ?? r.quoted_amount) },
                { label: 'Durum', render: r => h('div', { class: 'cell-title' }, requestStatusBadge(r.status), r.admin_note ? h('span', {}, r.admin_note) : null) },
                { label: '', type: 'actions', render: r => (r.status === 'pending' ? btn('İptal et', { size: 'xs', variant: 'ghost', onClick: async () => {
                    if (!(await confirmDialog({ title: 'İade talebi iptal edilsin mi?', message: 'Talebiniz geri çekilir; dilerseniz daha sonra yeniden talep edebilirsiniz.', confirmText: 'Talebi iptal et' }))) return;
                    try { await api(`/api/refunds/${r.id}/cancel`, { method: 'POST' }); toast('Talep iptal edildi.', 'success'); loadRefunds(); } catch (e) { toastError(e); }
                } }) : null) }
            ], data.requests) : emptyState({ iconName: 'wallet', title: 'İade talebiniz yok', text: 'Kalan süre için iade talebini sunucu sayfasındaki ⋯ menüsünden açabilirsiniz.' }));
        } catch (error) { clear(refundsBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    const withdrawBox = h('div', {}, loading());
    async function loadWithdrawals() {
        try {
            const data = await api('/api/withdrawals');
            if (!data.enabled) { clear(withdrawBox, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Bakiye çekme şu anda kapalı.'))); return; }
            const amountIn = input({ type: 'number', min: data.minAmount, step: '0.01', placeholder: `En az ${data.minAmount}`, 'aria-label': 'Tutar' });
            const ibanIn = input({ placeholder: 'TR00 0000 0000 0000 0000 0000 00', class: 'code', maxlength: 34, autocomplete: 'off', 'aria-label': 'IBAN' });
            const holderIn = input({ placeholder: 'Ad Soyad', maxlength: 100, autocomplete: 'name', 'aria-label': 'Hesap sahibi' });
            const send = btn('Çekim talebi oluştur', { variant: 'primary', iconName: 'send' });
            send.addEventListener('click', () => withBusy(send, async () => {
                const value = Number(amountIn.value);
                if (!(value >= data.minAmount)) return toast(`En az ${fmtMoney(data.minAmount)} çekebilirsiniz.`, 'warning');
                if (value > Number(state.user.balance)) return toast('Bakiyenizden fazla çekemezsiniz.', 'warning');
                if (!(await confirmDialog({ title: 'Çekim talebi', message: `${fmtMoney(value)} bakiyenizden ayrılıp onaydan sonra ${ibanIn.value.trim()} hesabına gönderilecek. Reddedilirse tutar bakiyenize geri yüklenir.`, confirmText: 'Talebi gönder' }))) return;
                try {
                    const res = await api('/api/withdrawals', { method: 'POST', body: { amount: value, iban: ibanIn.value, holder: holderIn.value } });
                    toast(res.message, 'success');
                    await loadSummary();
                    balanceValue.textContent = fmtMoney(state.user.balance);
                    loadWithdrawals();
                    loadTransactions();
                } catch (e) { toastError(e); }
            }));
            clear(withdrawBox,
                h('div', { class: 'card-body form-stack' },
                    h('p', { class: 'small muted' }, 'Kullanılmayan bakiyenizi kendi adınıza kayıtlı bir TR IBAN\'a çekebilirsiniz. Tutar talep anında bakiyenizden ayrılır; ödeme yapıldığında makbuz kesilir.'),
                    h('div', { class: 'form-grid form-grid-3' }, field(`Tutar (${info.currency})`, amountIn), field('IBAN', ibanIn), field('Hesap sahibi', holderIn)),
                    h('div', { class: 'form-actions' }, send)),
                data.withdrawals.length ? table([
                    { label: 'Tarih', type: 'date', render: w => fmtDateTime(w.created_at) },
                    { label: 'IBAN', type: 'mono', render: w => `…${w.iban.slice(-8)}`, hideSm: true },
                    { label: 'Tutar', type: 'money', render: w => fmtMoney(w.amount) },
                    { label: 'Durum', render: w => h('div', { class: 'cell-title' }, requestStatusBadge(w.status), w.admin_note || w.payout_reference ? h('span', {}, [w.payout_reference ? `Ref. ${w.payout_reference}` : null, w.admin_note].filter(Boolean).join(' · ')) : null) }
                ], data.withdrawals) : null);
        } catch (error) { clear(withdrawBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    append(root, 
        h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Bakiye & Ödemeler'), h('p', { class: 'lead' }, 'Havale/EFT ile bakiye yükleyin; kiralama ve yenilemeler bakiyenizden düşülür.'))),
        h('div', { class: 'grid grid-3' },
            card({ body: h('div', { class: 'stack stack-sm' }, h('div', { class: 'stat-label' }, icon('wallet', 'icon-sm'), 'Kullanılabilir bakiye'), balanceValue,
                h('p', { class: 'small muted' }, 'Bakiyeniz onaylanan ödemelerle güncellenir.'),
                btn('Yenile', { size: 'sm', variant: 'ghost', iconName: 'refresh', onClick: async () => { await loadSummary(); balanceValue.textContent = fmtMoney(state.user.balance); loadTransactions(); } })) }),
            card({ title: '1. Havale / EFT yapın', iconName: 'receipt', body: h('div', { class: 'form-stack' },
                h('pre', { class: 'log-box short iban-box' }, info.iban_details || 'Banka bilgisi tanımlanmamış.'),
                h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Açıklama kısmına mutlaka yazın'), copyable(info.reference_code)),
                h('p', { class: 'small muted' }, 'Referans kodu ödemenizin hızlı eşleşmesini sağlar.')) }),
            card({ title: '2. Bildirim gönderin', iconName: 'send', body: h('div', { class: 'form-stack' },
                field(`Tutar (${info.currency})`, amount), field('Gönderen ad soyad', sender), field('Dekont (isteğe bağlı)', receipt, { help: 'PNG, JPG veya PDF · en fazla 5 MB' }), submit) })),
        card({ title: 'Hesap hareketleri', iconName: 'activity', sub: 'Tüm yükleme, kiralama, yenileme ve iadeler.', bodyClass: 'tight', body: txBox }),
        card({ title: 'Ödeme bildirimlerim', iconName: 'list', bodyClass: 'tight', body: historyBox }),
        h('div', { class: 'grid grid-2 align-start' },
            card({ title: 'İade talepleri', iconName: 'refresh', sub: 'Kullanılmayan kiralama süresinin bakiyeye iadesi.', bodyClass: 'tight', body: refundsBox }),
            card({ title: 'Bakiye çek', iconName: 'download', sub: 'Bakiyenizi banka hesabınıza aktarın.', bodyClass: 'tight', body: withdrawBox })));
    loadPayments();
    loadTransactions();
    loadRefunds();
    loadWithdrawals();
}

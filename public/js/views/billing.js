import { append, state, api, h, clear, icon, btn, card, badge, table, field, input, fmtMoney, fmtDateTime, toast, toastError, withBusy, loading, copyable, openModal, errorBox } from '../core.js';
import { loadSummary } from '../main.js';

export const TX_TYPES = {
    deposit: ['Bakiye yükleme', 'success'],
    purchase: ['Sunucu kiralama', 'accent'],
    renewal: ['Süre uzatma', 'accent'],
    refund: ['İade', 'success'],
    adjustment: ['Bakiye düzeltme', 'info'],
    charge: ['Bakiye düşümü', 'warning'],
    trial: ['Deneme', 'info']
};

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
            ? h('iframe', { src: url, title: 'Dekont', style: { width: '100%', height: '70vh', border: '0', background: '#fff' } })
            : h('img', { src: url, alt: 'Dekont', style: { maxWidth: '100%', display: 'block', margin: '0 auto', borderRadius: '8px' } });
        openModal({ title: 'Dekont', size: 'lg', body, footer: [h('a', { class: 'btn', href: url, download: filename }, icon('download'), 'İndir')], onClose: () => URL.revokeObjectURL(url) });
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

    const balanceValue = h('div', { class: 'stat-value', style: { fontSize: '32px' } }, fmtMoney(state.user.balance));
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
                { label: 'Durum', render: p => h('div', {}, paymentStatusBadge(p.status), p.admin_note ? h('div', { class: 'small muted', style: { marginTop: '4px' } }, p.admin_note) : null) },
                { label: '', class: 'actions', render: p => (p.receipt_path ? btn('Dekont', { size: 'xs', iconName: 'receipt', onClick: () => viewReceipt(p.receipt_path) }) : '') }
            ], data.payments || [], { empty: 'Henüz ödeme bildiriminiz yok.' }));
        } catch (error) { clear(historyBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    async function loadTransactions() {
        try {
            const data = await api(`/api/account/transactions?limit=20&offset=${txOffset}`);
            const pager = h('div', { class: 'card-foot' },
                h('span', { class: 'small muted', style: { marginRight: 'auto' } }, `${data.total} hareket`),
                btn('Önceki', { size: 'sm', disabled: txOffset === 0, onClick: () => { txOffset = Math.max(0, txOffset - 20); loadTransactions(); } }),
                btn('Sonraki', { size: 'sm', disabled: txOffset + 20 >= data.total, onClick: () => { txOffset += 20; loadTransactions(); } }));
            clear(txBox, table([
                { label: 'Tarih', class: 'nowrap small', render: t => fmtDateTime(t.created_at) },
                { label: 'İşlem', render: t => { const [label, variant] = TX_TYPES[t.type] || [t.type, '']; return badge(label, variant); } },
                { label: 'Açıklama', render: t => h('span', { class: 'small' }, t.description || '') },
                { label: 'Tutar', class: 'num nowrap', render: t => h('strong', { class: t.amount > 0 ? 'text-success' : t.amount < 0 ? 'text-danger' : '' }, `${t.amount > 0 ? '+' : ''}${fmtMoney(t.amount)}`) },
                { label: 'Bakiye', class: 'num nowrap muted', render: t => fmtMoney(t.balance_after) }
            ], data.transactions || [], { empty: 'Henüz hesap hareketi yok.' }), data.total > 20 ? pager : null);
        } catch (error) { clear(txBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    const amount = input({ type: 'number', min: info.min_deposit, step: '0.01', placeholder: `En az ${info.min_deposit}`, required: true });
    const sender = input({ maxlength: 120, placeholder: 'Havaleyi gönderen ad soyad', required: true, autocomplete: 'name' });
    const receipt = h('input', { type: 'file', accept: 'image/png,image/jpeg,application/pdf', class: 'input' });
    const submit = btn('Ödeme bildirimi gönder', { variant: 'primary', iconName: 'send', attrs: { class: 'btn btn-primary btn-block' } });
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

    append(root, 
        h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Bakiye & Ödemeler'), h('p', { class: 'lead' }, 'Havale/EFT ile bakiye yükleyin; kiralama ve yenilemeler bakiyenizden düşülür.'))),
        h('div', { class: 'grid grid-3' },
            card({ body: h('div', { class: 'stack', style: { gap: '8px' } }, h('div', { class: 'stat-label' }, icon('wallet', 'icon-sm'), 'Kullanılabilir bakiye'), balanceValue,
                h('p', { class: 'small muted' }, 'Bakiyeniz onaylanan ödemelerle güncellenir.'),
                btn('Yenile', { size: 'sm', variant: 'ghost', iconName: 'refresh', onClick: async () => { await loadSummary(); balanceValue.textContent = fmtMoney(state.user.balance); loadTransactions(); } })) }),
            card({ title: '1. Havale / EFT yapın', iconName: 'receipt', body: h('div', { class: 'form-stack' },
                h('pre', { class: 'log-box short', style: { whiteSpace: 'pre-wrap', color: 'var(--text)', fontSize: '13px' } }, info.iban_details || 'Banka bilgisi tanımlanmamış.'),
                h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Açıklama kısmına mutlaka yazın'), copyable(info.reference_code)),
                h('p', { class: 'small muted' }, 'Referans kodu ödemenizin hızlı eşleşmesini sağlar.')) }),
            card({ title: '2. Bildirim gönderin', iconName: 'send', body: h('div', { class: 'form-stack' },
                field(`Tutar (${info.currency})`, amount), field('Gönderen ad soyad', sender), field('Dekont (isteğe bağlı)', receipt, { help: 'PNG, JPG veya PDF · en fazla 5 MB' }), submit) })),
        card({ title: 'Hesap hareketleri', iconName: 'activity', sub: 'Tüm yükleme, kiralama, yenileme ve iadeler.', bodyClass: 'tight', body: txBox }),
        card({ title: 'Ödeme bildirimlerim', iconName: 'list', bodyClass: 'tight', body: historyBox }));
    loadPayments();
    loadTransactions();
}

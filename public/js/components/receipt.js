// Numbered receipt viewer with a print-friendly layout.
import { api, h, btn, openModal, loading, errorBox, clear, fmtMoney, fmtDateTime, toastError } from '../core.js';

const TYPE_LABEL = {
    purchase: 'Sunucu kiralama', renewal: 'Süre uzatma', refund: 'İade', deposit: 'Bakiye yükleme', withdrawal: 'Para çekme'
};

function renderReceipt(r) {
    const currency = r.seller.currency || 'TL';
    const money = v => `${Number(v).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
    return h('article', { class: 'receipt-doc' },
        h('header', { class: 'receipt-top' },
            h('div', {}, h('strong', { class: 'receipt-seller' }, r.seller.name || ''), h('div', { class: 'small muted pre-line' }, r.seller.info || '')),
            h('div', { class: 'right' }, h('div', { class: 'eyebrow' }, 'Makbuz'), h('div', { class: 'receipt-number mono' }, r.number), h('div', { class: 'small muted' }, fmtDateTime(r.created_at)))),
        h('dl', { class: 'kv receipt-meta' },
            h('dt', {}, 'Müşteri'), h('dd', {}, `${r.buyer.username || '#' + r.user_id}${r.buyer.email ? ` · ${r.buyer.email}` : ''}`),
            h('dt', {}, 'İşlem'), h('dd', {}, TYPE_LABEL[r.type] || r.type),
            h('dt', {}, 'İşlem no'), h('dd', { class: 'mono' }, `#${r.transaction_id}`)),
        h('table', { class: 'table receipt-lines' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Açıklama'), h('th', { class: 'num' }, 'Miktar'), h('th', { class: 'num' }, 'Tutar'))),
            h('tbody', {}, r.lines.map(l => h('tr', {},
                h('td', {}, l.description),
                h('td', { class: 'num' }, l.quantity ? `${l.quantity}${l.unitPrice ? ` × ${money(l.unitPrice)}` : ''}` : ''),
                h('td', { class: 'num' }, money(l.amount))))),
            h('tfoot', {}, h('tr', {}, h('th', { colspan: '2' }, 'Toplam'), h('th', { class: 'num' }, money(r.amount))))),
        h('p', { class: 'small muted' }, 'Bu belge panel içi bakiye hareketinin dökümüdür; resmi fatura yerine geçmez.'));
}

/** openReceipt({ id }) or openReceipt({ transactionId }) */
export function openReceipt({ id = null, transactionId = null }) {
    const body = h('div', {}, loading('Makbuz yükleniyor…'));
    const printBtn = btn('Yazdır / PDF', { variant: 'primary', iconName: 'download', disabled: true, onClick: () => {
        document.body.classList.add('printing-receipt');
        const done = () => { document.body.classList.remove('printing-receipt'); window.removeEventListener('afterprint', done); };
        window.addEventListener('afterprint', done);
        window.print();
        setTimeout(done, 1000);
    } });
    const modal = openModal({ title: 'Makbuz', size: 'lg', body, footer: [btn('Kapat', { variant: 'ghost', onClick: () => modal.close() }), printBtn] });
    api(id ? `/api/receipts/${id}` : `/api/receipts/by-transaction/${transactionId}`)
        .then(data => { clear(body, renderReceipt(data.receipt)); printBtn.disabled = false; modal.dialog.querySelector('.modal-head h2').textContent = `Makbuz ${data.receipt.number}`; })
        .catch(e => { clear(body, errorBox(e)); if (e.status !== 404) toastError(e); });
    return modal;
}

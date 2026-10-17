// Bank-transfer (havale/EFT) top-up dialog, usable from any checkout or the
// paywall. With an `intent` the panel renews the server automatically as soon
// as an operator approves the transfer.
import { api, h, clear, icon, btn, field, input, copyable, openModal, withBusy, loading, errorBox, fmtMoney, toast, emit, state } from '../core.js';

let ibanCache = null;
async function bankInfo() {
    if (!ibanCache) ibanCache = await api('/api/payments/iban');
    return ibanCache;
}

/**
 * openDepositDialog({ suggestedAmount, intent, intentLabel, title })
 * Resolves true when a transfer report was submitted.
 */
export function openDepositDialog({ suggestedAmount = null, intent = null, intentLabel = null, title = 'Havale / EFT ile bakiye yükle' } = {}) {
    return new Promise(resolve => {
        const body = h('div', {}, loading('Banka bilgileri yükleniyor…'));
        const submit = btn('Ödeme bildirimi gönder', { variant: 'primary', iconName: 'send', disabled: true });
        let submitted = false;
        const modal = openModal({
            title, size: 'lg', body,
            footer: [btn('Vazgeç', { variant: 'ghost', onClick: () => modal.close() }), submit],
            onClose: () => resolve(submitted)
        });

        bankInfo().then(info => {
            const min = Number(info.min_deposit) || 0;
            const start = suggestedAmount ? Math.max(min, Math.ceil(Number(suggestedAmount) * 100) / 100) : '';
            const amount = input({ type: 'number', min, step: '0.01', value: start === '' ? '' : String(start), required: true, 'aria-label': 'Tutar' });
            const sender = input({ maxlength: 120, placeholder: 'Havaleyi gönderen ad soyad', required: true, autocomplete: 'name', value: '' });
            const receipt = h('input', { type: 'file', accept: 'image/png,image/jpeg,application/pdf', class: 'input' });
            const autoBox = intent ? h('input', { type: 'checkbox', checked: true }) : null;
            const error = h('div', { class: 'form-error', hidden: true, role: 'alert' });
            submit.disabled = false;
            clear(body, h('div', { class: 'deposit-grid' },
                h('div', { class: 'stack stack-sm' },
                    h('div', { class: 'eyebrow' }, '1. Havale / EFT yapın'),
                    h('pre', { class: 'log-box short iban-box' }, info.iban_details || 'Banka bilgisi tanımlanmamış.'),
                    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Açıklamaya mutlaka yazın'), copyable(info.reference_code)),
                    suggestedAmount ? h('div', { class: 'alert alert-info' }, icon('info'), h('div', {}, h('strong', {}, `Önerilen tutar: ${fmtMoney(start)}`),
                        h('p', {}, `Mevcut bakiyeniz ${fmtMoney(state.user.balance)}. Eksik tutar kadar ödeme yeterlidir.`))) : null),
                h('form', { class: 'form-stack', onSubmit: e => { e.preventDefault(); submit.click(); } },
                    h('div', { class: 'eyebrow' }, '2. Bildirim gönderin'),
                    error,
                    field(`Tutar (${info.currency})`, amount, { help: `En az ${fmtMoney(min)}` }),
                    field('Gönderen ad soyad', sender),
                    field('Dekont (isteğe bağlı)', receipt, { help: 'PNG, JPG veya PDF · en fazla 5 MB. Dekont onayı hızlandırır.' }),
                    autoBox ? h('label', { class: 'check' }, autoBox, intentLabel || 'Ödeme onaylanınca süreyi otomatik uzat') : null,
                    h('button', { type: 'submit', hidden: true, tabindex: '-1' }))));
            setTimeout(() => (amount.value ? sender : amount).focus(), 30);

            submit.addEventListener('click', () => withBusy(submit, async () => {
                error.hidden = true;
                if (!amount.reportValidity() || !sender.reportValidity()) return;
                const form = new FormData();
                form.append('amount', amount.value);
                form.append('senderName', sender.value.trim());
                if (autoBox && autoBox.checked) form.append('intent', JSON.stringify(intent));
                if (receipt.files[0]) form.append('receipt', receipt.files[0]);
                try {
                    const data = await api('/api/payments/report', { method: 'POST', form });
                    submitted = true;
                    toast(data.message, 'success', 7000);
                    emit('payments-changed');
                    modal.close();
                } catch (e) {
                    error.textContent = e.message;
                    error.hidden = false;
                }
            }));
        }).catch(e => clear(body, errorBox(e)));
    });
}

// Refunds (prorated, to balance) and balance withdrawals (to IBAN).
//
// Every paid rental/renewal is stored as a row in panel_rental_periods, so a
// refund can be computed exactly from what was paid for the time that is
// still unused. Money moves only through panelDb.recordBalanceChange inside a
// transaction, and every movement gets a numbered receipt.
const panelDb = require('./panelDb');

const { httpError, money } = panelDb;
const DAY_MS = 86400000;
// shorten: remove the refunded time from the subscription (suspends if nothing is left)
// release: delete the server now; keep: goodwill refund, subscription unchanged.
const SERVER_ACTIONS = ['shorten', 'release', 'keep'];
const MAX_PENDING_WITHDRAWALS = 3;

// ---------------------------------------------------------------------------
//  Pure calculation
// ---------------------------------------------------------------------------

/**
 * Prorated refund for the unused part of a server's paid periods.
 * periods: rows of panel_rental_periods (any order). Periods that already
 * ended, trials, voided and fully refunded periods contribute nothing; a
 * period that has not started yet is refunded in full.
 * Returns { gross, fee, total, feePercent, items: [{ periodId, ... }] } with
 * items ordered newest first (the order refunds are allocated in).
 */
function computeRefund(periods, now = new Date(), { feePercent = 0 } = {}) {
    const nowMs = now.getTime();
    const items = [];
    const sorted = [...periods].sort((a, b) => new Date(b.ends_at) - new Date(a.ends_at));
    for (const p of sorted) {
        if (p.status === 'void' || p.status === 'refunded' || p.kind === 'trial') continue;
        const start = new Date(p.starts_at).getTime();
        const end = new Date(p.ends_at).getTime();
        if (!(end > nowMs) || !(end > start)) continue;
        const refundable = money(Number(p.amount_paid) - Number(p.refunded_amount || 0));
        if (refundable <= 0) continue;
        const remainingMs = end - Math.max(nowMs, start);
        const ratio = Math.min(1, remainingMs / (end - start));
        const amount = money(refundable * ratio);
        if (amount <= 0) continue;
        items.push({
            periodId: p.id,
            planName: p.plan_name,
            kind: p.kind,
            startsAt: new Date(start).toISOString(),
            endsAt: new Date(end).toISOString(),
            paid: money(p.amount_paid),
            alreadyRefunded: money(p.refunded_amount || 0),
            remainingMs,
            remainingDays: Math.round(remainingMs / DAY_MS * 10) / 10,
            totalDays: Math.round((end - start) / DAY_MS * 10) / 10,
            ratio: Math.round(ratio * 10000) / 10000,
            amount
        });
    }
    const gross = money(items.reduce((sum, i) => sum + i.amount, 0));
    const pct = Math.min(100, Math.max(0, Number(feePercent) || 0));
    const fee = money(gross * pct / 100);
    return { gross, fee, feePercent: pct, total: money(gross - fee), items };
}

/**
 * Split an approved refund amount over the computed items, newest first, so
 * no period is ever refunded more than its prorated share.
 */
function allocateRefund(items, amount) {
    let left = money(amount);
    const out = [];
    let refundedMs = 0;
    for (const item of items) {
        if (left <= 0) break;
        const share = money(Math.min(item.amount, left));
        out.push({ periodId: item.periodId, amount: share });
        // Time given back is proportional to the money given back for this period.
        refundedMs += item.amount > 0 ? Math.round((item.remainingMs || 0) * (share / item.amount)) : 0;
        left = money(left - share);
    }
    return { allocations: out, unallocated: left, refundedMs };
}

/** Turkish IBAN: TR + 24 digits, ISO 13616 mod-97 checksum. */
function normalizeIban(value) {
    const iban = String(value || '').replace(/\s+/g, '').toUpperCase();
    if (!/^TR\d{24}$/.test(iban)) return null;
    const rearranged = iban.slice(4) + iban.slice(0, 4);
    const digits = rearranged.replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
    let remainder = 0;
    for (const ch of digits) remainder = (remainder * 10 + Number(ch)) % 97;
    return remainder === 1 ? iban : null;
}

function formatIban(iban) {
    return String(iban).replace(/(.{4})/g, '$1 ').trim();
}

// ---------------------------------------------------------------------------
//  Settings & quotes
// ---------------------------------------------------------------------------

async function refundSettings() {
    const s = await panelDb.getSettingsMap(['refund_enabled', 'refund_fee_percent', 'refund_min_amount', 'withdrawal_enabled', 'withdrawal_min_amount']);
    return {
        refundEnabled: String(s.refund_enabled ?? '1') === '1',
        feePercent: Number(s.refund_fee_percent) || 0,
        minAmount: Number(s.refund_min_amount) || 0,
        withdrawalEnabled: String(s.withdrawal_enabled ?? '1') === '1',
        withdrawalMin: Number(s.withdrawal_min_amount) || 0
    };
}

/** Refund quote for a server record. `legacy` = rented before periods were tracked. */
async function quoteForServer(record, { conn = null, lock = false, feePercent = null } = {}) {
    const settings = await refundSettings();
    const periods = await panelDb.listRentalPeriods(record.id, { conn, lock });
    const result = computeRefund(periods, new Date(), { feePercent: feePercent === null ? settings.feePercent : feePercent });
    return { ...result, legacy: periods.length === 0, minAmount: settings.minAmount, enabled: settings.refundEnabled };
}

// ---------------------------------------------------------------------------
//  Refund requests
// ---------------------------------------------------------------------------

function audit(actor, action, details, targetType = 'refund', targetId = null, ip = null) {
    return panelDb.logAudit({ actorId: actor ? actor.id : null, actorName: actor ? actor.username : 'system', action, targetType, targetId, details, ip });
}

async function requestRefund(user, record, reason, { ip = null } = {}) {
    const text = String(reason || '').trim();
    if (text.length < 10) throw httpError(400, 'Lütfen iade sebebinizi en az 10 karakterle açıklayın.');
    if (record.is_pool || Number(record.owner_id) !== Number(user.id)) throw httpError(403, 'Bu sunucu için iade talep edemezsiniz.');
    const q = await quoteForServer(record);
    if (!q.enabled) throw httpError(403, 'İade talepleri şu anda kapalı. Destek ile iletişime geçin.');
    if (q.legacy) throw httpError(409, 'Bu kiralama için ödeme dökümü bulunmuyor; iade için destek ile iletişime geçin.');
    if (q.total < q.minAmount || q.total <= 0) throw httpError(409, 'İade edilebilecek kalan süre yok veya tutar minimumun altında.');
    const db = panelDb.assertPool();
    const [pending] = await db.query("SELECT id FROM panel_refund_requests WHERE server_id = ? AND status = 'pending' LIMIT 1", [record.id]);
    if (pending.length) throw httpError(409, 'Bu sunucu için zaten bekleyen bir iade talebiniz var.');
    const [result] = await db.query(
        'INSERT INTO panel_refund_requests (user_id, server_id, port, reason, quoted_amount) VALUES (?, ?, ?, ?, ?)',
        [user.id, record.id, record.port, text.slice(0, 500), q.total]
    );
    await panelDb.notifyAdmins({ type: 'warning', title: `Yeni iade talebi · port ${record.port}`, body: `${user.username}: ${q.total.toFixed(2)} (${text.slice(0, 120)})`, link: '#/admin/refunds' });
    await audit(user, 'refund.request', { port: record.port, amount: q.total }, 'refund', result.insertId, ip);
    return { id: result.insertId, quote: q };
}

async function cancelRefund(user, requestId) {
    const [result] = await panelDb.assertPool().query(
        "UPDATE panel_refund_requests SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'", [parseInt(requestId, 10), user.id]);
    if (!result.affectedRows) throw httpError(404, 'Bekleyen iade talebi bulunamadı.');
    await audit(user, 'refund.cancel', null, 'refund', requestId);
}

/**
 * Approve a pending request (requestId) or refund a server directly (serverId).
 * amount defaults to the computed quote; it may be lowered, and for legacy
 * rentals (no period records) the admin must enter it.
 */
async function approveRefund(docker, admin, { requestId = null, serverId = null, amount = null, serverAction = 'shorten', note = null, ip = null }) {
    if (!SERVER_ACTIONS.includes(serverAction)) throw httpError(400, 'Geçersiz sunucu işlemi.');
    const outcome = await panelDb.withTransaction(async conn => {
        let request = null;
        let sid = serverId ? parseInt(serverId, 10) : null;
        if (requestId) {
            const [rows] = await conn.query('SELECT * FROM panel_refund_requests WHERE id = ? FOR UPDATE', [parseInt(requestId, 10)]);
            request = rows[0];
            if (!request) throw httpError(404, 'İade talebi bulunamadı.');
            if (request.status !== 'pending') throw httpError(409, 'Bu talep zaten işlenmiş.');
            sid = request.server_id;
        }
        if (!sid) throw httpError(409, 'Sunucu artık mevcut değil; tutarı kullanıcı bakiyesine "Bakiye düzeltme" ile ekleyin.');
        const [servers] = await conn.query('SELECT * FROM panel_servers WHERE id = ? FOR UPDATE', [sid]);
        const server = servers[0];
        if (!server || server.is_pool) throw httpError(404, 'Sunucu bulunamadı veya havuza dönmüş.');
        const userId = request ? request.user_id : server.owner_id;
        const q = await quoteForServer(server, { conn, lock: true });

        let value = amount === null || amount === undefined || amount === '' ? q.total : money(amount);
        if (!(value > 0)) throw httpError(400, 'İade tutarı sıfırdan büyük olmalı.');
        if (!q.legacy && value > q.total + 0.001) throw httpError(400, `İade tutarı hesaplanan üst sınırı (${q.total.toFixed(2)}) aşamaz.`);
        if (q.legacy && (amount === null || amount === undefined || amount === '')) throw httpError(400, 'Bu kiralamanın ödeme dökümü yok; iade tutarını elle girin.');

        const description = `Port ${server.port} kalan süre iadesi${request ? ` (talep #${request.id})` : ''}`;
        const { transactionId } = await panelDb.recordBalanceChange(conn, userId, value, {
            type: 'refund', description, referenceType: request ? 'refund_request' : 'server', referenceId: request ? request.id : server.port, actorId: admin.id
        });

        // Allocate to periods: the gross share (before fee) is what the period gave back.
        const grossValue = q.feePercent ? money(value / (1 - q.feePercent / 100)) : value;
        const { allocations, refundedMs } = allocateRefund(q.items, Math.min(grossValue, q.gross || grossValue));
        for (const a of allocations) {
            await conn.query(
                `UPDATE panel_rental_periods SET refunded_amount = LEAST(amount_paid, refunded_amount + ?),
                    status = IF(LEAST(amount_paid, refunded_amount + ?) >= amount_paid, 'refunded', 'partially_refunded')
                 WHERE id = ?`, [a.amount, a.amount, a.periodId]);
        }
        const lines = q.items.length
            ? q.items.map(i => ({ description: `${i.planName} · kalan ${i.remainingDays}/${i.totalDays} gün`, amount: i.amount }))
            : [{ description, amount: value }];
        if (q.fee && value === q.total) lines.push({ description: `İade kesintisi (%${q.feePercent})`, amount: -q.fee });
        if (money(lines.reduce((s, l) => s + l.amount, 0)) !== value) lines.push({ description: 'Yönetici düzeltmesi', amount: money(value - lines.reduce((s, l) => s + l.amount, 0)) });
        const receipt = await panelDb.createReceipt(conn, { userId, transactionId, type: 'refund', amount: value, lines });

        let expired = false;
        let newExpiry = null;
        if (serverAction === 'shorten') {
            // Legacy rentals have no period data: refunding ends the subscription now.
            const cut = q.legacy ? Infinity : refundedMs;
            newExpiry = new Date(Math.max(Date.now(), new Date(server.expires_at).getTime() - cut));
            expired = newExpiry.getTime() <= Date.now() + 60000;
            if (expired) {
                await conn.query(
                    `UPDATE panel_servers SET expires_at = NOW(), suspended = 1, suspended_reason = 'expired', expiry_notice_stage = 4,
                        deletion_notice_stage = 0, auto_renew = 0 WHERE id = ?`, [server.id]);
            } else {
                await conn.query('UPDATE panel_servers SET expires_at = ?, expiry_notice_stage = 0 WHERE id = ?', [newExpiry, server.id]);
            }
        }
        if (request) {
            await conn.query(
                `UPDATE panel_refund_requests SET status = 'approved', approved_amount = ?, server_action = ?, admin_note = ?,
                    reviewed_by = ?, reviewed_at = NOW(), transaction_id = ? WHERE id = ?`,
                [value, serverAction, note ? String(note).slice(0, 255) : null, admin.id, transactionId, request.id]);
        }
        return { userId, server, value, receipt, request, expired, newExpiry };
    });

    const { server, userId, value, receipt, request, expired, newExpiry } = outcome;
    if (expired) {
        try { await docker.getContainer(server.container_id).stop({ t: 5 }); } catch (_) { /* already stopped */ }
        try { await require('./phpSiteService').writeDomainMap(); } catch (_) { /* best effort */ }
    } else if (serverAction === 'release') {
        const lifecycle = require('./lifecycleService');
        const fresh = await panelDb.getServerById(server.id);
        if (fresh) await lifecycle.destroyServerResources(docker, fresh);
        try { await require('./poolService').ensurePool(docker); } catch (_) { /* best effort */ }
    }
    const actionText = serverAction === 'release' ? 'Sunucu kaldırıldı.'
        : serverAction === 'keep' ? 'Sunucunuz aynı süreyle kullanılmaya devam ediyor.'
            : expired ? 'Sunucunun süresi sona erdi; askı süresi boyunca süreyi yeniden uzatabilirsiniz.'
                : `Yeni bitiş tarihi: ${newExpiry.toLocaleDateString('tr-TR')}.`;
    await panelDb.notify(userId, {
        type: 'success', title: `${value.toFixed(2)} iade bakiyenize yüklendi`,
        body: `Port ${server.port} için iade onaylandı (makbuz ${receipt.number}). ${actionText}${note ? ` Not: ${note}` : ''}`,
        link: '#/billing'
    });
    await audit(admin, request ? 'refund.approve' : 'refund.direct', { port: server.port, amount: value, action: serverAction }, 'refund', request ? request.id : server.port, ip);
    return { amount: value, receipt, serverAction, expired, expires_at: newExpiry };
}

async function rejectRefund(admin, requestId, note, { ip = null } = {}) {
    const text = String(note || '').trim();
    if (!text) throw httpError(400, 'Red sebebi yazın; müşteriye iletilir.');
    const db = panelDb.assertPool();
    const [rows] = await db.query("SELECT * FROM panel_refund_requests WHERE id = ? AND status = 'pending'", [parseInt(requestId, 10)]);
    if (!rows[0]) throw httpError(404, 'Bekleyen iade talebi bulunamadı.');
    await db.query("UPDATE panel_refund_requests SET status = 'rejected', admin_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?", [text.slice(0, 255), admin.id, rows[0].id]);
    await panelDb.notify(rows[0].user_id, { type: 'danger', title: `Port ${rows[0].port} iade talebiniz reddedildi`, body: text, link: '#/billing' });
    await audit(admin, 'refund.reject', { note: text }, 'refund', rows[0].id, ip);
}

// ---------------------------------------------------------------------------
//  Withdrawals (balance → IBAN, paid out manually by the operator)
// ---------------------------------------------------------------------------

async function requestWithdrawal(user, { amount, iban, holder }, { ip = null } = {}) {
    const settings = await refundSettings();
    if (!settings.withdrawalEnabled) throw httpError(403, 'Bakiye çekme şu anda kapalı.');
    const value = money(amount);
    if (!(value > 0) || value < settings.withdrawalMin) throw httpError(400, `En az ${settings.withdrawalMin.toFixed(2)} çekebilirsiniz.`);
    const normalized = normalizeIban(iban);
    if (!normalized) throw httpError(400, 'Geçerli bir TR IBAN girin (TR ile başlayan 26 karakter).');
    const name = String(holder || '').trim().replace(/\s+/g, ' ');
    if (name.length < 5 || name.length > 100) throw httpError(400, 'Hesap sahibinin adını ve soyadını yazın.');

    const id = await panelDb.withTransaction(async conn => {
        const [pending] = await conn.query("SELECT COUNT(*) AS c FROM panel_withdrawals WHERE user_id = ? AND status = 'pending'", [user.id]);
        if (pending[0].c >= MAX_PENDING_WITHDRAWALS) throw httpError(429, 'Bekleyen çekim talebiniz çok fazla. Önce mevcut taleplerin sonuçlanmasını bekleyin.');
        const [result] = await conn.query(
            'INSERT INTO panel_withdrawals (user_id, amount, iban, account_holder) VALUES (?, ?, ?, ?)', [user.id, value, normalized, name]);
        // The amount is held immediately so it cannot be spent while the payout is pending.
        const { transactionId } = await panelDb.recordBalanceChange(conn, user.id, -value, {
            type: 'withdrawal', description: `Para çekme talebi #${result.insertId} (${formatIban(normalized).slice(-9)})`,
            referenceType: 'withdrawal', referenceId: result.insertId, actorId: user.id
        });
        await conn.query('UPDATE panel_withdrawals SET hold_transaction_id = ? WHERE id = ?', [transactionId, result.insertId]);
        return result.insertId;
    });
    await panelDb.notifyAdmins({ type: 'warning', title: 'Yeni para çekme talebi', body: `${user.username}: ${value.toFixed(2)}`, link: '#/admin/refunds?tab=withdrawals' });
    await audit(user, 'withdrawal.request', { amount: value }, 'withdrawal', id, ip);
    return { id };
}

async function markWithdrawalPaid(admin, id, { reference = null, note = null, ip = null } = {}) {
    const result = await panelDb.withTransaction(async conn => {
        const [rows] = await conn.query('SELECT * FROM panel_withdrawals WHERE id = ? FOR UPDATE', [parseInt(id, 10)]);
        const w = rows[0];
        if (!w) throw httpError(404, 'Çekim talebi bulunamadı.');
        if (w.status !== 'pending') throw httpError(409, 'Bu talep zaten işlenmiş.');
        await conn.query(
            "UPDATE panel_withdrawals SET status = 'paid', payout_reference = ?, admin_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
            [reference ? String(reference).slice(0, 100) : null, note ? String(note).slice(0, 255) : null, admin.id, w.id]);
        const receipt = w.hold_transaction_id ? await panelDb.createReceipt(conn, {
            userId: w.user_id, transactionId: w.hold_transaction_id, type: 'withdrawal', amount: money(w.amount),
            lines: [{ description: `Para çekme · ${formatIban(w.iban)} · ${w.account_holder}${reference ? ` · ref. ${reference}` : ''}`, amount: money(w.amount) }]
        }) : null;
        return { w, receipt };
    });
    await panelDb.notify(result.w.user_id, { type: 'success', title: `${money(result.w.amount).toFixed(2)} hesabınıza gönderildi`, body: `Para çekme talebiniz ödendi${reference ? ` (ref. ${reference})` : ''}.`, link: '#/billing' });
    await audit(admin, 'withdrawal.paid', { amount: money(result.w.amount), reference }, 'withdrawal', result.w.id, ip);
    return result;
}

async function rejectWithdrawal(admin, id, note, { ip = null } = {}) {
    const text = String(note || '').trim();
    if (!text) throw httpError(400, 'Red sebebi yazın; müşteriye iletilir.');
    const w = await panelDb.withTransaction(async conn => {
        const [rows] = await conn.query('SELECT * FROM panel_withdrawals WHERE id = ? FOR UPDATE', [parseInt(id, 10)]);
        const row = rows[0];
        if (!row) throw httpError(404, 'Çekim talebi bulunamadı.');
        if (row.status !== 'pending') throw httpError(409, 'Bu talep zaten işlenmiş.');
        await conn.query("UPDATE panel_withdrawals SET status = 'rejected', admin_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?", [text.slice(0, 255), admin.id, row.id]);
        await panelDb.recordBalanceChange(conn, row.user_id, money(row.amount), {
            type: 'withdrawal_reversal', description: `Para çekme talebi #${row.id} reddedildi, tutar iade edildi`,
            referenceType: 'withdrawal', referenceId: row.id, actorId: admin.id
        });
        return row;
    });
    await panelDb.notify(w.user_id, { type: 'danger', title: 'Para çekme talebiniz reddedildi', body: `${money(w.amount).toFixed(2)} bakiyenize geri yüklendi. Sebep: ${text}`, link: '#/billing' });
    await audit(admin, 'withdrawal.reject', { note: text }, 'withdrawal', w.id, ip);
}

module.exports = {
    SERVER_ACTIONS,
    computeRefund,
    allocateRefund,
    normalizeIban,
    formatIban,
    refundSettings,
    quoteForServer,
    requestRefund,
    cancelRefund,
    approveRefund,
    rejectRefund,
    requestWithdrawal,
    markWithdrawalPaid,
    rejectWithdrawal
};

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeRefund, allocateRefund, normalizeIban, formatIban } = require('../refundService');
const { formatReceiptNumber } = require('../panelDb');
const { parseIntent } = require('../routes/payments')._test;

const DAY = 86400000;
const NOW = new Date('2026-06-01T00:00:00Z');
const at = days => new Date(NOW.getTime() + days * DAY).toISOString();
const period = (id, startDay, endDay, paid, extra = {}) => ({
    id, kind: 'purchase', plan_name: 'Pro', starts_at: at(startDay), ends_at: at(endDay),
    amount_paid: paid, refunded_amount: 0, status: 'active', ...extra
});

test('computeRefund prorates the unused part of a running period', () => {
    const full = computeRefund([period(1, 0, 30, 300)], NOW);
    assert.equal(full.total, 300);
    const half = computeRefund([period(1, -15, 15, 300)], NOW);
    assert.equal(half.total, 150);
    assert.equal(half.items[0].remainingDays, 15);
    assert.equal(half.items[0].ratio, 0.5);
});

test('computeRefund refunds an unstarted renewal in full and orders newest first', () => {
    const q = computeRefund([period(1, -20, 10, 300), period(2, 10, 40, 250, { kind: 'renewal' })], NOW);
    assert.deepEqual(q.items.map(i => i.periodId), [2, 1]);
    assert.equal(q.items[0].amount, 250);
    assert.equal(q.items[1].amount, 100);
    assert.equal(q.total, 350);
});

test('computeRefund skips ended, trial, void, refunded periods and respects partial refunds', () => {
    const q = computeRefund([
        period(1, -60, -30, 300),
        period(2, -5, 25, 0, { kind: 'trial' }),
        period(3, 0, 30, 300, { status: 'void' }),
        period(4, 0, 30, 300, { status: 'refunded', refunded_amount: 300 }),
        period(5, -15, 15, 300, { status: 'partially_refunded', refunded_amount: 100 })
    ], NOW);
    assert.deepEqual(q.items.map(i => i.periodId), [5]);
    assert.equal(q.total, 100);
});

test('computeRefund applies the fee percentage and clamps it', () => {
    const q = computeRefund([period(1, 0, 30, 200)], NOW, { feePercent: 10 });
    assert.equal(q.gross, 200);
    assert.equal(q.fee, 20);
    assert.equal(q.total, 180);
    assert.equal(computeRefund([period(1, 0, 30, 200)], NOW, { feePercent: 150 }).total, 0);
    assert.equal(computeRefund([], NOW).total, 0);
});

test('allocateRefund fills newest periods first and returns the time given back', () => {
    const q = computeRefund([period(1, -15, 15, 300), period(2, 15, 45, 300)], NOW);
    const all = allocateRefund(q.items, q.total);
    assert.equal(all.unallocated, 0);
    assert.equal(all.refundedMs, 45 * DAY);

    const partial = allocateRefund(q.items, 375);
    assert.deepEqual(partial.allocations, [{ periodId: 2, amount: 300 }, { periodId: 1, amount: 75 }]);
    assert.equal(partial.refundedMs, 30 * DAY + 7.5 * DAY);

    const over = allocateRefund(q.items, 500);
    assert.equal(over.unallocated, 50);
});

test('normalizeIban accepts valid Turkish IBANs only', () => {
    assert.equal(normalizeIban('tr33 0006 1005 1978 6457 8413 26'), 'TR330006100519786457841326');
    assert.equal(normalizeIban('TR330006100519786457841327'), null);
    assert.equal(normalizeIban('DE89370400440532013000'), null);
    assert.equal(normalizeIban(''), null);
    assert.equal(formatIban('TR330006100519786457841326'), 'TR33 0006 1005 1978 6457 8413 26');
});

test('formatReceiptNumber pads the sequence and sanitises the prefix', () => {
    assert.equal(formatReceiptNumber('MKB', 2026, 1), 'MKB-2026-000001');
    assert.equal(formatReceiptNumber('fa-tura!', 2026, 1234567), 'FATURA-2026-1234567');
    assert.equal(formatReceiptNumber('', 2026, 12), 'MKB-2026-000012');
});

test('parseIntent validates renew intents', () => {
    assert.equal(parseIntent(undefined), null);
    assert.equal(parseIntent(''), null);
    const intent = parseIntent(JSON.stringify({ type: 'renew', serverId: 'abcdef123456', months: 3, coupon: 'yaz-25!' }));
    assert.equal(intent.type, 'renew');
    assert.equal(intent.months, 3);
    assert.equal(intent.serverId, 'abcdef123456');
    assert.equal(intent.coupon, 'YAZ-25');
    assert.throws(() => parseIntent('{bad'), { statusCode: 400 });
    assert.throws(() => parseIntent({ type: 'buy' }), { statusCode: 400 });
    assert.throws(() => parseIntent({ type: 'renew', serverId: 'abcdef123456', months: 2 }), { statusCode: 400 });
    assert.throws(() => parseIntent({ type: 'renew', serverId: '../etc', months: 1 }), { statusCode: 400 });
});

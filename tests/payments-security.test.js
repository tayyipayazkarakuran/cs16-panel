const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hasAllowedSignature } = require('../routes/payments')._test;

test('receipt validation checks file signatures instead of trusting MIME metadata', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-panel-receipt-'));
    try {
        const png = path.join(dir, 'receipt.png');
        const pdf = path.join(dir, 'receipt.pdf');
        const fake = path.join(dir, 'fake.png');
        fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
        fs.writeFileSync(pdf, Buffer.from('%PDF-1.7'));
        fs.writeFileSync(fake, Buffer.from('<script>'));

        assert.equal(hasAllowedSignature(png, '.png'), true);
        assert.equal(hasAllowedSignature(pdf, '.pdf'), true);
        assert.equal(hasAllowedSignature(fake, '.png'), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

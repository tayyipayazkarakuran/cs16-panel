const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The SPA is split into ES modules under public/js; check them as one source.
function readTree(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).map(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return readTree(full);
        return entry.name.endsWith('.js') ? fs.readFileSync(full, 'utf8') : '';
    }).join('\n');
}
const appSource = readTree(path.resolve(__dirname, '..', 'public', 'js'));

test('frontend translates browser aborts into actionable application errors', () => {
    assert.doesNotMatch(appSource, /AbortError/);
    assert.match(appSource, /requestTimedOut/);
    assert.match(appSource, /ApiTimeoutError/);
    assert.match(appSource, /RequestCancelledError/);
    assert.match(appSource, /UploadCancelledError/);
});

test('frontend keeps session tokens out of persistent browser storage', () => {
    assert.doesNotMatch(appSource, /localStorage\.getItem\(['"]cs_panel_token['"]\)/);
    assert.doesNotMatch(appSource, /localStorage\.setItem\(['"]cs_panel_token['"]/);
    assert.match(appSource, /localStorage\.removeItem\(['"]cs_panel_token['"]\)/);
});

test('fleet polling pauses while the page is hidden', () => {
    assert.match(appSource, /document\.addEventListener\(['"]visibilitychange['"]/);
    assert.match(appSource, /if \(document\.hidden\) stopServerPolling\(\)/);
    assert.match(appSource, /serversLoadPromise/);
});

test('frontend never renders API data through innerHTML or inline handlers', () => {
    assert.doesNotMatch(appSource, /\.innerHTML\s*=/);
    assert.doesNotMatch(appSource, /insertAdjacentHTML/);
    assert.doesNotMatch(appSource, /onclick=/i);
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /<script>(?!<\/script>)/, 'index.html must not contain inline scripts (CSP)');
});

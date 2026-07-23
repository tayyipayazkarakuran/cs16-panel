const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');

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

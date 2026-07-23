const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const cFs = require('../containerFsHelper');
const fastdl = require('../fastdlService');

test('safeRelativePath accepts nested game paths', () => {
    assert.equal(cFs.safeRelativePath('sound/custom/test.wav'), 'sound/custom/test.wav');
    assert.equal(cFs.safeRelativePath('gfx\\env\\sky.tga'), 'gfx/env/sky.tga');
    assert.equal(cFs.cstrikePath('maps/de_test.bsp'), '/hlds/cstrike/maps/de_test.bsp');
});

test('safeRelativePath rejects paths outside cstrike', () => {
    for (const value of ['../server.cfg', 'maps/../../server.cfg', '/etc/passwd', 'maps\\..\\..\\secret']) {
        assert.throws(() => cFs.safeRelativePath(value), /Access denied/);
    }
});

test('writeFile waits for the Docker exec process after stdin finishes', async () => {
    const expected = Buffer.alloc(1024 * 1024, 0x5a);
    let received = null;
    let completedAt = 0;
    let state = { Running: true, ExitCode: null };

    const container = {
        async exec() {
            return {
                async start() {
                    const stream = new PassThrough();
                    const chunks = [];
                    stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
                    stream.on('finish', () => {
                        setTimeout(() => {
                            received = Buffer.concat(chunks);
                            completedAt = Date.now();
                            state = { Running: false, ExitCode: 0 };
                        }, 75);
                    });
                    return stream;
                },
                async inspect() {
                    return state;
                }
            };
        }
    };

    await cFs.writeFile(container, 'maps/overwrite-test.bsp', expected);
    assert.ok(completedAt > 0, 'writeFile returned before the container process completed');
    assert.deepEqual(received, expected);
});

test('default FastDL categories include sound and gfx assets', () => {
    const categories = fastdl.normalizeCategories().map(item => item.source);
    assert.ok(categories.includes('sound'));
    assert.ok(categories.includes('gfx'));
    assert.deepEqual(
        fastdl.normalizeFastdlAssetPaths(['sound/custom/test.wav', 'gfx/env/sky.tga', 'addons/plugin.amxx']),
        ['sound/custom/test.wav', 'gfx/env/sky.tga']
    );
});

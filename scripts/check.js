// Syntax-checks every backend file and every browser ES module.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const files = [];
function walk(dir, filter) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, filter);
        else if (filter(entry.name)) files.push(full);
    }
}
for (const name of fs.readdirSync(root)) if (name.endsWith('.js')) files.push(path.join(root, name));
walk(path.join(root, 'routes'), n => n.endsWith('.js'));
walk(path.join(root, 'tests'), n => n.endsWith('.js'));
walk(path.join(root, 'public'), n => n.endsWith('.js'));

let failed = 0;
for (const file of files) {
    const rel = path.relative(root, file);
    const args = rel.startsWith('public') ? ['--input-type=module', '--check'] : ['--check', file];
    try {
        execFileSync(process.execPath, args, { input: rel.startsWith('public') ? fs.readFileSync(file) : undefined, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
        failed += 1;
        console.error(`✗ ${rel}\n${error.stderr}`);
    }
}
console.log(`${files.length - failed}/${files.length} dosya sözdizimi kontrolünden geçti.`);
process.exit(failed ? 1 : 0);

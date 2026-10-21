// npm run check: syntax of every .js/.mjs we own, the unit tests, and the
// compiled-gateway smoke. The local CI for this repo.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [];
const walk = rel => {
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'src-tauri', '.git'].includes(e.name)) walk(r); }
    else if (/\.(m?js)$/.test(e.name)) files.push(r);
  }
};
walk('.');
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { bad++; process.stderr.write(r.stderr); }
}
console.log(`syntax: ${files.length} files, ${bad} bad`);
if (bad) process.exit(1);

const step = (label, cmd, args) => {
  console.log(`\n== ${label}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`check: ${label} failed`); process.exit(1); }
};
process.env.DECK_CLI = 'off'; // no test may reach the real claude CLI
step('tests', process.execPath, ['--test', '--test-reporter=dot', 'test/**/*.test.mjs']);
step('gateway', process.execPath, ['scripts/check-gateway.mjs']);
console.log('\ncheck: all green');

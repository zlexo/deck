// Links bin/deck.mjs as ~/.local/bin/deck (first on PATH on this Mac), so merge
// scripts and terminals can call `deck review --check ...`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(ROOT, 'bin', 'deck.mjs');
const link = path.join(os.homedir(), '.local', 'bin', 'deck');
fs.mkdirSync(path.dirname(link), { recursive: true });
fs.chmodSync(target, 0o755);
try {
  const cur = fs.readlinkSync(link);
  if (cur === target) { console.log(`${link} -> ${target} (already)`); process.exit(0); }
  fs.unlinkSync(link);
} catch (e) {
  if (e.code === 'EINVAL') { console.error(`${link} exists and is not a link; leaving it alone`); process.exit(1); }
}
fs.symlinkSync(target, link);
console.log(`${link} -> ${target}`);

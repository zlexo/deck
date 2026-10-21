// Writes into the vault's daily note, the same way server.js's session recap
// does: one appended line, with a newline guaranteed before and after.
import fs from 'node:fs';
import path from 'node:path';
import { vaultDir } from './paths.mjs';

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function appendToFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + text + '\n');
}

export function appendDaily(line, { date } = {}) {
  appendToFile(path.join(vaultDir(), 'Daily', `${date || todayStr()}.md`), line);
}

export function vaultFile(rel) { return path.join(vaultDir(), rel); }

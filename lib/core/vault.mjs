// The vault: where it is, and the daily-note writes server.js's session recap
// also does (one appended line, with a newline guaranteed before and after).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStateFile } from './config.mjs';

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Where the vault is, resolved on every call so a vault created or adopted at
// runtime is used at once: DECK_VAULT, else state.json `vault.path`, else
// ~/vault when it exists, else none. DECK_VAULT is used as given (the tests
// and dev setups point it at a folder made on first write). A `vault.path`
// whose folder is gone resolves to none rather than to ~/vault, so a vault on
// an unplugged disk is never swapped for another one, nor recreated empty.
// `state` is the gateway's live object; without it state.json is read.
export function resolveVault({ env = process.env, state, home = os.homedir() } = {}) {
  const expand = p => path.resolve(p.replace(/^~(?=\/|$)/, home));
  if (env.DECK_VAULT) return { path: expand(env.DECK_VAULT), source: 'env' };
  const s = state || readStateFile();
  const set = s && s.vault && typeof s.vault.path === 'string' && s.vault.path ? s.vault.path : null;
  if (set) {
    const p = expand(set);
    return isDir(p) ? { path: p, source: 'state' } : { path: null, source: 'state', missing: p };
  }
  const def = path.join(home, 'vault');
  return isDir(def) ? { path: def, source: 'default' } : { path: null, source: null };
}

// The vault folder, or null when there is none.
export function vaultDir(state) { return resolveVault({ state }).path; }

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function appendToFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + text + '\n');
}

// Without a vault there is no daily note: the line is dropped, and false says so.
export function appendDaily(line, { date } = {}) {
  const v = vaultDir();
  if (!v) return false;
  appendToFile(path.join(v, 'Daily', `${date || todayStr()}.md`), line);
  return true;
}

// A path inside the vault, or null when there is none (readers treat that as
// a missing file).
export function vaultFile(rel) {
  const v = vaultDir();
  return v ? path.join(v, rel) : null;
}

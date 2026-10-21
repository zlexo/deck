// Deck Vault and Claude Code. Connect puts the vault's manual into every
// session, in any project (a rules file Deck owns that imports
// <vault>/CLAUDE.md), and lets sessions edit the vault like their own folder
// (permissions.additionalDirectories); with auto memory on, Claude Code's own
// notes go to <vault>/Memory (autoMemoryDirectory). Disconnect takes out
// exactly that. settings.json is parsed before anything is written, backed up
// beside itself, and written atomically. Nothing here is kept in state.json:
// what Connect added is read back from the files themselves.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { expandHome, isInside, tildify } from '../core/paths.mjs';
import { readStateFile } from '../core/config.mjs';
import { resolveVault } from '../core/vault.mjs';
import { writeTextAtomic } from '../core/files.mjs';
import { which } from '../core/env.mjs';
import { HttpError } from '../core/http.mjs';

// The first line of the rules file; a file without it is not Deck's.
export const MARK = '<!-- deck-vault: written by Deck; Disconnect in Deck removes this file -->';

// $CLAUDE_CONFIG_DIR, else state.json `claude.configDir` (Deck.app never sees
// shell variables), else ~/.claude.
export function claudeConfigDir({ env = process.env, state, home = os.homedir() } = {}) {
  const exp = p => path.resolve(p.replace(/^~(?=\/|$)/, home));
  if (env.CLAUDE_CONFIG_DIR) return { path: exp(env.CLAUDE_CONFIG_DIR), source: 'env' };
  const s = state || readStateFile();
  const set = s && s.claude && typeof s.claude.configDir === 'string' && s.claude.configDir;
  if (set) return { path: exp(set), source: 'state' };
  return { path: path.join(home, '.claude'), source: 'default' };
}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => typeof a === 'string' && path.resolve(expandHome(a)) === path.resolve(b);
const memDir = vault => path.join(vault, 'Memory');
const filesIn = dir => ({ settings: path.join(dir, 'settings.json'), rules: path.join(dir, 'rules', 'deck-vault.md') });
const realTarget = p => { try { return fs.realpathSync(p); } catch { return p; } }; // a symlinked settings.json stays a link
function readText(f) {
  try { return fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Claude Code's memory import: `@path`, a space written as "\ " (its parser
// ends a path at other whitespace and cuts it at "#").
export function rulesText(vault) {
  return `${MARK}\n\nYour memory vault is ${vault}. If ${vault}/CLAUDE.md is not in your context, read it before your first tool call.\n@${vault.replaceAll(' ', '\\ ')}/CLAUDE.md\n`;
}
const vaultOfRules = text => (/^Your memory vault is (.+)\. If /m.exec(text || '') || [])[1] || null;

function readSettings(file) {
  const text = readText(file);
  if (text === null) return { text, obj: {} };
  try {
    const obj = JSON.parse(text);
    if (!isObj(obj)) throw new Error('not a JSON object');
    if ('permissions' in obj && !isObj(obj.permissions)) throw new Error('"permissions" is not an object');
    if (obj.permissions && 'additionalDirectories' in obj.permissions && !Array.isArray(obj.permissions.additionalDirectories)) throw new Error('"permissions.additionalDirectories" is not a list');
    return { text, obj };
  } catch (e) { return { text, obj: null, error: e.message }; }
}

// The settings with the vault's directory entry and an auto memory folder
// inside the vault taken out. A list that only held the vault goes too
// (drop 1), and then a permissions object left empty (drop 2).
function strip(obj, vault, drop = 2) {
  const o = structuredClone(obj);
  const p = o.permissions;
  if (p && Array.isArray(p.additionalDirectories)) {
    const kept = p.additionalDirectories.filter(d => !same(d, vault));
    if (kept.length !== p.additionalDirectories.length) {
      p.additionalDirectories = kept;
      if (drop >= 1 && !kept.length) delete p.additionalDirectories;
      if (drop >= 2 && !Object.keys(p).length) delete o.permissions;
    }
  }
  if (typeof o.autoMemoryDirectory === 'string' && isInside(expandHome(o.autoMemoryDirectory), vault)) delete o.autoMemoryDirectory;
  return o;
}

function add(obj, vault, autoMemory) {
  const o = structuredClone(obj);
  o.permissions ||= {};
  const dirs = (o.permissions.additionalDirectories ||= []);
  if (!dirs.some(d => same(d, vault))) dirs.push(vault);
  if (autoMemory && !same(o.autoMemoryDirectory, memDir(vault))) o.autoMemoryDirectory = memDir(vault);
  if (!autoMemory && typeof o.autoMemoryDirectory === 'string' && isInside(expandHome(o.autoMemoryDirectory), vault)) delete o.autoMemoryDirectory;
  return o;
}

// In the file's own indent, with a final newline when it had one.
function serialize(obj, orig) {
  const indent = (/^([ \t]+)"/m.exec(orig || '') || [])[1] || 2;
  return JSON.stringify(obj, null, indent) + (orig == null || orig.endsWith('\n') ? '\n' : '');
}

const stamp = d => d.toISOString().replace(/[-:.]/g, '');
// A new backup file; a second Connect within the same millisecond gets "-1".
function writeBackup(base, text) {
  fs.mkdirSync(path.dirname(base), { recursive: true });
  for (let i = 0; ; i++) {
    const f = i ? `${base}-${i}` : base;
    try { fs.writeFileSync(f, text, { flag: 'wx' }); return f; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}
function backups(file) {
  const dir = path.dirname(file), pre = path.basename(file) + '.deck-';
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.startsWith(pre)); } catch {}
  return names.sort().reverse().map(n => readText(path.join(dir, n)));
}

const pasteLines = (vault, autoMemory) => [
  `  "permissions": { "additionalDirectories": [${JSON.stringify(vault)}] },`,
  ...(autoMemory ? [`  "autoMemoryDirectory": ${JSON.stringify(memDir(vault))}`] : []),
].join('\n');

// Files under the config folder's projects/*/memory/: per-repository auto
// memory, which stops loading once autoMemoryDirectory points elsewhere.
function countMemory(dir) {
  let n = 0;
  const walk = d => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.isFile() && e.name.endsWith('.md')) n++;
    }
  };
  let projects = [];
  try { projects = fs.readdirSync(path.join(dir, 'projects')); } catch {}
  for (const p of projects) walk(path.join(dir, 'projects', p, 'memory'));
  return n;
}

export function claudeStatus({ state } = {}) {
  const cd = claudeConfigDir({ state });
  const f = filesIn(cd.path);
  const vault = resolveVault({ state }).path;
  const rules = readText(f.rules);
  const ours = rules !== null && rules.startsWith(MARK);
  const s = readSettings(f.settings);
  const dirs = (s.obj && s.obj.permissions && s.obj.permissions.additionalDirectories) || [];
  const additionalDirectory = !!vault && dirs.some(d => same(d, vault));
  const amd = s.obj && typeof s.obj.autoMemoryDirectory === 'string' ? s.obj.autoMemoryDirectory : null;
  return {
    installed: !!which('claude'), configDir: tildify(cd.path), configSource: cd.source,
    connected: !!vault && ours && vaultOfRules(rules) === vault && additionalDirectory,
    rulesFile: rules === null ? null : { path: tildify(f.rules), ours },
    additionalDirectory,
    autoMemory: { on: !!vault && same(amd, memDir(vault)), dir: amd, stopLoading: countMemory(cd.path) },
    settingsError: s.error || null,
  };
}

export function connect({ state, autoMemory = true, dryRun = false, now = new Date() } = {}) {
  const vault = resolveVault({ state }).path;
  if (!vault) throw new HttpError(409, 'no vault: create one or adopt a folder first');
  if (/[#\\\s]/.test(vault.replaceAll(' ', ''))) throw new HttpError(409, `Claude Code cannot import from ${vault}: a vault path for Connect has no "#", backslash, tab or newline`);
  const f = filesIn(claudeConfigDir({ state }).path);
  const rules = readText(f.rules);
  if (rules !== null && !rules.startsWith(MARK)) throw new HttpError(409, `${tildify(f.rules)} exists and Deck did not write it; rename it, then Connect again`);
  const s = readSettings(f.settings);
  if (!s.obj) throw new HttpError(409, `${tildify(f.settings)} does not parse (${s.error}); Deck changed nothing. Fix it, or add these lines to it by hand:\n${pasteLines(vault, autoMemory)}`);
  const amd = s.obj.autoMemoryDirectory;
  if (autoMemory && typeof amd === 'string' && !isInside(expandHome(amd), vault))
    throw new HttpError(409, `${tildify(f.settings)} already sends auto memory to ${amd}; Connect without auto memory, or remove autoMemoryDirectory first`);
  // A vault that moved: the old one's entries go, the new one's come in.
  const prev = vaultOfRules(rules);
  const after = add(prev && prev !== vault ? strip(s.obj, prev) : s.obj, vault, autoMemory);

  const changes = [];
  if (!isDeepStrictEqual(after, s.obj)) changes.push({ path: f.settings, before: s.text, after: serialize(after, s.text) });
  const want = rulesText(vault);
  if (rules !== want) changes.push({ path: f.rules, before: rules, after: want });
  // An empty backup records that there was no settings.json.
  let backup = changes.some(c => c.path === f.settings) ? `${f.settings}.deck-${stamp(now)}` : null;
  if (!dryRun) {
    if (backup) backup = writeBackup(backup, s.text ?? '');
    for (const c of changes) writeTextAtomic(realTarget(c.path), c.after);
  }
  return { changes: changes.map(c => ({ ...c, path: tildify(c.path) })), backup: backup && tildify(backup), dryRun, status: claudeStatus({ state }) };
}

// The settings text after Disconnect: a backup's own bytes when the result is
// what that backup holds (nothing else changed since), else the result
// written out; null when there was no settings.json before.
function restoredText(file, s, vault) {
  const [dropped, ...kept] = [2, 1, 0].map(d => strip(s.obj, vault, d));
  if (isDeepStrictEqual(dropped, s.obj)) return s.text;
  for (const b of backups(file)) {
    if (b === '') { if (isDeepStrictEqual(dropped, {})) return null; continue; }
    let bo = null;
    try { bo = JSON.parse(b); } catch {}
    if (isObj(bo) && [dropped, ...kept].some(c => isDeepStrictEqual(c, bo))) return b;
  }
  return serialize(dropped, s.text);
}

export function disconnect({ state } = {}) {
  const f = filesIn(claudeConfigDir({ state }).path);
  const rules = readText(f.rules);
  const ours = rules !== null && rules.startsWith(MARK);
  const vault = (ours && vaultOfRules(rules)) || resolveVault({ state }).path;
  const s = readSettings(f.settings);
  if (!s.obj) throw new HttpError(409, `${tildify(f.settings)} does not parse (${s.error}); Deck changed nothing. Remove the vault from permissions.additionalDirectories and autoMemoryDirectory by hand`);
  const restored = [];
  if (vault) {
    const text = restoredText(f.settings, s, vault);
    if (text !== s.text) {
      if (text === null) fs.rmSync(realTarget(f.settings));
      else writeTextAtomic(realTarget(f.settings), text);
      restored.push(tildify(f.settings));
    }
  }
  if (ours) {
    fs.rmSync(f.rules);
    try { fs.rmdirSync(path.dirname(f.rules)); } catch {} // only when that left it empty
    restored.push(tildify(f.rules));
  }
  return { restored, status: claudeStatus({ state }) };
}

export function register(router, ctx) {
  router.add('GET', '/api/vault/claude', () => claudeStatus({ state: ctx.getState() }));
  router.add('POST', '/api/vault/connect', async (req, res, { body }) => {
    const b = await body();
    return connect({ state: ctx.getState(), autoMemory: b.autoMemory !== false, dryRun: b.dryRun === true });
  });
  router.add('POST', '/api/vault/disconnect', () => disconnect({ state: ctx.getState() }));
}

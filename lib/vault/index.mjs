// Deck Vault: which folder is the vault, and getting one. Create copies the
// scaffold in templates/vault once; Adopt points Deck at a folder the user
// already has and writes nothing into it. Deck never deletes a vault.
// Where the vault is resolved: lib/core/vault.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPath, deckRoot, expandHome, tildify } from '../core/paths.mjs';
import { deepMerge } from '../core/config.mjs';
import { resolveVault } from '../core/vault.mjs';
import { HttpError } from '../core/http.mjs';
import * as claude from './claude.mjs';
import * as git from './git.mjs';
import { register as registerPage } from './page.mjs';

export const templateDir = () => path.join(deckRoot(), 'templates', 'vault');
// In Deck's data folder: not synced to iCloud, backed up by Time Machine.
export const defaultVaultDir = () => dataPath('vault');

export function vaultStatus(state) {
  const r = resolveVault({ state });
  const v = (state && state.vault) || {};
  return {
    path: r.path, display: r.path && tildify(r.path), source: r.source,
    missing: r.missing || null, created: r.source === 'state' && !!v.created,
    defaultPath: tildify(defaultVaultDir()),
  };
}

// DECK_VAULT wins over state.json, so recording a vault would change nothing.
function refuseUnderEnv() {
  if (process.env.DECK_VAULT) throw new HttpError(409, `DECK_VAULT is set (${process.env.DECK_VAULT}) and wins over a vault Deck records; unset it first`);
}

function folderArg(p) {
  if (p == null || p === '') return null;
  if (typeof p !== 'string') throw new HttpError(400, 'path must be a string');
  const abs = expandHome(p.trim());
  if (!path.isAbsolute(abs)) throw new HttpError(400, 'path must be absolute or start with ~');
  const dir = path.resolve(abs);
  if (dir === '/' || dir === path.resolve(os.homedir())) throw new HttpError(400, 'the vault cannot be the disk root or the home folder');
  return dir;
}

const record = (ctx, vault) => ctx.saveState(deepMerge(ctx.getState(), { vault }));

// Copies the scaffold into `path` (Deck's data folder by default), which must
// be missing or empty, and records it. Refused while a vault resolves.
export function createVault(ctx, { path: p } = {}) {
  refuseUnderEnv();
  const cur = resolveVault({ state: ctx.getState() });
  if (cur.path) throw new HttpError(409, `a vault is already in use at ${tildify(cur.path)}; Create never replaces one`);
  const dest = folderArg(p) || defaultVaultDir();
  if (fs.existsSync(dest)) {
    if (!fs.statSync(dest).isDirectory()) throw new HttpError(409, `${tildify(dest)} is a file`);
    if (fs.readdirSync(dest).length) throw new HttpError(409, `${tildify(dest)} is not empty; Create writes only into a new or empty folder (Adopt uses a folder as it is)`);
  }
  const src = templateDir();
  if (!fs.existsSync(path.join(src, 'CLAUDE.md'))) throw new HttpError(500, `the vault template is missing at ${src}`);
  // Copied beside the target, then renamed into place: a failed copy leaves no
  // half vault, and the rename fails if the folder gained files meanwhile.
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(parent, '.deck-vault-'));
  try {
    fs.cpSync(src, stage, { recursive: true, force: false, errorOnExist: true });
    fs.renameSync(stage, dest);
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') throw new HttpError(409, `${tildify(dest)} is not empty`);
    throw e;
  }
  record(ctx, { path: tildify(dest), created: true });
  return vaultStatus(ctx.getState());
}

// Uses an existing folder as the vault, as it is.
export function adoptVault(ctx, { path: p } = {}) {
  refuseUnderEnv();
  const dir = folderArg(p);
  if (!dir) throw new HttpError(400, 'adopt needs a folder: { "path": "..." }');
  let st;
  try { st = fs.statSync(dir); } catch { throw new HttpError(404, `${tildify(dir)} does not exist`); }
  if (!st.isDirectory()) throw new HttpError(400, `${tildify(dir)} is not a folder`);
  const prev = ctx.getState().vault || {};
  const same = typeof prev.path === 'string' && path.resolve(expandHome(prev.path)) === dir;
  record(ctx, { path: tildify(dir), created: same && !!prev.created });
  return vaultStatus(ctx.getState());
}

export function register(router, ctx) {
  router.add('GET', '/api/vault', () => vaultStatus(ctx.getState()));
  // Create ends with the vault's first commit; a git failure leaves the vault and shows in /api/vault/git.
  router.add('POST', '/api/vault/create', async (req, res, { body }) => {
    const s = createVault(ctx, await body());
    try { await git.initCreated(); } catch (e) { console.error(`vault: first commit failed: ${e.message}`); }
    return s;
  });
  router.add('POST', '/api/vault/adopt', async (req, res, { body }) => adoptVault(ctx, await body()));
  claude.register(router, ctx);
  registerPage(router, ctx);
  git.register(router, ctx);
}

export function start() { git.start(); }
export async function stop() { await git.stop(); }

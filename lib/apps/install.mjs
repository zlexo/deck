// Deck Apps on disk: install, update and remove. Every path is checked to be
// inside Deck's apps folder before anything is written or deleted there, so a
// dev checkout (yours, in a scan root) is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../core/proc.mjs';
import { isInside, tildify } from '../core/paths.mjs';
import { appsDir, appDir, appDataDir, packsRoot, packDir } from './dirs.mjs';

export class AppsError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const tail = s => String(s || '').trim().split('\n').slice(-6).join('\n');
const STEP_TIMEOUT = 15 * 60e3;

// gh clones (private repos need its login); tests pass a cloner of their own.
const ghClone = (repo, dest) => run('gh', ['repo', 'clone', repo, dest, '--', '--quiet'], { timeoutMs: 10 * 60e3 });
const git = (cwd, args) => run('git', args, { cwd, timeoutMs: 120e3 });

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Where an app or a pack lives, checked to be inside its root before use.
export function appWhere(id) {
  const dir = appDir(id);
  if (!ID.test(id) || !isInside(dir, appsDir()) || dir === appsDir()) throw new AppsError(400, `not an app id: ${id}`);
  return { id, dir, root: appsDir() };
}
export function packWhere(appId, packId) {
  if (!ID.test(appId) || !ID.test(packId)) throw new AppsError(400, `not a pack id: ${appId}/${packId}`);
  const dir = packDir(appId, packId);
  if (!isInside(dir, packsRoot())) throw new AppsError(400, `not a pack id: ${appId}/${packId}`);
  return { id: packId, dir, root: path.dirname(dir) };
}

// What an install runs, in order: shown on the page before the confirm.
export function plan(entry, where = appWhere(entry.manifest.id)) {
  return [['gh', 'repo', 'clone', entry.repo, tildify(where.dir)], ...(entry.manifest.install || [])];
}

async function checkout(dir, latest, branch) {
  const target = latest.tag ? `tags/${latest.tag}` : (latest.sha || `origin/${branch}`);
  const r = await git(dir, ['checkout', '--quiet', '--detach', target]);
  if (r.code !== 0) throw new AppsError(502, `git checkout ${target}: ${tail(r.stderr)}`);
  const head = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  return { tag: latest.tag || null, sha: head };
}

async function runSteps(dir, steps, log) {
  for (const cmd of steps) {
    log(`$ ${cmd.join(' ')}`);
    const r = await run(cmd[0], cmd.slice(1), { cwd: dir, timeoutMs: STEP_TIMEOUT });
    if (r.timedOut || r.error || r.code !== 0) {
      const why = r.timedOut ? 'timed out' : r.error ? r.error.message : `exit ${r.code}`;
      throw new AppsError(502, `install step failed (${cmd.join(' ')}): ${why}\n${tail(r.stderr || r.stdout)}`);
    }
  }
}

// Clone into a staging folder, check out the version, move it into place,
// then run the install steps there (a venv or native module keeps the path it
// was built at). A failure removes the half-made copy.
export async function install(entry, { clone = ghClone, log = () => {}, where = appWhere(entry.manifest.id) } = {}) {
  const { id, dir: dest, root } = where;
  if (fs.existsSync(dest)) throw new AppsError(409, `${id} is already installed at ${tildify(dest)}`);
  fs.mkdirSync(root, { recursive: true });
  const stage = path.join(root, `.${id}.${process.pid}.tmp`);
  fs.rmSync(stage, { recursive: true, force: true });
  try {
    log(`$ gh repo clone ${entry.repo}`);
    const c = await clone(entry.repo, stage);
    if (c.error || c.code !== 0) throw new AppsError(502, `clone of ${entry.repo} failed: ${tail(c.stderr) || (c.error && c.error.message)}`);
    const version = await checkout(stage, entry.latest || {}, entry.branch);
    fs.renameSync(stage, dest);
    try { await runSteps(dest, entry.manifest.install || [], log); }
    catch (e) { fs.rmSync(dest, { recursive: true, force: true }); throw e; }
    return { repo: entry.repo, version, installedAt: Date.now() };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

// Tracked files changed by hand, at most `n`. Untracked files (an install
// step's output) do not count: git refuses the checkout itself if one is in
// the way, and says so.
async function localChanges(dir, n = 10) {
  const r = await git(dir, ['status', '--porcelain', '--untracked-files=no']);
  return r.stdout.split('\n').filter(Boolean).slice(0, n).map(l => l.slice(3));
}

export async function update(entry, record, { log = () => {}, where = appWhere(entry.manifest.id) } = {}) {
  const { id, dir } = where;
  if (!fs.existsSync(path.join(dir, '.git'))) throw new AppsError(404, `${id} is not installed`);
  const changed = await localChanges(dir);
  if (changed.length) throw new AppsError(409, `${id} has local changes, so it is not updated: ${changed.join(', ')}`);
  const f = await git(dir, ['fetch', '--quiet', '--tags', 'origin']);
  if (f.code !== 0) throw new AppsError(502, `git fetch: ${tail(f.stderr)}`);
  const version = await checkout(dir, entry.latest || {}, entry.branch);
  await runSteps(dir, entry.manifest.install || [], log);
  return { ...record, version, updatedAt: Date.now() };
}

// Deletes the installed copy; the app's data goes only when asked.
export function remove(id, { purge = false, where = appWhere(id) } = {}) {
  const { dir } = where;
  if (!fs.existsSync(dir)) throw new AppsError(404, `${id} is not installed`);
  fs.rmSync(dir, { recursive: true, force: true });
  if (purge && where.root === appsDir()) fs.rmSync(appDataDir(id), { recursive: true, force: true });
  return { removed: tildify(dir), purged: !!purge };
}

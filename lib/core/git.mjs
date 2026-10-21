// git helpers. The part that matters for safety is the worktree pair: Deck
// creates throwaway worktrees for CI runs and must never remove anything that
// is not one of them (a repo can be served live from its checkout, and the
// other checkouts hold live work). Both functions refuse any directory outside
// dataDir()'s work folders.
import fs from 'node:fs';
import path from 'node:path';
import { run, runOk } from './proc.mjs';
import { dataDir, expandHome, isInside } from './paths.mjs';

export const git = (args, cwd, opts = {}) => runOk('git', args, { cwd, ...opts }).then(s => s.trim());
export const gitSafe = (args, cwd, opts = {}) => run('git', args, { cwd, ...opts }).then(r => (r.code === 0 ? r.stdout.trim() : ''));

export const SHA_RE = /^[0-9a-f]{40}$/;

// A worktree Deck may create or delete: below dataDir(), inside a folder named
// `work`, and not that folder itself.
export function isThrowawayDir(dir) {
  const d = path.resolve(dir);
  if (!isInside(d, dataDir())) return false;
  const rel = path.relative(dataDir(), d).split(path.sep);
  const w = rel.indexOf('work');
  return w >= 0 && w < rel.length - 1;
}

function assertThrowaway(dir) {
  if (!isThrowawayDir(dir)) throw new Error(`refusing to touch ${dir}: not a Deck throwaway worktree (must be under ${path.join(dataDir(), '<feature>', 'work')})`);
}

export async function hasCommit(repoPath, sha) {
  const r = await run('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: expandHome(repoPath) });
  return r.code === 0;
}

// The SHA origin has for a ref, read with ls-remote. Nothing local changes.
export async function remoteSha(repoPath, ref) {
  const out = await git(['ls-remote', 'origin', ref], expandHome(repoPath), { timeoutMs: 120000 });
  const line = out.split('\n').find(l => l.endsWith(`\t${ref}`));
  if (!line) throw new Error(`origin has no ${ref}`);
  return line.split('\t')[0];
}

// Brings a commit into the object store without writing FETCH_HEAD or any
// ref. FETCH_HEAD is shared by everything that fetches in a checkout (other
// sessions, the review queue, CI), so fetch-then-read-FETCH_HEAD could return
// another process's commit.
export async function fetchSha(repoPath, sha) {
  if (!SHA_RE.test(sha)) throw new Error(`not a commit SHA: ${sha}`);
  if (await hasCommit(repoPath, sha)) return sha;
  await git(['fetch', '--quiet', '--no-write-fetch-head', 'origin', sha], expandHome(repoPath), { timeoutMs: 300000 });
  if (!(await hasCommit(repoPath, sha))) throw new Error(`fetched ${sha} but it is not in ${repoPath}`);
  return sha;
}

// A PR's head, by number, into the object store; returns its SHA.
export async function fetchPrHead(repoPath, pr) {
  return fetchSha(repoPath, await remoteSha(repoPath, `refs/pull/${Number(pr)}/head`));
}

// A branch (or a full ref) on origin into the object store; returns its SHA.
export async function fetchRef(repoPath, ref) {
  return fetchSha(repoPath, await remoteSha(repoPath, ref.startsWith('refs/') ? ref : `refs/heads/${ref}`));
}

export async function addWorktree(repoPath, dir, sha) {
  assertThrowaway(dir);
  if (fs.existsSync(dir)) await removeWorktree(repoPath, dir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(['worktree', 'add', '--detach', '--quiet', dir, sha], expandHome(repoPath), { timeoutMs: 300000 });
  return dir;
}

export async function removeWorktree(repoPath, dir) {
  assertThrowaway(dir);
  const cwd = expandHome(repoPath);
  await run('git', ['worktree', 'remove', '--force', '--force', dir], { cwd, timeoutMs: 300000 });
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  await run('git', ['worktree', 'prune'], { cwd });
}

// File content at a commit, or null when it does not exist there.
export async function showFile(repoPath, sha, file) {
  const r = await run('git', ['show', `${sha}:${file}`], { cwd: expandHome(repoPath), maxBuffer: 16 * 1024 * 1024 });
  return r.code === 0 ? r.stdout : null;
}

export async function mergeBase(repoPath, a, b) {
  return gitSafe(['merge-base', a, b], expandHome(repoPath));
}

export async function changedFiles(repoPath, base, head) {
  const out = await gitSafe(['diff', '--name-only', `${base}...${head}`], expandHome(repoPath));
  return out ? out.split('\n').filter(Boolean) : [];
}

export async function diffText(repoPath, base, head, { context = 10, files } = {}) {
  const args = ['diff', `-U${context}`, '--no-color', `${base}...${head}`];
  if (files && files.length) args.push('--', ...files);
  return git(args, expandHome(repoPath), { maxBuffer: 64 * 1024 * 1024 });
}

// A file's content at a commit, or null when the path is missing or is not a
// file: `git show <sha>:<dir>` prints a tree listing, cat-file refuses it.
export async function showBlob(repoPath, sha, file) {
  const r = await run('git', ['cat-file', 'blob', `${sha}:${file}`], { cwd: expandHome(repoPath), maxBuffer: 16 * 1024 * 1024 });
  return r.code === 0 ? r.stdout : null;
}

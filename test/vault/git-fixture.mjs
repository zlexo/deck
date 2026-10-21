// Shared by the vault git tests: a temp HOME with no git config, a vault per
// call with a local bare repository standing in for GitHub, a stubbed gh that
// answers the visibility, and an injected clock. Imported first, so the
// environment is set before lib/ reads it; the temp folder goes when the file's
// tests end, whatever happened before.
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-vault-git-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// No global or system git config, so the repo-local Deck identity is what commits.
Object.assign(process.env, { HOME: path.join(tmp, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
  DECK_DATA: path.join(tmp, 'data'), DECK_CONFIG: path.join(tmp, 'config'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') });
delete process.env.DECK_VAULT;
fs.mkdirSync(process.env.HOME);
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');

const { vaultGit } = await import('../../lib/vault/git.mjs');

export const MIN = 60e3;
export const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
// Keys built at run time, so no file in the repo holds one.
export const KEYS = { 'Anthropic key': ['sk-', 'ant-api03-', 'x'.repeat(40)], 'OpenAI key': ['sk-', 'proj-', 'y'.repeat(48)],
  'GitHub token': ['gh', 'p_', 'A1'.repeat(18)], 'AWS key id': ['AK', 'IA', 'Q'.repeat(16)], 'private key': ['-----BEGIN ', 'OPENSSH PRIVATE', ' KEY-----'] };
export const key = kind => KEYS[kind].join('');
export const log = dir => sh(dir, 'log', '--format=%s', 'main').split('\n');
export const staged = dir => sh(dir, 'diff', '--cached', '--name-only');
export const remoteHead = bare => { try { return sh(bare, 'rev-parse', 'main'); } catch { return null; } };
export const handCommit = (dir, msg = 'by hand') => { sh(dir, 'add', '-A'); sh(dir, '-c', 'user.name=h', '-c', 'user.email=h@h', 'commit', '-q', '-m', msg); };

let n = 0;
export function setup({ vault = {}, vis = 'private', ...extra } = {}) {
  const id = ++n, dir = path.join(tmp, `v${id}`), bare = path.join(tmp, 'remotes', `me${id}`, 'vault.git');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(bare, { recursive: true });
  sh(bare, 'init', '-q', '--bare', '-b', 'main');
  const box = { state: { vault: { path: dir, created: true, remote: `me${id}/vault`, ...vault } } };
  const calls = [];
  const gh = async (args, o) => { calls.push(args.join(' ')); return typeof vis === 'function' ? vis(args, o) : `${vis}\n`; };
  const clock = { t: 0 };
  const ctx = { getState: () => box.state, saveState: s => { box.state = s; } };
  const opts = { gh, githubUrl: (o, nm) => path.join(tmp, 'remotes', o, `${nm}.git`), now: () => clock.t, ...extra };
  return { id, dir, bare, box, calls, clock, ctx, opts, vg: vaultGit(ctx, opts) };
}
// A vault Deck created: one note, then Create's first commit.
export async function created(s) { write(s.dir, 'Boards/Work.md', '# Work\n\n## Backlog\n- [ ] start\n'); await s.vg.initCreated(); }
// Another Mac pushes a commit to the remote.
export function otherMac(s, rel, text) {
  const o = path.join(tmp, `other${++n}`);
  execFileSync('git', ['clone', '-q', s.bare, o]);
  write(o, rel, text);
  handCommit(o, 'other mac');
  sh(o, 'push', '-q', 'origin', 'main');
}
// An adopted vault in mode push with the user's own first commit.
export function adopted({ vault = {}, ...extra } = {}) {
  const s = setup({ vault: { created: false, git: 'push', ...vault }, ...extra });
  write(s.dir, 'Projects/p.md', 'p\n');
  sh(s.dir, 'init', '-q', '-b', 'main');
  sh(s.dir, 'config', 'user.name', 'Me');
  sh(s.dir, 'config', 'user.email', 'me@example.com');
  sh(s.dir, 'add', '-A');
  sh(s.dir, 'commit', '-q', '-m', 'mine');
  return s;
}

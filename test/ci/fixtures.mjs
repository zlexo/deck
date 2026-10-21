// Shared setup for the CI tests: a temp data folder with a space in its path
// (the real one is under "Application Support"), small git repos with a bare
// origin, and a lock held by another live process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Call before importing anything under lib/.
export function setupEnv(prefix) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  process.env.DECK_DATA = path.join(tmp, 'App Support', 'Deck');
  process.env.DECK_VAULT = path.join(tmp, 'vault');
  process.env.DECK_ROOT = path.join(tmp, 'deck');
  fs.mkdirSync(process.env.DECK_ROOT, { recursive: true });
  return tmp;
}

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A checkout whose origin is a bare repo; main has one commit, pushed.
export function makeRepo(tmp, name) {
  const origin = path.join(tmp, 'origins', `${name}.git`);
  const dir = path.join(tmp, 'repos', name);
  fs.mkdirSync(origin, { recursive: true });
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'ci@test');
  git(dir, 'config', 'user.name', 'ci test');
  git(dir, 'remote', 'add', 'origin', origin);
  const repo = {
    dir, origin,
    // Commits on whatever branch is checked out; returns the SHA.
    commit(files, msg = 'change') {
      for (const [f, text] of Object.entries(files)) {
        const p = path.join(dir, f);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
      }
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', msg);
      return git(dir, 'rev-parse', 'HEAD');
    },
    checkout(branch, from) { git(dir, 'checkout', '-q', ...(from ? ['-B', branch, from] : [branch])); },
    pushMain() { git(dir, 'push', '-q', 'origin', 'main'); },
    pushPr(n, sha) { git(dir, 'push', '-q', 'origin', `${sha}:refs/pull/${n}/head`); },
  };
  repo.main = repo.commit({ 'README.md': `${name}\n` }, 'initial');
  repo.pushMain();
  return repo;
}

// Free-disk limits at 0: a test must not depend on how full this Mac's disk
// is; the refusal and the watchdog have tests of their own.
export function stateFor(repos, ciRepos, extra = {}) {
  return {
    repos: Object.fromEntries(Object.entries(repos).map(([id, r]) => [id, { name: id, slug: `test/${id}`, path: r.dir }])),
    ci: { pollMs: 20, minFreeDiskGB: 0, stopBelowFreeDiskGB: 0, repos: ciRepos, ...extra },
  };
}

// A lock file owned by another live process (a sleep), as a second Deck
// process or the heavy-lock script would leave it.
export function holdLock(name, info = {}) {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  const file = path.join(process.env.DECK_DATA, 'locks', `${name}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid, ts: Date.now(), ...info }));
  let held = true;
  return {
    pid: child.pid,
    // Once only: after that the file may be another holder's.
    release() {
      if (!held) return;
      held = false;
      try { fs.unlinkSync(file); } catch {}
      child.kill('SIGKILL');
    },
  };
}

export async function until(fn, { timeoutMs = 10000, stepMs = 20, what = 'a condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, stepMs));
  }
}

// No GitHub in tests: a test that needs pull request facts passes its own.
export const noGithub = {
  async prInfo() { throw new Error('no GitHub in tests'); },
  async findPrForSha() { return null; },
  async githubEnv() { throw new Error('no token in tests'); },
};

export const sh = script => ['bash', '-c', script];

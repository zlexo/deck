import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-vault-git-')));
// No global or system git config, so the repo-local Deck identity is what commits.
Object.assign(process.env, { HOME: path.join(tmp, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
  DECK_DATA: path.join(tmp, 'data'), DECK_CONFIG: path.join(tmp, 'config') });
delete process.env.DECK_VAULT;
fs.mkdirSync(process.env.HOME);
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
const { vaultGit, scanDiff, register, QUIET_MS, QUIT_MS } = await import('../../lib/vault/git.mjs');
const { run } = await import('../../lib/core/proc.mjs');
const { createRouter } = await import('../../lib/core/http.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MIN = 60e3;
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
// Keys built at run time, so this file holds none.
const KEYS = { 'Anthropic key': ['sk-', 'ant-api03-', 'x'.repeat(40)], 'OpenAI key': ['sk-', 'proj-', 'y'.repeat(48)],
  'GitHub token': ['gh', 'p_', 'A1'.repeat(18)], 'AWS key id': ['AK', 'IA', 'Q'.repeat(16)], 'private key': ['-----BEGIN ', 'OPENSSH PRIVATE', ' KEY-----'] };
const key = kind => KEYS[kind].join('');

let n = 0;
// A vault, a bare remote standing in for GitHub, a gh that answers `private`, and a clock.
function setup({ vault = {}, priv = 'true' } = {}) {
  const id = ++n, dir = path.join(tmp, `v${id}`), bare = path.join(tmp, 'remotes', `me${id}`, 'vault.git');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(bare, { recursive: true });
  sh(bare, 'init', '-q', '--bare', '-b', 'main');
  const box = { state: { vault: { path: dir, created: true, remote: `me${id}/vault`, ...vault } } };
  const calls = [];
  const gh = async args => { calls.push(args.join(' ')); if (typeof priv === 'function') return priv(args); return `${priv}\n`; };
  const clock = { t: 0 };
  const ctx = { getState: () => box.state, saveState: s => { box.state = s; } };
  const opts = { gh, githubUrl: (o, nm) => path.join(tmp, 'remotes', o, `${nm}.git`), now: () => clock.t };
  return { dir, bare, box, calls, clock, ctx, opts, vg: vaultGit(ctx, opts) };
}
const log = dir => sh(dir, 'log', '--format=%s', 'main').split('\n');
const remoteHead = bare => { try { return sh(bare, 'rev-parse', 'main'); } catch { return null; } };
async function created(s) { write(s.dir, 'Boards/Work.md', '# Work\n\n## Backlog\n- [ ] start\n'); await s.vg.initCreated(); }

test('scan: each kind of key is found by file and line; near misses are not', () => {
  for (const kind of Object.keys(KEYS)) {
    const hits = scanDiff(`+++ b/Notes/a b.md\n@@ -0,0 +1,3 @@\n+one\n+two\n+token: ${key(kind)} here\n`);
    assert.deepEqual(hits, [{ file: 'Notes/a b.md', line: 3, kind }], kind);
  }
  assert.deepEqual(scanDiff('+++ b/x.md\n@@ -1 +1 @@\n+sk-ant is the prefix, AKIA1234 is short, ghp_short\n-' + key('AWS key id') + '\n'), [], 'prose and removed lines');
});

test('auto: the first commit at Create, then one commit after 10 quiet minutes, never while a file is still changing', async () => {
  const s = setup();
  await created(s);
  assert.deepEqual(log(s.dir), ['Vault: 1 note']);
  assert.equal(sh(s.dir, 'log', '-1', '--format=%an <%ae>'), 'Deck <deck@localhost>', 'no user identity, so the repo-local one');
  write(s.dir, 'Daily/d.md', 'one\n');
  await s.vg.tick();
  s.clock.t = 9 * MIN; await s.vg.tick();
  write(s.dir, 'Daily/d.md', 'one two\n'); // still being written
  s.clock.t = 9.5 * MIN; await s.vg.tick();
  s.clock.t = 19 * MIN; await s.vg.tick();
  assert.equal(log(s.dir).length, 1, 'quiet for 9.5 minutes only');
  write(s.dir, 'Projects/p.md', '# p\n');
  s.clock.t = 25 * MIN; await s.vg.tick();
  s.clock.t = 25 * MIN + QUIET_MS; await s.vg.tick();
  assert.deepEqual(log(s.dir), ['Vault: 2 notes', 'Vault: 1 note']);
  assert.equal(sh(s.dir, 'log', '-1', '--format=%b'), 'A Daily/d.md\nA Projects/p.md');
  assert.equal(remoteHead(s.bare), sh(s.dir, 'rev-parse', 'HEAD'), 'pushed');
  assert.ok(s.calls.includes(`api repos/me${n}/vault --jq .private`), 'checked private first');
  s.clock.t += QUIET_MS; await s.vg.tick();
  assert.equal(log(s.dir).length, 2, 'nothing new, no commit');
});

test('secret scan: a planted key commits nothing and is reported by file and line only', async () => {
  for (const kind of Object.keys(KEYS)) {
    const s = setup();
    await created(s);
    write(s.dir, 'Knowledge/keys.md', `# Keys\n\nmine: ${key(kind)}\n`);
    write(s.dir, 'Projects/ok.md', '# ok\n');
    await s.vg.commitNow();
    const st = await s.vg.status();
    assert.equal(log(s.dir).length, 1, `${kind}: no commit`);
    assert.deepEqual(st.secrets, [{ file: 'Knowledge/keys.md', line: 3, kind }]);
    assert.match(st.error, /Knowledge\/keys\.md:3/);
    assert.ok(!JSON.stringify(st).includes(key(kind)), 'the key itself is never shown');
    assert.equal(sh(s.dir, 'diff', '--cached', '--name-only'), '', 'nothing left staged');
    assert.equal(remoteHead(s.bare), sh(s.dir, 'rev-parse', 'HEAD'), 'only the clean first commit went out');
    fs.writeFileSync(path.join(s.dir, 'Knowledge/keys.md'), '# Keys\n\nin the keychain\n');
    await s.vg.commitNow();
    assert.equal(log(s.dir)[0], 'Vault: 2 notes');
    assert.deepEqual((await s.vg.status()).secrets, []);
  }
});

test('remote: a public repo, an unknown answer or a stray origin means no push, and the status says why', async () => {
  for (const [priv, why] of [['false', /is public/], [() => { throw new Error('gh api: HTTP 502'); }, /could not check .* private \(gh api: HTTP 502\)/]]) {
    const s = setup({ priv });
    await created(s);
    await s.vg.pushNow();
    const st = await s.vg.status();
    assert.equal(remoteHead(s.bare), null, 'nothing reached the remote');
    assert.match(st.error, why);
    assert.equal(st.remote.private, priv === 'false' ? false : null);
    assert.equal(st.lastPush.ok, false);
  }
  const s = setup();
  await created(s);
  sh(s.dir, 'remote', 'add', 'origin', path.join(tmp, 'elsewhere.git'));
  await s.vg.pushNow();
  assert.deepEqual(s.calls, [], 'not even asked: the URL is not the repo checked');
  assert.match((await s.vg.status()).error, /origin pushes to .*elsewhere\.git, not me\d+\/vault; no push/);
  assert.equal(remoteHead(s.bare), null);
});

function otherMac(s, rel, text) {
  const o = path.join(tmp, `other${++n}`);
  execFileSync('git', ['clone', '-q', s.bare, o]);
  write(o, rel, text);
  sh(o, 'add', '-A');
  sh(o, '-c', 'user.name=o', '-c', 'user.email=o@o', 'commit', '-q', '-m', 'other mac');
  sh(o, 'push', '-q', 'origin', 'main');
}

test('rejected push: a clean tree merges origin and pushes; a conflict is aborted and pushing stops', async () => {
  const s = setup();
  await created(s);
  await s.vg.pushNow();
  otherMac(s, 'Projects/theirs.md', 'theirs\n');
  write(s.dir, 'Projects/mine.md', 'mine\n');
  await s.vg.commitNow();
  assert.equal(remoteHead(s.bare), sh(s.dir, 'rev-parse', 'HEAD'), 'merged, then pushed');
  assert.equal(sh(s.dir, 'rev-list', '--parents', '-1', 'HEAD').split(' ').length, 3, 'a merge commit');
  assert.equal(sh(s.dir, 'log', '-1', '--format=%s', 'HEAD^1'), 'Vault: 1 note', 'never a rebase: my commit kept as it was');
  assert.ok(fs.existsSync(path.join(s.dir, 'Projects/theirs.md')));

  otherMac(s, 'Boards/Work.md', '# Work\n\n## Backlog\n- [ ] theirs\n');
  write(s.dir, 'Boards/Work.md', '# Work\n\n## Backlog\n- [ ] mine\n');
  await s.vg.commitNow();
  const st = await s.vg.status();
  assert.deepEqual(st.conflicts, ['Boards/Work.md']);
  assert.match(st.error, /merge aborted, pushing stopped: origin\/main conflicts in Boards\/Work\.md/);
  assert.equal(st.pending, 0, 'aborted: no conflict markers left');
  assert.ok(!fs.existsSync(path.join(s.dir, '.git', 'MERGE_HEAD')));
  const asked = s.calls.length;
  s.clock.t += 2 * QUIET_MS; await s.vg.tick();
  assert.equal(s.calls.length, asked, 'pushing stopped until Push is pressed');

  const d = setup();
  await created(d);
  await d.vg.pushNow();
  otherMac(d, 'Projects/theirs.md', 'theirs\n');
  write(d.dir, 'Projects/mine.md', 'mine\n');
  sh(d.dir, 'add', '-A');
  sh(d.dir, 'commit', '-q', '-m', 'by hand');
  write(d.dir, 'Daily/new.md', 'still open\n');
  await d.vg.pushNow();
  assert.match((await d.vg.status()).error, /merges them only on a clean tree/);
  assert.ok(!fs.existsSync(path.join(d.dir, 'Projects/theirs.md')), 'no merge on a dirty tree');
});

test('push mode and the memory mirror: only Memory/ is committed, another session\'s note is left alone, nothing is merged', async () => {
  const mem = path.join(tmp, 'claude-memory');
  write(mem, 'MEMORY.md', '- [a](a.md)\n');
  write(mem, 'a.md', 'a\n');
  const s = setup({ vault: { created: false, git: 'push', memoryMirror: mem } });
  write(s.dir, 'Projects/p.md', 'p\n');
  sh(s.dir, 'init', '-q', '-b', 'main');
  sh(s.dir, 'config', 'user.name', 'Me');
  sh(s.dir, 'config', 'user.email', 'me@example.com');
  sh(s.dir, 'add', '-A');
  sh(s.dir, 'commit', '-q', '-m', 'mine');
  write(s.dir, 'Projects/p.md', 'p, edited in another session\n');
  sh(s.dir, 'add', 'Projects/p.md');
  write(s.dir, 'Daily/today.md', 'untracked\n');
  await s.vg.tick();
  s.clock.t = QUIET_MS; await s.vg.tick();
  assert.deepEqual(log(s.dir), ['Memory: 2 files', 'mine']);
  assert.equal(sh(s.dir, 'log', '-1', '--format=%an <%ae>'), 'Me <me@example.com>', 'the user\'s identity when there is one');
  assert.deepEqual(sh(s.dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['Memory/MEMORY.md', 'Memory/a.md']);
  assert.equal(sh(s.dir, 'diff', '--cached', '--name-only'), 'Projects/p.md', 'still staged, not committed');
  assert.equal(fs.readFileSync(path.join(s.dir, 'Daily/today.md'), 'utf8'), 'untracked\n');
  assert.equal(remoteHead(s.bare), sh(s.dir, 'rev-parse', 'HEAD'));
  await s.vg.commitNow();
  assert.equal(log(s.dir).length, 2, 'push mode commits nothing else');

  fs.rmSync(path.join(mem, 'a.md'));
  s.clock.t += QUIET_MS; await s.vg.tick();
  s.clock.t += QUIET_MS; await s.vg.tick();
  assert.equal(log(s.dir)[0], 'Memory: 1 file');
  assert.ok(!fs.existsSync(path.join(s.dir, 'Memory/a.md')), 'a deletion is mirrored');
  fs.rmSync(mem, { recursive: true });
  s.clock.t += QUIET_MS; await s.vg.pushNow();
  assert.ok(fs.existsSync(path.join(s.dir, 'Memory/MEMORY.md')), 'a missing source deletes nothing');
  assert.match((await s.vg.status()).error, /memory folder .* is missing; Memory\/ is left as it is/);

  otherMac(s, 'Projects/q.md', 'q\n');
  write(mem, 'MEMORY.md', 'changed\n');
  await s.vg.pushNow();
  assert.match((await s.vg.status()).error, /origin has 1 commit this Mac does not; mode push never merges/);
  assert.equal(sh(s.dir, 'rev-list', '--merges', '--count', 'main'), '0', 'no merge');
  assert.ok(!fs.existsSync(path.join(s.dir, 'Projects/q.md')));
});

test('an adopted vault starts off: status only', async () => {
  const s = setup({ vault: { created: false, remote: undefined } });
  write(s.dir, 'a.md', 'a\n');
  const st = await s.vg.status();
  assert.equal(st.mode, 'off');
  assert.equal(st.repo, null);
  s.clock.t = 2 * QUIET_MS; await s.vg.tick(); await s.vg.tick();
  assert.ok(!fs.existsSync(path.join(s.dir, '.git')));
  await assert.rejects(s.vg.commitNow(), /git mode is off/);
});

test('quit: commits and pushes at once; a push that hangs is stopped at the budget', async () => {
  const s = setup();
  await created(s);
  write(s.dir, 'Daily/d.md', 'just written\n');
  let t0 = Date.now();
  await s.vg.quit();
  const fast = Date.now() - t0;
  assert.equal(log(s.dir).length, 2, 'not quiet, committed anyway');
  assert.equal(remoteHead(s.bare), sh(s.dir, 'rev-parse', 'HEAD'));
  assert.ok(fast < QUIT_MS, `${fast} ms`);

  const h = setup();
  await created(h);
  // A gh that hangs: a real child, which the budget must stop.
  h.opts.gh = async (args, o) => { const r = await run('sleep', ['917.25'], o); if (r.code !== 0) throw new Error(`gh killed (${r.signal})`); return 'true'; };
  const hv = vaultGit(h.ctx, h.opts);
  write(h.dir, 'Daily/d.md', 'x\n');
  t0 = Date.now();
  await hv.quit();
  const slow = Date.now() - t0;
  console.log(`quit: ${fast} ms with a push, ${slow} ms when gh hangs (budget ${QUIT_MS} ms)`);
  assert.ok(slow >= QUIT_MS && slow < QUIT_MS + 500, `${slow} ms`);
  assert.equal(log(h.dir).length, 2, 'the commit landed before the budget ran out');
  assert.equal(remoteHead(h.bare), null);
  assert.equal((await run('pgrep', ['-f', '^sleep 917.25$'])).stdout.trim(), '', 'the hung child is gone');
  assert.match((await hv.status()).error, /gave up: Deck quit first/);
});

test('wiring: Create makes the first commit, and the gateway\'s stop commits at quit', async () => {
  const { fileURLToPath } = await import('node:url');
  const { setDeckRoot } = await import('../../lib/core/paths.mjs');
  setDeckRoot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const vault = await import('../../lib/vault/index.mjs');
  const box = { state: {} };
  const router = createRouter();
  vault.register(router, { getState: () => box.state, saveState: st => { box.state = st; } });
  const req = { method: 'POST', on(ev, fn) { if (ev === 'end') queueMicrotask(fn); } };
  const res = { writeHead(c) { this.code = c; this.headersSent = true; }, end() { this.writableEnded = true; } };
  await router.handle(req, res, new URL('http://x/api/vault/create'));
  const dir = path.join(process.env.DECK_DATA, 'vault');
  assert.match(log(dir)[0], /^Vault: \d+ notes$/);
  vault.start();
  write(dir, 'Daily/d.md', 'at quit\n');
  await vault.stop();
  assert.deepEqual(sh(dir, 'show', '--name-only', '--format=%s', 'HEAD').split('\n').filter(Boolean), ['Vault: 1 note', 'Daily/d.md']);
});

test('routes: mode, remote by Create private repo, and the GET body', async () => {
  const s = setup({ vault: { remote: undefined } });
  await created(s);
  s.opts.gh = async args => { s.calls.push(args.join(' ')); return args[0] === 'repo' ? `https://github.com/me${n}/notes\n` : 'true\n'; };
  const router = createRouter();
  register(router, s.ctx, { ...s.opts, githubUrl: (o, nm) => (nm === 'notes' ? s.bare : 'x') });
  const call = async (method, url, body) => {
    const res = { headersSent: false, writableEnded: false, writeHead(c) { this.code = c; this.headersSent = true; }, end(b) { this.body = JSON.parse(b); this.writableEnded = true; } };
    const req = { method, on(ev, fn) { if (ev === 'data' && body) queueMicrotask(() => fn(Buffer.from(JSON.stringify(body)))); if (ev === 'end') queueMicrotask(() => queueMicrotask(fn)); } };
    await router.handle(req, res, new URL(url, 'http://x'));
    return res;
  };
  assert.equal((await call('POST', '/api/vault/git/mode', { mode: 'sometimes' })).code, 400);
  assert.equal((await call('POST', '/api/vault/git/mode', { mode: 'push' })).body.status.mode, 'push');
  assert.equal(s.box.state.vault.git, 'push');
  assert.equal((await call('POST', '/api/vault/git/remote', { repo: 'not a repo' })).code, 400);
  const r = await call('POST', '/api/vault/git/remote', { create: 'notes' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.ok(s.calls.includes('repo create notes --private'));
  assert.equal(s.box.state.vault.remote, `me${n}/notes`);
  assert.equal(sh(s.dir, 'remote', 'get-url', 'origin'), s.bare);
  assert.deepEqual(r.body.status.remote, { url: s.bare, owner: `me${n}`, name: 'notes', private: true, checkedAt: 0 });
  s.clock.t = QUIET_MS; s.calls.length = 0;
  assert.equal((await call('GET', '/api/vault/git')).body.remote.checkedAt, QUIET_MS, 'asked again after a quiet spell');
  assert.equal(s.calls.length, 1);
  await call('GET', '/api/vault/git');
  assert.equal(s.calls.length, 1, 'and not on every poll');
  const p = await call('POST', '/api/vault/git/push');
  assert.equal(p.body.status.lastPush.ok, true);
  assert.equal(remoteHead(s.bare), sh(s.dir, 'rev-parse', 'HEAD'));
  const g = (await call('GET', '/api/vault/git')).body;
  assert.deepEqual(Object.keys(g).slice(0, 11), ['repo', 'mode', 'branch', 'pending', 'lastCommit', 'remote', 'ahead', 'behind', 'lastPush', 'memoryMirror', 'error']);
  assert.deepEqual([g.branch, g.ahead, g.behind, g.lastCommit.subject, g.lastCommit.files], ['main', 0, 0, 'Vault: 1 note', ['Boards/Work.md']]);
});

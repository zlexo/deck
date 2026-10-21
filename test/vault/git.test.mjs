import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, MIN, sh, write, KEYS, key, log, staged, remoteHead, setup, created } from './git-fixture.mjs';

const { scanDiff, register, QUIET_MS } = await import('../../lib/vault/git.mjs');
const { run } = await import('../../lib/core/proc.mjs');
const { createRouter } = await import('../../lib/core/http.mjs');

const diff = (file, ...lines) => `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`;

test('scan: each kind of key is found by file and line; near misses, removed lines and AWS example ids are not', () => {
  for (const kind of Object.keys(KEYS))
    assert.deepEqual(scanDiff(diff('Notes/a b.md', 'one', 'two', `token: ${key(kind)} here`)), [{ file: 'Notes/a b.md', line: 3, kind }], kind);
  assert.deepEqual(scanDiff(diff('x.md', 'sk-ant is the prefix, AKIA1234 is short, ghp_short', 'id: AKIAIOSFODNN7EXAMPLE') + `@@ -9 +9 @@\n-${key('AWS key id')}\n`), []);
});

test('scan: an added line that starts with "++ " is content, not a header; a log reports the commit', () => {
  const text = `\x01${'a'.repeat(40)}\n${diff('k.md', 'fine', `++ ${key('GitHub token')}`)}`;
  assert.deepEqual(scanDiff(text), [{ file: 'k.md', line: 2, kind: 'GitHub token', sha: 'a'.repeat(40) }]);
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
  assert.ok(s.calls.includes(`api --hostname github.com repos/me${s.id}/vault --jq .visibility`), 'checked private first');
  s.clock.t += QUIET_MS; await s.vg.tick();
  assert.equal(log(s.dir).length, 2, 'nothing new, no commit');
});

test('secret scan: a file with a key is held back and reported by file and line only; the other file commits', async () => {
  for (const kind of Object.keys(KEYS)) {
    const s = setup();
    await created(s);
    write(s.dir, 'Knowledge/keys.md', `# Keys\n\nmine: ${key(kind)}\n`);
    write(s.dir, 'Projects/ok.md', '# ok, with AWS\'s example id AKIAIOSFODNN7EXAMPLE\n');
    await s.vg.commitNow();
    const st = await s.vg.status();
    assert.deepEqual(log(s.dir), ['Vault: 1 note', 'Vault: 1 note'], kind);
    assert.equal(sh(s.dir, 'show', '--name-only', '--format=', 'HEAD'), 'Projects/ok.md');
    assert.deepEqual(st.secrets, [{ file: 'Knowledge/keys.md', line: 3, kind }]);
    assert.match(st.error, /held back, possible secret at Knowledge\/keys\.md:3/);
    assert.ok(!JSON.stringify(st).includes(key(kind)), 'the key itself is never shown');
    assert.equal(staged(s.dir), '', 'nothing left staged');
    assert.equal(remoteHead(s.bare), sh(s.dir, 'rev-parse', 'HEAD'));
    fs.writeFileSync(path.join(s.dir, 'Knowledge/keys.md'), '# Keys\n\nin the keychain\n');
    await s.vg.commitNow();
    assert.equal(log(s.dir)[0], 'Vault: 1 note');
    assert.deepEqual((await s.vg.status()).secrets, []);
  }
});

test('secret scan: a binary file, a file marked -diff and an added "++ " line are all read', async () => {
  const s = setup();
  await created(s);
  write(s.dir, '.gitattributes', '*.md -diff\n');
  sh(s.dir, 'add', '.gitattributes');
  sh(s.dir, 'commit', '-q', '-m', 'attributes');
  fs.writeFileSync(path.join(s.dir, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`\n${key('Anthropic key')}\n`)]));
  write(s.dir, 'Knowledge/nodiff.md', `x\n${key('OpenAI key')}\n`);
  write(s.dir, 'plus.txt', `ok\n++ ${key('GitHub token')}\n`);
  write(s.dir, 'fine.txt', 'fine\n');
  await s.vg.commitNow();
  assert.equal(sh(s.dir, 'show', '--name-only', '--format=', 'HEAD'), 'fine.txt');
  assert.deepEqual((await s.vg.status()).secrets.map(h => `${h.file}:${h.line}`).sort(), ['Knowledge/nodiff.md:2', 'blob.bin:2', 'plus.txt:2']);
  assert.equal(staged(s.dir), '');
});

test('remote: a public, internal or unknown repo or a stray origin means no push, and the status says why', async () => {
  for (const [vis, why, priv] of [['public', /is public; Deck pushes only to a private repo/, false], ['internal', /is internal/, false],
    [() => { throw new Error('gh api: HTTP 502'); }, /could not check .* private \(gh api: HTTP 502\)/, null]]) {
    const s = setup({ vis });
    await created(s);
    await s.vg.pushNow();
    const st = await s.vg.status();
    assert.equal(remoteHead(s.bare), null, 'nothing reached the remote');
    assert.match(st.error, why);
    assert.equal(st.remote.private, priv);
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

test('an adopted vault starts off; a DECK_VAULT vault is off whatever state.json says', async () => {
  const s = setup({ vault: { created: false, remote: undefined } });
  write(s.dir, 'a.md', 'a\n');
  assert.equal((await s.vg.status()).mode, 'off');
  s.clock.t = 2 * QUIET_MS; await s.vg.tick(); await s.vg.tick();
  assert.ok(!fs.existsSync(path.join(s.dir, '.git')));
  await assert.rejects(s.vg.commitNow(), /git mode is off/);

  const e = setup({ vault: { git: 'auto' } });
  await created(e);
  process.env.DECK_VAULT = e.dir;
  try {
    write(e.dir, 'a.md', 'a\n');
    assert.equal((await e.vg.status()).mode, 'off');
    e.clock.t = 2 * QUIET_MS; await e.vg.tick(); await e.vg.tick();
    assert.equal(log(e.dir).length, 1);
    assert.throws(() => e.vg.setMode('auto'), /adopt it first/);
  } finally { delete process.env.DECK_VAULT; }
});

test('adopt and create: the git keys stay with their folder', async () => {
  const { setDeckRoot } = await import('../../lib/core/paths.mjs');
  setDeckRoot(path.resolve(import.meta.dirname, '..', '..'));
  const { adoptVault } = await import('../../lib/vault/index.mjs');
  const a = path.join(tmp, 'adopt-a'), b = path.join(tmp, 'adopt-b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const box = { state: { vault: { path: a, created: false, git: 'push', remote: 'me/a', memoryMirror: '/m', other: 1 } } };
  const ctx = { getState: () => box.state, saveState: st => { box.state = st; } };
  adoptVault(ctx, { path: a });
  assert.deepEqual(box.state.vault, { path: a, created: false, git: 'push', remote: 'me/a', memoryMirror: '/m', other: 1 }, 'same folder: kept');
  adoptVault(ctx, { path: b });
  assert.deepEqual(box.state.vault, { path: b, created: false, other: 1 }, 'another folder: cleared');
});

test('quit: commits and pushes at once; a gh that hangs is stopped and its child is gone', async () => {
  const s = setup();
  await created(s);
  write(s.dir, 'Daily/d.md', 'just written\n');
  let t0 = Date.now();
  await s.vg.quit();
  const fast = Date.now() - t0;
  assert.equal(log(s.dir).length, 2, 'not quiet, committed anyway');
  assert.equal(remoteHead(s.bare), sh(s.dir, 'rev-parse', 'HEAD'));

  const pidFile = path.join(tmp, 'gh.pid');
  const h = setup({ vis: async (args, o) => { const r = await run('/bin/sh', ['-c', `echo $$ > '${pidFile}'; exec sleep 917`], o); if (r.code !== 0) throw new Error(`gh killed (${r.signal})`); return 'private'; } });
  await created(h);
  write(h.dir, 'Daily/d.md', 'x\n');
  t0 = Date.now();
  await h.vg.quit();
  const slow = Date.now() - t0;
  console.log(`quit: ${fast} ms with a push; ${slow} ms when gh hangs`);
  assert.ok(slow < 10000, 'a hang guard, not a budget check');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the hung child is gone');
  assert.equal(log(h.dir).length, 2, 'the commit landed first');
  assert.equal(remoteHead(h.bare), null);
  assert.match((await h.vg.status()).error, /gave up: Deck quit first/);
});

test('routes: mode, remote by Create private repo, and the GET body', async () => {
  const s = setup({ vault: { remote: undefined } });
  await created(s);
  s.opts.gh = async args => { s.calls.push(args.join(' ')); return args[0] === 'repo' ? `https://github.com/me${s.id}/notes\n` : 'private\n'; };
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
  assert.equal(s.box.state.vault.remote, `me${s.id}/notes`);
  assert.equal(sh(s.dir, 'remote', 'get-url', 'origin'), s.bare);
  assert.deepEqual(r.body.status.remote, { url: s.bare, owner: `me${s.id}`, name: 'notes', private: true, checkedAt: 0 });
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
  s.calls.length = 0;
  const again = await call('POST', '/api/vault/git/remote', { create: 'other' });
  assert.equal(again.code, 409);
  assert.ok(!s.calls.some(c => c.startsWith('repo create')), 'refused before GitHub gets a repo');
});

test('wiring: Create makes the first commit, and the gateway\'s stop commits at quit', async () => {
  const { setDeckRoot } = await import('../../lib/core/paths.mjs');
  setDeckRoot(path.resolve(import.meta.dirname, '..', '..'));
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

test('reads never write the index (no index.lock taken while other sessions commit)', async () => {
  const s = setup();
  await created(s);
  const index = path.join(s.dir, '.git', 'index');
  const before = fs.statSync(index).mtimeMs;
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(s.dir, 'Boards/Work.md'), later, later); // stale stat info: a plain `git status` rewrites the index
  await s.vg.status();
  s.clock.t = 1; await s.vg.tick();
  assert.equal(fs.statSync(index).mtimeMs, before);
  sh(s.dir, 'status', '--porcelain');
  assert.notEqual(fs.statSync(index).mtimeMs, before, 'the probe can see a write');
});

test('run(): output past maxBuffer comes back marked truncated', async () => {
  const big = await run(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'], { maxBuffer: 1000 });
  assert.equal(big.truncated, true);
  const small = await run(process.execPath, ['-e', 'process.stdout.write("x".repeat(500))'], { maxBuffer: 1000 });
  assert.equal(small.truncated, false);
});

test('a scan that cannot read everything is never clean: the commit is held and the push does not happen', async () => {
  const s = setup({ maxOut: 4000 });
  await created(s);
  await s.vg.pushNow();
  const pushed = remoteHead(s.bare);
  write(s.dir, 'Knowledge/big.md', `${'plain line\n'.repeat(1000)}`);
  await s.vg.commitNow();
  assert.equal(log(s.dir).length, 1, 'held');
  assert.equal(staged(s.dir), '');
  assert.match((await s.vg.status()).error, /output too large to check/);
  sh(s.dir, 'add', '-A');
  sh(s.dir, 'commit', '-q', '-m', 'big, by hand');
  await s.vg.pushNow();
  assert.equal(remoteHead(s.bare), pushed, 'not pushed');
  assert.match((await s.vg.status()).error, /git log: output too large to check/);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-core-'));
process.env.DECK_DATA = path.join(tmp, 'data');
process.env.DECK_VAULT = path.join(tmp, 'vault');

const { setDeckRoot, dataDir, dataPath, expandHome, tildify, isInside } = await import('../../lib/core/paths.mjs');
const { toolPath, which } = await import('../../lib/core/env.mjs');
const { run, runOk, spawnTracked, pidAlive, listProcesses, RunError } = await import('../../lib/core/proc.mjs');
const { writeJsonAtomic, readJson, appendJsonl, readJsonl, tailLines } = await import('../../lib/core/files.mjs');
const { acquireLock, lockHolder } = await import('../../lib/core/lock.mjs');
const { deepMerge, configSection, repos } = await import('../../lib/core/config.mjs');
const { createRouter, HttpError } = await import('../../lib/core/http.mjs');
const { isThrowawayDir, addWorktree, removeWorktree, showFile } = await import('../../lib/core/git.mjs');
const { appendDaily, todayStr } = await import('../../lib/core/vault.mjs');
const { codeHash } = await import('../../lib/core/build-hash.mjs');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('paths: data and vault follow the environment, ~ round-trips', () => {
  assert.equal(dataDir(), path.join(tmp, 'data'));
  assert.equal(dataPath('ci', 'x.json'), path.join(tmp, 'data', 'ci', 'x.json'));
  assert.equal(expandHome('~/code'), path.join(os.homedir(), 'code'));
  assert.equal(tildify(path.join(os.homedir(), 'code')), '~/code');
  assert.ok(isInside('/a/b/c', '/a/b'));
  assert.ok(!isInside('/a/b/../x', '/a/b'));
  assert.ok(!isInside('/a/bc', '/a/b'));
});

test('env: under launchd\'s PATH, Homebrew and /usr/local still resolve', () => {
  const saved = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  try {
    const p = toolPath().split(':');
    assert.equal(p[0], '/opt/homebrew/bin');
    assert.ok(p.includes('/usr/bin') && p.includes('/usr/local/bin'));
    assert.equal(new Set(p).size, p.length, 'no duplicates');
    // The control: gh lives in /opt/homebrew/bin on this Mac, which launchd's
    // PATH does not contain. If toolPath stops adding it, this goes red.
    if (fs.existsSync('/opt/homebrew/bin/gh')) assert.equal(which('gh'), '/opt/homebrew/bin/gh');
    assert.equal(which('definitely-not-a-command-xyz'), null);
  } finally { process.env.PATH = saved; }
});

test('proc: run captures output and exit codes and never rejects', async () => {
  const ok = await run('bash', ['-c', 'echo out; echo err >&2; exit 3']);
  assert.equal(ok.code, 3);
  assert.equal(ok.stdout, 'out\n');
  assert.equal(ok.stderr, 'err\n');
  const missing = await run('no-such-binary-xyz', []);
  assert.equal(missing.code, null);
  assert.ok(missing.error);
  await assert.rejects(runOk('bash', ['-c', 'echo boom >&2; exit 1']), e => e instanceof RunError && /boom/.test(e.message));
  const input = await run('cat', [], { input: 'hello' });
  assert.equal(input.stdout, 'hello');
});

test('proc: a timeout kills the whole group, grandchildren too', async () => {
  const marker = path.join(tmp, 'grandchild.pid');
  const r = await run('bash', ['-c', `sleep 30 & echo $! > ${marker}; wait`], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  // A surviving sleep holds the pipes, so run() would only return when it ends
  // on its own after 30 s and the liveness check below would pass by waiting.
  assert.ok(r.durationMs < 3000, `returned after ${r.durationMs} ms: the grandchild outlived the kill`);
  const gpid = Number(fs.readFileSync(marker, 'utf8'));
  await new Promise(res => setTimeout(res, 200));
  assert.equal(pidAlive(gpid), false, 'the grandchild sleep must be gone');
});

test('proc: spawnTracked streams lines to a log and kill() stops the group', async () => {
  const log = path.join(tmp, 'logs', 'a.log');
  const lines = [];
  const marker = path.join(tmp, 'gc2.pid');
  const t = spawnTracked('bash', ['-c', `echo one; echo two >&2; sleep 30 & echo $! > ${marker}; wait`], { logFile: log, onLine: (l, s) => lines.push(`${s}:${l}`) });
  for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 100));
  const t0 = Date.now();
  const res = await t.kill(500);
  assert.ok(Date.now() - t0 < 3000, 'kill() waited for the grandchild to end on its own');
  assert.ok(res.signal || res.code !== 0);
  assert.deepEqual(lines.sort(), ['stderr:two', 'stdout:one']);
  assert.deepEqual(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).sort(), ['one', 'two']);
  const gpid = Number(fs.readFileSync(marker, 'utf8'));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(pidAlive(gpid), false);
});

test('proc: listProcesses sees this process with a start time', async () => {
  const all = await listProcesses();
  const me = all.find(p => p.pid === process.pid);
  assert.ok(me, 'own pid listed');
  assert.ok(me.startedAt && Math.abs(me.startedAt - Date.now()) < 3600e3);
  assert.ok(me.rssBytes > 0);
  assert.equal(me.uid, process.getuid());
  assert.match(me.cmd, /node/);
});

test('files: atomic json, jsonl with a torn line, tail', () => {
  const f = path.join(tmp, 'r', 'x.json');
  writeJsonAtomic(f, { a: 1 });
  assert.deepEqual(readJson(f), { a: 1 });
  assert.equal(readJson(path.join(tmp, 'nope.json'), 'fb'), 'fb');
  const l = path.join(tmp, 'r', 'l.jsonl');
  appendJsonl(l, { n: 1 });
  fs.appendFileSync(l, '{"n": 2, broken\n');
  appendJsonl(l, { n: 3 });
  assert.deepEqual(readJsonl(l).map(x => x.n), [1, 3]);
  const t = path.join(tmp, 'r', 't.txt');
  fs.writeFileSync(t, Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n');
  assert.deepEqual(tailLines(t, 2), ['line 498', 'line 499']);
});

test('lock: exclusive while held, taken over when the holder is dead', () => {
  const a = acquireLock('t1', { what: 'a' });
  assert.ok(a);
  assert.equal(acquireLock('t1'), null, 'second acquire refused');
  assert.equal(lockHolder('t1').what, 'a');
  a.release();
  assert.equal(lockHolder('t1'), null);
  // A lock left by a process that no longer exists.
  const dead = spawnSync('bash', ['-c', 'echo $$']).stdout.toString().trim();
  fs.writeFileSync(dataPath('locks', 't2.lock'), JSON.stringify({ pid: Number(dead), ts: 0 }));
  const b = acquireLock('t2');
  assert.ok(b, 'stale lock taken over');
  b.release();
});

test('lock: a lock file not yet written counts as held, a long-unreadable one is taken over', () => {
  const f = dataPath('locks', 't3.lock');
  fs.writeFileSync(f, ''); // another process created it and has not written its pid yet
  assert.equal(acquireLock('t3'), null, 'a fresh empty lock is held, not stale');
  const old = (Date.now() - 60000) / 1000;
  fs.utimesSync(f, old, old);
  const c = acquireLock('t3');
  assert.ok(c, 'unreadable for a minute: taken over');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).pid, process.pid);
  c.release();
  assert.equal(fs.existsSync(f), false);
  assert.deepEqual(fs.readdirSync(dataPath('locks')).filter(n => n.includes('t3') && n !== 't3.lock'), [], 'no temp files left');
});

test('config: objects merge, arrays replace, state overrides defaults', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } }), { a: { b: 1, c: [3] } });
  const st = { reviews: { queue: false, repos: { perdix: { risk: ['x/**'] } } } };
  const c = configSection('reviews', { queue: true, intervalMin: 10, repos: { perdix: { risk: ['a'], rules: ['R'] } } }, st);
  assert.equal(c.queue, false);
  assert.equal(c.intervalMin, 10);
  assert.deepEqual(c.repos.perdix, { risk: ['x/**'], rules: ['R'] });
  assert.deepEqual(repos({}), {}, 'no repos built in');
  const r = repos({ repos: { perdix: { name: 'Perdix', slug: 'you/perdix', path: '/tmp/p', project: 'perdix' } } });
  assert.deepEqual(r.perdix, { id: 'perdix', name: 'Perdix', slug: 'you/perdix', path: '/tmp/p', project: 'perdix' });
  assert.deepEqual(Object.keys(r), ['perdix']);
});

function fakeReqRes(method, url, bodyText = '') {
  const listeners = {};
  const req = { method, url, on(ev, fn) { (listeners[ev] ||= []).push(fn); if (ev === 'end') queueMicrotask(() => { for (const f of listeners.data || []) f(Buffer.from(bodyText)); for (const f of listeners.end) f(); }); return req; }, destroy() {} };
  const res = { code: null, body: null, headersSent: false, writableEnded: false,
    writeHead(c) { this.code = c; this.headersSent = true; }, end(b) { this.body = b ? JSON.parse(b) : null; this.writableEnded = true; } };
  return { req, res, url: new URL(url, 'http://x') };
}

test('http: params, query, body, errors, fall-through', async () => {
  const r = createRouter();
  r.add('GET', '/api/x/:id/runs/:run', (req, res, { params, query }) => ({ params, q: query.get('q') }));
  r.add('POST', '/api/x', async (req, res, { body }) => ({ got: await body() }));
  r.add('GET', '/api/err', () => { throw new HttpError(409, 'busy'); });
  let t = fakeReqRes('GET', '/api/x/a%20b/runs/7?q=1');
  assert.equal(await r.handle(t.req, t.res, t.url), true);
  assert.deepEqual(t.res.body, { params: { id: 'a b', run: '7' }, q: '1' });
  t = fakeReqRes('POST', '/api/x', '{"k":2}');
  await r.handle(t.req, t.res, t.url);
  assert.deepEqual(t.res.body, { got: { k: 2 } });
  t = fakeReqRes('POST', '/api/x', '{bad');
  await r.handle(t.req, t.res, t.url);
  assert.equal(t.res.code, 400);
  t = fakeReqRes('GET', '/api/err');
  await r.handle(t.req, t.res, t.url);
  assert.equal(t.res.code, 409);
  assert.equal(t.res.body.error, 'busy');
  t = fakeReqRes('GET', '/api/none');
  assert.equal(await r.handle(t.req, t.res, t.url), false);
  t = fakeReqRes('DELETE', '/api/x');
  assert.equal(await r.handle(t.req, t.res, t.url), false);
});

test('git: only Deck work folders count as throwaway (the control for every delete)', () => {
  assert.equal(isThrowawayDir(dataPath('ci', 'work', 'perdix-abc')), true);
  assert.equal(isThrowawayDir(dataPath('ci', 'work')), false, 'the work folder itself');
  assert.equal(isThrowawayDir(dataPath('ci')), false);
  assert.equal(isThrowawayDir(dataDir()), false);
  assert.equal(isThrowawayDir(path.join(os.homedir(), 'yt', 'modplex')), false);
  assert.equal(isThrowawayDir(dataPath('ci', 'work', '..', '..', 'x')), false);
  assert.equal(isThrowawayDir(path.join(tmp, 'elsewhere', 'work', 'x')), false);
});

test('git: worktrees are created and removed only under the work folder', async () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'hi\n');
  g('add', 'f.txt'); g('commit', '-qm', 'one');
  const sha = g('rev-parse', 'HEAD').stdout.trim();
  const dir = dataPath('ci', 'work', 'repo-' + sha.slice(0, 12));
  await addWorktree(repo, dir, sha);
  assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'hi\n');
  assert.equal(await showFile(repo, sha, 'f.txt'), 'hi\n');
  assert.equal(await showFile(repo, sha, 'missing.txt'), null);
  await removeWorktree(repo, dir);
  assert.equal(fs.existsSync(dir), false);
  // Refusals: the repo itself, and a folder outside the data dir.
  await assert.rejects(removeWorktree(repo, repo), /refusing/);
  await assert.rejects(addWorktree(repo, path.join(tmp, 'outside'), sha), /refusing/);
  assert.equal(fs.existsSync(path.join(repo, 'f.txt')), true, 'the repo is untouched');
});

test('vault: appendDaily appends one line with newlines around it', () => {
  appendDaily('- one', { date: '2026-01-02' });
  const f = path.join(tmp, 'vault', 'Daily', '2026-01-02.md');
  fs.appendFileSync(f, 'no newline');
  appendDaily('- two', { date: '2026-01-02' });
  assert.equal(fs.readFileSync(f, 'utf8'), '- one\nno newline\n- two\n');
  assert.match(todayStr(new Date(2026, 9, 2)), /^2026-10-02$/);
});

test('build-hash: a change under lib/ changes the gateway hash', () => {
  const root = path.join(tmp, 'deckroot');
  fs.mkdirSync(path.join(root, 'lib', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server.js'), 's');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(root, 'lib', 'x', 'a.mjs'), 'export const a = 1;');
  const h1 = codeHash(root);
  fs.writeFileSync(path.join(root, 'lib', 'x', 'a.mjs'), 'export const a = 2;');
  assert.notEqual(codeHash(root), h1);
  setDeckRoot(root);
});

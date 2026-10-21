import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-guard-')));
process.env.DECK_DATA = path.join(tmp, 'data');
process.env.DECK_VAULT = path.join(tmp, 'vault');
const meters = await import('../../lib/guard/meters.mjs');
const { findOrphans, killOrphan, orphanKind } = await import('../../lib/guard/orphans.mjs');
const { scan, clean, assertSafe, defaultRoots } = await import('../../lib/guard/cleanup.mjs');
const { benchVerdict } = await import('../../lib/guard/index.mjs');
const { pidAlive, listProcesses } = await import('../../lib/core/proc.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const GB = 1024 ** 3;
const T = meters.DEFAULTS;

test('meters: parse the real tools\' output formats', () => {
  assert.equal(meters.parseFreePct('The system has 8589934592 (2097152 pages with a page size of 4096).\n...\nSystem-wide memory free percentage: 39%\n'), 39);
  assert.deepEqual(meters.parseSwap('vm.swapusage: total = 3072.00M  used = 2663.56M  free = 408.44M  (encrypted)'),
    { totalBytes: 3072 * 1024 * 1024, usedBytes: 2663.56 * 1024 * 1024 });
  assert.deepEqual(meters.parseDf('Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s5 239362496 203000000 10485760 96% 2.2M 104M 2% /System/Volumes/Data\n'),
    { totalBytes: 239362496 * 1024, freeBytes: 10485760 * 1024 });
});

test('meters: thresholds turn each meter yellow or red', () => {
  const base = { freePct: 40, memBytes: 8 * GB, swap: { totalBytes: 4 * GB, usedBytes: 1 * GB }, disk: { totalBytes: 228 * GB, freeBytes: 20 * GB }, procs: [] };
  assert.equal(meters.build(base, T).level, 'ok');
  assert.equal(meters.build({ ...base, disk: { totalBytes: 1, freeBytes: 4.9 * GB } }, T).disk.level, 'warn');
  assert.equal(meters.build({ ...base, disk: { totalBytes: 1, freeBytes: 1.9 * GB } }, T).disk.level, 'bad');
  assert.equal(meters.build({ ...base, swap: { totalBytes: 4 * GB, usedBytes: 2.1 * GB } }, T).swap.level, 'warn');
  assert.equal(meters.build({ ...base, freePct: 18 }, T).ram.level, 'warn'); // 1.44 GB of 8
  assert.equal(meters.build({ ...base, freePct: 9 }, T).ram.level, 'bad');   // 0.72 GB
  const daemons = n => Array.from({ length: n }, (_, i) => ({ pid: 100 + i, rssBytes: 1, cmd: '/opt/j/bin/java -Xmx1g org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.1' }));
  assert.equal(meters.build({ ...base, procs: daemons(2) }, T).gradleLevel, 'ok');
  const three = meters.build({ ...base, procs: daemons(3) }, T);
  assert.equal(three.gradleLevel, 'warn');
  assert.equal(three.level, 'warn');
});

test('meters: java processes are classified, including paths with spaces', () => {
  const c = meters.classifyJava;
  assert.equal(c('/Library/Java/jdk/bin/java -cp x org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.1'), 'gradle-daemon');
  assert.equal(c('/opt/homebrew/opt/openjdk@25/bin/java -Dfabric.dli.env=server -Dfabric.dli.main=net.fabricmc.loader.impl.launch.knot.KnotServer net.fabricmc.devlaunchinjector.Main nogui'), 'mc-server');
  assert.equal(c('/opt/j/bin/java -Dfabric.dli.env=client net.fabricmc.devlaunchinjector.Main'), 'mc-client');
  assert.equal(c('/Users/z/Library/Application Support/minecraft/runtime/java-runtime-delta/bin/java -Xmx2G net.minecraft.client.main.Main'), 'mc-client');
  assert.equal(c('/opt/j/bin/java -jar something.jar'), 'other');
  assert.equal(c('node x.js /usr/bin/java'), null);
  assert.equal(c('/usr/local/bin/node /tmp/bin/java'), null);
  assert.equal(c('/usr/bin/javac -version'), null);
});

test('bench verdict: refuses on low memory or another Minecraft running', () => {
  const s = (freeBytes, java = []) => ({ ram: { freeBytes }, java });
  assert.equal(benchVerdict(s(3 * GB), T).ok, true);
  assert.match(benchVerdict(s(1.2 * GB), T).reason, /memory free/);
  assert.match(benchVerdict(s(3 * GB, [{ pid: 7, kind: 'mc-server' }]), T).reason, /server is running \(pid 7\)/);
  assert.match(benchVerdict(s(3 * GB, [{ pid: 8, kind: 'mc-client' }]), T).reason, /client/);
  assert.equal(benchVerdict(s(3 * GB, [{ pid: 9, kind: 'gradle-daemon' }]), T).ok, true);
});

test('orphans: only parent-1 dev processes of this user, never this process', async () => {
  const me = process.getuid();
  const home = os.homedir();
  const procs = [
    { pid: 10, ppid: 1, uid: me, rssBytes: 5, startedAt: 1, cmd: '/opt/j/bin/java org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.1' },
    { pid: 11, ppid: 1, uid: me, rssBytes: 9, startedAt: 1, cmd: `/usr/local/bin/node ${home}/yt/some-tool/server.js` },
    { pid: 12, ppid: 1, uid: me, rssBytes: 1, startedAt: 1, cmd: `${home}/yt/perdix/build/mac-release/app/perdix --frames 10` },
    { pid: 13, ppid: 1, uid: me, rssBytes: 1, startedAt: 1, cmd: '/opt/homebrew/bin/ffmpeg -i a.mp4 b.mp4' },
    { pid: 14, ppid: 1, uid: me, rssBytes: 1, startedAt: 1, cmd: '/x/chrome-headless-shell --headless' },
    { pid: 20, ppid: 99, uid: me, rssBytes: 1, startedAt: 1, cmd: '/opt/homebrew/bin/ffmpeg -i x' },          // has a parent
    { pid: 21, ppid: 1, uid: 0, rssBytes: 1, startedAt: 1, cmd: '/opt/homebrew/bin/ffmpeg -i x' },           // root's
    { pid: 22, ppid: 1, uid: me, rssBytes: 1, startedAt: 1, cmd: '/usr/local/bin/node /opt/other/app.js' },   // not from a project folder
    { pid: 23, ppid: 1, uid: me, rssBytes: 1, startedAt: 1, cmd: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { pid: 30, ppid: 1, uid: me, rssBytes: 1, startedAt: 1, cmd: `/usr/local/bin/node ${home}/yt/deck/server.js` }, // self
  ];
  const got = await findOrphans({ procs, uid: me, self: 30 });
  assert.deepEqual(got.map(o => `${o.pid}:${o.kind}`).sort(), ['10:gradle-daemon', '11:node', '12:perdix', '13:ffmpeg', '14:remotion-chrome']);
  assert.equal(orphanKind('/bin/bash -c sleep 5'), null);
});

test('orphans: a real orphan is killed, a reused pid is refused', async () => {
  // A disposable orphan named ffmpeg: a background `sleep` whose argv[0] is
  // ffmpeg, left behind when its bash exits.
  const r = spawnSync('bash', ['-c', '(exec -a ffmpeg sleep 120) > /dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
  const pid = Number(r.stdout.trim());
  await new Promise(res => setTimeout(res, 300));
  const mine = (await findOrphans()).find(o => o.pid === pid);
  assert.ok(mine, 'the sleep is listed as an ffmpeg orphan');
  assert.equal(mine.kind, 'ffmpeg');
  const refused = await killOrphan(pid, mine.startedAt - 5000);
  assert.equal(refused.ok, false, 'a different start time is a different process');
  assert.ok(pidAlive(pid));
  const ok = await killOrphan(pid, mine.startedAt);
  assert.equal(ok.ok, true);
  await new Promise(res => setTimeout(res, 300));
  assert.equal(pidAlive(pid), false);
  assert.equal((await killOrphan(pid, mine.startedAt)).ok, false, 'gone now');
});

// A world of things to clean, all under tmp.
function world() {
  const w = path.join(tmp, 'w' + Math.random().toString(36).slice(2, 7));
  const repo = path.join(w, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\n.gradle/\n/target/\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'source');
  // A tracked folder that happens to be called build: never offered.
  fs.mkdirSync(path.join(repo, 'docs', 'build'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'build', 'keep.md'), 'tracked');
  g('add', '.gitignore', 'src/a.txt', '-f', 'docs/build/keep.md'); g('commit', '-qm', 'one');
  const put = (rel, bytes = 4096) => { const f = path.join(repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(bytes)); };
  put('build/mac-debug/CMakeCache.txt'); put('build/mac-debug/app.o', 50000);
  put('build/mac-release/CMakeCache.txt'); put('build/mac-release/app.o', 80000);
  put('game/build/libs/x.jar', 30000);
  put('tool/build/out.bin', 2000);
  put('.gradle/caches/x', 2000);
  put('target/CACHEDIR.TAG', 100); put('target/debug/a.rlib', 9000);
  const tmpd = path.join(w, 'T');
  fs.mkdirSync(path.join(tmpd, 'remotion-webpack-bundle-abc'), { recursive: true });
  fs.writeFileSync(path.join(tmpd, 'remotion-webpack-bundle-abc', 'x'), Buffer.alloc(10000));
  fs.mkdirSync(path.join(tmpd, 'react-motion-renderQ2OFBs'));
  fs.writeFileSync(path.join(tmpd, 'react-motion-renderQ2OFBs', 'element-0000.jpeg'), Buffer.alloc(20000));
  fs.mkdirSync(path.join(tmpd, 'unrelated'));
  const ct = path.join(w, 'code-typer');
  const tts = path.join(ct, 'public', 'gen', 'tts-cache');
  fs.mkdirSync(tts, { recursive: true });
  fs.writeFileSync(path.join(tts, 'old.wav'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(tts, 'new.wav'), Buffer.alloc(1000));
  const old = (Date.now() - 9 * 86400e3) / 1000;
  fs.utimesSync(path.join(tts, 'old.wav'), old, old);
  fs.writeFileSync(path.join(ct, 'public', 'gen', 'ep-voice.edit.wav'), Buffer.alloc(1000)); // a hand edit
  fs.utimesSync(path.join(ct, 'public', 'gen', 'ep-voice.edit.wav'), old, old);
  const deck = path.join(w, 'deck');
  fs.mkdirSync(deck);
  fs.writeFileSync(path.join(deck, '.18ddbfa5bfefeea8-00000000.bun-build'), Buffer.alloc(5000));
  fs.writeFileSync(path.join(deck, '.notes.bun-build'), 'not a leftover');
  const gc = path.join(w, 'gradle-caches');
  fs.mkdirSync(gc);
  fs.writeFileSync(path.join(gc, 'jar'), Buffer.alloc(3000));
  return { w, repo, roots: { repos: [repo], tmpdir: tmpd, codeTyper: ct, deck, gradleCaches: gc, data: process.env.DECK_DATA, now: Date.now() } };
}

const labels = s => s.targets.map(t => t.label).sort();

test('cleanup scan: offers only generated things, with sizes and what rebuilds them', async () => {
  const { roots, repo } = world();
  const s = await scan(roots, { procs: [] });
  const name = path.basename(repo);
  assert.deepEqual(labels(s), [
    `${name} build/mac-debug`, `${name} build/mac-release`, `${name}/.gradle`, `${name}: 2 build folders`, `${name}/target`,
    'Bun compile leftovers in the Deck checkout (1)', 'Code Typer voice cache older than 7 days (1 files)',
    'Gradle caches (deep clean)', 'Remotion render leftovers (2)',
  ].sort());
  const rel = s.targets.find(t => t.label.endsWith('mac-release'));
  assert.match(rel.rebuilds, /cmake --preset mac-release/);
  assert.ok(rel.bytes >= 80000);
  assert.equal(s.targets.find(t => t.kind === 'gradle-caches').deep, true);
  assert.ok(!JSON.stringify(s).includes('docs/build'), 'a tracked build folder is never offered');
  assert.ok(!JSON.stringify(s).includes('voice.edit'), 'hand-made voice edits are never offered');
  assert.ok(!JSON.stringify(s).includes('unrelated'));
});

test('cleanup scan: a folder in use by a running process is left out', async () => {
  const { roots, repo } = world();
  const procs = [{ pid: 5, cmd: `${repo}/build/mac-release/app/perdix --frames 5` }];
  const s = await scan(roots, { procs });
  assert.ok(!labels(s).some(l => l.endsWith('mac-release')));
  assert.ok(labels(s).some(l => l.endsWith('mac-debug')));
  const busy = await scan(roots, { procs: [{ pid: 6, cmd: '/opt/j/bin/java org.gradle.launcher.daemon.bootstrap.GradleDaemon' }] });
  assert.ok(!labels(busy).some(l => l.includes('Gradle caches')), 'no deep clean while Gradle runs');
});

test('cleanup: removes what was chosen and nothing else; deep needs deep', async () => {
  const { roots, repo } = world();
  const s = await scan(roots, { procs: [] });
  const pick = s.targets.filter(t => !t.deep).map(t => t.id);
  const deepId = s.targets.find(t => t.deep).id;
  const r = await clean([...pick, deepId], { roots, procs: [] });
  assert.equal(r.removed.length, pick.length);
  assert.ok(r.errors.some(e => e.id === deepId && /deep/.test(e.error)));
  assert.ok(fs.existsSync(roots.gradleCaches), 'deep target kept without deep: true');
  assert.ok(!fs.existsSync(path.join(repo, 'build', 'mac-release')));
  assert.ok(!fs.existsSync(path.join(roots.tmpdir, 'remotion-webpack-bundle-abc')));
  assert.ok(!fs.existsSync(path.join(roots.tmpdir, 'react-motion-renderQ2OFBs')));
  assert.ok(fs.existsSync(path.join(roots.tmpdir, 'unrelated')));
  assert.ok(fs.existsSync(path.join(repo, 'src', 'a.txt')), 'source untouched');
  assert.ok(fs.existsSync(path.join(repo, 'docs', 'build', 'keep.md')), 'tracked build folder untouched');
  assert.ok(fs.existsSync(path.join(roots.codeTyper, 'public', 'gen', 'tts-cache', 'new.wav')), 'recent cache kept');
  assert.ok(fs.existsSync(path.join(roots.codeTyper, 'public', 'gen', 'ep-voice.edit.wav')), 'voice edit kept');
  assert.ok(fs.existsSync(path.join(roots.deck, '.notes.bun-build')));
  assert.ok(r.freedBytes > 150000);
  const r2 = await clean([deepId], { roots, procs: [], deep: true });
  assert.deepEqual(r2.removed, [deepId]);
  assert.ok(!fs.existsSync(roots.gradleCaches));
});

test('cleanup: a folder that stopped being generated between scan and clean is refused', async () => {
  const { roots, repo } = world();
  const s = await scan(roots, { procs: [] });
  const t = s.targets.find(t => t.label.endsWith('2 build folders'));
  // Someone starts tracking a file in it after the drawer was opened.
  spawnSync('git', ['add', '-f', 'game/build/libs/x.jar'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'track'], { cwd: repo });
  const r = await clean([t.id], { roots, procs: [] });
  assert.deepEqual(r.removed, []);
  assert.ok(fs.existsSync(path.join(repo, 'game', 'build', 'libs', 'x.jar')));
  assert.ok(fs.existsSync(path.join(repo, 'tool', 'build', 'out.bin')), 'nothing of the old group is touched');
});

test('cleanup rules: every kind refuses paths outside its own rule', async () => {
  const { roots, repo } = world();
  assert.match(await assertSafe({ kind: 'build' }, path.join(repo, 'src'), roots), /not a build folder/);
  assert.match(await assertSafe({ kind: 'build' }, path.join(repo, 'docs', 'build'), roots), /git does not ignore/);
  assert.match(await assertSafe({ kind: 'build' }, os.homedir(), roots), /not inside a known repo/);
  assert.match(await assertSafe({ kind: 'remotion' }, path.join(roots.tmpdir, 'unrelated'), roots), /not a Remotion/);
  assert.match(await assertSafe({ kind: 'tts-cache' }, path.join(roots.codeTyper, 'public', 'gen', 'ep-voice.edit.wav'), roots), /TTS cache/);
  assert.match(await assertSafe({ kind: 'bun' }, path.join(roots.deck, '.notes.bun-build'), roots), /bun/);
  assert.match(await assertSafe({ kind: 'gradle-caches' }, path.join(roots.gradleCaches, '..'), roots), /Gradle caches/);
  assert.match(await assertSafe({ kind: 'deck-worktree' }, repo, roots), /throwaway/);
  assert.match(await assertSafe({ kind: 'what' }, repo, roots), /unknown/);
});

test('defaultRoots: the vault is never a cleanup source', () => {
  const vault = process.env.DECK_VAULT;
  fs.mkdirSync(path.join(vault, '.git'), { recursive: true });
  const ctx = { getState: () => ({}), loadProjects: () => ({ coursework: { repos: [{ path: vault }] } }) };
  assert.ok(!defaultRoots(ctx).repos.includes(vault));
});

test('defaultRoots: the Code Typer voice cache is off unless guard.codeTyper names it', async () => {
  const off = defaultRoots({ getState: () => ({}), loadProjects: () => ({}) });
  assert.equal(off.codeTyper, null);
  const { roots } = world();
  const s = await scan({ ...roots, codeTyper: null }, { procs: [] });
  assert.ok(!labels(s).some(l => /voice cache/.test(l)), 'no TTS target without the setting');
  assert.match(await assertSafe({ kind: 'tts-cache' }, path.join(roots.codeTyper, 'public', 'gen', 'tts-cache', 'old.wav'), { ...roots, codeTyper: null }), /no TTS cache configured/);
  const on = defaultRoots({ getState: () => ({ guard: { codeTyper: '~/somewhere/code-typer' } }), loadProjects: () => ({}) });
  assert.equal(on.codeTyper, path.join(os.homedir(), 'somewhere', 'code-typer'));
});

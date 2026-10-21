// Rules added after the independent review of the guard (round 1).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-guard2-')));
process.env.DECK_DATA = path.join(tmp, 'data');
process.env.DECK_VAULT = path.join(tmp, 'vault');
const { scan, clean, assertSafe, forbiddenRoot, activeBuild, nestedRepos } = await import('../../lib/guard/cleanup.mjs');
const meters = await import('../../lib/guard/meters.mjs');
const { benchVerdict } = await import('../../lib/guard/index.mjs');
const { killOrphan } = await import('../../lib/guard/orphans.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const g = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
const put = (f, bytes = 2048) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(bytes)); };
function repoWith(ignores) {
  const repo = path.join(tmp, 'r' + Math.random().toString(36).slice(2, 7));
  fs.mkdirSync(repo);
  g(repo, 'init', '-q'); g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, '.gitignore'), ignores.join('\n') + '\n');
  g(repo, 'add', '.gitignore'); g(repo, 'commit', '-qm', 'one');
  return repo;
}
function nestedClone(at) {
  fs.mkdirSync(at, { recursive: true });
  g(at, 'init', '-q'); g(at, 'config', 'user.email', 't@t'); g(at, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(at, 'dep.c'), 'int dep;\n');
  g(at, 'add', 'dep.c'); g(at, 'commit', '-qm', 'dep');
}
const rootsFor = repo => ({ repos: [repo], tmpdir: path.join(tmp, 'T'), codeTyper: path.join(tmp, 'ct'), deck: path.join(tmp, 'deck'), gradleCaches: path.join(tmp, 'gc'), data: process.env.DECK_DATA, now: Date.now() });
const labels = s => s.targets.map(t => t.label);

test('a CMake preset whose FetchContent checkout has local changes is never offered; a clean one is, saying deps download again', async () => {
  const repo = repoWith(['build/']);
  put(path.join(repo, 'build/dbg/CMakeCache.txt'));
  nestedClone(path.join(repo, 'build/dbg/_deps/glm-src'));
  let s = await scan(rootsFor(repo), { procs: [] });
  const t = s.targets.find(x => x.label.endsWith('build/dbg'));
  assert.ok(t, labels(s).join(', '));
  assert.match(t.rebuilds, /FetchContent dependencies download again/);
  fs.writeFileSync(path.join(repo, 'build/dbg/_deps/glm-src/dep.c'), 'int dep = 1; // a local fix\n');
  s = await scan(rootsFor(repo), { procs: [] });
  assert.ok(!labels(s).some(l => l.endsWith('build/dbg')), 'the edited checkout keeps its folder');
  assert.match(await assertSafe({ kind: 'build' }, path.join(repo, 'build/dbg'), rootsFor(repo)), /local changes: .*glm-src/);
  assert.equal((await nestedRepos(path.join(repo, 'build/dbg'))).repos.length, 1);
  // The same change, made by the repo's own patch step, is build output.
  fs.mkdirSync(path.join(repo, 'cmake'));
  fs.writeFileSync(path.join(repo, 'cmake', 'PatchGlm.cmake'), '# re-applies our fix to glm after every fetch\n');
  g(repo, 'add', 'cmake/PatchGlm.cmake'); g(repo, 'commit', '-qm', 'patch step');
  s = await scan(rootsFor(repo), { procs: [] });
  assert.ok(labels(s).some(l => l.endsWith('build/dbg')), 'a declared patch makes the checkout rebuildable');
});

test('a build folder that belongs to a repo nested in the card repo is never offered', async () => {
  const repo = repoWith(['tools/']);
  const inner = path.join(repo, 'tools');
  nestedClone(inner);
  put(path.join(inner, 'build/release.sh'), 100);
  g(inner, 'add', '-f', 'build/release.sh'); g(inner, 'commit', '-qm', 'tracked by the nested repo');
  const s = await scan(rootsFor(repo), { procs: [] });
  assert.ok(!labels(s).some(l => l.includes('tools')), labels(s).join(', '));
  assert.match(await assertSafe({ kind: 'build' }, path.join(inner, 'build'), rootsFor(repo)), /another repo/);
});

test('while a build runs nothing under build folders is offered, and a build starting before the delete stops it', async () => {
  const repo = repoWith(['build/']);
  put(path.join(repo, 'game/build/x.jar'));
  const gradle = { pid: 9, cmd: '/opt/j/bin/java -cp gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain build' };
  const idle = { pid: 8, cmd: '/opt/j/bin/java org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.1' };
  assert.equal((await scan(rootsFor(repo), { procs: [gradle] })).targets.length, 0);
  assert.ok(activeBuild([{ cmd: '/opt/homebrew/bin/ninja -j 3' }]));
  assert.ok(activeBuild([{ cmd: '/Users/z/.cargo/bin/cargo build --release' }]));
  assert.equal(activeBuild([idle]), null, 'an idle daemon writes nothing');
  const s = await scan(rootsFor(repo), { procs: [idle] });
  assert.equal(s.targets.length, 1);
  const r = await clean([s.targets[0].id], { roots: rootsFor(repo), procs: [idle], procsNow: [idle, gradle] });
  assert.deepEqual(r.removed, []);
  assert.match(r.errors[0].error, /skipped: .*GradleWrapperMain/);
  assert.ok(fs.existsSync(path.join(repo, 'game/build/x.jar')));
});

test('roots: never the home folder, its parents, /, the vault or a folder holding it; never a tool home', async () => {
  const home = os.homedir();
  assert.equal(forbiddenRoot(home), true);
  assert.equal(forbiddenRoot(path.dirname(home)), true);
  assert.equal(forbiddenRoot('/'), true);
  fs.mkdirSync(path.join(tmp, 'vault', 'Daily'), { recursive: true });
  assert.equal(forbiddenRoot(path.join(tmp, 'vault')), true);
  assert.equal(forbiddenRoot(tmp), true, 'a folder holding the vault');
  assert.equal(forbiddenRoot(path.join(tmp, 'vault', 'Daily')), true);
  assert.equal(forbiddenRoot(path.join(home, 'yt', 'perdix')), false);
  if (fs.existsSync(path.join(home, '.gradle'))) {
    assert.match(await assertSafe({ kind: 'build' }, path.join(home, '.gradle'), { repos: [home] }), /tool home/);
  }
});

test('the rules the first review found untested: render running, dot folders', async () => {
  const repo = repoWith(['build/', '.cache/']);
  put(path.join(repo, '.cache/build/x'));
  const roots = rootsFor(repo);
  fs.mkdirSync(path.join(roots.tmpdir, 'react-motion-renderAB'), { recursive: true });
  put(path.join(roots.tmpdir, 'react-motion-renderAB', 'f.jpeg'));
  let s = await scan(roots, { procs: [] });
  assert.ok(!labels(s).some(l => l.includes('.cache')), 'a build folder under a dot folder is not offered');
  assert.ok(labels(s).some(l => l.startsWith('Remotion')));
  s = await scan(roots, { procs: [{ pid: 3, cmd: '/x/chrome-headless-shell --headless remotion' }] });
  assert.ok(!labels(s).some(l => l.startsWith('Remotion')), 'not while a render runs');
});

test('meters: what could not be read warns, and no bench starts without a memory reading', () => {
  const t = meters.DEFAULTS;
  const s = meters.build({ freePct: null, memBytes: 8 * 1024 ** 3, swap: null, disk: meters.parseDf('garbage'), procs: [] }, t);
  assert.equal(s.ram.level, 'warn'); assert.equal(s.swap.level, 'warn'); assert.equal(s.disk.level, 'warn');
  assert.equal(s.level, 'warn');
  assert.deepEqual(meters.parseDf('Filesystem 1024-blocks Used Available\n/dev/x abc def ghi\n') && meters.build({ freePct: 40, memBytes: 8e9, swap: { totalBytes: 1, usedBytes: 0 }, disk: meters.parseDf('h\n/dev/x abc def ghi\n'), procs: [] }, t).disk.level, 'warn');
  assert.match(benchVerdict(s, t).reason, /could not be read/);
});

test('orphans: a kill without the start time is refused', async () => {
  const r = await killOrphan(process.pid, undefined, { procs: [], uid: process.getuid(), self: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /start time is required/);
});

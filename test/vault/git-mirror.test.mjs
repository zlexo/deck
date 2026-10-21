import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, sh, write, key, log, staged, remoteHead, otherMac, adopted } from './git-fixture.mjs';

const { QUIET_MS } = await import('../../lib/vault/git.mjs');
let m = 0;
// Claude Code's memory folder, as the mirror's source.
function memory(files = { 'MEMORY.md': '- [a](a.md)\n', 'a.md': 'a\n' }) {
  const dir = path.join(tmp, `memory${++m}`);
  for (const [f, t] of Object.entries(files)) write(dir, f, t);
  return dir;
}
const mirrored = (extra = {}) => { const mem = memory(); return { mem, ...adopted({ vault: { memoryMirror: mem }, ...extra }) }; };

test('push mode and the mirror: only Memory/ is committed, another session\'s note is left alone, nothing is merged', async () => {
  const s = mirrored();
  write(s.dir, 'Projects/p.md', 'p, edited in another session\n');
  sh(s.dir, 'add', 'Projects/p.md');
  write(s.dir, 'Daily/today.md', 'untracked\n');
  await s.vg.tick();
  s.clock.t = QUIET_MS; await s.vg.tick();
  assert.deepEqual(log(s.dir), ['Memory: 2 files', 'mine']);
  assert.equal(sh(s.dir, 'log', '-1', '--format=%an <%ae>'), 'Me <me@example.com>', 'the user\'s identity when there is one');
  assert.deepEqual(sh(s.dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['Memory/MEMORY.md', 'Memory/a.md']);
  assert.equal(staged(s.dir), 'Projects/p.md', 'still staged, not committed');
  assert.equal(fs.readFileSync(path.join(s.dir, 'Daily/today.md'), 'utf8'), 'untracked\n');
  assert.equal(remoteHead(s.bare), sh(s.dir, 'rev-parse', 'HEAD'));
  await s.vg.commitNow();
  assert.equal(log(s.dir).length, 2, 'push mode commits nothing else');

  fs.rmSync(path.join(s.mem, 'a.md'));
  s.clock.t += QUIET_MS; await s.vg.tick();
  s.clock.t += QUIET_MS; await s.vg.tick();
  assert.equal(log(s.dir)[0], 'Memory: 1 file');
  assert.ok(!fs.existsSync(path.join(s.dir, 'Memory/a.md')), 'a deletion is mirrored');
  fs.rmSync(s.mem, { recursive: true });
  await s.vg.pushNow();
  assert.ok(fs.existsSync(path.join(s.dir, 'Memory/MEMORY.md')), 'a missing source deletes nothing');
  assert.match((await s.vg.status()).error, /memory folder .* is missing; Memory\/ is left as it is/);

  otherMac(s, 'Projects/q.md', 'q\n');
  write(s.mem, 'MEMORY.md', 'changed\n');
  await s.vg.pushNow();
  assert.match((await s.vg.status()).error, /origin has 1 commit this Mac does not; mode push never merges/);
  assert.equal(sh(s.dir, 'rev-list', '--merges', '--count', 'main'), '0', 'no merge');
  assert.ok(!fs.existsSync(path.join(s.dir, 'Projects/q.md')));
});

test('mirror: a hand-added or hand-edited Memory/ file is never overwritten or deleted', async () => {
  const s = mirrored();
  await s.vg.pushNow();
  assert.equal(log(s.dir)[0], 'Memory: 2 files');
  write(s.dir, 'Memory/mine.md', 'written by hand\n');
  write(s.mem, 'a.md', 'a, newer\n');
  await s.vg.pushNow();
  assert.match((await s.vg.status()).error, /Memory\/ has changes Deck did not make \(1 file\); nothing mirrored/);
  assert.equal(fs.readFileSync(path.join(s.dir, 'Memory/mine.md'), 'utf8'), 'written by hand\n');
  assert.equal(fs.readFileSync(path.join(s.dir, 'Memory/a.md'), 'utf8'), 'a\n', 'nothing copied either');
  fs.rmSync(path.join(s.dir, 'Memory/mine.md'));
  write(s.dir, 'Memory/MEMORY.md', 'edited by hand\n');
  await s.vg.pushNow();
  assert.match((await s.vg.status()).error, /Deck did not make \(1 file\)/);
  assert.equal(fs.readFileSync(path.join(s.dir, 'Memory/MEMORY.md'), 'utf8'), 'edited by hand\n');
  assert.equal(log(s.dir).length, 2);
});

test('mirror: a symlinked Memory/ is refused and its target left alone', async () => {
  const s = mirrored();
  const outside = path.join(tmp, 'outside');
  write(outside, 'x.md', 'x\n');
  fs.symlinkSync(outside, path.join(s.dir, 'Memory'));
  await s.vg.pushNow();
  assert.match((await s.vg.status()).error, /Memory\/ is a symlink or a file; nothing mirrored/);
  assert.deepEqual(fs.readdirSync(outside), ['x.md']);
  assert.deepEqual(log(s.dir), ['mine']);
});

test('mirror: a source file with a key is never copied; the rest is committed and nothing is left staged', async () => {
  const mem = memory({ 'a.md': 'a\n', 'b.md': `${key('Anthropic key')}\n` });
  const s = adopted({ vault: { memoryMirror: mem } });
  await s.vg.pushNow();
  const st = await s.vg.status();
  assert.deepEqual(sh(s.dir, 'show', '--name-only', '--format=%s', 'HEAD').split('\n').filter(Boolean), ['Memory: 1 file', 'Memory/a.md']);
  assert.ok(!fs.existsSync(path.join(s.dir, 'Memory/b.md')));
  assert.deepEqual(st.secrets, [{ file: 'Memory/b.md', line: 1, kind: 'Anthropic key' }]);
  assert.equal(staged(s.dir), '');
  assert.equal(sh(s.dir, 'status', '--porcelain'), '');
});

test('mirror: a commit stopped half way (quit) leaves nothing staged', async () => {
  let armed = true;
  const s = mirrored({ hook: async (step, abort) => { if (armed && step === 'staged') { armed = false; abort(); } } });
  await s.vg.pushNow();
  assert.equal(staged(s.dir), '');
  assert.deepEqual(log(s.dir), ['mine']);
  assert.match((await s.vg.status()).error, /gave up: Deck quit first/);
});

test('mirror: refused while Claude Code writes its auto memory straight into the vault', async () => {
  const s = mirrored();
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  write(process.env.CLAUDE_CONFIG_DIR, 'settings.json', JSON.stringify({ autoMemoryDirectory: path.join(s.dir, 'Memory') }));
  try {
    await s.vg.pushNow();
    assert.match((await s.vg.status()).error, /live memory, nothing mirrored/);
    assert.ok(!fs.existsSync(path.join(s.dir, 'Memory')));
  } finally { fs.rmSync(settings); }
});

test('mirror: a file git ignores in Memory/ is never deleted or overwritten', async () => {
  const s = mirrored();
  write(s.dir, '.gitignore', '*.draft\n');
  sh(s.dir, 'add', '.gitignore');
  sh(s.dir, 'commit', '-q', '-m', 'ignore drafts');
  write(s.dir, 'Memory/notes.draft', 'mine\n');
  await s.vg.pushNow();
  assert.match((await s.vg.status()).error, /git ignores that the mirror would change \(notes\.draft\)/);
  assert.equal(fs.readFileSync(path.join(s.dir, 'Memory/notes.draft'), 'utf8'), 'mine\n');
  assert.ok(!fs.existsSync(path.join(s.dir, 'Memory/a.md')), 'nothing mirrored');
});

test('mirror: a source file named "*.md" never pulls a held file into the commit', async () => {
  const mem = memory({ 'k.md': 'clean\n' });
  const s = adopted({ vault: { memoryMirror: mem } });
  await s.vg.pushNow();
  write(mem, 'k.md', `${key('Anthropic key')}\n`);
  write(mem, '*.md', 'star\n');
  write(s.dir, 'Memory/k.md', `${key('Anthropic key')}\n`); // what a cut pass leaves: equal to its source
  await s.vg.pushNow();
  assert.deepEqual(sh(s.dir, 'show', '--name-only', '--format=%s', 'HEAD').split('\n').filter(Boolean), ['Memory: 1 file', 'Memory/*.md']);
  assert.equal(sh(s.dir, 'show', 'HEAD:Memory/k.md'), 'clean', 'the held file was not committed');
  assert.deepEqual((await s.vg.status()).secrets.map(h => h.file), ['Memory/k.md']);
  assert.equal(staged(s.dir), '');
});

test('mirror: another session\'s lock between add and reset does not stop pushing; the leftover commits later', async () => {
  let s, armed = true;
  s = mirrored({ hook: async step => { if (armed && step === 'staged') { armed = false; fs.writeFileSync(path.join(s.dir, '.git', 'index.lock'), ''); } } });
  await s.vg.tick();
  s.clock.t = QUIET_MS; await s.vg.tick();
  const st = await s.vg.status();
  assert.match(st.error, /could not unstage Memory .*tried again next pass/);
  assert.equal(st.blocked, false);
  fs.rmSync(path.join(s.dir, '.git', 'index.lock'));
  s.clock.t = 2 * QUIET_MS; await s.vg.tick();
  s.clock.t = 3 * QUIET_MS; await s.vg.tick();
  assert.equal(log(s.dir)[0], 'Memory: 2 files');
  assert.equal(remoteHead(s.bare), sh(s.dir, 'rev-parse', 'HEAD'), 'pushed by the timer');
  assert.equal((await s.vg.status()).error, null);
});

test('mirror: a pass with nothing to commit clears the last Memory error', async () => {
  let s, armed = true;
  s = mirrored({ hook: async step => { if (armed && step === 'staged') { armed = false; fs.writeFileSync(path.join(s.dir, '.git', 'index.lock'), ''); } } });
  await s.vg.pushNow();
  assert.match((await s.vg.status()).error, /could not unstage/);
  fs.rmSync(path.join(s.dir, '.git', 'index.lock'));
  sh(s.dir, 'commit', '-q', '-m', 'Memory, by hand'); // another session commits the leftover
  await s.vg.pushNow();
  assert.equal((await s.vg.status()).error, null);
});

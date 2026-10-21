import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, MIN, sh, write, key, log, staged, remoteHead, setup, created, otherMac, adopted, handCommit } from './git-fixture.mjs';

const { QUIET_MS } = await import('../../lib/vault/git.mjs');
const originMain = dir => { try { return sh(dir, 'rev-parse', 'refs/remotes/origin/main'); } catch { return null; } };

test('rejected push: a clean tree merges in a tick and pushes, never a rebase', async () => {
  const s = setup();
  await created(s);
  await s.vg.pushNow();
  otherMac(s, 'Projects/theirs.md', 'theirs\n');
  write(s.dir, 'Projects/mine.md', 'mine\n');
  await s.vg.tick();
  s.clock.t = QUIET_MS; await s.vg.tick();
  assert.equal(remoteHead(s.bare), sh(s.dir, 'rev-parse', 'HEAD'), 'merged, then pushed');
  assert.equal(sh(s.dir, 'rev-list', '--parents', '-1', 'HEAD').split(' ').length, 3, 'a merge commit');
  assert.equal(sh(s.dir, 'log', '-1', '--format=%s', 'HEAD^1'), 'Vault: 1 note', 'my commit kept as it was');
  assert.ok(fs.existsSync(path.join(s.dir, 'Projects/theirs.md')));
});

test('rejected push: a conflict is found in memory, the tree is never touched, and pushing stops', async () => {
  const s = setup();
  await created(s);
  await s.vg.pushNow();
  otherMac(s, 'Boards/Work.md', '# Work\n\n## Backlog\n- [ ] theirs\n');
  write(s.dir, 'Boards/Work.md', '# Work\n\n## Backlog\n- [ ] mine\n');
  await s.vg.commitNow();
  const head = sh(s.dir, 'rev-parse', 'HEAD');
  const st = await s.vg.status();
  assert.deepEqual(st.conflicts, ['Boards/Work.md']);
  assert.match(st.error, /pushing stopped: origin\/main conflicts with this Mac in Boards\/Work\.md/);
  assert.equal(st.pending, 0, 'no conflict markers');
  assert.equal(fs.readFileSync(path.join(s.dir, 'Boards/Work.md'), 'utf8'), '# Work\n\n## Backlog\n- [ ] mine\n');
  assert.ok(!fs.existsSync(path.join(s.dir, '.git', 'MERGE_HEAD')));
  assert.equal(sh(s.dir, 'rev-parse', 'HEAD'), head);
  const asked = s.calls.length;
  s.clock.t += 2 * QUIET_MS; await s.vg.tick();
  assert.equal(s.calls.length, asked, 'pushing stopped until Push is pressed');

  const d = setup();
  await created(d);
  await d.vg.pushNow();
  otherMac(d, 'Projects/theirs.md', 'theirs\n');
  write(d.dir, 'Projects/mine.md', 'mine\n');
  handCommit(d.dir);
  write(d.dir, 'Daily/new.md', 'still open\n');
  await d.vg.pushNow();
  assert.match((await d.vg.status()).error, /merges them only on a clean tree/);
  assert.ok(!fs.existsSync(path.join(d.dir, 'Projects/theirs.md')), 'no merge on a dirty tree');
});

test('quit never fetches or merges: a rejected push waits for the next start', async () => {
  const s = setup();
  await created(s);
  await s.vg.pushNow();
  const tracked = originMain(s.dir);
  otherMac(s, 'Projects/theirs.md', 'theirs\n');
  write(s.dir, 'Projects/mine.md', 'mine\n');
  await s.vg.quit();
  assert.match((await s.vg.status()).error, /origin has new commits; Deck merges at the next start/);
  assert.equal(log(s.dir)[0], 'Vault: 1 note', 'committed');
  assert.equal(sh(s.dir, 'rev-list', '--merges', '--count', 'main'), '0', 'not merged');
  assert.equal(originMain(s.dir), tracked, 'nothing fetched');
});

test('push mode pushes main only after it has been still for a quiet spell', async () => {
  const s = adopted();
  await s.vg.tick();
  write(s.dir, 'Projects/q.md', 'q\n');
  handCommit(s.dir, 'second');
  s.clock.t = 5 * MIN; await s.vg.tick();
  s.clock.t = 14 * MIN; await s.vg.tick();
  assert.equal(remoteHead(s.bare), null, 'main moved at minute 5');
  s.clock.t = 15 * MIN; await s.vg.tick();
  assert.equal(remoteHead(s.bare), sh(s.dir, 'rev-parse', 'HEAD'));
  assert.deepEqual(log(s.dir), ['second', 'mine'], 'push mode commits nothing');
});

test('a key in an unpushed commit stops the push; Push now scans again', async () => {
  const s = adopted();
  write(s.dir, 'Knowledge/k.md', `a\nb\n${key('AWS key id')}\n`);
  handCommit(s.dir, 'oops');
  const sha = sh(s.dir, 'rev-parse', '--short=7', 'HEAD');
  await s.vg.pushNow();
  assert.deepEqual(s.calls, [], 'GitHub not even asked');
  const st = await s.vg.status();
  assert.equal(remoteHead(s.bare), null);
  assert.equal(st.blocked, true);
  assert.match(st.error, new RegExp(`possible secret in an unpushed commit at Knowledge/k\\.md:3 \\(AWS key id\\) in ${sha}`));
  s.clock.t = 2 * QUIET_MS; await s.vg.tick();
  assert.equal(remoteHead(s.bare), null, 'the timer does not push past it');
  await s.vg.pushNow();
  assert.equal(remoteHead(s.bare), null, 'Push now scans again');
});

test('another process holding index.lock: an error in the status, nothing staged, the push still tried', async () => {
  const mem = path.join(tmp, 'lock-memory');
  write(mem, 'a.md', 'a\n');
  const s = adopted({ vault: { memoryMirror: mem } });
  const lock = path.join(s.dir, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  try {
    await s.vg.tick();
    s.clock.t = QUIET_MS; await s.vg.tick();
    const st = await s.vg.status();
    assert.match(st.error, /index\.lock/);
    assert.equal(staged(s.dir), '');
    assert.equal(remoteHead(s.bare), sh(s.dir, 'rev-parse', 'HEAD'), 'the push went ahead');
    assert.deepEqual(log(s.dir), ['mine']);
  } finally { fs.rmSync(lock); }
  s.clock.t = 2 * QUIET_MS; await s.vg.tick();
  s.clock.t = 3 * QUIET_MS; await s.vg.tick();
  assert.deepEqual(log(s.dir), ['Memory: 1 file', 'mine'], 'the copy left behind is what the mirror makes, so it commits next time');
});

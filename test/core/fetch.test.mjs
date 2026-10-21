import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-fetch-'));
process.env.DECK_DATA = path.join(tmp, 'data');
const { fetchPrHead, fetchRef, fetchSha, remoteSha } = await import('../../lib/core/git.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const g = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };

// origin (bare) with main and a PR head; a clone that has neither PR commit yet.
function world() {
  const src = path.join(tmp, 'src' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(src);
  g(src, 'init', '-q', '-b', 'main'); g(src, 'config', 'user.email', 't@t'); g(src, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(src, 'a'), '1'); g(src, 'add', 'a'); g(src, 'commit', '-qm', 'one');
  const origin = src + '.git';
  g(tmp, 'clone', '-q', '--bare', src, origin);
  const clone = src + '-clone';
  g(tmp, 'clone', '-q', origin, clone);
  fs.writeFileSync(path.join(src, 'a'), '2'); g(src, 'commit', '-qam', 'pr work');
  const prSha = g(src, 'rev-parse', 'HEAD');
  g(src, 'push', '-q', origin, `HEAD:refs/pull/7/head`);
  fs.writeFileSync(path.join(src, 'b'), '3'); g(src, 'add', 'b'); g(src, 'commit', '-qm', 'main moves');
  const mainSha = g(src, 'rev-parse', 'HEAD');
  g(src, 'push', '-q', origin, 'HEAD:refs/heads/main');
  return { clone, prSha, mainSha };
}

test('a PR head and a branch are fetched by SHA; FETCH_HEAD and refs stay as they were', async () => {
  const { clone, prSha, mainSha } = world();
  const fh = path.join(clone, '.git', 'FETCH_HEAD');
  fs.writeFileSync(fh, 'deadbeef\tsentinel written by another process\n');
  const refsBefore = g(clone, 'for-each-ref', '--format=%(refname) %(objectname)');
  assert.equal(await remoteSha(clone, 'refs/pull/7/head'), prSha);
  assert.equal(await fetchPrHead(clone, 7), prSha);
  assert.equal(await fetchRef(clone, 'main'), mainSha);
  assert.equal(g(clone, 'cat-file', '-t', prSha), 'commit');
  assert.equal(fs.readFileSync(fh, 'utf8'), 'deadbeef\tsentinel written by another process\n', 'FETCH_HEAD untouched');
  assert.equal(g(clone, 'for-each-ref', '--format=%(refname) %(objectname)'), refsBefore, 'no ref moved');
});

test('unknown refs and malformed SHAs are errors, not guesses', async () => {
  const { clone } = world();
  await assert.rejects(fetchPrHead(clone, 999), /origin has no refs\/pull\/999\/head/);
  await assert.rejects(fetchSha(clone, 'HEAD'), /not a commit SHA/);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The real server.js on a spare port, with temp data and vault.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sec-'));
let child, port;
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

before(async () => {
  port = await freePort();
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DECK_DATA: path.join(tmp, 'data'), DECK_VAULT: path.join(tmp, 'vault'), DECK_NO_BACKGROUND: '1', DECK_HOST: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/version`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { if (child) child.kill('SIGKILL'); fs.rmSync(tmp, { recursive: true, force: true }); });

const post = (headers = {}) => fetch(`http://127.0.0.1:${port}/api/vault/capture`, {
  method: 'POST', headers: { 'content-type': 'text/plain', ...headers }, body: '{"text":""}',
});

test('the gateway listens on loopback only', () => {
  const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout;
  const addrs = out.split('\n').slice(1).filter(Boolean).map(l => l.trim().split(/\s+/)[8]);
  assert.ok(addrs.length >= 1, out);
  for (const a of addrs) assert.match(a, /^(127\.0\.0\.1|\[::1\]):\d+$/, `listening on ${a}`);
});

test('a write from another site is refused before any route runs', async () => {
  let r = await post({ origin: 'http://evil.example' });
  assert.equal(r.status, 403);
  r = await post({ 'sec-fetch-site': 'cross-site' });
  assert.equal(r.status, 403);
  r = await post({ origin: 'null' });
  assert.equal(r.status, 403);
});

test('local pages, local tools and the CLI still write; reads are never refused', async () => {
  // The capture route answers 400 for an empty text: reaching it means the
  // request got past the cross-site check, and nothing was written.
  assert.equal((await post({ origin: `http://localhost:${port}` })).status, 400);
  assert.equal((await post({ origin: 'http://localhost:5175', 'sec-fetch-site': 'same-site' })).status, 400);
  assert.equal((await post({ origin: 'http://127.0.0.1:8850' })).status, 400);
  assert.equal((await post()).status, 400, 'no Origin: the deck CLI, curl');
  const g = await fetch(`http://127.0.0.1:${port}/api/version`, { headers: { origin: 'http://evil.example' } });
  assert.equal(g.status, 200);
});

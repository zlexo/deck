import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The real server.js with two tools: `save` needs 2.8 s after SIGTERM to
// finish (a world save) and `stubborn` ignores SIGTERM, so only its 3 s grace
// and a SIGKILL stop it. Both outlast the 2.3 s after which the gateway used
// to exit whatever was still running, which orphaned them.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };

async function gateway(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-shutdown-'));
  const config = path.join(tmp, 'config');
  const saved = path.join(tmp, 'saved');
  fs.mkdirSync(path.join(config, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({ scanRoots: [] }));
  const tools = {
    save: {
      cmd: [process.execPath, '-e', `process.on('SIGTERM', () => setTimeout(() => { require('fs').writeFileSync(process.argv[1], 'saved'); process.exit(0); }, 2800)); console.log('ready'); setInterval(() => {}, 1000)`, saved],
      stopGraceMs: 8000,
    },
    stubborn: { cmd: [process.execPath, '-e', `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)`], stopGraceMs: 3000 },
    late: { cmd: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] },
  };
  for (const [id, m] of Object.entries(tools))
    fs.writeFileSync(path.join(config, 'tools', `${id}.json`), JSON.stringify({ id, name: id, cwd: tmp, ...m }));

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DECK_CONFIG: config, DECK_DATA: path.join(tmp, 'data'), DECK_VAULT: path.join(tmp, 'vault'), DECK_NO_BACKGROUND: '1' },
    stdio: 'ignore',
  });
  const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal, saved: fs.existsSync(saved) })));
  const api = (p, method = 'GET') => fetch(`http://127.0.0.1:${port}${p}`, { method }).then(async r => ({ status: r.status, body: await r.json() }));
  const pids = [];
  t.after(() => {
    for (const pid of [child.pid, ...pids]) try { process.kill(pid, 'SIGKILL'); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await api('/api/version')).status === 200) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  for (const id of ['save', 'stubborn']) {
    const r = await api(`/api/tools/${id}/start`, 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    pids.push(r.body.pid);
  }
  // A SIGTERM that lands before a tool has set its handler kills it at once.
  for (const id of ['save', 'stubborn'])
    for (let i = 0; i < 100 && !(await api(`/api/tools/${id}/logs`)).body.logs.includes('ready'); i++)
      await new Promise(r => setTimeout(r, 50));
  const done = () => Promise.race([exited, new Promise((_, no) => setTimeout(() => no(new Error('the gateway did not exit within 20 s')), 20000))]);
  return { api, pids, child, done };
}

test('POST /api/shutdown stops every tool within its grace, then the gateway exits', async t => {
  const g = await gateway(t);
  const r = await g.api('/api/shutdown', 'POST');
  assert.equal(r.status, 200);
  assert.ok(r.body.graceMs >= 8000, `graceMs ${r.body.graceMs} covers the slowest tool's 8 s grace`);
  const exit = await g.done();
  assert.equal(exit.code, 0);
  assert.ok(exit.saved, 'save finished its 2.8 s save before the gateway exited');
  for (const pid of g.pids) assert.ok(gone(pid), `tool ${pid} is gone when the gateway has exited`);
});

test('SIGTERM runs the same shutdown', async t => {
  const g = await gateway(t);
  g.child.kill('SIGTERM');
  const exit = await g.done();
  assert.equal(exit.code, 0);
  assert.ok(exit.saved, 'save finished its 2.8 s save before the gateway exited');
  for (const pid of g.pids) assert.ok(gone(pid), `tool ${pid} is gone when the gateway has exited`);
});

test('nothing starts once the shutdown has begun', async t => {
  const g = await gateway(t);
  assert.equal((await g.api('/api/shutdown', 'POST')).status, 200);
  // save takes 2.8 s to stop, so the gateway is still up to refuse this.
  const r = await g.api('/api/tools/late/start', 'POST');
  if (r.body.pid) g.pids.push(r.body.pid); // started after all: cleaned up, not orphaned
  assert.equal(r.status, 500);
  assert.match(r.body.error, /shutting down/);
  await g.done();
});

test('a second Ctrl-C quits at once and leaves the tools running', async t => {
  const g = await gateway(t);
  g.child.kill('SIGINT');
  await new Promise(r => setTimeout(r, 300));
  g.child.kill('SIGINT');
  const exit = await g.done();
  assert.equal(exit.code, 130);
  const [, stubborn] = g.pids;
  assert.ok(!gone(stubborn), 'stubborn, inside its 3 s grace, is left running');
});

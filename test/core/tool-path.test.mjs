import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The installed app starts the gateway with launchd's PATH, so everything here
// runs on the real server.js with exactly that PATH. The commands live in
// ~/.local/bin of a temp HOME: only toolPath() can find them, wherever node is
// installed on this machine.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BARE = '/usr/bin:/bin:/usr/sbin:/sbin';
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Says whether its own child command resolves, as npm has to find node.
const TOOL = `#!/bin/sh
echo "child: $(command -v deck-path-child || echo none)"
exec /bin/sleep 60
`;

async function gateway(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-tool-path-'));
  const bin = path.join(tmp, '.local', 'bin');
  const config = path.join(tmp, 'config');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(config, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(config, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'deck-path-tool'), TOOL, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'deck-path-child'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({ scanRoots: [] }));
  const tool = (id, cmd) => fs.writeFileSync(path.join(config, 'tools', `${id}.json`), JSON.stringify({ id, name: id, cmd: [cmd], cwd: tmp }));
  tool('found', 'deck-path-tool');
  tool('missing', 'deck-path-no-such-command');
  fs.writeFileSync(path.join(config, 'projects', 'play.json'), JSON.stringify({
    id: 'play', name: 'Play',
    servers: [
      { id: 'found', label: 'Found', cmd: ['deck-path-tool'], cwd: tmp },
      { id: 'missing', label: 'Missing', cmd: ['deck-path-no-such-command'], cwd: tmp },
    ],
  }));

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: BARE, HOME: tmp, PORT: String(port), DECK_CONFIG: config, DECK_DATA: path.join(tmp, 'data'), DECK_VAULT: path.join(tmp, 'vault'), DECK_NO_BACKGROUND: '1', DECK_CLI: 'off' },
    stdio: 'ignore',
  });
  const api = (p, method = 'GET') => fetch(`http://127.0.0.1:${port}${p}`, { method }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  t.after(async () => {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST' }).catch(() => {});
    await sleep(300);
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const until = async (ok, what, ms = 10000) => {
    for (const end = Date.now() + ms; !(await ok());) {
      if (Date.now() > end) throw new Error(`waited ${ms} ms: ${what}`);
      await sleep(100);
    }
  };
  await until(() => api('/api/version').then(r => r.status === 200, () => false), 'the gateway answers');
  return { api, until, bin };
}

describe('tools under launchd\'s PATH', () => {
  for (const [what, base] of [['a tool', '/api/tools/found'], ['a project server', '/api/projects/play/servers/found']]) {
    test(`${what} on a bare command starts, and its own children resolve`, async t => {
      const { api, until, bin } = await gateway(t);
      const r = await api(`${base}/start`, 'POST');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.body.pid > 0, `no pid: ${JSON.stringify(r.body)}`);
      await until(async () => (await api(`${base}/logs`)).body.logs.some(l => l.startsWith('child:')), 'it prints');
      const logs = (await api(`${base}/logs`)).body.logs;
      assert.ok(logs.includes(`child: ${path.join(bin, 'deck-path-child')}`), logs.join('\n'));
      await api(`${base}/stop`, 'POST');
    });
  }

  for (const [what, base] of [['a tool', '/api/tools/missing'], ['a project server', '/api/projects/play/servers/missing']]) {
    test(`${what} that cannot start says so and does not read as running`, async t => {
      const { api, until } = await gateway(t);
      const r = await api(`${base}/start`, 'POST');
      assert.notEqual(r.status, 200, JSON.stringify(r.body));
      assert.match(r.body.error, /deck-path-no-such-command/);
      await until(async () => (await api(`${base}/logs`)).body.logs.some(l => l.includes('spawn error')), 'the log has the reason');
      if (base.startsWith('/api/tools/')) {
        const row = (await api('/api/tools')).body.tools.find(x => x.id === 'missing');
        assert.equal(row.status, 'stopped');
      }
      // and it can be tried again, not "already running"
      const again = await api(`${base}/start`, 'POST');
      assert.match(again.body.error, /deck-path-no-such-command/);
    });
  }
});

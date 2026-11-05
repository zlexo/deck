import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A server that takes its port as a plain argument (`python3 -m http.server
// 4340`) has no flag to pass it with, so its manifest writes `{port}` into
// `cmd`, as `url` does. Everything here runs on the real server.js.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Prints the arguments it was given, then stays up like a server.
const ECHO = ['/bin/sh', '-c', 'echo "args: $*"; exec /bin/sleep 60', 'sh'];
// Serves one page on the port it gets as its first argument, no flag.
const SERVE = [process.execPath, '-e', "require('http').createServer((q, s) => s.end('served')).listen(+process.argv[1], '127.0.0.1')"];

async function gateway(t, { tools, projects = [], state = {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-tool-cmd-'));
  const config = path.join(tmp, 'config');
  fs.mkdirSync(path.join(config, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(config, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({ scanRoots: [], ...state }));
  for (const m of tools) fs.writeFileSync(path.join(config, 'tools', `${m.id}.json`), JSON.stringify({ name: m.id, cwd: tmp, ...m }));
  for (const p of projects) fs.writeFileSync(path.join(config, 'projects', `${p.id}.json`), JSON.stringify(p));

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: tmp, PORT: String(port), DECK_CONFIG: config, DECK_DATA: path.join(tmp, 'data'), DECK_VAULT: path.join(tmp, 'vault'), DECK_NO_BACKGROUND: '1', DECK_CLI: 'off' },
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
  const argsOf = async base => {
    await until(async () => (await api(`${base}/logs`)).body.logs.some(l => l.startsWith('args:')), 'it prints its arguments');
    return (await api(`${base}/logs`)).body.logs.find(l => l.startsWith('args:'));
  };
  return { api, until, argsOf, home: tmp };
}

describe('{key} in a tool\'s cmd', () => {
  test('a server that takes its port as a plain argument opens its page', async t => {
    const port = await freePort();
    const { api, until } = await gateway(t, { tools: [{
      id: 'site', cmd: [...SERVE, '{port}'], url: 'http://127.0.0.1:{port}/', portKey: 'port',
      config: { port: { type: 'number', default: port } },
    }] });
    const r = await api('/api/tools/site/start', 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = (await api('/api/tools')).body.tools.find(x => x.id === 'site');
    assert.equal(row.url, `http://127.0.0.1:${port}/`);
    let page = null;
    await until(async () => (page = await fetch(row.url).then(x => x.text(), () => null)) !== null, 'the page answers',
      5000).catch(async e => { throw new Error(`${e.message}\n${(await api('/api/tools/site/logs')).body.logs.join('\n')}`); });
    assert.equal(page, 'served');
    await api('/api/tools/site/stop', 'POST');
  });

  test('takes the saved value over the default, expands a path, and leaves other braces alone', async t => {
    const saved = await freePort();
    const { api, argsOf, home } = await gateway(t, {
      tools: [{
        id: 'echo', cmd: [...ECHO, '{port}', '--name={name}', '{dir}', '{other}', '{}'], portKey: 'port',
        config: {
          port: { type: 'number', default: 1 },
          name: { type: 'string', default: 'hello' },
          dir: { type: 'path', default: '~/work' },
        },
      }],
      state: { echo: { config: { port: saved } } },
    });
    const r = await api('/api/tools/echo/start', 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await argsOf('/api/tools/echo'), `args: ${saved} --name=hello ${path.join(home, 'work')} {other} {}`);
    const started = (await api('/api/tools/echo/logs')).body.logs.find(l => l.startsWith('[deck] started:'));
    assert.match(started, new RegExp(`^\\[deck\\] started: .* ${saved} --name=hello`), 'the log shows what ran');
    await api('/api/tools/echo/stop', 'POST');
  });

  test('is filled when a prelaunch step runs first', async t => {
    const port = await freePort();
    const { api, argsOf } = await gateway(t, { tools: [{
      id: 'stepped', cmd: [...ECHO, '{port}'], portKey: 'port',
      config: { port: { type: 'number', default: port } },
      prelaunch: [{ label: 'a step', cmd: ['/usr/bin/true'] }],
    }] });
    const r = await api('/api/tools/stepped/start', 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await argsOf('/api/tools/stepped'), `args: ${port}`);
    await api('/api/tools/stepped/stop', 'POST');
  });

  test('is filled when a project server starts the tool', async t => {
    const port = await freePort();
    const { api, argsOf } = await gateway(t, {
      tools: [{ id: 'shared', cmd: [...ECHO, '{port}'], portKey: 'port', config: { port: { type: 'number', default: port } } }],
      projects: [{ id: 'play', name: 'Play', servers: [{ id: 'web', label: 'Web', toolId: 'shared' }] }],
    });
    const r = await api('/api/projects/play/servers/web/start', 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await argsOf('/api/tools/shared'), `args: ${port}`);
    await api('/api/projects/play/servers/web/stop', 'POST');
  });
});

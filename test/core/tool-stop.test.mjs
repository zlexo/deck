import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Stop, Restart and quit take down what a tool started, not only the tool.
// Emoton's `preview` (the launcher here) spawns Remotion Studio (the studio)
// and exits on SIGTERM without stopping it; Stop used to signal the launcher
// alone, so the studio kept the port at PPID 1 and the next Start said "port
// in use" (2026-11-05). Everything here runs on the real server.js.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };
const portFree = port => new Promise(r => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(port, '127.0.0.1', () => s.close(() => r(true))); });

// Every process notes "<what> <name> <pid>" in a journal the test shares, so
// the order of the lines is the order of the events: a launcher or wrapper
// notes "launch", the process it starts "start".
const NOTE = `const fs = require('fs'); const [journal, name] = process.argv.slice(2);
const note = what => fs.appendFileSync(journal, what + ' ' + name + ' ' + process.pid + '\\n');
setTimeout(() => process.exit(0), 60000); // never outlives an interrupted run
`;
// Starts the studio with its stdio and has no SIGTERM handler of its own, as
// Emoton's preview does.
const LAUNCHER = NOTE + `note('launch');
require('child_process').spawn(process.execPath, [__dirname + '/studio.js', ...process.argv.slice(2)], { stdio: 'inherit' });
`;
// Holds the port. Exits on SIGTERM, or with "stubborn" ignores it.
const STUDIO = NOTE + `const [, , port, mode] = process.argv.slice(2);
note('start');
process.on('SIGTERM', () => { note('term'); if (mode !== 'stubborn') process.exit(0); });
require('net').createServer().listen(Number(port), '127.0.0.1', () => console.log('ready'));
`;
// The course VM: the wrapper shuts its child down cleanly on SIGTERM (SIGUSR2
// here, a QMP powerdown there) and exits once it has. A SIGTERM straight to
// the child cuts it off instead.
const WRAPPER = NOTE + `note('launch');
const vm = require('child_process').spawn(process.execPath, [__dirname + '/vm.js', ...process.argv.slice(2)], { stdio: 'inherit' });
process.on('SIGTERM', () => { vm.kill('SIGUSR2'); vm.once('exit', () => process.exit(0)); });
`;
const VM = NOTE + `note('start');
process.on('SIGUSR2', () => setTimeout(() => { note('clean'); process.exit(0); }, 500));
process.on('SIGTERM', () => { note('cut'); process.exit(0); });
console.log('ready');
`;

async function gateway(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-tool-stop-'));
  const config = path.join(tmp, 'config');
  const journal = path.join(tmp, 'journal');
  fs.writeFileSync(journal, '');
  for (const [file, src] of Object.entries({ 'launcher.js': LAUNCHER, 'studio.js': STUDIO, 'wrapper.js': WRAPPER, 'vm.js': VM }))
    fs.writeFileSync(path.join(tmp, file), src);
  fs.mkdirSync(path.join(config, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(config, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({ scanRoots: [] }));
  const ports = { studio: await freePort(), stubborn: await freePort(), served: await freePort() };
  const node = (file, ...args) => [process.execPath, path.join(tmp, file), journal, ...args];
  const tools = [
    { id: 'studio', cmd: node('launcher.js', 'studio', String(ports.studio)), config: { port: { type: 'number', default: ports.studio } } },
    { id: 'stubborn', cmd: node('launcher.js', 'stubborn', String(ports.stubborn), 'stubborn'), stopGraceMs: 1500, config: { port: { type: 'number', default: ports.stubborn } } },
    { id: 'vm', cmd: node('wrapper.js', 'vm'), stopGraceMs: 5000 },
  ];
  for (const m of tools) fs.writeFileSync(path.join(config, 'tools', `${m.id}.json`), JSON.stringify({ name: m.id, cwd: tmp, ...m }));
  fs.writeFileSync(path.join(config, 'projects', 'play.json'), JSON.stringify({
    id: 'play', name: 'Play',
    servers: [{ id: 'served', label: 'Served', port: ports.served, cmd: node('launcher.js', 'served', String(ports.served)), cwd: tmp }],
  }));

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: tmp, PORT: String(port), DECK_CONFIG: config, DECK_DATA: path.join(tmp, 'data'), DECK_VAULT: path.join(tmp, 'vault'), DECK_NO_BACKGROUND: '1', DECK_CLI: 'off' },
    stdio: 'ignore',
  });
  const exited = new Promise(r => child.once('exit', code => r(code)));
  const api = (p, method = 'GET') => fetch(`http://127.0.0.1:${port}${p}`, { method }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const lines = () => fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean);
  // pids of the processes called name that noted what, in order
  const pids = (name, what = 'start') => lines().filter(l => l.startsWith(`${what} ${name} `)).map(l => Number(l.split(' ')[2]));
  t.after(() => {
    for (const pid of [child.pid, ...lines().map(l => Number(l.split(' ')[2]))]) try { process.kill(pid, 'SIGKILL'); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const until = async (ok, what, ms = 10000) => {
    for (const end = Date.now() + ms; !(await ok());) {
      if (Date.now() > end) throw new Error(`waited ${ms} ms: ${what}`);
      await sleep(100);
    }
  };
  await until(() => api('/api/version').then(r => r.status === 200, () => false), 'the gateway answers');
  // Each start has a log of its own: ready once this one's says so.
  const ready = base => until(async () => (await api(`${base}/logs`)).body.logs.includes('ready'), `${base} is ready`)
    .catch(async e => { throw new Error(`${e.message}\nlog:\n${(await api(`${base}/logs`)).body.logs.join('\n')}\njournal:\n${lines().join('\n')}`); });
  const start = async base => {
    const r = await api(`${base}/start`, 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await ready(base);
    return r.body.pid;
  };
  return { api, ports, pids, lines, until, ready, start, exited };
}

describe('Stop takes down what a tool started', { concurrency: true }, () => {
  test('Stop, then Start at once: the studio the launcher left is gone and the port is free', async t => {
    const g = await gateway(t);
    const launcher = await g.start('/api/tools/studio');
    const [studio] = g.pids('studio');
    const r = await g.api('/api/tools/studio/stop', 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const again = await g.api('/api/tools/studio/start', 'POST');
    assert.equal(again.status, 200, `the next Start: ${JSON.stringify(again.body)}`);
    assert.ok(gone(launcher), 'the launcher has exited');
    assert.ok(gone(studio), `the first studio ${studio} has exited, not been left at PPID 1`);
    await g.ready('/api/tools/studio');
    assert.equal(g.pids('studio').length, 2, 'a second studio started');
  });

  test('Stop resolves to a free port within the tool\'s grace', async t => {
    const g = await gateway(t);
    await g.start('/api/tools/studio');
    const [studio] = g.pids('studio');
    await g.api('/api/tools/studio/stop', 'POST');
    await g.until(() => gone(studio), 'the studio exits', 5000);
    assert.ok(await portFree(g.ports.studio), `port ${g.ports.studio} is free`);
  });

  test('Restart stops the old studio before it starts the new one', async t => {
    const g = await gateway(t);
    await g.start('/api/tools/studio');
    const [first] = g.pids('studio');
    const r = await g.api('/api/tools/studio/restart', 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(gone(first), `the old studio ${first} is gone`);
    await g.ready('/api/tools/studio');
    assert.equal(g.pids('studio').length, 2, 'a second studio started');
  });

  test('Restart of a tool with no port starts the new one only once the old one has shut down', async t => {
    const g = await gateway(t);
    await g.start('/api/tools/vm');
    const [old] = g.pids('vm');
    const r = await g.api('/api/tools/vm/restart', 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await g.ready('/api/tools/vm');
    const [, next] = g.pids('vm');
    const order = g.lines().filter(l => / vm /.test(l) && !l.startsWith('launch')).map(l => l.split(' ').slice(0, 1).concat(l.endsWith(` ${old}`) ? 'old' : 'new').join(' '));
    assert.deepEqual(order, ['start old', 'clean old', 'start new'], `the old VM ${old} shut down before the new ${next} started`);
  });

  test('a child that ignores SIGTERM gets SIGKILL after the tool\'s grace', async t => {
    const g = await gateway(t);
    await g.start('/api/tools/stubborn');
    const [studio] = g.pids('stubborn');
    await g.api('/api/tools/stubborn/stop', 'POST');
    await g.until(() => g.pids('stubborn', 'term').length > 0, 'the studio gets its SIGTERM', 5000);
    assert.ok(!gone(studio), 'and is given the grace');
    await g.until(() => gone(studio), 'the studio is killed after its 1.5 s grace', 5000);
  });

  test('the tool gets the SIGTERM first and alone: the VM wrapper shuts its VM down cleanly', async t => {
    const g = await gateway(t);
    await g.start('/api/tools/vm');
    const [vm] = g.pids('vm');
    await g.api('/api/tools/vm/stop', 'POST');
    await g.until(() => gone(vm), 'the VM exits', 8000);
    assert.deepEqual(g.pids('vm', 'clean'), [vm], 'the VM shut down cleanly');
    assert.deepEqual(g.pids('vm', 'cut'), [], 'no SIGTERM reached the VM past its wrapper');
  });

  test('Stop of a project server takes down what it started too', async t => {
    const g = await gateway(t);
    const base = '/api/projects/play/servers/served';
    await g.start(base);
    const [studio] = g.pids('served');
    await g.api(`${base}/stop`, 'POST');
    await g.until(() => gone(studio), 'the server\'s child exits', 5000);
    const again = await g.api(`${base}/start`, 'POST');
    assert.equal(again.status, 200, JSON.stringify(again.body));
  });

  test('quitting during a Stop waits for that Stop to finish', async t => {
    const g = await gateway(t);
    await g.start('/api/tools/stubborn');
    const [studio] = g.pids('stubborn');
    await g.api('/api/tools/stubborn/stop', 'POST');
    await g.until(() => g.pids('stubborn', 'term').length > 0, 'the studio gets its SIGTERM', 5000);
    await g.api('/api/shutdown', 'POST');
    assert.equal(await g.exited, 0);
    assert.ok(gone(studio), `the studio ${studio}, inside its grace when the quit came, is gone once the gateway has exited`);
  });

  test('quitting Deck takes down what every tool started, then the gateway exits', async t => {
    const g = await gateway(t);
    await g.start('/api/tools/studio');
    await g.start('/api/tools/vm');
    const r = await g.api('/api/shutdown', 'POST');
    assert.ok(r.body.graceMs >= 10000, `graceMs ${r.body.graceMs} covers the vm's 5 s grace twice`);
    assert.equal(await g.exited, 0);
    for (const pid of ['studio', 'vm'].flatMap(name => [...g.pids(name, 'launch'), ...g.pids(name)])) assert.ok(gone(pid), `${pid} is gone once the gateway has exited`);
    assert.deepEqual(g.pids('vm', 'cut'), [], 'the VM was shut down by its wrapper');
  });
});

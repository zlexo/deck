import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The project panel's Stop and Restart, and the app's stop-all, on the real
// server.js. Every process here needs 6 s after SIGTERM to finish its save (a
// world save) and has a stopGraceMs of 10 s. These used to SIGKILL a project
// server or dev client 5 s after the SIGTERM whatever its spec said, and
// Restart started the new server 1.8 s after the SIGTERM, beside the old one
// still saving.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAVE_MS = 6000;
const WORLD = '/api/projects/play/servers/world';
const LAUNCHED = '/api/projects/play/servers/launched';
const TOOLED = '/api/projects/play/servers/tooled';
const CLIENT = '/api/projects/play/dev-client';
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Notes "start <name> <pid>" when it starts and "saved <name> <pid>" when its
// save after SIGTERM is done, in a journal every process of a test shares, so
// the order of the lines is the order of the events. With a port it holds
// that port, as a game server does, and is ready once it has it.
const SAVER = `
const fs = require('fs');
const [journal, name, port] = process.argv.slice(2);
const note = what => fs.appendFileSync(journal, what + ' ' + name + ' ' + process.pid + '\\n');
note('start');
process.on('SIGTERM', () => { console.log('saving'); setTimeout(() => { note('saved'); process.exit(0); }, ${SAVE_MS}); });
if (port) require('net').createServer().listen(Number(port), '127.0.0.1', () => console.log('ready'));
else console.log('ready');
setTimeout(() => process.exit(0), 60000); // never outlives an interrupted run
`;

async function gateway(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-project-stop-'));
  const config = path.join(tmp, 'config');
  const journal = path.join(tmp, 'journal');
  const saver = path.join(tmp, 'saver.js');
  fs.writeFileSync(saver, SAVER);
  fs.writeFileSync(journal, '');
  fs.mkdirSync(path.join(config, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(config, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({ scanRoots: [] }));
  const ports = { world: await freePort(), launched: await freePort() };
  const saving = (name, ...args) => ({ cmd: [process.execPath, saver, journal, name, ...args], cwd: tmp, stopGraceMs: 10000 });
  fs.writeFileSync(path.join(config, 'tools', 'slow.json'), JSON.stringify({ id: 'slow', name: 'slow', ...saving('slow') }));
  fs.writeFileSync(path.join(config, 'projects', 'play.json'), JSON.stringify({
    id: 'play', name: 'Play',
    servers: [
      { id: 'world', label: 'World', port: ports.world, ...saving('world', String(ports.world)) },
      // its port is held by something else, as the server JVM that
      // `./gradlew runServer` starts holds it, not the launcher Deck tracks
      { id: 'launched', label: 'Launched', port: ports.launched, ...saving('launched') },
      { id: 'tooled', label: 'Tooled', toolId: 'slow' },
    ],
    devClient: { label: 'Client', ...saving('client') },
  }));

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DECK_CONFIG: config, DECK_DATA: path.join(tmp, 'data'), DECK_VAULT: path.join(tmp, 'vault'), DECK_NO_BACKGROUND: '1' },
    stdio: 'ignore',
  });
  const api = (p, method = 'GET') => fetch(`http://127.0.0.1:${port}${p}`, { method }).then(async r => ({ status: r.status, body: await r.json() }));
  const note = line => fs.appendFileSync(journal, line + '\n');
  const events = name => fs.readFileSync(journal, 'utf8').split('\n').filter(l => l.split(' ')[1] === name);
  t.after(() => {
    // every process the test started, by the pid it noted when it started
    const pids = [...fs.readFileSync(journal, 'utf8').matchAll(/^start \S+ (\d+)$/gm)].map(m => Number(m[1]));
    for (const pid of [child.pid, ...pids]) try { process.kill(pid, 'SIGKILL'); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const until = async (ok, what, ms = 10000) => {
    for (const end = Date.now() + ms; !(await ok());) {
      if (Date.now() > end) throw new Error(`waited ${ms} ms: ${what}`);
      await sleep(100);
    }
  };
  await until(() => api('/api/version').then(r => r.status === 200, () => false), 'the gateway answers');
  // A SIGTERM that lands before a process has set its handler kills it at once.
  const ready = base => until(async () => (await api(`${base}/logs`)).body.logs.includes('ready'), `${base} is ready`);
  const start = async base => {
    const r = await api(`${base}/start`, 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await ready(base);
    return r.body.pid;
  };
  return { api, ports, note, events, until, ready, start };
}

describe('a project server or dev client gets its stopGraceMs', { concurrency: true }, () => {
  test('Stop lets a server finish its save', async t => {
    const g = await gateway(t);
    const a = await g.start(WORLD);
    const r = await g.api(`${WORLD}/stop`, 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await g.until(() => gone(a), 'the server exits', SAVE_MS + 10000);
    assert.deepEqual(g.events('world'), [`start world ${a}`, `saved world ${a}`]);
  });

  test('Stop lets a dev client finish its save', async t => {
    const g = await gateway(t);
    const a = await g.start(CLIENT);
    const r = await g.api(`${CLIENT}/stop`, 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await g.until(() => gone(a), 'the dev client exits', SAVE_MS + 10000);
    assert.deepEqual(g.events('client'), [`start client ${a}`, `saved client ${a}`]);
  });

  test('Stop of a server that is a tool gives it the tool\'s grace', async t => {
    const g = await gateway(t);
    const a = await g.start(TOOLED);
    const r = await g.api(`${TOOLED}/stop`, 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await g.until(() => gone(a), 'the tool exits', SAVE_MS + 10000);
    assert.deepEqual(g.events('slow'), [`start slow ${a}`, `saved slow ${a}`]);
  });

  test('Restart starts the new server only after the old one has saved and let go of its port', async t => {
    const g = await gateway(t);
    const a = await g.start(WORLD);
    const r = await g.api(`${WORLD}/restart`, 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body.pid;
    await g.until(() => g.events('world').includes(`start world ${b}`), 'the new server starts');
    assert.deepEqual(g.events('world'), [`start world ${a}`, `saved world ${a}`, `start world ${b}`]);
    await g.ready(WORLD); // it holds the port
    assert.ok(gone(a), 'the old server is gone');
  });

  test('Restart waits for the port when it outlives the process Deck started', async t => {
    const g = await gateway(t);
    const a = await g.start(LAUNCHED);
    const game = net.createServer().listen(g.ports.launched, '127.0.0.1');
    t.after(() => game.close());
    const restart = g.api(`${LAUNCHED}/restart`, 'POST');
    await g.until(() => gone(a), 'the launcher exits', SAVE_MS + 10000);
    await sleep(1500);
    g.note('released launched port');
    game.close();
    const r = await restart;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body.pid;
    await g.until(() => g.events('launched').includes(`start launched ${b}`), 'the new server starts');
    assert.deepEqual(g.events('launched'), [`start launched ${a}`, `saved launched ${a}`, 'released launched port', `start launched ${b}`]);
  });

  test('Restart of a server that is a tool waits for the tool to save', async t => {
    const g = await gateway(t);
    const a = await g.start(TOOLED);
    const r = await g.api(`${TOOLED}/restart`, 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await g.ready(TOOLED);
    assert.deepEqual(g.events('slow'), [`start slow ${a}`, `saved slow ${a}`, `start slow ${r.body.pid}`]);
  });

  test('while a restart waits, a second restart, a start and a stop are refused', async t => {
    const g = await gateway(t);
    const a = await g.start(WORLD);
    const restart = g.api(`${WORLD}/restart`, 'POST');
    await g.until(async () => (await g.api(`${WORLD}/logs`)).body.logs.includes('saving'), 'the old server got its SIGTERM');
    for (const action of ['restart', 'start', 'stop']) {
      const r = await g.api(`${WORLD}/${action}`, 'POST');
      assert.equal(r.status, 409, `${action}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /busy: a restart of World/);
    }
    const r = await restart;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await g.ready(WORLD);
    assert.deepEqual(g.events('world'), [`start world ${a}`, `saved world ${a}`, `start world ${r.body.pid}`], 'one new server');
  });

  // The app's quit with a gateway it adopted (the dev gateway, one started by
  // hand): the children stop, the gateway stays and runs out their graces.
  test('stop-all gives a project server and a dev client their grace', async t => {
    const g = await gateway(t);
    const a = await g.start(WORLD), c = await g.start(CLIENT);
    const r = await g.api('/api/stop-all', 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.stopped.sort(), ['proj:play:devclient', 'proj:play:server:world']);
    await g.until(() => gone(a) && gone(c), 'both exit', SAVE_MS + 10000);
    assert.deepEqual(g.events('world'), [`start world ${a}`, `saved world ${a}`]);
    assert.deepEqual(g.events('client'), [`start client ${c}`, `saved client ${c}`]);
  });
});

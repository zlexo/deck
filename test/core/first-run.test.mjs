import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-first-run-'));
process.env.DECK_DATA = path.join(tmp, 'data');
process.env.DECK_VAULT = path.join(tmp, 'vault');

const { setDeckRoot, tildify } = await import('../../lib/core/paths.mjs');
const { seedFromExamples } = await import('../../lib/core/config-cli.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A checkout as a stranger clones it: the examples, and no config of its own.
function cleanCheckout(name) {
  const dir = path.join(tmp, name);
  fs.cpSync(path.join(REPO, 'examples'), path.join(dir, 'examples'), { recursive: true });
  return dir;
}

test('first run: the examples are copied in, {deck} becomes the checkout, and the welcome is recorded', () => {
  const root = cleanCheckout('co-fresh');
  setDeckRoot(root);
  process.env.DECK_CONFIG = path.join(tmp, 'cfg-fresh');
  const copied = seedFromExamples();
  assert.deepEqual(copied.sort(), ['folders.json', 'projects/deck.json', 'tools/hello.json', 'tools/ticker.json']);
  const read = rel => JSON.parse(fs.readFileSync(path.join(process.env.DECK_CONFIG, rel), 'utf8'));
  assert.equal(read('tools/hello.json').cwd, `${tildify(root)}/examples/hello`);
  assert.equal(read('tools/hello.json').url, 'http://localhost:{port}', 'other placeholders are left for the gateway');
  assert.deepEqual(read('projects/deck.json').repos, [{ path: tildify(root) }]);
  assert.deepEqual(read('state.json'), { welcome: { seeded: true, dismissed: false } });
  for (const rel of copied) assert.doesNotMatch(fs.readFileSync(path.join(process.env.DECK_CONFIG, rel), 'utf8'), /\{deck\}/, rel);
  assert.equal(seedFromExamples(), null, 'only once: the config folder now has items');
});

test('no seeding when any config exists, in the config folder or in an old checkout', () => {
  const root = cleanCheckout('co-old');
  fs.writeFileSync(path.join(root, 'folders.json'), '{}');
  setDeckRoot(root);
  process.env.DECK_CONFIG = path.join(tmp, 'cfg-old');
  assert.equal(seedFromExamples(), null);
  assert.ok(!fs.existsSync(process.env.DECK_CONFIG));
  setDeckRoot(cleanCheckout('co-cfg'));
  process.env.DECK_CONFIG = path.join(tmp, 'cfg-has');
  fs.mkdirSync(path.join(process.env.DECK_CONFIG, 'tools'), { recursive: true });
  assert.equal(seedFromExamples(), null);
});

test('gateway on a clean checkout: example cards, the welcome until it is dismissed', async () => {
  const root = cleanCheckout('co-gateway');
  const cfg = path.join(tmp, 'cfg-gateway');
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, [path.join(REPO, 'server.js')], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), DECK_ROOT: root, DECK_CONFIG: cfg, DECK_DATA: path.join(tmp, 'gw-data'), DECK_VAULT: path.join(tmp, 'vault'), DECK_NO_BACKGROUND: '1', DECK_HOST: '' },
    stdio: 'ignore',
  });
  const get = async u => (await fetch(`http://127.0.0.1:${port}${u}`)).json();
  try {
    let c;
    for (let i = 0; i < 100 && !c; i++) { try { c = await get('/api/config'); } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.ok(c, 'server did not start');
    assert.equal(c.welcome, true);
    assert.equal(c.vault, false, 'no vault folder: the vault features hide');
    assert.equal(c.modlab, false, 'no project configures Mod Lab: its page hides');
    fs.mkdirSync(path.join(tmp, 'vault'), { recursive: true });
    assert.equal((await get('/api/config')).vault, true, 'checked on every request');
    assert.equal(c.dir, tildify(cfg));
    assert.deepEqual(c.sources, { tools: 'config', projects: 'config', 'folders.json': 'config', 'state.json': 'config' });
    const ids = (await get('/api/tools')).tools.map(t => t.id);
    assert.ok(ids.includes('hello') && ids.includes('ticker'), ids.join(','));
    assert.ok((await get('/api/projects')).projects.some(p => p.id === 'deck'));
    const r = await fetch(`http://127.0.0.1:${port}/api/config/welcome`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal((await get('/api/config')).welcome, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, 'state.json'), 'utf8')).welcome.dismissed, true, 'remembered in state.json');
  } finally { child.kill('SIGKILL'); }
});

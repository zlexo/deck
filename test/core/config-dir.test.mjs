import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-config-'));
process.env.DECK_DATA = path.join(tmp, 'data');
process.env.DECK_VAULT = path.join(tmp, 'vault');
delete process.env.DECK_CONFIG;

const { setDeckRoot, configDir, configPath, configSource } = await import('../../lib/core/paths.mjs');
const { readStateFile } = await import('../../lib/core/config.mjs');
const { plan, migrate, main } = await import('../../lib/core/config-cli.mjs');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const quiet = async fn => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

// A checkout from before the move: config next to the code.
function oldCheckout(name) {
  const dir = path.join(tmp, name);
  write(path.join(dir, 'tools', 'a.json'), '{"id":"a","cmd":["true"],"cwd":"~"}');
  write(path.join(dir, 'tools', 'b.json'), '{"id":"b","cmd":["true"],"cwd":"~"}');
  write(path.join(dir, 'projects', 'p.json'), '{"id":"p","name":"P"}');
  write(path.join(dir, 'folders.json'), '{"Downloads":"~/Downloads"}');
  write(path.join(dir, 'state.json'), '{"a":{"config":{"port":9000}}}');
  return dir;
}
function freshConfig(name) {
  process.env.DECK_CONFIG = path.join(tmp, name);
  return process.env.DECK_CONFIG;
}

test('config folder: in the data folder by default, DECK_CONFIG moves it', () => {
  delete process.env.DECK_CONFIG;
  assert.equal(configDir(), path.join(tmp, 'data', 'config'));
  process.env.DECK_CONFIG = path.join(tmp, 'elsewhere');
  assert.equal(configDir(), path.join(tmp, 'elsewhere'));
});

test('config path: the config folder wins, an old checkout is the fallback, a first write lands in the config folder', () => {
  const root = oldCheckout('co-paths');
  setDeckRoot(root);
  const cfg = freshConfig('cfg-paths');
  assert.equal(configSource('tools'), 'checkout');
  assert.equal(configPath('tools'), path.join(root, 'tools'));
  assert.deepEqual(readStateFile(), { a: { config: { port: 9000 } } }, 'state.json read from the checkout');
  write(path.join(cfg, 'tools', 'c.json'), '{}');
  assert.equal(configSource('tools'), 'config');
  assert.equal(configPath('tools'), path.join(cfg, 'tools'));
  assert.equal(configSource('nothing.json'), 'none');
  assert.equal(configPath('nothing.json'), path.join(cfg, 'nothing.json'));
});

test('migrate --dry-run reports and changes nothing', async () => {
  setDeckRoot(oldCheckout('co-dry'));
  const cfg = freshConfig('cfg-dry');
  const p = migrate({ dryRun: true });
  assert.deepEqual(p.steps.map(s => [s.rel, s.action]), [
    ['tools/a.json', 'copy'], ['tools/b.json', 'copy'], ['projects/p.json', 'copy'], ['folders.json', 'copy'], ['state.json', 'copy'],
  ]);
  assert.ok(!fs.existsSync(cfg), 'nothing written');
  assert.equal(await quiet(() => main(['migrate', '--dry-run'])), 0);
  assert.ok(!fs.existsSync(cfg));
});

test('migrate copies every item byte for byte, keeps the checkout, and a second run finds it all there', async () => {
  const root = oldCheckout('co-copy');
  setDeckRoot(root);
  const cfg = freshConfig('cfg-copy');
  assert.equal(await quiet(() => main(['migrate'])), 0);
  for (const rel of ['tools/a.json', 'tools/b.json', 'projects/p.json', 'folders.json', 'state.json'])
    assert.equal(fs.readFileSync(path.join(cfg, rel), 'utf8'), fs.readFileSync(path.join(root, rel), 'utf8'), rel);
  assert.ok(fs.existsSync(path.join(root, 'tools', 'a.json')), 'the checkout keeps its copies');
  assert.deepEqual(fs.readdirSync(cfg).filter(f => f.startsWith('.')), [], 'no staging folder left behind');
  for (const item of ['tools', 'projects', 'folders.json', 'state.json']) assert.equal(configSource(item), 'config', item);
  assert.ok(plan().steps.every(s => s.action === 'same'));
  assert.equal(await quiet(() => main(['migrate'])), 0);
});

test('migrate never overwrites a config file that differs: it is a conflict, exit 1', async () => {
  const root = oldCheckout('co-conflict');
  setDeckRoot(root);
  const cfg = freshConfig('cfg-conflict');
  write(path.join(cfg, 'state.json'), '{"newer":true}');
  assert.equal(await quiet(() => main(['migrate'])), 1);
  assert.equal(fs.readFileSync(path.join(cfg, 'state.json'), 'utf8'), '{"newer":true}');
  assert.ok(fs.existsSync(path.join(cfg, 'tools', 'a.json')), 'the rest still copied');
});

test('migrate copies a manifest that does not parse as it is, and says so', async () => {
  const root = oldCheckout('co-broken');
  write(path.join(root, 'tools', 'broken.json'), '{ not json');
  setDeckRoot(root);
  freshConfig('cfg-broken');
  const lines = [];
  const log = console.log; console.log = l => lines.push(l);
  try { assert.equal(await main(['migrate']), 0); } finally { console.log = log; }
  assert.ok(lines.some(l => /broken\.json does not parse/.test(l)), lines.join('\n'));
  assert.ok(fs.existsSync(path.join(configDir(), 'tools', 'broken.json')));
});

test('an unknown subcommand prints the usage and exits 1', async () => {
  assert.equal(await quiet(() => main(['nope'])), 1);
  assert.equal(await quiet(() => main(['migrate', '--force'])), 1);
});

// The real gateway: the config folder's manifests are served, the checkout's
// tools/ (still in this repo) are not, and scanRoots [] turns discovery off.
test('gateway: tools and folders come from the config folder', async () => {
  const cfg = path.join(tmp, 'cfg-gateway');
  write(path.join(cfg, 'tools', 'only-in-config.json'), '{"id":"only-in-config","name":"Only","cmd":["true"],"cwd":"~"}');
  write(path.join(cfg, 'folders.json'), '{"Here":"~/here"}');
  write(path.join(cfg, 'state.json'), '{"scanRoots":[]}');
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), DECK_ROOT: REPO, DECK_CONFIG: cfg, DECK_DATA: path.join(tmp, 'gw-data'), DECK_VAULT: path.join(tmp, 'vault'), DECK_NO_BACKGROUND: '1', DECK_HOST: '' },
    stdio: 'ignore',
  });
  try {
    let body;
    for (let i = 0; i < 100 && !body; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/api/tools`); if (r.ok) body = await r.json(); } catch {}
      if (!body) await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(body, 'server did not start');
    assert.deepEqual(body.tools.map(t => t.id), ['only-in-config']);
    assert.deepEqual(body.folders, { Here: '~/here' });
  } finally { child.kill('SIGKILL'); }
});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-vault-')));
// A home of its own: the default ~/vault must never be this machine's.
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
process.env.DECK_DATA = path.join(tmp, 'data');
process.env.DECK_CONFIG = path.join(tmp, 'config');
delete process.env.DECK_VAULT;
const { setDeckRoot } = await import('../../lib/core/paths.mjs');
const { resolveVault, vaultDir, todayStr } = await import('../../lib/core/vault.mjs');
const { register, templateDir } = await import('../../lib/vault/index.mjs');
const { createRouter } = await import('../../lib/core/http.mjs');
setDeckRoot(REPO);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const caller = router => async (method, url, body) => {
  const res = { code: null, body: null, headersSent: false, writableEnded: false, writeHead(c) { this.code = c; this.headersSent = true; }, end(b) { this.body = b ? JSON.parse(b) : null; this.writableEnded = true; } };
  const req = { method, url, on(ev, fn) { if (ev === 'data' && body) queueMicrotask(() => fn(Buffer.from(JSON.stringify(body)))); if (ev === 'end') queueMicrotask(() => queueMicrotask(fn)); } };
  await router.handle(req, res, new URL(url, 'http://x'));
  return res;
};
function routes(initial = {}) {
  const box = { state: initial };
  const router = createRouter();
  register(router, { getState: () => box.state, saveState: s => { box.state = s; } });
  return { box, call: caller(router) };
}
// Every file below a folder with its bytes and mtime, so "writes nothing" can be checked.
function snapshot(dir) {
  const out = {};
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name), f = path.join(dir, r);
      if (e.isDirectory()) { out[r + '/'] = true; walk(r); }
      else out[r] = `${fs.readFileSync(f, 'base64')} ${fs.statSync(f).mtimeMs}`;
    }
  };
  walk('');
  return out;
}
const files = dir => Object.keys(snapshot(dir)).sort();
const mkdir = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

test('resolver: DECK_VAULT, else vault.path, else ~/vault when it exists, else none', () => {
  const h = mkdir('r-home'), set = mkdir('r-set'), envDir = path.join(tmp, 'r-env');
  const state = { vault: { path: set } };
  assert.deepEqual(resolveVault({ env: {}, state: {}, home: h }), { path: null, source: null });
  fs.mkdirSync(path.join(h, 'vault'));
  assert.deepEqual(resolveVault({ env: {}, state: {}, home: h }), { path: path.join(h, 'vault'), source: 'default' });
  assert.deepEqual(resolveVault({ env: {}, state, home: h }), { path: set, source: 'state' });
  assert.deepEqual(resolveVault({ env: { DECK_VAULT: envDir }, state, home: h }), { path: envDir, source: 'env' }, 'used as given, made on first write');
  assert.deepEqual(resolveVault({ env: {}, state: { vault: { path: '~/vault' } }, home: h }), { path: path.join(h, 'vault'), source: 'state' });
});

test('resolver: a recorded vault whose folder is gone resolves to none, never to ~/vault', () => {
  const h = path.dirname(mkdir('g-home', 'vault'));
  const gone = path.join(tmp, 'unplugged', 'vault');
  assert.deepEqual(resolveVault({ env: {}, state: { vault: { path: gone } }, home: h }), { path: null, source: 'state', missing: gone });
});

test('resolver: read on every call, from state.json when no state is passed', () => {
  assert.equal(vaultDir(), null);
  const v = mkdir('later');
  fs.mkdirSync(process.env.DECK_CONFIG, { recursive: true });
  fs.writeFileSync(path.join(process.env.DECK_CONFIG, 'state.json'), JSON.stringify({ vault: { path: v } }));
  assert.equal(vaultDir(), v, 'no restart, no cache');
  fs.rmSync(path.join(process.env.DECK_CONFIG, 'state.json'));
});

test('create: copies the template into the data folder once, records it, a second create is refused', async () => {
  const { box, call } = routes();
  assert.equal((await call('GET', '/api/vault')).body.path, null);
  const r = await call('POST', '/api/vault/create', {});
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const dest = path.join(process.env.DECK_DATA, 'vault');
  assert.equal(r.body.path, dest);
  assert.deepEqual(box.state.vault, { path: dest, created: true });
  assert.deepEqual(files(dest).filter(f => !f.startsWith('.git/')), files(templateDir()), 'every template file, empty folders included');
  assert.ok(fs.existsSync(path.join(dest, '.git')), 'and its first commit (test/vault/git.test.mjs)');
  for (const f of ['CLAUDE.md', 'Home.md', 'Boards/Work.md', '.gitignore', 'Daily/.gitkeep'])
    assert.equal(fs.readFileSync(path.join(dest, f), 'utf8'), fs.readFileSync(path.join(templateDir(), f), 'utf8'), f);
  assert.equal(vaultDir(box.state), dest);
  assert.deepEqual(fs.readdirSync(path.dirname(dest)).filter(f => f.startsWith('.deck-vault-')), [], 'no staging folder left');
  const again = await call('POST', '/api/vault/create', { path: path.join(tmp, 'second') });
  assert.equal(again.code, 409);
  assert.match(again.body.error, /already in use/);
  assert.ok(!fs.existsSync(path.join(tmp, 'second')));
});

test('create: refuses a folder that is not empty and leaves it as it was; an empty one is fine', async () => {
  const { box, call } = routes();
  const full = mkdir('full');
  fs.writeFileSync(path.join(full, 'CLAUDE.md'), 'my own manual\n');
  const before = snapshot(full);
  const r = await call('POST', '/api/vault/create', { path: full });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /not empty; Create writes only into a new or empty folder/);
  assert.deepEqual(snapshot(full), before, 'nothing written, nothing replaced');
  assert.equal(box.state.vault, undefined, 'nothing recorded');
  const empty = mkdir('empty');
  const ok = await call('POST', '/api/vault/create', { path: empty });
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.ok(fs.existsSync(path.join(empty, 'Boards', 'Work.md')));
});

test('adopt: records an existing folder and writes nothing into it', async () => {
  const { box, call } = routes({ other: 1 });
  const notes = path.dirname(mkdir('notes', 'Ideas'));
  fs.writeFileSync(path.join(notes, 'Ideas', 'one.md'), '# one\n');
  const before = snapshot(notes);
  const r = await call('POST', '/api/vault/adopt', { path: notes });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(snapshot(notes), before);
  assert.deepEqual(box.state, { other: 1, vault: { path: notes, created: false } });
  assert.equal((await call('GET', '/api/vault')).body.source, 'state');
  assert.equal((await call('POST', '/api/vault/adopt', { path: path.join(tmp, 'nope') })).code, 404);
  assert.equal((await call('POST', '/api/vault/adopt', { path: 'relative/notes' })).code, 400);
  assert.equal((await call('POST', '/api/vault/adopt', { path: '~' })).code, 400);
  assert.equal((await call('POST', '/api/vault/adopt', {})).code, 400);
});

test('create and adopt refuse while DECK_VAULT is set: it would win over what they record', async () => {
  const { box, call } = routes();
  process.env.DECK_VAULT = path.join(tmp, 'env-vault');
  try {
    assert.equal((await call('POST', '/api/vault/create', {})).code, 409);
    assert.equal((await call('POST', '/api/vault/adopt', { path: mkdir('env-adopt') })).code, 409);
    assert.equal(box.state.vault, undefined);
  } finally { delete process.env.DECK_VAULT; }
});

test('gateway: a vault created while Deck runs lights up capture and reaches a vault: true app, no restart', async () => {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const gw = mkdir('gw'), data = path.join(gw, 'data'), cfg = mkdir('gw', 'config'), gwHome = mkdir('gw', 'home');
  fs.writeFileSync(path.join(cfg, 'state.json'), '{"scanRoots":[]}');
  const app = path.join(data, 'apps', 'reader');
  fs.mkdirSync(app, { recursive: true });
  const out = path.join(gw, 'seen.json');
  fs.writeFileSync(path.join(app, 'deck.json'), JSON.stringify({ id: 'reader', name: 'Reader', cwd: '{app}', vault: true,
    cmd: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ vault: process.env.DECK_VAULT }))`] }));
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const { DECK_VAULT, ...env } = process.env;
  const child = spawn(process.execPath, [path.join(REPO, 'server.js')], { cwd: REPO, stdio: 'ignore',
    env: { ...env, HOME: gwHome, PORT: String(port), DECK_ROOT: REPO, DECK_CONFIG: cfg, DECK_DATA: data, DECK_NO_BACKGROUND: '1', DECK_HOST: '' } });
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { code: r.status, body: await r.json() };
  };
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/api/version`)).ok; } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.equal((await call('GET', '/api/config')).body.vault, false);
    assert.equal((await call('POST', '/api/vault/capture', { text: 'too early' })).code, 409, 'no vault: nothing is created');
    assert.ok(!fs.existsSync(path.join(gwHome, 'vault')));
    const c = await call('POST', '/api/vault/create', {});
    assert.equal(c.code, 200, JSON.stringify(c.body));
    const vault = path.join(data, 'vault');
    assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, 'state.json'), 'utf8')).vault.path, vault);
    assert.equal((await call('GET', '/api/config')).body.vault, true);
    assert.equal((await call('POST', '/api/vault/capture', { text: 'first thought' })).code, 200);
    assert.match(fs.readFileSync(path.join(vault, 'Daily', `${todayStr()}.md`), 'utf8'), /first thought/);
    assert.ok((await call('GET', '/api/vault/recent')).body.notes.some(n => n.path === path.join(vault, 'Home.md')), 'recent notes come from the new vault');
    assert.equal((await call('POST', '/api/tools/reader/start')).code, 200);
    for (let i = 0; i < 50 && !fs.existsSync(out); i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).vault, vault);
  } finally { child.kill('SIGKILL'); }
});

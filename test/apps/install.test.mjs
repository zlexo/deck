import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-apps-install-'));
process.env.DECK_DATA = path.join(tmp, 'data');
process.env.DECK_VAULT = path.join(tmp, 'vault');
const { install, update, remove, plan } = await import('../../lib/apps/install.mjs');
const { register, appDir, appDataDir, clearCatalog } = await import('../../lib/apps/index.mjs');
const { run } = await import('../../lib/core/proc.mjs');
const { tildify } = await import('../../lib/core/paths.mjs');
const { createRouter } = await import('../../lib/core/http.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

// A "GitHub" repo: a bare remote and a work copy that pushes to it.
function remoteApp(name, manifest) {
  const bare = path.join(tmp, `${name}.git`), work = path.join(tmp, `${name}-work`);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  git(tmp, 'clone', '-q', bare, work);
  git(work, 'config', 'user.email', 't@t'); git(work, 'config', 'user.name', 't');
  const commit = (files, msg, tag) => {
    for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(work, f), t);
    git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', msg);
    if (tag) git(work, 'tag', tag);
    git(work, 'push', '-q', '--tags', 'origin', 'HEAD:main');
    return git(work, 'rev-parse', 'HEAD');
  };
  commit({ 'deck.json': JSON.stringify(manifest), 'app.txt': 'one\n' }, 'first', 'v1.0.0');
  return { bare, work, commit };
}
const clone = remotes => (repo, dest) => run('git', ['clone', '--quiet', remotes[repo], dest]);
// The install step writes where it ran, so the test sees it ran in the final folder.
const STEP = [['node', '-e', "require('fs').writeFileSync('built.txt', process.cwd())"]];
const manifest = (id, install = STEP) => ({ id, name: id, cmd: ['node', 'x.js'], cwd: '{app}', install });
const entryOf = (id, latest, m = manifest(id)) => ({ repo: `zlexo/${id}`, branch: 'main', manifest: m, latest });

test('install: cloned, at the release, the install steps run in the final folder, recorded; a second install is refused', async () => {
  const r = remoteApp('hello', manifest('hello'));
  const rec = await install(entryOf('hello', { tag: 'v1.0.0', sha: null }), { clone: clone({ 'zlexo/hello': r.bare }) });
  const dir = appDir('hello');
  assert.equal(rec.version.tag, 'v1.0.0');
  assert.equal(rec.version.sha, git(dir, 'rev-parse', 'HEAD'));
  assert.equal(fs.realpathSync(fs.readFileSync(path.join(dir, 'built.txt'), 'utf8')), fs.realpathSync(dir), 'the step ran in the final folder, not the staging one');
  assert.deepEqual(fs.readdirSync(path.dirname(dir)).filter(f => f.startsWith('.')), [], 'no staging folder left');
  await assert.rejects(install(entryOf('hello', { tag: 'v1.0.0' }), { clone: clone({ 'zlexo/hello': r.bare }) }), e => e.status === 409);
  assert.deepEqual(plan(entryOf('hello', {})), [['gh', 'repo', 'clone', 'zlexo/hello', tildify(appDir('hello'))], ...STEP]);
});

test('install: a failing step names itself and leaves nothing behind', async () => {
  const bad = manifest('broken', [['node', '-e', 'process.exit(3)']]);
  const r = remoteApp('broken', bad);
  await assert.rejects(install(entryOf('broken', { tag: 'v1.0.0' }, bad), { clone: clone({ 'zlexo/broken': r.bare }) }), e => e.status === 502 && /install step failed \(node -e process.exit\(3\)\): exit 3/.test(e.message));
  assert.ok(!fs.existsSync(appDir('broken')));
});

test('update: to the new release with the steps run again; refused over local changes', async () => {
  const r = remoteApp('upd', manifest('upd'));
  const remotes = { 'zlexo/upd': r.bare };
  let rec = await install(entryOf('upd', { tag: 'v1.0.0' }), { clone: clone(remotes) });
  const sha2 = r.commit({ 'app.txt': 'two\n' }, 'second', 'v1.1.0');
  fs.writeFileSync(path.join(appDir('upd'), 'built.txt'), 'stale'); // the install's own output is not a local change
  rec = await update(entryOf('upd', { tag: 'v1.1.0' }), rec);
  assert.equal(rec.version.tag, 'v1.1.0');
  assert.equal(git(appDir('upd'), 'rev-parse', 'HEAD'), sha2);
  assert.notEqual(fs.readFileSync(path.join(appDir('upd'), 'built.txt'), 'utf8'), 'stale', 'install steps ran again');
  fs.writeFileSync(path.join(appDir('upd'), 'app.txt'), 'edited by hand\n');
  r.commit({ 'app.txt': 'three\n' }, 'third', 'v1.2.0');
  await assert.rejects(update(entryOf('upd', { tag: 'v1.2.0' }), rec), e => e.status === 409 && /local changes.*app\.txt/.test(e.message));
  assert.equal(fs.readFileSync(path.join(appDir('upd'), 'app.txt'), 'utf8'), 'edited by hand\n', 'nothing overwritten');
});

test('remove: the copy goes, its data stays unless asked; ids outside the apps folder are refused', async () => {
  const r = remoteApp('gone', manifest('gone'));
  await install(entryOf('gone', { tag: 'v1.0.0' }), { clone: clone({ 'zlexo/gone': r.bare }) });
  fs.mkdirSync(appDataDir('gone'), { recursive: true });
  fs.writeFileSync(path.join(appDataDir('gone'), 'saved.json'), '{}');
  remove('gone');
  assert.ok(!fs.existsSync(appDir('gone')));
  assert.ok(fs.existsSync(path.join(appDataDir('gone'), 'saved.json')), 'data kept');
  await install(entryOf('gone', { tag: 'v1.0.0' }), { clone: clone({ 'zlexo/gone': r.bare }) });
  remove('gone', { purge: true });
  assert.ok(!fs.existsSync(appDataDir('gone')), 'purged on request');
  assert.throws(() => remove('../escape'), e => e.status === 400);
  assert.throws(() => remove('never-installed'), e => e.status === 404);
});

// Calls a route the way the gateway would, with an optional JSON body.
const caller = router => async (method, url, body) => {
  const res = { code: null, body: null, headersSent: false, writableEnded: false, writeHead(c) { this.code = c; this.headersSent = true; }, end(b) { this.body = b ? JSON.parse(b) : null; this.writableEnded = true; } };
  const req = { method, url, on(ev, fn) { if (ev === 'data' && body) queueMicrotask(() => fn(Buffer.from(JSON.stringify(body)))); if (ev === 'end') queueMicrotask(() => queueMicrotask(fn)); } };
  await router.handle(req, res, new URL(url, 'http://x'));
  return res;
};
// A fake gh that knows one app repo on zlexo, at release `latest()`.
const fakeGh = (name, latest) => async args => {
  if (args[0] === 'search') return [{ name, fullName: `zlexo/${name}`, description: '', updatedAt: '', isPrivate: true, url: `https://github.com/zlexo/${name}`, defaultBranch: 'main', isArchived: false }];
  if (/contents\/deck\.json/.test(args[1])) return { content: Buffer.from(JSON.stringify(manifest(name))).toString('base64') };
  if (/releases\/latest/.test(args[1])) return { tag_name: latest() };
  throw new Error(`unexpected gh ${args.join(' ')}`);
};

// The routes, with a fake gh behind the catalog and a cloner from local remotes.
test('routes: install records it in state, update moves it, a dev checkout is refused, remove forgets it', async () => {
  clearCatalog();
  const r = remoteApp('routed', manifest('routed'));
  let latest = 'v1.0.0';
  const gh = fakeGh('routed', () => latest);
  let state = { apps: { sources: ['zlexo'] } };
  let manifests = {};
  const ctx = { getState: () => state, saveState: s => { state = s; }, loadManifests: () => manifests };
  const router = createRouter();
  register(router, ctx, { gh, clone: clone({ 'zlexo/routed': r.bare }) });
  const call = caller(router);
  manifests = { routed: { id: 'routed', _dir: path.join(os.homedir(), 'code', 'routed') } };
  assert.equal((await call('POST', '/api/apps/install', { id: 'routed' })).code, 409, 'a dev checkout is used, not installed over');
  manifests = {};
  const inst = await call('POST', '/api/apps/install', { id: 'routed' });
  assert.equal(inst.code ?? 200, 200, JSON.stringify(inst.body));
  assert.equal(state.apps.installed.routed.version.tag, 'v1.0.0');
  assert.deepEqual(state.apps.sources, ['zlexo'], 'the rest of the state is kept');
  r.commit({ 'app.txt': 'new\n' }, 'new', 'v2.0.0'); latest = 'v2.0.0'; clearCatalog();
  const list = await call('GET', '/api/apps?refresh=1');
  assert.equal(list.body.apps[0].updateAvailable, true);
  await call('POST', '/api/apps/update', { id: 'routed' });
  assert.equal(state.apps.installed.routed.version.tag, 'v2.0.0');
  await call('POST', '/api/apps/remove', { id: 'routed' });
  assert.equal(state.apps.installed.routed, undefined);
  assert.ok(!fs.existsSync(appDir('routed')));
});

test('routes: an app whose id a tool of yours already has is shown as taken, and not installed', async () => {
  clearCatalog();
  const r = remoteApp('mine', manifest('mine'));
  let state = { apps: { sources: ['zlexo'] } };
  // a central manifest (config/tools): loaded without a _dir
  const manifests = { mine: { id: 'mine', name: 'My tool', cmd: ['node', 'own.js'], cwd: '~', _source: 'central' } };
  const ctx = { getState: () => state, saveState: s => { state = s; }, loadManifests: () => manifests };
  const router = createRouter();
  register(router, ctx, { gh: fakeGh('mine', () => 'v1.0.0'), clone: clone({ 'zlexo/mine': r.bare }) });
  const call = caller(router);
  const app = (await call('GET', '/api/apps?refresh=1')).body.apps[0];
  assert.equal(app.status, 'taken');
  assert.match(app.problem, /already has the id 'mine'/);
  const res = await call('POST', '/api/apps/install', { id: 'mine' });
  assert.equal(res.code, 409);
  assert.match(res.body.error, /rename or remove that tool's manifest/);
  assert.ok(!fs.existsSync(appDir('mine')), 'nothing cloned');
  assert.equal(state.apps.installed, undefined, 'nothing recorded');
});

test('gateway: a started app gets its data and packs folders, outside its own; only a vault: true app gets DECK_VAULT', async () => {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const { fileURLToPath } = await import('node:url');
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const data = path.join(tmp, 'gw-data'), cfg = path.join(tmp, 'gw-config');
  const dir = path.join(data, 'apps', 'envapp');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'state.json'), '{"scanRoots":[]}');
  const out = path.join(tmp, 'env-seen.json');
  fs.writeFileSync(path.join(dir, 'deck.json'), JSON.stringify({ id: 'envapp', name: 'Env', cwd: '{app}', data: true, packs: 'env-pack',
    cmd: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ data: process.env.DECK_APP_DATA, packs: process.env.DECK_APP_PACKS, vault: process.env.DECK_VAULT }))`] }));
  // The gateway runs with DECK_VAULT set: an app without vault: true must not inherit it.
  const vaultOut = path.join(tmp, 'vault-seen.json');
  fs.mkdirSync(path.join(data, 'apps', 'vaultapp'));
  fs.writeFileSync(path.join(data, 'apps', 'vaultapp', 'deck.json'), JSON.stringify({ id: 'vaultapp', name: 'Vault', cwd: '{app}', vault: true,
    cmd: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(vaultOut)}, JSON.stringify({ vault: process.env.DECK_VAULT }))`] }));
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, [path.join(REPO, 'server.js')], { cwd: REPO, stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DECK_ROOT: REPO, DECK_CONFIG: cfg, DECK_DATA: data, DECK_VAULT: path.join(tmp, 'vault'), DECK_NO_BACKGROUND: '1', DECK_HOST: '' } });
  try {
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) { try { ok = (await fetch(`http://127.0.0.1:${port}/api/version`)).ok; } catch { await new Promise(r => setTimeout(r, 100)); } }
    const r = await fetch(`http://127.0.0.1:${port}/api/tools/envapp/start`, { method: 'POST' });
    assert.equal(r.status, 200, await r.text());
    for (let i = 0; i < 50 && !fs.existsSync(out); i++) await new Promise(res => setTimeout(res, 100));
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(seen.data, path.join(data, 'app-data', 'envapp'));
    assert.equal(seen.packs, path.join(data, 'packs', 'envapp'));
    assert.ok(fs.statSync(seen.data).isDirectory() && fs.statSync(seen.packs).isDirectory(), 'made before the app starts');
    assert.equal(seen.vault, undefined, 'an app without vault: true does not see the vault');
    const v = await fetch(`http://127.0.0.1:${port}/api/tools/vaultapp/start`, { method: 'POST' });
    assert.equal(v.status, 200, await v.text());
    for (let i = 0; i < 50 && !fs.existsSync(vaultOut); i++) await new Promise(res => setTimeout(res, 100));
    assert.equal(JSON.parse(fs.readFileSync(vaultOut, 'utf8')).vault, path.join(tmp, 'vault'));
  } finally { child.kill('SIGKILL'); }
});

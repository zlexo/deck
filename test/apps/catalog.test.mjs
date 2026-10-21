import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-apps-'));
process.env.DECK_DATA = path.join(tmp, 'data');
process.env.DECK_VAULT = path.join(tmp, 'vault');
const { catalog, clearCatalog, manifestProblem, appsConfig } = await import('../../lib/apps/catalog.mjs');
const { statusOf, overview, appDir, appsDir } = await import('../../lib/apps/index.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => clearCatalog());

const b64 = obj => ({ content: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64') });
const notFound = () => { throw new Error('gh api: HTTP 404: Not Found'); };
const school = { id: 'school', name: 'School', cmd: ['node', 'serve.js'], cwd: '{app}', install: [['npm', 'ci']], packs: 'school-pack' };

// A gh that answers the search and the contents, releases and commits calls.
function fakeGh({ repos, files = {}, releases = {}, heads = {} }) {
  const calls = [];
  async function gh(args) {
    calls.push(args.join(' '));
    if (args[0] === 'search') return repos[args[args.indexOf('--owner') + 1]] || [];
    const m = /^repos\/([^/]+\/[^/]+)\/(contents\/deck\.json|releases\/latest|commits\/(.+))/.exec(args[1]);
    if (!m) throw new Error(`unexpected gh ${args.join(' ')}`);
    if (m[2].startsWith('contents')) return files[m[1]] !== undefined ? b64(files[m[1]]) : notFound();
    if (m[2] === 'releases/latest') return releases[m[1]] ? { tag_name: releases[m[1]] } : notFound();
    return { sha: heads[m[1]] || 'f'.repeat(40) };
  }
  gh.calls = calls;
  return gh;
}
const repo = (name, extra = {}) => ({ name, fullName: `zlexo/${name}`, description: `${name} repo`, updatedAt: '2026-10-21T00:00:00Z', isPrivate: true, url: `https://github.com/zlexo/${name}`, defaultBranch: 'main', isArchived: false, ...extra });

test('manifest: what makes a deck.json an app', () => {
  assert.equal(manifestProblem(school), null);
  assert.match(manifestProblem([]), /not a JSON object/);
  assert.match(manifestProblem({ ...school, id: 'Bad Id' }), /needs an id/);
  assert.match(manifestProblem({ ...school, cmd: [] }), /needs a cmd/);
  assert.match(manifestProblem({ ...school, install: ['npm ci'] }), /list of commands/);
  assert.match(manifestProblem({ ...school, packs: 'Not A Topic' }), /topic name/);
  assert.equal(manifestProblem({ ...school, vault: true }), null);
  assert.match(manifestProblem({ ...school, vault: 'yes' }), /vault must be true or false/);
});

test('sources: only owner names from state.json, none by default', () => {
  assert.deepEqual(appsConfig({}).sources, []);
  assert.deepEqual(appsConfig({ apps: { sources: ['zlexo', 'bad name', '', 42, 'some-org'] } }).sources, ['zlexo', 'some-org']);
});

test('catalog: tagged repos with their manifest problems, archived ones left out, one id per app, the newest version', async () => {
  const gh = fakeGh({
    repos: { zlexo: [repo('school'), repo('no-manifest'), repo('broken'), repo('old', { isArchived: true }), repo('school-copy')] },
    files: { 'zlexo/school': school, 'zlexo/broken': { id: 'broken', name: 'Broken' }, 'zlexo/school-copy': school },
    releases: { 'zlexo/school': 'v1.2.0' }, heads: { 'zlexo/school-copy': 'a'.repeat(40) },
  });
  const c = await catalog({ state: { apps: { sources: ['zlexo'] } }, gh });
  const by = Object.fromEntries(c.apps.map(a => [a.name, a]));
  assert.deepEqual(Object.keys(by), ['school', 'no-manifest', 'broken', 'school-copy']);
  assert.equal(by.school.problem, null);
  assert.deepEqual(by.school.latest, { tag: 'v1.2.0', sha: null });
  assert.equal(by['no-manifest'].problem, 'no deck.json at the repo root');
  assert.match(by.broken.problem, /needs a cmd/);
  assert.match(by['school-copy'].problem, /already used by zlexo\/school/);
  assert.ok(gh.calls.some(c => c.includes('--topic deck-app')));
});

test('catalog: cached ten minutes, a refresh asks again, and a failing owner is an error, not a crash', async () => {
  const gh = fakeGh({ repos: { zlexo: [repo('school')] }, files: { 'zlexo/school': school } });
  const state = { apps: { sources: ['zlexo'] } };
  await catalog({ state, gh, now: 1000 });
  const n = gh.calls.length;
  await catalog({ state, gh, now: 1000 + 5 * 60e3 });
  assert.equal(gh.calls.length, n, 'served from the cache');
  await catalog({ state, gh, now: 1000 + 5 * 60e3, refresh: true });
  assert.ok(gh.calls.length > n);
  const failing = async () => { throw new Error('gh search repos: HTTP 502'); };
  const c = await catalog({ state: { apps: { sources: ['zlexo'] } }, gh: failing, refresh: true });
  assert.deepEqual(c.apps, []);
  assert.match(c.errors[0], /^zlexo: .*502/);
});

test('status: installed by Deck (with an update badge), a dev checkout of yours, or available', () => {
  const entry = { manifest: school, latest: { tag: 'v1.2.0', sha: null } };
  fs.mkdirSync(path.join(appDir('school'), '.git'), { recursive: true });
  const installed = { school: { repo: 'zlexo/school', version: { tag: 'v1.1.0', sha: null } } };
  const s = statusOf(entry, { installed, manifests: {} });
  assert.equal(s.status, 'installed');
  assert.equal(s.version, 'v1.1.0');
  assert.equal(s.updateAvailable, true);
  assert.equal(statusOf(entry, { installed: { school: { version: { tag: 'v1.2.0' } } }, manifests: {} }).updateAvailable, false);
  const dev = statusOf(entry, { installed: {}, manifests: { school: { id: 'school', _dir: path.join(os.homedir(), 'code', 'school') } } });
  assert.deepEqual(dev, { status: 'dev', dir: '~/code/school', latest: 'v1.2.0' });
  const inApps = statusOf(entry, { installed: {}, manifests: { school: { id: 'school', _dir: appDir('school') } } });
  assert.equal(inApps.status, 'available', 'a folder in the apps dir that Deck did not record is not a dev checkout');
  assert.equal(statusOf({ manifest: null }, { installed: {}, manifests: {} }).status, 'unusable');
});

test('overview: the catalog with statuses, through the state the gateway holds', async () => {
  const gh = fakeGh({ repos: { zlexo: [repo('school')] }, files: { 'zlexo/school': school }, releases: { 'zlexo/school': 'v1.2.0' } });
  const ctx = { getState: () => ({ apps: { sources: ['zlexo'] } }), loadManifests: () => ({}) };
  const o = await overview(ctx, { gh });
  assert.equal(o.topic, 'deck-app');
  assert.deepEqual(o.apps.map(a => [a.id, a.status, a.latest, a.packs]), [['school', 'available', 'v1.2.0', 'school-pack']]);
  assert.deepEqual(o.apps[0].install, [['npm', 'ci']]);
});

// The real gateway: an app in the apps folder is a tool, with {app} as its folder.
test('gateway: an installed app is discovered from the apps folder, {app} filled in', async () => {
  const data = path.join(tmp, 'gw-data');
  const dir = path.join(data, 'apps', 'hello');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'deck.json'), JSON.stringify({ id: 'hello', name: 'Hello', cmd: ['node', 'server.js'], cwd: '{app}', paths: { Folder: '{app}' } }));
  const cfg = path.join(tmp, 'gw-config');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'state.json'), '{"scanRoots":[]}');
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, [path.join(REPO, 'server.js')], {
    cwd: REPO, env: { ...process.env, PORT: String(port), DECK_ROOT: REPO, DECK_CONFIG: cfg, DECK_DATA: data, DECK_VAULT: path.join(tmp, 'vault'), DECK_NO_BACKGROUND: '1', DECK_HOST: '' }, stdio: 'ignore',
  });
  try {
    let tools;
    for (let i = 0; i < 100 && !tools; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/tools`); if (r.ok) tools = (await r.json()).tools; } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.ok(tools, 'server did not start');
    const hello = tools.find(t => t.id === 'hello');
    assert.ok(hello, tools.map(t => t.id).join(','));
    assert.equal(hello.cwd, dir);
    assert.equal(hello.paths.Folder, dir);
    const apps = await (await fetch(`http://127.0.0.1:${port}/api/apps`)).json();
    assert.deepEqual(apps.sources, [], 'no sources configured: nothing to list');
  } finally { child.kill('SIGKILL'); }
});

test('sources: watched and unwatched through the gateway, which owns state.json', async () => {
  const { register } = await import('../../lib/apps/index.mjs');
  const { createRouter } = await import('../../lib/core/http.mjs');
  let state = { other: 1 };
  const router = createRouter();
  register(router, { getState: () => state, saveState: s => { state = s; }, loadManifests: () => ({}) }, { gh: async () => [] });
  const call = async body => {
    const res = { code: 200, body: null, headersSent: false, writableEnded: false, writeHead(c) { this.code = c; this.headersSent = true; }, end(b) { this.body = b ? JSON.parse(b) : null; this.writableEnded = true; } };
    const req = { method: 'POST', url: '/api/apps/sources', on(ev, fn) { if (ev === 'data') queueMicrotask(() => fn(Buffer.from(JSON.stringify(body)))); if (ev === 'end') queueMicrotask(() => queueMicrotask(fn)); } };
    await router.handle(req, res, new URL('/api/apps/sources', 'http://x'));
    return res;
  };
  assert.deepEqual((await call({ add: 'zlexo' })).body.sources, ['zlexo']);
  assert.deepEqual((await call({ add: 'zlexo' })).body.sources, ['zlexo'], 'once');
  assert.deepEqual((await call({ add: 'some-org' })).body.sources, ['zlexo', 'some-org']);
  assert.deepEqual((await call({ remove: 'zlexo' })).body.sources, ['some-org']);
  assert.equal((await call({ add: 'not an owner' })).code, 400);
  assert.equal(state.other, 1, 'the rest of the state is kept');
});

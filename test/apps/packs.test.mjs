import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-apps-packs-'));
process.env.DECK_DATA = path.join(tmp, 'data');
process.env.DECK_VAULT = path.join(tmp, 'vault');
const { register, clearCatalog, packProblem, packDir, appDir } = await import('../../lib/apps/index.mjs');
const { packWhere } = await import('../../lib/apps/install.mjs');
const { run } = await import('../../lib/core/proc.mjs');
const { createRouter } = await import('../../lib/core/http.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
function remote(name, files) {
  const bare = path.join(tmp, `${name}.git`), work = path.join(tmp, `${name}-work`);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare); git(tmp, 'clone', '-q', bare, work);
  git(work, 'config', 'user.email', 't@t'); git(work, 'config', 'user.name', 't');
  const commit = (fl, msg, tag) => { for (const [f, t] of Object.entries(fl)) { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), t); } git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', msg); if (tag) git(work, 'tag', tag); git(work, 'push', '-q', '--tags', 'origin', 'HEAD:main'); };
  commit(files, 'first', 'v1.0.0');
  return { bare, commit };
}

test('pack.json: an id, a title, and the app it is for', () => {
  assert.equal(packProblem({ id: 'asp-2026', title: 'ASP', app: 'school' }, 'school'), null);
  assert.match(packProblem({ id: 'asp-2026', title: 'ASP', app: 'other' }, 'school'), /is for 'other', not 'school'/);
  assert.match(packProblem({ id: 'Bad', title: 'x', app: 'school' }, 'school'), /needs an id/);
  assert.match(packProblem({ id: 'x', app: 'school' }, 'school'), /needs a title/);
  assert.throws(() => packWhere('school', '../x'), e => e.status === 400);
});

test('packs: listed under an app that is here, installed into the packs folder, updated, removed', async () => {
  clearCatalog();
  const app = { id: 'school', name: 'School', cmd: ['node', 'serve.js'], cwd: '{app}', packs: 'school-pack' };
  const appRemote = remote('school', { 'deck.json': JSON.stringify(app) });
  const packRemote = remote('school-asp', { 'pack.json': JSON.stringify({ id: 'asp-2026', title: 'ASP 2026', app: 'school' }), 'sessions/asp.js': 'one' });
  const remotes = { 'zlexo/school': appRemote.bare, 'zlexo/school-asp': packRemote.bare };
  let packTag = 'v1.0.0';
  const repoRow = n => ({ name: n, fullName: `zlexo/${n}`, description: '', updatedAt: '', isPrivate: true, url: `https://github.com/zlexo/${n}`, defaultBranch: 'main', isArchived: false });
  const b64 = o => ({ content: Buffer.from(JSON.stringify(o)).toString('base64') });
  const gh = async args => {
    if (args[0] === 'search') return args.includes('school-pack') ? [repoRow('school-asp')] : [repoRow('school')];
    if (/school\/contents\/deck\.json/.test(args[1])) return b64(app);
    if (/school-asp\/contents\/pack\.json/.test(args[1])) return b64({ id: 'asp-2026', title: 'ASP 2026', app: 'school' });
    if (/school-asp\/releases\/latest/.test(args[1])) return { tag_name: packTag };
    if (/school\/releases\/latest/.test(args[1])) return { tag_name: 'v1.0.0' };
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  let state = { apps: { sources: ['zlexo'] } };
  const ctx = { getState: () => state, saveState: s => { state = s; }, loadManifests: () => ({}) };
  const router = createRouter();
  register(router, ctx, { gh, clone: (repo, dest) => run('git', ['clone', '--quiet', remotes[repo], dest]) });
  const call = async (method, url, body) => {
    const res = { code: 200, body: null, headersSent: false, writableEnded: false, writeHead(c) { this.code = c; this.headersSent = true; }, end(b) { this.body = b ? JSON.parse(b) : null; this.writableEnded = true; } };
    const req = { method, url, on(ev, fn) { if (ev === 'data' && body) queueMicrotask(() => fn(Buffer.from(JSON.stringify(body)))); if (ev === 'end') queueMicrotask(() => queueMicrotask(fn)); } };
    await router.handle(req, res, new URL(url, 'http://x'));
    return res;
  };
  let o = (await call('GET', '/api/apps')).body;
  assert.deepEqual(o.apps[0].packList, [], 'packs are listed only for an app that is here');
  assert.equal((await call('POST', '/api/apps/install', { id: 'school' })).code, 200);
  clearCatalog();
  o = (await call('GET', '/api/apps')).body;
  assert.deepEqual(o.apps[0].packList.map(p => [p.id, p.status, p.latest]), [['asp-2026', 'available', 'v1.0.0']]);
  const inst = await call('POST', '/api/apps/packs/install', { app: 'school', id: 'asp-2026' });
  assert.equal(inst.code, 200, JSON.stringify(inst.body));
  assert.equal(fs.readFileSync(path.join(packDir('school', 'asp-2026'), 'sessions', 'asp.js'), 'utf8'), 'one');
  assert.ok(!fs.existsSync(path.join(appDir('school'), 'packs')), 'packs live outside the app folder');
  assert.equal(state.apps.packs.school['asp-2026'].version.tag, 'v1.0.0');
  packRemote.commit({ 'sessions/asp.js': 'two' }, 'M5 sessions', 'v1.1.0'); packTag = 'v1.1.0'; clearCatalog();
  o = (await call('GET', '/api/apps')).body;
  assert.equal(o.apps[0].packList[0].updateAvailable, true, 'the badge after the author publishes');
  assert.equal((await call('POST', '/api/apps/packs/update', { app: 'school', id: 'asp-2026' })).code, 200);
  assert.equal(fs.readFileSync(path.join(packDir('school', 'asp-2026'), 'sessions', 'asp.js'), 'utf8'), 'two');
  assert.equal((await call('POST', '/api/apps/packs/remove', { app: 'school', id: 'asp-2026' })).code, 200);
  assert.ok(!fs.existsSync(packDir('school', 'asp-2026')));
  assert.deepEqual(state.apps.packs.school, {});
  assert.equal((await call('POST', '/api/apps/packs/install', { app: 'school', id: 'nope' })).code, 404);
});

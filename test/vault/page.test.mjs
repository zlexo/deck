// The Vault page's read routes: the board, the apps that use the vault and
// their status line, Open in Obsidian.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-vault-page-')));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
process.env.DECK_DATA = path.join(tmp, 'data');
process.env.DECK_CONFIG = path.join(tmp, 'config');
delete process.env.DECK_VAULT;
const { parseBoard, register, obsidianUrl } = await import('../../lib/vault/page.mjs');
const { createRouter } = await import('../../lib/core/http.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const caller = router => async (method, url) => {
  const res = { code: 200, body: null, headersSent: false, writableEnded: false, writeHead(c) { this.code = c; this.headersSent = true; }, end(b) { this.body = b ? JSON.parse(b) : null; this.writableEnded = true; } };
  const req = { method, url, on(ev, fn) { if (ev === 'end') queueMicrotask(fn); } };
  await router.handle(req, res, new URL(url, 'http://x'));
  return res;
};
function routes(ctx, deps) {
  const router = createRouter();
  register(router, { getState: () => ({}), ...ctx }, deps);
  return caller(router);
}
const vaultWith = (name, files = {}) => {
  const v = path.join(tmp, name);
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(v, f)), { recursive: true }); fs.writeFileSync(path.join(v, f), text); }
  fs.mkdirSync(v, { recursive: true });
  return v;
};

test('board: the template board parses into its five columns and its starter card', () => {
  const cols = parseBoard(fs.readFileSync(path.join(REPO, 'templates', 'vault', 'Boards', 'Work.md'), 'utf8'));
  assert.deepEqual(cols.map(c => c.title), ['Backlog', 'This Week', 'In Progress', 'Waiting On', 'Done']);
  assert.deepEqual(cols[0].cards, [{ title: 'Vault: write a note for your first project from Templates/Project.md and link it from Home', done: false }]);
  assert.equal(cols.slice(1).reduce((n, c) => n + c.cards.length, 0), 0);
});

test('board: cards are top-level checkboxes; details, archive and settings are not', () => {
  const text = [
    '---', 'kanban-plugin: board', '---', '',
    '## In Progress', '- [ ] **Fix** the [[Login Bug|login bug]]', '\t- [ ] a sub-step, not a card', '  more detail', '- a plain line',
    '## Done', '- [x] Ship [[Release]]', '',
    '***', '', '## Archive', '- [x] old card', '',
    '%% kanban:settings', '```', '{"kanban-plugin":"board"}', '```', '%%',
  ].join('\r\n');
  assert.deepEqual(parseBoard(text), [
    { title: 'In Progress', cards: [{ title: 'Fix the login bug', done: false }] },
    { title: 'Done', cards: [{ title: 'Ship Release', done: true }] },
  ]);
});

test('board route: 409 without a vault, the columns with one, exists:false without the file', async () => {
  delete process.env.DECK_VAULT;
  assert.equal((await routes({})('GET', '/api/vault/board')).code, 409);
  const v = vaultWith('v-board', { 'Boards/Work.md': '## Backlog\n- [ ] one\n- [ ] two\n' });
  const state = { vault: { path: v } };
  const r = await routes({ getState: () => state })('GET', '/api/vault/board');
  assert.deepEqual(r.body, { file: path.join('Boards', 'Work.md'), exists: true, columns: [{ title: 'Backlog', cards: [{ title: 'one', done: false }, { title: 'two', done: false }] }] });
  const bare = { vault: { path: vaultWith('v-bare') } };
  assert.deepEqual((await routes({ getState: () => bare })('GET', '/api/vault/board')).body, { file: path.join('Boards', 'Work.md'), exists: false, columns: [] });
});

test('apps route: only vault:true apps, each with its status line from its own route', async t => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/status') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ status: 'index current, 2 duplicate pairs' })); }
    if (req.url === '/plain') return res.end('ok\nsecond line');
    res.statusCode = 500; res.end('no');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const manifests = {
    atlas: { id: 'atlas', name: 'Atlas', vault: true, url: base, status: '/api/status' },
    notes: { id: 'notes', name: 'Notes', vault: true, url: base, status: '/plain' },
    quiet: { id: 'quiet', name: 'Quiet', vault: true, url: base },
    broken: { id: 'broken', name: 'Broken', vault: true, url: base, status: '/nope' },
    away: { id: 'away', name: 'Away', vault: true, url: 'http://example.com/', status: '/api/status' },
    down: { id: 'down', name: 'Down', vault: true, url: 'http://127.0.0.1:1/', status: '/api/status' },
    other: { id: 'other', name: 'Other', url: base, status: '/api/status' },
    falsy: { id: 'falsy', name: 'Falsy', vault: 'yes', url: base },
  };
  const r = await routes({ loadManifests: () => manifests, toolUrl: m => m.url })('GET', '/api/vault/apps');
  const by = Object.fromEntries(r.body.apps.map(a => [a.id, [a.status, a.statusError]]));
  assert.deepEqual(r.body.apps.map(a => a.id), ['atlas', 'away', 'broken', 'down', 'notes', 'quiet'], 'only vault:true, by name');
  assert.deepEqual(by, {
    atlas: ['index current, 2 duplicate pairs', null],
    notes: ['ok', null],
    quiet: [null, null],
    broken: [null, 'status route answered 500'],
    away: [null, 'the status route is not on this Mac'],
    down: [null, 'not running'],
  });
});

test('obsidian route: opens obsidian://open with the vault path encoded; 409 and nothing opened without a vault', async () => {
  const opened = [];
  delete process.env.DECK_VAULT;
  assert.equal((await routes({}, { open: u => opened.push(u) })('POST', '/api/vault/obsidian')).code, 409);
  assert.deepEqual(opened, []);
  const v = vaultWith('my vault');
  const state = { vault: { path: v } };
  const r = await routes({ getState: () => state }, { open: u => opened.push(u) })('POST', '/api/vault/obsidian');
  assert.deepEqual(opened, [`obsidian://open?path=${encodeURIComponent(v)}`]);
  assert.equal(r.body.url, opened[0]);
  assert.match(obsidianUrl('/a b/c'), /^obsidian:\/\/open\?path=%2Fa%20b%2Fc$/);
});

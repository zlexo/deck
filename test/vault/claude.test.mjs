import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Never this machine's ~/.claude: a home and a Claude config folder of their own.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-vault-claude-')));
const home = path.join(tmp, 'home');
process.env.HOME = home;
process.env.DECK_DATA = path.join(tmp, 'data');
process.env.DECK_CONFIG = path.join(tmp, 'config');
const cfg = path.join(tmp, 'claude config');
process.env.CLAUDE_CONFIG_DIR = cfg;
const vault = path.join(tmp, 'my vault');
process.env.DECK_VAULT = vault;
const { claudeConfigDir, rulesText, MARK } = await import('../../lib/vault/claude.mjs');
const { register } = await import('../../lib/vault/index.mjs');
const { createRouter } = await import('../../lib/core/http.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function routes(state = {}) {
  const router = createRouter();
  register(router, { getState: () => state, saveState: () => { throw new Error('Connect keeps nothing in state.json'); } });
  return async (method, url, body) => {
    const res = { code: null, body: null, headersSent: false, writableEnded: false, writeHead(c) { this.code = c; this.headersSent = true; }, end(b) { this.body = b ? JSON.parse(b) : null; this.writableEnded = true; } };
    const req = { method, url, on(ev, fn) { if (ev === 'data' && body) queueMicrotask(() => fn(Buffer.from(JSON.stringify(body)))); if (ev === 'end') queueMicrotask(() => queueMicrotask(fn)); } };
    await router.handle(req, res, new URL(url, 'http://x'));
    return res;
  };
}
const settings = path.join(cfg, 'settings.json'), rules = path.join(cfg, 'rules', 'deck-vault.md');
const backups = () => fs.readdirSync(cfg).filter(f => f.startsWith('settings.json.deck-'));
const read = f => fs.readFileSync(f, 'utf8');
// Every file below the config folder with its bytes and mtime.
function snapshot(dir = cfg) {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[f] = `${fs.readFileSync(f, 'base64')} ${fs.statSync(f).mtimeMs}`; } };
  walk(dir);
  return out;
}
// Hand-written: four-space indent, no final newline, keys Deck must not touch.
const ORIGINAL = '{\n    "model": "opus",\n    "permissions": {\n        "allow": ["Bash(npm test)"],\n        "additionalDirectories": ["~/notes"]\n    },\n    "hooks": { "Stop": [] },\n    "env": { "A": "1" }\n}';

beforeEach(() => {
  fs.rmSync(cfg, { recursive: true, force: true });
  fs.mkdirSync(cfg, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = cfg;
});

test('config folder: CLAUDE_CONFIG_DIR, else state.json claude.configDir, else ~/.claude', () => {
  const h = '/h';
  assert.deepEqual(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '/c' }, state: { claude: { configDir: '/s' } }, home: h }), { path: '/c', source: 'env' });
  assert.deepEqual(claudeConfigDir({ env: {}, state: { claude: { configDir: '~/cc' } }, home: h }), { path: '/h/cc', source: 'state' });
  assert.deepEqual(claudeConfigDir({ env: {}, state: {}, home: h }), { path: '/h/.claude', source: 'default' });
});

test('connect: writes into claude.configDir from state.json when CLAUDE_CONFIG_DIR is unset, never ~/.claude', async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  const other = path.join(tmp, 'from-state');
  try {
    const r = await routes({ claude: { configDir: other } })('POST', '/api/vault/connect', {});
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.ok(fs.existsSync(path.join(other, 'rules', 'deck-vault.md')));
    assert.ok(!fs.existsSync(path.join(home, '.claude')));
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
});

test('connect: keeps every other settings key, adds the vault and auto memory, backs up the old bytes', async () => {
  fs.writeFileSync(settings, ORIGINAL);
  const r = await routes()('POST', '/api/vault/connect', {});
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const now = JSON.parse(read(settings)), was = JSON.parse(ORIGINAL);
  assert.deepEqual(now.permissions.additionalDirectories, ['~/notes', vault]);
  assert.equal(now.autoMemoryDirectory, path.join(vault, 'Memory'));
  delete now.autoMemoryDirectory;
  now.permissions.additionalDirectories.pop();
  assert.deepEqual(now, was, 'nothing else touched');
  assert.match(read(settings), /^ {4}"model"/m, 'the file keeps its indent');
  assert.equal(backups().length, 1);
  assert.equal(read(path.join(cfg, backups()[0])), ORIGINAL, 'the backup holds the old bytes');
  assert.equal(r.body.backup, path.join(cfg, backups()[0]));
  assert.equal(read(rules), rulesText(vault));
  assert.ok(read(rules).includes(`@${vault.replace(' ', '\\ ')}/CLAUDE.md`), 'the space in the import is escaped');
  assert.deepEqual(r.body.changes.map(c => c.path).sort(), [rules, settings].sort());
  assert.equal(r.body.changes.find(c => c.path === settings).before, ORIGINAL);
  assert.equal(r.body.changes.find(c => c.path === rules).before, null);
  const st = r.body.status;
  assert.equal(st.connected, true);
  assert.deepEqual(st.rulesFile, { path: rules, ours: true });
  assert.equal(st.autoMemory.on, true);
});

test('connect: a second Connect changes nothing; a dry run writes nothing', async () => {
  fs.writeFileSync(settings, ORIGINAL);
  const call = routes();
  const dry = await call('POST', '/api/vault/connect', { dryRun: true });
  assert.equal(dry.code, 200);
  assert.equal(dry.body.changes.length, 2);
  assert.equal(read(settings), ORIGINAL);
  assert.ok(!fs.existsSync(rules) && !backups().length, 'dry run: no rules file, no backup');
  assert.equal((await call('POST', '/api/vault/connect', {})).code, 200);
  const before = snapshot();
  const again = await call('POST', '/api/vault/connect', {});
  assert.equal(again.code, 200);
  assert.deepEqual(again.body.changes, []);
  assert.equal(again.body.backup, null);
  assert.deepEqual(snapshot(), before, 'no write, no second backup');
});

test('connect: unparsable settings are refused with the lines to paste; nothing is written', async () => {
  fs.writeFileSync(settings, '{ "model": "opus", }');
  const before = snapshot();
  const r = await routes()('POST', '/api/vault/connect', {});
  assert.equal(r.code, 409);
  assert.match(r.body.error, /does not parse/);
  assert.ok(r.body.error.includes(`"additionalDirectories": [${JSON.stringify(vault)}]`));
  assert.ok(r.body.error.includes(`"autoMemoryDirectory": ${JSON.stringify(path.join(vault, 'Memory'))}`));
  assert.deepEqual(snapshot(), before);
});

test('connect: a rules file Deck did not write is refused; auto memory sent elsewhere is not taken over', async () => {
  fs.mkdirSync(path.dirname(rules));
  fs.writeFileSync(rules, 'my own rules\n');
  const call = routes();
  let before = snapshot();
  const r = await call('POST', '/api/vault/connect', {});
  assert.equal(r.code, 409);
  assert.match(r.body.error, /Deck did not write it/);
  assert.deepEqual(snapshot(), before);
  fs.rmSync(rules);
  fs.writeFileSync(settings, '{ "autoMemoryDirectory": "~/elsewhere" }\n');
  before = snapshot();
  assert.equal((await call('POST', '/api/vault/connect', {})).code, 409);
  assert.deepEqual(snapshot(), before);
  const off = await call('POST', '/api/vault/connect', { autoMemory: false });
  assert.equal(off.code, 200, JSON.stringify(off.body));
  assert.equal(JSON.parse(read(settings)).autoMemoryDirectory, '~/elsewhere');
});

test('disconnect: settings.json equals its backup byte for byte and the rules file is gone', async () => {
  fs.writeFileSync(settings, ORIGINAL);
  const call = routes();
  assert.equal((await call('POST', '/api/vault/connect', {})).code, 200);
  const r = await call('POST', '/api/vault/disconnect');
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(read(settings), ORIGINAL);
  assert.equal(read(path.join(cfg, backups()[0])), ORIGINAL);
  assert.ok(!fs.existsSync(rules));
  assert.deepEqual(r.body.restored.sort(), [rules, settings].sort());
  assert.equal(r.body.status.connected, false);
});

test('disconnect: no settings.json before means none after; a key added since stays', async () => {
  const call = routes();
  await call('POST', '/api/vault/connect', {});
  assert.equal(read(path.join(cfg, backups()[0])), '', 'an empty backup: there was no file');
  await call('POST', '/api/vault/disconnect');
  assert.ok(!fs.existsSync(settings));
  fs.writeFileSync(settings, ORIGINAL);
  await call('POST', '/api/vault/connect', {});
  const s = JSON.parse(read(settings));
  s.theme = 'dark';
  fs.writeFileSync(settings, JSON.stringify(s, null, 2) + '\n');
  await call('POST', '/api/vault/disconnect');
  assert.deepEqual(JSON.parse(read(settings)), { ...JSON.parse(ORIGINAL), theme: 'dark' });
});

test('status: auto memory files that stop loading are counted under projects/*/memory/', async () => {
  for (const [p, n] of [['-a', 3], ['-b', 1]]) {
    const d = path.join(cfg, 'projects', p, 'memory');
    fs.mkdirSync(d, { recursive: true });
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `m${i}.md`), 'x');
  }
  fs.writeFileSync(path.join(cfg, 'projects', '-a', 'session.jsonl'), '{}');
  const r = await routes()('GET', '/api/vault/claude');
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.autoMemory, { on: false, dir: null, stopLoading: 4 });
  assert.equal(r.body.connected, false);
  assert.equal(r.body.rulesFile, null);
  assert.equal(r.body.configDir, cfg);
  assert.ok(MARK.startsWith('<!--'), 'the owner line is a comment Claude Code does not show');
});

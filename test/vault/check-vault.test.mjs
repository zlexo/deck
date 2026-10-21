import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The live check's guards, run against a home of their own: the real folders
// it must never use are made here, each reached through a symlink, so a guard
// that let one through would write into this temp folder and nowhere else.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'check-vault.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-check-vault-')));
const home = path.join(tmp, 'home');
const mk = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
const claudeHome = mk(home, '.claude');
const deckHome = mk(home, 'Library', 'Application Support', 'Deck');
const vaultHome = mk(home, 'vault');
const shellConfig = mk(tmp, 'shell claude');
const link = (name, to) => { const l = path.join(tmp, name); fs.symlinkSync(to, l); return l; };
const toClaude = link('looks-like-a-cache', claudeHome);
const toDeck = link('another-cache', deckHome);
const toShell = link('third-cache', shellConfig);
const okData = path.join(tmp, 'ok', 'Application Support', 'Deck');
const okClaude = path.join(tmp, 'ok', 'claude');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function check(env) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|CHECK_VAULT)/.test(k)));
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...base, HOME: home, DECK_CLI: 'off', ...env }, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: r.stdout + r.stderr };
}
const empty = d => fs.readdirSync(d).length === 0;

const refused = [
  ['the Claude config is a symlink to ~/.claude', { CHECK_VAULT_DATA: okData, CHECK_VAULT_CLAUDE: toClaude }, /Claude Code's config folder: .*\.claude \(Claude Code's own config\)/],
  ['the Claude config is a folder inside ~/.claude', { CHECK_VAULT_DATA: okData, CHECK_VAULT_CLAUDE: path.join(toClaude, 'sub') }, /is .*\.claude \(Claude Code's own config\)/],
  ["Deck's data is a symlink to Deck's real data", { CHECK_VAULT_DATA: toDeck, CHECK_VAULT_CLAUDE: okClaude }, /Deck's data folder: .*\(Deck's own data\)/],
  ['the data folder is inside ~/vault', { CHECK_VAULT_DATA: path.join(vaultHome, 'x'), CHECK_VAULT_CLAUDE: okClaude }, /\(a real vault\)/],
  ['the data folder holds ~/vault', { CHECK_VAULT_DATA: path.join(home, '..'), CHECK_VAULT_CLAUDE: okClaude }, /holds .*\.claude|holds .*vault|holds .*Deck/],
  ['the data folder is the home folder', { CHECK_VAULT_DATA: home, CHECK_VAULT_CLAUDE: okClaude }, /is the home folder/],
  ["the data folder inside the shell's own CLAUDE_CONFIG_DIR", { CHECK_VAULT_DATA: path.join(toShell, 'data'), CHECK_VAULT_CLAUDE: okClaude, CLAUDE_CONFIG_DIR: shellConfig }, /the CLAUDE_CONFIG_DIR this shell uses/],
  ['the config inside the data folder (deleted every run)', { CHECK_VAULT_DATA: okData, CHECK_VAULT_CLAUDE: path.join(okData, 'claude') }, /overlap/],
];
for (const [name, env, why] of refused) {
  test(`check:vault refuses before touching anything: ${name}`, () => {
    const r = check(env);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /refused/, r.out);
    assert.match(r.out, why, r.out);
    for (const d of [claudeHome, deckHome, vaultHome, shellConfig]) assert.ok(empty(d), `${d} was written: ${fs.readdirSync(d)}`);
    assert.ok(!fs.existsSync(path.join(tmp, 'ok')), 'a folder of the check was made');
  });
}

test('check:vault passes the guards for its own folders, then stops at DECK_CLI=off', () => {
  const r = check({ CHECK_VAULT_DATA: okData, CHECK_VAULT_CLAUDE: okClaude, CLAUDE_CONFIG_DIR: okClaude });
  assert.equal(r.code, 2, r.out);
  assert.doesNotMatch(r.out, /refused/);
  assert.match(r.out, /DECK_CLI is off/);
  assert.ok(!fs.existsSync(path.join(tmp, 'ok')), 'nothing is made before the CLI is reached');
});

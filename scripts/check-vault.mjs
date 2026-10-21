// The live check for Deck Vault, against the real Claude Code on a throwaway
// login: Connect must put the vault's manual into a session started in any
// folder, Deck's own (kit) calls must never carry it, and after Disconnect no
// session may. It also measures whether a session started inside the vault
// loads the manual twice (as the project's CLAUDE.md and through the rules
// import) or once.
//
//   npm run check:vault [-- --skip connect|disconnect]
//
//   --skip connect      planted control: no Connect, so the first session
//                       must come back without the sentinel (red)
//   --skip disconnect   planted control: no Disconnect, so the last session
//                       still quotes the sentinel (red); the cleanup still
//                       disconnects
//
// Two folders, neither of them the real ones (the check refuses when either
// resolves into ~/.claude, ~/Library/Application Support/Deck or ~/vault, or
// into a CLAUDE_CONFIG_DIR inherited from the shell):
//   Deck's data   ~/.cache/deck-check/Application Support/Deck, deleted and
//                 made again on every run. The space is on purpose: a real
//                 vault sits under Application Support, and Claude Code's
//                 `@` import has to survive it.
//   Claude Code   ~/.cache/deck-check/claude, kept between runs: it holds a
//                 login made once by hand. The check only Connects and
//                 Disconnects it, and leaves settings.json as it found it.
// CHECK_VAULT_DATA and CHECK_VAULT_CLAUDE move them (the guard test does).
//
// Every claude call is one short haiku turn without tools, so the sentinel
// can only come from what the session loaded. Inherited CLAUDE_* and
// ANTHROPIC_* variables are dropped first: run from inside a Claude Code
// session they would change what the nested sessions load.
//
// Exit 0 passed, 1 failed, 2 not run (refused, not logged in).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside } from '../lib/core/paths.mjs';

const say = s => console.log(`check-vault: ${s}`);
const notRun = s => { console.error(`check-vault: ${s}`); process.exit(2); };

const argv = process.argv.slice(2);
const skipAt = argv.indexOf('--skip');
const SKIP = skipAt >= 0 ? argv[skipAt + 1] : null;
if (skipAt >= 0 && !['connect', 'disconnect'].includes(SKIP)) notRun(`--skip takes connect or disconnect, not ${SKIP}`);

// ---------------------------------------------------------------- guards
const HOME = os.homedir();
const DATA = path.resolve(process.env.CHECK_VAULT_DATA || path.join(HOME, '.cache', 'deck-check', 'Application Support', 'Deck'));
const CLAUDE_DIR = path.resolve(process.env.CHECK_VAULT_CLAUDE || path.join(HOME, '.cache', 'deck-check', 'claude'));

// A path with its symlinks resolved, also when its last parts do not exist yet.
function real(p) {
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch {}
    const up = path.dirname(cur);
    if (up === cur) return path.join(cur, ...rest.reverse());
    rest.push(path.basename(cur));
    cur = up;
  }
}

// Why `p` may not be used, or null. Refused: a folder that is one of the real
// ones, inside one, or holds one (deleting it would delete the real one too).
function refusal(p, { home = HOME, inherited = null } = {}) {
  const r = real(p);
  if (r === '/' || r === real(home)) return `${p} is ${r === '/' ? 'the disk root' : 'the home folder'}`;
  const real_ = [
    [path.join(home, '.claude'), "Claude Code's own config"],
    [path.join(home, 'Library', 'Application Support', 'Deck'), "Deck's own data"],
    [path.join(home, 'vault'), 'a real vault'],
    ...(inherited ? [[inherited, 'the CLAUDE_CONFIG_DIR this shell uses']] : []),
  ];
  for (const [dir, what] of real_) {
    const d = real(dir);
    if (isInside(r, d) || isInside(d, r)) return `${p} resolves to ${r}, which ${isInside(r, d) ? 'is' : 'holds'} ${dir} (${what})`;
  }
  return null;
}

const INHERITED = process.env.CLAUDE_CONFIG_DIR && real(process.env.CLAUDE_CONFIG_DIR) !== real(CLAUDE_DIR) ? process.env.CLAUDE_CONFIG_DIR : null;
for (const [p, name] of [[DATA, "Deck's data folder"], [CLAUDE_DIR, "Claude Code's config folder"]]) {
  const why = refusal(p, { inherited: INHERITED });
  if (why) notRun(`refused, ${name}: ${why}`);
}
if (isInside(real(CLAUDE_DIR), real(DATA)) || isInside(real(DATA), real(CLAUDE_DIR)))
  notRun(`refused: ${DATA} and ${CLAUDE_DIR} overlap, and the data folder is deleted on every run (the login would go with it)`);
if (/^(off|0|false|no)$/i.test(process.env.DECK_CLI || '')) notRun('DECK_CLI is off: this check needs the real claude CLI');

say(`data ${DATA}`);
say(`claude config ${CLAUDE_DIR}`);

// ---------------------------------------------------------------- preflight
// A clean environment for every claude this check starts, the kit's included.
for (const k of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC)/.test(k)) delete process.env[k];
delete process.env.DECK_VAULT; // Create refuses under it, and it would win over the vault made here
process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;

const { run } = await import('../lib/core/proc.mjs');
const { newestClaude, UNSET } = await import('../lib/claude/cli-route.mjs');
const claude = await newestClaude();
if (!claude) notRun('no claude CLI on the PATH');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });
const auth = await run(claude.path, ['auth', 'status', '--json'], { timeoutMs: 30000, unset: UNSET });
let loggedIn = false;
try { loggedIn = JSON.parse(auth.stdout).loggedIn === true; } catch {}
if (!loggedIn) notRun(`Claude Code ${claude.version} is not logged in with the throwaway config. Log it in once:\n\n  CLAUDE_CONFIG_DIR="${CLAUDE_DIR.startsWith(HOME + '/') ? '$HOME' + CLAUDE_DIR.slice(HOME.length) : CLAUDE_DIR}" claude auth login\n`);
say(`Claude Code ${claude.version}, logged in`);

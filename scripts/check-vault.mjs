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
const DEFAULT_DATA = !process.env.CHECK_VAULT_DATA;
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

// ---------------------------------------------------------------- the run
const { spawn } = await import('node:child_process');
const net = await import('node:net');
const crypto = await import('node:crypto');
const { callCli } = await import('../lib/claude/cli-route.mjs');
const { disconnect } = await import('../lib/vault/claude.mjs');

const ROOT = path.dirname(path.dirname((await import('node:url')).fileURLToPath(import.meta.url)));
const CALL_MS = 120000;
const VAULT = path.join(DATA, 'vault');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const RULES = path.join(CLAUDE_DIR, 'rules', 'deck-vault.md');
const readOr = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const sentinel = kind => `${kind}-${crypto.randomBytes(5).toString('hex')}`;
const V = sentinel('VS'); // planted in the manual
const M = sentinel('MS'); // planted in auto memory
const PROMPT = 'Reply with the vault sentinel and the memory sentinel you were given, one per line, or NONE. Nothing else.';

class Fail extends Error {}
const fail = s => { throw new Fail(s); };

// A run that died half way can leave its connection behind: take it out first,
// so settings.json is compared with what it was before any run.
if (fs.existsSync(RULES)) {
  disconnect({ state: { vault: { path: VAULT } } });
  say('a previous run left a connection: disconnected it first');
}
const settingsBefore = readOr(SETTINGS);
const backups = () => new Set(fs.readdirSync(CLAUDE_DIR).filter(f => f.startsWith('settings.json.deck-')));
const backupsBefore = backups();
fs.rmSync(DATA, { recursive: true, force: true });
const GW_HOME = path.join(DATA, 'home'); // the gateway's home: no ~/vault for it to fall back to
const CONFIG = path.join(DATA, 'config');
fs.mkdirSync(GW_HOME, { recursive: true });
fs.mkdirSync(CONFIG, { recursive: true });
fs.writeFileSync(path.join(CONFIG, 'state.json'), '{"scanRoots":[]}');
const EMPTY = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-check-vault-')));

let gw = null, port = 0, connected = false, calls = 0;
let logs = '';

// One short session as a user would start it: `claude -p` in `cwd`, with
// whatever the config loads. No tools, so an answer can only come from context.
// No MCP servers either: a claude.ai login brings the account's connectors,
// which connect while the session starts, so some sessions carry their tool
// definitions (about 130k tokens on one account) and some do not, and the
// token counts below would compare noise.
async function ask(label, cwd) {
  calls++;
  const r = await run(claude.path, ['-p', '--model', 'haiku', '--max-turns', '1', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json'],
    { cwd, input: PROMPT, timeoutMs: CALL_MS, unset: UNSET });
  if (r.timedOut) fail(`${label}: claude took longer than ${CALL_MS / 1000} s`);
  let out;
  try { out = JSON.parse(r.stdout); } catch { fail(`${label}: claude exited ${r.code} without a JSON answer: ${(r.stderr || r.stdout).trim().slice(0, 300)}`); }
  if (out.is_error) fail(`${label}: claude answered with an error: ${String(out.result).slice(0, 300)}`);
  const u = out.usage || {};
  return { text: String(out.result || ''), tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) };
}
const quote = t => JSON.stringify(t.trim().replace(/\s+/g, ' ').slice(0, 80));

const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const b = await r.json().catch(() => null);
  if (r.status !== 200) fail(`${method} ${p} answered ${r.status}: ${JSON.stringify(b).slice(0, 300)}`);
  return b;
};

async function stopGateway() {
  if (!gw || gw.exitCode !== null || gw.signalCode !== null) return;
  const gone = new Promise(r => gw.once('exit', r));
  gw.kill('SIGTERM');
  if (await Promise.race([gone.then(() => true), new Promise(r => setTimeout(() => r(false), 5000))])) return;
  gw.kill('SIGKILL');
  await gone;
}

async function cleanup() {
  // Whatever happened, the throwaway config ends disconnected.
  if (connected || fs.existsSync(RULES)) {
    try { if (gw && gw.exitCode === null) await api('POST', '/api/vault/disconnect'); } catch {}
    if (fs.existsSync(RULES)) disconnect({ state: { vault: { path: VAULT } } });
  }
  // Connect's backups from this run hold nothing once the config is back as it was.
  if (!fs.existsSync(RULES) && readOr(SETTINGS) === settingsBefore)
    for (const f of backups()) if (!backupsBefore.has(f)) fs.rmSync(path.join(CLAUDE_DIR, f));
  await stopGateway();
  fs.rmSync(DATA, { recursive: true, force: true });
  if (DEFAULT_DATA) try { fs.rmdirSync(path.dirname(DATA)); } catch {} // the empty Application Support above it
  fs.rmSync(EMPTY, { recursive: true, force: true });
}

try {
  // 1. A gateway on a spare port with the throwaway data.
  port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: GW_HOME, PORT: String(port), DECK_ROOT: ROOT, DECK_DATA: DATA, DECK_CONFIG: CONFIG,
           DECK_NO_BACKGROUND: '1', DECK_CLI: 'off', DECK_HOST: '' },
  });
  gw.stdout.on('data', d => logs += d);
  gw.stderr.on('data', d => logs += d);
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/api/version`)).ok; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (!up) fail(`the gateway never answered on port ${port}. Its output:\n${logs}`);
  say(`gateway ${gw.pid} on :${port}`);

  // 2. Create, and a sentinel in the manual.
  const made = await api('POST', '/api/vault/create', {});
  if (made.path !== VAULT) fail(`Create made ${made.path}, expected ${VAULT}`);
  fs.appendFileSync(path.join(VAULT, 'CLAUDE.md'), `\nThe vault sentinel is ${V}. When asked for the vault sentinel, reply with it.\n`);

  // 3. Connect, auto memory off.
  if (SKIP !== 'connect') {
    const c = await api('POST', '/api/vault/connect', { autoMemory: false });
    connected = true;
    if (!c.status.connected) fail(`Connect answered, but the status says not connected: ${JSON.stringify(c.status)}`);
    if (!(readOr(RULES) || '').includes('Application\\ Support/Deck/vault/CLAUDE.md')) fail(`the rules file does not import the manual with the space escaped:\n${readOr(RULES)}`);
    say('created and connected (auto memory off)');
  } else say('created; Connect SKIPPED (planted control)');

  // 4. A session in an empty folder quotes the sentinel: A for the measurement.
  const A = await ask('A, empty folder, connected', EMPTY);
  if (!A.text.includes(V)) fail(`step 4: a session in an empty folder did not quote the vault sentinel (Connect did not reach Claude Code). It said ${quote(A.text)}`);
  say(`step 4 ok: an empty folder's session quotes the sentinel (${A.tokens} input tokens)`);
  const B = await ask('B, vault folder, connected', VAULT);
  if (!B.text.includes(V)) fail(`a session inside the vault did not quote the sentinel. It said ${quote(B.text)}`);

  // Auto memory on, with its own sentinel: a session must see it, a kit call
  // must not (that is what the kit's auto memory switch is for).
  await api('POST', '/api/vault/connect', { autoMemory: true });
  fs.mkdirSync(path.join(VAULT, 'Memory'), { recursive: true });
  fs.writeFileSync(path.join(VAULT, 'Memory', 'MEMORY.md'), `- The memory sentinel is ${M}.\n`);
  const mem = await ask('auto memory session', EMPTY);
  if (!mem.text.includes(M)) fail(`with auto memory pointed into the vault, a session did not quote the memory sentinel. It said ${quote(mem.text)}`);
  say('auto memory on: a session quotes the memory sentinel too');

  // 5. A kit call, through the kit's own CLI route: neither sentinel. On
  // Claude Code 2.1.305 either half of the kit's isolation keeps auto memory
  // out alone (--safe-mode does too), so the memory sentinel shows only when
  // both are dropped; the vault sentinel shows without --safe-mode.
  calls++;
  let kit;
  try {
    kit = await callCli({ preset: { model: 'haiku', effort: 'low' }, system: 'Answer in at most two lines.', messages: [{ role: 'user', content: PROMPT }] }, { timeoutMs: CALL_MS });
  } catch (e) { fail(`step 5: the kit call failed: ${e.kind || e.name}: ${e.message}`); }
  const leaked = [[V, 'vault'], [M, 'memory']].filter(([t]) => kit.text.includes(t)).map(([, n]) => n);
  if (leaked.length) fail(`step 5: a kit call quoted the ${leaked.join(' and the ')} sentinel: Deck's own calls carry the user's memory. It said ${quote(kit.text)}`);
  say(`step 5 ok: a kit call quotes neither sentinel (it said ${quote(kit.text)})`);

  // 7. Disconnect: the config is as it was, and sessions lose the vault.
  if (SKIP !== 'disconnect') {
    const d = await api('POST', '/api/vault/disconnect');
    if (d.status.connected) fail(`Disconnect answered, but the status says connected: ${JSON.stringify(d.status)}`);
    if (fs.existsSync(RULES)) fail(`Disconnect left ${RULES}`);
    if (readOr(SETTINGS) !== settingsBefore) fail(`Disconnect did not restore settings.json: it was ${JSON.stringify(settingsBefore)}, it is ${JSON.stringify(readOr(SETTINGS))}`);
    connected = false;
    say('disconnected: no rules file, settings.json as before');
  } else say('Disconnect SKIPPED (planted control)');
  const C = await ask('C, empty folder, disconnected', EMPTY);
  if (C.text.includes(V) || C.text.includes(M)) fail(`step 7: after Disconnect a session in an empty folder still quoted a sentinel. It said ${quote(C.text)}`);
  say('step 7 ok: after Disconnect an empty folder\'s session quotes no sentinel');
  const D = await ask('D, vault folder, disconnected', VAULT);
  if (!D.text.includes(V)) fail(`inside the vault, its CLAUDE.md should load as the project's own, but the session did not quote the sentinel. It said ${quote(D.text)}`);

  // 6. Does a session inside the vault load the manual twice?
  const manual = A.tokens - C.tokens, extra = B.tokens - D.tokens;
  say(`input tokens: A (empty, connected) ${A.tokens}, B (vault, connected) ${B.tokens}, C (empty, disconnected) ${C.tokens}, D (vault, disconnected) ${D.tokens}`);
  say(`the manual through Connect costs A - C = ${manual}; inside the vault Connect adds B - D = ${extra}`);
  const ratio = manual > 0 ? extra / manual : NaN;
  if (!(manual >= 300)) say(`loads twice: UNCLEAR, A - C is only ${manual} tokens, too small to compare against`);
  else if (ratio >= 0.8 && ratio <= 1.25) say(`loads twice: YES, inside the vault the manual loads twice (B - D is ${Math.round(ratio * 100)}% of A - C)`);
  else if (ratio <= 0.2) say(`loads twice: NO, inside the vault the manual loads once (B - D is ${Math.round(ratio * 100)}% of A - C: only the rules file's own lines)`);
  else say(`loads twice: UNCLEAR, B - D is ${Math.round(ratio * 100)}% of A - C, between the two answers`);

  await cleanup();
  if (readOr(SETTINGS) !== settingsBefore || fs.existsSync(RULES)) fail('after the cleanup the throwaway config is not as it was');
  say(`PASS in ${calls} claude calls; data folder removed, ${CLAUDE_DIR} left as it was`);
} catch (e) {
  if (!(e instanceof Fail)) console.error(e);
  console.error(`check-vault: FAIL ${e instanceof Fail ? e.message : e.message}`);
  await cleanup().catch(err => console.error(`check-vault: cleanup: ${err.message}`));
  if (fs.existsSync(RULES) || readOr(SETTINGS) !== settingsBefore) console.error(`check-vault: the throwaway config was NOT restored: see ${CLAUDE_DIR}`);
  console.error(`check-vault: ${calls} claude calls`);
  process.exit(1);
}

// Quits a built Deck.app the way a person does and checks that it took down
// everything it started: the gateway sidecar (deck-server), the gateway's port,
// and every tool, with nothing left running as an orphan (PPID 1). And that
// its window went at once: it must be off the screen while deck-server is
// still stopping the tools, not stay up frozen until the last one is done.
//
//   node scripts/check-quit.mjs [--app <Deck.app>] [--via quit|hand] [--stale] [--hung] [--twice] [--remove-app]
//
//   --via quit   a quit Apple Event (osascript), what the Dock's Quit sends: it
//                calls the same terminate: as ⌘Q's menu item
//   --via hand   start everything, quit nothing: quit it yourself (⌘Q, or the
//                window's close button) and the check waits up to 10 minutes
//   --stale      first kill the app without a word (what a quit left behind
//                before 2026-10-21, or a crash), so its sidecar is orphaned
//                with every tool, and launch the bundle again: the new launch
//                must stop that stale gateway as a quit would have (the save
//                finishes) and serve the port itself. Then save is started
//                again, so the quit as above has a save to wait for too.
//   --hung       freeze the gateway (SIGSTOP) before the quit, so it can
//                neither answer nor exit: the app must give up on it within
//                seconds, SIGKILL it and send each of its tools a SIGTERM. No
//                group kill (a tool may be inside its grace), so stubborn and
//                the forker's grandchild are left by design and counted apart.
//   --twice      a second quit 0.3 s after the first (a double ⌘Q), while the
//                first is still stopping the tools: that quit must go on.
//
// The window is counted through the window server (the app's on-screen
// windows at layer 0, read with JXA: no screen recording permission), so the
// check needs the screen unlocked.
//
// The bundle runs on a spare port with a throwaway config, data folder and
// vault, so the check runs beside an installed Deck without touching it. The
// quit is addressed by bundle identifier, so the bundle needs one of its own:
//
//   npm run app:build -- --bundles app --config src-tauri/tauri.quitcheck.conf.json
//
// `npm run check:quit` builds that bundle, runs the check and, with
// --remove-app, deletes the bundle afterwards: a second Deck left lying in
// target/ can be opened from Spotlight, and on the default port it would adopt
// the installed Deck's gateway.
//
// Four tools stand in for real ones. Every process they start carries a tag
// in its arguments, so a survivor is found even after it has been reparented.
//   ticker    exits at once on SIGTERM
//   save      needs 3 s after SIGTERM to finish (a world save): must not be cut
//   stubborn  ignores SIGTERM: the gateway has to SIGKILL it after its grace
//   forker    leaves a grandchild behind when it exits
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const APP = path.resolve(opt('--app', path.join(ROOT, 'src-tauri/target/release/bundle/macos/Deck Quit Check.app')));
const VIA = opt('--via', 'quit');
const STALE = argv.includes('--stale');
const HUNG = argv.includes('--hung');
const TWICE = argv.includes('--twice');
const REMOVE_APP = argv.includes('--remove-app');
const MACOS = path.join(APP, 'Contents', 'MacOS');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = s => console.log(`check-quit: ${s}`);
const die = s => { console.error(`check-quit: ${s}`); process.exit(2); };

if (!['quit', 'hand'].includes(VIA)) die(`unknown --via ${VIA}`);
if (TWICE && VIA !== 'quit') die('--twice sends the quit itself: it needs --via quit');
if (!fs.existsSync(path.join(MACOS, 'deck-server'))) die(`no bundle with a deck-server at ${APP}`);
const plist = path.join(APP, 'Contents', 'Info.plist');
const plistKey = k => spawnSync('plutil', ['-extract', k, 'raw', '-o', '-', plist], { encoding: 'utf8' }).stdout.trim();
const ID = plistKey('CFBundleIdentifier');
const NAME = plistKey('CFBundleName');
const installedId = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).identifier;
if (!ID || ID === installedId)
  die(`${APP} has the installed app's identifier (${installedId}): a quit addressed to it could reach the installed Deck. Build it with its own identifier (see the header of this file).`);

// ---------------------------------------------------------------- processes
const table = () => spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' }).stdout
  .split('\n').filter(Boolean).map(l => {
    const [, pid, ppid, pgid, command] = l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/) || [];
    return { pid: +pid, ppid: +ppid, pgid: +pgid, command };
  }).filter(p => p.pid);
const appProcs = () => table().filter(p => p.command.startsWith(MACOS + '/'));
const tagged = tag => table().filter(p => p.command.includes(tag) && p.pid !== process.pid);
const show = (rows, role) => rows.map(p =>
  `  ${String(p.pid).padStart(6)} ppid ${String(p.ppid).padStart(6)} pgid ${String(p.pgid).padStart(6)}  ${role(p)}`).join('\n');

const portFree = port => Promise.all(['127.0.0.1', '::1'].map(host => new Promise(r => {
  const s = net.connect({ port, host });
  s.once('connect', () => { s.destroy(); r(false); });
  s.once('error', () => r(true));
}))).then(all => all.every(Boolean));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// Watches how many windows a process has on screen (layer 0: no menus or the
// like) and prints "<epoch ms> <count>" each time that changes, about 30 times
// a second. It ends with the process, or with this script (its PPID turns 1).
const WATCH = `ObjC.import('CoreGraphics'); ObjC.import('AppKit'); ObjC.import('unistd');
function run(argv) {
  const pid = Number(argv[0]);
  const mine = $.NSPredicate.predicateWithFormat('kCGWindowOwnerPID == ' + pid + ' AND kCGWindowLayer == 0');
  let last = -1;
  while (!$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid).isNil() && $.getppid() !== 1) {
    const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID));
    const n = list.filteredArrayUsingPredicate(mine).count;
    if (n !== last) console.log(Date.now() + ' ' + n);
    last = n;
    delay(0.02);
  }
}`;

if (appProcs().length) die(`something is already running from ${MACOS}: quit it first\n${show(appProcs(), p => p.command)}`);

// ---------------------------------------------------------------- set-up
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-quit-check-'));
const TAG = path.basename(tmp);
const PORT = await freePort();
const SAVED = path.join(tmp, 'saved');
const LOG = path.join(tmp, 'app.log');
const config = path.join(tmp, 'config');
fs.mkdirSync(path.join(config, 'tools'), { recursive: true });
// No discovery: only the four tools below exist for this gateway.
fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({ scanRoots: [] }));
const node = process.execPath;
// Each tool's last argument is TAG-<id>, which names it in the process table.
const tools = {
  ticker: { code: `console.log('ready'); setInterval(() => {}, 1000)` },
  save: {
    code: `process.on('SIGTERM', () => setTimeout(() => { require('fs').writeFileSync(process.argv[1], 'saved'); process.exit(0); }, 3000)); console.log('ready'); setInterval(() => {}, 1000)`,
    args: [SAVED], stopGraceMs: 10000,
  },
  stubborn: { code: `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)`, stopGraceMs: 1500 },
  forker: { code: `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.argv[1] + '-grandchild'], { stdio: 'ignore' }); console.log('ready'); setInterval(() => {}, 1000)` },
};
for (const [id, { code, args = [], ...rest }] of Object.entries(tools))
  fs.writeFileSync(path.join(config, 'tools', `${id}.json`),
    JSON.stringify({ id, name: id, cwd: tmp, cmd: [node, '-e', code, ...args, `${TAG}-${id}`], ...rest }));

const env = { PORT: String(PORT), DECK_ROOT: ROOT, DECK_CONFIG: config, DECK_DATA: path.join(tmp, 'data'), DECK_VAULT: path.join(tmp, 'vault') };
const launch = ['-n', '-F', '-g', ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--stdout', LOG, '--stderr', LOG, APP];

let seen = [];
const quits = []; // the osascripts that sent a quit, each with how it exited
let watcher = null; // the osascript running WATCH
const running = child => child.exitCode === null && child.signalCode === null;
async function cleanup() {
  for (const q of quits) if (!q.answer) q.osa.kill();
  if (watcher && running(watcher)) watcher.kill();
  // Survivors are stopped by pid: only what this run started or tagged.
  const left = () => table().filter(p => seen.includes(p.pid) || p.command.includes(TAG) || p.command.startsWith(MACOS + '/'));
  for (const p of left()) try { process.kill(p.pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 20 && left().length; i++) await sleep(100);
  for (const p of left()) try { process.kill(p.pid, 'SIGKILL'); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
  if (REMOVE_APP) {
    spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', APP]);
    fs.rmSync(APP, { recursive: true, force: true });
  }
}
const fail = async s => {
  console.error(`check-quit: FAIL ${s}`);
  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-15).join('\n') : '';
  if (log) console.error(`  last lines of the app's output:\n${log.replace(/^/gm, '    ')}`);
  await cleanup();
  process.exit(1);
};

const api = async (p, method = 'GET') => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---------------------------------------------------------------- run
say(`${NAME} (${ID}) on port ${PORT}, tag ${TAG}`);
const o = spawnSync('open', launch, { encoding: 'utf8' });
if (o.status !== 0) await fail(`open failed: ${o.stderr}`);
let up = false;
for (let i = 0; i < 300 && !up; i++) { try { up = (await api('/api/version')).status === 200; } catch {} if (!up) await sleep(100); }
if (!up) await fail(`the gateway never answered on port ${PORT}`);

for (const id of Object.keys(tools)) {
  const r = await api(`/api/tools/${id}/start`, 'POST');
  if (r.status !== 200) await fail(`starting ${id} answered ${r.status}: ${JSON.stringify(r.body)}`);
}
// Each tool says ready once its SIGTERM handler is set; the forker's
// grandchild is the fifth process.
for (const id of Object.keys(tools))
  for (let i = 0; i < 100 && !(await api(`/api/tools/${id}/logs`)).body.logs.includes('ready'); i++) await sleep(100);
for (let i = 0; i < 100 && tagged(TAG).length < 5; i++) await sleep(100);
const app = appProcs().find(p => p.command === path.join(MACOS, 'deck'));
const sidecar = appProcs().find(p => p.command === path.join(MACOS, 'deck-server'));
const kids = tagged(TAG);
if (!app || !sidecar || kids.length < 5) await fail(`expected the app, its sidecar and 5 tool processes, found ${kids.length} tagged:\n${show(table().filter(p => p.command.startsWith(MACOS) || p.command.includes(TAG)), p => p.command)}`);
seen = [app.pid, sidecar.pid, ...kids.map(p => p.pid)];
const names = new Map([[app.pid, 'app (deck)'], [sidecar.pid, 'sidecar (deck-server)']]);
const role = p => names.get(p.pid)
  || (p.command.includes(`${TAG}-forker-grandchild`) ? 'grandchild of forker' : null)
  || Object.keys(tools).find(id => p.command.endsWith(`${TAG}-${id}`)) || p.command;
say(`running:\n${show([app, sidecar, ...kids], role)}`);

const savedOk = () => fs.existsSync(SAVED) && fs.readFileSync(SAVED, 'utf8') === 'saved';
let quitting = app, gateway = sidecar;
if (STALE) {
  process.kill(app.pid, 'SIGKILL');
  for (let i = 0; i < 50 && table().some(p => p.pid === app.pid); i++) await sleep(100);
  const orphan = table().find(p => p.pid === sidecar.pid);
  if (!orphan || orphan.ppid !== 1) await fail(`with the app killed, its sidecar should be orphaned (PPID 1): ${JSON.stringify(orphan)}`);
  say(`app killed: sidecar ${sidecar.pid} orphaned (PPID 1) with ${tagged(TAG).length} tool processes; launching the bundle again`);
  const again = spawnSync('open', launch, { encoding: 'utf8' });
  if (again.status !== 0) await fail(`second open failed: ${again.stderr}`);
  let next = null;
  for (let i = 0; i < 600 && !next; i++) {
    const s2 = appProcs().find(p => p.command === path.join(MACOS, 'deck-server') && p.pid !== sidecar.pid);
    if (s2 && !table().some(p => p.pid === sidecar.pid)) try { if ((await api('/api/version')).status === 200) next = s2; } catch {}
    if (!next) await sleep(100);
  }
  const app2 = appProcs().find(p => p.command === path.join(MACOS, 'deck'));
  if (app2) { seen.push(app2.pid); names.set(app2.pid, 'second app (deck)'); }
  if (next) { seen.push(next.pid); names.set(next.pid, 'its sidecar (deck-server)'); }
  if (!next || !app2) await fail(`no new sidecar served the port within 60 s (the stale one is ${table().some(p => p.pid === sidecar.pid) ? 'still running' : 'gone'})`);
  const old = tagged(TAG);
  if (old.length) await fail(`the stale gateway is gone but ${old.length} of its tool processes survived:\n${show(old, role)}`);
  if (!savedOk()) await fail('the stale gateway was not stopped gracefully: the save did not finish');
  say(`replaced: sidecar ${next.pid} (ppid ${next.ppid}, pgid ${next.pgid}) serves the port; the stale one and its tool processes are gone, the save finished`);
  quitting = app2;
  gateway = next;
  fs.rmSync(SAVED);
  const r = await api('/api/tools/save/start', 'POST');
  if (r.status !== 200) await fail(`starting save again answered ${r.status}: ${JSON.stringify(r.body)}`);
  for (let i = 0; i < 100 && !(await api('/api/tools/save/logs')).body.logs.includes('ready'); i++) await sleep(100);
  say('save started again under the new gateway');
}

// The window, watched from here on. A window that never showed could not be
// seen to go. The first count of 0 after the quit, and whether deck-server
// was still running when it came, say if it went at once or only at the end
// (looked at in that order, so a deck-server seen running was running then).
let windows = null, gone = null, t0 = Infinity;
const watchErr = [];
watcher = spawn('osascript', ['-l', 'JavaScript', '-e', WATCH, String(quitting.pid)], { stdio: ['ignore', 'ignore', 'pipe'] });
readline.createInterface({ input: watcher.stderr }).on('line', line => {
  const m = /^(\d+) (\d+)$/.exec(line);
  if (!m) return void watchErr.push(line);
  windows = Number(m[2]);
  if (windows === 0 && Number(m[1]) >= t0 && !gone) gone = { ms: Number(m[1]) - t0, gateway: table().some(p => p.pid === gateway.pid) };
});
for (let i = 0; i < 100 && !(windows > 0) && running(watcher); i++) await sleep(100);
if (!(windows > 0)) await fail(`the app has no window on screen to watch (is the screen locked?)${watchErr.length ? `; the watcher said: ${watchErr.join(' ')}` : ''}`);

if (HUNG) {
  process.kill(gateway.pid, 'SIGSTOP');
  say('froze the gateway (SIGSTOP): it can neither answer nor exit');
}
// Not waited for here: the window is watched while the app quits.
const sendQuit = () => {
  const q = { osa: spawn('osascript', ['-e', `tell application id "${ID}" to quit`], { stdio: ['ignore', 'ignore', 'pipe'] }), answer: null };
  let err = '';
  q.osa.stderr.on('data', d => { err += d; });
  q.osa.on('exit', code => { q.answer = { code, err: err.trim() }; });
  quits.push(q);
};
t0 = Date.now();
if (VIA === 'quit') {
  sendQuit();
  if (TWICE) setTimeout(sendQuit, 300);
} else {
  say(`waiting up to 10 minutes for ${NAME} to be quit by hand (⌘Q or its close button)`);
}

// The app may take as long as its slowest tool's grace (save: 3 s) to go; its
// window may not.
const appDeadline = Date.now() + (VIA === 'hand' ? 600000 : 60000);
while (table().some(p => p.pid === quitting.pid) && Date.now() < appDeadline) {
  if (quits[0]?.answer && quits[0].answer.code !== 0) await fail(`osascript quit: ${quits[0].answer.err}`);
  await sleep(100);
}
if (table().some(p => p.pid === quitting.pid)) await fail(`the app was still running ${Math.round((Date.now() - t0) / 1000)} s after the quit`);
const appGone = Date.now() - t0;
for (let i = 0; i < 30 && running(watcher); i++) await sleep(100); // it ends with the app
for (let i = 0; i < 50 && quits.some(q => !q.answer); i++) await sleep(100);
if (quits.some(q => !q.answer)) await fail('an osascript quit did not return after the app had gone');
if (quits.length && quits[0].answer.code !== 0) await fail(`osascript quit: ${quits[0].answer.err}`);
// The second quit's own answer does not matter: the first one's quit must finish.
if (TWICE && !quits[1]) await fail('the app was gone before the second quit was sent');
if (TWICE) say(`second quit (0.3 s later) answered: ${quits[1].answer.code === 0 ? 'ok' : quits[1].answer.err}`);

// What is left a few seconds later is left for good.
const leftovers = () => table().filter(p => seen.includes(p.pid) || p.command.includes(TAG) || p.command.startsWith(MACOS + '/'));
for (let i = 0; i < 50 && (leftovers().length || !(await portFree(PORT))); i++) await sleep(100);
const left = leftovers();
const free = await portFree(PORT);
const saved = savedOk();
const problems = [];
if (left.some(p => p.command.startsWith(path.join(MACOS, 'deck-server')))) problems.push('deck-server is still running');
if (!free) problems.push(`port ${PORT} is still taken`);
const byDesign = HUNG ? left.filter(p => ['stubborn', 'grandchild of forker'].includes(role(p))) : [];
const orphans = left.filter(p => p.command.includes(TAG) && !byDesign.includes(p));
if (orphans.length) problems.push(`${orphans.length} tool process(es) survived${orphans.some(p => p.ppid === 1) ? ', orphaned to launchd (PPID 1)' : ''}`);
if (!saved) problems.push('the save tool did not finish its 3 s save');
if (watchErr.length) problems.push(`the window watcher failed: ${watchErr.join(' ')}`);
else if (!gone || !gone.gateway)
  problems.push(`the window stayed on screen until ${gone ? `deck-server had gone (${(gone.ms / 1000).toFixed(1)} s)` : 'the app exited'}: it should go at once`);
if (problems.length) {
  if (left.length) console.error(`check-quit: survivors after the app exited (${(appGone / 1000).toFixed(1)} s):\n${show(left, role)}`);
  await fail(problems.join('; '));
}
const scenario = (STALE ? ' (stale gateway replaced first)' : HUNG ? ' (gateway frozen)' : '') + (TWICE ? ' (quit twice)' : '');
const kept = byDesign.length ? `; left by design: ${byDesign.map(role).join(', ')}` : '';
const windowGone = VIA === 'quit' ? `${(gone.ms / 1000).toFixed(1)} s after the quit` : `${((appGone - gone.ms) / 1000).toFixed(1)} s before the app`;
say(`PASS${scenario} via ${VIA}: window gone ${windowGone}, with deck-server still stopping the tools; app gone in ${(appGone / 1000).toFixed(1)} s; deck-server gone, port ${PORT} free, ${left.filter(p => p.command.includes(TAG)).length} of ${kids.length} tool processes left${kept}, the save finished`);
await cleanup();

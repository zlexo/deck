#!/usr/bin/env node
// Deck: a local control panel for your dev tools.
//
//   node server.js          → http://localhost:8800
//
// Registry-driven: every tool is a manifest (tools/*.json in Deck's config
// folder, or a deck.json dropped inside any project folder). The Deck starts/stops the processes,
// tails their logs, edits their config (passed as CLI flags/env on launch),
// and opens the folders you drag files from. Nothing tool-specific is
// hardcoded. See README.md for the manifest schema.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const ROOT = process.env.DECK_ROOT || __dirname;  // DECK_ROOT: set by the shipped .app sidecar (Bun-compiled binary runs from inside the bundle; assets stay here)
const PORT = Number(process.env.PORT || 8800);
// tools/, projects/, folders.json and state.json live in Deck's config folder
// (lib/core/paths.mjs), resolved on every read so a migration needs no restart.
const paths = require('./lib/core/paths.mjs');
paths.setDeckRoot(ROOT);
const seeded = require('./lib/core/config-cli.mjs').seedFromExamples();
if (seeded) console.log(`first run: ${seeded.length} example files copied into ${paths.tildify(paths.configDir())}`);
// The vault is resolved on every use (lib/core/vault.mjs), so one created or
// adopted while Deck runs is picked up without a restart.
const vaultLib = require('./lib/core/vault.mjs');
const vaultDir = () => vaultLib.vaultDir(state);
// A path inside the vault; throws when there is none.
function inVault(...parts) {
  const v = vaultDir();
  if (!v) throw Object.assign(new Error('no vault: create one or adopt a folder (/api/vault)'), { status: 409 });
  return path.join(v, ...parts);
}
const LOG_LINES = 500;

// ---------------------------------------------------------------- build identity
// The shipped gateway is a Bun-compiled binary; the frontend (public/*.html) is
// read live off disk. So the two halves of the Deck can drift: a sidecar built
// before a route existed serves a current page that calls a route it never heard
// of. That has bitten twice in production (2026-08-12: no /chrome.html;
// 2026-09-01: no /api/projects — the home page rendered an empty grid and the
// 404 body as the window title). DECK_BUILD is stamped in at compile time by
// scripts/build-gateway.mjs; under plain `node server.js` it is undefined, which
// is correct — a gateway running from source IS the source and can never be stale.
const BUILD = typeof DECK_BUILD !== 'undefined' ? DECK_BUILD : null;
// The hash covers server.js, lib/ and the lockfile (lib/core/build-hash.mjs):
// since v2 the gateway's code is more than server.js.
const { codeHash } = require('./lib/core/build-hash.mjs');
const sourceHash = () => {
  try { return codeHash(ROOT); }
  catch { return null; }  // no checkout next to us (DECK_ROOT wrong) — can't compare
};
function versionInfo() {
  const source = sourceHash();
  return {
    compiled: !!BUILD,                                  // false = running from source, always current
    sha: BUILD ? BUILD.sha : null,                      // git sha the sidecar was compiled from
    builtAt: BUILD ? BUILD.builtAt : null,
    serverHash: BUILD ? BUILD.serverHash : source,      // server.js this process is actually running
    sourceHash: source,                                 // server.js sitting in the checkout right now
    stale: !!(BUILD && source && BUILD.serverHash !== source),
  };
}

function expandHome(p) { return p && p.replace(/^~(?=\/|$)/, os.homedir()); }
const expand = expandHome;

// ---------------------------------------------------------------- shell helpers
// git/gh run through here. Never throws to the caller unless asked — most call
// sites want "" / null on failure (a repo with no upstream, no remote, etc.).
async function run(cmd, args, cwd) {
  const { stdout } = await execFileP(cmd, args, { cwd: cwd ? expand(cwd) : undefined, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}
const runSafe = async (cmd, args, cwd) => { try { return await run(cmd, args, cwd); } catch { return ''; } };

// Newest file matching a bash glob (supports * and **). Null if none.
// Guard: with no match + nullglob the pattern vanishes and a bare `ls` would list
// cwd — so expand into an array and only `ls` when it's non-empty.
async function newestFile(glob) {
  if (!glob) return null;
  const out = await runSafe('bash', ['-c', `shopt -s globstar nullglob; arr=(${expand(glob)}); ((\${#arr[@]})) && ls -td "\${arr[@]}" 2>/dev/null | head -1`]);
  return out || null;
}
// Newest mtime (ms) under a dir tree, or 0. BSD `stat -f %m` (macOS has no GNU find -printf).
async function newestMtime(dir) {
  const d = expand(dir);
  if (!d || !fs.existsSync(d)) return 0;
  const out = await runSafe('bash', ['-c', `find '${d}' -type f -not -path '*/.git/*' -not -path '*/build/*' -exec stat -f '%m' {} + 2>/dev/null | sort -rn | head -1`]);
  const t = parseInt(out, 10);
  return Number.isFinite(t) ? t * 1000 : 0;
}
const fileInfo = f => { try { const s = fs.statSync(f); return { path: f, name: path.basename(f), mtime: s.mtimeMs, size: s.size }; } catch { return null; } };
const daysAgo = ms => Math.round((Date.now() - ms) / 86400000);

// ---------------------------------------------------------------- projects
function loadProjects() {
  const projects = {};
  const dir = paths.configPath('projects');
  if (fs.existsSync(dir))
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) {
      try { const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (p.id) projects[p.id] = p; }
      catch (e) { console.error('bad project', f, e.message); }
    }
  return projects;
}
// Tools belonging to a project: match its `match` group-names against each tool's group/projects.
function toolsForProject(p, allTools) {
  const names = new Set([p.name, ...(p.match || [])]);
  return Object.values(allTools).filter(t => {
    const tg = [t.group, ...(t.projects || [])].filter(Boolean);
    return tg.some(g => names.has(g));
  });
}

// ---------------------------------------------------------------- git cockpit
async function gitState(repoPath, deliveryRemote) {
  const cwd = expand(repoPath);
  if (!fs.existsSync(path.join(cwd, '.git'))) return { path: repoPath, exists: false };
  const branch = await runSafe('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const dirtyOut = await runSafe('git', ['status', '--porcelain'], cwd);
  const dirty = dirtyOut ? dirtyOut.split('\n').filter(Boolean).length : 0;
  const remotes = (await runSafe('git', ['remote'], cwd)).split('\n').filter(Boolean);
  const hasRemote = remotes.length > 0;
  let ahead = 0, behind = 0, upstream = false;
  if (hasRemote) {
    const lr = await runSafe('git', ['rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd);
    const m = lr.match(/^(\d+)\s+(\d+)$/);
    if (m) { behind = +m[1]; ahead = +m[2]; upstream = true; }
  }
  const log = (await runSafe('git', ['log', '--pretty=format:%h%x1f%s%x1f%cr', '-6'], cwd))
    .split('\n').filter(Boolean).map(l => { const [hash, subject, when] = l.split('\x1f'); return { hash, subject, when }; });
  const remoteUrl = await runSafe('git', ['remote', 'get-url', 'origin'], cwd);
  return {
    path: repoPath, name: path.basename(cwd), exists: true,
    branch, dirty, hasRemote, upstream, ahead, behind, log, remoteUrl,
    // a repo entry's deliveryRemote names the remote a delivery ships through
    hasDeliveryRemote: !!deliveryRemote && (remotes.includes(deliveryRemote) || remoteUrl.toLowerCase().includes(String(deliveryRemote).toLowerCase())),
  };
}

// ---------------------------------------------------------------- versions/artifacts
async function artifactState(p) {
  const a = p.artifacts || {};
  const out = {};
  if (a.jar) {
    const f = await newestFile(a.jar.glob);
    const info = f ? fileInfo(f) : null;
    let stale = null;
    if (info && a.jar.source) {
      const srcM = await newestMtime(a.jar.source);
      stale = srcM > info.mtime ? { days: daysAgo(info.mtime), sourceNewer: true } : false;
    }
    out.jar = info ? { ...info, ageDays: daysAgo(info.mtime), stale } : null;
  }
  if (a.mrpack) { const f = await newestFile(a.mrpack.glob); out.mrpack = f ? { ...fileInfo(f), ageDays: daysAgo(fileInfo(f).mtime) } : null; }
  if (a.deployed) { const f = expand(a.deployed); out.deployed = fs.existsSync(f) ? { ...fileInfo(f), ageDays: daysAgo(fileInfo(f).mtime) } : null; }
  return out;
}

// ---------------------------------------------------------------- vault (timer log + tasks + capture)
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function appendToFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + text + '\n');
}
function fmtDur(sec) { const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; }

function logSession({ project, seconds, mode }) {
  const t = todayStr();
  const line = `- ⏱ **${fmtDur(seconds)}** on **${project}**${mode ? ` (${mode})` : ''} — ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  appendToFile(inVault('Daily', `${t}.md`), line);
  appendToFile(inVault('Health', 'Time Tracking.md'), `${t} · ${project} · ${fmtDur(seconds)}${mode ? ` · ${mode}` : ''}`);
}

const TASK_FILE = () => inVault('Tasks', 'Deck.md');
function readTasks() {
  if (!vaultDir()) return [];
  const f = TASK_FILE();
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').map((l, i) => {
    const m = l.match(/^- \[([ xX])\]\s+(.*)$/); if (!m) return null;
    let text = m[2].trim(); let project = null, due = null;
    const pm = text.match(/@(\S+)/); if (pm) { project = pm[1]; text = text.replace(/@\S+/, '').trim(); }
    const dm = text.match(/!(\S+)/); if (dm) { due = dm[1]; text = text.replace(/!\S+/, '').trim(); }
    return { line: i, text, done: m[1].toLowerCase() === 'x', project, due };
  }).filter(Boolean);
}
function writeTasks(tasks) {
  const f = TASK_FILE(); fs.mkdirSync(path.dirname(f), { recursive: true });
  const body = tasks.map(t => `- [${t.done ? 'x' : ' '}] ${t.text}${t.project ? ' @' + t.project : ''}${t.due ? ' !' + t.due : ''}`).join('\n');
  fs.writeFileSync(f, `# Deck Tasks\n\n> Managed from the Deck task list. Plain checklist so the vault stays the source of truth.\n\n${body}\n`);
}

// ---------------------------------------------------------------- registry
function loadManifests() {
  const tools = {};
  const addFile = (file, source) => {
    try {
      let text = fs.readFileSync(file, 'utf8');
      // "{app}" in a discovered manifest is the folder its deck.json is in
      // (an app installed by Deck can live anywhere).
      if (source === 'discovered') text = text.split('{app}').join(JSON.stringify(path.dirname(file)).slice(1, -1));
      const m = JSON.parse(text);
      if (m.id && m.cmd && m.cwd) tools[m.id] = { ...m, _source: source, ...(source === 'discovered' ? { _dir: path.dirname(file) } : {}) };
    } catch (e) { console.error('bad manifest', file, e.message); }
  };
  // central manifests
  const dir = paths.configPath('tools');
  if (fs.existsSync(dir))
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) addFile(path.join(dir, f), 'central');
  // discovered: a deck.json inside any direct child of the scan roots
  // (state.json `scanRoots`; an empty list turns discovery off)
  const roots = Array.isArray(state.scanRoots) ? state.scanRoots : ['~'];
  // Deck's apps folder is always scanned: that is where installed apps live.
  for (const root of [...roots.map(expand), paths.dataPath('apps')]) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const f = path.join(root, e.name, 'deck.json');
      if (fs.existsSync(f)) addFile(f, 'discovered');
    }
  }
  return tools;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(paths.configPath('state.json'), 'utf8')); } catch { return {}; }
}
function saveState(s) {
  const file = paths.configPath('state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}

let state = loadState(); // { [id]: { config: {...} } }

function toolConfig(m) {
  const cfg = {};
  for (const [k, spec] of Object.entries(m.config || {}))
    if (spec.default !== undefined) cfg[k] = spec.default;
  return { ...cfg, ...(state[m.id] && state[m.id].config || {}) };
}

function buildArgs(m, cfg) {
  const args = [], env = {};
  for (const [k, spec] of Object.entries(m.config || {})) {
    let v = cfg[k];
    if (v === undefined || v === '' || v === null) continue;
    if (spec.type === 'path') v = expand(String(v));
    if (spec.type === 'bool') { if (v && spec.flag) args.push(spec.flag); continue; }
    if (spec.flag) args.push(spec.flag, String(v));
    else if (spec.env) env[spec.env] = String(v);
  }
  return { args, env };
}

function toolUrl(m, cfg) {
  if (!m.url) return null;
  return m.url.replace(/\{(\w+)\}/g, (_, k) => cfg[k] ?? '');
}

function toolPort(m, cfg) {
  const v = m.portKey ? cfg[m.portKey] : cfg.port;
  return v ? parseInt(v, 10) : null;
}

// ---------------------------------------------------------------- runner
const procs = {}; // id -> { child, logs: [], startedAt }

function pushLog(id, line) {
  const p = procs[id]; if (!p) return;
  for (const l of line.split('\n')) if (l.trim()) p.logs.push(l);
  if (p.logs.length > LOG_LINES) p.logs.splice(0, p.logs.length - LOG_LINES);
}

function probePort(port) {
  return new Promise(resolve => {
    if (!port) return resolve(false);
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = v => { s.destroy(); resolve(v); };
    s.setTimeout(400, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

// A signal-killed child keeps exitCode null and sets signalCode, so check both.
const alive = p => p && p.child && p.child.exitCode === null && p.child.signalCode === null;

// Per-tool lifecycle lock: overlapping start/stop/restart requests raced each other
// (two server instances / a stop landing on a fresh start — 2026-07-30). One
// in-flight lifecycle op per tool; concurrent requests get a 409.
const busy = {};
// Set once shutdown() has begun: nothing new may start after it has counted
// the children it waits for.
let stopping = false;

// Polls until a port is released (max 10s). A stopped MC server can hold its
// port for a few seconds past process exit; starting into that window used to
// spawn an instance that failed to bind and shut itself down.
async function waitFree(port) {
	if (!port) return;
	const deadline = Date.now() + 10000;
	while (await probePort(port) && Date.now() < deadline)
		await new Promise(r => setTimeout(r, 400));
}
const waitPortFree = m => waitFree(toolPort(m, toolConfig(m))); // a tool's port

async function statusOf(id, m) {
  const cfg = toolConfig(m);
  const p = procs[id];
  if (alive(p))
    return { status: 'running', pid: p.child.pid, startedAt: p.startedAt };
  const port = toolPort(m, cfg);
  if (await probePort(port)) return { status: 'external' }; // running, but not started by the Deck
  return { status: 'stopped' };
}

// `prelaunch` may come from the tool's own manifest and/or from the project
// server entry delegating to it (`{toolId, prelaunch}`) — both run, manifest
// first. Without this a prelaunch on a toolId-delegated server would be
// silently ignored, which is the exact failure class prelaunch exists to kill.
// An app's data and its content packs live outside its folder, so updating or
// removing the app never touches what it saved (manifest `data`, `packs`).
// `vault: true` gives the app the vault Deck resolves as DECK_VAULT; no other
// tool gets it, not even through Deck's own environment.
function appEnv(m) {
  const env = {};
  if (m.vault === true) { const v = vaultDir(); if (v) env.DECK_VAULT = v; }
  if (m.data) { const d = paths.dataPath('app-data', m.id); fs.mkdirSync(d, { recursive: true }); env.DECK_APP_DATA = d; }
  if (m.packs) { const d = paths.dataPath('packs', m.id); fs.mkdirSync(d, { recursive: true }); env.DECK_APP_PACKS = d; }
  return env;
}

async function startTool(id, m, prelaunch) {
  if (stopping) throw new Error('Deck is shutting down');
  const cfg = toolConfig(m);
  const st = await statusOf(id, m);
  if (st.status === 'running') throw new Error('already running');
  if (st.status === 'external')
    throw new Error(`port ${toolPort(m, cfg)} is already in use (the tool may be running in a terminal)`);
  const { args, env } = buildArgs(m, cfg);
  const cwd = expand(m.cwd);
  if (!fs.existsSync(cwd)) throw new Error(`cwd not found: ${cwd}`);
  const steps = [...(m.prelaunch || []), ...(prelaunch || [])];
  const [bin, spawnArgs] = resolveSpawn([...m.cmd, ...args], cwd, steps, [...m.cmd.slice(1), ...args]);
  const { DECK_VAULT: _ownVault, ...inherited } = process.env;
  const child = spawn(bin, spawnArgs, { cwd, env: { ...inherited, ...appEnv(m), ...env } });
  procs[id] = { child, logs: [], startedAt: Date.now() };
  v2.onLaunch(id);
  pushLog(id, `[deck] started: ${m.cmd.join(' ')} ${args.join(' ')}${prelaunchNote(steps)}`);
  child.stdout.on('data', d => pushLog(id, d.toString()));
  child.stderr.on('data', d => pushLog(id, d.toString()));
  child.on('exit', (code, sig) => pushLog(id, `[deck] exited (${sig || 'code ' + code})`));
  child.on('error', e => pushLog(id, `[deck] spawn error: ${e.message}`));
  return child.pid;
}

function stopTool(id, m) {
  const p = procs[id];
  if (!alive(p)) throw new Error('not running (or not started by the Deck)');
  const child = p.child;
  const grace = (m && m.stopGraceMs) || 5000; // MC servers need time to save worlds
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, grace);
}

// ---------------------------------------------------------------- open in Finder
function openInFinder(rawPath) {
  const p = expand(rawPath);
  if (!fs.existsSync(p)) throw new Error('path not found: ' + p);
  const isDir = fs.statSync(p).isDirectory();
  execFile('open', isDir ? [p] : ['-R', p]); // -R reveals the file selected in its folder
  return isDir ? 'opened folder' : 'revealed file';
}

// ---------------------------------------------------------------- project procs
// dev-client / server run as project-scoped children in the same `procs` map,
// keyed `proj:<id>:<kind>`. A server can instead reference an existing tool.
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// A spec may declare `prelaunch: [{label, cmd, cwd}]` — steps that must succeed
// before the thing itself starts. The point is freshness: Blade Clash resolves
// the Conduit engine from mavenLocal, so without a republish step "Run Client"
// will happily launch against a stale engine jar and look like a code bug.
//
// The steps and the real command become ONE bash process that `exec`s the
// command last, so the pid Deck tracks is the command's own — status, logs, and
// SIGTERM keep working exactly as they do for a bare spawn. A failing step
// aborts loudly instead of launching something half-built.
function launchScript(cmdArr, dir, steps) {
  const lines = [];
  for (const s of steps) {
    const label = s.label || s.cmd.join(' ');
    lines.push(`printf '%s\\n' ${shq('[deck] ' + label)}`);
    lines.push(`cd ${shq(expand(s.cwd || dir))} || exit 1`);
    lines.push(`${s.cmd.map(shq).join(' ')} || { printf '%s\\n' ${shq('[deck] FAILED: ' + label + ' — not launching')}; exit 1; }`);
  }
  lines.push(`cd ${shq(dir)} || exit 1`);
  lines.push(`printf '%s\\n' ${shq('[deck] launching: ' + cmdArr.join(' '))}`);
  lines.push(`exec ${cmdArr.map(shq).join(' ')}`);
  return lines.join('\n');
}

// Resolves what to actually hand to spawn(): the command itself when there are
// no prelaunch steps, otherwise the bash wrapper that runs them and execs it.
function resolveSpawn(cmdArr, dir, steps, bareArgs) {
  return steps.length
    ? ['/bin/bash', ['-lc', launchScript(cmdArr, dir, steps)]]
    : [expand(cmdArr[0]), bareArgs || cmdArr.slice(1)];
}
const prelaunchNote = steps =>
  steps.length ? ` (after ${steps.length} prelaunch step${steps.length > 1 ? 's' : ''})` : '';

function spawnRaw(key, cmdArr, cwd, env, prelaunch) {
  if (stopping) throw new Error('Deck is shutting down');
  const dir = expand(cwd);
  if (!fs.existsSync(dir)) throw new Error(`cwd not found: ${dir}`);
  const steps = prelaunch || [];
  const [bin, args] = resolveSpawn(cmdArr, dir, steps);
  const child = spawn(bin, args, { cwd: dir, env: { ...process.env, ...(env || {}) } });
  procs[key] = { child, logs: [], startedAt: Date.now() };
  v2.onLaunch(key);
  pushLog(key, `[deck] started: ${cmdArr.join(' ')}${prelaunchNote(steps)}`);
  child.stdout.on('data', d => pushLog(key, d.toString()));
  child.stderr.on('data', d => pushLog(key, d.toString()));
  child.on('exit', (c, s) => pushLog(key, `[deck] exited (${s || 'code ' + c})`));
  child.on('error', e => pushLog(key, `[deck] spawn error: ${e.message}`));
  return child.pid;
}
// Stops a Deck-spawned child and resolves once it has exited: SIGTERM, then
// SIGKILL after the grace (an MC server needs its world save). Null when it
// was not running.
function stopProc(key, graceMs = 5000) {
  const p = procs[key];
  if (!alive(p)) return Promise.resolve(null);
  return new Promise(resolve => {
    const t = setTimeout(() => { if (alive(p)) p.child.kill('SIGKILL'); }, graceMs);
    p.child.once('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
    p.child.kill('SIGTERM');
  });
}
// How long a child gets between SIGTERM and SIGKILL: the stopGraceMs of the
// tool, project server or dev client it was started as.
function graceOf(key, manifests, projects) {
  const m = /^proj:([^:]+):(devclient|server:(.+))$/.exec(key);
  const p = m && projects[m[1]];
  const spec = !m ? manifests[key] : !p ? null : m[3] ? serverSpecs(p).find(s => s.id === m[3]) : p.devClient;
  return (spec && spec.stopGraceMs) || 5000;
}

async function procStatus(key, spec, allTools) {
  if (!spec) return null;
  if (spec.toolId) { const m = allTools[spec.toolId]; return m ? { ...(await statusOf(spec.toolId, m)), toolId: spec.toolId, label: spec.label } : { status: 'stopped', label: spec.label }; }
  const p = procs[key];
  if (alive(p)) return { status: 'running', pid: p.child.pid, startedAt: p.startedAt, label: spec.label };
  if (spec.port && await probePort(spec.port)) return { status: 'external', label: spec.label };
  return { status: 'stopped', label: spec.label };
}

const serverSpecs = p => p.servers || (p.server ? [{ id: 'server', ...p.server }] : []);
async function assembleProject(p, allManifests, { full } = {}) {
  const tools = toolsForProject(p, allManifests).map(m => m.id);
  const base = { id: p.id, name: p.name, iconSvg: p.iconSvg || '', color: p.color || '#6d8bff', description: p.description || '', toolCount: tools.length, delivery: !!p.delivery, tags: p.tags || [], category: p.category || null };
  if (!full) return base;
  const specs = serverSpecs(p);
  const [devClient, artifacts, servers] = await Promise.all([
    procStatus(`proj:${p.id}:devclient`, p.devClient, allManifests),
    artifactState(p),
    Promise.all(specs.map(s => procStatus(`proj:${p.id}:server:${s.id}`, s, allManifests).then(st => ({ ...s, ...st })))),
  ]);
  const git = await Promise.all((p.repos || []).map(r => gitState(r.path, r.deliveryRemote)));
  return { ...base, tools, repos: p.repos || [], devClient, devClientSpec: p.devClient || null,
    servers, site: p.site || null, sites: p.sites || null, artifacts, git };
}

// ---------------------------------------------------------------- v2 features
// Claude kit, Reviews, Mod Lab, CI panel, Machine guard and Focus mode live in
// lib/ (docs/v2/contract.md). They get this process's runner through ctx.
const v2 = require('./lib/v2.mjs').mount({
  root: ROOT,
  procs, alive, pushLog, spawnRaw, stopProc,
  loadProjects, loadManifests, serverSpecs, probePort,
  toolUrl: m => toolUrl(m, toolConfig(m)),
  getState: () => state,
  saveState: next => { state = next; saveState(next); },
});

// ---------------------------------------------------------------- http
const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });

// Only this Mac's own pages may change things. The gateway listens on loopback
// only (below), but a page on any website open in a local browser can still
// send a simple POST to localhost:8800; browsers mark such requests with an
// Origin and Sec-Fetch-Site. The deck CLI and curl send neither and pass.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function crossSite(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  if (origin === 'null') return true; // sandboxed frames, file: pages
  try {
    const h = new URL(origin).hostname;
    return !(LOCAL_HOSTS.has(h) || h.endsWith('.localhost'));
  } catch { return true; }
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && crossSite(req)) {
    return json(res, 403, { error: 'refused: a write from another site' });
  }
  const parts = u.pathname.split('/').filter(Boolean);
  try {
    // no-store so the WKWebView never serves a stale frontend after a code update.
    const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, no-cache, must-revalidate' };
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      res.writeHead(200, HTML);
      return res.end(fs.readFileSync(path.join(ROOT, 'public', 'index.html')));
    }
    // The native shell's top tab-bar webview.
    // Any other public/*.html page (workspace.html, tasks.html, vault.html…).
    if (req.method === 'GET' && /^\/[a-z0-9-]+\.html$/.test(u.pathname)) {
      const f = path.join(ROOT, 'public', u.pathname.slice(1));
      if (fs.existsSync(f)) { res.writeHead(200, HTML); return res.end(fs.readFileSync(f)); }
    }
    if (req.method === 'GET' && u.pathname === '/chrome.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(ROOT, 'public', 'chrome.html')));
    }
    // Raster project/tool icons: public/icons/<name>.<ext>, referenced from a
    // manifest as `<image href='/icons/x.png'>`. Flat namespace — basename()
    // strips any path, so traversal is impossible. no-cache so replacing a file
    // shows up on reload instead of sticking around in the webview.
    if (req.method === 'GET' && /^\/icons\/[\w.-]+\.(png|svg|webp|jpe?g)$/i.test(u.pathname)) {
      const f = path.join(ROOT, 'public', 'icons', path.basename(u.pathname));
      const mime = { '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
                     '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[path.extname(f).toLowerCase()];
      if (mime && fs.existsSync(f)) {
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
        return res.end(fs.readFileSync(f));
      }
    }

    // Who am I, and am I older than the checkout I'm serving pages from?
    // public/index.html asks, and says so out loud instead of rendering an empty
    // grid. A gateway too old to answer this route at all is, by that very fact,
    // older than the page asking.
    if (u.pathname === '/api/version' && req.method === 'GET') {
      return json(res, 200, versionInfo());
    }

    // Where Deck's config lives, and whether the home page should still say
    // that the cards are the examples copied in on the first run.
    if (u.pathname === '/api/config' && req.method === 'GET') {
      const w = state.welcome || {};
      return json(res, 200, {
        dir: paths.tildify(paths.configDir()),
        sources: Object.fromEntries(paths.CONFIG_ITEMS.map(i => [i, paths.configSource(i)])),
        welcome: !!(w.seeded && !w.dismissed),
        vault: !!vaultDir() && fs.existsSync(vaultDir()), // the vault features show only when the folder exists
        modlab: Object.values(loadProjects()).some(p => p.modlab), // Mod Lab only for a project that configures it
      });
    }
    if (u.pathname === '/api/config/welcome' && req.method === 'POST') {
      state = { ...state, welcome: { ...(state.welcome || {}), dismissed: true } };
      saveState(state);
      return json(res, 200, { welcome: false });
    }

    if (u.pathname === '/api/tools' && req.method === 'GET') {
      const manifests = loadManifests();
      const out = [];
      for (const [id, m] of Object.entries(manifests)) {
        const cfg = toolConfig(m);
        // a tool can serve several projects (shared tooling); `group` kept for back-compat
        const projects = Array.isArray(m.projects) && m.projects.length ? m.projects : [m.group || 'Other'];
        out.push({
          id, name: m.name || id, group: m.group || projects[0], projects,
          description: m.description || '',
          url: toolUrl(m, cfg), cwd: m.cwd, cmd: m.cmd, paths: m.paths || {},
          config: m.config || {}, values: cfg, source: m._source,
          ...(await statusOf(id, m)),
        });
      }
      let folders = {};
      try { folders = JSON.parse(fs.readFileSync(paths.configPath('folders.json'), 'utf8')); } catch {}
      return json(res, 200, { tools: out, folders });
    }

    if (parts[0] === 'api' && parts[1] === 'tools' && parts[2]) {
      const id = parts[2], action = parts[3];
      const m = loadManifests()[id];
      if (!m) return json(res, 404, { error: 'unknown tool ' + id });

      if (req.method === 'POST' && ['start', 'stop', 'restart'].includes(action)) {
        if (busy[id]) return json(res, 409, { error: `busy: a ${busy[id]} for ${id} is still in progress` });
        busy[id] = action;
        try {
          if (action === 'start') {
            await waitPortFree(m); // a just-stopped instance may still hold the port
            return json(res, 200, { ok: true, pid: await startTool(id, m) });
          }
          if (action === 'stop') { stopTool(id, m); return json(res, 200, { ok: true }); }
          // restart
          try { stopTool(id, m); } catch {}
          // wait for the old process to fully exit (MC servers save on shutdown)
          const deadline = Date.now() + ((m.stopGraceMs || 5000) + 3000);
          while (alive(procs[id]) && Date.now() < deadline)
            await new Promise(r => setTimeout(r, 300));
          await waitPortFree(m);
          return json(res, 200, { ok: true, pid: await startTool(id, m) });
        } finally { delete busy[id]; }
      }
      if (req.method === 'GET' && action === 'logs')
        return json(res, 200, { logs: (procs[id] && procs[id].logs) || [] });
      if (req.method === 'POST' && action === 'console') {
        // Send a command to the process's console via stdin (MC servers read stdin in nogui).
        // Only works for processes the Deck spawned; "running outside the Deck" has no pipe.
        const p = procs[id];
        if (!alive(p) || !p.child.stdin || !p.child.stdin.writable)
          return json(res, 409, { error: 'not running under the Deck — start it here first' });
        const cmd = (JSON.parse(await readBody(req) || '{}').cmd || '').trim();
        if (!cmd) return json(res, 400, { error: 'empty command' });
        try { p.child.stdin.write(cmd + '\n'); pushLog(id, '> ' + cmd); }
        catch (e) { return json(res, 500, { error: e.message }); }
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PUT' && action === 'config') {
        const body = JSON.parse(await readBody(req) || '{}');
        state[id] = { ...(state[id] || {}), config: body.values || {} };
        saveState(state);
        return json(res, 200, { ok: true });
      }
    }

    // The native shell sends this when the app quits (decision 2026-08-10: app
    // quit stops the tools): stop everything this gateway started, then exit
    // (shutdown() below). The answer says how long that can take, so the shell
    // knows how long to wait before it kills the gateway's process group.
    if (u.pathname === '/api/shutdown' && req.method === 'POST') {
      json(res, 200, { ok: true, graceMs: shutdownMs() });
      shutdown();
      return;
    }
    // The shell sends this instead when it adopted a gateway it did not start
    // (the dev gateway, one started by hand): the tools stop, the gateway stays.
    // Stops every Deck-spawned child within its own grace, as shutdown() does;
    // externally-started tools untouched.
    if (u.pathname === '/api/stop-all' && req.method === 'POST') {
      const manifests = loadManifests(), projects = loadProjects();
      const stopped = [];
      for (const id of Object.keys(procs))
        if (alive(procs[id])) { stopProc(id, graceOf(id, manifests, projects)); stopped.push(id); }
      return json(res, 200, { ok: true, stopped });
    }

    // ---- projects -----------------------------------------------------------
    if (parts[0] === 'api' && parts[1] === 'projects') {
      const manifests = loadManifests();
      const projects = loadProjects();
      if (!parts[2] && req.method === 'GET') {
        const out = await Promise.all(Object.values(projects).map(p => assembleProject(p, manifests)));
        return json(res, 200, { projects: out });
      }
      const p = projects[parts[2]];
      if (!p) return json(res, 404, { error: 'unknown project ' + parts[2] });
      if (!parts[3] && req.method === 'GET')
        return json(res, 200, { project: await assembleProject(p, manifests, { full: true }) });

      // dev-client logs. Servers and tools always had this; the dev client did
      // not, which made a failed Run Client completely silent — the button just
      // became clickable again with nothing to read. A launch you cannot see
      // fail is the worst kind, so it gets the same log surface as everything else.
      if (parts[3] === 'dev-client' && parts[4] === 'logs' && req.method === 'GET') {
        const key = `proj:${p.id}:devclient`;
        const pr = procs[key];
        return json(res, 200, {
          logs: (pr && pr.logs) || [],
          startedAt: pr && pr.startedAt,
          running: alive(pr),
        });
      }

      // dev-client lifecycle (Run Client)
      if (parts[3] === 'dev-client' && req.method === 'POST') {
        const spec = p.devClient; if (!spec) return json(res, 400, { error: 'no dev-client configured' });
        const action = parts[4], key = `proj:${p.id}:devclient`;
        if (spec.toolId) { const m = manifests[spec.toolId]; if (!m) return json(res, 404, { error: 'tool not found' });
          if (action === 'start') { await waitPortFree(m); return json(res, 200, { ok: true, pid: await startTool(spec.toolId, m, spec.prelaunch) }); }
          if (action === 'stop') { stopTool(spec.toolId, m); return json(res, 200, { ok: true }); }
        } else {
          if (action === 'start') { if (alive(procs[key])) return json(res, 200, { ok: true, already: true });
            if (spec.port && await probePort(spec.port)) return json(res, 409, { error: `port ${spec.port} in use` });
            return json(res, 200, { ok: true, pid: spawnRaw(key, spec.cmd, spec.cwd, spec.env, spec.prelaunch) }); }
          if (action === 'stop') { stopProc(key, graceOf(key, manifests, projects)); return json(res, 200, { ok: true }); }
        }
      }
      // servers[sid] — lifecycle + console + logs (the server-panel backend)
      if (parts[3] === 'servers' && parts[4]) {
        const sid = parts[4], action = parts[5];
        const spec = serverSpecs(p).find(s => s.id === sid);
        if (!spec) return json(res, 404, { error: 'unknown server ' + sid });
        const key = spec.toolId ? spec.toolId : `proj:${p.id}:server:${sid}`;
        if (req.method === 'GET' && action === 'logs')
          return json(res, 200, { logs: (procs[key] && procs[key].logs) || [], startedAt: procs[key] && procs[key].startedAt, running: alive(procs[key]) });
        if (req.method === 'POST' && action === 'console') {
          const pr = procs[key];
          if (!alive(pr) || !pr.child.stdin || !pr.child.stdin.writable) return json(res, 409, { error: 'not running under the Deck — start it here first' });
          const cmd = (JSON.parse(await readBody(req) || '{}').cmd || '').trim();
          if (!cmd) return json(res, 400, { error: 'empty command' });
          try { pr.child.stdin.write(cmd + '\n'); pushLog(key, '> ' + cmd); } catch (e) { return json(res, 500, { error: e.message }); }
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && ['start', 'stop', 'restart'].includes(action)) {
          // One lifecycle action per server at a time, as for tools: Restart
          // waits for the old process to stop, and a second Restart in that
          // window would start a second server.
          if (busy[key]) return json(res, 409, { error: `busy: a ${busy[key]} of ${spec.label || sid} is still in progress` });
          busy[key] = action;
          try {
            if (spec.toolId) { const m = manifests[spec.toolId]; if (!m) return json(res, 404, { error: 'tool not found' });
              if (action === 'stop') { stopTool(spec.toolId, m); return json(res, 200, { ok: true }); }
              if (action === 'restart') await stopProc(key, graceOf(key, manifests, projects)); // the tool's own grace
              await waitPortFree(m); return json(res, 200, { ok: true, pid: await startTool(spec.toolId, m, spec.prelaunch) });
            }
            if (action === 'start') { if (alive(procs[key])) return json(res, 200, { ok: true, already: true });
              if (spec.port && await probePort(spec.port)) return json(res, 409, { error: `port ${spec.port} in use` });
              return json(res, 200, { ok: true, pid: spawnRaw(key, spec.cmd, spec.cwd, spec.env, spec.prelaunch) }); }
            // Stop and Restart give the server its stopGraceMs (an MC server saves
            // its world, a VM shuts down cleanly) before the SIGKILL, as quitting
            // Deck does. Restart starts the new one only once the old one has
            // exited and its port is free: the server JVM that `./gradlew
            // runServer` starts can hold the port after the launcher Deck tracks
            // has gone.
            if (action === 'stop') { stopProc(key, graceOf(key, manifests, projects)); return json(res, 200, { ok: true }); }
            if (action === 'restart') { await stopProc(key, graceOf(key, manifests, projects)); await waitFree(spec.port);
              if (spec.port && await probePort(spec.port)) return json(res, 409, { error: `port ${spec.port} in use` });
              return json(res, 200, { ok: true, pid: spawnRaw(key, spec.cmd, spec.cwd, spec.env, spec.prelaunch) }); }
          } finally { delete busy[key]; }
        }
      }
      // build (generate) an artifact
      if (parts[3] === 'build' && req.method === 'POST') {
        const spec = p.artifacts && p.artifacts.jar && p.artifacts.jar.build;
        if (!spec) return json(res, 400, { error: 'no build configured' });
        const key = `proj:${p.id}:build`;
        if (alive(procs[key])) return json(res, 200, { ok: true, already: true });
        return json(res, 200, { ok: true, pid: spawnRaw(key, spec.cmd, spec.cwd) });
      }
      // start the project's site dev server, return the url to open in a tab
      if (parts[3] === 'site' && parts[4] === 'start' && req.method === 'POST') {
        // `sites[i]` when the project has several, `site` when it has one.
        const list = (p.sites && p.sites.length) ? p.sites : (p.site ? [p.site] : []);
        const i = Number(parts[5] || 0) || 0;
        const s = list[i]; if (!s || !s.dev) return json(res, 400, { error: 'no site dev configured' });
        const key = `proj:${p.id}:site:${i}`;
        if (!alive(procs[key]) && !(s.dev.port && await probePort(s.dev.port))) spawnRaw(key, s.dev.cmd, s.dev.cwd);
        return json(res, 200, { ok: true, url: `http://localhost:${s.dev.port}` });
      }
      // ship a delivery: build-fresh → stage the jar → tag → log to the Client Deliveries Log
      if (parts[3] === 'deliver' && req.method === 'POST') {
        if (!p.delivery) return json(res, 400, { error: 'not a delivery project' });
        const jarSpec = p.artifacts && p.artifacts.jar;
        if (!jarSpec) return json(res, 400, { error: 'no jar artifact configured' });
        const notes = [];
        let jar = (await artifactState(p)).jar;
        if ((!jar || (jar.stale && jar.stale.sourceNewer)) && jarSpec.build) {
          try { await run(jarSpec.build.cmd[0], jarSpec.build.cmd.slice(1), jarSpec.build.cwd); notes.push('built a fresh jar'); }
          catch (e) { return json(res, 500, { error: 'build failed: ' + (e.stderr || e.message || '').toString().slice(0, 300) }); }
          jar = (await artifactState(p)).jar;
        }
        if (!jar) return json(res, 400, { error: 'no jar to ship — build one first' });
        if (p.artifacts.deployed) {
          try { const dest = expand(p.artifacts.deployed); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(jar.path, dest); notes.push(`staged → ${path.basename(dest)}`); }
          catch (e) { notes.push('stage failed: ' + e.message); }
        }
        const repo = (p.repos || []).find(r => r.deliveryRemote);
        let tag = null;
        if (repo) {
          tag = `delivery/${todayStr()}`;
          await runSafe('git', ['tag', '-f', tag], expand(repo.path));
          const sha = await runSafe('git', ['rev-parse', '--short', 'HEAD'], expand(repo.path));
          notes.push(`tagged ${tag}${sha ? ' @ ' + sha : ''} (local — push when ready)`);
        }
        try {
          const f = inVault('Knowledge', 'Client Deliveries Log.md');
          const row = `| ${todayStr()} | ${p.name} | ${jar.name} | ${tag || '—'} | Deck-shipped |`;
          if (fs.existsSync(f)) {
            const lines = fs.readFileSync(f, 'utf8').split('\n');
            const si = lines.findIndex(l => /^\|[-\s|]+\|$/.test(l.trim()));
            if (si !== -1) { lines.splice(si + 1, 0, row); fs.writeFileSync(f, lines.join('\n')); notes.push('logged to Client Deliveries Log'); }
            else { appendToFile(f, row); notes.push('appended to Client Deliveries Log'); }
          } else { appendToFile(f, row); notes.push('created Client Deliveries Log'); }
        } catch (e) { notes.push('log failed: ' + e.message); }
        return json(res, 200, { ok: true, notes, jar: jar.name });
      }
      // git status: changed files + an auto-suggested commit message (for the commit dialog)
      if (parts[3] === 'git' && parts[4] === 'status' && req.method === 'GET') {
        const repo = expand(u.searchParams.get('repo') || '');
        if (!repo || !fs.existsSync(path.join(repo, '.git'))) return json(res, 400, { error: 'bad repo' });
        const out = await runSafe('git', ['status', '--porcelain'], repo);
        const files = out.split('\n').filter(Boolean).map(l => {
          const code = l.slice(0, 2).trim(); const file = l.slice(3);
          const kind = code.includes('D') ? 'deleted' : (code.includes('A') || code === '??') ? 'added' : 'modified';
          return { path: file, code, kind };
        });
        const uniq = [...new Set(files.map(f => path.basename(f.path)))];
        const suggested = !files.length ? '' : files.length === 1 ? `update ${uniq[0]}`
          : `update ${uniq.slice(0, 3).join(', ')}${uniq.length > 3 ? ` +${uniq.length - 3} more` : ''}`;
        return json(res, 200, { files, suggested });
      }
      // git actions
      if (parts[3] === 'git' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const repo = expand(body.repo); const action = parts[4];
        if (!repo || !fs.existsSync(repo)) return json(res, 400, { error: 'bad repo' });
        try {
          if (action === 'commit') {
            const files = Array.isArray(body.files) && body.files.length ? body.files : null;
            if (files) await run('git', ['add', '-A', '--', ...files], repo);
            else await run('git', ['add', '-A'], repo);
            const msg = (body.message || 'deck: quick commit').slice(0, 500);
            const args = ['-c', 'user.name=zlexo', 'commit', '-m', msg];
            if (files) args.push('--', ...files);
            await run('git', args, repo);
            if (body.push) { try { await run('git', ['push'], repo); } catch (e) {} }
            return json(res, 200, { ok: true });
          }
          if (action === 'push') { const out = await run('git', ['push'], repo); return json(res, 200, { ok: true, out }); }
          if (action === 'pull') { const out = await run('git', ['pull', '--ff-only'], repo); return json(res, 200, { ok: true, out }); }
          if (action === 'create-remote') {
            const name = path.basename(repo);
            const out = await run('gh', ['repo', 'create', `zlexo/${name}`, '--private', '--source', '.', '--push'], repo);
            return json(res, 200, { ok: true, out });
          }
        } catch (e) { return json(res, 500, { error: (e.stderr || e.message || '').toString().slice(0, 500) }); }
      }
    }

    // ---- health: what needs attention across ALL projects ------------------
    if (u.pathname === '/api/health' && req.method === 'GET') {
      const manifests = loadManifests();
      const projects = loadProjects();
      const items = [];
      for (const p of Object.values(projects)) {
        const d = await assembleProject(p, manifests, { full: true });
        for (const g of (d.git || [])) {
          if (!g.exists) continue;
          if (!g.hasRemote) items.push({ project: p.id, name: p.name, color: d.color, kind: 'no-remote', sev: 2, text: `${g.name}: no GitHub remote` });
          else if (g.ahead) items.push({ project: p.id, name: p.name, color: d.color, kind: 'unpushed', sev: 2, text: `${g.name}: ${g.ahead} unpushed` });
          if (g.dirty) items.push({ project: p.id, name: p.name, color: d.color, kind: 'dirty', sev: 1, text: `${g.name}: ${g.dirty} uncommitted` });
        }
        const jar = d.artifacts && d.artifacts.jar;
        if (jar && jar.stale && jar.stale.sourceNewer) items.push({ project: p.id, name: p.name, color: d.color, kind: 'stale', sev: 3, text: `jar ${jar.stale.days}d stale — source newer` });
      }
      items.sort((a, b) => b.sev - a.sev);
      return json(res, 200, { items });
    }

    // ---- session recap: diff a project's repos since a time, append to daily
    if (parts[0] === 'api' && parts[1] === 'recap' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const p = loadProjects()[body.project];
      if (!p) return json(res, 404, { error: 'unknown project' });
      const since = body.since || (body.seconds ? `${Math.ceil(body.seconds / 60) + 5} minutes ago` : '2 hours ago');
      const lines = [];
      for (const r of (p.repos || [])) {
        const cwd = expand(r.path);
        if (!fs.existsSync(path.join(cwd, '.git'))) continue;
        const commits = await runSafe('git', ['log', '--since', since, '--pretty=format:%h %s', '-20'], cwd);
        const uncommitted = await runSafe('git', ['diff', '--shortstat'], cwd);
        if (commits || uncommitted) {
          lines.push(`  - **${path.basename(cwd)}**${commits ? '\n' + commits.split('\n').map(c => `    - ${c}`).join('\n') : ''}${uncommitted ? `\n    - _working tree:_ ${uncommitted.trim()}` : ''}`);
        }
      }
      if (!lines.length) return json(res, 200, { ok: true, empty: true });
      const dur = body.seconds ? ` (${fmtDur(body.seconds)})` : '';
      const entry = `- 📓 **Session recap — ${p.name}${dur}** · ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}\n${lines.join('\n')}`;
      try { appendToFile(inVault('Daily', `${todayStr()}.md`), entry); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }

    // ---- time analytics: parse the ledger into per-project/day totals -------
    if (u.pathname === '/api/vault/time-stats' && req.method === 'GET') {
      const v = vaultDir(), f = v && path.join(v, 'Health', 'Time Tracking.md');
      const byProject = {}, byDay = {}; let total = 0;
      if (f && fs.existsSync(f)) {
        for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
          // "YYYY-MM-DD · Project · Xh Ym · mode"
          const m = l.match(/^(\d{4}-\d{2}-\d{2})\s*·\s*(.+?)\s*·\s*(?:(\d+)h\s*)?(?:(\d+)m)?/);
          if (!m) continue;
          const day = m[1], proj = m[2].trim(), secs = ((+m[3] || 0) * 3600 + (+m[4] || 0) * 60);
          byProject[proj] = (byProject[proj] || 0) + secs;
          byDay[day] = (byDay[day] || 0) + secs;
          total += secs;
        }
      }
      // last 7 days
      const days = [];
      for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; days.push({ day: k, seconds: byDay[k] || 0 }); }
      return json(res, 200, { total, byProject, week: days });
    }

    // ---- timer log ----------------------------------------------------------
    if (u.pathname === '/api/timer/log' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.seconds || body.seconds < 30) return json(res, 200, { ok: true, skipped: 'too short' });
      if (!vaultDir()) return json(res, 200, { ok: true, skipped: 'no vault' });
      try { logSession(body); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }

    // ---- tasks (vault-backed checklist) -------------------------------------
    if (u.pathname === '/api/tasks') {
      if (req.method === 'GET') return json(res, 200, { tasks: readTasks() });
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        let tasks = readTasks();
        if (body.op === 'add') tasks.push({ text: body.text, done: false, project: body.project || null, due: body.due || null });
        else if (body.op === 'toggle') { const t = tasks[body.index]; if (t) t.done = !t.done; }
        else if (body.op === 'delete') tasks.splice(body.index, 1);
        else if (body.op === 'set') tasks = body.tasks || tasks;
        if (!vaultDir()) return json(res, 409, { error: 'no vault: create one or adopt a folder (/api/vault)' });
        writeTasks(tasks);
        return json(res, 200, { ok: true, tasks: readTasks() });
      }
    }

    // ---- vault quick actions ------------------------------------------------
    if (u.pathname === '/api/vault/daily' && req.method === 'GET') {
      const v = vaultDir(), f = v && path.join(v, 'Daily', `${todayStr()}.md`);
      const exists = !!f && fs.existsSync(f);
      return json(res, 200, { date: todayStr(), exists, content: exists ? fs.readFileSync(f, 'utf8') : '' });
    }
    if (u.pathname === '/api/vault/capture' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const text = (body.text || '').trim(); if (!text) return json(res, 400, { error: 'empty' });
      try { appendToFile(inVault('Daily', `${todayStr()}.md`), `- 💭 ${text}`); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (u.pathname === '/api/vault/recent' && req.method === 'GET') {
      // The folder goes in as $1, never into the script: an adopted vault's
      // path is whatever the user picked, quotes included.
      const v = vaultDir();
      const out = !v ? '' : await runSafe('bash', ['-c', `find "$1" -name '*.md' -not -path '*/.*' -type f -exec stat -f '%m%t%N' {} + 2>/dev/null | sort -rn | head -14`, 'recent', v]);
      const notes = out.split('\n').filter(Boolean).map(l => { const p = l.split('\t')[1]; return p ? { name: path.basename(p, '.md'), path: p } : null; }).filter(Boolean);
      return json(res, 200, { notes });
    }

    if (u.pathname === '/api/open' && req.method === 'POST') {
      const { path: p } = JSON.parse(await readBody(req) || '{}');
      return json(res, 200, { ok: true, message: openInFinder(p) });
    }

    if (await v2.handle(req, res, u)) return;

    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 500, { error: e.message }); }
}

// Loopback only, IPv4 and IPv6: anything on the same network could otherwise
// start tools, commit and push, kill processes or delete build folders.
// DECK_HOST overrides it for a deliberate setup.
const HOSTS = process.env.DECK_HOST ? [process.env.DECK_HOST] : ['127.0.0.1', '::1'];
for (const host of HOSTS) {
  const srv = http.createServer(handle);
  srv.on('error', e => {
    if (host === '::1' && (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT')) return; // no IPv6 loopback
    console.error(`Deck could not listen on ${host}:${PORT}: ${e.message}`);
    if (host === HOSTS[0]) process.exit(1);
  });
  srv.listen(PORT, host, () => { if (host === HOSTS[0]) console.log(`\n  Deck → http://localhost:${PORT}\n`); });
}

// Deck going down stops everything it started and exits only once all of it
// is gone: each child gets SIGTERM and its own stopGraceMs (the MC server
// saves its world, a VM shuts down cleanly), then SIGKILL. Until
// 2026-10-21 this exited as soon as the v2 features had stopped (2.3 s at
// most), whatever was still running: that cancelled the SIGKILL timers and
// orphaned any child still inside its grace.
// The native shell asks for this on app quit (POST /api/shutdown); SIGTERM
// and SIGINT run the same. In a terminal a second Ctrl-C quits at once and
// leaves the tools running.
const V2_STOP_MS = 2000;
function shutdown(signal) {
  if (stopping) { if (signal === 'SIGINT') process.exit(130); return; }
  stopping = true;
  const running = Object.keys(procs).filter(key => alive(procs[key])).length;
  if (signal === 'SIGINT' && running) console.log(`stopping ${running} tool(s) first; Ctrl-C again to quit now and leave them running`);
  const manifests = loadManifests(), projects = loadProjects();
  const children = Object.keys(procs).map(key => stopProc(key, graceOf(key, manifests, projects)));
  // v2 runs (CI jobs, Mod Lab benches) own process groups of their own.
  const v2Stop = Promise.race([v2.shutdown(), new Promise(r => setTimeout(r, V2_STOP_MS))]);
  Promise.allSettled([...children, v2Stop]).then(() => setTimeout(() => process.exit(0), 300));
}
// The longest shutdown() can take: the slowest running child's grace.
function shutdownMs() {
  const manifests = loadManifests(), projects = loadProjects();
  const graces = Object.keys(procs).filter(key => alive(procs[key])).map(key => graceOf(key, manifests, projects));
  return Math.max(V2_STOP_MS, ...graces) + 300;
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

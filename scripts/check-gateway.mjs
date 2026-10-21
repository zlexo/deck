// Compiles the gateway the way the app ships it (bun --compile) into a temp
// file and starts it with launchd's bare PATH on a spare port, then asks it what
// its children would see. This is the check that catches "works under
// `node server.js`, broken in the app": a missing route in the bundle, a
// module that needs top-level await, a tool that only resolves on a terminal PATH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codeHash } from '../lib/core/build-hash.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-gateway-check-'));
const out = path.join(tmp, 'deck-server');
const fail = msg => { console.error(`check-gateway: ${msg}`); cleanup(); process.exit(1); };
let child = null;
function cleanup() {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}

const bun = ['/opt/homebrew/bin/bun', '/usr/local/bin/bun', path.join(os.homedir(), '.bun/bin/bun')].find(f => fs.existsSync(f)) || 'bun';
const stamp = { sha: 'check', builtAt: new Date().toISOString(), serverHash: codeHash(ROOT) };
// cwd is the temp folder: bun --compile leaves a 63 MB .<hash>.bun-build file
// in its working directory on every run.
const b = spawnSync(bun, ['build', '--compile', path.join(ROOT, 'server.js'), '--outfile', out, '--define', `DECK_BUILD=${JSON.stringify(stamp)}`], { cwd: tmp, encoding: 'utf8' });
if (b.status !== 0) fail(`bun build failed:\n${b.stderr || b.stdout}`);

const port = await new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
child = spawn(out, [], {
  cwd: ROOT,
  env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), USER: os.userInfo().username,
         DECK_ROOT: ROOT, PORT: String(port), DECK_DATA: path.join(tmp, 'data'), DECK_VAULT: path.join(tmp, 'vault'),
         DECK_NO_BACKGROUND: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', d => logs += d);
child.stderr.on('data', d => logs += d);

const get = async p => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json() }; };
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try { up = (await get('/api/version')).status === 200; } catch { await new Promise(r => setTimeout(r, 100)); }
}
if (!up) fail(`the compiled gateway never answered /api/version. Its output:\n${logs}`);

const v = (await get('/api/version')).body;
if (!v.compiled || v.stale) fail(`/api/version says compiled=${v.compiled} stale=${v.stale}`);
const env = (await get('/api/v2/env')).body;
const missing = ['git', 'gh', 'node', 'npm', 'bun', 'security'].filter(c => !env.resolved[c]);
if (missing.length) fail(`under the app's PATH these do not resolve: ${missing.join(', ')}`);
const badges = await get('/api/badges');
if (badges.status !== 200) fail(`/api/badges answered ${badges.status}`);
const extra = (process.env.CHECK_ROUTES || '').split(',').filter(Boolean);
for (const r of extra) {
  const res = await get(r);
  if (res.status !== 200) fail(`${r} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
}
// The native shell quits the app through this route: the compiled gateway
// must take it, say how long it needs, and exit on its own.
const exited = new Promise(r => child.once('exit', code => r(code)));
const down = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST' });
const answer = await down.json().catch(() => null);
if (down.status !== 200 || typeof answer?.graceMs !== 'number') fail(`/api/shutdown answered ${down.status}: ${JSON.stringify(answer)}`);
const code = await Promise.race([exited, new Promise(r => setTimeout(() => r('still running'), 10000))]);
if (code !== 0) fail(`after /api/shutdown the compiled gateway ${code === 'still running' ? 'was still running 10 s later' : `exited with ${code}`}`);
console.log(`check-gateway: compiled gateway up on :${port} with the bare PATH; ${env.routes.length} v2 routes; tools resolve (${Object.entries(env.resolved).filter(([, v]) => v).map(([k]) => k).join(', ')}); /api/shutdown exits it`);
cleanup();

// node scripts/with-heavy-lock.mjs -- <cmd> [args...]
//
// Runs a heavy command (a Gradle build, a CMake build, npm ci, a Minecraft
// server) only while holding the machine-wide `heavy` lock, the same lock CI
// runs and Mod Lab benches hold. On an 8 GB Mac two of these at once push the
// machine into swap and both crawl; one at a time finishes sooner.
//
// The lock lives in the real data folder whatever DECK_DATA says, so every
// worktree and the installed Deck share it. Waits for a holder to finish.
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

process.env.DECK_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Deck');
const { acquireLock, lockHolder } = await import('../lib/core/lock.mjs');
const { toolEnv } = await import('../lib/core/env.mjs');

const i = process.argv.indexOf('--');
const argv = i >= 0 ? process.argv.slice(i + 1) : process.argv.slice(2);
if (!argv.length) { console.error('usage: with-heavy-lock.mjs -- <cmd> [args...]'); process.exit(2); }

let lock = null, said = false;
while (!(lock = acquireLock('heavy', { what: argv.join(' ').slice(0, 200), cwd: process.cwd() }))) {
  const h = lockHolder('heavy');
  if (!said && h) { console.error(`with-heavy-lock: waiting for pid ${h.pid}: ${h.what || '?'}`); said = true; }
  await new Promise(r => setTimeout(r, 3000));
}
const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env: toolEnv() });
const stop = sig => { try { child.kill(sig); } catch {} };
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('exit', (code, signal) => {
  lock.release();
  process.exit(code ?? (signal ? 1 : 0));
});

// The environment child processes get. The installed app starts the gateway
// with launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), where gh, npm, node,
// bun and Homebrew's tools do not exist; a terminal has them all. Without this,
// everything works under `node server.js` and fails in the app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FRONT = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
const BASE = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export function toolPath(current = process.env.PATH || '') {
  const seen = new Set();
  const out = [];
  for (const dir of [...FRONT, ...current.split(':'), ...BASE]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out.join(':');
}

export function toolEnv(extra = {}) {
  return { ...process.env, PATH: toolPath(), ...extra };
}

// Absolute path of a command on toolPath(), or null.
export function which(cmd) {
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : null;
  for (const dir of toolPath().split(':')) {
    const f = path.join(dir, cmd);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {}
  }
  return null;
}

// Every executable of that name on toolPath(), in PATH order, each real file
// once (two folders often link to the same install).
export function whichAll(cmd) {
  const out = [], seen = new Set();
  for (const dir of toolPath().split(':')) {
    const f = path.join(dir, cmd);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      const real = fs.realpathSync(f);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(f);
    } catch {}
  }
  return out;
}

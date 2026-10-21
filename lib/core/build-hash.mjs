// The identity of the gateway's code: server.js, everything under lib/, and the
// lockfile (the bundled SDK version). scripts/build-gateway.mjs stamps this into
// the compiled sidecar and /api/version compares it with the checkout, so a
// sidecar built before a lib/ change reports itself stale like it always did
// for server.js changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function codeFiles(root) {
  const out = ['server.js', 'package-lock.json'];
  const walk = rel => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (/\.(m?js|json)$/.test(e.name)) out.push(r);
    }
  };
  walk('lib');
  return out;
}

export function codeHash(root) {
  const h = crypto.createHash('sha256');
  for (const rel of codeFiles(root)) {
    let data;
    try { data = fs.readFileSync(path.join(root, rel)); } catch { continue; }
    h.update(rel + '\0');
    h.update(data);
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

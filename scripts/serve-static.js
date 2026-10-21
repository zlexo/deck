#!/usr/bin/env node
// serve-static.js — a static file server for tools that are just a folder of
// HTML/JS (the study decks in the vault, for one).
//
//   node scripts/serve-static.js --port 8885 --dir ~/vault/Learning
//
// Deck starts it when the tool tab opens and SIGTERMs it when the tab closes,
// so there is nothing to remember to shut down. Localhost only: it binds
// 127.0.0.1, refuses paths that escape --dir, and serves nothing else.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

const PORT = Number(arg('--port', '8885'));
const ROOT = path.resolve(expand(arg('--dir', process.cwd())));
const INDEX = arg('--index', 'index.html');

if (!fs.existsSync(ROOT)) {
  console.error(`[serve-static] no such folder: ${ROOT}`);
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
};

const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end('bad url'); return; }

  let full = path.resolve(ROOT, '.' + rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('forbidden');                 /* ../ escape */
    return;
  }
  let stat = null;
  try { stat = fs.statSync(full); } catch { /* handled below */ }
  if (stat && stat.isDirectory()) {
    if (!rel.endsWith('/')) {                            /* keep relative links honest */
      res.writeHead(302, { location: rel + '/' }).end();
      return;
    }
    full = path.join(full, INDEX);
    try { stat = fs.statSync(full); } catch { stat = null; }
  }
  if (!stat) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel);
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',                         /* the vault is edited live */
    'content-length': stat.size,
  });
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve-static] ${ROOT} → http://localhost:${PORT}`);
});

/* Deck stops a tool by SIGTERM when its tab closes; exit cleanly so the port is
   free immediately for the next start. */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log('[serve-static] stopping');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

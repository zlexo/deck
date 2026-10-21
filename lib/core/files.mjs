// Small file helpers. Records are written atomically (temp file + rename) so a
// reader polling a record never sees half of one.
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// One JSON object per line. A single write() per line with O_APPEND, so two
// processes appending at once do not interleave inside a line.
export function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// Lines that do not parse are skipped (a crash mid-write leaves at most one).
export function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// The last n lines of a text file, reading only its end.
export function tailLines(file, n = 200, maxBytes = 2 * 1024 * 1024) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // first line is partial
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  } finally { fs.closeSync(fd); }
}

export function listFiles(dir, suffix = '') {
  try { return fs.readdirSync(dir).filter(f => f.endsWith(suffix)).map(f => path.join(dir, f)); }
  catch { return []; }
}

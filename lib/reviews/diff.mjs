// Turning git's output into what the reviewer reads: per-file diffs annotated
// with head line numbers, and numbered file listings. The numbers are what
// findings cite, so they come from git's hunk headers, never from counting by
// eye.
import path from 'node:path';

export const pad = n => String(n).padStart(5);

// `git diff --name-status -z -M`: "M\0path\0", and for renames and copies
// "R100\0old\0new\0".
export function parseNameStatusZ(out) {
  const parts = String(out || '').split('\0');
  const files = [];
  for (let i = 0; i < parts.length;) {
    const st = parts[i++];
    if (!st) continue;
    if (st[0] === 'R' || st[0] === 'C') files.push({ status: st[0], oldPath: parts[i++], path: parts[i++] });
    else files.push({ status: st[0], path: parts[i++] });
  }
  return files.filter(f => f.path);
}

// git quotes a path that holds a quote, a backslash or a control character
// (core.quotePath=false leaves other non-ASCII alone): C escapes, octal bytes.
export function unquote(p) {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const s = p.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const n = s[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(s.slice(i, i + 3), 8)); i += 2; continue; }
    bytes.push(({ n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 })[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

// Git ends a ---/+++ name with a tab when the name holds a space.
const fileName = (raw, prefix) => {
  const p = unquote(raw.replace(/\t$/, ''));
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
};

function chunkPath(lines) {
  let minus = null;
  for (const l of lines) {
    if (l.startsWith('@@')) break;
    if (l.startsWith('+++ ') && l !== '+++ /dev/null') return fileName(l.slice(4), 'b/');
    if (l.startsWith('rename to ')) return unquote(l.slice(10));
    if (l.startsWith('copy to ')) return unquote(l.slice(8));
    if (l.startsWith('--- ') && l !== '--- /dev/null') minus = fileName(l.slice(4), 'a/');
  }
  if (minus) return minus;
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0]);
  return m ? unquote(m[2]) : null;
}

// One entry per file, in git's order: { path, lines } with the raw lines.
export function splitDiff(text) {
  const lines = String(text || '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const chunks = [];
  let cur = null;
  for (const l of lines) {
    if (l.startsWith('diff --git ')) { cur = { lines: [l] }; chunks.push(cur); continue; }
    if (cur) cur.lines.push(l);
  }
  for (const c of chunks) c.path = chunkPath(c.lines);
  return chunks;
}

// "@@ -a,b +c,d @@" starts a hunk; c is the head line of its first line.
// Context and added lines get their head number; removed lines get none.
export function annotateChunk(lines) {
  const out = [];
  let n = 0, inHunk = false;
  for (const l of lines) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { n = Number(h[1]); inHunk = true; out.push(l); continue; }
    if (!inHunk) { out.push(l); continue; }
    const c = l[0];
    if (c === '+') { out.push(`${pad(n)}+|${l.slice(1)}`); n++; }
    else if (c === '-') { out.push(`${' '.repeat(5)}-|${l.slice(1)}`); }
    else if (c === ' ') { out.push(`${pad(n)} |${l.slice(1)}`); n++; }
    else out.push(l); // "\ No newline at end of file"
  }
  return out.join('\n');
}

// A file's lines as findings count them: a final newline ends the last line,
// it does not start another.
export function splitLines(text) {
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

export function numberLines(text, from = 1, to = Infinity) {
  const lines = splitLines(text);
  const out = [];
  for (let i = Math.max(1, from); i <= Math.min(lines.length, to); i++) out.push(`${pad(i)} |${lines[i - 1]}`);
  return out.join('\n');
}

// Machine-written files whose diff a reviewer cannot use: lockfiles and
// minified bundles. They are listed as changed but their text is not sent.
const GENERATED = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
  'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'composer.lock', 'go.sum', 'gradle.lockfile']);
export function isGenerated(file) {
  const base = path.posix.basename(file);
  return GENERATED.has(base) || base.endsWith('.lockfile') || /\.min\.(js|css)$/.test(base);
}

export const isBinary = text => text.includes('\0');

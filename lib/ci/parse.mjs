// Readers that turn a job's output into job.summary. Each reader sees every
// line as it streams (a Conduit check prints millions) and keeps only what it
// needs; finish() runs after the job ends, while its worktree still exists.
import fs from 'node:fs';
import path from 'node:path';

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = s => s.replace(ANSI, '');

// The last n lines, without keeping the rest.
export function ring(n) {
  const buf = [];
  return {
    push(line) { buf.push(line); if (buf.length > n) buf.shift(); },
    lines() { return buf.slice(); },
  };
}

// Perdix's scripts/ci-local.sh ends with:
//   == summary
//   passed: layering minecraft-files format build tidy linux-warnings
//   failed: none
//   not run here: Linux (gcc), ... need Linux;
//                 on macOS, 'ubsan' runs the UndefinedBehaviorSanitizer half.
export function parseCiLocal(lines) {
  const clean = lines.map(stripAnsi);
  let at = -1;
  for (let i = clean.length - 1; i >= 0; i--) if (clean[i].trim() === '== summary') { at = i; break; }
  if (at < 0) return null;
  const words = v => (v.trim() === 'none' || !v.trim() ? [] : v.trim().split(/\s+/));
  const out = { passed: [], failed: [], notRunHere: '' };
  let seen = false;
  for (let i = at + 1; i < clean.length; i++) {
    const line = clean[i];
    let m;
    if ((m = /^passed:(.*)$/.exec(line))) { out.passed = words(m[1]); seen = true; }
    else if ((m = /^failed:(.*)$/.exec(line))) { out.failed = words(m[1]); seen = true; }
    else if ((m = /^not run here:(.*)$/.exec(line))) {
      const parts = [m[1].trim()];
      while (i + 1 < clean.length && /^\s+\S/.test(clean[i + 1])) parts.push(clean[++i].trim());
      out.notRunHere = parts.join(' ');
    }
  }
  return seen ? out : null;
}

// Vitest's closing block:
//    Test Files  1 failed | 31 passed (32)
//         Tests  2 failed | 491 passed (493)
//        Errors  1 error
function vitestCounts(text) {
  const out = {};
  const total = /\((\d+)\)\s*$/.exec(text);
  if (total) out.total = Number(total[1]);
  for (const part of text.replace(/\(\d+\)\s*$/, '').split('|')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(part);
    if (m) out[m[2].replace(/\s+(\w)/g, (_, c) => c.toUpperCase())] = Number(m[1]);
  }
  return out;
}

export function parseVitest(lines) {
  let files = null, tests = null, errors = null;
  for (const raw of lines) {
    const line = stripAnsi(raw);
    let m;
    if ((m = /^\s*Test Files\s+(.*)$/.exec(line))) files = vitestCounts(m[1]);
    else if ((m = /^\s*Tests\s+(\d.*)$/.exec(line))) tests = vitestCounts(m[1]);
    else if ((m = /^\s*Errors\s+(\d+)\s+errors?/.exec(line))) errors = Number(m[1]);
  }
  if (!files && !tests) return null;
  const out = { files, tests };
  if (errors != null) out.errors = errors;
  return out;
}

// JUnit XML under every build/test-results folder below `root`. Bounded: it
// does not descend into run folders (game test worlds) or dependencies.
const SKIP = new Set(['node_modules', '.gradle', '.git', 'src', 'run', 'runs', '.idea']);
export function junitFiles(root, maxDepth = 6) {
  const out = [];
  const xmlBelow = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) xmlBelow(p);
      else if (e.name.endsWith('.xml')) out.push(p);
    }
  };
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.name === 'build') xmlBelow(path.join(p, 'test-results'));
      else walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out.sort();
}

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};

export function junitCounts(root) {
  const files = junitFiles(root);
  const out = { suites: 0, tests: 0, failures: 0, errors: 0, skipped: 0, failed: [] };
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/<testsuite\b[^>]*>/g)) {
      out.suites++;
      for (const k of ['tests', 'failures', 'errors', 'skipped']) out[k] += Number(attr(m[0], k)) || 0;
    }
    // A failing case: a <testcase> whose body holds <failure or <error.
    for (const chunk of text.split(/<testcase\b/).slice(1)) {
      const body = chunk.split('</testcase>')[0];
      if (!/<(failure|error)\b/.test(body)) continue;
      const head = body.slice(0, body.indexOf('>') + 1);
      if (out.failed.length < 20) out.failed.push(`${attr(head, 'classname') || '?'}.${attr(head, 'name') || '?'}`);
    }
  }
  out.files = files.length;
  return out;
}

// Readers by name (a job's `parse`).
export const PARSERS = {
  'ci-local'() {
    const tail = ring(400);
    return { line: l => tail.push(l), finish: () => parseCiLocal(tail.lines()) };
  },
  vitest() {
    const tail = ring(200);
    return { line: l => tail.push(l), finish: () => parseVitest(tail.lines()) };
  },
  // A Gradle build: the JUnit results it wrote, the game test verdicts the
  // Minecraft servers printed, the tasks that failed, and Gradle's last word.
  gradle() {
    const game = { runs: 0, passed: 0, failed: 0 };
    const failedTasks = [];
    let build = null;
    const apiCompat = {};
    return {
      line(raw) {
        if (raw.length > 2000) return;
        const l = stripAnsi(raw);
        let m;
        if ((m = /All (\d+) required tests passed/.exec(l))) { game.runs++; game.passed += Number(m[1]); }
        else if ((m = /(\d+) required tests? failed/.exec(l))) { game.runs++; game.failed += Number(m[1]); }
        else if ((m = /^> Task (\S+) FAILED/.exec(l))) { if (failedTasks.length < 20) failedTasks.push(m[1]); }
        else if ((m = /^BUILD (SUCCESSFUL|FAILED) in (.+)$/.exec(l))) build = `${m[1]} in ${m[2].trim()}`;
        else if ((m = /^checkApiCompat: gating (.*)$/.exec(l))) apiCompat.gating = m[1].trim();
        else if ((m = /^checkApiCompat: (\d+ module\(s\) compared.*)$/.exec(l))) apiCompat.result = m[1].trim();
      },
      finish({ dir }) {
        const out = { junit: junitCounts(dir), gameTests: game };
        if (failedTasks.length) out.failedTasks = failedTasks;
        if (build) out.build = build;
        if (apiCompat.gating || apiCompat.result) out.apiCompat = apiCompat;
        return out;
      },
    };
  },
};

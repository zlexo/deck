// Child processes for v2 features. Every spawn goes through here so that
// (1) the command resolves on toolPath() even under launchd's bare PATH, and
// (2) each child leads its own process group, so stopping it also stops what
// it started (gradlew forks the game JVM; npm forks node; a bash wrapper forks
// the real command).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { toolEnv, which } from './env.mjs';
import { expandHome } from './paths.mjs';

export class RunError extends Error {
  constructor(message, result) { super(message); this.name = 'RunError'; this.result = result; }
}

// A bare name resolves on toolPath(); "./gradlew" stays relative to cwd.
function resolveCmd(cmd) {
  if (cmd.startsWith('~')) return expandHome(cmd);
  if (cmd.includes('/')) return cmd;
  return which(cmd) || cmd;
}

export function killGroup(pid, signal = 'SIGTERM') {
  if (!pid) return false;
  try { process.kill(-pid, signal); return true; } catch {}
  try { process.kill(pid, signal); return true; } catch { return false; }
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Runs a command to completion. Never rejects: a command that cannot start
// comes back with `error` set and `code: null`. `abort` (an AbortSignal) stops
// the command's group as a timeout does. Output past maxBuffer is dropped and
// `truncated` says so.
export function run(cmd, args = [], opts = {}) {
  const { cwd, env, unset = [], timeoutMs, input, maxBuffer = 64 * 1024 * 1024, abort } = opts;
  const started = Date.now();
  return new Promise(resolve => {
    let settled = false, timedOut = false, timer = null, killer = null;
    let stdout = '', stderr = '', size = 0, truncated = false;
    let stop = null;
    const finish = r => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killer);
      if (stop) abort.removeEventListener('abort', stop);
      resolve({ stdout, stderr, durationMs: Date.now() - started, timedOut, truncated, ...r });
    };
    if (abort && abort.aborted) return finish({ code: null, signal: null, error: new Error('aborted') });
    let child;
    try {
      const childEnv = toolEnv(env);
      for (const k of unset) delete childEnv[k]; // inherited variables the child must not see
      child = spawn(resolveCmd(cmd), args, { cwd: cwd && expandHome(cwd), env: childEnv, detached: true });
    } catch (error) {
      return finish({ code: null, signal: null, error });
    }
    child.stdout.on('data', d => { size += d.length; if (size <= maxBuffer) stdout += d; else truncated = true; });
    child.stderr.on('data', d => { size += d.length; if (size <= maxBuffer) stderr += d; else truncated = true; });
    child.on('error', error => finish({ code: null, signal: null, error }));
    child.on('close', (code, signal) => finish({ code, signal }));
    child.stdin.on('error', () => {});
    child.stdin.end(input == null ? undefined : input);
    if (abort) {
      stop = () => { killGroup(child.pid, 'SIGTERM'); if (!killer) killer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000); };
      abort.addEventListener('abort', stop, { once: true });
    }
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid, 'SIGTERM');
        if (!killer) killer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000);
      }, timeoutMs);
    }
  });
}

// run(), but a non-zero exit (or a failed start) throws RunError carrying the
// tail of stderr, which is what a caller usually has to show.
export async function runOk(cmd, args = [], opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.error || r.code !== 0) {
    const why = r.error ? r.error.message
      : r.timedOut ? `timed out after ${opts.timeoutMs} ms`
      : (r.stderr || r.stdout).trim().split('\n').slice(-8).join('\n') || `exit ${r.code}`;
    throw new RunError(`${cmd} ${args.join(' ')}: ${why}`, r);
  }
  return r.stdout;
}

// A long-running child with line-by-line output. Lines from stdout and stderr
// go to onLine(line, stream) and, when logFile is set, to that file.
// kill(graceMs) sends SIGTERM to the whole group, then SIGKILL after the grace.
export function spawnTracked(cmd, args = [], opts = {}) {
  const { cwd, env, logFile, onLine } = opts;
  let log = null;
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    log = fs.openSync(logFile, 'a');
  }
  const emit = (line, stream) => {
    if (log !== null) { try { fs.writeSync(log, line + '\n'); } catch {} }
    if (onLine) { try { onLine(line, stream); } catch {} }
  };
  const splitter = stream => {
    let buf = '';
    return {
      push(d) {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          emit(buf.slice(0, i).replace(/\r$/, ''), stream);
          buf = buf.slice(i + 1);
        }
      },
      flush() { if (buf) { emit(buf, stream); buf = ''; } },
    };
  };
  const out = splitter('stdout'), err = splitter('stderr');
  let exited = null;
  let child;
  const done = new Promise(resolve => {
    const finish = r => {
      if (exited) return;
      exited = r;
      out.flush(); err.flush();
      if (log !== null) { try { fs.closeSync(log); } catch {} log = null; }
      resolve(r);
    };
    try {
      child = spawn(resolveCmd(cmd), args, { cwd: cwd && expandHome(cwd), env: toolEnv(env), detached: true });
    } catch (error) {
      child = null;
      return finish({ code: null, signal: null, error });
    }
    child.stdout.on('data', d => out.push(d.toString()));
    child.stderr.on('data', d => err.push(d.toString()));
    child.on('error', error => finish({ code: null, signal: null, error }));
    child.on('close', (code, signal) => finish({ code, signal }));
    child.stdin.on('error', () => {});
  });
  return {
    child,
    pid: child && child.pid,
    done,
    get exited() { return exited; },
    write(line) {
      if (!child || exited || !child.stdin.writable) return false;
      child.stdin.write(line + '\n');
      return true;
    },
    kill(graceMs = 5000) {
      if (!child || exited) return done;
      killGroup(child.pid, 'SIGTERM');
      const t = setTimeout(() => killGroup(child.pid, 'SIGKILL'), graceMs);
      return done.finally(() => clearTimeout(t));
    },
  };
}

// Every process: pid, ppid, uid, rss, start time, command. `lstart` is five
// words ("Mon Oct 12 11:23:45 2026"), which is why the columns are split by position.
export async function listProcesses() {
  const r = await run('/bin/ps', ['-axo', 'pid=,ppid=,uid=,rss=,lstart=,command='], { maxBuffer: 32 * 1024 * 1024 });
  if (r.code !== 0) return [];
  return parsePs(r.stdout);
}

export function parsePs(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const w = raw.trim().split(/\s+/);
    if (w.length < 10) continue;
    // "Mon Oct 12 11:23:45 2026" -> "Oct 12 2026 11:23:45", a form V8 and JSC both parse.
    const startedAt = Date.parse(`${w[5]} ${w[6]} ${w[8]} ${w[7]}`);
    out.push({
      pid: Number(w[0]), ppid: Number(w[1]), uid: Number(w[2]), rssBytes: Number(w[3]) * 1024,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      cmd: w.slice(9).join(' '),
    });
  }
  return out;
}

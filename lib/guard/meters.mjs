// The header meters (concept § 5): free memory, swap, disk, and the Java
// processes on this 8 GB Mac. Sampled every 10 s by start(); snapshot() is the
// last sample. Thresholds come from config `guard` over these defaults.
import { execFileSync } from 'node:child_process';
import { run, listProcesses, parsePs } from '../core/proc.mjs';
import { configSection } from '../core/config.mjs';

const GB = 1024 ** 3;
export const DEFAULTS = {
  intervalS: 10,
  disk: { warnBytes: 5 * GB, badBytes: 2 * GB, volume: '/System/Volumes/Data' },
  swap: { warnPct: 50 },
  ram: { warnBytes: 1.5 * GB, badBytes: 0.75 * GB },
  gradle: { warnAbove: 2 },
  bench: { minFreeBytes: 1.5 * GB },
};
export const thresholds = state => configSection('guard', DEFAULTS, state);

// The executable is java when the command starts with a path ending in
// /bin/java (or a bare java). The path may contain spaces (the Minecraft
// launcher's runtime lives under "Application Support"), so the test is on the
// text before the first option rather than on the first word.
export function isJava(cmd) {
  if (/^java(\s|$)/.test(cmd)) return true;
  const i = cmd.indexOf('/bin/java');
  if (i < 0) return false;
  const after = cmd.charAt(i + '/bin/java'.length);
  const exe = cmd.slice(0, i);
  // An absolute path with no option and no second path before it: so
  // "node x.js /usr/bin/java" is not java, ".../Application Support/.../bin/java" is.
  return (after === '' || after === ' ') && exe.startsWith('/') && !exe.includes(' -') && !exe.includes(' /');
}

export function classifyJava(cmd) {
  if (!isJava(cmd)) return null;
  if (cmd.includes('org.gradle.launcher.daemon.bootstrap.GradleDaemon')) return 'gradle-daemon';
  if (/-Dfabric\.dli\.env=server|KnotServer|fabric-server-launch|paper.*\.jar|minecraft_server|\bnogui\b/.test(cmd)) return 'mc-server';
  if (/-Dfabric\.dli\.env=client|KnotClient|net\.minecraft\.client\.main\.Main/.test(cmd)) return 'mc-client';
  return 'other';
}

export function parseFreePct(text) {
  const m = /System-wide memory free percentage:\s*(\d+)%/.exec(text || '');
  return m ? Number(m[1]) : null;
}
export function parseSwap(text) {
  const m = /total = ([\d.]+)M\s+used = ([\d.]+)M/.exec(text || '');
  return m ? { totalBytes: Number(m[1]) * 1024 * 1024, usedBytes: Number(m[2]) * 1024 * 1024 } : null;
}
export function parseDf(text) {
  const line = (text || '').trim().split('\n')[1];
  if (!line) return null;
  const w = line.trim().split(/\s+/);
  return { totalBytes: Number(w[1]) * 1024, freeBytes: Number(w[3]) * 1024 };
}

const worst = levels => (levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok');

export function build({ freePct, memBytes, swap, disk, procs }, t) {
  const freeBytes = freePct == null ? null : Math.round(memBytes * freePct / 100);
  // A meter that could not be read is shown as a warning, never as fine.
  const ram = {
    freeBytes, totalBytes: memBytes, freePct, unknown: freeBytes == null,
    level: freeBytes == null ? 'warn' : freeBytes < t.ram.badBytes ? 'bad' : freeBytes < t.ram.warnBytes ? 'warn' : 'ok',
  };
  const swapPct = swap && swap.totalBytes > 0 ? Math.round(swap.usedBytes / swap.totalBytes * 100) : 0;
  const sw = { usedBytes: swap ? swap.usedBytes : 0, totalBytes: swap ? swap.totalBytes : 0, pct: swapPct, unknown: !swap, level: !swap || swapPct > t.swap.warnPct ? 'warn' : 'ok' };
  const diskOk = disk && Number.isFinite(disk.freeBytes) && Number.isFinite(disk.totalBytes);
  const dk = diskOk
    ? { ...disk, level: disk.freeBytes < t.disk.badBytes ? 'bad' : disk.freeBytes < t.disk.warnBytes ? 'warn' : 'ok' }
    : { freeBytes: null, totalBytes: null, unknown: true, level: 'warn' };
  const java = [];
  for (const p of procs) {
    const kind = classifyJava(p.cmd);
    if (kind) java.push({ pid: p.pid, rssBytes: p.rssBytes, kind, cmd: p.cmd.slice(0, 300), startedAt: p.startedAt });
  }
  const gradleDaemons = java.filter(j => j.kind === 'gradle-daemon').length;
  const gradleLevel = gradleDaemons > t.gradle.warnAbove ? 'warn' : 'ok';
  return { ts: Date.now(), level: worst([ram.level, sw.level, dk.level, gradleLevel]), ram, swap: sw, disk: dk, java, gradleDaemons, gradleLevel };
}

let memBytes = null;
async function memsize() {
  if (memBytes) return memBytes;
  const r = await run('/usr/sbin/sysctl', ['-n', 'hw.memsize']);
  memBytes = Number(r.stdout.trim()) || 8 * GB;
  return memBytes;
}

export async function sample(state) {
  const t = thresholds(state);
  const [mp, sw, df, procs, mem] = await Promise.all([
    run('/usr/bin/memory_pressure', [], { timeoutMs: 10000 }),
    run('/usr/sbin/sysctl', ['vm.swapusage']),
    run('/bin/df', ['-k', t.disk.volume]),
    listProcesses(),
    memsize(),
  ]);
  return build({ freePct: parseFreePct(mp.stdout), memBytes: mem, swap: parseSwap(sw.stdout), disk: parseDf(df.stdout), procs }, t);
}

// The same sample without awaiting, for the one synchronous caller
// (canStartBench) when no recent sample exists. About 100 ms, rarely.
export function sampleSync(state) {
  const t = thresholds(state);
  // Short timeouts: this blocks the event loop, and it only runs when no
  // sample is recent; an answer that does not come in time reads as unknown.
  const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 32 * 1024 * 1024 }); } catch { return ''; } };
  const mem = memBytes || Number(sh('/usr/sbin/sysctl', ['-n', 'hw.memsize']).trim()) || 8 * GB;
  memBytes = mem;
  return build({
    freePct: parseFreePct(sh('/usr/bin/memory_pressure', [])), memBytes: mem,
    swap: parseSwap(sh('/usr/sbin/sysctl', ['vm.swapusage'])),
    disk: parseDf(sh('/bin/df', ['-k', t.disk.volume])),
    procs: parsePs(sh('/bin/ps', ['-axo', 'pid=,ppid=,uid=,rss=,lstart=,command='])),
  }, t);
}

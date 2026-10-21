// The orphan sweep (concept § 5): dev processes whose parent is gone (parent
// pid 1) and that keep holding memory: Gradle daemons, node servers started
// from project folders, the Perdix engine, ffmpeg, and Remotion's headless Chrome.
// Killing one re-checks that the pid is still that same process.
import os from 'node:os';
import path from 'node:path';
import { listProcesses, pidAlive, killGroup } from '../core/proc.mjs';

const YT = path.join(os.homedir(), 'yt') + '/';

export function orphanKind(cmd) {
  const exe = cmd.split(' ')[0];
  if (cmd.includes('org.gradle.launcher.daemon.bootstrap.GradleDaemon')) return 'gradle-daemon';
  if (/(^|\/)node$/.test(exe) && cmd.includes(YT)) return 'node';
  if (/(^|\/)perdix$/.test(exe)) return 'perdix';
  if (/(^|\/)ffmpeg$/.test(exe)) return 'ffmpeg';
  if (/chrome-headless-shell/.test(cmd) || (/Chrom(e|ium)/.test(cmd) && /remotion/i.test(cmd))) return 'remotion-chrome';
  return null;
}

export async function findOrphans({ procs, uid = process.getuid(), self = process.pid } = {}) {
  const all = procs || await listProcesses();
  const now = Date.now();
  return all
    .filter(p => p.ppid === 1 && p.uid === uid && p.pid !== self)
    .map(p => ({ ...p, kind: orphanKind(p.cmd) }))
    .filter(p => p.kind)
    .map(p => ({ pid: p.pid, kind: p.kind, cmd: p.cmd.slice(0, 400), rssBytes: p.rssBytes, startedAt: p.startedAt,
      ageS: p.startedAt ? Math.round((now - p.startedAt) / 1000) : null }))
    .sort((a, b) => b.rssBytes - a.rssBytes);
}

// Kills an orphan only if `pid` is still an orphan of the same kind that
// started at `startedAt`: a pid freed and reused by an unrelated process in
// the meantime is refused. SIGTERM, then SIGKILL after 8 s if it lingers.
export async function killOrphan(pid, startedAt, { procs, uid, self } = {}) {
  pid = Number(pid);
  if (!Number.isFinite(Number(startedAt))) return { ok: false, reason: 'a start time is required, so a reused pid cannot be killed' };
  const now = await findOrphans({ procs, uid, self });
  const hit = now.find(o => o.pid === pid);
  if (!hit) return { ok: false, reason: `pid ${pid} is not an orphan dev process any more` };
  if (hit.startedAt !== Number(startedAt)) return { ok: false, reason: `pid ${pid} is a different process now (started ${new Date(hit.startedAt).toISOString()})` };
  if (!killGroup(pid, 'SIGTERM')) return { ok: false, reason: `could not signal pid ${pid}` };
  const t = setTimeout(async () => {
    if (!pidAlive(pid)) return;
    const again = (await findOrphans({ uid, self })).find(o => o.pid === pid && o.startedAt === hit.startedAt);
    if (again) killGroup(pid, 'SIGKILL');
  }, 8000);
  t.unref();
  return { ok: true, signal: 'SIGTERM', kind: hit.kind };
}

// The CI runner (contract § 5 and § 12). A FIFO queue of heads, deduplicated by
// repo and SHA. One run at a time across processes (lock `ci`), and a run holds
// the machine lock `heavy` for its whole length, so a Perdix build never
// overlaps a Minecraft server on an 8 GB Mac. A run checks the exact head out
// in a throwaway worktree under the data folder, never in a live checkout
// (a repo can be served live from its checkout; the other checkouts hold work in
// progress), runs the repo's jobs there in order, writes the record as it goes,
// and always removes the worktree.
//
// Lock order is `ci` then `heavy`. Every other holder of `heavy` (Mod Lab,
// scripts/with-heavy-lock.mjs) takes only `heavy`, so no two waits can cross.
import fs from 'node:fs';
import path from 'node:path';
import { dataPath, expandHome, tildify } from '../core/paths.mjs';
import { writeJsonAtomic } from '../core/files.mjs';
import { acquireLock, lockHolder } from '../core/lock.mjs';
import { spawnTracked, run, listProcesses } from '../core/proc.mjs';
import { git, gitSafe, SHA_RE, addWorktree, removeWorktree, fetchPrHead, fetchRef, fetchSha, hasCommit } from '../core/git.mjs';
import { gh, ghJson } from '../core/gh.mjs';
import { repos as configuredRepos, configSection } from '../core/config.mjs';
import { CI_DEFAULTS } from './defaults.mjs';
import { PARSERS } from './parse.mjs';
import { createLog } from './log.mjs';
import { ciRecordPath, recordFor, listRecords } from './records.mjs';

// A bad request (unknown repo, a word that is not a PR, SHA or main). The
// router answers `status`.
export class CiInputError extends Error {
  constructor(message) { super(message); this.name = 'CiInputError'; this.status = 400; }
}
// origin or GitHub could not be reached, or refused.
class UpstreamError extends Error {
  constructor(message) { super(message); this.name = 'UpstreamError'; this.status = 502; }
}
class Stopped extends Error {}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const BRANCH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

export const workDir = (repo, sha) => dataPath('ci', 'work', `${repo}-${sha.slice(0, 12)}`);
export const logDir = (repo, sha) => dataPath('ci', repo, sha);
// Held from the moment a head is queued until its run ends, by the process
// that queued it: it dedupes across processes, and a record left `queued` or
// `running` whose lock has no live holder belongs to a process that died.
export const runLockName = (repo, sha) => `ci-run-${repo}-${sha.slice(0, 12)}`;

// A job name as a file name: no separators, no leading dots.
export const logName = name => `${String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'job'}.log`;

export const cmdString = argv => argv
  .map(a => (/^[A-Za-z0-9_./:=@%+,{}-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
  .join(' ');

export function fmtDuration(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function ciConfig(state) { return configSection('ci', CI_DEFAULTS, state); }

// The repo and its jobs, validated. Throws CiInputError.
export function repoPlan(repoId, state) {
  if (typeof repoId !== 'string' || !ID_RE.test(repoId)) throw new CiInputError(`unknown repo '${repoId}'`);
  const all = configuredRepos(state);
  const repo = Object.hasOwn(all, repoId) ? all[repoId] : null;
  if (!repo) throw new CiInputError(`unknown repo '${repoId}'`);
  const cfg = ciConfig(state);
  const rc = cfg.repos && Object.hasOwn(cfg.repos, repoId) ? cfg.repos[repoId] : null;
  if (!rc || !Array.isArray(rc.jobs) || !rc.jobs.length) throw new CiInputError(`no CI jobs configured for ${repoId}`);
  const files = new Set();
  const jobs = rc.jobs.map((j, i) => {
    if (!j || typeof j.name !== 'string' || !j.name.trim()) throw new CiInputError(`${repoId}: CI job ${i + 1} has no name`);
    if (!Array.isArray(j.cmd) || !j.cmd.length || !j.cmd.every(a => typeof a === 'string')) throw new CiInputError(`${repoId}: CI job '${j.name}' has no cmd`);
    const file = logName(j.name);
    if (files.has(file)) throw new CiInputError(`${repoId}: two CI jobs would share the log ${file}`);
    files.add(file);
    return { ...j, file, timeoutMin: Number(j.timeoutMin || rc.timeoutMin || 30) };
  });
  return {
    id: repoId, repo, jobs,
    pollMs: Number(cfg.pollMs) || 2000,
    logMaxBytes: Number(cfg.logMaxBytes) || 64 * 1024 * 1024,
    minFreeDiskGB: cfg.minFreeDiskGB == null ? 3 : Number(cfg.minFreeDiskGB),
    stopBelowFreeDiskGB: cfg.stopBelowFreeDiskGB == null ? 1 : Number(cfg.stopBelowFreeDiskGB),
    diskCheckMs: Number(cfg.diskCheckMs) || 15000,
  };
}

// Free bytes on the disk that holds `dir` (or its nearest existing parent).
export function freeDiskBytes(dir) {
  let d = path.resolve(dir);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  const s = fs.statfsSync(d);
  return Number(s.bavail) * Number(s.bsize);
}
const gb = bytes => (bytes / 1024 ** 3).toFixed(1);

// A word from the command line: a pull request number, a commit SHA, or main.
export function parseTarget(word) {
  const w = String(word || '');
  if (/^\d{1,6}$/.test(w) && Number(w) > 0) return { pr: Number(w) };
  if (w === 'main') return { ref: 'main' };
  if (/^[0-9a-f]{7,40}$/i.test(w)) return { sha: w.toLowerCase() };
  throw new CiInputError(`'${w}' is not a pull request number, a commit SHA or main`);
}

// The exact head to run: { sha, pr, ref }. A PR, main, or a SHA the checkout
// lacks is fetched from origin by SHA: objects only, no ref or FETCH_HEAD
// written, no working tree touched.
export async function resolveHead(repoCfg, t = {}) {
  const cwd = repoCfg.path;
  const given = ['pr', 'sha', 'ref'].filter(k => t[k] != null && t[k] !== '');
  if (given.length !== 1) throw new CiInputError('say which head to run: one of pr, sha, or ref: "main"');
  const upstream = (what, e) => new UpstreamError(`could not fetch ${what} of ${repoCfg.slug || repoCfg.path}: ${e.message}`);
  let out;
  if (t.pr != null) {
    const n = Number(t.pr);
    if (!Number.isInteger(n) || n <= 0) throw new CiInputError(`'${t.pr}' is not a pull request number`);
    try { out = { sha: await fetchPrHead(cwd, n), pr: n, ref: `pull/${n}/head` }; }
    catch (e) { throw upstream(`pull request #${n}`, e); }
  } else if (t.ref != null) {
    if (t.ref !== 'main') throw new CiInputError(`only "main" can be run by ref, not '${t.ref}'`);
    try { out = { sha: await fetchRef(cwd, 'main'), pr: null, ref: 'main' }; }
    catch (e) { throw upstream('main', e); }
  } else {
    const s = String(t.sha).toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(s)) throw new CiInputError(`'${t.sha}' is not a commit SHA`);
    if (s.length === 40 && await hasCommit(cwd, s)) out = { sha: s, pr: null, ref: null };
    else {
      const full = await gitSafe(['rev-parse', '--verify', '--quiet', `${s}^{commit}`], expandHome(cwd));
      if (SHA_RE.test(full)) out = { sha: full, pr: null, ref: null };
      else if (s.length === 40) {
        try { await fetchSha(cwd, s); } catch {}
        if (await hasCommit(cwd, s)) out = { sha: s, pr: null, ref: null };
      }
    }
    if (!out) throw new CiInputError(`no commit ${s} in ${tildify(expandHome(cwd))} or on origin`);
  }
  if (!SHA_RE.test(out.sha || '')) throw new UpstreamError(`resolving the head gave '${out.sha}', not a SHA`);
  return out;
}

// GitHub facts the planner needs, through gh. Tests replace these.
async function prInfo(repoCfg, pr) {
  const j = await ghJson(['pr', 'view', String(pr), '-R', repoCfg.slug, '--json', 'labels,baseRefName']);
  return { pr, labels: (j.labels || []).map(l => l.name), base: j.baseRefName || 'main' };
}
async function findPrForSha(repoCfg, sha) {
  const list = await ghJson(['pr', 'list', '-R', repoCfg.slug, '--state', 'open', '--limit', '200', '--json', 'number,labels,baseRefName,headRefOid']);
  const hit = list.find(p => p.headRefOid === sha);
  return hit ? { pr: hit.number, labels: (hit.labels || []).map(l => l.name), base: hit.baseRefName || 'main' } : null;
}
// The token is read at the moment a job needs it and goes only into that
// job's environment. The error never carries gh's output.
async function githubEnv(repoCfg) {
  const r = await run('gh', ['auth', 'token'], { timeoutMs: 30000 });
  const token = r.code === 0 ? r.stdout.trim() : '';
  if (!token) throw new Error(r.error ? r.error.message : `gh auth token exited ${r.code}`);
  let actor = '';
  try { actor = (await gh(['api', 'user', '--jq', '.login'])).trim(); } catch {}
  return { GITHUB_ACTOR: actor || String(repoCfg.slug || '').split('/')[0], GITHUB_TOKEN: token };
}

function freshRecord(item, plan, status) {
  return {
    v: 1, repo: item.repo, sha: item.sha, pr: item.pr ?? null, ref: item.ref ?? null, status,
    startedAt: Date.now(), finishedAt: 0, durationMs: 0,
    jobs: plan.jobs.map(j => ({ name: j.name, cmd: cmdString(j.cmd), status: 'pending', durationMs: 0, log: null, summary: {} })),
    error: null,
  };
}

function markEnded(rec, why) {
  rec.status = 'error';
  rec.error = why;
  for (const j of rec.jobs || []) {
    if (j.status === 'running') { j.status = 'red'; j.summary = { ...(j.summary || {}), reason: `interrupted: ${why}` }; }
    else if (j.status === 'pending') { j.status = 'skipped'; j.summary = { reason: `not run: ${why}` }; }
  }
}

const writeRecord = rec => writeJsonAtomic(ciRecordPath(rec.repo, rec.sha), rec);

export function createRunner(opts = {}) {
  const {
    getState = () => undefined,
    onEvent = () => {},
    parsers = PARSERS,
    killGraceMs = 10000,
    // After the command itself exits, how long processes it started may keep
    // its output open before they are stopped.
    exitGraceMs = 60000,
    // Measures the free disk a run would use; tests replace it.
    freeDisk = () => freeDiskBytes(dataPath()),
  } = opts;
  const gh = { prInfo, findPrForSha, githubEnv, ...(opts.github || {}) };

  const queue = [];
  let current = null;
  let started = false;
  let pumping = null;
  const sleepers = new Set();

  const emit = (type, data = {}) => { try { onEvent({ type, ...data }); } catch {} };

  // Background waits: unref'd, and stop() ends them at once.
  function sleep(ms) {
    return new Promise(resolve => {
      const s = { resolve, timer: setTimeout(() => { sleepers.delete(s); resolve(); }, ms) };
      s.timer.unref();
      sleepers.add(s);
    });
  }
  function wakeAll() {
    for (const s of sleepers) { clearTimeout(s.timer); s.resolve(); }
    sleepers.clear();
  }

  async function waitLock(name, info, item, pollMs) {
    let told = false;
    for (;;) {
      if (item.aborted) throw new Stopped(item.abortReason);
      const l = acquireLock(name, info);
      if (l) return l;
      if (!told) { told = true; emit('wait', { repo: item.repo, sha: item.sha, lock: name, holder: lockHolder(name) }); }
      await sleep(pollMs);
    }
  }

  async function enqueue(req = {}) {
    const plan = repoPlan(req.repo, getState());
    const head = await resolveHead(plan.repo, req);
    const key = `${plan.id}:${head.sha}`;
    if ((current && current.key === key) || queue.some(q => q.key === key)) return { queued: true, sha: head.sha, already: true };
    const runLock = acquireLock(runLockName(plan.id, head.sha), { what: `CI ${plan.id} ${head.sha.slice(0, 12)}`, repo: plan.id, sha: head.sha });
    if (!runLock) {
      const h = lockHolder(runLockName(plan.id, head.sha));
      return { queued: true, sha: head.sha, already: true, elsewhere: h ? h.pid : null };
    }
    const item = { key, repo: plan.id, sha: head.sha, pr: head.pr, ref: head.ref, runLock, aborted: false, abortReason: null, job: null, tracked: null };
    item.done = new Promise(r => { item.resolveDone = r; });
    try { writeRecord(freshRecord(item, plan, 'queued')); }
    catch (e) { runLock.release(); throw e; }
    queue.push(item);
    emit('queued', { repo: item.repo, sha: item.sha, pr: item.pr, ref: item.ref, position: queue.length + (current ? 1 : 0) });
    pump();
    return { queued: true, sha: head.sha };
  }

  function pump() {
    if (!started || pumping) return;
    pumping = (async () => {
      while (started && queue.length) {
        const item = queue.shift();
        current = item;
        try { await runItem(item); }
        catch (e) { console.error(`ci: run of ${item.repo} ${item.sha.slice(0, 12)} failed outside its record: ${e.stack || e.message}`); }
        finally { current = null; }
      }
    })().finally(() => { pumping = null; if (started && queue.length) pump(); });
  }

  // Which jobs run, and with what argv. Network work (gh, fetches) happens
  // here, before the worktree exists.
  async function planJobs(plan, item, rec) {
    const repoCfg = plan.repo;
    const jobs = plan.jobs;
    let facts = null;
    if (jobs.some(j => j.prOnly || j.skipLabel)) {
      try {
        if (item.pr) facts = await gh.prInfo(repoCfg, item.pr);
        else {
          facts = await gh.findPrForSha(repoCfg, item.sha);
          if (facts) { item.pr = facts.pr; rec.pr = facts.pr; }
        }
      } catch (e) { throw new UpstreamError(`could not read the pull request from GitHub: ${e.message}`); }
    }
    let changed = null;
    if (jobs.some(j => j.onlyIfChanged)) {
      let main;
      try { main = await fetchRef(repoCfg.path, 'main'); }
      catch (e) { throw new UpstreamError(`could not fetch main to compare against: ${e.message}`); }
      // Not gitSafe: an empty answer would read as "nothing changed" and skip a job.
      const out = await git(['diff', '--name-only', '-z', `${main}...${item.sha}`], expandHome(repoCfg.path));
      changed = out.split('\0').filter(Boolean);
    }
    const decisions = jobs.map(j => {
      if (j.prOnly && !facts) return { run: false, reason: 'not a pull request (GitHub runs this check on pull requests only)' };
      if (j.skipLabel && facts && facts.labels.includes(j.skipLabel)) return { run: false, reason: `the pull request carries the '${j.skipLabel}' label` };
      if (j.onlyIfChanged) {
        const pre = [].concat(j.onlyIfChanged);
        if (!changed.some(f => pre.some(p => f.startsWith(p)))) return { run: false, reason: `no change under ${pre.join(', ')} against its merge base with origin/main` };
      }
      return { run: true };
    });
    let base = null;
    if (jobs.some((j, i) => decisions[i].run && j.cmd.some(a => a.includes('{base}')))) {
      const branch = facts ? facts.base : 'main';
      if (!BRANCH_RE.test(branch)) throw new UpstreamError(`the base branch '${branch}' is not a plain branch name`);
      try { base = await fetchRef(repoCfg.path, branch); }
      catch (e) { throw new UpstreamError(`could not fetch the base branch ${branch}: ${e.message}`); }
    }
    jobs.forEach((j, i) => {
      if (!decisions[i].run) return;
      decisions[i].argv = j.cmd.map(a => a.replaceAll('{sha}', item.sha).replaceAll('{base}', base || ''));
      for (const f of [].concat(j.requires || [])) {
        if (!fs.existsSync(expandHome(f))) throw new Error(`job '${j.name}' needs ${f}, which is missing (see docs/v2/ci.md)`);
      }
    });
    return decisions;
  }

  // A job's own process group (spawnTracked makes each job a group leader)
  // after the job ended: anything still in it was started by the job and left
  // running, such as a background server. Only the group is signalled, never
  // the job's pid alone, which may already belong to someone else.
  async function reapGroup(pgid) {
    if (!pgid) return false;
    const alive = () => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
    if (!alive()) return false;
    try { process.kill(-pgid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 20 && alive(); i++) await new Promise(r => setTimeout(r, 100));
    if (alive()) { try { process.kill(-pgid, 'SIGKILL'); } catch {} }
    return true;
  }

  // Processes a job left behind that still name its worktree: orphans (their
  // parent is gone) and descendants of this process. Anyone else's process
  // that mentions the folder is left alone.
  async function sweep(dir) {
    const all = await listProcesses();
    const parent = new Map(all.map(p => [p.pid, p.ppid]));
    const ours = pid => {
      for (let p = pid, n = 0; p > 1 && n < 64; p = parent.get(p), n++) if (p === process.pid) return true;
      return false;
    };
    const hits = all.filter(p => p.pid !== process.pid
      && (p.cmd.includes(dir + '/') || p.cmd.includes(dir + ' ') || p.cmd.endsWith(dir))
      && (p.ppid === 1 || ours(p.pid)));
    if (!hits.length) return [];
    for (const p of hits) { try { process.kill(p.pid, 'SIGTERM'); } catch {} }
    await new Promise(r => setTimeout(r, 2000));
    for (const p of hits) { try { process.kill(p.pid, 'SIGKILL'); } catch {} }
    return hits;
  }

  async function runJob(job, decision, { dir, item, logFile, plan }) {
    const env = {};
    for (const [k, v] of Object.entries(job.env || {})) env[k] = typeof v === 'string' ? expandHome(v) : String(v);
    const log = createLog(logFile, { dropLines: job.dropLines || null, maxBytes: plan.logMaxBytes });
    const summary = {};
    let parser = null;
    try {
      if (job.parse) {
        if (!parsers[job.parse]) throw new Error(`job '${job.name}': no summary reader called '${job.parse}'`);
        parser = parsers[job.parse]();
      }
      log.note(`$ ${cmdString(decision.argv)}`);
      log.note(`in ${dir}`);
      // Only the configured values; the GitHub token below is never written.
      const shown = Object.keys(job.env || {}).map(k => `${k}=${env[k]}`).join(' ');
      if (shown) log.note(`env ${shown}`);
      if (job.githubToken) {
        let creds = null, why = '';
        try { creds = await gh.githubEnv(plan.repo); } catch (e) { why = e.message; }
        if (creds && creds.GITHUB_TOKEN) {
          env.GITHUB_ACTOR = creds.GITHUB_ACTOR;
          env.GITHUB_TOKEN = creds.GITHUB_TOKEN;
          log.note('GITHUB_ACTOR and GITHUB_TOKEN set from gh (not shown)');
          summary.githubToken = true;
        } else {
          log.note(`no GitHub token (${why || 'gh gave none'}): GitHub Packages is not read`);
          summary.githubToken = false;
        }
      }
      const t0 = Date.now();
      let timedOut = false, lingered = false, lingerTimer = null;
      const tracked = spawnTracked(decision.argv[0], decision.argv.slice(1), {
        cwd: dir, env,
        onLine: l => { log.line(l); if (parser) parser.line(l); },
      });
      item.tracked = tracked;
      try { if (tracked.child) tracked.child.stdin.end(); } catch {}
      const timer = setTimeout(() => {
        timedOut = true;
        log.note(`timed out after ${job.timeoutMin} min: stopping it`);
        tracked.kill(killGraceMs);
      }, job.timeoutMin * 60000);
      timer.unref();
      if (tracked.child) {
        tracked.child.once('exit', () => {
          lingerTimer = setTimeout(() => { lingered = true; tracked.kill(killGraceMs); }, exitGraceMs);
          lingerTimer.unref();
        });
      }
      if (item.aborted) tracked.kill(killGraceMs);
      // The disk can fill after the start check passed; stop before it does.
      const watchdog = setInterval(() => {
        let free;
        try { free = freeDisk(); } catch { return; }
        if (free >= plan.stopBelowFreeDiskGB * 1024 ** 3 || item.aborted) return;
        item.aborted = true;
        item.abortReason = `stopped: free disk fell to ${gb(free)} GB, under ${plan.stopBelowFreeDiskGB} GB, while '${job.name}' ran`;
        log.note(item.abortReason);
        tracked.kill(killGraceMs);
      }, plan.diskCheckMs);
      watchdog.unref();
      const res = await tracked.done;
      clearInterval(watchdog);
      clearTimeout(timer);
      clearTimeout(lingerTimer);
      item.tracked = null;
      const durationMs = Date.now() - t0;
      const left = [];
      if (await reapGroup(tracked.pid)) {
        log.note('processes the job started were still running in its process group; stopped them');
        left.push('its process group');
      }
      const swept = await sweep(dir);
      if (swept.length) {
        log.note(`stopped ${swept.length} orphaned process(es) the job left running: ${swept.map(p => `${p.pid} ${p.cmd.slice(0, 120)}`).join('; ')}`);
        left.push(`${swept.length} orphaned process(es)`);
      }
      if (left.length) summary.leftRunning = left.join(', ');
      if (lingered) log.note(`the command exited, but processes it started kept its output open for ${Math.round(exitGraceMs / 1000)}s and were stopped`);
      if (parser && !item.aborted) Object.assign(summary, (await parser.finish({ dir })) || {});
      summary.exitCode = res.code;
      if (res.signal) summary.signal = res.signal;
      if (timedOut) summary.reason = `timed out after ${job.timeoutMin} min`;
      else if (res.error) summary.reason = `could not start ${decision.argv[0]}: ${res.error.message}`;
      else if (item.aborted) summary.reason = item.abortReason;
      log.note(`exit ${res.code ?? res.signal ?? 'none'} after ${fmtDuration(durationMs)}`);
      return { ok: res.code === 0 && !timedOut && !res.error && !item.aborted, durationMs, summary };
    } finally {
      item.tracked = null;
      log.close();
    }
  }

  async function runItem(item) {
    const { repo, sha } = item;
    const label = `CI ${repo} ${sha.slice(0, 12)}${item.pr ? ` (#${item.pr})` : item.ref ? ` (${item.ref})` : ''}`;
    let rec = recordFor(repo, sha) || { v: 1, repo, sha, pr: item.pr ?? null, ref: item.ref ?? null, status: 'queued', startedAt: Date.now(), finishedAt: 0, durationMs: 0, jobs: [], error: null };
    const save = () => {
      try { writeRecord(rec); } catch (e) { console.error(`ci: could not write the record of ${repo} ${sha.slice(0, 12)}: ${e.message}`); }
    };
    let ciLock = null, heavy = null, plan = null, dir = null;
    try {
      plan = repoPlan(repo, getState());
      const pollMs = opts.pollMs || plan.pollMs;
      ciLock = await waitLock('ci', { what: label, repo, sha, pr: item.pr ?? null }, item, pollMs);
      heavy = await waitLock('heavy', { what: label, cwd: workDir(repo, sha) }, item, pollMs);
      plan = repoPlan(repo, getState()); // the wait can be long; take the config as it is now
      const free = freeDisk();
      if (free < plan.minFreeDiskGB * 1024 ** 3) {
        throw new Error(`refused to start: ${gb(free)} GB free on the disk, under the ${plan.minFreeDiskGB} GB a CI run needs (a fresh worktree and its build take about 1 GB)`);
      }
      rec = freshRecord(item, plan, 'running');
      fs.rmSync(logDir(repo, sha), { recursive: true, force: true }); // a rerun starts with no old logs
      save();
      emit('start', { repo, sha, pr: item.pr, jobs: plan.jobs.map(j => j.name) });
      const decisions = await planJobs(plan, item, rec);
      dir = workDir(repo, sha);
      await addWorktree(plan.repo.path, dir, sha);
      let red = null;
      for (let i = 0; i < plan.jobs.length; i++) {
        const job = plan.jobs[i], jr = rec.jobs[i], d = decisions[i];
        if (item.aborted) throw new Stopped(item.abortReason);
        if (red || !d.run) {
          jr.status = 'skipped';
          jr.summary = { reason: red ? `skipped: '${red}' is red` : d.reason };
          save();
          emit('job', { repo, sha, job: { ...jr } });
          continue;
        }
        jr.cmd = cmdString(d.argv);
        jr.status = 'running';
        jr.log = path.join(logDir(repo, sha), job.file);
        save();
        item.job = job.name;
        emit('job', { repo, sha, job: { ...jr } });
        const r = await runJob(job, d, { dir, item, logFile: jr.log, plan });
        item.job = null;
        jr.durationMs = r.durationMs;
        jr.summary = r.summary;
        jr.status = r.ok ? 'green' : 'red';
        if (item.aborted) throw new Stopped(item.abortReason);
        save();
        emit('job', { repo, sha, job: { ...jr } });
        if (!r.ok) red = job.name;
      }
      rec.status = red ? 'red' : 'green';
    } catch (e) {
      markEnded(rec, e instanceof Stopped ? e.message : (e.message || String(e)));
    } finally {
      item.job = null;
      if (dir && plan) {
        try { await removeWorktree(plan.repo.path, dir); }
        catch (e) { console.error(`ci: could not remove ${dir}: ${e.message} (the next start removes it)`); }
      }
      if (heavy) heavy.release();
      if (ciLock) ciLock.release();
      item.runLock.release();
      rec.finishedAt = Date.now();
      rec.durationMs = rec.startedAt ? rec.finishedAt - rec.startedAt : 0;
      save();
      emit('end', { repo, sha, record: rec });
      item.resolveDone(rec);
    }
  }

  // Records a dead process left `queued` or `running` become `error`, and the
  // worktrees it left are removed. Anything a live process still holds stays.
  async function recover() {
    const all = configuredRepos(getState());
    const mine = (id, sha) => (current && current.repo === id && current.sha.startsWith(sha))
      || queue.some(q => q.repo === id && q.sha.startsWith(sha));
    let records = 0, worktrees = 0;
    for (const id of Object.keys(all)) {
      if (!ID_RE.test(id)) continue;
      for (const rec of listRecords(id, { limit: Infinity })) {
        if (rec.status !== 'running' && rec.status !== 'queued') continue;
        if (!SHA_RE.test(rec.sha || '') || mine(id, rec.sha) || lockHolder(runLockName(id, rec.sha))) continue;
        markEnded(rec, 'interrupted: the process running it ended before it finished');
        rec.finishedAt = Date.now();
        rec.durationMs = rec.startedAt ? rec.finishedAt - rec.startedAt : 0;
        try { writeRecord(rec); records++; } catch {}
      }
    }
    const work = dataPath('ci', 'work');
    let names = [];
    try { names = fs.readdirSync(work); } catch {}
    for (const name of names) {
      const i = name.lastIndexOf('-');
      const id = name.slice(0, i), sha12 = name.slice(i + 1);
      if (i <= 0 || !Object.hasOwn(all, id) || !/^[0-9a-f]{12}$/.test(sha12)) continue;
      if (mine(id, sha12) || lockHolder(`ci-run-${id}-${sha12}`)) continue;
      try { await removeWorktree(all[id].path, path.join(work, name)); worktrees++; }
      catch (e) { console.error(`ci: could not remove the leftover worktree ${name}: ${e.message}`); }
    }
    return { records, worktrees };
  }

  function start() { started = true; pump(); }

  async function stop(reason = 'stopped') {
    started = false;
    for (const q of queue.splice(0)) {
      q.aborted = true;
      const rec = recordFor(q.repo, q.sha);
      if (rec && rec.status === 'queued') {
        markEnded(rec, `${reason} before it ran`);
        rec.finishedAt = Date.now();
        try { writeRecord(rec); } catch {}
      }
      q.runLock.release();
      q.resolveDone(rec);
    }
    if (current) {
      current.aborted = true;
      current.abortReason = reason;
      if (current.tracked) current.tracked.kill(killGraceMs);
    }
    wakeAll();
    if (pumping) await pumping;
  }

  function status() {
    return {
      running: current ? { repo: current.repo, sha: current.sha, pr: current.pr ?? null, job: current.job || null } : null,
      queue: queue.map(q => ({ repo: q.repo, sha: q.sha, pr: q.pr ?? null })),
    };
  }

  // The final record of a head this runner queued, or null.
  function waitFor(repo, sha) {
    const it = (current && current.repo === repo && current.sha === sha) ? current : queue.find(q => q.repo === repo && q.sha === sha);
    return it ? it.done : null;
  }

  return { enqueue, start, stop, status, recover, waitFor };
}

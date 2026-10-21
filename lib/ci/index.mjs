// CI panel (contract § 5): each repo's local CI, run in a throwaway worktree of
// the exact head and recorded per head SHA. Reviews, the badges and the merge
// gate read the records through ./records.mjs.
import { HttpError } from '../core/http.mjs';
import { isInside } from '../core/paths.mjs';
import { tailLines } from '../core/files.mjs';
import { lockHolder } from '../core/lock.mjs';
import { repos } from '../core/config.mjs';
import { recordFor, listRecords } from './records.mjs';
import { createRunner, ciConfig, logDir, runLockName } from './runner.mjs';

export { latestRecord, recordFor, isGreen, listRecords } from './records.mjs';
export { createRunner } from './runner.mjs';

const SHA40 = /^[0-9a-f]{40}$/;
let runner = null;
let stopped = false;

function repoAndSha(query, state) {
  const repo = query.get('repo') || '';
  const sha = (query.get('sha') || '').toLowerCase();
  if (!Object.hasOwn(repos(state), repo)) throw new HttpError(400, `unknown repo '${repo}'`);
  if (!SHA40.test(sha)) throw new HttpError(400, 'sha must be a full 40-character commit SHA');
  return { repo, sha };
}

// The body of POST /api/ci/run: {repo, pr} | {repo, sha} | {repo, ref: 'main'}.
function target(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'expected a JSON object');
  const t = { repo: b.repo };
  if (b.pr != null) t.pr = b.pr;
  if (b.sha != null) t.sha = b.sha;
  if (b.ref != null) t.ref = b.ref;
  return t;
}

export function overview(r, state) {
  const st = r ? r.status() : { running: null, queue: [] };
  let running = st.running;
  // A run in another process (the `deck ci` command) holds the `ci` lock.
  if (!running) {
    const h = lockHolder('ci');
    if (h && h.repo && SHA40.test(h.sha || '')) {
      const rec = recordFor(h.repo, h.sha);
      const job = rec && (rec.jobs || []).find(j => j.status === 'running');
      running = { repo: h.repo, sha: h.sha, pr: (rec && rec.pr) ?? h.pr ?? null, job: job ? job.name : null };
    }
  }
  const queue = [...st.queue];
  const seen = new Set(queue.map(q => `${q.repo}:${q.sha}`));
  if (running) seen.add(`${running.repo}:${running.sha}`);
  const cfg = ciConfig(state);
  const out = [];
  for (const [id, repo] of Object.entries(repos(state))) {
    if (!cfg.repos || !Object.hasOwn(cfg.repos, id)) continue;
    const records = listRecords(id, { limit: 20 });
    // Heads another live process has queued.
    for (const rec of records) {
      if (rec.status !== 'queued' || seen.has(`${id}:${rec.sha}`) || !lockHolder(runLockName(id, rec.sha))) continue;
      seen.add(`${id}:${rec.sha}`);
      queue.push({ repo: id, sha: rec.sha, pr: rec.pr ?? null });
    }
    out.push({ id, name: repo.name, slug: repo.slug, latest: records[0] || null, records });
  }
  return { running, queue, repos: out };
}

export function register(router, ctx = {}) {
  const getState = () => (typeof ctx.getState === 'function' ? ctx.getState() : undefined);
  runner = createRunner({ getState });
  stopped = false;
  const r = runner;

  router.add('GET', '/api/ci', () => overview(r, getState()));

  router.add('POST', '/api/ci/run', async (req, res, { body }) => {
    const out = await r.enqueue(target(await body()));
    return { queued: true, sha: out.sha };
  });

  router.add('GET', '/api/ci/record', (req, res, { query }) => {
    const { repo, sha } = repoAndSha(query, getState());
    const rec = recordFor(repo, sha);
    if (!rec) throw new HttpError(404, `no CI record for ${repo} ${sha.slice(0, 12)}`);
    return rec;
  });

  router.add('GET', '/api/ci/log', (req, res, { query }) => {
    const { repo, sha } = repoAndSha(query, getState());
    const rec = recordFor(repo, sha);
    if (!rec) throw new HttpError(404, `no CI record for ${repo} ${sha.slice(0, 12)}`);
    const name = query.get('job') || '';
    const job = (rec.jobs || []).find(j => j.name === name);
    if (!job) throw new HttpError(404, `no job '${name}' in that record`);
    if (!job.log) return { lines: [] };
    // The record names the file; it must still be this head's log folder.
    if (!isInside(job.log, logDir(repo, sha))) throw new HttpError(400, 'that log is outside the record\'s folder');
    const n = Math.min(Math.max(parseInt(query.get('lines'), 10) || 200, 1), 5000);
    return { lines: tailLines(job.log, n) };
  });
}

// The queue runs only after start(); with DECK_NO_BACKGROUND, POST /api/ci/run
// still queues but nothing runs.
export function start() {
  const r = runner;
  if (!r) return;
  r.recover()
    .then(({ records, worktrees }) => {
      if (records || worktrees) console.log(`ci: ${records} interrupted record(s) closed, ${worktrees} leftover worktree(s) removed`);
    })
    .catch(e => console.error(`ci: recovery failed: ${e.message}`))
    .finally(() => { if (!stopped && r === runner) r.start(); });
}

export async function stop() {
  stopped = true;
  if (runner) await runner.stop('stopped: Deck shut down');
}

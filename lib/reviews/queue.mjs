// The review queue (concept decision 1): every intervalMin minutes while
// reviews.queue is on, review every open PR head that has a green CI record
// and no done review, oldest PR first, one at a time.
//
// Drafts are skipped: a draft still moves, and reviewing each push of it
// would spend the month's budget on code nobody has asked to merge. Marking it
// ready puts its head in the next pass; `deck review` and the page's Review
// button review a draft on request.
//
// A pass stops on BudgetExhausted, CreditsOut or AuthMissing (nothing after
// it could be reviewed either: those heads get a failed record of the same
// kind, so the gate allows them on CI alone, and the next pass retries them).
// A RateLimited answer is waited out inside the review (retry-after, up to
// three tries); if it persists the pass stops and the next one resumes.
// Overloaded leaves a failed record for that PR and the pass moves on; the
// next pass retries it. Refused, BadRequest and BadOutput are not retried
// automatically: they repeat for the same input and can cost money each time.
import { isGreen } from '../ci/records.mjs';
import { deps as getDeps, sleep } from './deps.mjs';
import { reviewConfig, reviewRepos } from './config.mjs';
import { reviewFor, writeReview } from './records.mjs';
import { renderMarkdown } from './render.mjs';
import { listOpenPrs } from './github.mjs';
import { runReview, runningReview } from './review.mjs';
import { acquireLock } from '../core/lock.mjs';

const STOP_PASS = new Set(['BudgetExhausted', 'CreditsOut', 'PlanLimit', 'AuthMissing']);
const RETRY = new Set(['BudgetExhausted', 'CreditsOut', 'PlanLimit', 'CliOutdated', 'AuthMissing', 'RateLimited', 'Overloaded']);
const MAX_INTERNAL_FAILURES = 3; // per head and process: a bug must not re-pay for the same review forever
const FIRST_PASS_MS = 30000;
const LOCK_WAIT_MS = 30 * 60000;

const status = { lastPassAt: null, nextPassAt: null, lastError: null };
const internalFailures = new Map();
let ctxRef = null, timer = null, passing = null, abort = null, stopped = true;

export function queueStatus(state) {
  const cfg = reviewConfig(state);
  return { on: cfg.queue, intervalMin: cfg.intervalMin, lastPassAt: status.lastPassAt, nextPassAt: status.nextPassAt, running: runningReview(), lastError: status.lastError };
}

export function noteError(msg) { status.lastError = msg; }

// The heads this pass should review, oldest PR first across the repos.
export async function candidates(state, d, errors) {
  const out = [];
  for (const repo of reviewRepos(state)) {
    let prs;
    try { prs = await listOpenPrs(repo, d, { fresh: true }); } catch (e) { errors.push(`${repo.id}: ${e.message}`); continue; }
    for (const p of prs) {
      const sha = p.headRefOid;
      if (p.isDraft || !/^[0-9a-f]{40}$/.test(sha || '')) continue;
      if (!isGreen(repo.id, sha)) continue;
      const rec = reviewFor(repo.id, p.number, sha);
      if (rec && rec.status === 'done') continue;
      if (rec && rec.status === 'failed' && !RETRY.has(rec.error && rec.error.kind)) continue;
      if ((internalFailures.get(`${repo.id}#${p.number}@${sha}`) || 0) >= MAX_INTERNAL_FAILURES) continue;
      out.push({ repo, pr: p });
    }
  }
  return out.sort((a, b) => (Date.parse(a.pr.createdAt) || 0) - (Date.parse(b.pr.createdAt) || 0) || a.pr.number - b.pr.number);
}

// A head the kit could not reach because the budget, the credits or the key
// are gone: recorded as failed with that kind, never over a done review.
function markNotReviewed(c, err, d) {
  // Under the review lock: a review finishing between this check and the
  // write would otherwise be replaced by "not reviewed".
  const lock = acquireLock('review', { what: 'queue: recording heads not reviewed' });
  if (!lock) return; // a review is running; the next pass decides
  try { markNotReviewedLocked(c, err, d); } finally { lock.release(); }
}
function markNotReviewedLocked(c, err, d) {
  const rec = reviewFor(c.repo.id, c.pr.number, c.pr.headRefOid);
  if (rec && rec.status === 'done') return;
  const now = d.now();
  const failed = {
    v: 1, repo: c.repo.id, slug: c.repo.slug, pr: c.pr.number, sha: c.pr.headRefOid,
    title: c.pr.title || '', base: c.pr.baseRefName || '', head: c.pr.headRefName || '',
    status: 'failed', error: { kind: err.kind, message: `${err.message || ''} (not attempted: the pass stopped)`.trim() },
    verdict: null, summary: '', findings: [], dropped: [], preset: null, model: null, risky: [], partial: false,
    costUsd: 0, requestIds: [], startedAt: now, finishedAt: now,
    context: { rules: [], lessons: '', design: [], stack: [], tokensEst: 0 }, githubStatus: null,
  };
  writeReview(failed, renderMarkdown(failed));
}

// One pass. Returns what it did, for tests and the log.
export async function runPass(ctx, { deps: over, signal } = {}) {
  const d = getDeps(over);
  const state = ctx.getState();
  const errors = [];
  const result = { reviewed: [], failed: [], stoppedBy: null, errors };
  const list = await candidates(state, d, errors);
  for (let i = 0; i < list.length; i++) {
    if (signal && signal.aborted) break;
    const c = list[i];
    const key = `${c.repo.id}#${c.pr.number}@${c.pr.headRefOid}`;
    let res;
    try {
      res = await runReview({ repoId: c.repo.id, pr: c.pr.number, sha: c.pr.headRefOid, state, deps: over, lockWaitMs: LOCK_WAIT_MS, signal, background: true, skipIfDone: true });
    } catch (e) {
      if (signal && signal.aborted) break;
      internalFailures.set(key, (internalFailures.get(key) || 0) + 1);
      errors.push(`${c.repo.id}#${c.pr.number}: ${e.message}`);
      continue;
    }
    if (res.problems && res.problems.length) errors.push(...res.problems.map(p => `${c.repo.id}#${c.pr.number}: ${p}`));
    if (!res.error) { result.reviewed.push(key); continue; }
    result.failed.push({ key, kind: res.error.kind });
    if (STOP_PASS.has(res.error.kind)) {
      for (const rest of list.slice(i + 1)) markNotReviewed(rest, res.error, d);
      result.stoppedBy = res.error.kind;
      errors.push(`pass stopped: ${res.error.kind}${res.error.message ? ` (${res.error.message})` : ''}`);
      break;
    }
    if (res.error.kind === 'RateLimited') {
      result.stoppedBy = 'RateLimited';
      errors.push('pass stopped: still rate limited after waiting');
      break;
    }
    // Overloaded, Refused, BadRequest, BadOutput: recorded; on to the next PR.
  }
  return result;
}

function schedule(ms) {
  clearTimeout(timer);
  if (stopped) return;
  status.nextPassAt = Date.now() + ms;
  timer = setTimeout(tick, ms);
  timer.unref();
}

async function tick() {
  timer = null;
  if (stopped || !ctxRef) return;
  let intervalMin = 10;
  try {
    const cfg = reviewConfig(ctxRef.getState());
    intervalMin = cfg.intervalMin;
    if (cfg.queue && !passing) {
      abort = new AbortController();
      passing = runPass(ctxRef, { signal: abort.signal })
        .then(r => { status.lastError = r.errors.length ? r.errors.join('; ') : null; })
        .catch(e => { status.lastError = `pass failed: ${e.message}`; })
        .finally(() => { status.lastPassAt = Date.now(); passing = null; abort = null; });
      await passing;
    }
  } catch (e) { status.lastError = `queue: ${e.message}`; }
  schedule(intervalMin * 60000);
}

export function start(ctx) {
  ctxRef = ctx;
  stopped = false;
  schedule(FIRST_PASS_MS);
}

// The queue was switched on: look soon instead of at the next interval.
export function kick(ms = 5000) {
  if (stopped || passing) return;
  schedule(ms);
}

export async function stop() {
  stopped = true;
  clearTimeout(timer);
  timer = null;
  status.nextPassAt = null;
  if (abort) abort.abort();
  if (passing) await Promise.race([passing, sleep(1500, { unref: true })]);
}

// Tests reset the module between cases.
export function resetQueue() {
  internalFailures.clear();
  status.lastPassAt = status.nextPassAt = status.lastError = null;
}

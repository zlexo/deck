// The Reviews routes (contract § 6). They work without the queue having run:
// the gateway check and the tests start no background loops.
import os from 'node:os';
import { HttpError } from '../core/http.mjs';
import { recordFor as ciRecordFor } from '../ci/records.mjs';
import { deps as getDeps, kitSpend } from './deps.mjs';
import { reviewRepos, reviewRepo } from './config.mjs';
import { reviewFor, overrideFor, listReviews, readMarkdown } from './records.mjs';
import { renderMarkdown } from './render.mjs';
import { listOpenPrs } from './github.mjs';
import { gateFor } from './gate.mjs';
import { runReview, applyOverride, ReviewError } from './review.mjs';
import { queueStatus, kick, noteError } from './queue.mjs';
import { openBlockers } from './verify.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const CI_STATE = { green: 'green', red: 'red', running: 'running', queued: 'running' };

function ciState(repo, sha) {
  const r = ciRecordFor(repo, sha);
  return r ? (CI_STATE[r.status] || null) : null;
}

function reviewSummary(rec) {
  if (!rec) return null;
  const blockers = openBlockers(rec).length;
  return {
    verdict: rec.verdict || null, blockers, notes: (rec.findings || []).length - blockers,
    costUsd: rec.costUsd || 0, status: rec.status, error: rec.error || null,
  };
}

function parsePr(v) {
  const n = typeof v === 'number' ? v : /^#?\d+$/.test(String(v || '')) ? Number(String(v).replace('#', '')) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'pr must be a PR number');
  return n;
}

function parseRepo(id, state) {
  const repo = reviewRepo(String(id || ''), state);
  if (!repo) throw new HttpError(400, `unknown repo: ${id}`);
  return repo;
}

const pending = new Set(); // repo#pr runs started from the page and not finished

export async function overview(ctx, over) {
  const d = getDeps(over);
  const state = ctx.getState();
  const repos = reviewRepos(state);
  const lists = await Promise.all(repos.map(r => listOpenPrs(r, d).then(prs => ({ prs }), e => ({ prs: [], error: e.message }))));
  return {
    queue: queueStatus(state),
    repos: repos.map((r, i) => ({
      id: r.id, name: r.name, slug: r.slug,
      prs: lists[i].prs.map(p => {
        const g = gateFor(r.id, p.number, p.headRefOid);
        return {
          pr: p.number, title: p.title, sha: p.headRefOid, url: p.url,
          ci: ciState(r.id, p.headRefOid),
          review: reviewSummary(reviewFor(r.id, p.number, p.headRefOid)),
          gate: { code: g.code, label: g.label },
        };
      }),
      // Not in the contract's table: set only when gh could not list the
      // repo's PRs, so an outage does not read as "no open PRs".
      ...(lists[i].error ? { error: lists[i].error } : {}),
    })),
    spend: await kitSpend(d, state),
  };
}

export function registerRoutes(router, ctx, over) {
  router.add('GET', '/api/reviews', () => overview(ctx, over));

  router.add('GET', '/api/reviews/record', (req, res, { query }) => {
    const state = ctx.getState();
    const repo = parseRepo(query.get('repo'), state);
    const pr = parsePr(query.get('pr'));
    const sha = query.get('sha');
    if (sha && !SHA_RE.test(sha)) throw new HttpError(400, 'sha must be a full 40-character SHA');
    const record = sha ? reviewFor(repo.id, pr, sha) : listReviews(repo.id, { pr, limit: 1 })[0] || null;
    if (!record) throw new HttpError(404, `no review record for ${repo.id}#${pr}${sha ? ` at ${sha.slice(0, 7)}` : ''}`);
    const override = overrideFor(repo.id, pr, record.sha);
    return { record, markdown: readMarkdown(repo.id, pr, record.sha) || renderMarkdown(record, override), override };
  });

  // Starts a review in the background; it waits its turn when another review
  // holds the lock. The page polls GET /api/reviews for the result.
  router.add('POST', '/api/reviews/run', async (req, res, { body }) => {
    const b = await body();
    const state = ctx.getState();
    const repo = parseRepo(b.repo, state);
    const pr = parsePr(b.pr);
    const key = `${repo.id}#${pr}`;
    if (!pending.has(key)) {
      pending.add(key);
      runReview({ repoId: repo.id, pr, state, deps: over, lockWaitMs: 30 * 60000, background: true })
        .then(r => { if (r.error) noteError(`${key}: not reviewed (${r.error.kind})`); else if (r.problems.length) noteError(`${key}: ${r.problems.join('; ')}`); })
        .catch(e => noteError(`${key}: ${e.message}`))
        .finally(() => pending.delete(key));
    }
    return { started: true };
  });

  router.add('POST', '/api/reviews/override', async (req, res, { body }) => {
    const b = await body();
    const state = ctx.getState();
    const repo = parseRepo(b.repo, state);
    const pr = parsePr(b.pr);
    if (!SHA_RE.test(String(b.sha || ''))) throw new HttpError(400, 'sha must be a full 40-character SHA');
    if (typeof b.reason !== 'string' || !b.reason.trim()) throw new HttpError(400, 'an override needs a reason');
    try {
      const r = await applyOverride({ repoId: repo.id, pr, sha: b.sha, reason: b.reason, who: `${os.userInfo().username} via Deck`, state, deps: over });
      if (r.problems.length) noteError(`${repo.id}#${pr}: ${r.problems.join('; ')}`);
    } catch (e) {
      if (e instanceof ReviewError) throw new HttpError(e.status, e.message);
      throw e;
    }
    return { ok: true };
  });

  // Only the gateway writes state.json, through ctx.saveState: copy the live
  // state, change the one setting, save the whole object.
  router.add('POST', '/api/reviews/queue', async (req, res, { body }) => {
    const b = await body();
    if (typeof b.on !== 'boolean') throw new HttpError(400, 'on must be true or false');
    const state = ctx.getState() || {};
    const next = { ...state, reviews: { ...(state.reviews || {}), queue: b.on } };
    ctx.saveState(next);
    if (b.on) kick();
    return { on: b.on };
  });
}

// The merge gate (contract § 6): may this PR's current head merge? Read from
// the CI record and the review records of that exact head.
//   0 mergeable: green CI, and a done review with no open blocker or an override
//   2 blocked: an open blocker and no override
//   3 no review because of budget or API (budget, credits, the key, rate
//     limits, overload): allowed on CI alone
//   4 the head or the base changed since its review
//   5 no green CI record for the head
//   6 no review record at all for this PR
//   7 the review failed for another reason (a refusal, an answer that did not
//     fit the schema, output cut off): review again, or override with a reason
//   1 usage or internal error
// CI comes first: a head without green CI is never mergeable, whatever its
// review says, and "run CI" is the step that unblocks it.
import { isGreen as ciIsGreen } from '../ci/records.mjs';
import { deps as getDeps } from './deps.mjs';
import { reviewRepo } from './config.mjs';
import { reviewFor, overrideFor, listReviews } from './records.mjs';
import { isBlocked, openBlockers } from './verify.mjs';
import { fetchPr } from './github.mjs';

export const GATE = { MERGEABLE: 0, ERROR: 1, BLOCKED: 2, NO_REVIEW_API: 3, HEAD_CHANGED: 4, NO_GREEN_CI: 5, NOT_REVIEWED: 6, REVIEW_FAILED: 7 };
export const GATE_LABELS = {
  0: 'mergeable', 1: 'error', 2: 'blocked', 3: 'not reviewed (budget or API)',
  4: 'changed since review', 5: 'no green CI', 6: 'not reviewed', 7: 'review failed',
};
// Failures that say nothing about the code: the API could not be reached or
// paid for. Only these let a head merge on CI alone. A refusal, a malformed
// answer or output cut at max_tokens came from this PR's review and gets a
// re-run or a person's override instead.
export const AVAILABILITY = new Set(['BudgetExhausted', 'CreditsOut', 'PlanLimit', 'CliOutdated', 'AuthMissing', 'RateLimited', 'Overloaded']);
const short = sha => String(sha || '').slice(0, 7);
const where = f => `${f.file}:${f.line_start}`;

// From the records alone, for a head the caller already knows. `base` is the
// PR's current base branch, when known: a review of the same head against
// another base reviewed another diff.
export function gateFor(repo, pr, sha, { isGreen = ciIsGreen, base } = {}) {
  const id = `${repo}#${pr}`;
  const out = (code, reason, extra = {}) => ({ code, label: GATE_LABELS[code], reason, sha, ...extra });
  if (!isGreen(repo, sha)) return out(5, `no green CI record for ${id} at ${short(sha)}; run CI on this head first`);
  const rec = reviewFor(repo, pr, sha);
  if (!rec) {
    const older = listReviews(repo, { pr }).find(r => r.sha !== sha);
    if (older) return out(4, `${id} is at ${short(sha)} but the last review was of ${short(older.sha)}; review the new head`);
    return out(6, `${id} at ${short(sha)} has no review record; run deck review ${repo} ${pr}`);
  }
  if (base && rec.base && rec.base !== base) {
    return out(4, `${id} at ${short(sha)} was reviewed against ${rec.base}, but its base is now ${base}; review it again`, { record: rec });
  }
  if (rec.status !== 'done') {
    const e = rec.error || {};
    const why = `${e.kind || 'error'}${e.message ? `: ${e.message}` : ''}`;
    if (AVAILABILITY.has(e.kind)) {
      return out(3, `${id} at ${short(sha)} was not reviewed (${why}); allowed on CI alone, note it in the PR body`, { record: rec });
    }
    const fov = overrideFor(repo, pr, sha);
    if (fov) return { ...out(0, `${id} at ${short(sha)}: the review failed (${why}), overridden by ${fov.who}: ${fov.reason}`, { record: rec, override: fov }), label: 'mergeable (overridden)' };
    return out(7, `${id} at ${short(sha)}: the review failed (${why}); review it again, or override with a reason`, { record: rec });
  }
  if (isBlocked(rec)) {
    const ov = overrideFor(repo, pr, sha);
    const blockers = openBlockers(rec);
    if (ov) return { ...out(0, `${id} at ${short(sha)}: blocked, overridden by ${ov.who}: ${ov.reason}`, { record: rec, override: ov }), label: 'mergeable (overridden)' };
    return out(2, `${id} at ${short(sha)} has ${blockers.length || 'an'} open blocker${blockers.length === 1 ? '' : 's'}${blockers.length ? ` (${blockers.map(where).join(', ')})` : ''}; fix it or override with a reason`, { record: rec });
  }
  const partial = rec.partial ? ' (partial context: the largest diffs were left out of the review)' : '';
  return out(0, `${id} at ${short(sha)} has green CI and a ${rec.verdict === 'pass_with_notes' ? 'passing review with notes' : 'passing review'}${partial}`, { record: rec });
}

// The command's gate: resolves the PR's current head through gh first.
export async function checkGate(repoId, pr, { state, deps: over, isGreen } = {}) {
  const d = getDeps(over);
  const repo = reviewRepo(repoId, state);
  if (!repo) return { code: 1, label: GATE_LABELS[1], reason: `unknown repo: ${repoId}` };
  if (!Number.isInteger(pr) || pr <= 0) return { code: 1, label: GATE_LABELS[1], reason: `bad PR number: ${pr}` };
  let info;
  try { info = await fetchPr(repo, pr, d); } catch (e) { return { code: 1, label: GATE_LABELS[1], reason: `could not resolve ${repoId}#${pr}: ${e.message}` }; }
  if (!/^[0-9a-f]{40}$/.test(info.headRefOid || '')) return { code: 1, label: GATE_LABELS[1], reason: `${repoId}#${pr} has no head SHA` };
  return gateFor(repo.id, pr, info.headRefOid, { ...(isGreen ? { isGreen } : {}), base: info.baseRefName });
}

// What Reviews asks GitHub, through the injected gh: open PR lists (cached
// about a minute, the page polls them), one PR's details, and the review-gate
// commit status. The status carries a verdict and nothing else: findings stay
// local (concept § Reviews, decision 2).
const LIST_FIELDS = 'number,title,headRefOid,headRefName,baseRefName,baseRefOid,isDraft,url,createdAt';
const VIEW_FIELDS = 'number,title,body,headRefOid,headRefName,baseRefOid,baseRefName,isDraft,url,state,closingIssuesReferences';
export const LIST_TTL_MS = 60000;

const lists = new Map(); // repo id -> { at, prs } or { at, pending }

export function clearPrCache() { lists.clear(); }

export async function listOpenPrs(repo, d, { fresh = false } = {}) {
  const hit = lists.get(repo.id);
  if (hit && hit.pending) return hit.pending;
  if (!fresh && hit && d.now() - hit.at < LIST_TTL_MS) return hit.prs;
  const pending = d.gh(['pr', 'list', '--repo', repo.slug, '--state', 'open', '--limit', '100', '--json', LIST_FIELDS])
    .then(out => {
      const prs = JSON.parse(out);
      if (!Array.isArray(prs)) throw new Error(`gh pr list for ${repo.slug} did not return a list`);
      lists.set(repo.id, { at: d.now(), prs });
      return prs;
    })
    .catch(e => { lists.delete(repo.id); throw e; });
  lists.set(repo.id, { at: d.now(), pending });
  return pending;
}

export async function fetchPr(repo, pr, d) {
  const info = JSON.parse(await d.gh(['pr', 'view', String(pr), '--repo', repo.slug, '--json', VIEW_FIELDS]));
  if (!info || info.number !== pr) throw new Error(`gh pr view ${repo.slug}#${pr} answered for another PR`);
  return info;
}

export const prUrl = (repo, pr, info) => (info && info.url) || `https://github.com/${repo.slug}/pull/${pr}`;

// The status for a head: pass, pass with notes, blocked, or blocked and
// overridden (success: the override unblocks that head). A failed review
// has none and posts nothing.
export function statusFor(record, override, blocked) {
  if (!record || record.status !== 'done') return null;
  if (blocked) return override ? { state: 'success', description: 'blocked, overridden' } : { state: 'failure', description: 'blocked' };
  return { state: 'success', description: record.verdict === 'pass_with_notes' ? 'pass with notes' : 'pass' };
}

export async function postStatus(repo, sha, status, d) {
  await d.gh(['api', '-X', 'POST', `repos/${repo.slug}/statuses/${sha}`,
    '-f', `state=${status.state}`, '-f', 'context=review-gate', '-f', `description=${status.description}`]);
  return { state: status.state, description: status.description, postedAt: d.now() };
}

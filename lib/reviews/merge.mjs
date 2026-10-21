// deck merge: the review gate wired into merging (concept § Reviews, "My merge
// scripts call it before every merge"). Every merge of a reviewed repo's PR
// goes through here:
//   1. the gate decides (deck review --check's codes);
//   2. a head the API could not review (code 3) merges on CI alone, and the PR
//      body says so before the merge;
//   3. open PRs stacked on this one are retargeted to its base first, because
//      deleting a merged base branch makes GitHub close the PRs on top of it;
//   4. the merge is pinned to the head the gate checked (--match-head-commit),
//      so a commit pushed in between is refused by GitHub, not merged unreviewed.
import { checkGate } from './gate.mjs';
import { reviewRepo } from './config.mjs';
import { deps as getDeps } from './deps.mjs';
import { configSection } from '../core/config.mjs';
import { expandHome } from '../core/paths.mjs';
import { run } from '../core/proc.mjs';

// The merge commit's author email: state.json's merge.authorEmail, else the
// repo's git user.email, else none and GitHub uses the account's default
// (which can be a private address: set one of the first two to avoid that).
export async function authorEmail(repo, state, git = args => run('git', args, { timeoutMs: 5000 })) {
  const { authorEmail: set } = configSection('merge', { authorEmail: null }, state);
  if (set) return set;
  try {
    const r = await git(['-C', expandHome(repo.path), 'config', '--get', 'user.email']);
    const email = String((r && r.stdout) || '').trim();
    return email || null;
  } catch { return null; }
}

const MERGEABLE = new Set([0, 3]);

export async function mergePr(repoId, pr, { dryRun = false, deps: over, isGreen, log = () => {} } = {}) {
  const d = getDeps(over);
  const repo = reviewRepo(repoId);
  if (!repo) return { code: 1, reason: `unknown repo: ${repoId}` };
  const g = await checkGate(repoId, pr, { deps: over, isGreen });
  if (!MERGEABLE.has(g.code)) return { code: g.code, reason: `not merging: ${g.label}: ${g.reason}` };
  const sha = g.sha;

  const info = JSON.parse(await d.gh(['pr', 'view', String(pr), '--repo', repo.slug, '--json', 'headRefName,baseRefName,body,state,headRefOid']));
  if (info.state !== 'OPEN') return { code: 1, reason: `${repoId}#${pr} is ${String(info.state).toLowerCase()}` };
  if (info.headRefOid !== sha) return { code: 4, reason: `${repoId}#${pr} moved to ${info.headRefOid.slice(0, 7)} while the gate checked ${sha.slice(0, 7)}; check again` };
  const steps = [];

  if (g.code === 3) {
    const kind = (g.record && g.record.error && g.record.error.kind) || 'API error';
    const note = `\n\n---\nMerged on CI alone: the review gate could not review ${sha.slice(0, 7)} (${kind}).`;
    steps.push({ what: 'note in the PR body', run: () => d.gh(['pr', 'edit', String(pr), '--repo', repo.slug, '--body', (info.body || '') + note]) });
  }

  const stacked = JSON.parse(await d.gh(['pr', 'list', '--repo', repo.slug, '--state', 'open', '--base', info.headRefName, '--json', 'number']));
  for (const s of stacked) {
    steps.push({ what: `retarget #${s.number} to ${info.baseRefName}`, run: () => d.gh(['pr', 'edit', String(s.number), '--repo', repo.slug, '--base', info.baseRefName]) });
  }
  const email = await authorEmail(repo, undefined, d.git);
  steps.push({ what: `merge #${pr} at ${sha.slice(0, 7)} and delete ${info.headRefName}`,
    run: () => d.gh(['pr', 'merge', String(pr), '--repo', repo.slug, '--merge', '--delete-branch', ...(email ? ['--author-email', email] : []), '--match-head-commit', sha]) });

  for (const s of steps) {
    log(`${dryRun ? 'would ' : ''}${s.what}`);
    if (!dryRun) await s.run();
  }
  return { code: 0, reason: `${dryRun ? 'would merge' : 'merged'} ${repoId}#${pr} at ${sha.slice(0, 7)} (${g.label})`, steps: steps.map(s => s.what) };
}

const USAGE = `usage:
  deck merge <repo> <pr> [--dry-run]   merge through the review gate: refused unless the
                                       head has green CI and a passing (or overridden)
                                       review, or could not be reviewed for budget or API
repos: the ids in state.json's \`repos\` section (\`deck config\` shows where state.json is)`;

export async function main(argv = [], io = {}) {
  const log = io.log || (s => console.log(s));
  const err = io.err || (s => console.error(s));
  const pos = argv.filter(a => !a.startsWith('-'));
  const dryRun = argv.includes('--dry-run');
  if (argv.includes('-h') || argv.includes('--help')) { log(USAGE); return 0; }
  const bad = argv.find(a => a.startsWith('-') && a !== '--dry-run');
  if (bad || pos.length !== 2) { err(bad ? `deck merge: unknown option ${bad}\n${USAGE}` : USAGE); return 1; }
  const pr = /^#?\d+$/.test(pos[1]) ? Number(pos[1].replace('#', '')) : NaN;
  if (!Number.isInteger(pr) || pr <= 0) { err(`deck merge: ${pos[1]} is not a PR number`); return 1; }
  try {
    const r = await mergePr(pos[0], pr, { dryRun, deps: io.deps, isGreen: io.isGreen, log });
    (r.code === 0 ? log : err)(r.reason);
    return r.code;
  } catch (e) {
    err(`deck merge: ${e.message}`);
    return 1;
  }
}

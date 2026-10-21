// `deck review` (contract § 11). Never writes state.json: config is read from
// the file, and the queue setting is the gateway's to change.
//   deck review <repo> <pr>                         exit 0 pass, 2 blocked, 3 budget/API, 7 failed, 1 error
//   deck review --check <repo> <pr>                 the gate's exit code, one line of reason
//   deck review --override <repo> <pr> --reason <text>
import os from 'node:os';
import { checkGate, gateFor } from './gate.mjs';
import { runReview, applyOverride, recordMdPath, ReviewError, short } from './review.mjs';
import { openBlockers } from './verify.mjs';
import { fetchPr } from './github.mjs';
import { reviewRepo } from './config.mjs';
import { repos as coreRepos } from '../core/config.mjs';
import { deps as getDeps } from './deps.mjs';

const USAGE = `usage:
  deck review <repo> <pr>                          review the PR's head now
  deck review --check <repo> <pr>                  the merge gate: exit 0 mergeable, 2 blocked,
                                                   3 not reviewed for budget or API (allowed on CI
                                                   alone), 4 head or base changed, 5 no green CI,
                                                   6 not reviewed, 7 review failed, 1 error
  deck review --override <repo> <pr> --reason <text>
repos: the ids in state.json's \`repos\` section (\`deck config\` shows where state.json is)`;

function parse(argv) {
  const out = { mode: 'review', pos: [], reason: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.mode = 'check';
    else if (a === '--override') out.mode = 'override';
    else if (a === '--reason') out.reason = argv[++i] ?? '';
    else if (a.startsWith('--reason=')) out.reason = a.slice('--reason='.length);
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('-')) { out.bad = `unknown option ${a}`; }
    else out.pos.push(a);
  }
  return out;
}

const toPr = s => (/^#?\d+$/.test(String(s || '')) ? Number(String(s).replace('#', '')) : NaN);
const money = n => `$${(Number(n) || 0).toFixed(2)}`;

export async function main(argv = [], io = {}) {
  const log = io.log || (s => console.log(s));
  const err = io.err || (s => console.error(s));
  const over = io.deps;
  const a = parse(argv);
  if (a.help) { log(USAGE); return 0; }
  if (a.bad || a.pos.length !== 2) { err(a.bad ? `deck review: ${a.bad}\n${USAGE}` : USAGE); return 1; }
  const [repoId, prArg] = a.pos;
  const pr = toPr(prArg);
  if (!reviewRepo(repoId)) { err(`deck review: unknown repo ${repoId} (configured: ${Object.keys(coreRepos()).join(', ') || 'none'})`); return 1; }
  if (!Number.isInteger(pr) || pr <= 0) { err(`deck review: ${prArg} is not a PR number`); return 1; }

  if (a.mode === 'check') {
    const g = await checkGate(repoId, pr, { deps: over, isGreen: io.isGreen });
    (g.code === 0 ? log : err)(`${g.label}: ${g.reason}`);
    if (g.sha) (g.code === 0 ? log : err)(`head ${g.sha}`); // full SHA, for --match-head-commit
    return g.code;
  }

  if (a.mode === 'override') {
    if (!a.reason || !a.reason.trim()) { err('deck review --override needs --reason <text>'); return 1; }
    try {
      const d = getDeps(over);
      const info = await fetchPr(reviewRepo(repoId), pr, d);
      const r = await applyOverride({ repoId, pr, sha: info.headRefOid, reason: a.reason, who: `${os.userInfo().username} via cli`, deps: over });
      log(`override recorded: ${repoId}#${pr} at ${short(info.headRefOid)} may merge (${r.override.reason})`);
      for (const p of r.problems) err(`warning: ${p}`);
      return 0;
    } catch (e) {
      err(`deck review --override: ${e.message}`);
      return 1;
    }
  }

  try {
    let waiting = false;
    const r = await runReview({
      repoId, pr, deps: over, lockWaitMs: 30 * 60000, rateLimit: { maxWaitS: 300 },
      onWait: h => { if (!waiting) { waiting = true; err(`waiting for the review lock${h && h.repo ? ` (${h.repo}#${h.pr} is being reviewed)` : ''}`); } },
      onRateLimited: s => err(`rate limited: waiting ${s} s as the API asked`),
    });
    const rec = r.record;
    for (const p of r.problems) err(`warning: ${p}`);
    if (r.error) {
      // The exit code is the gate's answer for this head now: an earlier
      // review that stands (blocked or passing) keeps its code, and a new
      // failed record answers 3 or 7 by its kind.
      const g = gateFor(rec.repo, rec.pr, rec.sha, { isGreen: io.isGreen || (() => true) });
      err(`${repoId}#${pr} at ${short(rec.sha)}: not reviewed (${r.error.kind}${r.error.message ? `: ${r.error.message}` : ''}). ${r.written ? g.reason : `The earlier review of this head stands: ${g.label}.`}`);
      return g.code === 5 ? 3 : g.code;
    }
    const blockers = openBlockers(rec).length;
    const others = rec.findings.length - blockers;
    log(`${repoId}#${pr} at ${short(rec.sha)}: ${rec.verdict.replace(/_/g, ' ')} (${blockers} blocker${blockers === 1 ? '' : 's'}, ${others} other, ${rec.dropped.length} dropped), ${rec.preset} ${rec.model || ''}, ${money(rec.costUsd)}${rec.partial ? ', partial context' : ''}`.replace(/ ,/g, ','));
    log(`record: ${recordMdPath(rec.repo, rec.pr, rec.sha)}`);
    return rec.verdict === 'blocked' ? 2 : 0;
  } catch (e) {
    err(`deck review: ${e instanceof ReviewError ? '' : 'failed: '}${e.message}`);
    return 1;
  }
}

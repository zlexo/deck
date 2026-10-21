import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpEnv, makeFixture, putCi, putJson } from './helpers.mjs';

const tmp = tmpEnv('rv-merge');
const { mergePr, main } = await import('../../lib/reviews/merge.mjs');
const { configureReviews } = await import('../../lib/reviews/deps.mjs');
const { reviewPath, overridePath } = await import('../../lib/reviews/records.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fx = makeFixture(tmp);
const DATA = process.env.DECK_DATA;
const writeState = (extra = {}) => fs.writeFileSync(path.join(process.env.DECK_ROOT, 'state.json'), JSON.stringify({ ...fx.state, ...extra }));
writeState({ merge: { authorEmail: 'merges@example.com' } });
const SLUG = 'zlexo/perdix';

// A gh that answers views, the stacked list, edits and merges, recording calls.
// `moveAfter` returns a different head from the second view on (a push between
// the gate's check and the merge).
function mergeGh({ stacked = [], moveAfter = Infinity } = {}) {
  const calls = [];
  let views = 0;
  async function gh(args) {
    calls.push(args);
    const [a, b] = args;
    if (a === 'pr' && b === 'view') {
      views++;
      const head = views > moveAfter ? 'f'.repeat(40) : fx.headA;
      return JSON.stringify({ ...fx.pr7, headRefOid: head, body: 'Original body.' });
    }
    if (a === 'pr' && b === 'list' && args.includes('--base')) return JSON.stringify(stacked.map(number => ({ number })));
    if (a === 'pr' && (b === 'edit' || b === 'merge')) return '';
    throw new Error(`unexpected gh ${args.join(' ')}`);
  }
  gh.calls = calls;
  gh.kinds = () => calls.map(c => `${c[0]} ${c[1]}`);
  return gh;
}
const review = (over = {}) => putJson(reviewPath('perdix', 7, fx.headA), { v: 1, repo: 'perdix', pr: 7, sha: fx.headA, status: 'done', verdict: 'pass', findings: [], dropped: [], finishedAt: 1, ...over });
const blocker = { severity: 'blocker', file: 'src/app.js', line_start: 6, line_end: 6, quote: 'x', problem: 'p', failure_scenario: 's', suggestion: 'g', verify: { real: true, why: 'w' } };

let gh;
beforeEach(() => { fs.rmSync(DATA, { recursive: true, force: true }); });
const use = g => { gh = g; configureReviews({ gh, sleep: async () => true }); };

test('mergeable: stacked PRs are retargeted first, then a merge pinned to the checked head', async () => {
  use(mergeGh({ stacked: [8] }));
  putCi(DATA, 'perdix', fx.headA); review();
  const r = await mergePr('perdix', 7);
  assert.equal(r.code, 0, r.reason);
  const edit = gh.calls.find(c => c[1] === 'edit'), merge = gh.calls.find(c => c[1] === 'merge');
  assert.deepEqual(edit, ['pr', 'edit', '8', '--repo', SLUG, '--base', 'main']);
  assert.ok(gh.calls.indexOf(edit) < gh.calls.indexOf(merge), 'retarget before the branch is deleted');
  for (const flag of ['--merge', '--delete-branch']) assert.ok(merge.includes(flag), flag);
  assert.equal(merge[merge.indexOf('--author-email') + 1], 'merges@example.com', 'merge.authorEmail from state.json');
  assert.equal(merge[merge.indexOf('--match-head-commit') + 1], fx.headA);
});

test('refused: blocked, no green CI, not reviewed, head changed; nothing is edited or merged', async () => {
  use(mergeGh()); putCi(DATA, 'perdix', fx.headA); review({ verdict: 'blocked', findings: [blocker] });
  assert.equal((await mergePr('perdix', 7)).code, 2);
  fs.rmSync(DATA, { recursive: true, force: true });
  use(mergeGh()); review();
  assert.equal((await mergePr('perdix', 7)).code, 5);
  use(mergeGh()); putCi(DATA, 'perdix', fx.headA); fs.rmSync(path.join(DATA, 'reviews'), { recursive: true, force: true });
  assert.equal((await mergePr('perdix', 7)).code, 6);
  assert.ok(!gh.kinds().some(k => k === 'pr edit' || k === 'pr merge'));
});

test('an override on this exact head merges', async () => {
  use(mergeGh()); putCi(DATA, 'perdix', fx.headA); review({ verdict: 'blocked', findings: [blocker] });
  putJson(overridePath('perdix', 7, fx.headA), { who: 'dev', reason: 'accepted', ts: 1 });
  assert.equal((await mergePr('perdix', 7)).code, 0);
  assert.ok(gh.kinds().includes('pr merge'));
});

test('a head the API could not review merges on CI alone, with a note in the PR body first', async () => {
  use(mergeGh()); putCi(DATA, 'perdix', fx.headA); review({ status: 'failed', verdict: null, error: { kind: 'CreditsOut', message: 'out' } });
  assert.equal((await mergePr('perdix', 7)).code, 0);
  const edit = gh.calls.find(c => c[1] === 'edit');
  const body = edit[edit.indexOf('--body') + 1];
  assert.match(body, /^Original body\.\n\n---\nMerged on CI alone: the review gate could not review [0-9a-f]{7} \(CreditsOut\)\.$/);
  assert.ok(gh.calls.indexOf(edit) < gh.calls.findIndex(c => c[1] === 'merge'));
});

test('a push between the check and the merge is refused (exit 4)', async () => {
  use(mergeGh({ moveAfter: 1 })); putCi(DATA, 'perdix', fx.headA); review();
  const r = await mergePr('perdix', 7);
  assert.equal(r.code, 4);
  assert.match(r.reason, /moved/);
  assert.ok(!gh.kinds().includes('pr merge'));
});

test('--dry-run says what it would do and changes nothing', async () => {
  use(mergeGh({ stacked: [8] })); putCi(DATA, 'perdix', fx.headA); review();
  const out = [];
  assert.equal(await main(['perdix', '7', '--dry-run'], { log: s => out.push(s), err: s => out.push(s) }), 0);
  assert.ok(!gh.kinds().some(k => k === 'pr edit' || k === 'pr merge'));
  assert.match(out.join('\n'), /would retarget #8 to main[\s\S]*would merge #7/);
  assert.equal(await main(['perdix', 'x'], { log: () => {}, err: () => {} }), 1);
});

test('author email: git user.email when state.json sets none, and no flag when neither has one', async () => {
  const { authorEmail } = await import('../../lib/reviews/merge.mjs');
  const repo = { path: fx.clone };
  writeState();
  try {
    assert.equal(await authorEmail(repo, undefined, async () => ({ code: 0, stdout: 'dev@example.com\n' })), 'dev@example.com');
    assert.equal(await authorEmail(repo, undefined, async () => ({ code: 1, stdout: '' })), null);
    assert.equal(await authorEmail(repo, { merge: { authorEmail: 'set@example.com' } }, async () => { throw new Error('not asked'); }), 'set@example.com');
    use(mergeGh());
    configureReviews({ gh, sleep: async () => true, git: async () => ({ code: 1, stdout: '' }) });
    putCi(DATA, 'perdix', fx.headA); review();
    const r = await mergePr('perdix', 7);
    assert.equal(r.code, 0, r.reason);
    assert.ok(!gh.calls.find(c => c[1] === 'merge').includes('--author-email'), 'no email: GitHub decides');
  } finally { writeState({ merge: { authorEmail: 'merges@example.com' } }); }
});

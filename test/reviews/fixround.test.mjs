// The rules added after the independent review of the gate (round 1): which
// failures let a head through, a re-review raced by another process, a base
// change, the CLI's exit after a failed re-run, short quotes, directories, and
// the guards that had no test.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpEnv, makeFixture, fakeKit, fakeGh, KitError, putCi, putJson, finding } from './helpers.mjs';

const tmp = tmpEnv('rv-fix');
const { gateFor, checkGate, AVAILABILITY } = await import('../../lib/reviews/gate.mjs');
const { runReview, applyOverride } = await import('../../lib/reviews/review.mjs');
const { configureReviews } = await import('../../lib/reviews/deps.mjs');
const { runPass, resetQueue } = await import('../../lib/reviews/queue.mjs');
const { clearPrCache, fetchPr } = await import('../../lib/reviews/github.mjs');
const { reviewPath, reviewFor, overridePath } = await import('../../lib/reviews/records.mjs');
const { verifyLocal, candidatePaths } = await import('../../lib/reviews/verify.mjs');
const { main } = await import('../../lib/reviews/cli.mjs');
const { acquireLock } = await import('../../lib/core/lock.mjs');
const { showBlob } = await import('../../lib/core/git.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fx = makeFixture(tmp);
const DATA = process.env.DECK_DATA;
fs.writeFileSync(path.join(process.env.DECK_ROOT, 'state.json'), JSON.stringify(fx.state));
const rec = (over = {}) => ({ v: 1, repo: 'perdix', pr: 7, sha: fx.headA, base: 'main', status: 'done', verdict: 'pass', findings: [], dropped: [], finishedAt: 1, ...over });
const failedRec = kind => rec({ status: 'failed', verdict: null, error: { kind, message: 'm' } });
const green = () => true;

beforeEach(() => { fs.rmSync(DATA, { recursive: true, force: true }); resetQueue(); clearPrCache(); });

test('gate: only budget and API failures merge on CI alone; others need a re-run or an override', () => {
  for (const kind of ['BudgetExhausted', 'CreditsOut', 'PlanLimit', 'CliOutdated', 'AuthMissing', 'RateLimited', 'Overloaded']) {
    putJson(reviewPath('perdix', 7, fx.headA), failedRec(kind));
    assert.equal(gateFor('perdix', 7, fx.headA, { isGreen: green }).code, 3, kind);
  }
  for (const kind of ['Refused', 'BadRequest', 'BadOutput', 'Internal', undefined]) {
    putJson(reviewPath('perdix', 7, fx.headA), failedRec(kind));
    const g = gateFor('perdix', 7, fx.headA, { isGreen: green });
    assert.equal(g.code, 7, String(kind));
    assert.match(g.reason, /review it again, or override/);
  }
  assert.deepEqual([...AVAILABILITY].sort(), ['AuthMissing', 'BudgetExhausted', 'CliOutdated', 'CreditsOut', 'Overloaded', 'PlanLimit', 'RateLimited']);
});

test('override: a failed review can be overridden on its head; an API outage needs none', async () => {
  configureReviews({ gh: fakeGh({}), sleep: async () => true });
  putJson(reviewPath('perdix', 7, fx.headA), failedRec('Refused'));
  await applyOverride({ repoId: 'perdix', pr: 7, sha: fx.headA, reason: 'reviewed by hand', who: 'z', state: { ...fx.state, reviews: { githubStatus: false } } });
  const g = gateFor('perdix', 7, fx.headA, { isGreen: green });
  assert.equal(g.code, 0);
  assert.match(g.reason, /failed \(Refused: m\), overridden by z: reviewed by hand/);
  putJson(reviewPath('perdix', 8, fx.headB), { ...failedRec('CreditsOut'), pr: 8, sha: fx.headB });
  await assert.rejects(applyOverride({ repoId: 'perdix', pr: 8, sha: fx.headB, reason: 'r', who: 'z', state: fx.state }), e => e.status === 409 && /already allows it on CI alone/.test(e.message));
});

test('gate: a review of the same head against another base does not count', () => {
  putJson(reviewPath('perdix', 8, fx.headB), { ...rec(), pr: 8, sha: fx.headB, base: 'feat/a' });
  assert.equal(gateFor('perdix', 8, fx.headB, { isGreen: green, base: 'feat/a' }).code, 0);
  const g = gateFor('perdix', 8, fx.headB, { isGreen: green, base: 'main' });
  assert.equal(g.code, 4);
  assert.match(g.reason, /reviewed against feat\/a, but its base is now main/);
});

test('gate: a pass on partial context says so', () => {
  putJson(reviewPath('perdix', 7, fx.headA), rec({ partial: true }));
  assert.match(gateFor('perdix', 7, fx.headA, { isGreen: green }).reason, /partial context/);
});

test('checkGate: a PR view without a head SHA is an error, not a guess', async () => {
  configureReviews({ gh: fakeGh({ views: { 'zlexo/perdix#7': { ...fx.pr7, headRefOid: '' } } }) });
  assert.equal((await checkGate('perdix', 7, { isGreen: green })).code, 1);
});

test('fetchPr: an answer for another PR number is refused', async () => {
  const gh = fakeGh({ views: { 'zlexo/perdix#7': fx.pr8 } });
  await assert.rejects(fetchPr({ id: 'perdix', slug: 'zlexo/perdix' }, 7, { gh }), /answered for another PR/);
});

test('queue race: a head reviewed by someone else while the queue waited is not reviewed again', async () => {
  // The queue lists #7 as a candidate, then waits for the lock that a CLI
  // review holds. That review finishes (blocked) and releases the lock. The
  // queue must skip #7, not pay again and replace the verdict.
  putCi(DATA, 'perdix', fx.headA);
  const kit = fakeKit({ review: [{ verdict: 'pass', summary: 'second opinion', findings: [] }] });
  const held = acquireLock('review', { repo: 'perdix', pr: 7, what: 'the CLI' });
  let released = false;
  configureReviews({
    kit, gh: fakeGh({ lists: { 'zlexo/perdix': [fx.pr7] }, views: { 'zlexo/perdix#7': fx.pr7 } }),
    sleep: async () => {
      if (!released) {
        putJson(reviewPath('perdix', 7, fx.headA), rec({ verdict: 'blocked', summary: 'first', findings: [finding({ severity: 'blocker' })] }));
        held.release();
        released = true;
      }
      return true;
    },
  });
  await runPass({ getState: () => fx.state });
  assert.equal(kit.calls.length, 0, 'no second paid review');
  assert.equal(reviewFor('perdix', 7, fx.headA).summary, 'first');
  assert.equal(gateFor('perdix', 7, fx.headA, { isGreen: green }).code, 2);
});

test('queue stop: a head that became done meanwhile is never marked not reviewed', async () => {
  putCi(DATA, 'perdix', fx.headA); putCi(DATA, 'perdix', fx.headB);
  const pr7 = { ...fx.pr7, createdAt: '2026-10-01T00:00:00Z' }, pr8 = { ...fx.pr8, createdAt: '2026-10-02T00:00:00Z' };
  const kit = fakeKit({
    review: [() => {
      // While #7 is reviewed, someone else finishes #8; then the credits run out.
      putJson(reviewPath('perdix', 8, fx.headB), { ...rec(), pr: 8, sha: fx.headB, base: 'feat/a', summary: 'done elsewhere' });
      return new KitError('CreditsOut', 'out');
    }],
  });
  configureReviews({ kit, gh: fakeGh({ lists: { 'zlexo/perdix': [pr7, pr8] }, views: { 'zlexo/perdix#7': pr7, 'zlexo/perdix#8': pr8 } }), sleep: async () => true });
  await runPass({ getState: () => fx.state });
  assert.equal(reviewFor('perdix', 7, fx.headA).error.kind, 'CreditsOut');
  assert.equal(reviewFor('perdix', 8, fx.headB).status, 'done', 'the finished review stands');
});

test('deck review: a failed re-run exits with the standing review\'s code', async () => {
  putCi(DATA, 'perdix', fx.headA);
  putJson(reviewPath('perdix', 7, fx.headA), rec({ verdict: 'blocked', findings: [finding({ severity: 'blocker' })] }));
  configureReviews({ kit: fakeKit({ review: [new KitError('BudgetExhausted', 'out until the 1st')] }), gh: fakeGh({ lists: { 'zlexo/perdix': [fx.pr7] }, views: { 'zlexo/perdix#7': fx.pr7 } }), sleep: async () => true });
  const out = [];
  const code = await main(['perdix', '7'], { log: s => out.push(s), err: s => out.push(s), isGreen: green });
  assert.equal(code, 2, out.join('\n'));
  assert.match(out.join('\n'), /The earlier review of this head stands: blocked/);
});

test('verify: a directory or a path out of the repo is not a file', async () => {
  assert.equal(await showBlob(fx.clone, fx.headA, 'src'), null, 'a tree is not a blob');
  assert.equal((await showBlob(fx.work, fx.headA, 'src/app.js')).includes('function add'), true);
  const { kept, dropped } = await verifyLocal(
    [finding({ file: 'src', line_start: 1, line_end: 1, quote: 'app.js new.js' }), finding({ file: '../secret.txt', line_start: 1, line_end: 1, quote: 'top secret line' })],
    async p => (p === 'src' ? null : 'top secret line\n'), // a reader that would read anything it is handed
  );
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 2);
  assert.deepEqual(candidatePaths('../secret.txt'), []);
  assert.deepEqual(candidatePaths('a/../../x'), []);
});

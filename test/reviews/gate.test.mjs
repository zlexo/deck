import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpEnv, fakeGh, putCi, putJson, finding } from './helpers.mjs';

const tmp = tmpEnv('rv-gate');
const { gateFor, checkGate } = await import('../../lib/reviews/gate.mjs');
const { reviewPath, overridePath } = await import('../../lib/reviews/records.mjs');
const { configureReviews } = await import('../../lib/reviews/deps.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DATA = process.env.DECK_DATA;
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const rec = (pr, sha, over = {}) => ({ v: 1, repo: 'perdix', pr, sha, status: 'done', verdict: 'pass', findings: [], dropped: [], finishedAt: 1, ...over });
const blocked = (pr, sha) => rec(pr, sha, { verdict: 'blocked', findings: [finding({ severity: 'blocker', line_start: 6 })] });
const putReview = r => putJson(reviewPath(r.repo, r.pr, r.sha), r);
const putOverride = (pr, sha) => putJson(overridePath('perdix', pr, sha), { who: 'dev via cli', reason: 'intended', ts: 2 });

beforeEach(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('gate 5: no green CI record for the head, whatever the review says', () => {
  putReview(rec(7, A));
  assert.equal(gateFor('perdix', 7, A).code, 5);
  putCi(DATA, 'perdix', A, 'red');
  assert.equal(gateFor('perdix', 7, A).code, 5, 'a red record is not green');
  putCi(DATA, 'perdix', A, 'running');
  assert.equal(gateFor('perdix', 7, A).code, 5);
  putCi(DATA, 'perdix', B, 'green');
  assert.equal(gateFor('perdix', 7, A).code, 5, 'green CI on another head does not count');
  assert.match(gateFor('perdix', 7, A).reason, /no green CI record for perdix#7 at aaaaaaa/);
});

test('gate 6: green CI and no review record at all', () => {
  putCi(DATA, 'perdix', A);
  const g = gateFor('perdix', 7, A);
  assert.equal(g.code, 6);
  assert.equal(g.label, 'not reviewed');
  putReview(rec(8, A));
  assert.equal(gateFor('perdix', 7, A).code, 6, 'another PR\'s review of the same SHA does not count');
});

test('gate 4: records exist only for older heads of the PR', () => {
  putCi(DATA, 'perdix', B);
  putReview(rec(7, A));
  putReview(blocked(7, C));
  const g = gateFor('perdix', 7, B);
  assert.equal(g.code, 4);
  assert.match(g.reason, /perdix#7 is at bbbbbbb but the last review was of/);
  putReview(rec(7, B, { status: 'failed', error: { kind: 'Overloaded', message: '' }, verdict: null }));
  assert.equal(gateFor('perdix', 7, B).code, 3, 'once the head itself has a record, 4 no longer applies');
});

test('gate 3: a failed record for the head is allowed on CI alone', () => {
  putCi(DATA, 'perdix', A);
  putReview(rec(7, A, { status: 'failed', error: { kind: 'CreditsOut', message: 'spend limit' }, verdict: null }));
  const g = gateFor('perdix', 7, A);
  assert.equal(g.code, 3);
  assert.match(g.reason, /not reviewed \(CreditsOut: spend limit\); allowed on CI alone, note it in the PR body/);
});

test('gate 3: the Claude plan\'s limit on the CLI route is allowed on CI alone, like a spent budget', () => {
  putCi(DATA, 'perdix', A);
  putReview(rec(7, A, { status: 'failed', error: { kind: 'PlanLimit', message: 'usage limit reached' }, verdict: null }));
  const g = gateFor('perdix', 7, A);
  assert.equal(g.code, 3);
  assert.match(g.reason, /PlanLimit: usage limit reached/);
});

test('gate 2: an open blocker without an override', () => {
  putCi(DATA, 'perdix', A);
  putReview(blocked(7, A));
  const g = gateFor('perdix', 7, A);
  assert.equal(g.code, 2);
  assert.match(g.reason, /1 open blocker \(src\/app\.js:6\)/);
  putReview(rec(7, A, { verdict: 'blocked', findings: [] }));
  assert.equal(gateFor('perdix', 7, A).code, 2, 'a blocked verdict blocks even with no finding left');
  putReview(rec(7, A, { verdict: 'pass', findings: [finding({ severity: 'blocker' })] }));
  assert.equal(gateFor('perdix', 7, A).code, 2, 'a blocker blocks even under a pass verdict');
});

test('gate 0: green CI and a done review with no open blocker, or an override for this head', () => {
  putCi(DATA, 'perdix', A);
  putReview(rec(7, A));
  assert.equal(gateFor('perdix', 7, A).code, 0);
  putReview(rec(7, A, { verdict: 'pass_with_notes', findings: [finding()] }));
  assert.equal(gateFor('perdix', 7, A).code, 0, 'notes do not block');
  putReview(rec(7, A, { verdict: 'pass_with_notes', findings: [finding({ severity: 'should_fix', demoted: { from: 'blocker', reason: 'r' } })] }));
  assert.equal(gateFor('perdix', 7, A).code, 0, 'a demoted blocker does not block');
  putReview(blocked(7, A));
  putOverride(7, A);
  const g = gateFor('perdix', 7, A);
  assert.equal(g.code, 0);
  assert.equal(g.label, 'mergeable (overridden)');
  assert.match(g.reason, /overridden by dev via cli: intended/);
});

test('override scope: it unblocks the exact head it names, nothing else', () => {
  putCi(DATA, 'perdix', A);
  putCi(DATA, 'perdix', B);
  putReview(blocked(7, A));
  putOverride(7, A);
  putReview(blocked(7, B));
  assert.equal(gateFor('perdix', 7, A).code, 0);
  assert.equal(gateFor('perdix', 7, B).code, 2, 'a new head of the same PR is blocked again');
  putReview(blocked(8, A));
  assert.equal(gateFor('perdix', 8, A).code, 2, 'another PR at the same SHA is not overridden');
  fs.mkdirSync(path.join(DATA, 'reviews', 'modplex'), { recursive: true });
  putCi(DATA, 'modplex', A);
  putJson(reviewPath('modplex', 7, A), { ...blocked(7, A), repo: 'modplex' });
  assert.equal(gateFor('modplex', 7, A).code, 2, 'nor the same PR number in another repo');
});

test('gate 1: unknown repo, bad PR number, a PR gh cannot resolve', async () => {
  configureReviews({ gh: fakeGh({ views: { 'zlexo/perdix#9': new Error('no pull requests found') } }) });
  for (const [repo, pr, re] of [['nope', 7, /unknown repo/], ['perdix', 0, /bad PR number/], ['perdix', 9, /could not resolve perdix#9: no pull requests found/]]) {
    const g = await checkGate(repo, pr);
    assert.equal(g.code, 1);
    assert.match(g.reason, re);
  }
});

test('checkGate resolves the PR\'s current head through gh', async () => {
  putCi(DATA, 'perdix', B);
  putReview(rec(7, A));
  configureReviews({ gh: fakeGh({ views: { 'zlexo/perdix#7': { number: 7, headRefOid: B } } }) });
  const g = await checkGate('perdix', 7);
  assert.equal(g.code, 4, 'the review was of A, the PR is now at B');
  assert.equal(g.sha, B);
});

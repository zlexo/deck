import { test, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpEnv, makeFixture, fakeKit, fakeGh, KitError, putCi } from './helpers.mjs';

const tmp = tmpEnv('rv-queue');
const { configureReviews } = await import('../../lib/reviews/deps.mjs');
const { runPass, candidates, start, stop, kick, queueStatus, resetQueue } = await import('../../lib/reviews/queue.mjs');
const { clearPrCache } = await import('../../lib/reviews/github.mjs');
const { reviewFor, writeReview } = await import('../../lib/reviews/records.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fx = makeFixture(tmp);
const DATA = process.env.DECK_DATA;
const ctx = (over = {}) => ({ getState: () => ({ ...fx.state, ...over }) });
const pass = { verdict: 'pass', summary: 's', findings: [] };
// PR 8 is the older one here, so it is reviewed first.
const pr7 = { ...fx.pr7, createdAt: '2026-10-05T00:00:00Z' };
const pr8 = { ...fx.pr8, createdAt: '2026-10-01T00:00:00Z' };
let sleeps;

function setup({ review = [], list = [pr7, pr8], views = {} } = {}) {
  const kit = fakeKit({ review });
  const gh = fakeGh({ lists: { 'zlexo/perdix': list }, views: { 'zlexo/perdix#7': pr7, 'zlexo/perdix#8': pr8, ...views } });
  sleeps = [];
  configureReviews({ kit, gh, sleep: async ms => { sleeps.push(ms); return true; } });
  clearPrCache();
  return { kit, gh };
}

beforeEach(() => {
  fs.rmSync(path.join(DATA, 'reviews'), { recursive: true, force: true });
  fs.rmSync(path.join(DATA, 'ci'), { recursive: true, force: true });
  putCi(DATA, 'perdix', fx.headA);
  putCi(DATA, 'perdix', fx.headB);
  resetQueue();
});

const keys = list => list.map(c => `${c.repo.id}#${c.pr.number}`);
const status = (pr, sha) => { const r = reviewFor('perdix', pr, sha); return r && (r.status === 'done' ? 'done' : r.error.kind); };

test('queue: candidates are green, not drafts, not done, oldest first', async () => {
  const { gh } = setup();
  const d = { gh, now: () => Date.now() };
  assert.deepEqual(keys(await candidates(fx.state, d, [])), ['perdix#8', 'perdix#7']);
  setup({ list: [pr7, { ...pr8, isDraft: true }] });
  assert.deepEqual(keys(await candidates(fx.state, { gh: fakeGh({ lists: { 'zlexo/perdix': [pr7, { ...pr8, isDraft: true }] } }), now: Date.now }, [])), ['perdix#7'], 'drafts wait until marked ready');
  fs.rmSync(path.join(DATA, 'ci', 'perdix', `${fx.headB}.json`));
  assert.deepEqual(keys(await candidates(fx.state, d, [])), ['perdix#7'], 'no green CI, no review');
  putCi(DATA, 'perdix', fx.headB, 'red');
  assert.deepEqual(keys(await candidates(fx.state, d, [])), ['perdix#7']);
  const failed = kind => ({ v: 1, repo: 'perdix', pr: 7, sha: fx.headA, status: 'failed', error: { kind, message: '' } });
  writeReview(failed('Overloaded'));
  assert.deepEqual(keys(await candidates(fx.state, d, [])), ['perdix#7'], 'a failed record is retried');
  writeReview(failed('Refused'));
  assert.deepEqual(keys(await candidates(fx.state, d, [])), [], 'but not a refusal');
  writeReview({ ...failed('x'), status: 'done', error: null });
  assert.deepEqual(keys(await candidates(fx.state, d, [])), [], 'a done head is never reviewed again');
  const errors = [];
  await candidates(fx.state, { gh: fakeGh({ failList: { 'zlexo/perdix': 'HTTP 502' } }), now: Date.now }, errors);
  assert.deepEqual(errors, ['perdix: HTTP 502']);
});

test('queue: a pass reviews every candidate, then the next one has nothing to do', async () => {
  const { kit } = setup({ review: [pass, pass] });
  const r = await runPass(ctx());
  assert.deepEqual(r.reviewed, [`perdix#8@${fx.headB}`, `perdix#7@${fx.headA}`]);
  assert.equal(kit.calls.length, 2);
  const again = await runPass(ctx());
  assert.deepEqual(again.reviewed, []);
  assert.equal(kit.calls.length, 2);
});

test('queue: budget, credits, the plan\'s limit or a missing key stop the pass; the rest are marked not reviewed and retried later', async () => {
  for (const kind of ['BudgetExhausted', 'CreditsOut', 'PlanLimit', 'AuthMissing']) {
    fs.rmSync(path.join(DATA, 'reviews'), { recursive: true, force: true });
    const { kit, gh } = setup({ review: [new KitError(kind, 'out')] });
    const r = await runPass(ctx());
    assert.equal(r.stoppedBy, kind);
    assert.equal(kit.calls.length, 1, `${kind}: nothing is sent after the first refusal`);
    assert.equal(status(8, fx.headB), kind);
    assert.equal(status(7, fx.headA), kind, 'the head the pass never reached is recorded too');
    assert.match(reviewFor('perdix', 7, fx.headA).error.message, /not attempted/);
    assert.deepEqual(gh.posts, [], 'failed reviews post no status');
  }
  const { kit } = setup({ review: [pass, pass] });
  const r = await runPass(ctx());
  assert.equal(r.reviewed.length, 2, 'the next pass retries both');
  assert.equal(kit.calls.length, 2);
  assert.equal(status(7, fx.headA), 'done');
});

test('queue: a 429 is waited out and the pass goes on', async () => {
  const { kit } = setup({ review: [new KitError('RateLimited', 'slow', { retryAfterS: 5 }), pass, pass] });
  const r = await runPass(ctx());
  assert.deepEqual(sleeps, [5000]);
  assert.equal(r.reviewed.length, 2);
  assert.equal(kit.calls.length, 3);
});

test('queue: a 429 that persists stops the pass without marking the rest', async () => {
  const rl = () => new KitError('RateLimited', 'slow', { retryAfterS: 5 });
  setup({ review: [rl(), rl(), rl()] });
  const r = await runPass(ctx());
  assert.equal(r.stoppedBy, 'RateLimited');
  assert.equal(status(8, fx.headB), 'RateLimited');
  assert.equal(status(7, fx.headA), null, 'not attempted, not recorded: the next pass reviews it');
});

test('queue: Overloaded skips that PR until the next pass; Refused is not retried', async () => {
  let { kit } = setup({ review: [new KitError('Overloaded'), pass] });
  let r = await runPass(ctx());
  assert.equal(r.stoppedBy, null);
  assert.equal(status(8, fx.headB), 'Overloaded');
  assert.equal(status(7, fx.headA), 'done', 'the pass went on to the next PR');
  ({ kit } = setup({ review: [pass] }));
  await runPass(ctx());
  assert.equal(status(8, fx.headB), 'done', 'retried on the next pass');
  fs.rmSync(path.join(DATA, 'reviews'), { recursive: true, force: true });
  ({ kit } = setup({ review: [new KitError('Refused'), pass] }));
  await runPass(ctx());
  assert.equal(status(8, fx.headB), 'Refused');
  ({ kit } = setup({ review: [] }));
  r = await runPass(ctx());
  assert.equal(kit.calls.length, 0, 'a refusal repeats for the same input; it waits for a manual run');
  assert.deepEqual(r.reviewed, []);
});

test('queue: a head failing for an internal reason is tried three times per process, not every pass', async () => {
  const { gh } = setup({ review: [pass, pass, pass, pass], views: { 'zlexo/perdix#8': new Error('HTTP 500') } });
  for (let i = 0; i < 4; i++) await runPass(ctx());
  const views8 = gh.calls.filter(a => a[0] === 'pr' && a[1] === 'view' && a[2] === '8').length;
  assert.equal(views8, 3);
  assert.equal(status(7, fx.headA), 'done', 'the other PR is not held up');
});

test('queue loop: runs a pass only while reviews.queue is on, and stop() clears its timer', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  try {
    const { gh } = setup({ review: [] });
    let state = { ...fx.state, reviews: { queue: false, intervalMin: 10 } };
    const live = { getState: () => state };
    fs.rmSync(path.join(DATA, 'ci'), { recursive: true, force: true }); // nothing to review: a pass only lists
    start(live);
    assert.equal(queueStatus(state).nextPassAt, 1000 + 30000);
    mock.timers.tick(30000);
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
    assert.equal(gh.calls.length, 0, 'queue off: no pass');
    assert.equal(queueStatus(state).nextPassAt, 31000 + 600000);
    state = { ...state, reviews: { queue: true, intervalMin: 10 } };
    kick(5000);
    mock.timers.tick(5000);
    for (let i = 0; i < 50 && !queueStatus(state).lastPassAt; i++) await new Promise(r => setImmediate(r));
    assert.ok(gh.calls.some(a => a[0] === 'pr' && a[1] === 'list'), 'queue on: a pass listed the PRs');
    assert.ok(queueStatus(state).lastPassAt);
    await stop();
    assert.equal(queueStatus(state).nextPassAt, null);
    const before = gh.calls.length;
    mock.timers.tick(3600000);
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
    assert.equal(gh.calls.length, before, 'stopped: nothing more runs');
  } finally { mock.timers.reset(); }
});

test('queue: an outdated claude CLI marks that PR not reviewed, and the pass goes on to the next', async () => {
  fs.rmSync(path.join(DATA, 'reviews'), { recursive: true, force: true });
  const { kit } = setup({ review: [new KitError('CliOutdated', 'the claude CLI is too old for this model'), pass] });
  const r = await runPass(ctx());
  assert.equal(r.stoppedBy, null, 'one old install does not stop the pass');
  assert.equal(kit.calls.length, 2);
  assert.equal(status(8, fx.headB), 'CliOutdated');
  assert.equal(status(7, fx.headA), 'done');
});


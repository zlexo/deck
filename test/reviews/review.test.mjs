import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpEnv, makeFixture, fakeKit, fakeGh, KitError, finding } from './helpers.mjs';

const tmp = tmpEnv('rv-review');
const { configureReviews } = await import('../../lib/reviews/deps.mjs');
const { runReview, applyOverride, ReviewError } = await import('../../lib/reviews/review.mjs');
const { reviewFor, overrideFor, reviewPath, reviewMdPath } = await import('../../lib/reviews/records.mjs');
const { REVIEW_SCHEMA, VERIFY_SCHEMA } = await import('../../lib/reviews/prompt.mjs');
const { acquireLock } = await import('../../lib/core/lock.mjs');
const { todayStr } = await import('../../lib/core/vault.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fx = makeFixture(tmp);
const EM = String.fromCharCode(0x2014), EN = String.fromCharCode(0x2013);
const DASHES = new RegExp(`[${EN}${EM}]`);
const dailyFile = () => path.join(process.env.DECK_VAULT, 'Daily', `${todayStr()}.md`);
const dailyText = () => (fs.existsSync(dailyFile()) ? fs.readFileSync(dailyFile(), 'utf8') : '');
const views = (over = {}) => ({ 'zlexo/perdix#7': { ...fx.pr7, ...over }, 'zlexo/perdix#8': fx.pr8 });
let sleeps;

function setup({ review = [], verify = [], gh = {}, view = {} } = {}) {
  const kit = fakeKit({ review, verify });
  const g = fakeGh({ views: views(view), lists: { 'zlexo/perdix': [fx.pr7, fx.pr8] }, ...gh });
  sleeps = [];
  configureReviews({ kit, gh: g, sleep: async ms => { sleeps.push(ms); return true; } });
  return { kit, gh: g };
}

beforeEach(() => {
  fs.rmSync(path.join(process.env.DECK_DATA, 'reviews'), { recursive: true, force: true });
  fs.rmSync(path.join(process.env.DECK_VAULT, 'Daily'), { recursive: true, force: true });
});

const real = finding();
const invented = finding({ line_start: 2, line_end: 2, quote: 'return a * b;', problem: 'invented' });

test('review: keeps the finding that quotes real lines, drops the invented one, posts the status', async () => {
  const { kit, gh } = setup({ review: [{ verdict: 'pass_with_notes', summary: 'Swaps the operands of sub.', findings: [real, invented] }] });
  const r = await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  assert.equal(r.error, null);
  const rec = reviewFor('perdix', 7, fx.headA);
  assert.deepEqual(rec, r.record);
  assert.equal(rec.status, 'done');
  assert.equal(rec.verdict, 'pass_with_notes');
  assert.equal(rec.findings.length, 1);
  assert.equal(rec.findings[0].quote, real.quote);
  assert.equal(rec.dropped.length, 1);
  assert.equal(rec.dropped[0].finding.problem, 'invented');
  assert.match(rec.dropped[0].reason, /does not match lines 2-2/);
  assert.equal(rec.summary, 'Swaps the operands of sub.');
  assert.deepEqual({ v: rec.v, repo: rec.repo, slug: rec.slug, pr: rec.pr, sha: rec.sha, title: rec.title, base: rec.base, head: rec.head },
    { v: 1, repo: 'perdix', slug: 'zlexo/perdix', pr: 7, sha: fx.headA, title: fx.pr7.title, base: 'main', head: 'feat/a' });
  assert.equal(rec.preset, 'review.normal');
  assert.equal(rec.model, 'claude-sonnet-5-5');
  assert.deepEqual(rec.risky, []);
  assert.equal(rec.partial, false);
  assert.equal(rec.costUsd, 0.1);
  assert.deepEqual(rec.requestIds, ['req_1']);
  assert.deepEqual(rec.context.design, ['docs/design/0002-chunks.md']);
  assert.ok(rec.context.tokensEst > 0 && rec.startedAt > 0 && rec.finishedAt >= rec.startedAt);
  // The call itself.
  const call = kit.calls[0];
  assert.equal(call.tool, 'reviews');
  assert.equal(call.preset, 'review.normal');
  assert.equal(call.schema, REVIEW_SCHEMA);
  assert.equal(call.ref, `perdix#7@${fx.headA.slice(0, 7)}`);
  assert.equal(call.system[0].cache, true);
  // The rendering and the status.
  const md = fs.readFileSync(reviewMdPath('perdix', 7, fx.headA), 'utf8');
  assert.match(md, /^# Review: perdix#7 Swap sub and add a module$/m);
  assert.match(md, /### 1\. Should fix: src\/app\.js:6/);
  assert.match(md, /## Dropped \(did not match the head commit\)/);
  assert.deepEqual(gh.posts, [{ path: `repos/zlexo/perdix/statuses/${fx.headA}`, state: 'success', context: 'review-gate', description: 'pass with notes' }]);
  assert.equal(rec.githubStatus.description, 'pass with notes');
  assert.equal(dailyText(), '', 'a passing review writes nothing to the vault');
});

test('review: a blocker the verify pass rejects is demoted and the verdict recomputed', async () => {
  const { kit, gh } = setup({
    review: [{ verdict: 'blocked', summary: 's', findings: [finding({ severity: 'blocker' })] }],
    verify: [{ real: false, why: 'every caller passes the operands reversed already' }],
  });
  const r = await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  const f = r.record.findings[0];
  assert.equal(f.severity, 'should_fix');
  assert.deepEqual(f.demoted, { from: 'blocker', reason: 'every caller passes the operands reversed already' });
  assert.equal(r.record.verdict, 'pass_with_notes', 'the model said blocked; the record says what survived');
  const v = kit.calls[1];
  assert.equal(v.preset, 'review.verify');
  assert.equal(v.schema, VERIFY_SCHEMA);
  const text = v.messages[0].content.map(b => b.text).join('\n');
  assert.ok(text.includes('    6 |  return b - a; // swapped'), 'the code around the claim, numbered');
  assert.ok(text.includes('severity: blocker') && text.includes('<diff_of_file path="src/app.js">'));
  assert.ok(v.messages[0].content.every(b => !b.cache), 'the verify preset is not cached');
  assert.equal(gh.posts[0].description, 'pass with notes');
  assert.equal(r.record.costUsd, 0.2);
  assert.deepEqual(r.record.requestIds, ['req_1', 'req_2']);
});

test('review: a confirmed blocker blocks, posts failure and writes one daily line without dashes', async () => {
  const { gh } = setup({
    review: [{ verdict: 'pass', summary: 's', findings: [finding({ severity: 'blocker' }), finding({ severity: 'nit' })] }],
    verify: [{ real: true, why: 'line 6 subtracts the wrong way' }],
    view: { title: `Swap sub ${EM} and ${EN} add` },
  });
  const r = await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  assert.equal(r.record.verdict, 'blocked', 'the model said pass; a verified blocker survives');
  assert.deepEqual(r.record.findings[0].verify, { real: true, why: 'line 6 subtracts the wrong way' });
  assert.deepEqual(gh.posts.map(p => [p.state, p.description]), [['failure', 'blocked']]);
  const lines = dailyText().trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^- Review gate: \\[perdix#7\\]\\(https://github.com/zlexo/perdix/pull/7\\) at ${fx.headA.slice(0, 7)} blocked, 1 blocker \\(review.normal, \\$0.20\\): Swap sub, and, add · \\d\\d:\\d\\d$`));
  assert.ok(!DASHES.test(dailyText()), 'no en or em dash reaches the vault');
});

test('review: failed reviews post no status, for every kind the kit can raise', async () => {
  for (const kind of ['BudgetExhausted', 'CreditsOut', 'AuthMissing', 'Overloaded', 'Refused', 'BadRequest']) {
    const { gh } = setup({ review: [new KitError(kind, `${kind} happened`)] });
    const r = await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
    assert.deepEqual(r.error, { kind, message: `${kind} happened` });
    const rec = reviewFor('perdix', 7, fx.headA);
    assert.equal(rec.status, 'failed');
    assert.deepEqual(rec.error, { kind, message: `${kind} happened` });
    assert.equal(rec.verdict, null);
    assert.equal(rec.githubStatus, null);
    assert.deepEqual(gh.posts, [], `${kind}: nothing posted`);
    assert.match(fs.readFileSync(reviewMdPath('perdix', 7, fx.headA), 'utf8'), new RegExp(`not reviewed\\*\\* \\(${kind}`));
  }
  assert.equal(dailyText(), '');
});

test('review: a malformed answer is a failed record, not a pass', async () => {
  const { gh } = setup({ review: [{ verdict: 'great', findings: 'none' }] });
  const r = await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  assert.equal(r.error.kind, 'BadOutput');
  assert.equal(reviewFor('perdix', 7, fx.headA).status, 'failed');
  assert.deepEqual(gh.posts, []);
});

test('review: a failed re-run never replaces a done review of the same head', async () => {
  setup({ review: [{ verdict: 'pass', summary: 's', findings: [] }, new KitError('BudgetExhausted')] });
  await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  const r = await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  assert.equal(r.error.kind, 'BudgetExhausted');
  assert.equal(r.written, false);
  assert.equal(reviewFor('perdix', 7, fx.headA).status, 'done');
});

test('review: with githubStatus off nothing is posted; a refused post leaves the record and a warning', async () => {
  let { gh } = setup({ review: [{ verdict: 'pass', summary: 's', findings: [] }] });
  let r = await runReview({ repoId: 'perdix', pr: 7, state: { ...fx.state, reviews: { githubStatus: false } } });
  assert.deepEqual(gh.posts, []);
  assert.equal(r.record.githubStatus, null);
  ({ gh } = setup({ review: [{ verdict: 'pass', summary: 's', findings: [] }], gh: { failPost: true } }));
  r = await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  assert.equal(r.record.status, 'done');
  assert.equal(reviewFor('perdix', 7, fx.headA).githubStatus, null);
  assert.match(r.problems.join(), /GitHub status not posted/);
});

test('review: a changed file under a risk glob routes the PR to review.risky', async () => {
  const { kit } = setup({ review: [{ verdict: 'pass', summary: 's', findings: [] }] });
  const r = await runReview({ repoId: 'perdix', pr: 7, state: { ...fx.state, reviews: { repos: { perdix: { risk: ['src/**', 'docs/*'] } } } } });
  assert.equal(kit.calls[0].preset, 'review.risky');
  assert.equal(r.record.preset, 'review.risky');
  assert.equal(r.record.model, 'claude-opus-5-5');
  assert.deepEqual(r.record.risky, ['src/app.js', 'src/long.js', 'src/new.js']);
});

test('review: anything that is not a kit error writes no record', async () => {
  setup({ review: [{ verdict: 'pass', summary: 's', findings: [] }], view: {} });
  configureReviews({ kit: fakeKit(), gh: fakeGh({ views: { 'zlexo/perdix#7': new Error('HTTP 502') } }) });
  await assert.rejects(runReview({ repoId: 'perdix', pr: 7, state: fx.state }), /HTTP 502/);
  configureReviews({ kit: {}, gh: fakeGh({ views: views(), lists: {} }) });
  await assert.rejects(runReview({ repoId: 'perdix', pr: 7, state: fx.state }), /Claude kit is not available/);
  configureReviews({ kit: fakeKit({ review: [new Error('socket hang up')] }), gh: fakeGh({ views: views(), lists: {} }) });
  await assert.rejects(runReview({ repoId: 'perdix', pr: 7, state: fx.state }), /socket hang up/);
  assert.equal(fs.existsSync(reviewPath('perdix', 7, fx.headA)), false);
  await assert.rejects(runReview({ repoId: 'nope', pr: 7, state: fx.state }), e => e instanceof ReviewError && /unknown repo/.test(e.message));
  await assert.rejects(runReview({ repoId: 'perdix', pr: 0, state: fx.state }), ReviewError);
});

test('review: one review at a time; a waiting review takes the lock once it is free', async () => {
  setup({ review: [{ verdict: 'pass', summary: 's', findings: [] }] });
  const held = acquireLock('review', { repo: 'conduit', pr: 3 });
  await assert.rejects(runReview({ repoId: 'perdix', pr: 7, state: fx.state }), e => e.status === 409 && /conduit#3/.test(e.message));
  const kit = fakeKit({ review: [{ verdict: 'pass', summary: 's', findings: [] }] });
  configureReviews({ kit, gh: fakeGh({ views: views(), lists: {} }), sleep: async () => { held.release(); return true; } });
  const r = await runReview({ repoId: 'perdix', pr: 7, state: fx.state, lockWaitMs: 60000 });
  assert.equal(r.record.status, 'done');
});

test('review: a 429 with retry-after is waited out; one that persists is recorded', async () => {
  setup({ review: [new KitError('RateLimited', 'slow', { retryAfterS: 7 }), { verdict: 'pass', summary: 's', findings: [] }] });
  let r = await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  assert.deepEqual(sleeps, [7000]);
  assert.equal(r.record.status, 'done');
  const rl = () => new KitError('RateLimited', 'slow', { retryAfterS: 7 });
  setup({ review: [rl(), rl(), rl()] });
  r = await runReview({ repoId: 'perdix', pr: 8, state: fx.state });
  assert.deepEqual(sleeps, [7000, 7000], 'three tries, two waits');
  assert.equal(r.error.kind, 'RateLimited');
  setup({ review: [new KitError('RateLimited', 'slow', { retryAfterS: 3600 })] });
  r = await runReview({ repoId: 'perdix', pr: 8, state: fx.state });
  assert.deepEqual(sleeps, [], 'a wait longer than the cap is not waited');
  assert.equal(r.error.kind, 'RateLimited');
});

test('override: unblocks a blocked head, records who and why, flips the status, writes a daily line', async () => {
  setup({ review: [{ verdict: 'blocked', summary: 's', findings: [finding({ severity: 'blocker' })] }], verify: [{ real: true, why: 'w' }] });
  await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  const { gh } = setup();
  const r = await applyOverride({ repoId: 'perdix', pr: 7, sha: fx.headA, reason: `the swap is intended ${EM} see the RFC`, who: 'dev via cli', state: fx.state });
  const ov = overrideFor('perdix', 7, fx.headA);
  assert.deepEqual(ov, r.override);
  assert.equal(ov.who, 'dev via cli');
  assert.ok(ov.ts > 0);
  assert.deepEqual(gh.posts.map(p => [p.state, p.description]), [['success', 'blocked, overridden']]);
  assert.match(fs.readFileSync(reviewMdPath('perdix', 7, fx.headA), 'utf8'), /Overridden by dev via cli/);
  const last = dailyText().trim().split('\n').pop();
  assert.match(last, /overridden by dev via cli: the swap is intended, see the RFC/);
  assert.ok(!DASHES.test(dailyText()));
});

test('override: a re-review of an overridden head keeps the override in its status and rendering', async () => {
  setup({ review: [{ verdict: 'blocked', summary: 's', findings: [finding({ severity: 'blocker' })] }], verify: [{ real: true, why: 'w' }] });
  await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  setup();
  await applyOverride({ repoId: 'perdix', pr: 7, sha: fx.headA, reason: 'intended', who: 'z', state: fx.state });
  const { gh } = setup({ review: [{ verdict: 'blocked', summary: 's', findings: [finding({ severity: 'blocker' })] }], verify: [{ real: true, why: 'w' }] });
  const r = await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  assert.equal(r.record.verdict, 'blocked');
  assert.deepEqual(gh.posts.map(p => [p.state, p.description]), [['success', 'blocked, overridden']], 'GitHub agrees with the gate');
  assert.match(fs.readFileSync(reviewMdPath('perdix', 7, fx.headA), 'utf8'), /Overridden by z/);
});

test('override: refused unless the exact head has a done, blocked review, and always needs a reason', async () => {
  setup({ review: [{ verdict: 'pass', summary: 's', findings: [] }, new KitError('CreditsOut')] });
  await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  const go = (over = {}) => applyOverride({ repoId: 'perdix', pr: 7, sha: fx.headA, reason: 'r', who: 'z', state: fx.state, ...over });
  await assert.rejects(go(), e => e.status === 409 && /not blocked/.test(e.message));
  await assert.rejects(go({ sha: fx.headB }), e => e.status === 409 && /no review of/.test(e.message));
  await assert.rejects(go({ reason: '  ' }), e => e.status === 400 && /needs a reason/.test(e.message));
  await assert.rejects(go({ sha: 'abc' }), e => e.status === 400);
  await runReview({ repoId: 'perdix', pr: 8, state: fx.state });
  await assert.rejects(go({ pr: 8, sha: fx.headB }), e => e.status === 409 && /could not run \(CreditsOut\)/.test(e.message));
  assert.equal(overrideFor('perdix', 7, fx.headA), null);
});

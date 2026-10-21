import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpEnv, makeFixture, fakeKit, fakeGh, KitError, putCi, putJson, finding } from './helpers.mjs';

const tmp = tmpEnv('rv-cli');
const { main } = await import('../../lib/reviews/cli.mjs');
const { configureReviews } = await import('../../lib/reviews/deps.mjs');
const { reviewPath, overrideFor, reviewFor } = await import('../../lib/reviews/records.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fx = makeFixture(tmp);
const DATA = process.env.DECK_DATA;
// The CLI reads state.json from the deck root, never the gateway's copy:
// point Perdix at the fixture so nothing here touches a real checkout.
fs.writeFileSync(path.join(process.env.DECK_ROOT, 'state.json'), JSON.stringify(fx.state));

let out;
const io = () => { out = []; return { log: s => out.push(`out: ${s}`), err: s => out.push(`err: ${s}`) }; };
const run = async argv => main(argv, io());
let gh;
function setup(review = [], verify = []) {
  gh = fakeGh({ views: { 'zlexo/perdix#7': fx.pr7, 'zlexo/perdix#9': new Error('no pull requests found') }, lists: { 'zlexo/perdix': [fx.pr7] } });
  configureReviews({ kit: fakeKit({ review, verify }), gh, sleep: async () => true });
}
const rec = (over = {}) => ({ v: 1, repo: 'perdix', pr: 7, sha: fx.headA, status: 'done', verdict: 'pass', findings: [], dropped: [], finishedAt: 1, ...over });

beforeEach(() => { fs.rmSync(DATA, { recursive: true, force: true }); setup(); });

test('cli: usage errors exit 1, --help exits 0', async () => {
  assert.equal(await run([]), 1);
  assert.equal(await run(['--help']), 0);
  assert.match(out[0], /deck review --check <repo> <pr>/);
  assert.equal(await run(['perdix']), 1);
  assert.equal(await run(['nope', '7']), 1);
  assert.match(out.join(), /unknown repo nope \(configured: perdix, modplex, conduit\)/);
  assert.equal(await run(['perdix', 'seven']), 1);
  assert.equal(await run(['--bogus', 'perdix', '7']), 1);
});

test('cli: --check exits with the gate\'s code and prints one line of reason', async () => {
  const check = () => run(['--check', 'perdix', '#7']);
  assert.equal(await check(), 5);
  assert.deepEqual(out, [`err: no green CI: no green CI record for perdix#7 at ${fx.headA.slice(0, 7)}; run CI on this head first`, `err: head ${fx.headA}`]);
  putCi(DATA, 'perdix', fx.headA);
  assert.equal(await check(), 6);
  putJson(reviewPath('perdix', 7, fx.headB), rec({ sha: fx.headB }));
  assert.equal(await check(), 4);
  putJson(reviewPath('perdix', 7, fx.headA), rec({ status: 'failed', error: { kind: 'AuthMissing', message: 'no key' }, verdict: null }));
  assert.equal(await check(), 3);
  putJson(reviewPath('perdix', 7, fx.headA), rec({ verdict: 'blocked', findings: [finding({ severity: 'blocker' })] }));
  assert.equal(await check(), 2);
  assert.equal(out.length, 2);
  assert.equal(out[1], `err: head ${fx.headA}`, 'the full SHA, for --match-head-commit');
  assert.match(out[0], /^err: blocked: perdix#7 at \w{7} has 1 open blocker \(src\/app\.js:6\)/);
  assert.equal(await run(['--override', 'perdix', '7', '--reason', 'intended']), 0);
  assert.equal(await check(), 0);
  assert.match(out[0], /^out: mergeable \(overridden\): /);
  assert.equal(await run(['--check', 'perdix', '9']), 1);
  assert.match(out[0], /could not resolve perdix#9/);
});

test('cli: --override needs a reason and a blocked head', async () => {
  putJson(reviewPath('perdix', 7, fx.headA), rec());
  assert.equal(await run(['--override', 'perdix', '7']), 1);
  assert.match(out[0], /needs --reason/);
  assert.equal(await run(['--override', 'perdix', '7', '--reason=fine']), 1);
  assert.match(out[0], /not blocked: nothing to override/);
  putJson(reviewPath('perdix', 7, fx.headA), rec({ verdict: 'blocked', findings: [finding({ severity: 'blocker' })] }));
  assert.equal(await run(['--override', 'perdix', '7', '--reason=fine']), 0);
  const ov = overrideFor('perdix', 7, fx.headA);
  assert.equal(ov.reason, 'fine');
  assert.match(ov.who, / via cli$/);
  assert.deepEqual(gh.posts.map(p => p.description), ['blocked, overridden']);
});

test('cli: deck review exits 0 on a pass, 2 when blocked, 3 when the kit could not review, 1 on errors', async () => {
  setup([{ verdict: 'pass_with_notes', summary: 's', findings: [finding()] }]);
  assert.equal(await run(['perdix', '7']), 0);
  assert.match(out[0], /^out: perdix#7 at \w{7}: pass with notes \(0 blockers, 1 other, 0 dropped\), review\.normal claude-sonnet-5-5, \$0\.10$/);
  assert.match(out[1], /^out: record: .*reviews\/perdix\/7-[0-9a-f]{40}\.md$/);
  fs.rmSync(DATA, { recursive: true, force: true });
  setup([{ verdict: 'blocked', summary: 's', findings: [finding({ severity: 'blocker' })] }], [{ real: true, why: 'w' }]);
  assert.equal(await run(['perdix', '7']), 2);
  fs.rmSync(DATA, { recursive: true, force: true });
  setup([new KitError('CreditsOut', 'spend limit reached')]);
  assert.equal(await run(['perdix', '7']), 3);
  assert.match(out.join('\n'), /not reviewed \(CreditsOut: spend limit reached\)\. .*allowed on CI alone/);
  assert.equal(reviewFor('perdix', 7, fx.headA).status, 'failed');
  assert.equal(await run(['perdix', '9']), 1);
  assert.match(out.join(), /no pull requests found/);
});

test('cli: a 429 is waited out with a notice, never longer than five minutes a wait', async () => {
  setup([new KitError('RateLimited', 'slow', { retryAfterS: 30 }), { verdict: 'pass', summary: 's', findings: [] }]);
  assert.equal(await run(['perdix', '7']), 0);
  assert.ok(out.includes('err: rate limited: waiting 30 s as the API asked'));
  fs.rmSync(DATA, { recursive: true, force: true });
  setup([new KitError('RateLimited', 'slow', { retryAfterS: 600 })]);
  assert.equal(await run(['perdix', '7']), 3, 'a longer wait is not waited: recorded, gate 3');
  assert.ok(!out.some(l => l.includes('rate limited: waiting')));
});

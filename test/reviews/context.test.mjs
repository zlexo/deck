import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpEnv, makeFixture, git, fakeGh } from './helpers.mjs';
import { withSample } from '../fixtures/sample-config.mjs';

const tmp = tmpEnv('rv-context');
const { assembleContext, LIMITS, rfcNumbers, issueRefs, stackChain } = await import('../../lib/reviews/context.mjs');
const { reviewRepo } = await import('../../lib/reviews/config.mjs');
const { SYSTEM_PROMPT } = await import('../../lib/reviews/prompt.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fx = makeFixture(tmp);
const repo = reviewRepo('perdix', fx.state);
const d = { gh: fakeGh(), now: () => Date.now() };
const block = (ctx, name) => ctx.messages[0].content[ctx.meta.blocks.findIndex(b => b.name === name) - 1].text;

test('context: missing commits are fetched without moving a ref or writing FETCH_HEAD', async () => {
  const refsBefore = git(fx.clone, 'for-each-ref', '--format=%(refname) %(objectname)');
  assert.throws(() => git(fx.clone, 'cat-file', '-e', `${fx.headA}^{commit}`), 'the clone starts without the PR head');
  const ctx = await assembleContext({ repo, pr: fx.pr7, headSha: fx.headA, openPrs: [fx.pr7, fx.pr8], deps: d });
  assert.ok(ctx.changed.length > 0);
  git(fx.clone, 'cat-file', '-e', `${fx.headA}^{commit}`);
  assert.equal(git(fx.clone, 'for-each-ref', '--format=%(refname) %(objectname)'), refsBefore, 'no ref moved');
  assert.equal(fs.existsSync(path.join(fx.clone, '.git', 'FETCH_HEAD')), false, 'FETCH_HEAD untouched');
  assert.equal(git(fx.clone, 'status', '--porcelain'), '', 'working tree untouched');
});

test('context: the blocks come in the fixed order with at most four cache marks', async () => {
  const pr = { ...fx.pr8, body: 'Stacked on #7. Follows RFC 0003.' };
  const ctx = await assembleContext({ repo, pr, headSha: fx.headB, openPrs: [fx.pr7, fx.pr8], deps: d });
  assert.deepEqual(ctx.meta.blocks.map(b => b.name), ['system', 'rules', 'design', 'stack#7', 'pr']);
  assert.deepEqual(ctx.system, [{ text: SYSTEM_PROMPT, cache: true }]);
  const marks = (ctx.system.filter(b => b.cache).length) + ctx.messages[0].content.filter(b => b.cache).length;
  assert.ok(marks <= 4, `${marks} cache marks`);
  const content = ctx.messages[0].content;
  assert.equal(content[content.length - 1].cache, undefined, 'the PR itself is never cached');
  assert.ok(content.slice(0, -1).every(b => b.type === 'text'));
});

test('context: house rules are read at the head commit, lessons from the vault', async () => {
  let ctx = await assembleContext({ repo, pr: fx.pr7, headSha: fx.headA, openPrs: [], deps: d });
  const rules = block(ctx, 'rules');
  assert.match(rules, /Rule two: no em dashes/, 'the head version of CONTRIBUTING.md');
  assert.match(rules, /Naming is snake_case/, 'RFC 0000, a rules file for Perdix');
  assert.deepEqual(ctx.meta.rules, ['CONTRIBUTING.md', 'docs/design/0000-foundations.md'], 'CLAUDE.md is missing and skipped');
  assert.equal(ctx.meta.lessons, '', 'no lessons note: empty');
  const lessons = path.join(process.env.DECK_VAULT, 'Knowledge', 'Review Lessons', 'Perdix.md');
  fs.mkdirSync(path.dirname(lessons), { recursive: true });
  fs.writeFileSync(lessons, '- A range-for over a temporary passed debug and failed release.\n');
  ctx = await assembleContext({ repo, pr: fx.pr7, headSha: fx.headA, openPrs: [], deps: d });
  assert.match(block(ctx, 'rules'), /range-for over a temporary/);
  assert.equal(ctx.meta.lessons, 'Knowledge/Review Lessons/Perdix.md');
  fs.rmSync(lessons);
});

test('context: Perdix design context is the RFCs the PR names, minus rules and docs it changes', async () => {
  const pr = { ...fx.pr7, body: 'Builds on RFC 0002 and RFCs 0003 and 0000. See RFC 0099.' };
  const ctx = await assembleContext({ repo, pr, headSha: fx.headA, openPrs: [], deps: d });
  assert.deepEqual(ctx.meta.design, ['docs/design/0002-chunks.md', 'docs/design/0003-meshing.md']);
  assert.match(block(ctx, 'design'), /A chunk is 32 cubed/);
  assert.deepEqual(rfcNumbers('docs(rfc): 0011 horizon', 'RFC 7, RFC-12, RFCs 0006 and 0007', 'docs/rfc-0011-horizon', 'docs/design/0004-x.md'),
    ['0004', '0006', '0007', '0007', '0011', '0012'].filter((v, i, a) => a.indexOf(v) === i));
  const none = await assembleContext({ repo, pr: { ...fx.pr7, body: '' , title: 'no refs' }, headSha: fx.headA, openPrs: [], deps: d });
  assert.ok(!none.meta.blocks.some(b => b.name === 'design'), 'no design block, no cache mark spent on it');
});

test('context: Modplex and Conduit design context is the issues the PR links, not PRs', async () => {
  const conduit = reviewRepo('conduit', withSample({ repos: { conduit: { path: fx.clone } } }));
  const gh = fakeGh({ issues: {
    'zlexo/conduit#5': { number: 5, title: 'Custody leaks', state: 'open', body: 'Players lose items.' },
    'zlexo/conduit#6': { number: 6, title: 'Hub mode', state: 'closed', body: 'Adventure in the hub.' },
    'zlexo/conduit#9': { number: 9, title: 'a PR', pull_request: {}, body: 'not an issue' },
  } });
  const pr = { ...fx.pr7, body: 'Fixes the leak. Also see #6, and #9 for the PR. Not &#38; or a/#7.', closingIssuesReferences: [{ number: 5, repository: { name: 'conduit', owner: { login: 'zlexo' } } }, { number: 77, repository: { name: 'other', owner: { login: 'zlexo' } } }] };
  assert.deepEqual(issueRefs(pr, 'zlexo/conduit'), [5, 6, 9]);
  const ctx = await assembleContext({ repo: conduit, pr, headSha: fx.headA, openPrs: [], deps: { ...d, gh } });
  assert.deepEqual(ctx.meta.design, ['#5', '#6']);
  assert.match(block(ctx, 'design'), /Players lose items/);
  assert.doesNotMatch(block(ctx, 'design'), /not an issue/);
});

test('context: a stacked PR carries the diffs below it, bottom first, at most three', async () => {
  const ctx = await assembleContext({ repo, pr: fx.pr8, headSha: fx.headB, openPrs: [fx.pr8, fx.pr7], deps: d });
  assert.deepEqual(ctx.meta.stack, [7]);
  assert.ok(/return b - a; \/\/ swapped/.test(block(ctx, 'stack#7')), 'the lower PR\'s change');
  assert.ok(!/swapped/.test(block(ctx, 'pr')), 'the PR under review shows only its own change');
  const chain = n => ({ number: n, headRefName: `b${n}`, baseRefName: n === 1 ? 'main' : `b${n - 1}` });
  const all = [1, 2, 3, 4, 5].map(chain);
  assert.deepEqual(stackChain(all[4], all).map(p => p.number), [2, 3, 4], 'three below, bottom first');
  const loop = [{ number: 1, headRefName: 'x', baseRefName: 'y' }, { number: 2, headRefName: 'y', baseRefName: 'x' }];
  assert.deepEqual(stackChain(loop[0], loop).map(p => p.number), [2], 'a cycle ends');
});

test('context: the diff is -U10 with head line numbers, files up to 40 KB in full, lockfiles left out', async () => {
  const ctx = await assembleContext({ repo, pr: fx.pr7, headSha: fx.headA, openPrs: [], deps: d });
  const pr = block(ctx, 'pr');
  const diff = pr.slice(pr.indexOf('<diff>'), pr.indexOf('</diff>'));
  const has = (text, re, msg) => assert.ok(re.test(text), msg);
  has(diff, /^ {4}6\+\| {2}return b - a; \/\/ swapped$/m, 'added line with its head number');
  has(diff, /^ {5}-\| {2}return a - b;$/m, 'removed line without a number');
  has(diff, /^ {3}20 \|long line 20$/m, 'ten lines of context before line 30');
  assert.ok(!/^ {3}19 \|long line 19$/m.test(diff), 'but not eleven');
  has(diff, /^ {3}40 \|long line 40$/m, 'ten lines of context after');
  assert.ok(!/^ {3}41 \|/m.test(diff), 'but not eleven');
  has(pr, /<file path="src\/new.js" lines="1">\n {4}1 \|export const answer = 42;\n<\/file>/, 'a small file in full');
  has(pr, /<file path="big.txt" omitted="43 KB, over the 40 KB limit/, 'a file over 40 KB is left out');
  has(pr, /^ 1500\+\|big line 1500 changed$/m, 'its diff is still there');
  has(diff, /diff --git a\/package-lock.json b\/package-lock.json\n\(generated file: its diff is not shown\)/, 'lockfile diff left out');
  assert.ok(!/"packages": \{\}/.test(pr), 'lockfile text left out');
  assert.equal(ctx.meta.partial, false);
  assert.equal(ctx.chunkFor('src/app.js').includes('6+|'), true);
  assert.equal(await ctx.readHead('src/new.js'), 'export const answer = 42;\n');
  assert.equal(await ctx.readHead('nope.js'), null);
  assert.ok(ctx.meta.tokensEst > 0 && ctx.meta.tokensEst === Math.ceil(ctx.meta.blocks.reduce((n, b) => n + b.chars, 0) / 4));
});

test('context: over the token limit the PR goes hunks only and is flagged partial', async () => {
  const saved = LIMITS.tokens;
  try {
    const full = await assembleContext({ repo, pr: fx.pr8, headSha: fx.headB, openPrs: [fx.pr7, fx.pr8], deps: d });
    LIMITS.tokens = full.meta.tokensEst - 1;
    const ctx = await assembleContext({ repo, pr: fx.pr8, headSha: fx.headB, openPrs: [fx.pr7, fx.pr8], deps: d });
    assert.equal(ctx.meta.partial, true);
    assert.match(ctx.meta.notes[0], /^hunks only/);
    assert.doesNotMatch(block(ctx, 'pr'), /<head_files>/);
    assert.match(block(ctx, 'pr'), /<partial_context>/);
    assert.ok(ctx.meta.tokensEst <= LIMITS.tokens);
    LIMITS.tokens = 1;
    const tiny = await assembleContext({ repo, pr: fx.pr7, headSha: fx.headA, openPrs: [], deps: d });
    assert.equal(tiny.meta.partial, true);
    assert.ok(tiny.meta.notes.some(n => /largest file diffs/.test(n)), 'then whole file diffs go');
    assert.match(block(tiny, 'pr'), /not shown, to fit the context/);
  } finally { LIMITS.tokens = saved; }
});

test('context: the system prompt and the rules block are the same bytes for two PRs', async () => {
  const a = await assembleContext({ repo, pr: fx.pr8, headSha: fx.headB, openPrs: [], deps: d });
  const b = await assembleContext({ repo, pr: { ...fx.pr8, title: 'Another title', body: 'Other body' }, headSha: fx.headB, openPrs: [], deps: d });
  assert.equal(a.system[0].text, b.system[0].text);
  assert.equal(a.messages[0].content[0].text, b.messages[0].content[0].text);
  assert.doesNotMatch(SYSTEM_PROMPT, /\d{4}-\d{2}-\d{2}|perdix|conduit|modplex/i, 'nothing per run or per repo in the cached system prompt');
});

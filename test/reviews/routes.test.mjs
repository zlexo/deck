import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpEnv, makeFixture, fakeKit, fakeGh, putCi, putJson, finding } from './helpers.mjs';

const tmp = tmpEnv('rv-routes');
const { configureReviews } = await import('../../lib/reviews/deps.mjs');
const { createRouter } = await import('../../lib/core/http.mjs');
const reviews = await import('../../lib/reviews/index.mjs');
const { clearPrCache } = await import('../../lib/reviews/github.mjs');
const { reviewPath, reviewFor, overrideFor } = await import('../../lib/reviews/records.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fx = makeFixture(tmp);
const DATA = process.env.DECK_DATA;
let state = { ...fx.state, other: { keep: true } };
const saved = [];
const ctx = { getState: () => state, saveState: next => { saved.push(next); state = next; } };
const router = createRouter();
reviews.register(router, ctx);

function call(method, url, body) {
  const listeners = {};
  const text = body === undefined ? '' : JSON.stringify(body);
  const req = { method, url, on(ev, fn) { (listeners[ev] ||= []).push(fn); if (ev === 'end') queueMicrotask(() => { for (const f of listeners.data || []) f(Buffer.from(text)); for (const f of listeners.end) f(); }); return req; }, destroy() {} };
  const res = { code: null, body: null, headersSent: false, writableEnded: false,
    writeHead(c) { this.code = c; this.headersSent = true; }, end(b) { this.body = b ? JSON.parse(b) : null; this.writableEnded = true; } };
  return router.handle(req, res, new URL(url, 'http://x')).then(hit => ({ hit, code: res.code, body: res.body }));
}

const rec = (pr, sha, over = {}) => ({ v: 1, repo: 'perdix', slug: 'zlexo/perdix', pr, sha, title: 't', status: 'done', verdict: 'pass', summary: '', findings: [], dropped: [], costUsd: 0.12, finishedAt: 5, preset: 'review.normal', context: {}, ...over });
let gh;
beforeEach(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
  gh = fakeGh({ lists: { 'zlexo/perdix': [fx.pr7, fx.pr8] }, failList: { 'zlexo/modplex': 'gh: HTTP 502' }, views: { 'zlexo/perdix#7': fx.pr7 } });
  configureReviews({ kit: fakeKit({ spend: { month: '2026-10', total: 1.5 }, review: [{ verdict: 'pass', summary: 's', findings: [] }] }), gh });
  clearPrCache();
});

test('routes: GET /api/reviews lists each repo\'s open PRs with CI, review and gate', async () => {
  putCi(DATA, 'perdix', fx.headA);
  putJson(reviewPath('perdix', 7, fx.headA), rec(7, fx.headA, { verdict: 'blocked', findings: [finding({ severity: 'blocker' }), finding()] }));
  putCi(DATA, 'perdix', fx.headB, 'running');
  const r = await call('GET', '/api/reviews');
  assert.equal(r.code, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['queue', 'repos', 'spend']);
  assert.deepEqual(Object.keys(r.body.queue).sort(), ['intervalMin', 'lastError', 'lastPassAt', 'nextPassAt', 'on', 'running']);
  assert.equal(r.body.queue.on, true);
  assert.equal(r.body.queue.intervalMin, 10);
  assert.deepEqual(r.body.spend, { month: '2026-10', total: 1.5 });
  assert.deepEqual(r.body.repos.map(x => x.id), ['perdix', 'modplex', 'conduit']);
  const perdix = r.body.repos[0];
  assert.deepEqual({ id: perdix.id, name: perdix.name, slug: perdix.slug }, { id: 'perdix', name: 'Perdix', slug: 'zlexo/perdix' });
  assert.deepEqual(perdix.prs[0], {
    pr: 7, title: fx.pr7.title, sha: fx.headA, url: fx.pr7.url, ci: 'green',
    review: { verdict: 'blocked', blockers: 1, notes: 1, costUsd: 0.12, status: 'done', error: null },
    gate: { code: 2, label: 'blocked' },
  });
  assert.equal(perdix.prs[1].ci, 'running');
  assert.equal(perdix.prs[1].review, null);
  assert.deepEqual(perdix.prs[1].gate, { code: 5, label: 'no green CI' });
  assert.equal(perdix.error, undefined);
  assert.deepEqual(r.body.repos[1].prs, []);
  assert.equal(r.body.repos[1].error, 'gh: HTTP 502', 'a failed listing says so instead of looking empty');
  await call('GET', '/api/reviews');
  assert.equal(gh.calls.filter(a => a[1] === 'list').length, 3 + 1, 'lists are cached for a minute; the failed one is asked again');
});

test('routes: GET /api/reviews/record returns the record, its rendering and its override', async () => {
  putJson(reviewPath('perdix', 7, fx.headA), rec(7, fx.headA, { finishedAt: 9 }));
  putJson(reviewPath('perdix', 7, fx.headB), rec(7, fx.headB, { finishedAt: 3 }));
  putJson(path.join(DATA, 'reviews', 'perdix', `7-${fx.headA}.override.json`), { who: 'z', reason: 'r', ts: 1 });
  let r = await call('GET', `/api/reviews/record?repo=perdix&pr=7&sha=${fx.headB}`);
  assert.equal(r.code, 200);
  assert.equal(r.body.record.sha, fx.headB);
  assert.equal(r.body.override, null);
  assert.match(r.body.markdown, /^# Review: perdix#7 t/);
  r = await call('GET', '/api/reviews/record?repo=perdix&pr=7');
  assert.equal(r.body.record.sha, fx.headA, 'without a sha: the newest record of the PR');
  assert.deepEqual(r.body.override, { who: 'z', reason: 'r', ts: 1 });
  assert.equal((await call('GET', '/api/reviews/record?repo=perdix&pr=99')).code, 404);
  assert.equal((await call('GET', '/api/reviews/record?repo=perdix&pr=7&sha=../../x')).code, 400);
  assert.equal((await call('GET', '/api/reviews/record?repo=../x&pr=7')).code, 400);
  assert.equal((await call('GET', '/api/reviews/record?repo=perdix&pr=abc')).code, 400);
});

test('routes: POST /api/reviews/run starts a review in the background', async () => {
  const r = await call('POST', '/api/reviews/run', { repo: 'perdix', pr: 7 });
  assert.deepEqual([r.code, r.body], [200, { started: true }]);
  for (let i = 0; i < 200 && !reviewFor('perdix', 7, fx.headA); i++) await new Promise(res => setTimeout(res, 25));
  assert.equal(reviewFor('perdix', 7, fx.headA).status, 'done');
  assert.equal((await call('POST', '/api/reviews/run', { repo: 'nope', pr: 7 })).code, 400);
  assert.equal((await call('POST', '/api/reviews/run', { repo: 'perdix' })).code, 400);
});

test('routes: POST /api/reviews/override records an override for a blocked head only', async () => {
  putJson(reviewPath('perdix', 7, fx.headA), rec(7, fx.headA, { verdict: 'blocked', findings: [finding({ severity: 'blocker' })] }));
  putJson(reviewPath('perdix', 8, fx.headB), rec(8, fx.headB));
  assert.equal((await call('POST', '/api/reviews/override', { repo: 'perdix', pr: 7, sha: fx.headA })).code, 400, 'a reason is required');
  assert.equal((await call('POST', '/api/reviews/override', { repo: 'perdix', pr: 7, sha: 'abc', reason: 'r' })).code, 400);
  const notBlocked = await call('POST', '/api/reviews/override', { repo: 'perdix', pr: 8, sha: fx.headB, reason: 'r' });
  assert.equal(notBlocked.code, 409);
  assert.match(notBlocked.body.error, /not blocked/);
  const ok = await call('POST', '/api/reviews/override', { repo: 'perdix', pr: 7, sha: fx.headA, reason: 'intended' });
  assert.deepEqual([ok.code, ok.body], [200, { ok: true }]);
  const ov = overrideFor('perdix', 7, fx.headA);
  assert.equal(ov.reason, 'intended');
  assert.match(ov.who, / via Deck$/);
  assert.deepEqual(gh.posts.map(p => p.description), ['blocked, overridden']);
});

test('routes: POST /api/reviews/queue writes the setting through ctx.saveState and keeps the rest', async () => {
  let r = await call('POST', '/api/reviews/queue', { on: false });
  assert.deepEqual(r.body, { on: false });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].other, { keep: true }, 'the rest of state.json survives');
  assert.equal(saved[0].repos.perdix.path, fx.clone);
  assert.equal(saved[0].reviews.queue, false);
  assert.equal((await call('GET', '/api/reviews')).body.queue.on, false);
  r = await call('POST', '/api/reviews/queue', { on: true });
  assert.equal(state.reviews.queue, true);
  assert.equal((await call('POST', '/api/reviews/queue', { on: 'yes' })).code, 400);
  assert.equal(saved.length, 2);
});

test('routes: registered as the contract names them', () => {
  assert.deepEqual(router.routes(), ['GET /api/reviews', 'GET /api/reviews/record', 'POST /api/reviews/run', 'POST /api/reviews/override', 'POST /api/reviews/queue']);
});

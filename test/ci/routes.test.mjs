import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupEnv, makeRepo, stateFor, holdLock, until, sh } from './fixtures.mjs';

const tmp = setupEnv('deck-ci-routes-');
const { createRouter } = await import('../../lib/core/http.mjs');
const ci = await import('../../lib/ci/index.mjs');
const { recordFor, ciRecordPath } = await import('../../lib/ci/records.mjs');
const { runLockName } = await import('../../lib/ci/runner.mjs');
const { main } = await import('../../lib/ci/cli.mjs');
after(async () => { await ci.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

const repo = makeRepo(tmp, 'fake');
let jobs = [{ name: 'ok', cmd: sh('echo one; echo two; echo three') }];
const state = () => stateFor({ fake: repo }, { fake: { timeoutMin: 1, jobs } });
let n = 0;
const head = () => repo.commit({ [`r${++n}.txt`]: `${n}\n` }, `commit ${n}`);

// The router the gateway uses, driven without a socket.
const router = createRouter();
ci.register(router, { getState: state });
async function call(method, url, body) {
  const listeners = {};
  const text = body === undefined ? '' : JSON.stringify(body);
  const req = { method, url, on(ev, fn) { (listeners[ev] ||= []).push(fn); if (ev === 'end') queueMicrotask(() => { for (const f of listeners.data || []) f(Buffer.from(text)); for (const f of listeners.end) f(); }); return req; }, destroy() {} };
  const res = { code: null, body: null, headersSent: false, writableEnded: false,
    writeHead(c) { this.code = c; this.headersSent = true; }, end(b) { this.body = b ? JSON.parse(b) : null; this.writableEnded = true; } };
  const handled = await router.handle(req, res, new URL(url, 'http://x'));
  assert.ok(handled, `${method} ${url} is a CI route`);
  return res;
}

test('the four routes of contract § 5 are registered', () => {
  assert.deepEqual(router.routes(), ['GET /api/ci', 'POST /api/ci/run', 'GET /api/ci/record', 'GET /api/ci/log']);
});

test('POST /api/ci/run refuses bad input and queues a head; nothing runs before start()', async () => {
  for (const [body, re] of [
    [{ repo: 'nope', sha: repo.main }, /unknown repo/],
    [{ repo: 'fake' }, /say which head/],
    [{ repo: 'fake', sha: 'zz' }, /not a commit SHA/],
    [{ repo: 'fake', pr: -1 }, /not a pull request number/],
    [{ repo: 'fake', ref: 'dev' }, /only "main"/],
    [{ repo: 'fake', ref: 'main', sha: repo.main }, /one of pr, sha/],
    [[1, 2], /expected a JSON object/],
  ]) {
    const r = await call('POST', '/api/ci/run', body);
    assert.equal(r.code, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
  const sha = head();
  const ok = await call('POST', '/api/ci/run', { repo: 'fake', sha: sha.slice(0, 9) });
  assert.equal(ok.code, 200);
  assert.deepEqual(ok.body, { queued: true, sha });
  const again = await call('POST', '/api/ci/run', { repo: 'fake', sha });
  assert.deepEqual(again.body, { queued: true, sha }, 'a second ask is the same answer');
  const o = (await call('GET', '/api/ci')).body;
  assert.equal(o.running, null);
  assert.deepEqual(o.queue, [{ repo: 'fake', sha, pr: null }]);
  const fake = o.repos.find(r => r.id === 'fake');
  assert.deepEqual(Object.keys(fake).sort(), ['id', 'latest', 'name', 'records', 'slug']);
  assert.equal(fake.slug, 'test/fake');
  assert.equal(fake.latest.status, 'queued');
  assert.deepEqual(o.repos.map(r => r.id), ['fake'], 'only the configured repos, none built in');
  // The feature's start() closes what a dead process left running, then runs
  // what was queued.
  const stale = repo.commit({ 'stale.txt': 'x\n' }, 'stale');
  fs.writeFileSync(ciRecordPath('fake', stale), JSON.stringify({ v: 1, repo: 'fake', sha: stale, pr: null, ref: null, status: 'running', startedAt: 1, jobs: [{ name: 'ok', status: 'running', summary: {} }], error: null }));
  ci.start();
  await until(() => recordFor('fake', stale)?.status === 'error', { what: 'start() to close the stale record' });
  assert.match(recordFor('fake', stale).error, /interrupted/);
  await until(() => recordFor('fake', sha)?.status === 'green', { what: 'the queued run' });
  const after = (await call('GET', '/api/ci')).body;
  assert.equal(after.running, null);
  assert.deepEqual(after.queue, []);
  assert.equal(after.repos.find(r => r.id === 'fake').latest.sha, sha);
});

test('GET /api/ci/record and /api/ci/log answer per head, and a log outside the record folder is never read', async () => {
  const sha = head();
  await call('POST', '/api/ci/run', { repo: 'fake', sha });
  await until(() => recordFor('fake', sha)?.status === 'green', { what: 'the run' });
  assert.equal((await call('GET', `/api/ci/record?repo=fake&sha=${sha}`)).body.status, 'green');
  assert.equal((await call('GET', `/api/ci/record?repo=fake&sha=${'f'.repeat(40)}`)).code, 404);
  assert.equal((await call('GET', `/api/ci/record?repo=fake&sha=${sha.slice(0, 12)}`)).code, 400);
  assert.equal((await call('GET', `/api/ci/record?repo=..&sha=${sha}`)).code, 400);
  const lines = (await call('GET', `/api/ci/log?repo=fake&sha=${sha}&job=ok&lines=2`)).body.lines;
  assert.deepEqual(lines, ['three', lines[1]]);
  assert.match(lines[1], /^\[deck\] exit 0/);
  assert.equal((await call('GET', `/api/ci/log?repo=fake&sha=${sha}&job=${encodeURIComponent('../../x')}`)).code, 404);
  // A record whose log points elsewhere (edited by hand, or by anything else).
  const secret = path.join(tmp, 'secret.txt');
  fs.writeFileSync(secret, 'do not serve\n');
  const rec = recordFor('fake', sha);
  rec.jobs[0].log = secret;
  fs.writeFileSync(ciRecordPath('fake', sha), JSON.stringify(rec));
  const r = await call('GET', `/api/ci/log?repo=fake&sha=${sha}&job=ok`);
  assert.equal(r.code, 400);
  assert.ok(!JSON.stringify(r.body).includes('do not serve'));
});

test('GET /api/ci shows a run that another process holds the ci lock for, and heads another process queued', async () => {
  const running = head(), queued = head();
  const write = rec => { fs.mkdirSync(path.dirname(ciRecordPath('fake', rec.sha)), { recursive: true }); fs.writeFileSync(ciRecordPath('fake', rec.sha), JSON.stringify(rec)); };
  write({ v: 1, repo: 'fake', sha: running, pr: 4, ref: 'pull/4/head', status: 'running', startedAt: Date.now(), jobs: [{ name: 'ok', status: 'running', summary: {} }], error: null });
  write({ v: 1, repo: 'fake', sha: queued, pr: null, ref: null, status: 'queued', startedAt: Date.now(), jobs: [], error: null });
  const ciLock = holdLock('ci', { what: 'CI fake', repo: 'fake', sha: running, pr: 4 });
  const runLock = holdLock(runLockName('fake', queued), { repo: 'fake', sha: queued });
  try {
    const o = (await call('GET', '/api/ci')).body;
    assert.deepEqual(o.running, { repo: 'fake', sha: running, pr: 4, job: 'ok' });
    assert.deepEqual(o.queue, [{ repo: 'fake', sha: queued, pr: null }]);
  } finally { ciLock.release(); runLock.release(); }
  // Without live holders they are neither running nor queued.
  const o = (await call('GET', '/api/ci')).body;
  assert.equal(o.running, null);
  assert.deepEqual(o.queue, []);
});

test('deck ci: exit 0 green, 1 red, 3 error; --status reads the record', async () => {
  const lines = [];
  const io = (st) => ({ state: st, out: l => lines.push(l), err: l => lines.push(`ERR ${l}`), runnerOpts: { pollMs: 20 } });
  // A record a killed `deck ci` left running is closed by the next one.
  const left = head();
  fs.writeFileSync(ciRecordPath('fake', left), JSON.stringify({ v: 1, repo: 'fake', sha: left, pr: null, ref: null, status: 'running', startedAt: 1, jobs: [], error: null }));
  const green = head();
  assert.equal(await main(['fake', green], io(state())), 0);
  assert.equal(recordFor('fake', left).status, 'error');
  assert.ok(lines.some(l => /^fake [0-9a-f]{12}: green/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => l.startsWith('ok: green')));
  assert.ok(lines.some(l => l.includes(`record: `) && l.includes(`${green}.json`)));
  jobs = [{ name: 'bad', cmd: sh('exit 1') }];
  const red = head();
  assert.equal(await main(['fake', red], io(state())), 1);
  jobs = [{ name: 'needs', cmd: sh('true'), requires: [path.join(tmp, 'missing-tool')] }];
  const broken = head();
  assert.equal(await main(['fake', broken], io(state())), 3);
  jobs = [{ name: 'ok', cmd: sh('true') }];
  assert.equal(await main(['--status', 'fake', green], io(state())), 0);
  assert.equal(await main(['--status', 'fake', red], io(state())), 1);
  assert.equal(await main(['--status', 'fake', broken.slice(0, 10)], io(state())), 1);
  assert.equal(await main(['--status', 'fake', 'f'.repeat(40)], io(state())), 1);
  assert.equal(await main(['nope', 'main'], io(state())), 1);
  assert.equal(await main(['fake', 'xyz'], io(state())), 1);
  assert.equal(await main([], io(state())), 1);
});

test('deck ci through bin/deck.mjs: state.json from DECK_ROOT, exit codes from the record', () => {
  const st = state();
  fs.writeFileSync(path.join(process.env.DECK_ROOT, 'state.json'), JSON.stringify(st));
  const bin = path.join(path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname))), 'bin', 'deck.mjs');
  const env = { ...process.env };
  const sha = head();
  const runIt = (...a) => spawnSync(process.execPath, [bin, 'ci', ...a], { env, encoding: 'utf8', timeout: 60000 });
  const r = runIt('fake', sha);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /: green/);
  assert.equal(runIt('--status', 'fake', sha).status, 0);
  assert.equal(runIt('--status', 'fake', 'e'.repeat(40)).status, 1);
});

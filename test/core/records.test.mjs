import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-records-'));
process.env.DECK_DATA = tmp;
const ci = await import('../../lib/ci/records.mjs');
const rv = await import('../../lib/reviews/records.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const put = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };

test('ci records: green only when the record for that exact sha is green', () => {
  put(ci.ciRecordPath('perdix', A), { v: 1, repo: 'perdix', sha: A, status: 'green', startedAt: 1 });
  put(ci.ciRecordPath('perdix', B), { v: 1, repo: 'perdix', sha: B, status: 'red', startedAt: 2 });
  assert.equal(ci.isGreen('perdix', A), true);
  assert.equal(ci.isGreen('perdix', B), false);
  assert.equal(ci.isGreen('perdix', 'c'.repeat(40)), false);
  assert.equal(ci.isGreen('perdix', 'not-a-sha'), false);
  assert.equal(ci.isGreen('modplex', A), false, 'records are per repo');
  assert.equal(ci.latestRecord('perdix').sha, B);
  assert.deepEqual(ci.listRecords('perdix').map(r => r.sha), [B, A]);
});

test('review records: listed per PR, overrides kept apart', () => {
  put(rv.reviewPath('perdix', 7, A), { pr: 7, sha: A, status: 'done', verdict: 'blocked', finishedAt: 5 });
  put(rv.reviewPath('perdix', 7, B), { pr: 7, sha: B, status: 'done', verdict: 'pass', finishedAt: 9 });
  put(rv.reviewPath('perdix', 8, A), { pr: 8, sha: A, status: 'failed', finishedAt: 3 });
  put(rv.overridePath('perdix', 7, A), { who: 'dev', reason: 'r', ts: 6 });
  assert.equal(rv.reviewFor('perdix', 7, A).verdict, 'blocked');
  assert.equal(rv.overrideFor('perdix', 7, A).reason, 'r');
  assert.equal(rv.overrideFor('perdix', 7, B), null);
  assert.deepEqual(rv.listReviews('perdix', { pr: 7 }).map(r => r.sha), [B, A]);
  assert.equal(rv.listReviews('perdix').length, 3, 'override files are not records');
  assert.equal(rv.latestRecord('perdix').sha, B);
});

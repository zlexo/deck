// Reviews through the real Claude kit, with only the Anthropic client faked:
// what the kit builds from the review's blocks (cache marks, the schema, the
// presets), what it bills, and how its errors land in records. No key, no
// network: the client is a stub and the key reader returns a placeholder.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpEnv, makeFixture, fakeGh, finding } from './helpers.mjs';

const tmp = tmpEnv('rv-kit');
const kit = await import('../../lib/claude/index.mjs');
const { readJsonl } = await import('../../lib/core/files.mjs');
const { dataPath } = await import('../../lib/core/paths.mjs');
const { configureReviews } = await import('../../lib/reviews/deps.mjs');
const { runReview } = await import('../../lib/reviews/review.mjs');
const { reviewFor } = await import('../../lib/reviews/records.mjs');
const { REVIEW_SCHEMA, VERIFY_SCHEMA } = await import('../../lib/reviews/prompt.mjs');
after(() => { kit.resetKit(); fs.rmSync(tmp, { recursive: true, force: true }); });

const fx = makeFixture(tmp);
let sent, replies, sleeps;
const message = (answer, over = {}) => ({
  id: `msg_${sent.length}`, model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(answer) }],
  usage: { input_tokens: 10000, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  _request_id: `req_${sent.length}`, ...over,
});
function reply(params) {
  sent.push(params);
  const r = replies.shift();
  if (!r) throw new Error('stub client: no reply queued');
  if (r.throw) throw r.throw;
  return message(r.answer, r.over);
}
const stub = { create: async p => reply(p), stream: p => ({ finalMessage: async () => reply(p) }) };
const client = { messages: stub, beta: { messages: stub } };

beforeEach(() => {
  sent = []; replies = []; sleeps = [];
  fs.rmSync(dataPath(), { recursive: true, force: true });
  kit.resetKit();
  kit.configureKit({ keyReader: async () => 'placeholder-not-a-key', clientFactory: () => client });
  configureReviews({ gh: fakeGh({ views: { 'zlexo/perdix#7': fx.pr7 }, lists: { 'zlexo/perdix': [fx.pr7] } }), sleep: async ms => { sleeps.push(ms); return true; } });
});

const marks = params => {
  const blocks = [...(params.system || []), ...params.messages.flatMap(m => (Array.isArray(m.content) ? m.content : []))];
  return blocks.filter(b => b.cache_control).map(b => b.cache_control);
};

test('kit seam: the review and verify requests the kit builds, and what the record says they cost', async () => {
  replies = [
    { answer: { verdict: 'blocked', summary: 's', findings: [finding({ severity: 'blocker' })] } },
    { answer: { real: true, why: 'line 6 subtracts the wrong way round' } },
  ];
  const r = await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  assert.equal(r.error, null);
  const [review, verify] = sent;
  assert.equal(review.model, 'claude-sonnet-5-5');
  assert.equal(review.max_tokens, 32000);
  assert.deepEqual(review.output_config, { effort: 'high', format: { type: 'json_schema', schema: REVIEW_SCHEMA } });
  const m = marks(review);
  assert.ok(m.length >= 2 && m.length <= 4, `${m.length} cache marks`);
  assert.ok(m.every(c => c.type === 'ephemeral' && c.ttl === '1h'));
  assert.ok(review.system[0].cache_control, 'the system prompt is a cached prefix');
  const content = review.messages[0].content;
  assert.equal(content[content.length - 1].cache_control, undefined, 'the PR block is never cached');
  assert.ok(content.every(b => b.type === 'text' && typeof b.text === 'string' && !('cache' in b)));
  assert.equal(verify.model, 'claude-sonnet-5-5');
  assert.equal(verify.max_tokens, 4000);
  assert.deepEqual(verify.output_config, { effort: 'low', format: { type: 'json_schema', schema: VERIFY_SCHEMA } });
  assert.equal(marks(verify).length, 0, 'the verify preset sends no cache marks');
  const rec = reviewFor('perdix', 7, fx.headA);
  assert.equal(rec.verdict, 'blocked');
  assert.deepEqual(rec.requestIds, ['req_1', 'req_2']);
  // 10k in and 1k out on Sonnet 5.5, twice: 2 * (10000 * 2 + 1000 * 10) / 1e6.
  assert.equal(rec.costUsd, 0.06);
  const ledger = readJsonl(dataPath('claude-ledger.jsonl'));
  assert.deepEqual(ledger.map(l => [l.tool, l.preset, l.ref.split(' ')[0]]), [['reviews', 'review.normal', `perdix#7@${fx.headA.slice(0, 7)}`], ['reviews', 'review.verify', `perdix#7@${fx.headA.slice(0, 7)}`]]);
});

test('kit seam: a refusal is a failed record that keeps what it cost', async () => {
  replies = [{ answer: {}, over: { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] } }];
  const r = await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  assert.equal(r.error.kind, 'Refused');
  const rec = reviewFor('perdix', 7, fx.headA);
  assert.equal(rec.status, 'failed');
  assert.equal(rec.error.kind, 'Refused');
  assert.equal(rec.costUsd, 0.03, 'a refused request was still billed');
  assert.deepEqual(rec.requestIds, []);
});

test('kit seam: the caps in the state the review is handed, and a missing key, stop it before any request', async () => {
  let r = await runReview({ repoId: 'perdix', pr: 7, state: { ...fx.state, claude: { caps: { reviews: 0 } } } });
  assert.equal(r.error.kind, 'BudgetExhausted');
  kit.configureKit({ keyReader: async () => null });
  r = await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  assert.equal(r.error.kind, 'AuthMissing');
  assert.equal(sent.length, 0, 'nothing reached the client');
  assert.equal(reviewFor('perdix', 7, fx.headA).error.kind, 'AuthMissing');
});

test('kit seam: a 429 with retry-after from the API is waited out and retried', async () => {
  const limited = Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '3' } });
  replies = [{ throw: limited }, { answer: { verdict: 'pass', summary: 's', findings: [] } }];
  const r = await runReview({ repoId: 'perdix', pr: 7, state: fx.state });
  assert.deepEqual(sleeps, [3000]);
  assert.equal(r.record.status, 'done');
  assert.equal(sent.length, 2);
});

test('kit seam: the page\'s spend is the kit\'s summary for the live state', async () => {
  const { overview } = await import('../../lib/reviews/routes.mjs');
  const o = await overview({ getState: () => ({ ...fx.state, claude: { caps: { reviews: 12 } } }) });
  assert.equal(o.spend.caps.reviews, 12);
  assert.ok('month' in o.spend && 'levels' in o.spend);
});

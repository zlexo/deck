import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-kit-'));
process.env.DECK_DATA = path.join(tmp, 'data');
process.env.DECK_VAULT = path.join(tmp, 'vault');
const { setDeckRoot } = await import('../../lib/core/paths.mjs');
setDeckRoot(path.join(tmp, 'root')); // no state.json there: default caps
const kit = await import('../../lib/claude/index.mjs');
const { costOf, ledgerFile, readCalls, monthOf } = await import('../../lib/claude/ledger.mjs');
const { classify } = await import('../../lib/claude/errors.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const KEY = 'sk-ant-test-NEVER-WRITE-ME';
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

// A fake SDK client that records requests and answers with `respond(params, path)`.
function fakeClient(respond) {
  const seen = [];
  const api = beta => ({
    create: async p => { seen.push({ p, beta, stream: false }); return respond(p, { beta, stream: false }); },
    stream: p => { seen.push({ p, beta, stream: true }); return { finalMessage: async () => respond(p, { beta, stream: true }) }; },
  });
  return { seen, client: { messages: api(false), beta: { messages: api(true) } } };
}
const ok = (text, usage = {}, extra = {}) => ({ id: 'msg_1', _request_id: 'req_1', model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
  content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage }, ...extra });
const apiErr = (status, message, headers = {}) => Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message } }, undefined, new Headers({ 'request-id': 'req_err', ...headers }));

function setup(respond, { key = KEY } = {}) {
  const f = fakeClient(respond);
  kit.configureKit({ keyReader: async () => key, keyChecker: async () => !!key, clientFactory: k => { f.key = k; return f.client; }, now: () => NOW, fallbacks: true });
  return f;
}
const base = { tool: 'reviews', preset: 'review.normal', messages: [{ role: 'user', content: [{ type: 'text', text: 'diff', cache: true }] }], system: [{ text: 'rules', cache: true }, { text: 'design' }] };

beforeEach(() => { fs.rmSync(process.env.DECK_DATA, { recursive: true, force: true }); kit.resetKit(); });

test('request shape: preset model, effort, cache TTL, structured output, fallbacks, streaming above 16k', async () => {
  const f = setup(() => ok('{"verdict":"pass"}'));
  const r = await kit.call({ ...base, schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false } });
  const { p, beta, stream } = f.seen[0];
  assert.equal(p.model, 'claude-sonnet-5-5');
  assert.equal(p.max_tokens, 32000);
  assert.equal(stream, true, '32k max_tokens streams');
  assert.equal(beta, true);
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.fallbacks, 'default');
  assert.equal(p.output_config.effort, 'high');
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.deepEqual(p.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(p.system[1].cache_control, undefined, 'unmarked block stays uncached');
  assert.deepEqual(p.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal('cache' in p.system[0], false, 'the kit marker never reaches the API');
  assert.deepEqual(r.json, { verdict: 'pass' });
  assert.equal(f.key, KEY);
  // A preset without caching strips the markers; 4k does not stream.
  const g = setup(() => ok('{"real":true}'));
  await kit.call({ ...base, preset: 'review.verify' });
  assert.equal(g.seen[0].stream, false);
  assert.equal(g.seen[0].p.output_config.effort, 'low');
  assert.equal(g.seen[0].p.system[0].cache_control, undefined);
});

test('ledger: one line per call with tokens and cost, never the key', async () => {
  setup(() => ok('x', { input_tokens: 10000, output_tokens: 2000, cache_creation_input_tokens: 50000, cache_read_input_tokens: 40000 }));
  const r = await kit.call({ ...base, ref: 'perdix#334@abc' });
  // Sonnet 5.5, 1h writes: 10k*2 + 50k*4 + 40k*0.2 + 2k*10 = 20000+200000+8000+20000 per 1e6
  assert.equal(r.costUsd, 0.248);
  const [line] = readCalls();
  for (const k of ['ts', 'tool', 'preset', 'model', 'request_id', 'input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens', 'cost_usd'])
    assert.ok(k in line, `ledger has ${k}`);
  assert.equal(line.cost_usd, 0.248);
  assert.equal(line.ref, 'perdix#334@abc');
  assert.equal(line.request_id, 'req_1');
  assert.ok(!fs.readFileSync(ledgerFile(), 'utf8').includes(KEY), 'the key is never written');
});

test('cost: cache writes priced by the TTL breakdown when the API reports one', () => {
  const u = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 2e6, cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 } };
  assert.equal(costOf(u, 'claude-opus-5-5', '1h'), 5 + 8);
  assert.equal(costOf({ input_tokens: 1e6, output_tokens: 1e6 }, 'claude-opus-5-5'), 24);
  assert.equal(costOf({ cache_read_input_tokens: 1e6 }, 'claude-sonnet-5-5'), 0.2);
});

function seedSpend(tool, usd, ts = NOW) {
  fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
  fs.appendFileSync(ledgerFile(), JSON.stringify({ ts, tool, preset: 'x', cost_usd: usd }) + '\n');
}

test('caps: a spent tool budget refuses before any request, other tools and months unaffected', async () => {
  seedSpend('reviews', 40);
  seedSpend('modlab', 3, Date.UTC(2026, 8, 30)); // last month does not count
  const f = setup(() => ok('x'));
  await assert.rejects(kit.call(base), e => e.kind === 'BudgetExhausted' && /until the 1st/.test(e.message));
  assert.equal(f.seen.length, 0, 'no request was sent');
  await kit.call({ ...base, tool: 'modlab', preset: 'modlab.crash' });
  assert.equal(f.seen.length, 1, 'modlab still has budget');
  const s = kit.spendSummary({ now: NOW });
  assert.equal(s.levels.reviews, 'out');
  assert.equal(s.month, monthOf(NOW));
});

test('caps: the total cap refuses even with tool budget left', async () => {
  seedSpend('reviews', 30); seedSpend('modlab', 9); seedSpend('emoton', 51);
  const f = setup(() => ok('x'));
  await assert.rejects(kit.call({ ...base, tool: 'modlab', preset: 'modlab.crash' }), e => e.kind === 'BudgetExhausted' && /all tools/.test(e.message));
  assert.equal(f.seen.length, 0);
});

test('caps: warn levels at 50% and 80%', () => {
  seedSpend('reviews', 20);
  assert.equal(kit.spendSummary({ now: NOW }).levels.reviews, 'warn50');
  seedSpend('reviews', 12.5);
  assert.equal(kit.spendSummary({ now: NOW }).levels.reviews, 'warn80');
  assert.equal(kit.spendSummary({ now: NOW }).levels.modlab, 'ok');
});

test('no key: AuthMissing, nothing sent', async () => {
  const f = setup(() => ok('x'), { key: null });
  await assert.rejects(kit.call(base), e => e.kind === 'AuthMissing' && /deck-anthropic-reviews/.test(e.message));
  assert.equal(f.seen.length, 0);
});

test('errors map to the concept table and are logged without secrets', async () => {
  const cases = [
    [apiErr(402, 'billing problem'), 'CreditsOut'],
    [apiErr(400, 'Your credit balance is too low to access the Anthropic API.'), 'CreditsOut'],
    [apiErr(400, 'You have reached your specified workspace API usage limits.'), 'CreditsOut'],
    [apiErr(400, 'messages: roles must alternate'), 'BadRequest'],
    [apiErr(429, 'slow down', { 'retry-after': '17' }), 'RateLimited'],
    [apiErr(429, 'monthly cap'), 'CreditsOut'],
    [apiErr(529, 'Overloaded'), 'Overloaded'],
    [apiErr(500, 'boom'), 'Overloaded'],
    [apiErr(401, 'invalid x-api-key'), 'AuthMissing'],
    [new Anthropic.APIConnectionError({ message: 'Connection error.' }), 'Overloaded'],
  ];
  for (const [err, kind] of cases) {
    setup(() => { throw err; });
    await assert.rejects(kit.call(base), e => e.kind === kind, `${err.message} -> ${kind}`);
  }
  assert.equal(classify(apiErr(429, 'x', { 'retry-after': '17' })).retryAfterS, 17);
  const lines = readCalls();
  assert.equal(lines.length, cases.length);
  assert.ok(lines.every(l => l.ok === false && l.cost_usd === 0));
  assert.ok(!fs.readFileSync(ledgerFile(), 'utf8').includes(KEY));
});

test('credits out raises the banner; the next good call clears it', async () => {
  setup(() => { throw apiErr(402, 'billing'); });
  await assert.rejects(kit.call(base));
  assert.ok((await kit.status()).creditsOut, 'banner set');
  setup(() => ok('x'));
  await kit.call(base);
  assert.equal((await kit.status()).creditsOut, null, 'banner cleared');
});

test('fallback beta not enabled: retried once without it, then off for the process', async () => {
  let n = 0;
  const f = setup(p => { n++; if (p.betas) throw apiErr(400, 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.'); return ok('x'); });
  await kit.call(base);
  assert.equal(n, 2);
  assert.equal(f.seen[1].beta, false);
  assert.equal(readCalls()[0].fallbacks, 'off');
  await kit.call(base);
  assert.equal(f.seen.length, 3);
  assert.equal(f.seen[2].p.betas, undefined, 'stays off');
});

test('refusal: logged with its cost, raised as Refused', async () => {
  setup(() => ok('', { input_tokens: 1000, output_tokens: 0 }, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }));
  await assert.rejects(kit.call(base), e => e.kind === 'Refused' && e.category === 'cyber');
  assert.equal(readCalls()[0].ok, false);
  assert.ok(readCalls()[0].cost_usd > 0);
});

test('structured output: unparsable or truncated JSON is a BadRequest', async () => {
  const schema = { type: 'object', properties: {}, additionalProperties: false };
  setup(() => ok('{not json'));
  await assert.rejects(kit.call({ ...base, schema }), e => e.kind === 'BadRequest' && /did not parse/.test(e.message));
  setup(() => ok('{"a":', {}, { stop_reason: 'max_tokens' }));
  await assert.rejects(kit.call({ ...base, schema }), e => e.kind === 'BadRequest' && /max_tokens/.test(e.message));
});

test('more than four cache breakpoints is refused locally', async () => {
  const f = setup(() => ok('x'));
  const system = Array.from({ length: 5 }, (_, i) => ({ text: 'b' + i, cache: true }));
  await assert.rejects(kit.call({ ...base, system }), e => e.kind === 'BadRequest' && /breakpoints/.test(e.message));
  assert.equal(f.seen.length, 0);
});

test('status: key presence without reading, the presets with prices', async () => {
  setup(() => ok('x'));
  const s = await kit.status();
  assert.deepEqual(s.keys, { reviews: 'present', modlab: 'present' });
  assert.equal(s.keychain.reviews.service, 'deck-anthropic-reviews');
  assert.ok(s.presets.find(p => p.id === 'review.risky').model === 'claude-opus-5-5');
  assert.ok(!JSON.stringify(s).includes(KEY));
});

test('the real Keychain: a missing item reads as missing (no prompt, no secret)', async () => {
  const { hasKey, readKey } = await import('../../lib/claude/keys.mjs');
  const { TOOLS } = await import('../../lib/claude/presets.mjs');
  TOOLS.selftest = { service: 'deck-anthropic-selftest-does-not-exist', label: 'x' };
  try {
    assert.equal(await hasKey('selftest'), false);
    assert.equal(await readKey('selftest'), null);
  } finally { delete TOOLS.selftest; }
});

test('a failed ledger write does not hide the API result', async () => {
  setup(() => ok('{"a":1}'));
  fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
  fs.mkdirSync(ledgerFile()); // a directory where the ledger file should be: appends fail
  const r = await kit.call({ ...base, schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false } });
  assert.deepEqual(r.json, { a: 1 });
  setup(() => { throw apiErr(529, 'Overloaded'); });
  await assert.rejects(kit.call(base), e => e.kind === 'Overloaded');
});

test('a local failure is re-raised as it is, never as an API kind', async () => {
  setup(() => { throw new TypeError("Cannot read properties of undefined (reading 'stream')"); });
  await assert.rejects(kit.call(base), e => e instanceof TypeError && e.kind === undefined);
  const [line] = readCalls();
  assert.equal(line.error, 'Internal');
  assert.equal(line.cost_usd, 0);
});

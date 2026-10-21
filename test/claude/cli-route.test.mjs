import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cli-route-'));
process.env.DECK_DATA = path.join(tmp, 'data');
process.env.DECK_VAULT = path.join(tmp, 'vault');
const { setDeckRoot } = await import('../../lib/core/paths.mjs');
setDeckRoot(path.join(tmp, 'root'));
const { cliArgs, callCli, classifyCli, cliStatus, resetCliStatus, cliInstalled, UNSET, ISOLATION_ENV, newestClaude, resetNewestClaude, parseVersion } = await import('../../lib/claude/cli-route.mjs');
const { whichAll } = await import('../../lib/core/env.mjs');
const kit = await import('../../lib/claude/index.mjs');
const { readCalls, setCreditsOut } = await import('../../lib/claude/ledger.mjs');
const { run } = await import('../../lib/core/proc.mjs');
const { PRESETS } = await import('../../lib/claude/presets.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 9, 20, 12);
const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };
const base = { tool: 'reviews', preset: 'review.normal', system: [{ text: 'rules', cache: true }, { text: 'design' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'the diff', cache: true }] }] };

// What `claude -p --output-format json` prints (shape read off the CLI, 2026-10-20).
const answer = (over = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: '{"verdict":"pass"}',
  stop_reason: 'end_turn', session_id: 'sess-1', total_cost_usd: 0.0123,
  usage: { input_tokens: 900, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  modelUsage: { 'claude-sonnet-5-5': {} }, structured_output: { verdict: 'pass' }, ...over,
});
function fakeRunner(reply) {
  const seen = [];
  const runner = async (args, opts) => {
    seen.push({ args, opts, cwdExisted: fs.existsSync(opts.cwd), cwdEntries: fs.readdirSync(opts.cwd) });
    return typeof reply === 'function' ? reply(args, opts) : { code: 0, stdout: reply, stderr: '' };
  };
  runner.seen = seen;
  return runner;
}

beforeEach(() => { fs.rmSync(process.env.DECK_DATA, { recursive: true, force: true }); kit.resetKit(); resetCliStatus(); });

test('cli args: no tools, no MCP servers, no slash commands, no saved session, the preset\'s model and effort', () => {
  const a = cliArgs({ model: 'claude-sonnet-5-5', effort: 'high', system: 'SYS', schema: SCHEMA });
  const after = flag => a[a.indexOf(flag) + 1];
  assert.equal(a[0], '-p');
  assert.equal(after('--model'), 'claude-sonnet-5-5');
  assert.equal(after('--effort'), 'high');
  assert.equal(after('--output-format'), 'json');
  assert.deepEqual(JSON.parse(after('--json-schema')), SCHEMA);
  assert.equal(after('--tools'), '', 'every built-in tool off');
  for (const f of ['--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(a.includes(f), f);
  assert.equal(after('--system-prompt'), 'SYS');
  assert.ok(!a.some(x => /dangerously|bypass/i.test(x)), 'never skips permissions');
  assert.ok(!cliArgs({ model: 'm', effort: 'low', system: '' }).includes('--json-schema'));
});

test('callCli: prompt on stdin, ANTHROPIC_* unset, a fresh empty folder that is gone afterwards', async () => {
  const runner = fakeRunner(answer());
  const r = await callCli({ preset: PRESETS['review.normal'], system: base.system, messages: base.messages, schema: SCHEMA }, { runner });
  const [{ args, opts, cwdExisted, cwdEntries }] = runner.seen;
  assert.equal(opts.input, 'the diff');
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'rules\n\ndesign');
  assert.deepEqual([...opts.unset].sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
  assert.deepEqual(opts.env, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, 'auto memory off: no vault, no memory in a review');
  assert.deepEqual(ISOLATION_ENV, opts.env);
  assert.ok(cwdExisted && cwdEntries.length === 0, 'an empty folder while it runs');
  assert.ok(!fs.existsSync(opts.cwd), 'deleted afterwards');
  assert.ok(opts.timeoutMs > 0);
  assert.deepEqual(r.json, { verdict: 'pass' });
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.equal(r.estUsd, 0.0123);
  assert.equal(r.sessionId, 'sess-1');
});

test('callCli: JSON from the result text when there is no structured_output; the folder goes even on failure', async () => {
  const fenced = fakeRunner(answer({ structured_output: undefined, result: '```json\n{"verdict":"blocked"}\n```' }));
  assert.deepEqual((await callCli({ preset: PRESETS['review.normal'], messages: base.messages, schema: SCHEMA }, { runner: fenced })).json, { verdict: 'blocked' });
  const bad = fakeRunner(answer({ structured_output: undefined, result: 'not json' }));
  await assert.rejects(callCli({ preset: PRESETS['review.normal'], messages: base.messages, schema: SCHEMA }, { runner: bad }), e => e.kind === 'BadRequest' && /did not parse/.test(e.message));
  assert.ok(!fs.existsSync(bad.seen[0].opts.cwd));
});

test('callCli: failures map to the kit\'s kinds', async () => {
  const p = PRESETS['review.normal'];
  const kind = async reply => { try { await callCli({ preset: p, messages: base.messages }, { runner: fakeRunner(reply) }); return 'no error'; } catch (e) { return `${e.kind}: ${e.message}`; } };
  assert.match(await kind(answer({ is_error: true, result: 'Not logged in · Please run /login' })), /^AuthMissing: .*claude auth login/);
  assert.match(await kind(answer({ is_error: true, result: 'Claude usage limit reached. Your limit will reset at 5pm' })), /^PlanLimit/);
  assert.match(await kind(answer({ is_error: true, api_error_status: 400, result: "API Error: 400 Claude Code 2.1.195 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again." })), /^CliOutdated: the claude CLI is too old for this model \(run `claude update`\)/);
  assert.match(await kind(answer({ is_error: true, api_error_status: 429, result: 'error' })), /^PlanLimit/);
  assert.match(await kind(answer({ is_error: true, api_error_status: 529, result: 'Overloaded' })), /^Overloaded/);
  assert.match(await kind(answer({ is_error: true, result: 'something else' })), /^BadRequest: something else/);
  assert.match(await kind(answer({ stop_reason: 'refusal' })), /^Refused/);
  assert.match(await kind(() => ({ code: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) })), /^AuthMissing: the claude CLI is not installed/);
  assert.match(await kind(() => ({ code: null, stdout: '', stderr: '', timedOut: true })), /^Overloaded: .*longer than/);
  assert.match(await kind(() => ({ code: 1, stdout: 'Error: strict mode', stderr: '\x1b[31mbad schema\x1b[0m' })), /^BadRequest: claude exited 1: bad schema/);
  await assert.rejects(callCli({ preset: p, messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }, { runner: fakeRunner(answer()) }), /text only/);
  await assert.rejects(callCli({ preset: p, messages: [...base.messages, { role: 'assistant', content: 'x' }] }, { runner: fakeRunner(answer()) }), /one user message/);
  assert.equal(classifyCli('', null).kind, 'BadRequest');
});

test('run(): unset removes inherited variables, env still adds', async () => {
  process.env.DECK_TEST_GONE = 'secret';
  try {
    const r = await run('/usr/bin/env', [], { env: { DECK_TEST_KEEP: '1' }, unset: ['DECK_TEST_GONE'] });
    assert.match(r.stdout, /^DECK_TEST_KEEP=1$/m);
    assert.doesNotMatch(r.stdout, /DECK_TEST_GONE/);
    assert.match((await run('/usr/bin/env', [])).stdout, /^DECK_TEST_GONE=secret$/m, 'only when asked');
  } finally { delete process.env.DECK_TEST_GONE; }
  assert.deepEqual(UNSET.slice().sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
});

test('DECK_CLI=off turns the CLI route off (the test suite runs with it)', () => {
  const saved = process.env.DECK_CLI;
  try {
    process.env.DECK_CLI = 'off';
    assert.equal(cliInstalled(), false);
  } finally { if (saved === undefined) delete process.env.DECK_CLI; else process.env.DECK_CLI = saved; }
});

test('cliStatus: installed, logged in and the plan type, never the account\'s email or organisation', async () => {
  const runner = async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'a@b.c', orgId: 'o', orgName: 'Org', subscriptionType: 'max' }) });
  const s = await cliStatus({ runner, installed: () => true, newest: async () => null, now: NOW });
  assert.deepEqual(s, { installed: true, loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', version: null, path: null });
  assert.doesNotMatch(JSON.stringify(s), /@|Org/);
  resetCliStatus();
  assert.deepEqual(await cliStatus({ runner, installed: () => false, now: NOW }), { installed: false, loggedIn: false });
  resetCliStatus();
});

// The kit's route choice, with a fake API client and a fake CLI.
function routes({ key = 'sk-ant-test-NEVER-WRITE-ME', cli = true, api = () => ({ id: 'msg_1', _request_id: 'req_1', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"verdict":"pass"}' }], usage: { input_tokens: 1000, output_tokens: 100 } }) } = {}) {
  const sent = { api: 0, cli: 0 };
  const client = { messages: { create: async () => { sent.api++; return api(); }, stream: () => ({ finalMessage: async () => { sent.api++; return api(); } }) } };
  client.beta = client;
  kit.configureKit({
    keyReader: async () => key, keyChecker: async () => !!key, clientFactory: () => client, now: () => NOW, fallbacks: false,
    cliAvailable: () => cli,
    cliCaller: async () => { sent.cli++; return { text: '{"verdict":"pass"}', json: { verdict: 'pass' }, model: 'claude-sonnet-5-5', sessionId: 's', stopReason: 'end_turn', usage: { input_tokens: 700, output_tokens: 60 }, estUsd: 0.02 }; },
    cliStatus: async () => ({ installed: cli, loggedIn: cli }),
  });
  return sent;
}

test('route auto: the API with a key and money left; the CLI without a key; neither is an AuthMissing naming both', async () => {
  let sent = routes();
  assert.equal((await kit.call({ ...base, schema: SCHEMA })).route, 'api');
  assert.deepEqual(sent, { api: 1, cli: 0 });
  sent = routes({ key: null });
  const r = await kit.call({ ...base, schema: SCHEMA });
  assert.equal(r.route, 'cli');
  assert.equal(r.costUsd, 0);
  assert.equal(r.estUsd, 0.02);
  assert.deepEqual(sent, { api: 0, cli: 1 });
  routes({ key: null, cli: false });
  await assert.rejects(kit.call(base), e => e.kind === 'AuthMissing' && /no claude CLI/.test(e.message));
});

test('route auto: spent caps or a credits-out month go to the CLI; without one, the old refusals stand', async () => {
  fs.mkdirSync(process.env.DECK_DATA, { recursive: true });
  fs.writeFileSync(path.join(process.env.DECK_DATA, 'claude-ledger.jsonl'), JSON.stringify({ ts: NOW, tool: 'reviews', cost_usd: 40 }) + '\n');
  let sent = routes();
  assert.equal((await kit.call(base)).route, 'cli', 'reviews cap spent');
  assert.deepEqual(sent, { api: 0, cli: 1 });
  routes({ cli: false });
  await assert.rejects(kit.call(base), e => e.kind === 'BudgetExhausted');
  fs.rmSync(path.join(process.env.DECK_DATA, 'claude-ledger.jsonl'));
  setCreditsOut({ ts: NOW, tool: 'reviews', message: 'out' });
  sent = routes();
  assert.equal((await kit.call(base)).route, 'cli', 'credits out this month: no API call to fail');
  assert.equal(sent.api, 0);
  sent = routes({ cli: false });
  assert.equal((await kit.call(base)).route, 'api', 'no CLI: the API is tried as before');
});

test('route auto: credits running out during the call fall through to the CLI in the same call', async () => {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const sent = routes({ api: () => { throw Anthropic.APIError.generate(402, { type: 'error', error: { type: 'billing', message: 'credit balance too low' } }, undefined, new Headers()); } });
  const r = await kit.call(base);
  assert.equal(r.route, 'cli');
  assert.deepEqual(sent, { api: 1, cli: 1 });
  assert.deepEqual(readCalls().map(c => [c.route, c.ok, c.error || null]), [['api', false, 'CreditsOut'], ['cli', true, null]]);
});

test('route api and route cli: only that route', async () => {
  fs.mkdirSync(path.join(tmp, 'root'), { recursive: true });
  const write = route => fs.writeFileSync(path.join(tmp, 'root', 'state.json'), JSON.stringify({ claude: { route } }));
  try {
    write('api');
    routes({ key: null });
    await assert.rejects(kit.call(base), e => e.kind === 'AuthMissing' && !/CLI/.test(e.message));
    write('cli');
    const sent = routes();
    assert.equal((await kit.call(base)).route, 'cli');
    assert.deepEqual(sent, { api: 0, cli: 1 });
    write('nonsense');
    assert.equal(kit.routeSetting(), 'auto');
  } finally { fs.rmSync(path.join(tmp, 'root', 'state.json'), { force: true }); }
});

test('ledger: a CLI line says its route, costs 0 against the caps, and keeps the estimate', async () => {
  routes({ key: null });
  await kit.call({ ...base, ref: 'perdix#7@abc' });
  const [line] = readCalls();
  assert.equal(line.route, 'cli');
  assert.equal(line.cost_usd, 0);
  assert.equal(line.est_usd, 0.02);
  assert.equal(line.input_tokens, 700);
  assert.equal(line.ref, 'perdix#7@abc');
  assert.equal(kit.spendSummary({ now: NOW }).total, 0);
});

test('a local failure on the CLI route is re-raised without a kind, as on the API route', async () => {
  routes({ key: null });
  kit.configureKit({ cliCaller: async () => { throw new TypeError('bug'); } });
  await assert.rejects(kit.call(base), e => e instanceof TypeError && e.kind === undefined);
  assert.equal(readCalls()[0].error, 'Internal');
});

test('status: the route and the CLI\'s state, nothing about the account', async () => {
  routes({ key: null });
  const s = await kit.status();
  assert.equal(s.route, 'auto');
  assert.deepEqual(s.cli, { installed: true, loggedIn: true });
});

test('the newest claude on the PATH is used, each real file once, and a broken one is skipped', async () => {
  const dirs = ['a', 'b', 'c'].map(n => fs.mkdtempSync(path.join(tmp, `bin-${n}-`)));
  for (const d of dirs.slice(0, 2)) { fs.writeFileSync(path.join(d, 'deck-test-cli'), '#!/bin/sh\n'); fs.chmodSync(path.join(d, 'deck-test-cli'), 0o755); }
  fs.symlinkSync(path.join(dirs[0], 'deck-test-cli'), path.join(dirs[2], 'deck-test-cli'));
  const saved = process.env.PATH;
  process.env.PATH = `${dirs[0]}:${dirs[2]}:${dirs[1]}:${saved}`;
  try { assert.deepEqual(whichAll('deck-test-cli'), [path.join(dirs[0], 'deck-test-cli'), path.join(dirs[1], 'deck-test-cli')], 'the symlink is the same file'); }
  finally { process.env.PATH = saved; }

  assert.deepEqual(parseVersion('2.1.205 (Claude Code)'), [2, 1, 205]);
  const versions = { '/x/old/claude': '2.1.195 (Claude Code)', '/x/new/claude': '2.1.205 (Claude Code)', '/x/broken/claude': null, '/x/newest/claude': '2.10.0 (Claude Code)' };
  const probe = async bin => (versions[bin] ? { code: 0, stdout: versions[bin] } : { code: 1, stdout: '' });
  resetNewestClaude();
  assert.deepEqual(await newestClaude({ candidates: ['/x/old/claude', '/x/broken/claude', '/x/new/claude'], probe, now: NOW }), { path: '/x/new/claude', version: '2.1.205' });
  assert.deepEqual(await newestClaude({ candidates: ['/x/newest/claude'], probe, now: NOW + 1000 }), { path: '/x/new/claude', version: '2.1.205' }, 'cached');
  assert.deepEqual(await newestClaude({ candidates: ['/x/newest/claude', '/x/new/claude'], probe, now: NOW + 601e3 }), { path: '/x/newest/claude', version: '2.10.0' }, 'compared as numbers after the cache expires');
  resetNewestClaude();
  assert.equal(await newestClaude({ candidates: [], probe, now: NOW }), null);
  resetNewestClaude();
});

test('cliStatus reports the version and where it is, with the home folder as ~', async () => {
  resetCliStatus();
  const runner = async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, subscriptionType: 'max' }) });
  const s = await cliStatus({ runner, installed: () => true, newest: async () => ({ path: path.join(os.homedir(), '.local', 'bin', 'claude'), version: '2.1.205' }), now: NOW });
  assert.equal(s.version, '2.1.205');
  assert.equal(s.path, '~/.local/bin/claude');
  resetCliStatus();
});


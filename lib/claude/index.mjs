// The Claude kit (concept § 1, contract § 4): the one place Deck calls Claude.
// Two routes: the API, with keys from the Keychain per tool, every call
// checked against the monthly caps first; and the claude CLI on the user's
// login (cli-route.mjs). state.json's claude.route picks: `auto` (the API when
// its key exists and neither the caps nor the credits are out, else the CLI),
// `api` or `cli`. Every call is written to the ledger with its route, and
// every failure becomes a ClaudeError with a `kind` the features branch on.
import Anthropic from '@anthropic-ai/sdk';
import { PRESETS, PRICES, TOOLS, STREAM_ABOVE, BASE_URL } from './presets.mjs';
import { ClaudeError, classify, KINDS } from './errors.mjs';
import { readKey, hasKey, keychainItem } from './keys.mjs';
import { appendCall, costOf, spendSummary, recentCalls, creditsOut, setCreditsOut } from './ledger.mjs';
import { callCli, cliInstalled, cliStatus } from './cli-route.mjs';
import { configSection } from '../core/config.mjs';
import { DEFAULTS as KIT_DEFAULTS } from './presets.mjs';

export { PRESETS, PRICES, TOOLS, KINDS, ClaudeError, spendSummary, recentCalls };

// Server-side refusal fallback: a declined request is re-run on the model
// Anthropic recommends for that refusal category, inside the same call.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const DEFAULT_DEPS = {
  keyReader: readKey,
  keyChecker: hasKey,
  // baseURL is pinned: desktop sessions set ANTHROPIC_BASE_URL, and authToken
  // is nulled so an ANTHROPIC_AUTH_TOKEN in the environment cannot ride along.
  clientFactory: apiKey => new Anthropic({ apiKey, authToken: null, baseURL: BASE_URL, maxRetries: 2 }),
  cliCaller: callCli,
  cliAvailable: cliInstalled,
  cliStatus,
  now: () => Date.now(),
};
const deps = { ...DEFAULT_DEPS };
let fallbacks = true;

// Tests swap in fakes; `fallbacks: false` starts with the beta turned off.
export function configureKit(over = {}) {
  const { fallbacks: fb, ...rest } = over;
  Object.assign(deps, rest);
  if (fb !== undefined) fallbacks = !!fb;
}
export function resetKit() { Object.assign(deps, DEFAULT_DEPS); fallbacks = true; }

function toBlocks(content, ttl, marks) {
  if (typeof content === 'string') return content;
  return content.map(block => {
    const { cache, ...rest } = block;
    const out = rest.type ? rest : { type: 'text', ...rest };
    if (cache && ttl) { marks.n++; out.cache_control = { type: 'ephemeral', ttl }; }
    return out;
  });
}

function buildParams({ preset, system = [], messages, schema }) {
  const p = PRESETS[preset];
  const marks = { n: 0 };
  const params = {
    model: p.model,
    max_tokens: p.maxTokens,
    system: toBlocks(system, p.cache, marks),
    messages: messages.map(m => ({ role: m.role, content: toBlocks(m.content, p.cache, marks) })),
    output_config: { effort: p.effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
  };
  if (!params.system.length) delete params.system;
  if (marks.n > 4) throw new ClaudeError('BadRequest', `${marks.n} cache breakpoints; the API allows 4`);
  return params;
}

async function send(client, params) {
  const api = params.betas ? client.beta.messages : client.messages;
  return params.max_tokens > STREAM_ABOVE ? api.stream(params).finalMessage() : api.create(params);
}

// A ledger write that fails (a full disk) must not replace the API's own
// answer or error with a filesystem one: the Console's workspace limit still
// caps real spend, so the call's outcome wins and the failure is logged.
function record(line) {
  try { appendCall(line); } catch (e) { console.error(`claude kit: ledger write failed: ${e.message}`); }
}
function marker(info) {
  try { setCreditsOut(info); } catch (e) { console.error(`claude kit: state write failed: ${e.message}`); }
}

function ledgerLine(base, extra) {
  return {
    ts: base.ts, tool: base.tool, preset: base.preset, model: base.model, ref: base.ref || null, route: base.route || 'api',
    request_id: null, message_id: null,
    input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
    cost_usd: 0, ...extra,
  };
}

export const ROUTES = ['auto', 'api', 'cli'];
export function routeSetting(state) {
  const r = configSection('claude', KIT_DEFAULTS, state).route;
  return ROUTES.includes(r) ? r : 'auto';
}

export async function call(opts) {
  const { tool, preset, state } = opts;
  if (!TOOLS[tool]) throw new ClaudeError('BadRequest', `unknown tool ${tool}`);
  const p = PRESETS[preset];
  if (!p) throw new ClaudeError('BadRequest', `unknown preset ${preset}`);
  if (!Array.isArray(opts.messages) || !opts.messages.length) throw new ClaudeError('BadRequest', 'no messages');

  const now = deps.now();
  const route = routeSetting(state);
  if (route === 'cli') return viaCli(opts, now);

  const spend = spendSummary({ now, state });
  const budgetOut = spend.byTool[tool] >= spend.caps[tool] || spend.total >= spend.caps.total;
  const budgetError = () => {
    const which = spend.total >= spend.caps.total ? `all tools ($${spend.total} of $${spend.caps.total})` : `${TOOLS[tool].label} ($${spend.byTool[tool]} of $${spend.caps[tool]})`;
    return new ClaudeError('BudgetExhausted', `budget out until the 1st: ${which} spent in ${spend.month}`);
  };
  const key = await deps.keyReader(tool);
  if (route === 'api') {
    if (budgetOut) throw budgetError();
    if (!key) throw new ClaudeError('AuthMissing', `no API key: the Keychain item ${TOOLS[tool].service} is missing`);
    return viaApi(opts, key, now);
  }

  // auto: the API while it can answer, else the CLI.
  const cli = deps.cliAvailable();
  if (key && !budgetOut && !(cli && creditsOut({ now }))) {
    try { return await viaApi(opts, key, now); }
    catch (e) {
      // Credits ran out, or the key was rejected, during this very call.
      if (cli && e instanceof ClaudeError && (e.kind === 'CreditsOut' || e.kind === 'AuthMissing')) return viaCli(opts, now);
      throw e;
    }
  }
  if (cli) return viaCli(opts, now);
  if (budgetOut) throw budgetError();
  throw new ClaudeError('AuthMissing', `no API key: the Keychain item ${TOOLS[tool].service} is missing, and no claude CLI`);
}

async function viaCli(opts, now) {
  const { tool, preset, ref, state } = opts;
  const p = PRESETS[preset];
  const base = { ts: now, tool, preset, model: p.model, ref, route: 'cli' };
  const started = Date.now();
  let r;
  try {
    r = await deps.cliCaller({ preset: p, system: opts.system, messages: opts.messages, schema: opts.schema });
  } catch (e) {
    // As on the API route, a local failure is re-raised without a kind, so no
    // feature records it as Claude's verdict.
    if (!(e instanceof ClaudeError)) {
      record(ledgerLine(base, { ok: false, error: 'Internal', message: String((e && e.message) || e).slice(0, 200), ms: Date.now() - started }));
      throw e;
    }
    record(ledgerLine(base, { ok: false, error: e.kind, message: e.message.slice(0, 200), ms: Date.now() - started }));
    throw e;
  }
  const usage = r.usage || {};
  // Not billed per call (the plan pays), so cost_usd stays 0 and the caps
  // never count it; est_usd is what the CLI says the call would have cost.
  record(ledgerLine({ ...base, model: r.model }, {
    ok: true, message_id: r.sessionId,
    input_tokens: usage.input_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cost_usd: 0, est_usd: r.estUsd, stop_reason: r.stopReason, ms: Date.now() - started,
  }));
  const after = spendSummary({ now, state });
  return {
    text: r.text, json: r.json, model: r.model, requestId: null, messageId: r.sessionId,
    stopReason: r.stopReason, usage, costUsd: 0, estUsd: r.estUsd, route: 'cli',
    budget: { level: after.levels[tool], spent: after.byTool[tool], cap: after.caps[tool], total: after.total },
  };
}

async function viaApi(opts, key, now) {
  const { tool, preset, ref, state } = opts;
  const p = PRESETS[preset];
  const params = buildParams(opts);
  if (fallbacks) { params.betas = [FALLBACK_BETA]; params.fallbacks = 'default'; }
  const base = { ts: now, tool, preset, model: p.model, ref, route: 'api' };
  const client = deps.clientFactory(key);
  const started = Date.now();

  let msg;
  try {
    try {
      msg = await send(client, params);
    } catch (e) {
      const c = classify(e);
      // An organisation without the fallback beta gets a 400 naming the header
      // or the field. Turn it off for this process and send the request plain.
      if (c.kind === 'BadRequest' && params.betas && /anthropic-beta|fallbacks/i.test(c.message)) {
        fallbacks = false;
        delete params.betas;
        delete params.fallbacks;
        msg = await send(client, params);
      } else throw e;
    }
  } catch (e) {
    // A local failure (a TypeError, a misused SDK) is not an answer from the
    // API. It is re-raised as it is, without a kind, so no feature records it
    // as the API's verdict (the review gate would let a head through on it).
    if (!(e instanceof ClaudeError) && !(e && e.status) && !(e instanceof Anthropic.APIConnectionError)) {
      record(ledgerLine(base, { ok: false, error: 'Internal', message: String((e && e.message) || e).slice(0, 200), ms: Date.now() - started }));
      throw e;
    }
    const c = classify(e);
    record(ledgerLine(base, { ok: false, error: c.kind, message: c.message.slice(0, 200), request_id: c.requestId || null, ms: Date.now() - started }));
    if (c.kind === 'CreditsOut') marker({ ts: now, tool, message: c.message });
    throw c;
  }

  const usage = msg.usage || {};
  const model = msg.model || p.model;
  const costUsd = costOf(usage, PRICES[model] ? model : p.model, p.cache);
  record(ledgerLine({ ...base, model }, {
    ok: msg.stop_reason !== 'refusal',
    request_id: msg._request_id || null, message_id: msg.id || null,
    input_tokens: usage.input_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cost_usd: costUsd, stop_reason: msg.stop_reason || null, ms: Date.now() - started,
    ...(params.fallbacks ? {} : { fallbacks: 'off' }),
  }));
  if (creditsOut({ now })) marker(null);

  if (msg.stop_reason === 'refusal') {
    const d = msg.stop_details || {};
    throw new ClaudeError('Refused', `declined by the model${d.category ? ` (${d.category})` : ''}`, { category: d.category || null, costUsd });
  }
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let json = null;
  if (opts.schema) {
    if (msg.stop_reason === 'max_tokens') throw new ClaudeError('BadRequest', `output cut at max_tokens (${p.maxTokens})`, { costUsd });
    try { json = JSON.parse(text); }
    catch { throw new ClaudeError('BadRequest', 'the structured output did not parse as JSON', { costUsd }); }
  }
  const after = spendSummary({ now, state });
  return {
    text, json, model, requestId: msg._request_id || null, messageId: msg.id || null,
    stopReason: msg.stop_reason, usage, costUsd, route: 'api',
    budget: { level: after.levels[tool], spent: after.byTool[tool], cap: after.caps[tool], total: after.total },
  };
}


// 'present' | 'missing'. Checks the item exists; never reads the secret.
export async function keyStatus(tool) { return (await deps.keyChecker(tool)) ? 'present' : 'missing'; }

export async function status({ state } = {}) {
  const keys = {};
  for (const t of Object.keys(TOOLS)) keys[t] = await keyStatus(t);
  return {
    route: routeSetting(state),
    cli: await deps.cliStatus(),
    keys,
    keychain: Object.fromEntries(Object.keys(TOOLS).map(t => [t, keychainItem(t)])),
    spend: spendSummary({ state }),
    creditsOut: creditsOut(),
    presets: Object.entries(PRESETS).map(([id, p]) => ({ id, ...p, price: PRICES[p.model] })),
    recent: recentCalls(50),
  };
}

export function register(router, ctx) {
  router.add('GET', '/api/claude/status', () => status({ state: ctx.getState() }));
}
export function start() {}
export async function stop() {}

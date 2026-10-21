// The kit's second route: one isolated `claude -p` call on the user's Claude
// Code login, for when there is no API key or the API's budget or credits are
// out. Every call runs with no tools (so the code under review cannot make it
// run anything), no MCP servers, no slash commands and no saved session, in a
// fresh empty folder that is deleted afterwards, and without ANTHROPIC_*
// variables, so it always uses the login: never an inherited key or proxy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../core/proc.mjs';
import { which, whichAll } from '../core/env.mjs';
import { tildify } from '../core/paths.mjs';
import { ClaudeError } from './errors.mjs';

export const UNSET = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
const TIMEOUT_MS = 15 * 60 * 1000;

// The CLI takes one prompt and one system prompt: text only.
function textOf(content) {
  if (typeof content === 'string') return content;
  return content.map(b => {
    if (b.type && b.type !== 'text') throw new ClaudeError('BadRequest', `the CLI route takes text only, not ${b.type}`);
    return b.text;
  }).join('\n\n');
}

export function cliArgs({ model, effort, system, schema }) {
  return [
    '-p', '--model', model, '--effort', effort, '--output-format', 'json',
    ...(schema ? ['--json-schema', JSON.stringify(schema)] : []),
    '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
    '--system-prompt', system,
  ];
}

const ANSI = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex
const clean = s => String(s || '').replace(ANSI, '').trim();

// An answer the CLI marked as an error, as one of the kit's kinds.
export function classifyCli(result, status) {
  const msg = clean(result).slice(0, 300) || 'the claude CLI reported an error';
  if (status === 401 || /log ?in|logged in|authenticat|oauth|invalid api key/i.test(msg))
    return new ClaudeError('AuthMissing', `${msg} (run \`claude auth login\` once in a terminal)`, { status });
  // An install too old for the preset's model: the code under review is not
  // at fault, so it is an availability problem, like a missing key.
  if (/does not support this model|or newer is required|claude update/i.test(msg))
    return new ClaudeError('CliOutdated', `the claude CLI is too old for this model (run \`claude update\`): ${msg}`, { status });
  if (status === 429 || /usage limit|limit reached|rate.?limit|too many requests|resets? (at|in)/i.test(msg))
    return new ClaudeError('PlanLimit', `the Claude plan's limit: ${msg}`, { status });
  if ((status && status >= 500) || /overloaded|timed? ?out|network|ECONN/i.test(msg))
    return new ClaudeError('Overloaded', msg, { status });
  return new ClaudeError('BadRequest', msg, { status });
}

export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };

// With several installs (a package manager's and the native installer's), the
// first one on the PATH can be the oldest, and an old CLI refuses newer models.
// Use the newest. Cached ten minutes, so a `claude update` is picked up.
let newestCache = null;
export async function newestClaude({ candidates = whichAll('claude'), probe = bin => run(bin, ['--version'], { timeoutMs: 10000, unset: UNSET }), now = Date.now() } = {}) {
  if (newestCache && now - newestCache.at < 600e3) return newestCache.value;
  let best = null;
  for (const bin of candidates) {
    const r = await probe(bin);
    const v = r && r.code === 0 ? parseVersion(r.stdout) : null;
    if (v && (!best || newer(v, best.v))) best = { path: bin, v };
  }
  const value = best ? { path: best.path, version: best.v.join('.') } : null;
  newestCache = { at: now, value };
  return value;
}
export function resetNewestClaude() { newestCache = null; }

const DEFAULT_RUNNER = async (args, opts) => {
  const c = await newestClaude();
  if (!c) return { code: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) };
  return run(c.path, args, opts);
};
const DEFAULT_RUNNER_STATUS = DEFAULT_RUNNER;

// DECK_CLI=off turns the CLI route off (the test suite always runs with it,
// so no test can spend a real plan's usage).
export const cliOff = () => /^(off|0|false|no)$/i.test(process.env.DECK_CLI || '');
export const cliInstalled = () => !cliOff() && !!which('claude');

// For the Claude page: installed, logged in, and the plan type. Never the
// account's email or organisation (pages get screenshotted). Cached a minute.
let statusCache = null;
export async function cliStatus({ runner = DEFAULT_RUNNER_STATUS, installed = cliInstalled, newest = () => newestClaude(), now = Date.now() } = {}) {
  if (statusCache && now - statusCache.at < 60e3) return statusCache.value;
  let value;
  if (!installed()) value = { installed: false, loggedIn: false };
  else {
    const r = await runner(['auth', 'status', '--json'], { timeoutMs: 15000, unset: UNSET });
    let a = {};
    try { a = JSON.parse(r.stdout); } catch {}
    const n = await newest();
    value = { installed: true, loggedIn: a.loggedIn === true, authMethod: a.authMethod || null, subscriptionType: a.subscriptionType || null,
      version: n ? n.version : null, path: n ? tildify(n.path) : null };
  }
  statusCache = { at: now, value };
  return value;
}
export function resetCliStatus() { statusCache = null; }


// Returns what the kit records and hands back; throws ClaudeError.
export async function callCli({ preset, system = '', messages, schema }, { runner = DEFAULT_RUNNER, timeoutMs = TIMEOUT_MS } = {}) {
  if (messages.length !== 1 || messages[0].role !== 'user') throw new ClaudeError('BadRequest', 'the CLI route takes one user message');
  const args = cliArgs({ model: preset.model, effort: preset.effort, system: textOf(system), schema });
  const prompt = textOf(messages[0].content);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-claude-'));
  let r;
  try { r = await runner(args, { cwd, input: prompt, timeoutMs, unset: UNSET }); }
  finally { fs.rmSync(cwd, { recursive: true, force: true }); }

  if (r.timedOut) throw new ClaudeError('Overloaded', `the claude CLI took longer than ${Math.round(timeoutMs / 60000)} min`);
  if (r.error) {
    if (r.error.code === 'ENOENT') throw new ClaudeError('AuthMissing', 'the claude CLI is not installed');
    throw new ClaudeError('BadRequest', `claude: ${r.error.message}`);
  }
  let out;
  try { out = JSON.parse(r.stdout); }
  catch { throw new ClaudeError('BadRequest', `claude exited ${r.code}: ${clean(r.stderr).slice(0, 200) || 'no JSON answer'}`); }
  if (out.is_error) throw classifyCli(out.result, out.api_error_status);
  if (out.stop_reason === 'refusal') throw new ClaudeError('Refused', 'declined by the model');

  const text = typeof out.result === 'string' ? out.result : '';
  let json = null;
  if (schema) {
    if (out.structured_output !== undefined && out.structured_output !== null) json = out.structured_output;
    else {
      try { json = JSON.parse(text.trim().replace(/^```(json)?\s*|\s*```$/g, '')); }
      catch { throw new ClaudeError('BadRequest', 'the structured output did not parse as JSON'); }
    }
  }
  return {
    text, json,
    model: Object.keys(out.modelUsage || {})[0] || preset.model,
    sessionId: out.session_id || null,
    stopReason: out.stop_reason || null,
    usage: out.usage || {},
    estUsd: Number(out.total_cost_usd) || 0,
  };
}

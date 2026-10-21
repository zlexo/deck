// The spend ledger: one JSON line per API call (concept § 1), the caps that
// are checked against it before every call, and the credits-out marker the
// panel shows as a banner.
import { dataPath } from '../core/paths.mjs';
import { appendJsonl, readJsonl, readJson, writeJsonAtomic } from '../core/files.mjs';
import { configSection } from '../core/config.mjs';
import { PRICES, DEFAULTS } from './presets.mjs';

export const ledgerFile = () => dataPath('claude-ledger.jsonl');
const stateFile = () => dataPath('claude-state.json');

export const monthOf = (ts = Date.now()) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// What a response cost. Cache writes are priced by TTL: the usage breaks them
// down when the API reports it; otherwise all writes are taken at the TTL the
// request asked for.
export function costOf(usage, model, ttl) {
  const p = PRICES[model];
  if (!p || !usage) return 0;
  const cc = usage.cache_creation || null;
  let w5 = cc ? cc.ephemeral_5m_input_tokens || 0 : null;
  let w1 = cc ? cc.ephemeral_1h_input_tokens || 0 : null;
  if (w5 === null) {
    const total = usage.cache_creation_input_tokens || 0;
    w5 = ttl === '1h' ? 0 : total;
    w1 = ttl === '1h' ? total : 0;
  }
  const usd = ((usage.input_tokens || 0) * p.input
    + w5 * p.cacheWrite5m + w1 * p.cacheWrite1h
    + (usage.cache_read_input_tokens || 0) * p.cacheRead
    + (usage.output_tokens || 0) * p.output) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

export function appendCall(line) { appendJsonl(ledgerFile(), line); }

export function readCalls() { return readJsonl(ledgerFile()); }

export function caps(state) { return configSection('claude', DEFAULTS, state).caps; }

const level = (spent, cap, warnAt) => {
  if (!(cap > 0)) return 'out';
  const f = spent / cap;
  return f >= 1 ? 'out' : f >= warnAt[1] ? 'warn80' : f >= warnAt[0] ? 'warn50' : 'ok';
};

export function spendSummary({ now = Date.now(), state } = {}) {
  const month = monthOf(now);
  const cfg = configSection('claude', DEFAULTS, state);
  const byTool = { reviews: 0, modlab: 0 };
  let total = 0, calls = 0;
  for (const c of readCalls()) {
    if (monthOf(c.ts) !== month) continue;
    const usd = Number(c.cost_usd) || 0;
    byTool[c.tool] = (byTool[c.tool] || 0) + usd;
    total += usd;
    calls++;
  }
  const round = v => Math.round(v * 1e4) / 1e4;
  for (const k of Object.keys(byTool)) byTool[k] = round(byTool[k]);
  total = round(total);
  const levels = { total: level(total, cfg.caps.total, cfg.warnAt) };
  for (const k of Object.keys(byTool)) levels[k] = level(byTool[k], cfg.caps[k], cfg.warnAt);
  return { month, byTool, total, calls, caps: cfg.caps, levels };
}

export function recentCalls(n = 50) { return readCalls().slice(-n).reverse(); }

// The last credits-out event, shown until a call succeeds again or the month turns.
export function creditsOut({ now = Date.now() } = {}) {
  const s = readJson(stateFile(), {}) || {};
  const c = s.creditsOut;
  return c && monthOf(c.ts) === monthOf(now) ? c : null;
}
export function setCreditsOut(info) {
  const s = readJson(stateFile(), {}) || {};
  s.creditsOut = info;
  writeJsonAtomic(stateFile(), s);
}

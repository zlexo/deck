// The seams Reviews reaches the world through: the Claude kit, gh, the clock,
// sleeping and the vault's daily note. Production uses the real ones; tests
// swap them with configureReviews() and never reach the API or GitHub.
//
// The kit is a namespace import read at call time: until the kit lands, its
// module exports no `call`, and a named import would fail to link the whole
// gateway.
import * as claudeKit from '../claude/index.mjs';
import { gh as realGh } from '../core/gh.mjs';
import { appendDaily } from '../core/vault.mjs';

export function sleep(ms, { unref = false, signal } = {}) {
  return new Promise(resolve => {
    if (signal && signal.aborted) return resolve(false);
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(true); }, Math.max(0, ms));
    if (unref && t.unref) t.unref();
    function onAbort() { clearTimeout(t); resolve(false); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

const defaults = () => ({
  kit: claudeKit,
  gh: realGh,
  now: () => Date.now(),
  sleep,
  appendDaily,
});

let current = defaults();

export function configureReviews(over = {}) {
  current = { ...defaults(), ...over };
  return current;
}

export function deps(over) { return over ? { ...current, ...over } : current; }

// The kit's call(), or an error that says why there is none. Not a kit error
// (no `kind`), so no record is written: a missing kit is a Deck bug, not a
// budget or API state the gate may wave through.
export function kitCall(d) {
  const call = d.kit && d.kit.call;
  if (typeof call !== 'function') throw new Error('the Claude kit is not available (lib/claude exports no call yet)');
  return call;
}

// The kit reads its caps from the state it is handed (the gateway's live
// copy); the CLI hands none and the kit reads state.json.
export async function kitSpend(d, state) {
  const f = d.kit && d.kit.spendSummary;
  if (typeof f !== 'function') return null;
  try { return (await f({ state })) || null; } catch { return null; }
}

export function presetModel(d, preset) {
  const p = d.kit && d.kit.PRESETS;
  return (p && p[preset] && p[preset].model) || null;
}

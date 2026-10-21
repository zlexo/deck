// Verification (concept § Reviews, contract § 6). Every finding is checked
// against the repository at the head commit before it counts:
//   (a) local and exact: the file exists, the lines exist, the quote matches
//       those lines; anything else moves to `dropped` with the reason;
//   (b) each blocker that survives goes to a second model told to disprove
//       it; "not real" demotes it to should_fix with the reason.
// Then the verdict is recomputed from what survived.
import { SEVERITIES } from './prompt.mjs';
import { splitLines } from './diff.mjs';

export const normalizeWs = s => String(s).replace(/\s+/g, ' ').trim();

// A quote copied with the review's line prefixes ("   12 |", "   12+|",
// "     -|") still counts, but only when every line carries one: a lone "x |"
// inside real code is never stripped.
const PREFIX = /^ *\d*[ +-]\|/;
export function stripLinePrefixes(quote) {
  const lines = String(quote).split('\n');
  const nonEmpty = lines.filter(l => l.trim());
  if (!nonEmpty.length || !nonEmpty.every(l => PREFIX.test(l))) return String(quote);
  return lines.map(l => l.replace(PREFIX, '')).join('\n');
}

// The quote rule. Whitespace is normalised on both sides (every run of spaces,
// tabs and newlines becomes one space), and the quote may be a fragment: it
// may start part way into the first cited line and end part way into the
// last. But it must span the range: start in the first cited line and end in
// the last (blank lines at either end of the range do not count). A short
// generic quote cannot anchor a wide range, and a range cannot be padded
// with lines the quote does not reach. And it must cover a real share of the
// cited text: at least 12 characters and a quarter of it (the whole of it when
// the cited text is shorter), so "a" or ";" cannot anchor a finding.
export const MIN_QUOTE = 12;
export function quoteMatches(lines, start, end, quote) {
  const seg = lines.slice(start - 1, end).map(normalizeWs).filter(Boolean);
  if (!seg.length) return { ok: false, reason: `lines ${start}-${end} are blank` };
  const q = normalizeWs(stripLinePrefixes(quote));
  if (!q) return { ok: false, reason: 'the quote is empty' };
  const joined = seg.join(' ');
  const need = Math.min(joined.length, Math.max(MIN_QUOTE, Math.ceil(joined.length / 4)));
  if (q.length < need) return { ok: false, reason: `the quote covers too little of lines ${start}-${end} (${q.length} of at least ${need} characters)` };
  const firstEnd = seg[0].length;
  const lastStart = joined.length - seg[seg.length - 1].length;
  let seen = false;
  for (let i = joined.indexOf(q); i !== -1; i = joined.indexOf(q, i + 1)) {
    seen = true;
    if (i < firstEnd && i + q.length > lastStart) return { ok: true };
  }
  return { ok: false, reason: seen ? `the quote does not span lines ${start}-${end}` : `the quote does not match lines ${start}-${end}` };
}

// Paths as findings cite them: "./x", "/x" and the diff's "b/x" all mean "x"
// when "x" exists. Anything climbing out of the repository is refused.
export function candidatePaths(file) {
  const s = String(file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!s || s.includes('\0') || s.split('/').includes('..')) return [];
  const out = [s];
  if (/^[ab]\//.test(s)) out.push(s.slice(2));
  return out;
}

function shapeError(f) {
  if (!f || typeof f !== 'object') return 'not an object';
  if (!SEVERITIES.includes(f.severity)) return `unknown severity ${JSON.stringify(f.severity)}`;
  if (typeof f.file !== 'string' || !f.file.trim()) return 'no file';
  if (!Number.isInteger(f.line_start) || !Number.isInteger(f.line_end)) return 'line numbers are not integers';
  if (typeof f.quote !== 'string') return 'no quote';
  return null;
}

// readFile(path) -> the file's text at the head commit, or null. Returns
// { kept, dropped }; every finding lands in exactly one of them.
export async function verifyLocal(findings, readFile) {
  const kept = [], dropped = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    const bad = shapeError(f);
    if (bad) { dropped.push({ finding: f, reason: `malformed finding: ${bad}` }); continue; }
    let file = null, text = null;
    for (const p of candidatePaths(f.file)) {
      text = await readFile(p);
      if (text != null) { file = p; break; }
    }
    if (text == null) { dropped.push({ finding: f, reason: `${f.file} does not exist at the head commit` }); continue; }
    const lines = splitLines(text);
    if (f.line_start < 1 || f.line_end < f.line_start || f.line_end > lines.length) {
      dropped.push({ finding: f, reason: `lines ${f.line_start}-${f.line_end} are out of range: ${file} has ${lines.length} lines at the head commit` });
      continue;
    }
    const m = quoteMatches(lines, f.line_start, f.line_end, f.quote);
    if (!m.ok) { dropped.push({ finding: f, reason: m.reason }); continue; }
    kept.push({
      severity: f.severity, file, line_start: f.line_start, line_end: f.line_end, quote: f.quote,
      problem: String(f.problem || ''), failure_scenario: String(f.failure_scenario || ''), suggestion: String(f.suggestion || ''),
      verify: null, demoted: null,
    });
  }
  return { kept, dropped };
}

// The contract's rule: blocked when a blocker survives, pass_with_notes when
// any finding survives, else pass. The model's own verdict is not consulted.
export function computeVerdict(findings) {
  if (findings.some(f => f.severity === 'blocker')) return 'blocked';
  return findings.length ? 'pass_with_notes' : 'pass';
}

export const openBlockers = record => (record && Array.isArray(record.findings) ? record.findings.filter(f => f.severity === 'blocker') : []);
export const isBlocked = record => !!record && (record.verdict === 'blocked' || openBlockers(record).length > 0);

// (b) The disprove pass, one call per surviving blocker. `ask(finding)`
// resolves to { real, why } or throws a kit error. A blocker the verifier
// could not judge stays a blocker, marked unverified: an outage must not
// turn a blocker into a pass. Once the budget, the credits or the key are
// gone, the remaining blockers are not sent at all.
const GIVE_UP = new Set(['BudgetExhausted', 'CreditsOut', 'PlanLimit', 'CliOutdated', 'AuthMissing']);
export async function verifyBlockers(findings, ask) {
  let stop = null;
  for (const f of findings) {
    if (f.severity !== 'blocker') continue;
    if (stop) { f.verify = { real: null, why: `not verified: ${stop}` }; continue; }
    let ans;
    try { ans = await ask(f); }
    catch (e) {
      if (!e || !e.kind) throw e;
      if (GIVE_UP.has(e.kind)) stop = e.kind;
      f.verify = { real: null, why: `not verified: ${e.kind}` };
      continue;
    }
    if (!ans || typeof ans.real !== 'boolean') { f.verify = { real: null, why: 'not verified: the verify pass gave no answer' }; continue; }
    const why = String(ans.why || '').trim();
    f.verify = { real: ans.real, why };
    if (!ans.real) {
      f.severity = 'should_fix';
      f.demoted = { from: 'blocker', reason: why || 'the verify pass found it not real' };
    }
  }
  return findings;
}

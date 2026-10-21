import { test } from 'node:test';
import assert from 'node:assert/strict';

const { verifyLocal, verifyBlockers, computeVerdict, quoteMatches, stripLinePrefixes, isBlocked } = await import('../../lib/reviews/verify.mjs');
const { REVIEW_SCHEMA, VERIFY_SCHEMA } = await import('../../lib/reviews/prompt.mjs');
const { KitError } = await import('./helpers.mjs');

const FILES = {
  'src/a.js': ['function f(x) {', '  if (x > 0) {', '    return x * 2;', '  }', '', '  return 0;', '}'].join('\n') + '\n',
  'docs/b.md': 'one\ntwo\n',
};
const read = async p => (p in FILES ? FILES[p] : null);
const F = over => ({ severity: 'should_fix', file: 'src/a.js', line_start: 3, line_end: 3, quote: 'return x * 2;', problem: 'p', failure_scenario: 's', suggestion: 'g', ...over });

test('verify: a finding on a file missing at the head is dropped', async () => {
  const { kept, dropped } = await verifyLocal([F({ file: 'src/gone.js' })], read);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /does not exist at the head commit/);
  assert.equal(dropped[0].finding.file, 'src/gone.js', 'the original finding is kept for the debug list');
});

test('verify: line ranges outside the file are dropped', async () => {
  for (const [s, e] of [[7, 8], [0, 1], [3, 2], [8, 8]]) {
    const { kept, dropped } = await verifyLocal([F({ line_start: s, line_end: e })], read);
    assert.equal(kept.length, 0, `${s}-${e} must not be kept`);
    assert.match(dropped[0].reason, /out of range: src\/a\.js has 7 lines/);
  }
  // The last real line is in range: a final newline does not add a line.
  const ok = await verifyLocal([F({ line_start: 7, line_end: 7, quote: '}' })], read);
  assert.equal(ok.kept.length, 1);
});

test('verify: a quote that does not match its lines is dropped', async () => {
  const { kept, dropped } = await verifyLocal([F({ quote: 'return x * 3;' })], read);
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /does not match lines 3-3/);
  const moved = await verifyLocal([F({ line_start: 6, line_end: 6 })], read);
  assert.equal(moved.kept.length, 0, 'real text cited at the wrong line is not a match');
});

test('verify: whitespace is normalised on both sides', async () => {
  const { kept } = await verifyLocal([F({ line_start: 2, line_end: 3, quote: 'if (x > 0) {\n\t return   x * 2;' })], read);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].file, 'src/a.js');
});

test('verify: a fragment must span the cited range, first line to last', () => {
  const L = FILES['src/a.js'].split('\n');
  assert.equal(quoteMatches(L, 2, 3, '(x > 0) {\n    return x').ok, true, 'part of the first and part of the last line');
  assert.equal(quoteMatches(L, 3, 3, 'return x * 2').ok, true, 'a fragment of a single cited line');
  // Too little of the cited text anchors nothing, the probe's shapes included.
  for (const tiny of ['x', ';', 'x * 2', ') {\n    return']) {
    const r = quoteMatches(L, tiny.includes('\n') ? 2 : 3, 3, tiny);
    assert.equal(r.ok, false, `quote ${JSON.stringify(tiny)} is too short to anchor a finding`);
  }
  assert.match(quoteMatches(L, 3, 3, 'x * 2').reason, /covers too little/);
  const wide = quoteMatches(L, 1, 7, 'if (x > 0) {\n    return x * 2;\n  }');
  assert.equal(wide.ok, false, 'a fragment of a middle line cannot anchor a wide range');
  assert.match(wide.reason, /does not span lines 1-7/);
  assert.equal(quoteMatches(L, 2, 3, 'if (x > 0) {').ok, false, 'stops before the last cited line');
  assert.equal(quoteMatches(L, 4, 6, '}\n\nreturn 0;').ok, true, 'a blank line inside the range is whitespace');
  assert.equal(quoteMatches(L, 5, 6, 'return 0;').ok, true, 'a blank line at the edge of the range does not count');
  assert.equal(quoteMatches(L, 5, 5, 'x').ok, false, 'blank lines anchor nothing');
  assert.equal(quoteMatches(L, 3, 3, '   ').ok, false, 'an empty quote anchors nothing');
});

test('verify: the review\'s line prefixes are tolerated only on every line', async () => {
  assert.equal(stripLinePrefixes('    2 |  if (x > 0) {\n    3+|    return x * 2;'), '  if (x > 0) {\n    return x * 2;');
  assert.equal(stripLinePrefixes('a |b'), 'a |b');
  assert.equal(stripLinePrefixes('    2 |x\nplain'), '    2 |x\nplain', 'mixed lines are left alone');
  const { kept } = await verifyLocal([F({ line_start: 2, line_end: 3, quote: '    2 |  if (x > 0) {\n    3+|    return x * 2;' })], read);
  assert.equal(kept.length, 1);
});

test('verify: paths in diff form resolve, paths out of the repo do not', async () => {
  const a = await verifyLocal([F({ file: 'b/src/a.js' }), F({ file: './src/a.js' }), F({ file: '/src/a.js' })], read);
  assert.equal(a.kept.length, 3);
  assert.ok(a.kept.every(f => f.file === 'src/a.js'));
  const b = await verifyLocal([F({ file: '../src/a.js' }), F({ file: 'src/../src/a.js' })], read);
  assert.equal(b.kept.length, 0);
});

test('verify: malformed findings are dropped, and every finding lands in exactly one list', async () => {
  const input = [F(), F({ severity: 'critical' }), F({ line_start: '3' }), F({ quote: 42 }), null, F({ file: 'nope' }), F({ quote: 'zzz' })];
  const { kept, dropped } = await verifyLocal(input, read);
  assert.equal(kept.length + dropped.length, input.length);
  assert.equal(kept.length, 1);
  assert.ok(dropped.slice(0, 4).every(d => /malformed finding/.test(d.reason)));
  assert.deepEqual(kept[0], { ...F(), verify: null, demoted: null });
});

test('verify pass: "not real" demotes a blocker to should_fix with the reason', async () => {
  const fs = [{ ...F({ severity: 'blocker' }) }, { ...F({ severity: 'blocker', line_start: 6, line_end: 6, quote: 'return 0;' }) }, { ...F({ severity: 'nit' }) }];
  const asked = [];
  await verifyBlockers(fs, async f => { asked.push(f.line_start); return f.line_start === 3 ? { real: false, why: 'line 2 guards it' } : { real: true, why: 'nothing guards line 6' }; });
  assert.deepEqual(asked, [3, 6], 'only blockers are sent');
  assert.equal(fs[0].severity, 'should_fix');
  assert.deepEqual(fs[0].demoted, { from: 'blocker', reason: 'line 2 guards it' });
  assert.deepEqual(fs[0].verify, { real: false, why: 'line 2 guards it' });
  assert.equal(fs[1].severity, 'blocker');
  assert.deepEqual(fs[1].verify, { real: true, why: 'nothing guards line 6' });
  assert.equal(fs[2].verify, undefined, 'a nit is not verified');
  assert.equal(computeVerdict(fs), 'blocked');
});

test('verify pass: a blocker the verifier cannot judge stays a blocker, and a dead budget stops the pass', async () => {
  const fs = [F({ severity: 'blocker' }), F({ severity: 'blocker' }), F({ severity: 'blocker' }), F({ severity: 'blocker' })];
  let n = 0;
  await verifyBlockers(fs, async () => {
    n++;
    if (n === 1) throw new KitError('Overloaded');
    if (n === 2) return { why: 'no boolean' };
    throw new KitError('BudgetExhausted');
  });
  assert.equal(n, 3, 'nothing is sent after the budget is gone');
  assert.ok(fs.every(f => f.severity === 'blocker'));
  assert.deepEqual(fs.map(f => f.verify.real), [null, null, null, null]);
  assert.match(fs[0].verify.why, /Overloaded/);
  assert.match(fs[3].verify.why, /BudgetExhausted/);
  await assert.rejects(verifyBlockers([F({ severity: 'blocker' })], async () => { throw new Error('a bug'); }), /a bug/, 'a non-kit error is not swallowed');
});

test('verdict: recomputed from what survived', () => {
  assert.equal(computeVerdict([]), 'pass');
  assert.equal(computeVerdict([F({ severity: 'nit' })]), 'pass_with_notes');
  assert.equal(computeVerdict([F({ severity: 'question' }), F({ severity: 'blocker' })]), 'blocked');
  assert.equal(isBlocked({ verdict: 'blocked', findings: [] }), true, 'an inconsistent record errs toward blocked');
  assert.equal(isBlocked({ verdict: 'pass', findings: [F({ severity: 'blocker' })] }), true);
  assert.equal(isBlocked({ verdict: 'pass_with_notes', findings: [F()] }), false);
});

test('schemas: closed objects, enums for the closed sets, no numeric or length constraints', () => {
  const banned = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern'];
  const walk = (s, where) => {
    if (!s || typeof s !== 'object') return;
    for (const k of banned) assert.ok(!(k in s), `${where} has ${k}`);
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false, `${where} must be closed`);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${where} requires every property`);
      for (const [k, v] of Object.entries(s.properties)) walk(v, `${where}.${k}`);
    }
    if (s.type === 'array') walk(s.items, `${where}[]`);
  };
  walk(REVIEW_SCHEMA, 'review');
  walk(VERIFY_SCHEMA, 'verify');
  assert.deepEqual(REVIEW_SCHEMA.properties.verdict.enum, ['pass', 'pass_with_notes', 'blocked']);
  assert.deepEqual(REVIEW_SCHEMA.properties.findings.items.properties.severity.enum, ['blocker', 'should_fix', 'nit', 'question']);
});

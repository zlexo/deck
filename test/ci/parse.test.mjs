import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './fixtures.mjs';

const tmp = setupEnv('deck-ci-parse-');
const { parseCiLocal, parseVitest, junitCounts, PARSERS } = await import('../../lib/ci/parse.mjs');
const { createLog } = await import('../../lib/ci/log.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('ci-local: the summary block, with the not-run-here continuation line', () => {
  const lines = [
    '== tidy', 'some output', 'passed: this is not the summary',
    '', '== summary',
    'passed: layering minecraft-files format build',
    'failed: tidy linux-warnings',
    "not run here: Linux (gcc), Linux (lavapipe) and Linux (ASan + UBSan) need Linux;",
    "              on macOS, 'ubsan' runs the UndefinedBehaviorSanitizer half.",
  ];
  assert.deepEqual(parseCiLocal(lines), {
    passed: ['layering', 'minecraft-files', 'format', 'build'],
    failed: ['tidy', 'linux-warnings'],
    notRunHere: "Linux (gcc), Linux (lavapipe) and Linux (ASan + UBSan) need Linux; on macOS, 'ubsan' runs the UndefinedBehaviorSanitizer half.",
  });
  assert.deepEqual(parseCiLocal(['== summary', 'passed: none', 'failed: none']).passed, []);
  assert.equal(parseCiLocal(['no summary here']), null);
});

test('vitest: the closing counts, failures and colours included', () => {
  assert.deepEqual(parseVitest([' Test Files  32 passed (32)', '      Tests  493 passed (493)', '   Duration  5.1s']), {
    files: { passed: 32, total: 32 }, tests: { passed: 493, total: 493 },
  });
  const red = ['\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m31 passed\x1b[39m\x1b[22m\x1b[90m (32)\x1b[39m',
    '      Tests  2 failed | 489 passed | 2 skipped (493)', '     Errors  1 error'];
  assert.deepEqual(parseVitest(red), {
    files: { failed: 1, passed: 31, total: 32 }, tests: { failed: 2, passed: 489, skipped: 2, total: 493 }, errors: 1,
  });
  assert.equal(parseVitest(['nothing']), null);
});

test('junit: counts every build/test-results folder, either layout, and never walks game test worlds', () => {
  const root = path.join(tmp, 'gradle');
  const suite = (file, attrs, body = '') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `<?xml version="1.0"?>\n<testsuite name="s" ${attrs}>\n${body}</testsuite>\n`);
  };
  suite(path.join(root, 'modules/a/build/test-results/test/TEST-a.xml'), 'tests="3" skipped="1" failures="0" errors="0"');
  suite(path.join(root, 'modules/b/versions/26.2/build/test-results/test/TEST-b.xml'), 'tests="2" skipped="0" failures="1" errors="0"',
    '<testcase name="ok" classname="me.B"/>\n<testcase name="breaks" classname="me.B" time="0.1">\n<failure message="x">boom</failure>\n</testcase>\n');
  // Not results: a world folder and a source folder.
  suite(path.join(root, 'modules/b/versions/26.2/run/build/test-results/TEST-world.xml'), 'tests="99" failures="99"');
  suite(path.join(root, 'modules/a/src/build/test-results/TEST-src.xml'), 'tests="50"');
  const c = junitCounts(root);
  assert.deepEqual({ ...c, failed: c.failed }, { suites: 2, tests: 5, failures: 1, errors: 0, skipped: 1, failed: ['me.B.breaks'], files: 2 });
});

test('gradle: game test verdicts, failed tasks, the build line and the API gate line', () => {
  const p = PARSERS.gradle();
  for (const l of [
    '> Task :modules:conduit-core:26.2:runGameTest',
    '[12:00:00] [Server thread/INFO] (Minecraft) All 23 required tests passed :)',
    '[12:00:09] [Server thread/INFO] (Minecraft) 2 required tests failed :(',
    '> Task :modules:conduit-world:26.2:runGameTest FAILED',
    'checkApiCompat: gating 11 module(s) at 0.31.0, baselines from mavenLocal then GitHub Packages',
    'checkApiCompat: per module, freshly built jar against the newest published version below it',
    'checkApiCompat: 11 module(s) compared, 0 skipped, no undeclared breaks',
    'BUILD FAILED in 7m 3s',
  ]) p.line(l);
  const s = p.finish({ dir: path.join(tmp, 'empty') });
  assert.deepEqual(s.gameTests, { runs: 2, passed: 23, failed: 2 });
  assert.deepEqual(s.failedTasks, [':modules:conduit-world:26.2:runGameTest']);
  assert.equal(s.build, 'FAILED in 7m 3s');
  assert.deepEqual(s.apiCompat, { gating: '11 module(s) at 0.31.0, baselines from mavenLocal then GitHub Packages', result: '11 module(s) compared, 0 skipped, no undeclared breaks' });
  assert.equal(s.junit.tests, 0);
});

test('log: lines matching the filter are counted, not written', () => {
  const f = path.join(tmp, 'logs', 'drop.log');
  const log = createLog(f, { dropLines: '\\[\\+\\+ \\]' });
  log.note('start');
  for (let i = 0; i < 1000; i++) log.line(`[++ ] progress ${i}`);
  log.line('a real line');
  log.close();
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(!text.includes('progress'));
  assert.ok(text.includes('a real line'));
  assert.match(text, /1000 lines matching .* were left out/);
});

test('log: past the cap nothing more is written except the last lines', () => {
  const f = path.join(tmp, 'logs', 'cap.log');
  const log = createLog(f, { maxBytes: 1000, keepTail: 5 });
  for (let i = 0; i < 500; i++) log.line(`line ${String(i).padStart(4, '0')} ${'x'.repeat(40)}`);
  log.note('exit 1');
  log.close();
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(Buffer.byteLength(text) < 2500, `the log is ${Buffer.byteLength(text)} bytes`);
  assert.ok(text.includes('line 0000'), 'the start is kept');
  assert.ok(text.includes('line 0499'), 'the end is kept');
  assert.ok(!text.includes('line 0300'), 'the middle is not');
  assert.match(text, /the log reached 0.0 MB: \d+ more lines/);
  assert.ok(text.includes('[deck] exit 1'), 'Deck\'s own lines are always written');
});

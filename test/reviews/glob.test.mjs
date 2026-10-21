import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_STATE } from '../fixtures/sample-config.mjs';

const { matchGlob, riskyPaths } = await import('../../lib/reviews/glob.mjs');
const { DEFAULTS } = await import('../../lib/reviews/config.mjs');

test('glob: * stays inside one segment', () => {
  assert.ok(matchGlob('app/src/world_loop*', 'app/src/world_loop.cpp'));
  assert.ok(matchGlob('app/src/world_loop*', 'app/src/world_loop_test.hpp'));
  assert.ok(!matchGlob('app/src/world_loop*', 'app/src/x/world_loop.cpp'));
  assert.ok(!matchGlob('app/src/world_loop*', 'app/src/world_loop/inner.cpp'), '* never crosses a slash');
  assert.ok(matchGlob('engine/world/src/*stream*', 'engine/world/src/streaming.cpp'));
  assert.ok(matchGlob('engine/world/src/*stream*', 'engine/world/src/world_stream.hpp'));
  assert.ok(!matchGlob('engine/world/src/*stream*', 'engine/world/include/streaming.hpp'));
  assert.ok(!matchGlob('*.cpp', 'a/b.cpp'));
});

test('glob: ** crosses segments, and **/ also matches none', () => {
  assert.ok(matchGlob('apps/payments/**', 'apps/payments/src/charge.ts'));
  assert.ok(matchGlob('apps/payments/**', 'apps/payments/x.ts'));
  assert.ok(!matchGlob('apps/payments/**', 'apps/payments'), 'the folder itself is not a file under it');
  assert.ok(!matchGlob('apps/payments/**', 'apps/payments-ui/x.ts'));
  assert.ok(!matchGlob('packages/db/**', 'packages/db-ledger/x.ts'), 'db/** is not db-ledger');
  assert.ok(matchGlob('a/**/b', 'a/b'));
  assert.ok(matchGlob('a/**/b', 'a/x/y/b'));
  assert.ok(matchGlob('**/job.cpp', 'job.cpp'));
  assert.ok(matchGlob('**/job.cpp', 'engine/core/job.cpp'));
});

test('glob: other characters are literal', () => {
  assert.ok(matchGlob('a.b/c+d', 'a.b/c+d'));
  assert.ok(!matchGlob('a.b', 'axb'), 'a dot is a dot');
  assert.ok(!matchGlob('a?', 'ab'), '? is not a wildcard');
  assert.ok(!matchGlob('src/[x]', 'src/x'));
});

test('glob: the sample setup\'s risk globs route the right files', () => {
  assert.deepEqual(DEFAULTS.repos, {}, 'no review rules built in');
  const { perdix, modplex, conduit } = SAMPLE_STATE.reviews.repos;
  assert.deepEqual(riskyPaths(['app/src/world_loop.cpp', 'app/src/main.cpp', 'engine/core/src/jobs.cpp', 'engine/render/src/gpu_arena.cpp', 'engine/render/src/staging_upload.cpp'], perdix.risk),
    ['app/src/world_loop.cpp', 'engine/core/src/jobs.cpp', 'engine/render/src/gpu_arena.cpp', 'engine/render/src/staging_upload.cpp']);
  assert.deepEqual(riskyPaths(['packages/db/src/a.ts', 'packages/db-ledger/b.ts', 'packages/ui/c.ts'], modplex.risk), ['packages/db/src/a.ts', 'packages/db-ledger/b.ts']);
  assert.deepEqual(riskyPaths(['modules/conduit-core/src/A.java', 'modules/conduit-arena/src/B.java'], conduit.risk), ['modules/conduit-core/src/A.java']);
  assert.deepEqual(riskyPaths(['x', 'x'], ['x']), ['x'], 'each path once');
  assert.deepEqual(riskyPaths(['x'], undefined), []);
});

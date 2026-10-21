// Which jobs run: build:runtime only when the head changes runtime/ against
// its merge base with origin/main; the changelog gate only for a pull request
// and not when it carries the no-changelog label.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv, makeRepo, stateFor, noGithub, sh, git } from './fixtures.mjs';
import { SAMPLE_STATE } from '../fixtures/sample-config.mjs';

const tmp = setupEnv('deck-ci-plan-');
const { createRunner } = await import('../../lib/ci/runner.mjs');
const { CI_DEFAULTS } = await import('../../lib/ci/defaults.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const repo = makeRepo(tmp, 'mp');
const runner = (jobs, github = noGithub) => {
  const state = stateFor({ mp: repo }, { mp: { timeoutMin: 1, jobs } });
  return createRunner({ getState: () => state, pollMs: 20, github });
};
async function runOnce(r, target) {
  const q = await r.enqueue({ repo: 'mp', ...target });
  const done = r.waitFor('mp', q.sha);
  r.start();
  return done;
}

test('build:runtime runs only when the head changes runtime/ against its merge base with origin/main', async () => {
  const jobs = [
    { name: 'build', cmd: sh('echo build') },
    { name: 'build:runtime', cmd: sh('echo runtime built'), onlyIfChanged: ['runtime/'] },
  ];
  // Two branches off main: one touches runtime/, one does not.
  repo.checkout('touches-runtime', 'main');
  const touches = repo.commit({ 'runtime/build.gradle': 'x\n' }, 'runtime change');
  repo.checkout('docs-only', 'main');
  const docs = repo.commit({ 'docs/a.md': 'a\n' }, 'docs change');
  // main moves on with a runtime/ change of its own after both branched: a
  // two-dot diff would charge it to docs-only.
  repo.checkout('main');
  repo.commit({ 'runtime/later.txt': 'later\n' }, 'main touches runtime later');
  repo.pushMain();

  const a = await runOnce(runner(jobs), { sha: touches });
  assert.equal(a.status, 'green');
  assert.deepEqual(a.jobs.map(j => j.status), ['green', 'green']);
  assert.ok(fs.readFileSync(a.jobs[1].log, 'utf8').includes('runtime built'));

  const b = await runOnce(runner(jobs), { sha: docs });
  assert.equal(b.status, 'green');
  assert.deepEqual(b.jobs.map(j => j.status), ['green', 'skipped']);
  assert.match(b.jobs[1].summary.reason, /no change under runtime\/ against its merge base with origin\/main/);

  // main itself: nothing differs from its own merge base.
  const m = await runOnce(runner(jobs), { ref: 'main' });
  assert.equal(m.ref, 'main');
  assert.equal(m.sha, git(repo.dir, 'rev-parse', 'main'));
  assert.equal(m.jobs[1].status, 'skipped');
});

test('when the comparison with main cannot be made, the run is an error, not a silent skip', async () => {
  const jobs = [{ name: 'build:runtime', cmd: sh('echo built'), onlyIfChanged: ['runtime/'] }];
  // An origin without main.
  const lone = makeRepo(tmp, 'lone');
  git(lone.origin, 'update-ref', '-d', 'refs/heads/main');
  const state = stateFor({ lone }, { lone: { timeoutMin: 1, jobs } });
  const r = createRunner({ getState: () => state, pollMs: 20, github: noGithub });
  const q = await r.enqueue({ repo: 'lone', sha: lone.main });
  const done = r.waitFor('lone', q.sha);
  r.start();
  const rec = await done;
  assert.equal(rec.status, 'error');
  assert.match(rec.error, /could not fetch main/);
});

test('the changelog gate: skipped for a pull request labelled no-changelog, run otherwise, and only for pull requests', async () => {
  const jobs = [{ name: 'changelog', cmd: sh('echo "base={base} head={sha}"; exit 1'), prOnly: true, skipLabel: 'no-changelog' }];
  repo.checkout('engine-change', 'main');
  const sha = repo.commit({ 'modules/x/src/main/A.java': 'class A {}\n' }, 'engine change');
  repo.checkout('main');
  repo.pushPr(7, sha);
  const mainSha = git(repo.dir, 'rev-parse', 'main');
  const asked = [];
  const github = labels => ({ ...noGithub, async prInfo(r, pr) { asked.push(pr); return { pr, labels, base: 'main' }; } });

  const labelled = await runOnce(runner(jobs, github(['no-changelog', 'other'])), { pr: 7 });
  assert.equal(labelled.pr, 7);
  assert.equal(labelled.ref, 'pull/7/head');
  assert.equal(labelled.sha, sha, 'the PR head was fetched from origin');
  assert.equal(labelled.status, 'green');
  assert.equal(labelled.jobs[0].status, 'skipped');
  assert.match(labelled.jobs[0].summary.reason, /carries the 'no-changelog' label/);

  const plain = await runOnce(runner(jobs, github(['other'])), { pr: 7 });
  assert.equal(plain.status, 'red', 'without the label the gate runs (and this one fails)');
  const log = fs.readFileSync(plain.jobs[0].log, 'utf8');
  assert.ok(log.includes(`base=${mainSha} head=${sha}`), `the gate compares the PR's base with its head:\n${log}`);
  assert.deepEqual(asked, [7, 7]);

  // Not a pull request: main, or a SHA no open PR has as its head.
  const onMain = await runOnce(runner(jobs, github(['other'])), { ref: 'main' });
  assert.equal(onMain.jobs[0].status, 'skipped');
  assert.match(onMain.jobs[0].summary.reason, /not a pull request/);

  // A SHA that is an open PR's head is that PR: its labels count.
  const bySha = { ...noGithub, async findPrForSha(r, s) { return s === sha ? { pr: 7, labels: ['no-changelog'], base: 'main' } : null; } };
  const viaSha = await runOnce(runner(jobs, bySha), { sha });
  assert.equal(viaSha.pr, 7);
  assert.equal(viaSha.jobs[0].status, 'skipped');
  assert.match(viaSha.jobs[0].summary.reason, /no-changelog/);
});

test('a full SHA the checkout lacks is fetched from origin by SHA; one origin lacks too is refused', async () => {
  // A commit pushed to origin from elsewhere: the checkout has never seen it.
  const other = path.join(tmp, 'elsewhere');
  git(tmp, 'clone', '-q', repo.origin, other);
  git(other, 'config', 'user.email', 'ci@test');
  git(other, 'config', 'user.name', 'ci test');
  fs.writeFileSync(path.join(other, 'remote-only.txt'), 'x\n');
  git(other, 'add', 'remote-only.txt');
  git(other, 'commit', '-qm', 'only on origin');
  const sha = git(other, 'rev-parse', 'HEAD');
  git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/elsewhere');
  assert.throws(() => git(repo.dir, 'cat-file', '-e', `${sha}^{commit}`), /./, 'the checkout does not have it yet');
  const refsBefore = git(repo.dir, 'for-each-ref', '--format=%(refname) %(objectname)');
  const rec = await runOnce(runner([{ name: 'ok', cmd: sh('test -f remote-only.txt') }]), { sha });
  assert.equal(rec.status, 'green');
  assert.equal(rec.sha, sha);
  assert.equal(git(repo.dir, 'for-each-ref', '--format=%(refname) %(objectname)'), refsBefore, 'no ref moved in the checkout');
  await assert.rejects(runner([{ name: 'ok', cmd: sh('true') }]).enqueue({ repo: 'mp', sha: 'e'.repeat(40) }), /no commit e{40}/);
});

test('a pull request whose labels cannot be read is an error, not a guess', async () => {
  const jobs = [{ name: 'changelog', cmd: sh('exit 0'), prOnly: true, skipLabel: 'no-changelog' }];
  repo.pushPr(8, repo.main);
  const rec = await runOnce(runner(jobs, { ...noGithub, async prInfo() { throw new Error('HTTP 502'); } }), { pr: 8 });
  assert.equal(rec.status, 'error');
  assert.match(rec.error, /could not read the pull request from GitHub: HTTP 502/);
});

test('no repo jobs are built in; the sample setup mirrors each repo\'s GitHub workflow', () => {
  assert.deepEqual(CI_DEFAULTS.repos, {});
  const r = SAMPLE_STATE.ci.repos;
  assert.deepEqual(r.perdix.jobs.map(j => j.name), ['ci-local']);
  assert.deepEqual(r.perdix.jobs[0].cmd, ['scripts/ci-local.sh']);
  assert.equal(r.perdix.jobs[0].env.JOBS, '3');
  assert.deepEqual(r.conduit.jobs.map(j => j.name), ['check', 'changelog']);
  assert.deepEqual(r.conduit.jobs[0].cmd, ['./gradlew', 'check', '--no-daemon', '--stacktrace']);
  assert.equal(r.conduit.jobs[0].githubToken, true);
  assert.deepEqual(r.conduit.jobs[1].cmd, ['scripts/check-changelog-unreleased.sh', '{base}', '{sha}']);
  assert.equal(r.conduit.jobs[1].skipLabel, 'no-changelog');
  assert.deepEqual(r.modplex.jobs.map(j => j.name), ['npm ci', 'build', 'typecheck', 'test:all', 'build:runtime']);
  assert.deepEqual(r.modplex.jobs[4].onlyIfChanged, ['runtime/']);
  assert.deepEqual([r.perdix.timeoutMin, r.conduit.timeoutMin, r.modplex.timeoutMin], [60, 45, 30]);
  assert.ok(new RegExp(r.conduit.jobs[0].dropLines).test('[++ ] 12/400 chunks'), 'the progress lines are dropped');
  assert.ok(!new RegExp(r.conduit.jobs[0].dropLines).test('> Task :modules:conduit-core:26.2:test FAILED'));
});

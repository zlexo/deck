import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv, makeRepo, stateFor, holdLock, until, git, noGithub, sh } from './fixtures.mjs';

const tmp = setupEnv('deck-ci-runner-');
const { createRunner, workDir, runLockName, repoPlan, logName } = await import('../../lib/ci/runner.mjs');
const { recordFor, ciRecordPath } = await import('../../lib/ci/records.mjs');
const { lockHolder } = await import('../../lib/core/lock.mjs');
const { isThrowawayDir } = await import('../../lib/core/git.mjs');
const { dataPath, isInside } = await import('../../lib/core/paths.mjs');
const { pidAlive } = await import('../../lib/core/proc.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const repo = makeRepo(tmp, 'fake');
let n = 0;
// A fresh head for each test, so records never collide.
const head = () => repo.commit({ [`f${++n}.txt`]: `${n}\n` }, `commit ${n}`);

function runnerWith(jobs, more = {}) {
  const state = stateFor({ fake: repo }, { fake: { timeoutMin: 1, jobs } });
  return createRunner({ getState: () => state, pollMs: 20, github: noGithub, ...more });
}
async function runOnce(runner, target) {
  const q = await runner.enqueue({ repo: 'fake', ...target });
  const done = runner.waitFor('fake', q.sha);
  runner.start();
  return done;
}
const noLocks = sha => ['ci', 'heavy', runLockName('fake', sha)].filter(l => lockHolder(l));

test('a run checks the exact head out under the data folder, runs the jobs in order there, never in the checkout, and removes it', async () => {
  const sha = head();
  const r = runnerWith([
    { name: 'first', cmd: sh('pwd; git rev-parse HEAD; echo made > marker.txt') },
    { name: 'second', cmd: sh('test -f marker.txt && echo second sees the marker') },
  ]);
  const rec = await runOnce(r, { sha });
  assert.equal(rec.status, 'green', JSON.stringify(rec));
  assert.deepEqual(rec.jobs.map(j => [j.name, j.status]), [['first', 'green'], ['second', 'green']]);
  const log = fs.readFileSync(rec.jobs[0].log, 'utf8');
  assert.ok(log.includes(`\n${workDir('fake', sha)}\n`), `ran in the throwaway worktree:\n${log}`);
  assert.ok(log.includes(`\n${sha}\n`), 'the exact head was checked out');
  assert.ok(isThrowawayDir(workDir('fake', sha)) && isInside(workDir('fake', sha), dataPath('ci', 'work')));
  // The live checkout saw nothing.
  assert.equal(fs.existsSync(path.join(repo.dir, 'marker.txt')), false);
  assert.equal(git(repo.dir, 'status', '--porcelain'), '');
  assert.equal(git(repo.dir, 'rev-parse', 'HEAD'), sha);
  // Removed afterwards, worktree metadata too.
  assert.equal(fs.existsSync(workDir('fake', sha)), false, 'worktree folder removed');
  assert.ok(!git(repo.dir, 'worktree', 'list').includes(workDir('fake', sha)), 'worktree pruned');
  assert.deepEqual(noLocks(sha), []);
  // The contract's shape, and the file holds the final record.
  assert.deepEqual(Object.keys(rec).sort(), ['durationMs', 'error', 'finishedAt', 'jobs', 'pr', 'ref', 'repo', 'sha', 'startedAt', 'status', 'v']);
  assert.deepEqual(Object.keys(rec.jobs[0]).sort(), ['cmd', 'durationMs', 'log', 'name', 'status', 'summary']);
  assert.equal(rec.v, 1);
  assert.equal(rec.error, null);
  assert.ok(rec.finishedAt >= rec.startedAt && rec.durationMs >= 0);
  assert.equal(rec.jobs[1].cmd, "bash -c 'test -f marker.txt && echo second sees the marker'");
  assert.ok(isInside(rec.jobs[0].log, dataPath('ci', 'fake', sha)));
  assert.deepEqual(recordFor('fake', sha), rec);
});

test('after a red job the rest are skipped, and the run is red', async () => {
  const sha = head();
  const r = runnerWith([
    { name: 'ok', cmd: sh('echo fine') },
    { name: 'fails', cmd: sh('echo broken >&2; exit 3') },
    { name: 'after', cmd: sh('echo ran > "$DECK_TEST_MARK"'), env: { DECK_TEST_MARK: path.join(tmp, 'after-ran') } },
  ]);
  const rec = await runOnce(r, { sha });
  assert.equal(rec.status, 'red');
  assert.deepEqual(rec.jobs.map(j => j.status), ['green', 'red', 'skipped']);
  assert.equal(rec.jobs[1].summary.exitCode, 3);
  assert.match(rec.jobs[2].summary.reason, /'fails' is red/);
  assert.equal(rec.jobs[2].log, null);
  assert.equal(fs.existsSync(path.join(tmp, 'after-ran')), false, 'the job after a red one never ran');
  assert.ok(fs.readFileSync(rec.jobs[1].log, 'utf8').includes('broken'), 'stderr is in the log');
});

test('the worktree is removed and every lock released even when a job throws', async () => {
  const sha = head();
  const parsers = { boom: () => ({ line() {}, finish() { throw new Error('the reader exploded'); } }) };
  const r = runnerWith([{ name: 'reads', cmd: sh('echo out'), parse: 'boom' }, { name: 'next', cmd: sh('true') }], { parsers });
  const rec = await runOnce(r, { sha });
  assert.equal(rec.status, 'error');
  assert.match(rec.error, /the reader exploded/);
  assert.equal(rec.jobs[1].status, 'skipped');
  assert.equal(fs.existsSync(workDir('fake', sha)), false, 'worktree removed in finally');
  assert.ok(!git(repo.dir, 'worktree', 'list').includes(workDir('fake', sha)));
  assert.deepEqual(noLocks(sha), []);
  // The runner still works afterwards.
  const again = await runOnce(runnerWith([{ name: 'ok', cmd: sh('true') }]), { sha: head() });
  assert.equal(again.status, 'green');
});

test('a command that cannot start is red with the reason, and the run goes on to record it', async () => {
  const sha = head();
  const rec = await runOnce(runnerWith([{ name: 'missing', cmd: ['no-such-command-xyz'] }]), { sha });
  assert.equal(rec.status, 'red');
  assert.match(rec.jobs[0].summary.reason, /could not start no-such-command-xyz/);
});

test('a job past its timeout is red with the reason, its process group is killed, and the rest are skipped', async () => {
  const sha = head();
  const mark = path.join(tmp, 'timeout-grandchild.pid');
  const r = runnerWith([
    { name: 'slow', cmd: sh(`sleep 30 & echo $! > "${mark}"; wait`), timeoutMin: 0.01 },
    { name: 'after', cmd: sh('true') },
  ], { killGraceMs: 500 });
  const t0 = Date.now();
  const rec = await runOnce(r, { sha });
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms: the timeout did not stop the job`);
  assert.equal(rec.status, 'red');
  assert.equal(rec.jobs[0].status, 'red');
  assert.match(rec.jobs[0].summary.reason, /timed out after 0.01 min/);
  assert.equal(rec.jobs[1].status, 'skipped');
  await new Promise(res => setTimeout(res, 200));
  assert.equal(pidAlive(Number(fs.readFileSync(mark, 'utf8'))), false, 'the grandchild is gone');
  assert.match(fs.readFileSync(rec.jobs[0].log, 'utf8'), /timed out after 0.01 min/);
});

test('what a green job leaves running is stopped: its process group, and orphans that name its worktree', async () => {
  const sha = head();
  const inGroup = path.join(tmp, 'left-in-group.pid'), orphan = path.join(tmp, 'left-orphan.pid');
  // A background sleep stays in the job's group; a process that made its own
  // session escapes the group but names a file in the worktree. Both end on
  // their own within a minute, and the test kills them whatever happens, so
  // a run with the runner's cleanup broken (a control) leaves nothing behind.
  const script = `sleep 60 > /dev/null 2>&1 & echo $! > "${inGroup}"
perl -MPOSIX -e 'POSIX::setsid(); open(STDOUT, ">/dev/null"); open(STDERR, ">/dev/null"); exec("perl", "-e", "sleep 60", "$ENV{PWD}/README.md")' &
echo $! > "${orphan}"
sleep 0.3; echo done`;
  const pids = () => [inGroup, orphan].filter(f => fs.existsSync(f)).map(f => Number(fs.readFileSync(f, 'utf8')));
  try {
    const rec = await runOnce(runnerWith([{ name: 'leaves', cmd: sh(script) }]), { sha });
    assert.equal(rec.status, 'green', JSON.stringify(rec.jobs));
    assert.equal(rec.jobs[0].summary.leftRunning, 'its process group, 1 orphaned process(es)');
    await new Promise(res => setTimeout(res, 300));
    assert.equal(pidAlive(Number(fs.readFileSync(inGroup, 'utf8'))), false, 'the background sleep is gone');
    assert.equal(pidAlive(Number(fs.readFileSync(orphan, 'utf8'))), false, 'the orphaned process is gone');
  } finally {
    for (const pid of pids()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
});

test('stop() kills the live job, removes its worktree, and closes what was queued', async () => {
  const a = head(), b = head();
  const mark = path.join(tmp, 'stop-grandchild.pid');
  const r = runnerWith([{ name: 'long', cmd: sh(`sleep 30 & echo $! > "${mark}"; wait`) }], { killGraceMs: 500 });
  await r.enqueue({ repo: 'fake', sha: a });
  await r.enqueue({ repo: 'fake', sha: b });
  const doneA = r.waitFor('fake', a), doneB = r.waitFor('fake', b);
  r.start();
  await until(() => recordFor('fake', a)?.jobs[0].status === 'running' && fs.existsSync(mark), { what: 'the job to start' });
  assert.equal(recordFor('fake', b).status, 'queued');
  assert.deepEqual(r.status().running, { repo: 'fake', sha: a, pr: null, job: 'long' });
  assert.deepEqual(r.status().queue, [{ repo: 'fake', sha: b, pr: null }]);
  const t0 = Date.now();
  await r.stop('stopped by the test');
  assert.ok(Date.now() - t0 < 8000, 'stop() returned');
  const ra = await doneA, rb = await doneB;
  assert.equal(ra.status, 'error');
  assert.equal(ra.error, 'stopped by the test');
  assert.equal(ra.jobs[0].status, 'red');
  assert.match(ra.jobs[0].summary.reason, /stopped by the test/);
  assert.equal(rb.status, 'error');
  assert.match(rb.error, /stopped by the test before it ran/);
  assert.equal(fs.existsSync(workDir('fake', a)), false, 'worktree removed');
  assert.equal(pidAlive(Number(fs.readFileSync(mark, 'utf8'))), false, 'the job\'s process group is gone');
  assert.deepEqual(noLocks(a), []);
  assert.deepEqual(noLocks(b), []);
});

test('a head is queued once, in this process and across processes', async () => {
  const sha = head();
  const r = runnerWith([{ name: 'ok', cmd: sh('true') }]);
  const first = await r.enqueue({ repo: 'fake', sha });
  const second = await r.enqueue({ repo: 'fake', sha: sha.slice(0, 10) });
  assert.equal(first.already, undefined);
  assert.equal(second.already, true);
  assert.deepEqual(r.status().queue.map(q => q.sha), [sha]);
  // Another process holds that head's run lock: queued there, not here.
  const other = head();
  const held = holdLock(runLockName('fake', other), { repo: 'fake', sha: other });
  try {
    const elsewhere = await r.enqueue({ repo: 'fake', sha: other });
    assert.equal(elsewhere.already, true);
    assert.equal(elsewhere.elsewhere, held.pid);
    assert.deepEqual(r.status().queue.map(q => q.sha), [sha]);
  } finally { held.release(); }
  const done = r.waitFor('fake', sha);
  r.start();
  assert.equal((await done).status, 'green');
});

test('one run at a time across runners: the ci lock serialises them', async () => {
  const order = path.join(tmp, 'order.txt');
  const job = [{ name: 'step', cmd: sh(`echo "start $(git rev-parse --short HEAD)" >> "${order}"; sleep 0.4; echo "end $(git rev-parse --short HEAD)" >> "${order}"`) }];
  const one = runnerWith(job), two = runnerWith(job);
  const a = head(), b = head();
  await one.enqueue({ repo: 'fake', sha: a });
  await two.enqueue({ repo: 'fake', sha: b });
  const da = one.waitFor('fake', a), db = two.waitFor('fake', b);
  one.start(); two.start();
  const [ra, rb] = await Promise.all([da, db]);
  assert.equal(ra.status, 'green');
  assert.equal(rb.status, 'green');
  const lines = fs.readFileSync(order, 'utf8').trim().split('\n').map(l => l.split(' ')[0]);
  assert.deepEqual(lines, ['start', 'end', 'start', 'end'], `the two runs overlapped: ${lines}`);
});

test('a run waits for the machine lock while another process holds it', async () => {
  const sha = head();
  const held = holdLock('heavy', { what: 'a Gradle build' });
  const events = [];
  const r = runnerWith([{ name: 'ok', cmd: sh('true') }], { onEvent: e => events.push(e) });
  try {
    await r.enqueue({ repo: 'fake', sha });
    const done = r.waitFor('fake', sha);
    r.start();
    await new Promise(res => setTimeout(res, 400));
    assert.equal(recordFor('fake', sha).status, 'queued', 'nothing ran while heavy was held');
    assert.equal(lockHolder('ci').sha, sha, 'it holds ci and waits for heavy');
    const wait = events.find(e => e.type === 'wait' && e.lock === 'heavy');
    assert.equal(wait && wait.holder.what, 'a Gradle build');
    held.release();
    assert.equal((await done).status, 'green');
  } finally { held.release(); }
});

test('start-up recovery: records a dead process left queued or running become errors, a live owner\'s stay, its leftover worktrees go', async () => {
  const [dead1, dead2, live, done] = [head(), head(), head(), head()];
  const base = sha => ({ v: 1, repo: 'fake', sha, pr: null, ref: null, startedAt: Date.now() - 1000, finishedAt: 0, durationMs: 0, error: null });
  const write = rec => { fs.mkdirSync(path.dirname(ciRecordPath('fake', rec.sha)), { recursive: true }); fs.writeFileSync(ciRecordPath('fake', rec.sha), JSON.stringify(rec)); };
  write({ ...base(dead1), status: 'running', jobs: [{ name: 'a', status: 'green', summary: {} }, { name: 'b', status: 'running', summary: {} }, { name: 'c', status: 'pending', summary: {} }] });
  write({ ...base(dead2), status: 'queued', jobs: [{ name: 'a', status: 'pending', summary: {} }] });
  write({ ...base(live), status: 'running', jobs: [{ name: 'a', status: 'running', summary: {} }] });
  write({ ...base(done), status: 'green', jobs: [{ name: 'a', status: 'green', summary: {} }] });
  const { addWorktree } = await import('../../lib/core/git.mjs');
  await addWorktree(repo.dir, workDir('fake', dead1), dead1);
  await addWorktree(repo.dir, workDir('fake', live), live);
  const held = holdLock(runLockName('fake', live), { repo: 'fake', sha: live });
  try {
    const r = runnerWith([{ name: 'ok', cmd: sh('true') }]);
    const got = await r.recover();
    assert.deepEqual(got, { records: 2, worktrees: 1 });
    const d1 = recordFor('fake', dead1);
    assert.equal(d1.status, 'error');
    assert.match(d1.error, /interrupted/);
    assert.deepEqual(d1.jobs.map(j => j.status), ['green', 'red', 'skipped']);
    assert.equal(recordFor('fake', dead2).status, 'error');
    assert.equal(recordFor('fake', live).status, 'running', 'a live owner keeps its record');
    assert.equal(recordFor('fake', done).status, 'green');
    assert.equal(fs.existsSync(workDir('fake', dead1)), false, 'the dead run\'s worktree is removed');
    assert.equal(fs.existsSync(workDir('fake', live)), true, 'the live run\'s worktree stays');
  } finally {
    held.release();
    const { removeWorktree } = await import('../../lib/core/git.mjs');
    await removeWorktree(repo.dir, workDir('fake', live));
  }
});

test('the GitHub token reaches the job that asks for it and nothing else: not the record, not a log', async () => {
  const sha = head();
  const secret = 'ghs_TESTSECRETdonotprint123';
  const github = { ...noGithub, githubEnv: async () => ({ GITHUB_ACTOR: 'tester', GITHUB_TOKEN: secret }) };
  // The expected value sits outside the data folder: the record stores each
  // job's command line, so the command must not carry the secret itself.
  const expected = path.join(tmp, 'expected-token');
  fs.writeFileSync(expected, secret);
  const r = runnerWith([
    { name: 'with', cmd: sh(`test "$GITHUB_TOKEN" = "$(cat '${expected}')" && test "$GITHUB_ACTOR" = tester && echo has-token`), githubToken: true },
    { name: 'without', cmd: sh('test -z "$GITHUB_TOKEN" && echo no-token') },
  ], { github });
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const rec = await runOnce(r, { sha });
    assert.equal(rec.status, 'green', JSON.stringify(rec.jobs));
    assert.equal(rec.jobs[0].summary.githubToken, true);
    const leaks = [];
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (fs.readFileSync(p, 'utf8').includes(secret)) leaks.push(p);
      }
    };
    walk(process.env.DECK_DATA);
    assert.deepEqual(leaks, [], 'the token was written to disk');
    assert.ok(fs.readFileSync(rec.jobs[0].log, 'utf8').includes('set from gh (not shown)'));
  } finally { if (saved !== undefined) process.env.GITHUB_TOKEN = saved; }
});

test('a missing tool is an error (not a verdict on the code), and nothing runs', async () => {
  const sha = head();
  const r = runnerWith([{ name: 'needs', cmd: sh('echo ran > "$M"'), env: { M: path.join(tmp, 'needs-ran') }, requires: [path.join(tmp, 'no-such-tool')] }]);
  const rec = await runOnce(r, { sha });
  assert.equal(rec.status, 'error');
  assert.match(rec.error, /needs .*no-such-tool, which is missing/);
  assert.equal(fs.existsSync(path.join(tmp, 'needs-ran')), false);
});

test('a run does not start with less free disk than ci.minFreeDiskGB: an error that says why, and nothing ran', async () => {
  const GB = 1024 ** 3;
  const mark = path.join(tmp, 'disk-job-ran');
  const jobs = [{ name: 'writes', cmd: sh(`echo ran > "${mark}"`) }];
  const state = stateFor({ fake: repo }, { fake: { timeoutMin: 1, jobs } }, { minFreeDiskGB: 3 });
  const low = head();
  const r = createRunner({ getState: () => state, pollMs: 20, github: noGithub, freeDisk: () => 2.5 * GB });
  const rec = await runOnce(r, { sha: low });
  assert.equal(rec.status, 'error');
  assert.match(rec.error, /refused to start: 2\.5 GB free on the disk, under the 3 GB a CI run needs/);
  assert.equal(rec.jobs[0].status, 'skipped');
  assert.match(rec.jobs[0].summary.reason, /not run: refused to start/);
  assert.equal(fs.existsSync(mark), false, 'nothing ran');
  assert.ok(!git(repo.dir, 'worktree', 'list').includes(workDir('fake', low)), 'no worktree was made');
  assert.deepEqual(noLocks(low), []);
  const ok = await runOnce(createRunner({ getState: () => state, pollMs: 20, github: noGithub, freeDisk: () => 3.5 * GB }), { sha: head() });
  assert.equal(ok.status, 'green');
});

test('a job is stopped when free disk falls under ci.stopBelowFreeDiskGB while it runs, and the run is an error', async () => {
  const GB = 1024 ** 3;
  const sha = head();
  const mark = path.join(tmp, 'disk-watch-grandchild.pid');
  const jobs = [{ name: 'fills', cmd: sh(`sleep 30 & echo $! > "${mark}"; wait`) }, { name: 'after', cmd: sh('true') }];
  const state = stateFor({ fake: repo }, { fake: { timeoutMin: 1, jobs } }, { minFreeDiskGB: 3, stopBelowFreeDiskGB: 1, diskCheckMs: 50 });
  // Plenty at the start check, then the disk fills while the job runs.
  let free = 10 * GB;
  const r = createRunner({ getState: () => state, pollMs: 20, github: noGithub, killGraceMs: 500, freeDisk: () => free });
  const q = await r.enqueue({ repo: 'fake', sha });
  const done = r.waitFor('fake', q.sha);
  r.start();
  await until(() => recordFor('fake', sha)?.jobs[0].status === 'running' && fs.existsSync(mark), { what: 'the job to start' });
  const t0 = Date.now();
  free = 0.4 * GB;
  const rec = await done;
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms: the watchdog did not stop the job`);
  assert.equal(rec.status, 'error');
  assert.match(rec.error, /free disk fell to 0\.4 GB, under 1 GB, while 'fills' ran/);
  assert.equal(rec.jobs[0].status, 'red');
  assert.equal(rec.jobs[1].status, 'skipped');
  assert.equal(fs.existsSync(workDir('fake', sha)), false, 'the worktree is removed');
  await new Promise(res => setTimeout(res, 200));
  assert.equal(pidAlive(Number(fs.readFileSync(mark, 'utf8'))), false, 'the job\'s processes are gone');
  assert.match(fs.readFileSync(rec.jobs[0].log, 'utf8'), /free disk fell to 0\.4 GB/);
});

test('the free-disk refusal measures the real disk under the data folder', async () => {
  // No measurement injected: a threshold no disk meets refuses, zero runs.
  const jobs = [{ name: 'ok', cmd: sh('true') }];
  const huge = stateFor({ fake: repo }, { fake: { timeoutMin: 1, jobs } }, { minFreeDiskGB: 1e9 });
  const refused = await runOnce(createRunner({ getState: () => huge, pollMs: 20, github: noGithub }), { sha: head() });
  assert.equal(refused.status, 'error');
  assert.match(refused.error, /refused to start: [\d.]+ GB free on the disk, under the 1000000000 GB/);
  const none = stateFor({ fake: repo }, { fake: { timeoutMin: 1, jobs } }, { minFreeDiskGB: 0 });
  assert.equal((await runOnce(createRunner({ getState: () => none, pollMs: 20, github: noGithub }), { sha: head() })).status, 'green');
});

test('repo ids and job names cannot point outside the data folder', async () => {
  const sha = head();
  for (const bad of ['../x', 'a/b', '..', '', 'constructor', '__proto__']) {
    assert.throws(() => repoPlan(bad, stateFor({ fake: repo }, {})), /unknown repo|no CI jobs/, bad);
  }
  // A config whose repo id would climb out of the work folder is refused before any git call.
  const evil = { repos: { '../../evil': { path: repo.dir, slug: 'x/y' } }, ci: { repos: { '../../evil': { jobs: [{ name: 'x', cmd: ['true'] }] } } } };
  assert.throws(() => repoPlan('../../evil', evil), /unknown repo/);
  const r = createRunner({ getState: () => evil, github: noGithub });
  await assert.rejects(r.enqueue({ repo: '../../evil', sha }), /unknown repo/);
  for (const name of ['../../etc/passwd', '..', 'a/b', '.hidden', 'npm ci', 'test:all']) {
    const f = logName(name);
    assert.ok(!f.includes('/') && !f.startsWith('.'), `${name} -> ${f}`);
  }
  assert.equal(logName('npm ci'), 'npm-ci.log');
  assert.equal(logName('build:runtime'), 'build-runtime.log');
  // Two names that land on one file are refused.
  assert.throws(() => repoPlan('fake', stateFor({ fake: repo }, { fake: { jobs: [{ name: 'a:b', cmd: ['true'] }, { name: 'a b', cmd: ['true'] }] } })), /share the log/);
});

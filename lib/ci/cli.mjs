// deck ci <repo> <pr|sha|main>        run CI now, in this process (exit 0 green, 1 red, 3 error)
// deck ci --status <repo> <pr|sha>    print the record of that head (exit 0 green, 1 otherwise)
import { tildify } from '../core/paths.mjs';
import { recordFor, ciRecordPath } from './records.mjs';
import { createRunner, repoPlan, resolveHead, parseTarget, fmtDuration } from './runner.mjs';

const USAGE = `usage:
  deck ci <repo> <pr|sha|main>         run CI in a throwaway worktree (exit 0 green, 1 red, 3 error)
  deck ci --status <repo> <pr|sha|main> print the record of that head (exit 0 green, 1 otherwise)`;

const short = sha => String(sha || '').slice(0, 12);

export function summaryText(job) {
  const s = job.summary || {};
  const bits = [];
  if (s.reason) bits.push(s.reason);
  if (Array.isArray(s.passed)) bits.push(`passed: ${s.passed.join(' ') || 'none'}; failed: ${(s.failed || []).join(' ') || 'none'}`);
  if (s.tests && s.tests.total != null) bits.push(`tests: ${s.tests.passed || 0} passed${s.tests.failed ? `, ${s.tests.failed} failed` : ''} of ${s.tests.total}`);
  if (s.junit) bits.push(`junit: ${s.junit.tests} tests, ${s.junit.failures + s.junit.errors} failed, ${s.junit.skipped} skipped`);
  if (s.gameTests && s.gameTests.runs) bits.push(`game tests: ${s.gameTests.passed} passed, ${s.gameTests.failed} failed`);
  return bits.length ? ` (${bits.join('; ')})` : '';
}

function printRecord(rec, out) {
  out(`${rec.repo} ${short(rec.sha)}${rec.pr ? ` #${rec.pr}` : rec.ref ? ` ${rec.ref}` : ''}: ${rec.status}${rec.durationMs ? ` in ${fmtDuration(rec.durationMs)}` : ''}`);
  for (const j of rec.jobs || []) out(`  ${j.name}: ${j.status}${j.durationMs ? ` in ${fmtDuration(j.durationMs)}` : ''}${summaryText(j)}`);
  if (rec.error) out(`  error: ${rec.error}`);
  out(`  record: ${tildify(ciRecordPath(rec.repo, rec.sha))}`);
}

const exitFor = rec => (rec && rec.status === 'green' ? 0 : rec && rec.status === 'red' ? 1 : 3);

// io: { out, err } for tests; runnerOpts reach createRunner.
export async function main(argv = [], io = {}) {
  const out = io.out || (s => console.log(s));
  const err = io.err || (s => console.error(s));
  const args = [...argv];
  if (!args.length || args[0] === '-h' || args[0] === '--help') { out(USAGE); return args.length ? 0 : 1; }

  if (args[0] === '--status') {
    const [, repoId, word] = args;
    if (!repoId || !word) { err(USAGE); return 1; }
    try {
      const plan = repoPlan(repoId, io.state);
      const sha = /^[0-9a-f]{40}$/i.test(word) ? word.toLowerCase() : (await resolveHead(plan.repo, parseTarget(word))).sha;
      const rec = recordFor(repoId, sha);
      if (!rec) { out(`${repoId} ${short(sha)}: no CI record`); return 1; }
      printRecord(rec, out);
      return rec.status === 'green' ? 0 : 1;
    } catch (e) { err(`deck ci: ${e.message}`); return 1; }
  }

  const [repoId, word, ...extra] = args;
  if (!repoId || !word || extra.length) { err(USAGE); return 1; }
  let target;
  try { repoPlan(repoId, io.state); target = parseTarget(word); }
  catch (e) { err(`deck ci: ${e.message}`); return 1; }

  let jobStart = 0, jobName = null;
  const onEvent = e => {
    if (e.type === 'wait') {
      const what = e.lock === 'heavy' ? 'the machine lock' : e.lock === 'ci' ? 'the CI lock' : e.lock;
      out(`waiting for ${what}${e.holder ? `: ${e.holder.what || '?'} (pid ${e.holder.pid})` : ''}`);
    } else if (e.type === 'start') out(`running ${e.jobs.join(', ')}`);
    else if (e.type === 'job') {
      const j = e.job;
      if (j.status === 'running') { jobStart = Date.now(); jobName = j.name; out(`${j.name}: running`); }
      else { if (j.name === jobName) jobName = null; out(`${j.name}: ${j.status}${j.durationMs ? ` in ${fmtDuration(j.durationMs)}` : ''}${summaryText(j)}`); }
    }
  };
  const runner = createRunner({ ...(io.runnerOpts || {}), getState: () => io.state, onEvent });
  // What a killed `deck ci` left behind is closed here too, not only when the
  // gateway next starts. Records and worktrees a live process holds stay.
  try { await runner.recover(); } catch (e) { err(`deck ci: recovery: ${e.message}`); }

  let queued;
  try { queued = await runner.enqueue({ repo: repoId, ...target }); }
  catch (e) { err(`deck ci: ${e.message}`); return e.status === 400 ? 1 : 3; }
  out(`${repoId} ${target.pr ? `#${target.pr}` : target.ref || short(target.sha)} = ${short(queued.sha)}`);

  // Ref'd: lock waits use unref'd timers, and this is what keeps the command
  // alive through them. It also says a long job is still going.
  const beat = setInterval(() => {
    if (jobName) out(`${jobName}: still running (${fmtDuration(Date.now() - jobStart)})`);
  }, io.heartbeatMs || 60000);
  // The first signal stops the run cleanly; a second one leaves at once (the
  // next start removes the worktree).
  let signalled = false;
  const onSignal = () => {
    if (signalled) process.exit(130);
    signalled = true;
    out('stopping: the job is killed and its worktree removed (again to quit now)');
    runner.stop('stopped from the terminal');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    let rec;
    const own = runner.waitFor(repoId, queued.sha);
    if (own) {
      runner.start();
      rec = await own;
    } else {
      // Another process (the running Deck) has this head queued or running.
      out(`already queued${queued.elsewhere ? ` by pid ${queued.elsewhere}` : ''}; following its record`);
      let last = '';
      for (;;) {
        rec = recordFor(repoId, queued.sha);
        const now = rec ? `${rec.status} ${(rec.jobs || []).map(j => `${j.name}=${j.status}`).join(' ')}` : 'none';
        if (now !== last) { out(now); last = now; }
        if (!rec || !['queued', 'running'].includes(rec.status)) break;
        await new Promise(r => setTimeout(r, io.followMs || 3000));
      }
    }
    if (!rec) { err(`deck ci: no record for ${repoId} ${short(queued.sha)}`); return 3; }
    printRecord(rec, out);
    return exitFor(rec);
  } finally {
    clearInterval(beat);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

// The CI jobs of each repo: the same checks as its GitHub workflow, in the
// same order (concept § 4, contract § 5). state.json's `ci` key overrides any
// of it; objects merge key by key, arrays (a repo's `jobs`) replace whole.
//
// A job:
//   name           shown on the panel; also names its log file
//   cmd            argv, run in the throwaway worktree; {sha} is the head,
//                  {base} the head of the pull request's base branch
//   env            extra environment; a value starting with ~/ is expanded
//   timeoutMin     overrides the repo's timeoutMin for this job
//   parse          which reader fills job.summary: ci-local | vitest | gradle
//   dropLines      a regex: matching lines are counted, not written to the log
//   githubToken    GITHUB_ACTOR and GITHUB_TOKEN from `gh`, in this job's
//                  environment only; never logged or recorded
//   requires       files that must exist, or the run is an error (a missing
//                  tool says nothing about the code)
//   onlyIfChanged  path prefixes: runs only when the head changes a file under
//                  one of them against its merge base with origin/main
//   prOnly         runs only for a pull request (GitHub runs it on pull requests only)
//   skipLabel      skipped when the pull request carries this label

export const CI_DEFAULTS = {
  // How often a run waiting for the `ci` or `heavy` lock looks again.
  pollMs: 2000,
  // A log stops growing here; its last lines are still kept at the end.
  logMaxBytes: 64 * 1024 * 1024,
  // A run does not start with less free disk than this: a fresh worktree and
  // its build take about 1 GB, and swap grows into the same disk.
  minFreeDiskGB: 3,
  // A running job is stopped (the run ends as an error) when free disk falls
  // under this: a Conduit game test once wrote 100 MB a minute into its world.
  stopBelowFreeDiskGB: 1,
  diskCheckMs: 15000,
  // Per repo: { timeoutMin, jobs: [job, ...] }, keyed like state.json's
  // `repos`. examples/state.example.json has a C++ engine and a web app.
  repos: {},
};

# CI panel: as built

Contract § 5 and § 12; concept § 4 (in the author's notes).
Code: `lib/ci/` (`defaults.mjs` jobs, `runner.mjs` queue and runs,
`parse.mjs` summaries, `log.mjs` job logs, `index.mjs` routes, `cli.mjs`).

## What each repo runs

Jobs run in order, in a throwaway worktree of the exact head under
`ci/work/<repo>-<sha12>/`; after a red job the rest are `skipped`. Each job has
a timeout (Perdix 60 min, Conduit 45, Modplex 30); a timeout is red with the
reason. Override anything through `state.json` key `ci` (objects merge, a
repo's `jobs` array replaces whole).

| Repo | Job | Command | Summary |
|---|---|---|---|
| perdix | `ci-local` | `scripts/ci-local.sh` with `CLANG_FORMAT`/`CLANG_TIDY` from `~/.ci-tools`, `JOBS=3` | `passed`, `failed`, `notRunHere` from its summary block |
| conduit | `check` | `./gradlew check --no-daemon --stacktrace`, `GITHUB_ACTOR`/`GITHUB_TOKEN` from `gh` | JUnit counts, game test verdicts, failed tasks, Gradle's last line, the API gate line |
| conduit | `changelog` | `scripts/check-changelog-unreleased.sh <base sha> <head sha>` | exit code |
| modplex | `npm ci`, `build`, `typecheck`, `test:all` | the npm scripts | vitest's file and test counts (`test:all`) |
| modplex | `build:runtime` | `npm run build:runtime` with `GRADLE_OPTS=-Dorg.gradle.daemon=false` | exit code |

Perdix's clang tools, the versions ci.yml pins (22.1.8 on 2026-10-12):

```
python3 -m venv ~/.ci-tools
~/.ci-tools/bin/pip install clang-format==<CLANG_FORMAT_VERSION> clang-tidy==<CLANG_TIDY_VERSION>
```

A missing `~/.ci-tools/bin/clang-*` makes the run an `error` (the machine is
not set up), not `red`. A version that no longer matches ci.yml makes
ci-local.sh's `format` or `tidy` fail, which is red: reinstall with the new pins.

## How a run goes

1. Queued (FIFO, deduplicated by repo and SHA). The head is resolved first: a
   PR through `fetchPrHead`, `main` through `fetchRef`, a SHA locally or by
   fetch. The record is written `queued`; its `startedAt` is the queue time
   until the run starts. The queuing process holds the lock
   `ci-run-<repo>-<sha12>` until the run ends, which dedupes across processes.
2. Waits for the lock `ci` (one run at a time across processes), then for
   `heavy` (the machine lock; Mod Lab and `scripts/with-heavy-lock.mjs` take
   it too). Always in that order, so no two waits cross.
3. Refuses to start under `ci.minFreeDiskGB` (3 GB) free on the data folder's
   disk: the record becomes `error`, saying how much was free. While a job
   runs, free disk is measured every 15 s; under `ci.stopBelowFreeDiskGB`
   (1 GB) the job is killed and the run ends as `error`, saying how much was
   left. Swap on this Mac grows into the same disk under memory pressure.
4. Plans the jobs: pull request facts from `gh` when a job needs them (the
   label and the base branch), `main` fetched when a job depends on what the
   head changes. A failure here is an `error`, never a guess or a silent skip.
5. `addWorktree`, then each job through `spawnTracked` with stdin closed. The
   record is rewritten atomically at every job start and end.
6. After each job: anything still in its process group is stopped, then any
   orphan whose command line names the worktree.
7. `finally`: the worktree is removed, the locks released, the record closed.

`stop()` (Deck shutting down, or Ctrl-C on `deck ci`) kills the live job's
process group, removes its worktree, and closes queued records as `error`. On
`start()`, records a dead process left `queued` or `running` (their run lock
has no live holder) become `error` ("interrupted"), and worktrees left under
`ci/work/` without a live holder are removed.

Logs: `ci/<repo>/<sha>/<job>.log`, the job name made file-safe (`npm ci` is
`npm-ci.log`). Conduit's `[++ ]` progress lines are counted, not written (a
whole check once came to 1.6 GB); any log stops growing at 64 MB and keeps its
last 300 lines. A rerun of a head starts with an empty log folder.

## Measured (2026-10-12, real heads, the real data folder)

| Repo | Head | Result | Duration |
|---|---|---|---|
| perdix | #334 `e82c936` | green: layering, minecraft-files, format, build, tidy, linux-warnings | 5m07s (ci-local 5m02s: configure with 12 dependency clones 79 s, 477 build steps, 782 tests 69 s, tidy, Homebrew Clang 20 over 209 files) |
| conduit | #53 `92a7a9f` | error: stopped at 798 MB free disk, `check` unfinished, `changelog` not run | 32m56s. Unit tests, doc checks and checkApiCompat passed ("11 module(s) compared, 0 skipped, no undeclared breaks", GitHub Packages reached); seven game-test verdicts, all passed (223 tests). `conduit-world`'s `runGameTest` then ran over 30 minutes, its world growing about 100 MB a minute (1.4 GB in the worktree), printing 27,543,899 `[++ ]` lines that the log left out (the log stayed at 297 KB). |

Not run on 10-12, because the disk stayed under 4 GB free after the Conduit
run (swap had grown to 7 GB): Modplex `main`, and the red control, a Perdix
commit that is #334's head plus one clang-format break
(`86f00a88957a5b2c55239d75e3a8ff02bccbdd36`, made with plumbing, on no branch;
`git gc` prunes it after about two weeks). To run them:
`deck ci modplex main` (expect green), and
`deck ci perdix 86f00a88957a5b2c55239d75e3a8ff02bccbdd36` (expect red, with
`summary.failed: ["format"]`; clang-format 22.1.8 flags the line, checked by
hand). Conduit's `changelog` job alone (a temp data folder, `check` left out)
went green on #53: "14 engine source file(s) changed and [Unreleased] gained
365 line(s)", against main's head fetched for it.

Conduit's whole `check` takes about 5 minutes on GitHub. Locally its
`conduit-world` game test is the long pole and needs more free disk than this
Mac had on 10-12; with the watchdog the runner now stops such a run itself
(as `error`, not `red`) instead of filling the disk.

## Where it differs from the concept or GitHub, and why

- **Exact head, not the merge.** GitHub's `pull_request` runs test the head
  merged into the current base; Deck tests the exact head SHA (a record per
  head, as the gate needs). A stacked PR, or one whose base moved, can be green
  here and red there.
- **Linux jobs do not run.** Perdix's GCC, lavapipe, ASan and TSan jobs need
  Linux; `ci-local.sh` says so and the record keeps it in `summary.notRunHere`.
- **Modplex's steps are separate jobs** (the concept wrote one `&&` line): a
  duration, a log and a status per step, and the skip-after-red rule applies.
- **Conduit's changelog gate is a job** (the concept's table lists only
  `check`): it mirrors `changelog-gate.yml`. It runs only for a pull request
  (GitHub runs it on `pull_request` only; a SHA that is an open PR's head counts
  as that PR), against the PR's base branch freshly fetched, and is skipped when
  the PR carries `no-changelog`. The base is passed as the fetched SHA, which is
  what `origin/<base>` resolves to after CI's own fetch.
- **checkApiCompat's baselines.** `gradle/api-compat.gradle` reads mavenLocal
  first, then GitHub Packages when `GITHUB_ACTOR` and `GITHUB_TOKEN` are set; CI
  sets both. The `check` job gets them from `gh auth token` (scopes include
  `write:packages`) and `gh api user`, in that job's environment only; the
  token is never logged or recorded (a test reads every file under the data
  folder for it). Without a token the job still runs, says so in its log, and
  records `summary.githubToken: false`. Unlike CI, `~/.m2` takes part.
- **Node.** GitHub runs Modplex on Node 22; this Mac has Node 24.14.1
  (`engines` allows `>=22`). Not pinned.
- **`build:runtime`** is not in GitHub's CI; it runs when the head changes
  `runtime/` against its merge base with origin/main (decided 10-12). Its
  `./gradlew build` has no `--no-daemon`, so the job sets
  `GRADLE_OPTS=-Dorg.gradle.daemon=false` to leave no daemon behind.
- **A fresh worktree every run**: Perdix configures and clones its
  dependencies each time (about 80 s of the 5 min); Conduit rebuilds Loom's
  project cache; Modplex installs from the npm cache.
- **The worktree path has a space** (`Application Support`), unlike GitHub's
  runners; Perdix and Conduit built and tested there without trouble.
- **Free disk limits** (3 GB to start, 1 GB to keep going) have no GitHub
  counterpart: a run stopped for disk is an `error`, never a verdict.

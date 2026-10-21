# Deck v2: the contract

The interface every v2 feature builds against. The feature spec (what each
feature does and why) is the concept document, kept in the author's notes;
this file fixes the shapes: modules, routes, records, exit codes. It is
**locked**: a lane that needs a change reports it instead of diverging.

Features: Claude kit (`lib/claude`), Reviews (`lib/reviews`), Mod Lab
(`lib/modlab`), CI panel (`lib/ci`), Machine guard (`lib/guard`), Focus mode
(`lib/focus`). Shared helpers: `lib/core`. The mount: `lib/v2.mjs`.

## 1. Code layout and rules

- New code is ESM (`.mjs`). `server.js` stays CommonJS and loads `lib/v2.mjs`
  with `require()` (Node 22.12+ and Bun both support it). **No top-level
  `await` anywhere under `lib/`**: `require()` of an ESM graph with top-level
  await throws `ERR_REQUIRE_ASYNC_MODULE`.
- One runtime dependency: `@anthropic-ai/sdk`, imported only by `lib/claude`.
  Nothing else under `lib/` imports an npm package.
- The shipped gateway is Bun-compiled (`scripts/build-gateway.mjs`). Inside the
  binary `import.meta.url` points into Bun's virtual filesystem, so **never
  derive a path from `import.meta.url` in `lib/`**. Use `deckRoot()` and
  `dataDir()` from `lib/core/paths.mjs`.
- The installed app starts the gateway with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`.
  Every child process (`gh`, `npm`, `node`, `bun`, `cmake`, `java`, ...) is
  spawned through `lib/core/proc.mjs` with `toolEnv()`, which puts
  `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin` in front. A bare
  `spawn('gh', ...)` with `process.env` works in a terminal and fails in the app.
- Timers: every `setInterval`/`setTimeout` in a background loop is `.unref()`ed
  and cleared in `stop()`.
- No native `<select>`, no `confirm()`/`alert()`/`prompt()` in pages (Deck's
  webview has no dialogs; `confirm()` returns false). Two-click in-page confirms.
- No em dashes or en dashes in code, comments, copy or docs.
- Paths shown to the user keep `~` (use `tildify()`); paths used on disk are
  expanded (`expandHome()`).

## 2. Data and config

- **Data** (records, logs, ledgers) lives outside the repo:
  `dataDir()` = `$DECK_DATA` or `~/Library/Application Support/Deck`.

```
claude-ledger.jsonl            one line per API call (kit)
claude-state.json              last credits-out event (kit)
reviews/<repo>/<pr>-<sha>.json review record (+ .md rendering)
reviews/<repo>/<pr>-<sha>.override.json
ci/<repo>/<sha>.json           CI record
ci/<repo>/<sha>/<job>.log      CI job logs
ci/work/<repo>-<sha12>/        throwaway worktree while a run is live
modlab/<project>/<runId>.json  Mod Lab run record
modlab/<project>/<runId>/      step logs, screenshots
launches.json                  { "<toolId or proj:id:kind>": epochMs } (focus)
locks/<name>.lock              cross-process locks
```

- **Config** stays in `state.json` (gitignored, local) on top of the defaults in
  `lib/core/config.mjs`. Sections: `claude`, `reviews`, `ci`, `modlab`,
  `guard`, `focus`. `loadConfig(state?)` deep-merges defaults with the state
  object (server passes `ctx.getState()`; the CLI omits it and the file is read).
  **Only the server writes `state.json`** (through `ctx.saveState`); the CLI
  never does, because the server holds the file in memory and rewrites it whole.
- Mod Lab benches live in `projects/<id>.json` under `modlab` (concept § Mod Lab).

## 3. The mount (`server.js` → `lib/v2.mjs`)

`server.js` builds a `ctx` and calls `mount(ctx)`:

```js
ctx = {
  root, vault,                         // deck checkout, vault folder
  procs, alive, pushLog,               // server.js's process map and helpers
  spawnRaw(key, cmdArr, cwd, env, prelaunch) -> pid,
  stopProc(key, graceMs) -> Promise<{code, signal} | null>,  // SIGTERM, wait, SIGKILL after grace
  loadProjects() -> { id: project }, loadManifests() -> { id: manifest },
  serverSpecs(project) -> [spec], probePort(port) -> Promise<bool>,
  getState() -> object, saveState(next),
}
const v2 = mount(ctx)  // { handle(req, res, url) -> Promise<bool>, onLaunch(key), shutdown() -> Promise }
```

`handle` runs before the 404 and returns `true` when a v2 route answered.
`onLaunch(key)` is called by `server.js` whenever it starts a tool (`toolId`)
or a project child (`proj:<id>:<kind>`); Focus records it.

Each feature folder exports three functions from its `index.mjs`, and
`lib/v2.mjs` calls them in this order: `register(router, ctx)` at mount,
`start(ctx)` right after, `await stop()` on shutdown. `start` is skipped when
`DECK_NO_BACKGROUND` is set (the gateway check and tests), so routes must work
without their background loop having run.

Routes use `lib/core/http.mjs`:

```js
router.add('GET', '/api/modlab/:project/runs/:id', async (req, res, { params, query, body }) => obj)
// returning an object sends it as 200 JSON; throw new HttpError(status, message) for errors
// body() parses the JSON request body ({} when empty)
```

## 4. Claude kit (`lib/claude`)

```js
import { call, keyStatus, spendSummary, recentCalls, PRESETS, PRICES } from './lib/claude/index.mjs'

const r = await call({
  tool: 'reviews' | 'modlab',          // budget bucket and Keychain service
  preset: 'review.normal' | 'review.risky' | 'review.verify' | 'modlab.scenario' | 'modlab.crash',
  system: [{ text, cache: true }],     // blocks; cache:true marks a breakpoint (max 4 in total)
  messages: [{ role: 'user', content: [{ type: 'text', text, cache: true }] }],
  schema,                              // optional JSON schema -> output_config.format; r.json is parsed
  ref,                                 // short label for the ledger, e.g. "perdix#334@e82c936"
  state,                               // optional: the gateway's live state, for the caps (the CLI leaves it out)
})
// r = { text, json, model, requestId, stopReason, usage: {...}, costUsd, budget: { level, spent, cap } }
```

- `cache: true` becomes `cache_control: {type: 'ephemeral', ttl}` with the
  preset's TTL (`1h` or `5m`); presets without caching strip the markers.
- Presets (model, effort, max_tokens, cache) are the concept's table; prices
  per MTok live in `PRICES` next to them.
- Errors are `ClaudeError` subclasses with a `kind`:
  `BudgetExhausted`, `CreditsOut`, `RateLimited` (`retryAfterS`), `Overloaded`,
  `AuthMissing`, `BadRequest`, `Refused`. Features branch on `err.kind`.
- `keyStatus(tool)` -> `'present' | 'missing'` (never reads the secret).
- `spendSummary({ state }?)` -> `{ month: 'YYYY-MM', byTool: {reviews, modlab}, total, caps: {reviews, modlab, total}, levels: {reviews, modlab, total} }`,
  level one of `ok | warn50 | warn80 | out`.
- Tests inject fakes with `configureKit({ keyReader, clientFactory, now })`.

## 5. CI panel (`lib/ci`)

**Record** `ci/<repo>/<sha>.json`:

```json
{ "v": 1, "repo": "perdix", "sha": "<40 hex>", "pr": 334, "ref": "pull/334/head",
  "status": "queued | running | green | red | error",
  "startedAt": 0, "finishedAt": 0, "durationMs": 0,
  "jobs": [ { "name": "ci-local", "cmd": "scripts/ci-local.sh", "status": "pending | running | green | red | skipped",
              "durationMs": 0, "log": "<abs path>", "summary": { } } ],
  "error": null }
```

`green` = every job green or skipped. `error` = the run itself broke (fetch,
worktree, crash), which is not a verdict on the code. One run at a time across
processes (lock `ci`); more are queued.

**Exported API** (Reviews and the badges read these):

```js
latestRecord(repo) -> record | null
recordFor(repo, sha) -> record | null
isGreen(repo, sha) -> boolean
```

**Routes:**

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/ci` | | `{ running: {repo, sha, pr, job} \| null, queue: [{repo, sha, pr}], repos: [{ id, name, slug, latest: record \| null, records: [record] }] }` (records: newest 20) |
| POST | `/api/ci/run` | `{repo, pr}` or `{repo, sha}` or `{repo, ref: 'main'}` | `{ queued: true, sha }` |
| GET | `/api/ci/record` | `?repo&sha` | record |
| GET | `/api/ci/log` | `?repo&sha&job&lines=200` | `{ lines: [string] }` |

## 6. Reviews (`lib/reviews`)

**Record** `reviews/<repo>/<pr>-<sha>.json`:

```json
{ "v": 1, "repo": "perdix", "slug": "zlexo/perdix", "pr": 334, "sha": "<40 hex>",
  "title": "", "base": "main", "head": "branch",
  "status": "done | failed",
  "error": { "kind": "CreditsOut", "message": "" },
  "verdict": "pass | pass_with_notes | blocked",
  "summary": "",
  "findings": [ { "severity": "blocker | should_fix | nit | question", "file": "", "line_start": 1, "line_end": 3,
                  "quote": "", "problem": "", "failure_scenario": "", "suggestion": "",
                  "verify": { "real": true, "why": "" }, "demoted": { "from": "blocker", "reason": "" } } ],
  "dropped": [ { "finding": { }, "reason": "" } ],
  "preset": "review.normal", "model": "claude-sonnet-5-5", "risky": ["path"], "partial": false,
  "costUsd": 0, "requestIds": [], "startedAt": 0, "finishedAt": 0,
  "context": { "rules": [], "lessons": "", "design": [], "stack": [], "tokensEst": 0 },
  "githubStatus": { "state": "success | failure", "description": "", "postedAt": 0 } }
```

`verify.real` is `null` for a blocker the second look could not judge (it
stays a blocker). `error.kind` is a kit kind or `BadOutput` (an answer that
does not fit the schema). `verdict` is recomputed after verification: `blocked` when a blocker survives,
`pass_with_notes` when any finding survives, else `pass`. A finding is never
both kept and dropped. **Override** `<pr>-<sha>.override.json`:
`{ "who": "", "reason": "", "ts": 0 }`.

**The gate:** `deck review --check <repo> <pr>` resolves the PR's head SHA and exits:

| Code | Meaning |
|---|---|
| 0 | mergeable: green CI record, and a done review with no open blocker or an override |
| 2 | blocked: an open blocker and no override |
| 3 | no review because of budget or API (a failed record of kind BudgetExhausted, CreditsOut, AuthMissing, RateLimited or Overloaded): allowed on CI alone, note it in the PR body |
| 4 | the head changed since its review (a record exists for an older head only), or the PR's base is not the one it was reviewed against |
| 5 | no green CI record for the head |
| 6 | no review record at all for this PR |
| 7 | the review failed for another reason (Refused, BadOutput, BadRequest, output cut off): review again, or override with a reason |
| 1 | usage or internal error |

**Routes:**

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/reviews` | | `{ queue: { on, intervalMin, lastPassAt, nextPassAt, running: {repo, pr} \| null, lastError }, repos: [{ id, name, slug, error?, prs: [{ pr, title, sha, url, ci: 'green' \| 'red' \| 'running' \| null, review: { verdict, blockers, notes, costUsd, status, error } \| null, gate: { code, label } }] }], spend: <spendSummary> }` |
| GET | `/api/reviews/record` | `?repo&pr&sha` | `{ record, markdown, override }` |
| POST | `/api/reviews/run` | `{repo, pr}` | `{ started: true }` |
| POST | `/api/reviews/override` | `{repo, pr, sha, reason}` | `{ ok: true }` |
| POST | `/api/reviews/queue` | `{on}` | `{ on }` |

## 7. Mod Lab (`lib/modlab`)

Bench: `projects/<id>.json` → `modlab` (concept § Mod Lab). Scenario files are
YAML in the mod's repo (`modlab.scenarios`), the subset in the concept's step
table; `lib/modlab/yaml.mjs` parses that subset and rejects anything else with
a line number.

**Run record** `modlab/<project>/<runId>.json` (runId `YYYYMMDD-HHMMSS`):

```json
{ "v": 1, "project": "pad-party", "id": "20261012-153000",
  "status": "running | passed | failed | error | stopped",
  "startedAt": 0, "finishedAt": 0, "durationMs": 0,
  "commits": { "~/code/your-mod": "<sha>" },
  "steps": [ { "kind": "check | prelaunch | build | server | client | stop", "label": "",
               "status": "pending | running | passed | failed | skipped", "startedAt": 0, "durationMs": 0,
               "detail": "", "log": "<abs path>" } ],
  "scenarios": [ { "file": "boot-clean.yaml", "name": "", "status": "pending | running | passed | failed | skipped",
                   "durationMs": 0, "error": "",
                   "steps": [ { "i": 0, "text": "console: /padparty hub status", "status": "", "durationMs": 0,
                                "evidence": { "matched": "", "lines": [], "state": { }, "screenshot": "" }, "error": "" } ] } ],
  "crashes": [ { "ts": 0, "source": "crash-report | tick-loop | stopped", "file": "", "causedBy": "", "frame": "", "excerpt": "" } ] }
```

**Routes:**

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/modlab` | | `{ benches: [{ project, name, color, iconSvg, scenarios, lastRun, running }], running: { project, runId } \| null }` |
| GET | `/api/modlab/:project` | | `{ bench, scenarios: [{ file, name, needs, timeout, steps, text, error }], history: [summary], running: summary \| null }` |
| POST | `/api/modlab/:project/run` | `{ scenarios?: [file] }` | `{ runId }` (409 when a run is live or the guard refuses, with the reason) |
| POST | `/api/modlab/:project/stop` | | `{ ok: true }` |
| GET | `/api/modlab/:project/runs/:id` | | run record |
| GET | `/api/modlab/:project/runs/:id/log` | `?step=<index>&lines=200` | `{ lines }` |
| GET | `/api/modlab/:project/runs/:id/files/:name` | | the screenshot (image/png) |
| POST | `/api/modlab/:project/scenarios/draft` | `{ sentence }` | `{ yaml, costUsd }` |
| PUT | `/api/modlab/:project/scenarios/:file` | `{ yaml }` | `{ ok: true, file }` (validated first; 400 with the parse error) |
| POST | `/api/modlab/:project/crashes/explain` | `{ runId, index }` | `{ text, costUsd }` |

**Test bridge** (in the game, dev only, `127.0.0.1:<port>`, every request carries
`x-testbridge-token`): `GET /health`, `POST /command {as, cmd}`, `GET /players`,
`GET /player/<name>`, `POST /player/<name>/tp {to}`, `POST /screen/<name>/press {button}`,
`GET /commands` (Brigadier dump), `POST /fake/spawn {name}`, `POST /fake/remove {name}`.
The server gets the port and token through the environment variables
`CONDUIT_TESTBRIDGE_PORT` and `CONDUIT_TESTBRIDGE_TOKEN`; without the token the
bridge does not start.

## 8. Machine guard (`lib/guard`)

```js
snapshot() -> { ts, level: 'ok' | 'warn' | 'bad',
  ram:  { freeBytes, totalBytes, freePct, level },
  swap: { usedBytes, totalBytes, pct, level },
  disk: { freeBytes, totalBytes, level },
  java: [{ pid, rssBytes, kind: 'gradle-daemon' | 'mc-server' | 'mc-client' | 'other', cmd }],
  gradleDaemons, gradleLevel }
canStartBench() -> { ok, reason }      // Mod Lab asks before a run
```

Thresholds (defaults in config `guard`): disk under 5 GB warn, under 2 GB bad;
swap over 50% warn; more than 2 Gradle daemons warn; free RAM under 1.5 GB warn,
under 0.75 GB bad.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/guard` | | snapshot (sampled every 10 s) |
| GET | `/api/guard/orphans` | | `{ orphans: [{ pid, kind, cmd, ageS, rssBytes, startedAt }] }` |
| POST | `/api/guard/orphans/kill` | `{ pid, startedAt }` | `{ ok, signal }` (refuses when the pid no longer matches) |
| GET | `/api/guard/cleanup` | `?refresh=1` | `{ scannedAt, targets: [{ id, label, paths, bytes, rebuilds, kind, deep }] }` |
| POST | `/api/guard/cleanup` | `{ ids: [id] }` | `{ freedBytes, removed: [id], errors: [] }` |

## 9. Focus mode (`lib/focus`)

Reads the schedule table in `Goals/2026 Goals.md` § Focus (columns From, To,
Main, In flight), maps names through `focus.map`, and records launches.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/focus` | | `{ enabled, showAll, today, period: { from, to, main, inFlight }, main: projectId \| null, inFlight: [projectId], archive: { projects: [id], tools: [id] }, lastLaunch: { key: ms }, error }` |
| POST | `/api/focus` | `{ enabled?, showAll? }` | same as GET |

## 10. Badges

`GET /api/badges` -> `{ byProject: { <projectId>: { repo, ci: 'green' | 'red' | 'running' | null, review: 'passed' | 'notes' | 'blocked' | null } } }`.
A card gets the badges of its first repo that is a configured review repo.

## 11. The `deck` command (`bin/deck.mjs`)

```
deck review <repo> <pr>                  run a review now (exit 0 pass, 2 blocked, 3 budget/API)
deck review --check <repo> <pr>          the gate (§ 6 exit codes)
deck review --override <repo> <pr> --reason <text>
deck merge <repo> <pr> [--dry-run]       merge through the gate (0 and 3 merge; stacked PRs retargeted first)
deck ci <repo> <pr|sha|main>             run CI in a throwaway worktree (exit 0 green, 1 red, 3 error)
deck ci --status <repo> <pr|sha>         print the record (exit 0 green, 1 otherwise)
deck claude                              keys, spend, caps
deck modlab run <project> [file ...]     asks the running Deck to run a bench, follows it
```

`bin/deck.mjs` dispatches to `lib/<feature>/cli.mjs` (`export async function main(argv) -> exitCode`).
`scripts/install-cli.mjs` links it as `~/.local/bin/deck`.

## 12. The machine lock

This Mac has 8 GB. A CI run and a Mod Lab run each hold the cross-process lock
`heavy` (`lib/core/lock.mjs`) for their whole duration, so a Perdix build never
overlaps a Minecraft server. CI waits for the lock (its queue); a bench start
answers 409 with the holder's description. Hand-run heavy commands go through
`node scripts/with-heavy-lock.mjs -- <cmd>`, which takes the same lock in the
real data folder whatever `DECK_DATA` says.

## 13. Tests and checks

- `npm test` runs `node --test` over `test/**/*.test.mjs`. Every test sets
  `DECK_DATA` to a temp dir; nothing writes to the real data folder or vault.
- Every gate rule, threshold and safety refusal has a test that goes red when
  the rule is removed (a control). PR bodies list the controls and that each was
  seen red.
- `npm run check` = syntax check of every `.js`/`.mjs`, `npm test`, and the
  gateway compile smoke (`scripts/check-gateway.mjs`: compiles the sidecar to a
  temp file and starts it with the app's bare PATH on a spare port).

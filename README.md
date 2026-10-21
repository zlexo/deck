# Deck

A local control panel for your dev tools. One window to start, stop and tail
every tool you run, see each project's git state, run its CI on your own
machine, and let a pull request merge only after green CI and a Claude review.

I built it to run my own projects: a C++ voxel engine, a Java game engine and a
web platform, each with its own servers, tools and CI. Everything specific to
one setup lives in Deck's config folder, so the same code runs anyone's.

macOS. A small Node gateway (no framework) serves the pages; an optional
native window wraps it (Tauri).

![The home grid: Deck and Perdix as project cards, Perdix with its CI and review badges, the machine's meters in the header](docs/media/home.png)

## Run it

```bash
git clone https://github.com/zlexo/deck && cd deck
npm install
npm start            # http://localhost:8800
```

The first run copies the examples into Deck's config folder (a web server, a
ticker, and Deck itself as a project), so there is something to start right
away. `deck config` shows where that folder is.

## What it does

### Tools and projects

Every tool is a manifest: a JSON file in the config folder's `tools/`, or a
`deck.json` inside any project folder (the direct children of your home folder
are scanned; `scanRoots` in `state.json` changes that).

```json
{
  "id": "hello",
  "name": "Hello server",
  "group": "Examples",
  "cwd": "~/code/hello",
  "cmd": ["node", "server.js"],
  "url": "http://localhost:{port}",
  "portKey": "port",
  "config": { "port": { "type": "number", "flag": "--port", "default": 8899 } },
  "paths": { "Output": "~/code/hello/out" }
}
```

- `config` fields (`number`, `string`, `path`, `enum`, `bool`) become a CLI
  `flag` or an `env` variable; values saved in the page are passed on the next
  start. `{key}` placeholders in `url` are filled from them.
- `paths` become buttons that open the folder in Finder.
- A project card (`projects/*.json`) groups tools, repos, servers and a dev
  client, and shows each repo's branch, changes and ahead/behind.
- **`prelaunch`**: steps that must succeed before a server or dev client
  starts. A project that pulls a library from a local repository republishes it
  first, so editing the library and pressing Run never launches the old one.

### CI on your machine

`deck ci <repo> <pr|sha|main>` runs a repo's jobs, the same checks as its
GitHub workflow, in a throwaway worktree, never in your checkout. Every run is
recorded per commit, and project cards show the result.

- Runs take a machine lock, so two heavy builds never overlap.
- A run does not start under 3 GB of free disk, and a running job is stopped
  under 1 GB.
- Jobs can be limited to pull requests, to heads that change a path, or skipped
  by a label; a job's log drops lines that only show progress.

![The CI panel: a green run of a Perdix pull request, with how long it took](docs/media/ci.png)

### Reviews and the merge gate

When a pull request's CI is green, Reviews asks Claude for a review: the diff
with context, the repo's own rules files, the design documents the PR names,
and lessons from earlier reviews. Every finding must quote the real lines it is
about, and a blocker gets a second, independent look before it can block a
merge. The verdict is posted as a `review-gate` commit status.

`deck review --check <repo> <pr>` is the merge gate:

| Exit | Meaning |
|---|---|
| 0 | mergeable: green CI and a review with no open blocker, or an override |
| 2 | blocked: an open blocker and no override |
| 3 | not reviewed because of money or availability (budget, credits, the plan's limit, a missing key, rate limits, overload): allowed on CI alone, and the PR says so |
| 4 | the head or the base changed since the review |
| 5 | no green CI for this head |
| 6 | no review for this PR |
| 7 | the review failed for another reason: review again, or override with a reason |
| 1 | usage or internal error |

`deck merge <repo> <pr>` merges through the gate: pull requests stacked on this
one are retargeted to its base first (deleting a merged base branch would close
them), and the merge is pinned to the exact head the gate checked.

A finding from a real review of a Perdix pull request (fog for chunks and bodies,
about 600 lines), answered through a Claude Code login:

> **Question: app/src/main.cpp:501**
>
> ```
> vx::app::frame_fog(overlay.fog(), overlay.held_view_distance().value_or(distance.chunks));
> ```
>
> **Problem.** The wiring in `draw_frame` is not covered by any test shown: reading
> `overlay.fog()`, using the held distance, and passing `.fog = fog` to the renderer.
> `frame_fog` and the overlay accessors are unit tested, but `main.cpp` is not.
>
> **How it breaks.** Someone drops `.fog = fog` from the `render` call, or passes
> `distance.chunks` instead of the held distance. Every shown test stays green, and
> the app draws without fog, or with the wrong fog, when the memory budget lowers the view.

### The Claude kit

The one place Deck calls Claude, with two routes:

- **An API key per tool**, kept in the macOS Keychain, with monthly caps per
  tool and in total. Every call is checked against the caps first and written
  to a ledger after: tokens, cache use and cost.
- **Your Claude Code login**, through one isolated `claude -p` call: no tools,
  so the code under review cannot make it run anything; no MCP servers, no
  saved session, an empty temporary folder, and no `ANTHROPIC_*` variables.

`claude.route` in `state.json` picks: `auto` (the API while a key has money
left, then your login), `api` or `cli`. The Claude page shows which route
answers right now and every call either route made.

![The Claude page: this month's spend against the caps, the route that answers now, the login's state, and the keys](docs/media/claude.png)

### Apps from GitHub

Tools can live in their own repos. Tag a repo `deck-app` and give it a
`deck.json` at its root, and it shows up on the Apps page of every Deck that
watches its owner (`apps.sources` in `state.json`; private repos work through
your `gh` login). Install shows the exact commands first, then clones into
Deck's apps folder and runs the manifest's `install` steps; a badge appears when
the author publishes a new release, and Update brings it in. An app's own data
goes to a folder outside it, so updating or removing an app never touches what
it saved.

An app can take **content packs**: repos tagged with the app's pack topic, each
with a `pack.json`, installed and updated the same way, into a folder the app is
given (`DECK_APP_PACKS`). Publishing a new version of a pack is how its author
reaches everyone who installed it.

### Machine guard

RAM, swap and disk meters in the header, a sweep for orphaned dev processes,
and a cleanup drawer of folders that can be rebuilt (build output, package
caches, render leftovers), each with its size and what rebuilds it. Every path
is checked against its rule again right before it is deleted.

### Focus and the vault (optional)

With an Obsidian vault, Deck can capture notes into it, and **Focus** reads a
plan table from a note to put the current main project first on the home grid.
Without a vault, those parts stay hidden.

## Configuration

Deck keeps its own config outside the checkout, in
`~/Library/Application Support/Deck/config/` (`DECK_CONFIG` moves it):
`tools/`, `projects/`, `folders.json` and `state.json`.

| `state.json` key | What it sets |
|---|---|
| `scanRoots` | folders whose direct children are searched for `deck.json` |
| `repos` | the repos that get CI and reviews: name, GitHub slug, path, project card |
| `ci.repos` | each repo's jobs |
| `reviews.repos` | each repo's rules files, design source and risk globs |
| `claude.route`, `claude.caps` | the route, and the monthly caps in USD |
| `merge.authorEmail` | the merge commit's author email (else git's `user.email`) |
| `focus`, `guard` | the Focus plan; the guard's meter thresholds and an extra cleanup target |
| `apps.sources` | the GitHub owners whose `deck-app` repos the Apps page lists |

[`examples/state.example.json`](examples/state.example.json) is a worked setup
for a C++ engine and a web app.

## The `deck` command

```text
deck review <repo> <pr>                  run a review now
deck review --check <repo> <pr>          the merge gate
deck review --override <repo> <pr> --reason <text>
deck merge <repo> <pr> [--dry-run]       merge through the gate
deck ci <repo> <pr|sha|main>             run CI in a throwaway worktree
deck claude                              the route, keys, spend, last calls
deck config                              where the config is read from
deck config migrate [--dry-run]          move a checkout's config into the config folder
```

`npm run cli:install` puts `deck` on your PATH.

## The native app

`npm run app:install` builds Deck.app (Tauri; needs Rust and Bun) and installs
it. The app runs the same gateway, compiled, and opens each tool in its own
tab. If the compiled gateway is older than the checkout's code, the home page
says so instead of failing quietly.

Quitting the app (⌘Q, the Dock, closing its window) stops every tool it
started, each within its own `stopGraceMs`, then the gateway, and then anything
a tool left behind. The window goes at once; the app quits once the last tool
has stopped. A gateway that an earlier run left running (the app crashed or
was killed) is stopped the same way when the app starts again.

## Requirements

macOS, Node 22.12 or newer, git. `gh` for reviews and merges. For reviews,
either an Anthropic API key or Claude Code logged in.

## Development

- `npm test`: the unit and gateway tests (254). They run with `DECK_CLI=off`,
  so no test can reach a real `claude` CLI.
- `npm run check`: syntax of every file, the tests, and a smoke test of the
  compiled gateway with launchd's bare PATH.
- `npm run check:quit`: builds a test copy of the app (its own name and
  identifier, so it runs beside an installed Deck), quits it with stand-in
  tools running and checks that its window goes at once and nothing is left:
  no `deck-server`, the port free, no orphaned tool. `-- --stale` and
  `-- --hung` add a crashed app and a frozen gateway (the cases are in the
  header of `scripts/check-quit.mjs`).
- [`docs/v2/`](docs/v2/) holds the design contract, CI and Reviews as they
  were planned before they were built.

## License

Source-available, all rights reserved: you may read the code; using, copying or
changing it needs written permission. See [LICENSE](LICENSE).

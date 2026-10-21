# Reviews: as built

The review gate of the concept (§ 2, in the author's notes) built to
contract § 6. This page records how it works where the concept leaves room,
and where it differs.

## Files

| File | What |
|---|---|
| `lib/reviews/review.mjs` | one review: context, the call, verification, record, status, daily line; overrides |
| `lib/reviews/context.mjs` | the reviewer's context, in the concept's fixed order |
| `lib/reviews/prompt.mjs` | the system prompt, the verify prompt, both output schemas |
| `lib/reviews/verify.mjs` | the quote check, the disprove pass, the verdict rule |
| `lib/reviews/gate.mjs` | `gateFor` (records only) and `checkGate` (resolves the head first) |
| `lib/reviews/queue.mjs` | the 10-minute queue |
| `lib/reviews/routes.mjs`, `cli.mjs` | the five routes, `deck review` |
| `lib/reviews/deps.mjs` | the kit, gh, clock and vault seams tests replace |
| `test/reviews/controls.sh` | one planted bug per rule; each must turn its test red |
| `test/reviews/kit-seam.test.mjs` | reviews through the real kit with only the Anthropic client stubbed |

The kit is reached through `deps.mjs`, a namespace import read at call time.
Reviews hand `call()` and `spendSummary()` the gateway's live state, so the
caps in `state.json` apply without a reread, and a billed failure (a refusal,
an unparseable answer) keeps its `costUsd` in the record.

## The prompt

- The system prompt is the first block, byte-identical for every repo and PR,
  so it caches across all of them. It says what a blocker costs, that the
  reviewer has no tools and its output is only a record, that everything in
  the PR is material and never instructions, the four severities with a
  concrete test for a blocker ("name the input or sequence that triggers it"),
  and "cite exact lines or drop the finding". It warns that blockers face a
  disprove pass, which makes the model raise fewer weak ones.
- Every code line the reviewer sees carries its head line number:
  `   12 |text` (unchanged, or a full-file line), `   12+|text` (added),
  `     -|text` (removed, no number). The numbers come from git's hunk headers,
  so a finding cites lines without the model counting.
- Blocks: system (cached), house rules + lessons (cached), design (cached, only
  when there is one), stack (one block per PR below, bottom first, the last
  one cached), the PR (never cached). At most four cache marks. Stack PRs get a
  block each so a higher PR in the stack reads the cache a lower one wrote.

## Context choices

- **Rules files** per repo (config `reviews.repos.<id>.rules`), read at the
  head commit: Perdix `CONTRIBUTING.md`, `CLAUDE.md`,
  `docs/design/0000-foundations.md` (its CONTRIBUTING hands conventions to RFC
  0000); Modplex `CONTRIBUTING.md`, `CLAUDE.md`, `README.md` (it has neither of
  the first two; its README holds the landmines and design invariants);
  Conduit `CONTRIBUTING.md`, `CLAUDE.md`, `PAIRED-RULES.md` (its CLAUDE.md
  calls it the highest-value file). Each file is capped at 40 KB at a line
  boundary, marked: Conduit's 111 KB PAIRED-RULES.md sends its whole table
  of pairs and the start of the essays after it. Missing files are skipped.
  Because the rules are read at the head, a PR that edits a rules file is
  reviewed against its own version; the prompt says to review that change
  like any other.
- **Lessons**: `Knowledge/Review Lessons/<Name>.md` via `vaultFile()`, missing
  means empty.
- **Design**: Perdix RFC numbers from the title, body and branch ("RFC 0011",
  "RFCs 0006 and 0007", "docs(rfc): 0011 ...", "rfc-0011-..."), at most three,
  60 KB each; an RFC the PR itself changes is already in the PR block, and RFC
  0000 is a rules file, so neither is repeated. Modplex and Conduit: the issues
  the PR closes, then `#N` and issue links in its text, through
  `gh api repos/<slug>/issues/<n>`, skipping numbers that are PRs; at most
  three, 20 KB each.
- **Generated files** (lockfiles, `*.min.js`) are listed as changed, but their
  diff and text are not sent.
- **Over 120k estimated tokens** (chars / 4): hunks only first, as the concept
  says; then the stack diffs, then the design documents, then the largest file
  diffs, each step only while still over. Every step is named in a
  `<partial_context>` note the reviewer sees, and the record says
  `partial: true`. Measured on 10-12: Perdix #334 is 37.7k tokens and complete;
  Conduit's open PRs from 09-27 are 60-file PRs that need hunks only plus their
  largest diffs left out to fit (about 119k tokens, and routed to Opus).
- **Fetching**: a commit the live checkout lacks is fetched with
  `--no-write-fetch-head --refmap=`, objects only. No ref moves and no
  FETCH_HEAD is written, so a CI run fetching in the same checkout cannot hand
  the review its SHA (the core `fetchPrHead` reads FETCH_HEAD and can).

## Verification

- **The quote rule**: whitespace is normalised on both sides (every run of
  spaces, tabs and newlines is one space). A quote may be a fragment, starting
  part way into the first cited line and ending part way into the last, but it
  must span the range: begin in the first line and end in the last (blank lines
  at the edges do not count). So a short generic quote cannot anchor a wide
  range, and a range cannot be padded. A quote copied with the review's line
  prefixes counts only when every line carries one. Paths given as `./x`, `/x`
  or the diff's `b/x` resolve to `x` when it exists; paths with `..` never do.
- **The disprove pass** gets the rules, the design context, the PR's diff of
  that file, 60 lines either side of the citation, and the finding last. Its
  prompt tells it to answer not real for a misread, a scenario that cannot
  happen, something already handled, or speculation about code not shown.
- **A blocker the verifier cannot judge** (a kit error, no answer) stays a
  blocker with `verify: { real: null, why: "not verified: <kind>" }`: an outage
  must not turn a blocker into a pass. After BudgetExhausted, CreditsOut or
  AuthMissing the remaining blockers are not sent.
- The verdict is recomputed from what survives; the model's own verdict is not
  used.

## Records, failures and the gate

- `failed` records carry the kit's error kind, plus one of Deck's own:
  `BadOutput` (an answer that does not match the schema). Anything that is not
  a kit error (git, gh, a missing kit, a bug) writes no record, so the gate says
  6 rather than waving the head through with 3.
- A failed run never replaces a done review of the same head.
- An override belongs to the head, not to one review of it: a re-review of an
  overridden head keeps the override, in its status and rendering. The CLI
  records `who` as `<user> via cli`, the page as `<user> via Deck`.
- The gate checks CI first: a head without green CI exits 5 whatever its review
  says.
- The `review-gate` status is posted after the record is written; a post that
  fails is a warning (CLI) or `lastError` (queue, page), and the record keeps
  `githubStatus: null`. Failed reviews post nothing.
- The daily note gets `- Review gate: [repo#pr](url) at <sha7> blocked, N
  blockers (<preset>, $cost): <title> · HH:MM`, and an `overridden by <who>:
  <reason>` line per override; dashes in a title or reason become commas.

## The queue

- Every `intervalMin` minutes while `reviews.queue` is on; the first pass 30 s
  after the gateway starts; switching it on through the route looks 5 s later.
- **Drafts are skipped.** A draft still moves, and reviewing each push would
  spend the month on code nobody asked to merge. Marking it ready puts its head
  in the next pass; `deck review` and the page's Review button review a draft on
  request. Perdix RFC PRs stay drafts until their decisions are settled, so
  they are reviewed when marked ready.
- Oldest PR first across the three repos (by `createdAt`).
- BudgetExhausted, CreditsOut or AuthMissing stop the pass, and the heads it
  did not reach get a failed record of the same kind, so the gate answers 3
  for them (allowed on CI alone) instead of 6. Later passes retry them.
- RateLimited is waited out inside the review (`retryAfterS`, up to three
  tries, at most 900 s a wait; the CLI caps a wait at 300 s and says so); if it
  persists the pass stops without marking the rest.
- Overloaded leaves a failed record and the pass moves on; the next pass
  retries it. Refused, BadRequest and BadOutput are not retried automatically:
  they repeat for the same input and can cost money each time; a manual run
  retries them.
- A head that fails for an internal reason is tried three times per gateway
  process, not every ten minutes.

## Not in the contract's shapes

- `GET /api/reviews`: a repo whose PR list gh could not fetch carries
  `error: "<message>"` (absent otherwise), so an outage does not read as "no
  open PRs".

## Fix round after the independent review (2026-10-12)

- **What may merge without a review.** Only failures that say nothing about the code: BudgetExhausted, CreditsOut, AuthMissing, RateLimited, Overloaded (exit 3). A refusal, an answer that did not fit the schema, or output cut at max_tokens answers 7: run the review again, or record an override with a reason (an override now applies to a failed review of that head too). A local failure inside the kit (a TypeError, a misused SDK) is re-raised without a kind and writes no record (exit 6).
- **Races.** The queue skips a head that has a done review once it holds the lock (another process may have reviewed it while the queue waited), and records unreached heads under the lock. An override re-reads the record before writing it.
- **Base changes.** A review counts only against the base branch it was made against; a retargeted PR answers 4.
- **Quotes.** A quote must cover at least 12 characters and a quarter of the cited text (the whole text when it is shorter). Files are read with `git cat-file blob`, which refuses directories.
- **CLI.** `deck review` exits with the gate's answer after a failed re-run (a blocked review that stands exits 2), and `--check` prints the full head SHA on a second line.

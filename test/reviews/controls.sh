#!/usr/bin/env bash
# Controls for the review gate's rules. Each one plants a single bug in
# lib/reviews, runs the test file that guards that rule, and expects it to
# go red; then the file is restored from HEAD. A control that stays green
# means the test cannot see the bug it exists for.
#
#   bash test/reviews/controls.sh            all controls
#   bash test/reviews/controls.sh gate       only those whose name contains "gate"
#
# Refuses to run with uncommitted changes under lib/reviews: files are
# restored with git checkout, which would throw that work away.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
if [ -n "$(git status --porcelain -- lib/reviews)" ]; then
  echo "controls: commit lib/reviews first (each planted file is restored from HEAD)"
  exit 2
fi
only=${1:-}
log=$(mktemp -t deck-controls)
# A planted bug can leave work running after its test file has cleaned up
# (a review the queue started still takes its lock), recreating an empty
# temp folder. Folders the run creates are removed at the end.
tmpdir=${TMPDIR:-/tmp}
before=$(ls -d "$tmpdir"/deck-rv-* 2>/dev/null | sort)
red=0; bad=0

control() { # name file testfile from to
  local name=$1 file=$2 test=$3
  if [ -n "$only" ] && [[ $name != *"$only"* ]]; then return; fi
  if ! FROM=$4 TO=$5 perl -0pi -e '$f = $ENV{FROM}; $t = $ENV{TO}; s/\Q$f\E/$t/ or die "pattern not found\n"' "$file" 2>"$log"; then
    echo "SETUP  $name: the bug could not be planted in $file ($(cat "$log"))"
    bad=$((bad + 1)); git checkout -q -- "$file"; return
  fi
  if node --test --test-reporter=spec "$test" >"$log" 2>&1; then
    echo "GREEN  $name: planted in $file and $test still passed"
    bad=$((bad + 1))
  else
    local first
    first=$(grep -m1 '^✖' "$log" | sed 's/^✖ //; s/ ([0-9.]*ms)$//')
    echo "red    $name: $first"
    red=$((red + 1))
  fi
  git checkout -q -- "$file"
}

T=test/reviews
# The gate, one control per exit code and the override's scope.
control gate-5-ci-first        lib/reviews/gate.mjs     $T/gate.test.mjs   "if (!isGreen(repo, sha)) return out(5," "if (false) return out(5,"
control gate-4-head-changed    lib/reviews/gate.mjs     $T/gate.test.mjs   "if (older) return out(4," "if (false) return out(4,"
control gate-3-failed-record   lib/reviews/gate.mjs     $T/gate.test.mjs   "if (rec.status !== 'done') {" "if (false) {"
control gate-2-blocked         lib/reviews/gate.mjs     $T/gate.test.mjs   "if (isBlocked(rec)) {" "if (false) {"
control gate-0-override        lib/reviews/gate.mjs     $T/gate.test.mjs   "const ov = overrideFor(repo, pr, sha);" "const ov = null;"
control gate-override-scope    lib/reviews/records.mjs  $T/gate.test.mjs   '`${pr}-${sha}.override.json`' '`${pr}.override.json`'
control gate-1-error           lib/reviews/gate.mjs     $T/gate.test.mjs   "catch (e) { return { code: 1," "catch (e) { return { code: 6,"
# Verification: each drop rule, the fragment rule, the disprove pass, the verdict.
control verify-missing-file    lib/reviews/verify.mjs   $T/verify.test.mjs "if (text == null) { dropped.push" "if (text == null && false) { dropped.push"
control verify-line-range      lib/reviews/verify.mjs   $T/verify.test.mjs "|| f.line_end > lines.length" "|| false"
control verify-quote-mismatch  lib/reviews/verify.mjs   $T/verify.test.mjs "if (!m.ok) { dropped.push" "if (false) { dropped.push"
control verify-quote-span      lib/reviews/verify.mjs   $T/verify.test.mjs "if (i < firstEnd && i + q.length > lastStart) return" "if (true) return"
control verify-demotion        lib/reviews/verify.mjs   $T/verify.test.mjs "if (!ans.real) {" "if (false) {"
control verify-verdict-rule    lib/reviews/verify.mjs   $T/verify.test.mjs "if (findings.some(f => f.severity === 'blocker')) return 'blocked';" ""
control review-verdict-recomputed lib/reviews/review.mjs $T/review.test.mjs "rec.verdict = computeVerdict(kept);" "rec.verdict = out.verdict;"
# Failed reviews post nothing; a failed run keeps a done review; only kit errors leave a record.
control review-failed-posts-nothing lib/reviews/review.mjs $T/review.test.mjs "const out = writeFailed(rec, e, d);" "const out = writeFailed(rec, e, d); await postStatus(repo, sha, { state: 'failure', description: 'blocked' }, d);"
control review-done-kept       lib/reviews/review.mjs   $T/review.test.mjs "if (existing && existing.status === 'done') return" "if (false) return"
control review-non-kit-errors  lib/reviews/review.mjs   $T/review.test.mjs "      if (!e || !e.kind) throw e;
      paid(rec, e);" "      if (!e) throw e;
      paid(rec, e);"
control review-risky-routing   lib/reviews/review.mjs   $T/review.test.mjs "const preset = risky.length ? 'review.risky' : 'review.normal';" "const preset = 'review.normal';"
control review-lock            lib/reviews/review.mjs   $T/review.test.mjs "const l = acquireLock('review', info);" "const l = { release() {} };"
control review-override-needs-block lib/reviews/review.mjs $T/review.test.mjs "if (!failed && !isBlocked(rec)) throw" "if (false) throw"
control review-keeps-override  lib/reviews/review.mjs   $T/review.test.mjs "const st = statusFor(rec, override, blocked);" "const st = statusFor(rec, null, blocked);"
control review-rate-limit-wait lib/reviews/review.mjs   $T/review.test.mjs "if (!e || e.kind !== 'RateLimited' || i >= attempts || wait > maxWaitS) throw e;" "throw e;"
# The seam with the real kit.
control kit-gets-live-state    lib/reviews/review.mjs   $T/kit-seam.test.mjs "schema: REVIEW_SCHEMA, ref, state }, rateLimit);" "schema: REVIEW_SCHEMA, ref }, rateLimit);"
control kit-billed-failure     lib/reviews/review.mjs   $T/kit-seam.test.mjs "      paid(rec, e); // a refusal or an unparseable answer was still billed" ""
# The queue's stop conditions and choices.
control queue-stops-on-budget  lib/reviews/queue.mjs    $T/queue.test.mjs  "const STOP_PASS = new Set(['BudgetExhausted', 'CreditsOut', 'AuthMissing']);" "const STOP_PASS = new Set([]);"
control queue-marks-the-rest   lib/reviews/queue.mjs    $T/queue.test.mjs  "for (const rest of list.slice(i + 1)) markNotReviewed(rest, res.error, d);" ""
control queue-overloaded-moves-on lib/reviews/queue.mjs $T/queue.test.mjs  "new Set(['BudgetExhausted', 'CreditsOut', 'AuthMissing']);" "new Set(['BudgetExhausted', 'CreditsOut', 'AuthMissing', 'Overloaded']);"
control queue-rate-limit-stops lib/reviews/queue.mjs    $T/queue.test.mjs  "if (res.error.kind === 'RateLimited') {" "if (false) {"
control queue-skips-drafts     lib/reviews/queue.mjs    $T/queue.test.mjs  "if (p.isDraft || " "if (false || "
control queue-needs-green-ci   lib/reviews/queue.mjs    $T/queue.test.mjs  "if (!isGreen(repo.id, sha)) continue;" ""
control queue-refusal-not-retried lib/reviews/queue.mjs $T/queue.test.mjs  "const RETRY = new Set(['BudgetExhausted'," "const RETRY = new Set(['Refused', 'BudgetExhausted',"
control queue-internal-cap     lib/reviews/queue.mjs    $T/queue.test.mjs  "const MAX_INTERNAL_FAILURES = 3;" "const MAX_INTERNAL_FAILURES = 1000;"
control queue-off-means-off    lib/reviews/queue.mjs    $T/queue.test.mjs  "if (cfg.queue && !passing) {" "if (!passing) {"
# Context: rules at the head, partial mode, cache marks, no FETCH_HEAD.
control context-rules-at-head  lib/reviews/context.mjs  $T/context.test.mjs "const rules = await readRules(repo, headSha);" "const rules = await readRules(repo, baseSha);"
control context-partial        lib/reviews/context.mjs  $T/context.test.mjs "if (tokensOf(blocks) > LIMITS.tokens && fullCount) {" "if (false) {"
control context-pr-not-cached  lib/reviews/context.mjs  $T/context.test.mjs "headSha, changed, chunks, files, { hunksOnly, notes }), cache: false });" "headSha, changed, chunks, files, { hunksOnly, notes }), cache: true });"
control context-no-fetch-head  lib/reviews/context.mjs  $T/context.test.mjs "'--no-write-fetch-head', " ""
control context-design-skips-changed lib/reviews/context.mjs $T/context.test.mjs "if (!p || changedPaths.has(p) || repo.rules.includes(p)) continue;" "if (!p) continue;"
control glob-star-one-segment  lib/reviews/glob.mjs     $T/glob.test.mjs   "re += '[^/]*';" "re += '.*';"
# Routes and the command.
control routes-queue-saves     lib/reviews/routes.mjs   $T/routes.test.mjs "ctx.saveState(next);" ""
control routes-list-error-shown lib/reviews/routes.mjs  $T/routes.test.mjs "...(lists[i].error ? { error: lists[i].error } : {})," ""
control cli-check-exit-code    lib/reviews/cli.mjs      $T/cli.test.mjs    "return g.code;" "return g.code ? 1 : 0;"

rm -f "$log"
after=$(ls -d "$tmpdir"/deck-rv-* 2>/dev/null | sort)
comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | while read -r d; do [ -n "$d" ] && rm -rf "$d"; done
if [ -n "$(git status --porcelain -- lib/reviews)" ]; then echo "controls: lib/reviews is not clean afterwards"; exit 2; fi
echo "controls: $red red, $bad not red"
[ "$bad" -eq 0 ]

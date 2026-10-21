// One review, start to finish: context, the review call, verification, the
// record, the GitHub status and the daily note. Contract § 6.
import os from 'node:os';
import { acquireLock, lockHolder } from '../core/lock.mjs';
import { tildify } from '../core/paths.mjs';
import { deps as getDeps, kitCall, presetModel } from './deps.mjs';
import { reviewRepo, reviewConfig } from './config.mjs';
import { assembleContext, capText } from './context.mjs';
import { numberLines, splitLines } from './diff.mjs';
import { riskyPaths } from './glob.mjs';
import { REVIEW_SCHEMA, VERIFY_SCHEMA, VERIFY_PROMPT, VERDICTS } from './prompt.mjs';
import { verifyLocal, verifyBlockers, computeVerdict, isBlocked, openBlockers } from './verify.mjs';
import { reviewFor, overrideFor, writeReview, writeOverride, reviewMdPath } from './records.mjs';
import { renderMarkdown } from './render.mjs';
import { fetchPr, listOpenPrs, statusFor, postStatus, prUrl } from './github.mjs';
import { AVAILABILITY } from './gate.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
export const short = sha => String(sha || '').slice(0, 7);

// Errors a caller shows as usage problems (exit 1, HTTP 400/409), not crashes.
export class ReviewError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ReviewError'; this.status = status; }
}

// The review this process is running, for the page.
let current = null;
export function runningReview() {
  if (current) return { repo: current.repo, pr: current.pr };
  const h = lockHolder('review');
  return h && h.repo ? { repo: h.repo, pr: h.pr } : null;
}

// One review at a time across processes (lock `review`). Waits up to
// waitMs for a holder to finish; 0 means refuse at once.
async function takeLock(info, waitMs, d, opts) {
  const until = d.now() + waitMs;
  for (;;) {
    const l = acquireLock('review', info);
    if (l) return l;
    const h = lockHolder('review');
    if (d.now() >= until || (opts.signal && opts.signal.aborted)) {
      throw new ReviewError(`a review is already running${h && h.repo ? ` (${h.repo}#${h.pr}, pid ${h.pid})` : ''}`, 409);
    }
    if (opts.onWait) opts.onWait(h);
    await d.sleep(1000, { unref: !!opts.background, signal: opts.signal });
  }
}

// A kit call that waits out a 429 with retry-after: up to `attempts` calls,
// never longer than maxWaitS for one wait. Other kit errors go to the caller.
async function callKit(d, req, { attempts = 2, maxWaitS = 300, background = false, signal, onRateLimited } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await kitCall(d)(req);
    } catch (e) {
      const wait = Number(e && e.retryAfterS) > 0 ? Number(e.retryAfterS) : 60;
      if (!e || e.kind !== 'RateLimited' || i >= attempts || wait > maxWaitS) throw e;
      if (onRateLimited) onRateLimited(wait);
      const slept = await d.sleep(wait * 1000, { unref: background, signal });
      if (slept === false) throw e; // stopped while waiting
    }
  }
}

// En and em dashes in a title or reason become a comma: the vault's house
// style has none. Built from char codes so this source holds no dash either.
const DASH = new RegExp(`\\s*[${String.fromCharCode(0x2013, 0x2014)}]\\s*`, 'g');
const clean = s => String(s == null ? '' : s).replace(DASH, ', ').replace(/\s+/g, ' ').trim();
const hhmm = ts => { const t = new Date(ts); return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };

function daily(d, line, problems) {
  try { d.appendDaily(line); } catch (e) { problems.push(`daily note: ${e.message}`); }
}

function verifyMessage(f, ctx, info, repo) {
  const parts = [ctx.rulesText];
  if (ctx.designText) parts.push(ctx.designText);
  const diff = ctx.chunkFor(f.file);
  parts.push(`<pull_request repo="${repo.slug}" number="${info.number}" title="${clean(info.title).replace(/"/g, '&quot;')}">\n<diff_of_file path="${f.file}">\n${diff ? capText(diff, 30 * 1024).text : '(this file is not changed by the pull request)'}\n</diff_of_file>\n</pull_request>`);
  return { parts, file: f.file };
}

// What a call cost, answered or not: the kit puts costUsd and the request id
// on its errors too when the API billed the request.
function paid(rec, r) {
  if (!r) return;
  rec.costUsd = Math.round((rec.costUsd + (Number(r.costUsd) || 0)) * 1e6) / 1e6;
  if (r.requestId) rec.requestIds.push(r.requestId);
}

// Fields every record carries, done or failed.
function baseRecord(repo, info, sha, preset, risky, ctx, startedAt) {
  return {
    v: 1, repo: repo.id, slug: repo.slug, pr: info.number, sha,
    title: info.title || '', base: info.baseRefName || '', head: info.headRefName || '',
    status: 'done', error: null, verdict: null, summary: '', findings: [], dropped: [],
    preset, model: null, risky, partial: !!(ctx && ctx.meta.partial),
    costUsd: 0, requestIds: [], startedAt, finishedAt: null,
    context: ctx
      ? { rules: ctx.meta.rules, lessons: ctx.meta.lessons, design: ctx.meta.design, stack: ctx.meta.stack, tokensEst: ctx.meta.tokensEst }
      : { rules: [], lessons: '', design: [], stack: [], tokensEst: 0 },
    githubStatus: null,
  };
}

// A failed record never replaces a done review of the same head: a re-run
// that hits the budget must not erase a verdict.
export function writeFailed(rec, err, d) {
  const existing = reviewFor(rec.repo, rec.pr, rec.sha);
  const failed = { ...rec, status: 'failed', error: { kind: err.kind, message: String(err.message || '') }, verdict: null, finishedAt: d.now() };
  if (existing && existing.status === 'done') return { record: failed, written: false };
  writeReview(failed, renderMarkdown(failed));
  return { record: failed, written: true };
}

// Runs one review. Resolves to { record, written, error, problems, meta }:
// `error` is the kit error ({kind, message}) when the kit could not review,
// and the record is then a failed one. Anything else (git, gh, a bug) throws
// and writes nothing, so the gate keeps saying "not reviewed".
export async function runReview(opts) {
  const { repoId, pr, state, lockWaitMs = 0, signal, background = false, onWait, onRateLimited } = opts;
  const d = getDeps(opts.deps);
  const repo = reviewRepo(repoId, state);
  if (!repo) throw new ReviewError(`unknown repo: ${repoId}`);
  if (!Number.isInteger(pr) || pr <= 0) throw new ReviewError(`bad PR number: ${pr}`);
  if (opts.sha != null && !SHA_RE.test(opts.sha)) throw new ReviewError(`bad head SHA: ${opts.sha}`);
  const cfg = reviewConfig(state);
  const rateLimit = { attempts: 3, maxWaitS: 900, ...(opts.rateLimit || {}), background, signal, onRateLimited };

  const lock = await takeLock({ repo: repo.id, pr, what: `review ${repo.id}#${pr}` }, lockWaitMs, d, { signal, background, onWait });
  current = { repo: repo.id, pr };
  const startedAt = d.now();
  const problems = [];
  try {
    const info = opts.prInfo || await fetchPr(repo, pr, d);
    const sha = opts.sha || info.headRefOid;
    if (!SHA_RE.test(sha || '')) throw new Error(`no head SHA for ${repo.id}#${pr}`);
    // The queue lists its heads before it waits for the lock; a review of the
    // same head (the CLI, the page) may have finished meanwhile. Paying for a
    // second one would also replace that verdict.
    if (opts.skipIfDone) {
      const existing = reviewFor(repo.id, pr, sha);
      if (existing && existing.status === 'done') return { record: existing, written: false, skipped: true, error: null, problems, meta: null };
    }
    if (!SHA_RE.test(info.baseRefOid || '')) throw new Error(`no base SHA for ${repo.id}#${pr}`);
    let openPrs = [];
    try { openPrs = await listOpenPrs(repo, d); } catch (e) { problems.push(`stack context skipped: ${e.message}`); }
    const ctx = await assembleContext({ repo, pr: info, headSha: sha, openPrs, deps: d });
    const risky = riskyPaths(ctx.changedPaths, repo.risk);
    const preset = risky.length ? 'review.risky' : 'review.normal';
    const ref = `${repo.id}#${pr}@${short(sha)}`;
    const rec = baseRecord(repo, info, sha, preset, risky, ctx, startedAt);

    let r;
    try {
      r = await callKit(d, { tool: 'reviews', preset, system: ctx.system, messages: ctx.messages, schema: REVIEW_SCHEMA, ref, state }, rateLimit);
    } catch (e) {
      if (!e || !e.kind) throw e;
      paid(rec, e); // a refusal or an unparseable answer was still billed
      rec.model = presetModel(d, preset);
      const out = writeFailed(rec, e, d);
      return { ...out, error: { kind: e.kind, message: String(e.message || '') }, problems, meta: ctx.meta };
    }
    rec.model = r.model || presetModel(d, preset);
    paid(rec, r);
    const out = r.json;
    if (!out || typeof out !== 'object' || !Array.isArray(out.findings) || !VERDICTS.includes(out.verdict)) {
      const err = { kind: 'BadOutput', message: `the review answer did not match the schema (stop reason ${r.stopReason || 'unknown'})` };
      const res = writeFailed(rec, err, d);
      return { ...res, error: err, problems, meta: ctx.meta };
    }

    const { kept, dropped } = await verifyLocal(out.findings, p => ctx.readHead(p));
    await verifyBlockers(kept, async f => {
      const m = verifyMessage(f, ctx, info, repo);
      const text = await ctx.readHead(f.file);
      const from = Math.max(1, f.line_start - 60), to = f.line_end + 60;
      const n = splitLines(text).length;
      m.parts.push(`<code path="${f.file}" lines="${from}-${Math.min(n, to)}">\n${numberLines(text, from, to)}\n</code>`);
      m.parts.push(`<finding>\nseverity: blocker\nfile: ${f.file}\nlines: ${f.line_start}-${f.line_end}\nquote:\n${f.quote}\nproblem: ${f.problem}\nfailure_scenario: ${f.failure_scenario}\nsuggestion: ${f.suggestion}\n</finding>`);
      let v;
      try {
        v = await callKit(d, {
          tool: 'reviews', preset: 'review.verify', system: [{ text: VERIFY_PROMPT }],
          messages: [{ role: 'user', content: m.parts.map(text => ({ type: 'text', text })) }],
          schema: VERIFY_SCHEMA, ref: `${ref} verify ${f.file}:${f.line_start}`, state,
        }, { ...rateLimit, attempts: 2 });
      } catch (e) { paid(rec, e); throw e; }
      paid(rec, v);
      return v.json;
    });
    rec.findings = kept;
    rec.dropped = dropped;
    rec.verdict = computeVerdict(kept);
    rec.summary = String(out.summary || '');
    rec.finishedAt = d.now();
    // An override belongs to the head, not to one review of it: a re-run of
    // an overridden head keeps it, in the rendering and in the status.
    const override = overrideFor(repo.id, pr, sha);
    writeReview(rec, renderMarkdown(rec, override));

    // The status says pass or blocked, nothing more. Posted after the record
    // exists, so a GitHub outage cannot lose a review.
    const blocked = isBlocked(rec);
    if (cfg.githubStatus) {
      const st = statusFor(rec, override, blocked);
      try {
        rec.githubStatus = await postStatus(repo, sha, st, d);
        writeReview(rec, renderMarkdown(rec, override));
      } catch (e) { problems.push(`GitHub status not posted: ${e.message}`); }
    }
    if (blocked) {
      const n = openBlockers(rec).length;
      daily(d, `- Review gate: [${repo.id}#${pr}](${prUrl(repo, pr, info)}) at ${short(sha)} blocked, ${n} blocker${n === 1 ? '' : 's'} (${preset}, $${rec.costUsd.toFixed(2)}): ${clean(rec.title)} · ${hhmm(rec.finishedAt)}`, problems);
    }
    return { record: rec, written: true, error: null, problems, meta: ctx.meta };
  } finally {
    current = null;
    lock.release();
  }
}

// An override unblocks one exact head: the head's review must be done and
// blocked. It is recorded with who and why, the status flips to "blocked,
// overridden", and the daily note gets a line.
export async function applyOverride({ repoId, pr, sha, reason, who, state, deps: over }) {
  const d = getDeps(over);
  const repo = reviewRepo(repoId, state);
  if (!repo) throw new ReviewError(`unknown repo: ${repoId}`);
  if (!Number.isInteger(pr) || pr <= 0) throw new ReviewError(`bad PR number: ${pr}`);
  if (!SHA_RE.test(sha || '')) throw new ReviewError(`bad head SHA: ${sha}`);
  const why = String(reason || '').trim();
  if (!why) throw new ReviewError('an override needs a reason');
  const rec = reviewFor(repo.id, pr, sha);
  if (!rec) throw new ReviewError(`${repo.id}#${pr} has no review of ${short(sha)}: nothing to override`, 409);
  const failed = rec.status !== 'done';
  if (failed && AVAILABILITY.has(rec.error && rec.error.kind)) throw new ReviewError(`the review of ${short(sha)} could not run (${rec.error.kind}); the gate already allows it on CI alone`, 409);
  if (!failed && !isBlocked(rec)) throw new ReviewError(`the review of ${short(sha)} is not blocked: nothing to override`, 409);
  const problems = [];
  const override = { who: String(who || `${os.userInfo().username}`), reason: why, ts: d.now() };
  writeOverride(repo.id, pr, sha, override);
  // A failed review posted no status; an overridden blocked one says so.
  let posted = null;
  if (!failed && reviewConfig(state).githubStatus) {
    try { posted = await postStatus(repo, sha, statusFor(rec, override, true), d); }
    catch (e) { problems.push(`GitHub status not posted: ${e.message}`); }
  }
  // Read the record again: a review of this head may have finished while the
  // status was posted, and writing the copy read above would replace it.
  const now = reviewFor(repo.id, pr, sha) || rec;
  if (posted && now.finishedAt === rec.finishedAt) now.githubStatus = posted;
  writeReview(now, renderMarkdown(now, override));
  daily(d, `- Review gate: [${repo.id}#${pr}](${prUrl(repo, pr)}) at ${short(sha)} overridden by ${clean(override.who)}: ${clean(why)} · ${hhmm(override.ts)}`, problems);
  return { override, record: rec, problems };
}

export const recordMdPath = (repo, pr, sha) => tildify(reviewMdPath(repo, pr, sha));
export { overrideFor };

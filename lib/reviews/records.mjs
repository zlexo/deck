// Review records and overrides (contract § 6). The runner writes them; the
// gate, the badges and the pages read them through here.
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from '../core/paths.mjs';
import { readJson, listFiles, writeJsonAtomic, writeTextAtomic } from '../core/files.mjs';

export const reviewsDir = repo => dataPath('reviews', repo);
export const reviewPath = (repo, pr, sha) => dataPath('reviews', repo, `${pr}-${sha}.json`);
export const reviewMdPath = (repo, pr, sha) => dataPath('reviews', repo, `${pr}-${sha}.md`);
export const overridePath = (repo, pr, sha) => dataPath('reviews', repo, `${pr}-${sha}.override.json`);

const NAME = /^(\d+)-([0-9a-f]{40})\.json$/;
const SHA = /^[0-9a-f]{40}$/;
const REPO_ID = /^[a-z0-9][a-z0-9_-]*$/;

export function reviewFor(repo, pr, sha) { return readJson(reviewPath(repo, pr, sha)); }
export function overrideFor(repo, pr, sha) { return readJson(overridePath(repo, pr, sha)); }

// Every record of a repo (optionally one PR's), newest first.
export function listReviews(repo, { pr, limit = 200 } = {}) {
  const out = [];
  for (const f of listFiles(reviewsDir(repo), '.json')) {
    const m = NAME.exec(path.basename(f));
    if (!m || (pr != null && Number(m[1]) !== Number(pr))) continue;
    const r = readJson(f);
    if (r) out.push(r);
  }
  return out.sort((a, b) => (b.finishedAt || b.startedAt || 0) - (a.finishedAt || a.startedAt || 0)).slice(0, limit);
}

export function latestRecord(repo) { return listReviews(repo, { limit: 1 })[0] || null; }

export function readMarkdown(repo, pr, sha) {
  try { return fs.readFileSync(reviewMdPath(repo, pr, sha), 'utf8'); } catch { return null; }
}

// The writers build file names from their arguments, so they refuse anything
// that is not a plain repo id, a PR number and a full SHA: a route parameter
// must never become a path outside the reviews folder.
function assertKey(repo, pr, sha) {
  if (!REPO_ID.test(String(repo))) throw new Error(`bad repo id: ${repo}`);
  if (!Number.isInteger(pr) || pr <= 0) throw new Error(`bad PR number: ${pr}`);
  if (!SHA.test(String(sha))) throw new Error(`bad head SHA: ${sha}`);
}

// The record and its rendering are written together; readers poll the JSON.
export function writeReview(record, markdown) {
  assertKey(record.repo, record.pr, record.sha);
  writeJsonAtomic(reviewPath(record.repo, record.pr, record.sha), record);
  if (markdown != null) writeTextAtomic(reviewMdPath(record.repo, record.pr, record.sha), markdown);
}

export function writeOverride(repo, pr, sha, override) {
  assertKey(repo, pr, sha);
  writeJsonAtomic(overridePath(repo, pr, sha), override);
}

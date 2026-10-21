// Reading CI records (contract § 5). The CI runner writes them; Reviews, the
// badges and the gate read them through here, so there is one reader.
import { dataPath } from '../core/paths.mjs';
import { readJson, listFiles } from '../core/files.mjs';

export const ciDir = repo => dataPath('ci', repo);
export const ciRecordPath = (repo, sha) => dataPath('ci', repo, `${sha}.json`);

export function recordFor(repo, sha) {
  if (!repo || !/^[0-9a-f]{40}$/.test(sha || '')) return null;
  return readJson(ciRecordPath(repo, sha));
}

// Newest first by start time.
export function listRecords(repo, { limit = 20 } = {}) {
  return listFiles(ciDir(repo), '.json')
    .map(f => readJson(f))
    .filter(r => r && r.sha)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, limit);
}

export function latestRecord(repo) { return listRecords(repo, { limit: 1 })[0] || null; }

export function isGreen(repo, sha) {
  const r = recordFor(repo, sha);
  return !!r && r.status === 'green';
}

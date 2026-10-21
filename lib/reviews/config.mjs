// Reviews config: defaults here, overridden by state.json's `reviews` section
// (contract § 2). Repo identity (slug, path, name) comes from the core registry;
// what a review reads and how it routes comes from here.
import { configSection, repos as coreRepos } from '../core/config.mjs';

// The queue runs every 10 minutes and a review-gate commit status is posted;
// which repos are reviewed, and how, is state.json's business.
export const DEFAULTS = {
  queue: true,
  intervalMin: 10,
  githubStatus: true,
  // Per repo: rules files, design source and risk globs, e.g.
  //   "perdix": { "rules": ["CONTRIBUTING.md"], "design": "rfc", "risk": ["engine/core/src/job*"] }
  // A configured repo without an entry gets FALLBACK_RULES, issues, no risk globs.
  repos: {},
};

const FALLBACK_RULES = ['CONTRIBUTING.md', 'CLAUDE.md'];

export function reviewConfig(state) {
  const c = configSection('reviews', DEFAULTS, state);
  const n = Number(c.intervalMin);
  return { ...c, queue: c.queue !== false, githubStatus: c.githubStatus !== false, intervalMin: Number.isFinite(n) && n >= 1 ? n : DEFAULTS.intervalMin };
}

// One reviewed repo: the registry entry plus its rules files, design source
// ('rfc' reads docs/design/NNNN-*.md, 'issues' reads linked GitHub issues)
// and risk globs.
export function reviewRepo(id, state) {
  const base = coreRepos(state)[id];
  if (!base) return null;
  const r = (reviewConfig(state).repos || {})[id] || {};
  return {
    ...base,
    rules: Array.isArray(r.rules) ? r.rules : FALLBACK_RULES,
    design: r.design === 'rfc' ? 'rfc' : 'issues',
    risk: Array.isArray(r.risk) ? r.risk : [],
  };
}

export function reviewRepos(state) {
  return Object.keys(coreRepos(state)).map(id => reviewRepo(id, state)).filter(Boolean);
}

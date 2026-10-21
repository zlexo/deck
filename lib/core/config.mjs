// Config = defaults in code, overridden by state.json (in Deck's config folder,
// see paths.mjs; a checkout from before the move still works).
// Only the gateway writes state.json (ctx.saveState): it keeps the file in
// memory and rewrites it whole, so a second writer would be silently undone.
import { configPath } from './paths.mjs';
import { readJson } from './files.mjs';

// The repos that get CI records and reviews: state.json's `repos` section,
// one entry per repo, e.g.
//   "perdix": { "name": "Perdix", "slug": "you/perdix", "path": "~/code/perdix", "project": "perdix" }
// where `project` is the Deck card it belongs to. None by default.
export const REPOS = {};

export function readStateFile() { return readJson(configPath('state.json'), {}) || {}; }

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Objects merge key by key; arrays and scalars replace.
export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(base[k]) && isObj(v) ? deepMerge(base[k], v) : v;
  return out;
}

// `state` is the gateway's live object; the CLI leaves it out and the file is read.
export function configSection(name, defaults, state) {
  const s = state || readStateFile();
  return deepMerge(defaults, isObj(s[name]) ? s[name] : {});
}

export function repos(state) {
  const all = configSection('repos', REPOS, state);
  return Object.fromEntries(Object.entries(all).map(([id, r]) => [id, { id, ...r }]));
}
export function repo(id, state) { return repos(state)[id] || null; }

// Deck Apps: the catalog. Every repo tagged `deck-app` on the owners listed in
// state.json's apps.sources, with the deck.json at its root that makes it an
// app. Read through gh, so private repos work for whoever gh is logged in as,
// and public ones for everyone. Cached ten minutes.
import { ghJson } from '../core/gh.mjs';
import { configSection } from '../core/config.mjs';

export const TOPIC = 'deck-app';
export const DEFAULTS = { sources: [] };
const TTL = 10 * 60e3;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function appsConfig(state) {
  const c = configSection('apps', DEFAULTS, state);
  const sources = Array.isArray(c.sources) ? c.sources.filter(s => typeof s === 'string' && OWNER.test(s)) : [];
  return { ...c, sources };
}

const isArgv = c => Array.isArray(c) && c.length > 0 && c.every(a => typeof a === 'string');

// Why a deck.json is not an app's manifest, or null when it is one.
export function manifestProblem(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'deck.json is not a JSON object';
  if (!ID.test(m.id || '')) return 'deck.json needs an id: lowercase letters, digits and dashes';
  if (!m.name) return 'deck.json needs a name';
  if (!isArgv(m.cmd)) return 'deck.json needs a cmd';
  if (m.install != null && !(Array.isArray(m.install) && m.install.every(isArgv))) return 'install must be a list of commands, each a list of strings';
  if (m.packs != null && !(typeof m.packs === 'string' && ID.test(m.packs))) return 'packs must be a topic name';
  return null;
}

async function fileJson(gh, full, branch, file) {
  const r = await gh(['api', `repos/${full}/contents/${file}?ref=${encodeURIComponent(branch)}`]);
  return JSON.parse(Buffer.from(r.content || '', 'base64').toString('utf8'));
}

// The newest version: the latest release's tag if the repo has releases, else
// the default branch's head.
export async function latestVersion(gh, full, branch) {
  try {
    const rel = await gh(['api', `repos/${full}/releases/latest`]);
    if (rel && rel.tag_name) return { tag: rel.tag_name, sha: null };
  } catch (e) { if (!/404|Not Found/i.test(e.message)) throw e; }
  const c = await gh(['api', `repos/${full}/commits/${encodeURIComponent(branch)}`]);
  return { tag: null, sha: c.sha };
}

export async function searchTopic(gh, owner, topic) {
  return gh(['search', 'repos', '--owner', owner, '--topic', topic, '--limit', '100',
    '--json', 'name,fullName,description,updatedAt,isPrivate,url,defaultBranch,isArchived']);
}

// Repos with `topic` on every source, each with its manifest (`file`) checked
// by `problemOf`, and its latest version.
export async function listTagged({ sources, topic, file, problemOf, gh }) {
  const out = [], errors = [];
  for (const owner of sources) {
    let found;
    try { found = await searchTopic(gh, owner, topic); }
    catch (e) { errors.push(`${owner}: ${e.message}`); continue; }
    for (const r of found) {
      if (r.isArchived) continue;
      const e = { repo: r.fullName, owner, name: r.name, description: r.description || '', updatedAt: r.updatedAt,
        private: !!r.isPrivate, url: r.url, branch: r.defaultBranch, manifest: null, problem: null, latest: null };
      try {
        const m = await fileJson(gh, r.fullName, r.defaultBranch, file);
        e.problem = problemOf(m);
        if (!e.problem) e.manifest = m;
      } catch (err) {
        e.problem = /404|Not Found/i.test(err.message) ? `no ${file} at the repo root` : `${file} unreadable: ${err.message}`;
      }
      if (e.manifest) {
        try { e.latest = await latestVersion(gh, r.fullName, r.defaultBranch); }
        catch (err) { e.problem = `no version: ${err.message}`; e.manifest = null; }
      }
      out.push(e);
    }
  }
  // One id, one app: the first source wins and the others say why they are hidden.
  const seen = new Map();
  for (const e of out) {
    if (!e.manifest) continue;
    if (seen.has(e.manifest.id)) { e.problem = `id '${e.manifest.id}' is already used by ${seen.get(e.manifest.id)}`; e.manifest = null; }
    else seen.set(e.manifest.id, e.repo);
  }
  return { entries: out, errors };
}

// Why a pack.json is not a pack for `appId`, or null when it is one.
export function packProblem(p, appId) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'pack.json is not a JSON object';
  if (!ID.test(p.id || '')) return 'pack.json needs an id: lowercase letters, digits and dashes';
  if (!p.title) return 'pack.json needs a title';
  if (p.app !== appId) return `pack.json is for '${p.app || 'no app'}', not '${appId}'`;
  return null;
}

let cache = null;
const packCache = new Map();
export function clearCatalog() { cache = null; packCache.clear(); }

// The packs for one app: repos tagged with the app's pack topic on the same
// owners, each with a pack.json naming that app.
export async function packCatalog({ state, appId, topic, gh = ghJson, now = Date.now(), refresh = false } = {}) {
  const { sources } = appsConfig(state);
  const key = `${appId}|${topic}|${sources.join(',')}`;
  const hit = packCache.get(key);
  if (!refresh && hit && now - hit.at < TTL) return hit.value;
  const { entries, errors } = await listTagged({ sources, topic, file: 'pack.json', problemOf: m => packProblem(m, appId), gh });
  const value = { packs: entries, errors, at: now };
  packCache.set(key, { at: now, value });
  return value;
}

export async function catalog({ state, gh = ghJson, now = Date.now(), refresh = false } = {}) {
  const { sources } = appsConfig(state);
  const key = sources.join(',');
  if (!refresh && cache && cache.key === key && now - cache.at < TTL) return cache.value;
  const { entries, errors } = await listTagged({ sources, topic: TOPIC, file: 'deck.json', problemOf: manifestProblem, gh });
  const value = { sources, apps: entries, errors, at: now };
  cache = { at: now, key, value };
  return value;
}

// Focus mode (concept § 6, contract § 9). The home grid follows the Focus
// plan: the current main first and large, the in-flight projects next,
// everything else on one Archive row. The plan is a schedule table under a
// "## Focus" heading in a vault note (columns From, To, Main, In flight),
// named by state.json's focus.goals. Without one, everything shows.
//
// Two things always stay visible: a project with something running, and
// everything when Focus is off or the plan cannot be read. Tools that have
// not been launched for 30 days fold onto the workspace's Archive shelf;
// launches are recorded from the day this shipped, so nothing is called
// stale before it has had 30 days to be launched.
import fs from 'node:fs';
import { dataPath } from '../core/paths.mjs';
import { readJson, writeJsonAtomic } from '../core/files.mjs';
import { configSection } from '../core/config.mjs';
import { vaultFile, todayStr } from '../core/vault.mjs';

const DAY = 86400e3;
export const DEFAULTS = {
  enabled: true,
  showAll: false,
  goals: null, // the vault note holding the plan, e.g. "Goals/2026 Goals.md"
  staleDays: 30,
  map: {}, // plan names that are not a project's id or name: { "Website": "site" }
};

const LAUNCHES = () => dataPath('launches.json');

// launches.json: { "<key>": epochMs, ..., "_since": epochMs } where _since is
// when recording began.
function readLaunches() { return readJson(LAUNCHES(), {}) || {}; }

export function recordLaunch(key, now = Date.now()) {
  if (!key) return;
  const all = readLaunches();
  all._since ||= now;
  all[key] = now;
  writeJsonAtomic(LAUNCHES(), all);
}
export function lastLaunches() { const { _since, ...rest } = readLaunches(); return rest; }

function ensureSince(now) {
  const all = readLaunches();
  if (!all._since) { all._since = now; writeJsonAtomic(LAUNCHES(), all); }
  return all._since;
}

// The rows of the first table under the "## Focus" heading whose header has
// From, To, Main and In flight.
export function parseSchedule(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex(l => /^##\s+Focus\b/.test(l));
  if (start < 0) throw new Error('no "## Focus" section in the goals note');
  let i = start + 1;
  const rows = [];
  for (; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const head = cells(lines[i]).map(h => h.toLowerCase());
    const col = name => head.indexOf(name);
    if (col('from') < 0 || col('to') < 0 || col('main') < 0) continue;
    for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
      const c = cells(lines[i]);
      const flight = col('in flight') >= 0 ? c[col('in flight')] : '';
      rows.push({
        from: c[col('from')], to: c[col('to')], main: c[col('main')],
        inFlight: flight ? flight.split(',').map(s => s.trim()).filter(Boolean) : [],
      });
    }
    break;
  }
  if (!rows.length) throw new Error('no schedule table (From | To | Main | In flight) in the Focus section');
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.from) || !/^\d{4}-\d{2}-\d{2}$/.test(r.to)) throw new Error(`a schedule row has a date that is not YYYY-MM-DD: ${r.from} to ${r.to}`);
  }
  return rows;
}

export function periodFor(rows, today) { return rows.find(r => r.from <= today && today <= r.to) || null; }

// A plan name to a Deck project: the map first, then a project's id or name.
export function projectFor(name, map, projects) {
  if (!name) return null;
  if (map[name] && projects[map[name]]) return map[name];
  const low = name.toLowerCase();
  const hit = Object.values(projects).find(p => p.id.toLowerCase() === low || (p.name || '').toLowerCase() === low);
  return hit ? hit.id : null;
}

// Which projects have something running: a project child in procs, or one of
// the project's tools (matched the way server.js matches tools to cards).
function runningProjects(ctx, projects) {
  const live = new Set();
  const manifests = ctx.loadManifests();
  for (const [key, p] of Object.entries(ctx.procs || {})) {
    if (!ctx.alive(p)) continue;
    const m = /^proj:([^:]+):/.exec(key);
    if (m) { live.add(m[1]); continue; }
    const tool = manifests[key];
    if (!tool) continue;
    const groups = [tool.group, ...(tool.projects || [])].filter(Boolean);
    for (const proj of Object.values(projects)) {
      const names = new Set([proj.name, ...(proj.match || [])]);
      if (groups.some(g => names.has(g))) live.add(proj.id);
    }
  }
  return live;
}

export function focusState(ctx, { now = Date.now() } = {}) {
  const cfg = configSection('focus', DEFAULTS, ctx.getState());
  const projects = ctx.loadProjects();
  const today = todayStr(new Date(now));
  const launches = lastLaunches();
  const out = { enabled: cfg.enabled, showAll: cfg.showAll, today, period: null, main: null, inFlight: [], archive: { projects: [], tools: [] }, lastLaunch: launches, error: null };

  // Tools quiet for staleDays, counted from when recording began.
  const since = ensureSince(now);
  const manifests = ctx.loadManifests();
  for (const id of Object.keys(manifests)) {
    const last = launches[id] || since;
    if (now - last > cfg.staleDays * DAY) out.archive.tools.push(id);
  }

  out.configured = !!cfg.goals;
  if (!cfg.goals) { out.error = 'no plan configured (focus.goals in state.json)'; return out; }
  let rows;
  try {
    const file = vaultFile(cfg.goals);
    rows = parseSchedule(fs.readFileSync(file, 'utf8'));
  } catch (e) { out.error = e.code === 'ENOENT' ? `no goals note at ${cfg.goals}` : e.message; return out; }
  const period = periodFor(rows, today);
  if (!period) { out.error = `no schedule row covers ${today}`; return out; }
  out.period = period;
  out.main = projectFor(period.main, cfg.map, projects);
  out.inFlight = period.inFlight.map(n => projectFor(n, cfg.map, projects)).filter(id => id && id !== out.main);
  const keep = new Set([out.main, ...out.inFlight, ...runningProjects(ctx, projects)]);
  out.archive.projects = Object.keys(projects).filter(id => !keep.has(id));
  return out;
}

export function register(router, ctx) {
  router.add('GET', '/api/focus', () => focusState(ctx));
  router.add('POST', '/api/focus', async (req, res, { body }) => {
    const b = await body();
    const state = ctx.getState();
    const next = { ...state, focus: { ...(state.focus || {}) } };
    if (typeof b.enabled === 'boolean') next.focus.enabled = b.enabled;
    if (typeof b.showAll === 'boolean') next.focus.showAll = b.showAll;
    ctx.saveState(next);
    return focusState(ctx);
  });
}
export function start() {}
export async function stop() {}

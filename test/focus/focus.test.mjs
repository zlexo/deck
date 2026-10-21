import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-focus-'));
process.env.DECK_DATA = path.join(tmp, 'data');
process.env.DECK_VAULT = path.join(tmp, 'vault');
const focus = await import('../../lib/focus/index.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const GOALS = `# 2026 Goals

## Focus: one main at a time (2026-10-10)
- **Now to 21 Oct: coursework is the main.**

**Schedule** (Deck reads this):

| From | To | Main | In flight |
|---|---|---|---|
| 2026-10-10 | 2026-10-21 | Coursework | Perdix, Deck |
| 2026-10-22 | 2026-11-30 | Perdix | Pad Party |

- Why: finishes were missing.

## Other
| From | To | Main |
|---|---|---|
| 2026-01-01 | 2026-12-31 | Wrong |
`;
const write = text => { const f = path.join(tmp, 'vault', 'Goals', '2026 Goals.md'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

const P = id => ({ id, name: id === 'pad-party' ? 'Pad Party' : id[0].toUpperCase() + id.slice(1), match: [] });
const projects = Object.fromEntries(['coursework', 'perdix', 'deck', 'pad-party', 'modplex', 'rpg-mod', 'atlas'].map(id => [id, P(id)]));
projects['rpg-mod'].match = ['RPG Mod', 'Servers'];
function ctx({ procs = {}, state = { focus: { goals: 'Goals/2026 Goals.md' } }, manifests = {} } = {}) {
  let st = state;
  return {
    loadProjects: () => projects, loadManifests: () => manifests, procs,
    alive: p => p && p.live, getState: () => st, saveState: s => { st = s; },
  };
}
const OCT12 = new Date(2026, 9, 12, 12).getTime();

test('schedule: the table under ## Focus, not another section\'s', () => {
  const rows = focus.parseSchedule(GOALS);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { from: '2026-10-10', to: '2026-10-21', main: 'Coursework', inFlight: ['Perdix', 'Deck'] });
  assert.equal(focus.periodFor(rows, '2026-10-21').main, 'Coursework', 'the last day is inside');
  assert.equal(focus.periodFor(rows, '2026-10-22').main, 'Perdix');
  assert.equal(focus.periodFor(rows, '2026-12-01'), null);
  assert.throws(() => focus.parseSchedule('# x\n## Focus\nno table'), /no schedule table/);
  // A later section's table is never taken for the plan.
  assert.throws(() => focus.parseSchedule('## Focus\nno table here\n## Other\n| From | To | Main |\n|---|---|---|\n| 2026-01-01 | 2026-12-31 | Wrong |\n'), /no schedule table/);
  assert.throws(() => focus.parseSchedule('# x\n## Other\n'), /no "## Focus"/);
  assert.throws(() => focus.parseSchedule('## Focus\n| From | To | Main |\n|---|---|---|\n| 10 Oct | 21 Oct | Coursework |\n'), /YYYY-MM-DD/);
});

test('names map to projects through focus.map, then by id or name', () => {
  assert.equal(focus.projectFor('Coursework', focus.DEFAULTS.map, projects), 'coursework');
  assert.equal(focus.projectFor('Pad Party', {}, projects), 'pad-party');
  assert.equal(focus.projectFor('atlas', {}, projects), 'atlas');
  assert.equal(focus.projectFor('Nope', focus.DEFAULTS.map, projects), null);
});

test('home grid: main, in flight, everything else archived', () => {
  write(GOALS);
  const s = focus.focusState(ctx(), { now: OCT12 });
  assert.equal(s.main, 'coursework');
  assert.deepEqual(s.inFlight, ['perdix', 'deck']);
  assert.deepEqual(s.archive.projects.sort(), ['atlas', 'modplex', 'pad-party', 'rpg-mod']);
  assert.equal(s.error, null);
  const later = focus.focusState(ctx(), { now: new Date(2026, 9, 25, 12).getTime() });
  assert.equal(later.main, 'perdix');
  assert.deepEqual(later.inFlight, ['pad-party']);
});

test('a project with something running is never archived', () => {
  write(GOALS);
  const manifests = { 'enemy-placer': { id: 'enemy-placer', group: 'RPG Mod' } };
  const s = focus.focusState(ctx({ procs: { 'proj:modplex:server:dev-agent': { live: true }, 'enemy-placer': { live: true }, 'proj:atlas:site:0': { live: false } }, manifests }), { now: OCT12 });
  assert.ok(!s.archive.projects.includes('modplex'), 'a running project server');
  assert.ok(!s.archive.projects.includes('rpg-mod'), 'a running tool of the project');
  assert.ok(s.archive.projects.includes('atlas'), 'a dead child does not count');
});

test('no plan or no row for today: an error and no archive, so everything shows', () => {
  fs.rmSync(path.join(tmp, 'vault', 'Goals'), { recursive: true, force: true });
  let s = focus.focusState(ctx(), { now: OCT12 });
  assert.match(s.error, /no goals note/);
  assert.deepEqual(s.archive.projects, []);
  write(GOALS);
  s = focus.focusState(ctx(), { now: new Date(2027, 0, 5).getTime() });
  assert.match(s.error, /no schedule row covers 2027-01-05/);
  assert.deepEqual(s.archive.projects, []);
});

test('tools: stale only after 30 quiet days counted from when recording began', () => {
  write(GOALS);
  fs.rmSync(process.env.DECK_DATA, { recursive: true, force: true });
  const manifests = { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } };
  const day = 86400e3;
  let s = focus.focusState(ctx({ manifests }), { now: OCT12 });
  assert.deepEqual(s.archive.tools, [], 'day one: nothing is stale yet');
  focus.recordLaunch('a', OCT12 + 20 * day);
  s = focus.focusState(ctx({ manifests }), { now: OCT12 + 31 * day });
  assert.deepEqual(s.archive.tools.sort(), ['b', 'c'], 'never launched in 31 days of recording');
  s = focus.focusState(ctx({ manifests }), { now: OCT12 + 51 * day });
  assert.deepEqual(s.archive.tools.sort(), ['a', 'b', 'c']);
});

test('POST toggles enabled and showAll through saveState', async () => {
  write(GOALS);
  const routes = {};
  const c = ctx();
  focus.register({ add: (m, p, h) => { routes[`${m} ${p}`] = h; } }, c);
  const r = await routes['POST /api/focus']({}, {}, { body: async () => ({ showAll: true, enabled: false }) });
  assert.equal(r.showAll, true);
  assert.equal(r.enabled, false);
  assert.deepEqual(c.getState().focus, { goals: 'Goals/2026 Goals.md', showAll: true, enabled: false }, 'the toggles merge into the configured section');
});

test('no plan configured: the state says so and nothing is folded away', () => {
  write(GOALS);
  const s = focus.focusState(ctx({ state: {} }), { now: OCT12 });
  assert.match(s.error, /no plan configured/);
  assert.equal(s.configured, false, 'the home page shows no Focus line for it');
  assert.equal(focus.focusState(ctx(), { now: OCT12 }).configured, true);
  assert.equal(s.main, null);
  assert.deepEqual(s.archive.projects, []);
});

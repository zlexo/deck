// Deck Apps: tools that live in their own GitHub repos, tagged `deck-app`,
// installed into Deck's apps folder and updated from it. This module serves
// the catalog with each app's status; install.mjs changes what is on disk.
import fs from 'node:fs';
import path from 'node:path';
import { isInside, tildify } from '../core/paths.mjs';
import { catalog, packCatalog, clearCatalog } from './catalog.mjs';
import { appsDir, appDir, packDir } from './dirs.mjs';
import { install, update, remove, plan, AppsError, packWhere } from './install.mjs';
import { HttpError } from '../core/http.mjs';

export { catalog, packCatalog, appsConfig, manifestProblem, packProblem, clearCatalog, TOPIC } from './catalog.mjs';
export { appsDir, appDir, appDataDir, packsDir, packsRoot, packDir } from './dirs.mjs';

export function installedOf(state) {
  const all = (state && state.apps && state.apps.installed) || {};
  return Object.fromEntries(Object.entries(all).filter(([id]) => fs.existsSync(path.join(appDir(id), '.git'))));
}

export function installedPacks(state, appId) {
  const all = (state && state.apps && state.apps.packs && state.apps.packs[appId]) || {};
  return Object.fromEntries(Object.entries(all).filter(([id]) => fs.existsSync(path.join(packDir(appId, id), '.git'))));
}

const versionOf = v => (v ? v.tag || (v.sha ? v.sha.slice(0, 7) : null) : null);
const sameVersion = (a, b) => !!(a && b) && (a.tag ? a.tag === b.tag : a.sha === b.sha);

// An app's place on this machine: installed by Deck, a checkout of yours in a
// scan root (Deck uses it and never installs a second copy), or available.
export function statusOf(entry, { installed, manifests }) {
  if (!entry.manifest) return { status: 'unusable' };
  const id = entry.manifest.id;
  const inst = installed[id];
  if (inst) {
    return { status: 'installed', dir: tildify(appDir(id)), version: versionOf(inst.version), latest: versionOf(entry.latest),
      updateAvailable: !sameVersion(inst.version, entry.latest) };
  }
  const dev = Object.values(manifests).find(m => m.id === id && m._dir && !isInside(m._dir, appsDir()));
  if (dev) return { status: 'dev', dir: tildify(dev._dir), latest: versionOf(entry.latest) };
  // A tool of yours in the config folder with the same id: a discovered app
  // replaces it on the home grid, so installing would make it disappear.
  const own = manifests[id];
  if (own && !own._dir) return { status: 'taken', latest: versionOf(entry.latest),
    problem: `a tool in Deck's config folder already has the id '${id}': installing this app would replace it, so rename or remove that tool's manifest first` };
  return { status: 'available', latest: versionOf(entry.latest) };
}

// The packs of an app that is on this machine, each with its status.
async function packsOf(state, appId, topic, { refresh, gh }) {
  const pc = await packCatalog({ state, appId, topic, refresh, ...(gh ? { gh } : {}) });
  const have = installedPacks(state, appId);
  return pc.packs.map(e => {
    const id = e.manifest ? e.manifest.id : null;
    const inst = id && have[id];
    return {
      id, title: e.manifest ? e.manifest.title : e.name, description: (e.manifest && e.manifest.description) || e.description,
      repo: e.repo, url: e.url, private: e.private, problem: e.problem,
      status: !e.manifest ? 'unusable' : inst ? 'installed' : 'available',
      version: inst ? versionOf(inst.version) : null, latest: versionOf(e.latest),
      updateAvailable: !!inst && !sameVersion(inst.version, e.latest),
      plan: e.manifest ? plan(e, packWhere(appId, id)) : [],
    };
  });
}

export async function overview(ctx, { refresh = false, gh } = {}) {
  const state = ctx.getState();
  const c = await catalog({ state, refresh, ...(gh ? { gh } : {}) });
  const installed = installedOf(state);
  const manifests = ctx.loadManifests ? ctx.loadManifests() : {};
  const apps = await Promise.all(c.apps.map(async e => {
    const st = statusOf(e, { installed, manifests });
    const packs = e.manifest && e.manifest.packs && (st.status === 'installed' || st.status === 'dev')
      ? await packsOf(state, e.manifest.id, e.manifest.packs, { refresh, gh }) : [];
    return { e, st, packs };
  }));
  return {
    sources: c.sources, errors: c.errors, checkedAt: c.at, topic: 'deck-app',
    apps: apps.map(({ e, st, packs: packList }) => ({
      id: e.manifest ? e.manifest.id : null, name: e.manifest ? e.manifest.name : e.name,
      description: (e.manifest && e.manifest.description) || e.description, repo: e.repo, url: e.url,
      private: e.private, updatedAt: e.updatedAt, problem: e.problem,
      install: e.manifest ? e.manifest.install || [] : [], packs: e.manifest ? e.manifest.packs || null : null,
      plan: e.manifest ? plan(e) : [],
      ...st, packList,
    })),
  };
}

// The gateway owns state.json: installs are recorded through ctx.saveState.
function setInstalled(ctx, id, rec) {
  const s = ctx.getState();
  const installed = { ...((s.apps && s.apps.installed) || {}) };
  if (rec) installed[id] = rec; else delete installed[id];
  ctx.saveState({ ...s, apps: { ...(s.apps || {}), installed } });
}

function setPack(ctx, appId, packId, rec) {
  const s = ctx.getState();
  const packs = { ...((s.apps && s.apps.packs) || {}) };
  const mine = { ...(packs[appId] || {}) };
  if (rec) mine[packId] = rec; else delete mine[packId];
  packs[appId] = mine;
  ctx.saveState({ ...s, apps: { ...(s.apps || {}), packs } });
}

const busy = new Set();
async function act(ctx, body, fn) {
  const { id } = (await body()) || {};
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'id required');
  if (busy.has(id)) throw new HttpError(409, `${id} is already being installed, updated or removed`);
  busy.add(id);
  try { return await fn(id); }
  catch (e) { if (e instanceof AppsError) throw new HttpError(e.status, e.message); throw e; }
  finally { busy.delete(id); }
}

async function packEntryFor(ctx, appId, packId, deps) {
  const app = await entryFor(ctx, appId, deps);
  if (!app.manifest.packs) throw new HttpError(400, `${appId} takes no packs`);
  const pc = await packCatalog({ state: ctx.getState(), appId, topic: app.manifest.packs, ...(deps.gh ? { gh: deps.gh } : {}) });
  const e = pc.packs.find(p => p.manifest && p.manifest.id === packId);
  if (!e) throw new HttpError(404, `no pack '${packId}' for ${appId} on the watched owners`);
  return e;
}

async function entryFor(ctx, id, deps) {
  const c = await catalog({ state: ctx.getState(), ...(deps.gh ? { gh: deps.gh } : {}) });
  const e = c.apps.find(a => a.manifest && a.manifest.id === id);
  if (!e) throw new HttpError(404, `no app '${id}' on the watched owners`);
  return e;
}

// Which owners are watched: set through the gateway, which owns state.json
// (a hand edit while it runs would be overwritten by its next save).
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
function setSources(ctx, change) {
  const s = ctx.getState();
  const now = Array.isArray(s.apps && s.apps.sources) ? s.apps.sources : [];
  const next = change.add ? [...new Set([...now, change.add])] : now.filter(o => o !== change.remove);
  ctx.saveState({ ...s, apps: { ...(s.apps || {}), sources: next } });
  clearCatalog();
  return next;
}

export function register(router, ctx, deps = {}) {
  router.add('POST', '/api/apps/sources', async (req, res, { body }) => {
    const b = (await body()) || {};
    const owner = b.add || b.remove;
    if (typeof owner !== 'string' || !OWNER.test(owner)) throw new HttpError(400, 'a GitHub owner name: letters, digits and dashes');
    return { sources: setSources(ctx, b.add ? { add: owner } : { remove: owner }) };
  });
  router.add('GET', '/api/apps', (req, res, { query }) => overview(ctx, { refresh: query.get('refresh') === '1', gh: deps.gh }));
  router.add('POST', '/api/apps/install', (req, res, { body }) => act(ctx, body, async id => {
    const e = await entryFor(ctx, id, deps);
    const st = statusOf(e, { installed: installedOf(ctx.getState()), manifests: ctx.loadManifests ? ctx.loadManifests() : {} });
    if (st.status === 'dev') throw new HttpError(409, `${id} is already a checkout of yours at ${st.dir}: Deck uses that one`);
    if (st.status === 'taken') throw new HttpError(409, st.problem);
    const rec = await install(e, deps);
    setInstalled(ctx, id, rec);
    return { ok: true, id, version: rec.version };
  }));
  router.add('POST', '/api/apps/update', (req, res, { body }) => act(ctx, body, async id => {
    const rec = installedOf(ctx.getState())[id];
    if (!rec) throw new HttpError(404, `${id} was not installed by Deck`);
    const next = await update(await entryFor(ctx, id, deps), rec, deps);
    setInstalled(ctx, id, next);
    return { ok: true, id, version: next.version };
  }));
  // Packs: { app, id } in the body; the busy key is app/id.
  const packAct = (body, fn) => act(ctx, async () => { const b = (await body()) || {}; return { ...b, id: b.app && b.id ? `${b.app}/${b.id}` : null, app: b.app, pack: b.id }; },
    key => { const [appId, packId] = key.split('/'); return fn(appId, packId); });
  router.add('POST', '/api/apps/packs/install', (req, res, { body }) => packAct(body, async (appId, packId) => {
    const e = await packEntryFor(ctx, appId, packId, deps);
    const rec = await install(e, { ...deps, where: packWhere(appId, packId) });
    setPack(ctx, appId, packId, rec);
    return { ok: true, app: appId, id: packId, version: rec.version };
  }));
  router.add('POST', '/api/apps/packs/update', (req, res, { body }) => packAct(body, async (appId, packId) => {
    const rec = installedPacks(ctx.getState(), appId)[packId];
    if (!rec) throw new HttpError(404, `${appId}/${packId} was not installed by Deck`);
    const next = await update(await packEntryFor(ctx, appId, packId, deps), rec, { ...deps, where: packWhere(appId, packId) });
    setPack(ctx, appId, packId, next);
    return { ok: true, app: appId, id: packId, version: next.version };
  }));
  router.add('POST', '/api/apps/packs/remove', (req, res, { body }) => packAct(body, async (appId, packId) => {
    if (!installedPacks(ctx.getState(), appId)[packId]) throw new HttpError(404, `${appId}/${packId} was not installed by Deck`);
    const r = remove(packId, { where: packWhere(appId, packId) });
    setPack(ctx, appId, packId, null);
    return { ok: true, app: appId, id: packId, ...r };
  }));
  router.add('POST', '/api/apps/remove', (req, res, { body }) => {
    let purge = false;
    return act(ctx, async () => { const b = (await body()) || {}; purge = b.purge === true; return b; }, async id => {
      if (!installedOf(ctx.getState())[id]) throw new HttpError(404, `${id} was not installed by Deck`);
      const r = remove(id, { purge });
      setInstalled(ctx, id, null);
      return { ok: true, id, ...r };
    });
  });
}
export function start() {}
export async function stop() {}

// Machine guard (concept § 5, contract § 8): the header meters, the orphan
// sweep and the cleanup drawer, for an 8 GB Mac whose disk has run out twice.
import { HttpError } from '../core/http.mjs';
import { sample, sampleSync, thresholds } from './meters.mjs';
import { findOrphans, killOrphan } from './orphans.mjs';
import { scan, clean, defaultRoots } from './cleanup.mjs';

let last = null;       // the latest meter sample
let timer = null;
let ctxRef = null;
let lastScan = null;   // the latest cleanup scan
let scanning = null;   // the scan in flight, shared by concurrent requests

const GB = 1024 ** 3;
const gb = b => (b / GB).toFixed(1);

export function snapshot() { return last; }

let sampling = null;
// One sample at a time: under heavy swap a sample can outlast the 10 s tick.
function refresh() {
  if (!sampling) {
    sampling = sample(ctxRef && ctxRef.getState())
      .then(s => { last = s; })
      .catch(e => console.error(`guard: sample failed: ${e.message}`))
      .finally(() => { sampling = null; });
  }
  return sampling.then(() => last);
}

// Mod Lab asks before a bench: enough free memory, and no other Minecraft
// (server or client) running, since one server and one client is all 8 GB holds.
export function benchVerdict(s, t) {
  if (s.ram.freeBytes == null) return { ok: false, reason: 'free memory could not be read, so a bench is not started' };
  if (s.ram.freeBytes < t.bench.minFreeBytes) {
    return { ok: false, reason: `only ${gb(s.ram.freeBytes)} GB of memory free; a bench needs ${gb(t.bench.minFreeBytes)} GB` };
  }
  const mc = s.java.find(j => j.kind === 'mc-server' || j.kind === 'mc-client');
  if (mc) return { ok: false, reason: `another Minecraft ${mc.kind === 'mc-server' ? 'server' : 'client'} is running (pid ${mc.pid})` };
  return { ok: true, reason: '' };
}

export function canStartBench() {
  const s = last && Date.now() - last.ts < 30000 ? last : (last = sampleSync(ctxRef && ctxRef.getState()));
  return benchVerdict(s, thresholds(ctxRef && ctxRef.getState()));
}

function scanOnce() {
  if (!scanning) {
    scanning = scan(defaultRoots(ctxRef))
      .then(r => (lastScan = r))
      .finally(() => { scanning = null; });
  }
  return scanning;
}

export function register(router, ctx) {
  ctxRef = ctx;
  router.add('GET', '/api/guard', async () => last || await refresh());
  router.add('GET', '/api/guard/orphans', async () => ({ orphans: await findOrphans() }));
  router.add('POST', '/api/guard/orphans/kill', async (req, res, { body }) => {
    const { pid, startedAt } = await body();
    if (!Number.isInteger(Number(pid)) || Number(pid) <= 1) throw new HttpError(400, 'pid required');
    if (!Number.isFinite(Number(startedAt))) throw new HttpError(400, 'startedAt required: the process start time from the orphan list');
    const r = await killOrphan(pid, startedAt);
    if (!r.ok) throw new HttpError(409, r.reason);
    setTimeout(refresh, 1500).unref();
    return r;
  });
  router.add('GET', '/api/guard/cleanup', async (req, res, { query }) => {
    if (query.get('refresh') === '1' || !lastScan) await scanOnce();
    return { ...lastScan, scanning: !!scanning };
  });
  router.add('POST', '/api/guard/cleanup', async (req, res, { body }) => {
    const { ids, deep } = await body();
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'ids required');
    const r = await clean(ids, { deep: deep === true, roots: defaultRoots(ctx) });
    lastScan = null;
    setTimeout(refresh, 500).unref();
    return r;
  });
}

export function start(ctx) {
  ctxRef = ctx;
  refresh();
  const t = thresholds(ctx.getState());
  timer = setInterval(refresh, t.intervalS * 1000);
  timer.unref();
}

export async function stop() { clearInterval(timer); timer = null; }

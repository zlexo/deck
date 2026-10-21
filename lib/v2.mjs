// Deck v2: mounts the six features into server.js. See docs/v2/contract.md.
import { createRouter } from './core/http.mjs';
import { setDeckRoot } from './core/paths.mjs';
import { toolPath, which } from './core/env.mjs';
import { repos } from './core/config.mjs';
import * as claude from './claude/index.mjs';
import { creditsOut } from './claude/ledger.mjs';
import * as ci from './ci/index.mjs';
import * as reviews from './reviews/index.mjs';
import * as modlab from './modlab/index.mjs';
import * as guard from './guard/index.mjs';
import * as focus from './focus/index.mjs';
import * as apps from './apps/index.mjs';
import * as vault from './vault/index.mjs';

const FEATURES = { claude, ci, reviews, modlab, guard, focus, apps, vault };

// A card shows the badges of its first repo that is a configured review repo.
function badges(ctx) {
  const projects = ctx.loadProjects();
  const all = repos(ctx.getState());
  const byPath = new Map(Object.values(all).map(r => [r.path, r]));
  const byProject = {};
  for (const p of Object.values(projects)) {
    const hit = (p.repos || []).map(r => byPath.get(r.path)).find(Boolean);
    if (!hit) continue;
    const c = ci.latestRecord(hit.id);
    const v = reviews.latestRecord(hit.id);
    byProject[p.id] = {
      repo: hit.id,
      ci: c ? ({ green: 'green', red: 'red', running: 'running', queued: 'running' }[c.status] || null) : null,
      review: v && v.status === 'done' ? ({ pass: 'passed', pass_with_notes: 'notes', blocked: 'blocked' }[v.verdict] || null) : null,
    };
  }
  return { byProject };
}

// What needs looking at, beyond server.js's git items: blocked reviews, red CI,
// the machine meters, and credits out. Each item says which page opens it.
const GB = 1024 ** 3;
async function attention(ctx) {
  const items = [];
  const week = Date.now() - 7 * 86400e3;
  for (const r of Object.values(repos(ctx.getState()))) {
    const c = ci.latestRecord(r.id);
    if (c && c.status === 'red') items.push({ kind: 'ci-red', sev: 3, project: r.project, open: 'ci', text: `${r.name}: CI red at ${c.sha.slice(0, 7)}${c.pr ? ` (#${c.pr})` : ''}` });
    const seen = new Set();
    for (const v of reviews.listReviews ? reviews.listReviews(r.id) : []) {
      if (seen.has(v.pr)) continue; // the newest record per PR decides
      seen.add(v.pr);
      if ((v.finishedAt || 0) < week || v.status !== 'done' || v.verdict !== 'blocked') continue;
      if (reviews.overrideFor && reviews.overrideFor(r.id, v.pr, v.sha)) continue;
      const n = (v.findings || []).filter(f => f.severity === 'blocker').length;
      items.push({ kind: 'review-blocked', sev: 3, project: r.project, open: 'reviews', text: `${r.name} #${v.pr}: review blocked (${n} blocker${n === 1 ? '' : 's'})` });
    }
  }
  const g = guard.snapshot();
  if (g) {
    if (g.disk.level !== 'ok') items.push({ kind: 'disk', sev: g.disk.level === 'bad' ? 3 : 2, open: 'machine', text: `Disk: ${(g.disk.freeBytes / GB).toFixed(1)} GB free` });
    if (g.ram.level !== 'ok') items.push({ kind: 'ram', sev: g.ram.level === 'bad' ? 3 : 2, open: 'machine', text: `Memory: ${(g.ram.freeBytes / GB).toFixed(1)} GB free` });
    if (g.swap.level !== 'ok') items.push({ kind: 'swap', sev: 1, open: 'machine', text: `Swap ${g.swap.pct}% used` });
    if (g.gradleLevel !== 'ok') items.push({ kind: 'gradle', sev: 1, open: 'machine', text: `${g.gradleDaemons} Gradle daemons running` });
  }
  // The marker only: claude.status() would spawn `security` twice per poll.
  try { if (creditsOut()) items.push({ kind: 'credits', sev: 2, open: 'claude', text: 'Claude credits out until the 1st' }); } catch {}
  return { items: items.sort((a, b) => b.sev - a.sev) };
}

export function mount(ctx) {
  setDeckRoot(ctx.root);
  const router = createRouter();
  for (const f of Object.values(FEATURES)) f.register(router, ctx);
  router.add('GET', '/api/badges', () => badges(ctx));
  router.add('GET', '/api/v2/attention', () => attention(ctx));
  // What the gateway's children will see. The installed app runs with
  // launchd's PATH; this route is how that is checked without guessing.
  router.add('GET', '/api/v2/env', () => ({
    path: toolPath(),
    resolved: Object.fromEntries(['git', 'gh', 'node', 'npm', 'bun', 'java', 'security', 'cmake'].map(c => [c, which(c)])),
    routes: router.routes(),
  }));
  // DECK_NO_BACKGROUND: the compiled-gateway check and the tests start a
  // gateway that must not run review passes, CI queues or samplers.
  if (!process.env.DECK_NO_BACKGROUND) {
    for (const [name, f] of Object.entries(FEATURES)) {
      try { f.start(ctx); } catch (e) { console.error(`v2: ${name} failed to start: ${e.message}`); }
    }
  }
  return {
    handle: (req, res, url) => router.handle(req, res, url),
    onLaunch(key) { try { focus.recordLaunch(key); } catch {} },
    // All at once: the gateway waits 2 s for the lot, and the vault's quit
    // commit must not queue behind a CI job's kill grace.
    async shutdown() {
      await Promise.all(Object.entries(FEATURES).map(async ([name, f]) => {
        try { await f.stop(); } catch (e) { console.error(`v2: ${name} failed to stop: ${e.message}`); }
      }));
    },
  };
}

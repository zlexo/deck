// The cleanup drawer (concept § 5): things that can be rebuilt, with their
// size and what rebuilds them. Never user files.
//
// Every target comes from one of a fixed set of generators, and every path is
// re-checked against its generator's rule right before it is deleted
// (assertSafe). A path that no longer passes is skipped, so a drawer opened an
// hour ago cannot delete what has since become something else.
//
// What is deliberately NOT here: Code Typer's public/gen beyond its TTS cache
// (it holds hand-made voice edits, *-voice.edit.wav), node_modules, renders in
// out/, anything under ~/vault, and any folder git tracks files in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, listProcesses } from '../core/proc.mjs';
import { expandHome, tildify, deckRoot, dataDir, isInside } from '../core/paths.mjs';
import { vaultDir } from '../core/vault.mjs';
import { isThrowawayDir, removeWorktree } from '../core/git.mjs';
import { lockHolder } from '../core/lock.mjs';
import { repos as reviewRepos, configSection } from '../core/config.mjs';

const DAY = 86400e3;

// guard.codeTyper in state.json: the Code Typer checkout whose voice cache may
// be cleared. Unset, that generator is off.
export function defaultRoots(ctx) {
  const state = ctx && ctx.getState ? ctx.getState() : undefined;
  const { codeTyper } = configSection('guard', { codeTyper: null }, state);
  const repoPaths = new Set(Object.values(reviewRepos(state)).map(r => expandHome(r.path)));
  if (ctx && ctx.loadProjects) {
    for (const p of Object.values(ctx.loadProjects())) for (const r of p.repos || []) repoPaths.add(expandHome(r.path));
  }
  return {
    repos: [...repoPaths].filter(p => fs.existsSync(path.join(p, '.git')) && !forbiddenRoot(p)),
    tmpdir: os.tmpdir(),
    codeTyper: codeTyper ? expandHome(codeTyper) : null,
    deck: deckRoot(),
    gradleCaches: expandHome('~/.gradle/caches'),
    data: dataDir(),
    now: Date.now(),
  };
}

const realPath = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// A card repo that must never be a cleanup source: the vault (it can be a
// card's repo), any folder holding the vault or the home folder, and the home
// folder itself (a dotfiles repo at ~ would offer ~/.gradle as a build folder).
export function forbiddenRoot(p) {
  const r = realPath(p), home = realPath(os.homedir()), v = vaultDir(), vault = v && realPath(v);
  return r === '/' || isInside(home, r) || (!!vault && (isInside(r, vault) || isInside(vault, r)));
}

// Tool homes that look like build output but hold settings and credentials.
const TOOL_HOMES = ['~/.gradle', '~/.m2', '~/.cargo', '~/.npm', '~/.rustup'].map(expandHome);
const inToolHome = p => TOOL_HOMES.some(h => isInside(realPath(p), realPath(h)));

// A build running now writes into build folders: Gradle's client and workers
// (an idle daemon writes nothing), ninja, cmake --build, cargo. While one runs,
// no build folder is offered or deleted.
export function activeBuild(procs) {
  const p = procs.find(x => /GradleWrapperMain|org\.gradle\.launcher\.GradleMain|GradleWorkerMain|(^|\/)ninja( |$)|(^|\/)cmake --build|(^|\/)cargo (build|run|test|check)|(^|\/)rustc /.test(x.cmd));
  return p ? p.cmd.slice(0, 80) : null;
}

// Git checkouts nested inside a build folder (CMake's FetchContent clones its
// dependencies under _deps/<name>-src): deletable only when each is clean, or
// when its changes are the card repo's own patch step (Perdix patches Tracy
// and toml++ on every configure: cmake/VxPatchTracy.cmake). Returns the nested
// repos, or { dirty } naming one with local changes nobody declared.
export async function nestedRepos(dir, repo) {
  const r = await run('/usr/bin/find', [dir, '-name', '.git', '-prune', '-print'], { timeoutMs: 60000 });
  const repos = r.stdout.split('\n').filter(Boolean).map(g => path.dirname(g));
  for (const n of repos) {
    const st = await run('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: n, timeoutMs: 60000 });
    if (st.code === 0 && !st.stdout.trim()) continue;
    if (st.code === 0 && repo && await patchedByRepo(repo, n)) continue;
    return { repos, dirty: n };
  }
  return { repos, dirty: null };
}

// True when a tracked CMake file of the repo, with "patch" in its path, names
// the dependency: then the checkout's changes are applied by the build.
async function patchedByRepo(repo, nested) {
  const m = /\/_deps\/([^/]+)-src$/.exec(nested);
  if (!m) return false;
  const r = await run('git', ['grep', '-il', '-F', m[1], '--', '*.cmake', 'CMakeLists.txt', '*/CMakeLists.txt'], { cwd: repo });
  return r.code === 0 && r.stdout.split('\n').some(f => /patch/i.test(f));
}

const idOf = (kind, p) => crypto.createHash('sha1').update(`${kind}\0${p}`).digest('hex').slice(0, 12);

async function du(p) {
  const r = await run('/usr/bin/du', ['-sk', p], { timeoutMs: 120000 });
  const k = parseInt(r.stdout, 10);
  return Number.isFinite(k) ? k * 1024 : 0;
}

const isDir = p => { try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };

// Generated, not source: git ignores it and tracks nothing inside it, and it
// belongs to the card repo itself (not to a repo nested in it).
async function gitIgnored(repo, p) {
  const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(p) });
  if (top.code !== 0 || realPath(top.stdout.trim()) !== realPath(repo)) return false;
  const ign = await run('git', ['check-ignore', '-q', p], { cwd: repo });
  if (ign.code !== 0) return false;
  const tracked = await run('git', ['ls-files', '--', path.relative(repo, p)], { cwd: repo });
  return tracked.code === 0 && tracked.stdout.trim() === '';
}

const inUse = (p, procs) => procs.some(pr => pr.cmd.includes(p + '/') || pr.cmd.includes(p + ' ') || pr.cmd.endsWith(p));

// --- the rules every deletion is checked against ------------------------------
const BUN_LEFTOVER = /^\.[0-9a-f]+-0+\.bun-build$/;
const REMOTION_TMP = /^(remotion-|react-motion-render)/;

export async function assertSafe(t, p, roots) {
  const real = path.resolve(p);
  switch (t.kind) {
    case 'build': {
      const repo = roots.repos.find(r => isInside(real, r) && real !== r);
      if (!repo) return 'not inside a known repo';
      const base = path.basename(real), parent = path.basename(path.dirname(real));
      const shape = base === 'build' || base === '.gradle'
        || (parent === 'build' && fs.existsSync(path.join(real, 'CMakeCache.txt')))
        || (base === 'target' && fs.existsSync(path.join(real, 'CACHEDIR.TAG'))); // cargo marks its own
      if (!shape) return 'not a build folder';
      if (!isDir(real)) return 'not a plain directory';
      if (inToolHome(real)) return 'inside a tool home (~/.gradle, ~/.m2, ...)';
      if (!(await gitIgnored(repo, real))) return 'git does not ignore it, tracks files in it, or it belongs to another repo';
      const nested = await nestedRepos(real, repo);
      if (nested.dirty) return `holds a git checkout with local changes: ${tildify(nested.dirty)}`;
      return null;
    }
    case 'remotion':
      return path.dirname(real) === path.resolve(roots.tmpdir) && REMOTION_TMP.test(path.basename(real)) ? null : 'not a Remotion temp folder';
    case 'tts-cache':
      if (!roots.codeTyper) return 'no TTS cache configured';
      return isInside(real, path.join(roots.codeTyper, 'public', 'gen', 'tts-cache')) && real !== path.join(roots.codeTyper, 'public', 'gen', 'tts-cache') ? null : 'not in the TTS cache';
    case 'bun':
      return path.dirname(real) === path.resolve(roots.deck) && BUN_LEFTOVER.test(path.basename(real)) ? null : 'not a bun compile leftover';
    case 'deck-worktree':
      return isThrowawayDir(real) ? null : 'not a Deck throwaway worktree';
    case 'gradle-caches':
      return real === path.resolve(roots.gradleCaches) ? null : 'not the Gradle caches folder';
    case 'worktree-prune':
      return roots.repos.includes(real) ? null : 'not a known repo';
    default:
      return 'unknown kind';
  }
}

// --- generators ----------------------------------------------------------------
async function buildTargets(roots, procs) {
  const out = [];
  if (activeBuild(procs)) return out; // a running build writes into these
  for (const repo of roots.repos) {
    const name = path.basename(repo);
    const cands = [];
    const top = path.join(repo, 'build');
    const presets = isDir(top) ? fs.readdirSync(top).map(d => path.join(top, d)).filter(d => isDir(d) && fs.existsSync(path.join(d, 'CMakeCache.txt'))) : [];
    if (presets.length) for (const d of presets) {
      const deps = fs.existsSync(path.join(d, '_deps')) ? '; its FetchContent dependencies download again' : '';
      cands.push({ p: d, rebuilds: `cmake --preset ${path.basename(d)} && cmake --build --preset ${path.basename(d)} (a full rebuild of that preset${deps})`, label: `${name} build/${path.basename(d)}` });
    }
    else if (isDir(top)) cands.push({ p: top, rebuilds: 'the next build', label: `${name}/build`, group: true });
    for (const sub of ['', 'modules']) {
      const dir = sub ? path.join(repo, sub) : repo;
      if (!isDir(dir)) continue;
      for (const d of fs.readdirSync(dir)) {
        const b = path.join(dir, d, 'build');
        if (d.startsWith('.') || d === 'build' || d === 'node_modules' || !isDir(b)) continue;
        cands.push({ p: b, rebuilds: 'the next Gradle build', label: `${name}/${sub ? sub + '/' : ''}${d}/build`, group: true });
      }
    }
    for (const t of [path.join(repo, 'target'), path.join(repo, 'src-tauri', 'target')]) {
      if (isDir(t) && fs.existsSync(path.join(t, 'CACHEDIR.TAG'))) cands.push({ p: t, rebuilds: 'cargo build (several minutes; an app build needs it)', label: `${name}/${path.relative(repo, t)}` });
    }
    const dg = path.join(repo, '.gradle');
    if (isDir(dg)) cands.push({ p: dg, rebuilds: 'Gradle recreates it on the next run', label: `${name}/.gradle` });
    // Plain Gradle build folders of one repo are one entry (Conduit alone has a
    // dozen small module builds); CMake presets, cargo targets and .gradle
    // stay separate because each costs its own rebuild.
    const plain = [];
    for (const c of cands) {
      if (inUse(c.p, procs)) continue;
      const t = { kind: 'build' };
      if (await assertSafe(t, c.p, roots)) continue;
      if (c.group) plain.push(c);
      else out.push({ ...t, id: idOf('build', c.p), label: c.label, paths: [c.p], rebuilds: c.rebuilds, deep: false });
    }
    if (plain.length === 1) out.push({ kind: 'build', id: idOf('build', plain[0].p), label: plain[0].label, paths: [plain[0].p], rebuilds: plain[0].rebuilds, deep: false });
    else if (plain.length > 1) {
      out.push({ kind: 'build', id: idOf('build', repo + '#gradle'), label: `${name}: ${plain.length} build folders`, paths: plain.map(c => c.p), rebuilds: 'the next Gradle build', deep: false });
    }
  }
  return out;
}

async function remotionTargets(roots, procs) {
  let names = [];
  // remotion-*: bundles; react-motion-render*: a render's frame dumps (a leaked
  // pair from two renders held 1 GB on 2026-10-12).
  try { names = fs.readdirSync(roots.tmpdir).filter(n => REMOTION_TMP.test(n)); } catch {}
  if (!names.length) return [];
  if (procs.some(p => /remotion|chrome-headless-shell|(^|\/)ffmpeg /.test(p.cmd))) return []; // a render is running
  const paths = names.map(n => path.join(roots.tmpdir, n));
  return [{ kind: 'remotion', id: idOf('remotion', roots.tmpdir), label: `Remotion render leftovers (${paths.length})`, paths, rebuilds: 'the next render bundles again', deep: false }];
}

function ttsTargets(roots) {
  if (!roots.codeTyper) return [];
  const dir = path.join(roots.codeTyper, 'public', 'gen', 'tts-cache');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const old = names.map(n => path.join(dir, n)).filter(f => { try { return roots.now - fs.statSync(f).mtimeMs > 7 * DAY; } catch { return false; } });
  if (!old.length) return [];
  return [{ kind: 'tts-cache', id: idOf('tts-cache', dir), label: `Code Typer voice cache older than 7 days (${old.length} files)`, paths: old, rebuilds: 'Kokoro voices those lines again on the next render', deep: false }];
}

function bunTargets(roots) {
  let names = [];
  try { names = fs.readdirSync(roots.deck).filter(n => BUN_LEFTOVER.test(n)); } catch {}
  if (!names.length) return [];
  return [{ kind: 'bun', id: idOf('bun', roots.deck), label: `Bun compile leftovers in the Deck checkout (${names.length})`, paths: names.map(n => path.join(roots.deck, n)), rebuilds: 'nothing uses them', deep: false }];
}

function deckWorktreeTargets(roots) {
  const out = [];
  for (const feature of ['ci', 'reviews', 'modlab']) {
    if (lockHolder(feature === 'ci' ? 'ci' : feature === 'reviews' ? 'review' : 'heavy')) continue; // a run may be using them
    const work = path.join(roots.data, feature, 'work');
    let names = [];
    try { names = fs.readdirSync(work); } catch { continue; }
    for (const n of names) {
      const p = path.join(work, n);
      if (!isDir(p) || !isThrowawayDir(p)) continue;
      out.push({ kind: 'deck-worktree', id: idOf('deck-worktree', p), label: `Leftover ${feature} worktree ${n}`, paths: [p], rebuilds: 'a fresh one is made for the next run', deep: false, repoId: n.replace(/-[0-9a-f]{12}$/, '') });
    }
  }
  return out;
}

async function pruneTargets(roots) {
  const out = [];
  for (const repo of roots.repos) {
    const r = await run('git', ['worktree', 'list', '--porcelain'], { cwd: repo });
    const prunable = r.stdout.split('\n\n').filter(b => /^prunable/m.test(b)).length;
    if (prunable) out.push({ kind: 'worktree-prune', id: idOf('worktree-prune', repo), label: `${path.basename(repo)}: ${prunable} stale worktree record${prunable === 1 ? '' : 's'}`, paths: [repo], rebuilds: 'nothing: their folders are already gone (git worktree prune)', deep: false, bytes: 0 });
  }
  return out;
}

function gradleCachesTarget(roots, procs) {
  if (!isDir(roots.gradleCaches)) return [];
  if (procs.some(p => /GradleDaemon|GradleWrapperMain|gradle-launcher/.test(p.cmd))) return []; // Gradle is running
  return [{ kind: 'gradle-caches', id: idOf('gradle-caches', roots.gradleCaches), label: 'Gradle caches (deep clean)', paths: [roots.gradleCaches], rebuilds: 'every Gradle project downloads its dependencies again on its next build (slow, needs the network)', deep: true }];
}

export async function scan(roots, { procs } = {}) {
  const ps = procs || await listProcesses();
  const targets = [
    ...await buildTargets(roots, ps), ...await remotionTargets(roots, ps), ...ttsTargets(roots),
    ...bunTargets(roots), ...deckWorktreeTargets(roots), ...await pruneTargets(roots), ...gradleCachesTarget(roots, ps),
  ];
  for (const t of targets) {
    if (t.bytes === undefined) {
      let b = 0;
      for (const p of t.paths) b += await du(p);
      t.bytes = b;
    }
    t.shown = t.paths.map(tildify);
  }
  return { scannedAt: Date.now(), targets: targets.sort((a, b) => (a.deep - b.deep) || (b.bytes - a.bytes)) };
}

// Removes the chosen targets after a fresh scan: an id that is no longer in it
// is reported, not guessed at. Deep targets need `deep: true` as well.
export async function clean(ids, { deep = false, roots, procs, procsNow } = {}) {
  const fresh = await scan(roots, { procs });
  const byId = new Map(fresh.targets.map(t => [t.id, t]));
  // The scan (with its du) takes seconds: a build, a render or a CI run that
  // started meanwhile is checked again right before anything goes.
  const now = procsNow || procs || await listProcesses();
  const removed = [], errors = [];
  let freedBytes = 0;
  for (const id of ids || []) {
    const t = byId.get(id);
    if (!t) { errors.push({ id, error: 'not in a fresh scan any more (in use, gone, or no longer safe)' }); continue; }
    if (t.deep && !deep) { errors.push({ id, error: 'a deep clean needs deep: true' }); continue; }
    let ok = true;
    const busy = t.kind === 'build' ? activeBuild(now)
      : t.kind === 'remotion' && now.some(x => /remotion|chrome-headless-shell|(^|\/)ffmpeg /.test(x.cmd)) ? 'a render is running'
      : t.kind === 'deck-worktree' && (lockHolder('ci') || lockHolder('heavy')) ? 'a CI run or a bench is running' : null;
    if (busy) { errors.push({ id, error: `skipped: ${busy}` }); continue; }
    for (const p of t.paths) {
      if (t.kind === 'build' && inUse(p, now)) { errors.push({ id, path: tildify(p), error: 'in use by a running process' }); ok = false; continue; }
      const why = await assertSafe(t, p, roots);
      if (why) { errors.push({ id, path: tildify(p), error: why }); ok = false; continue; }
      try {
        if (t.kind === 'worktree-prune') await run('git', ['worktree', 'prune'], { cwd: p });
        else if (t.kind === 'deck-worktree') {
          const r = reviewRepos()[t.repoId];
          if (r) await removeWorktree(expandHome(r.path), p);
          else fs.rmSync(p, { recursive: true, force: true });
        } else fs.rmSync(p, { recursive: true, force: true });
      } catch (e) { errors.push({ id, path: tildify(p), error: e.message }); ok = false; }
    }
    if (ok) { removed.push(id); freedBytes += t.bytes || 0; }
  }
  return { freedBytes, removed, errors };
}

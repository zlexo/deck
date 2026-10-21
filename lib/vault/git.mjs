// Deck Vault, git: the vault's commits and its push to a private GitHub repo.
// Modes (state `vault.git`): `auto` (Deck's own vault: commit after a quiet
// spell and at quit, then push), `push` (push main once it has been still for
// a quiet spell; never commit or merge, except the Memory/ mirror), `off`
// (status only). Adopted vaults start `off`. Every commit and every unpushed
// commit is scanned for secrets; every push first asks GitHub whether the repo
// is private. Never a rebase.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../core/proc.mjs';
import { gh as realGh } from '../core/gh.mjs';
import { deepMerge } from '../core/config.mjs';
import { expandHome, isInside, tildify } from '../core/paths.mjs';
import { HttpError } from '../core/http.mjs';
import { resolveVault } from '../core/vault.mjs';
import { claudeConfigDir } from './claude.mjs';

export const MODES = ['auto', 'push', 'off'];
export const QUIET_MS = 10 * 60e3; // no change for this long, then commit
const POLL_MS = 30e3;
// The gateway gives every feature's stop() 2 s together (V2_STOP_MS); the
// quit commit and push finish inside this or are stopped.
export const QUIT_MS = 1500;
const MAX_OUT = 256 * 1024 * 1024;

// High-confidence patterns only: a hit holds the file back. AWS's documented
// example ids (16 characters ending in EXAMPLE) are allowed.
export const SECRETS = [
  ['Anthropic key', /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI key', /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|\bsk-[A-Za-z0-9_-]{16,}T3BlbkFJ[A-Za-z0-9_-]{16,}/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{60,}/g],
  ['AWS key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, m => m.endsWith('EXAMPLE')],
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g],
];
const secretIn = l => (SECRETS.find(([, re, allow]) => [...l.matchAll(re)].some(m => !allow || !allow(m[0]))) || [])[0];

// Secrets in the added lines of `git diff -U0` or `git log -p -U0
// --format=%x01%H`, as { file, line, kind, sha? }: where, never what. Between
// `diff --git` and the first `@@` everything is header; inside a hunk a line
// starting with `+++ ` is content (an added line whose text starts with `++ `).
export function scanDiff(text) {
  const hits = [];
  let file = null, line = 0, header = false, sha;
  for (const l of text.split('\n')) {
    if (l.startsWith('\x01')) { sha = l.slice(1); file = null; header = false; continue; }
    if (l.startsWith('diff --git ')) { header = true; file = null; continue; }
    if (header) {
      if (l.startsWith('+++ ')) file = l === '+++ /dev/null' ? null : l.slice(6);
      if (!l.startsWith('@@')) continue;
      header = false;
    }
    const h = /^@@ -\S+ \+(\d+)/.exec(l);
    if (h) { line = Number(h[1]); continue; }
    if (!file || !l.startsWith('+')) continue;
    const kind = secretIn(l);
    if (kind) hits.push(sha ? { file, line, kind, sha } : { file, line, kind });
    line++;
  }
  return hits;
}
const where = hs => hs.map(h => `${h.file}:${h.line} (${h.kind})${h.sha ? ` in ${h.sha.slice(0, 7)}` : ''}`).join(', ');

const SLUG = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
const GH_URL = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const parse = re => s => { const m = re.exec(s || ''); return m ? { owner: m[1], name: m[2] } : null; };
const slugOf = parse(SLUG), urlSlug = parse(GH_URL);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };
// What a failed command said: its fatal/error lines, else its last lines.
const tail = r => {
  const ls = (r.stderr || r.stdout || (r.error && r.error.message) || `exit ${r.code}`).trim().split('\n');
  const bad = ls.filter(l => /^(fatal|error):/.test(l));
  return (bad.length ? bad : ls.slice(-3)).join(' ');
};

// Every file below a folder (regular files, .DS_Store skipped) with its stat.
function listFiles(root) {
  const out = new Map();
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && e.name !== '.DS_Store') out.set(r, fs.statSync(path.join(root, r)));
    }
  };
  if (fs.existsSync(root)) walk('');
  return out;
}
// Status entries ({ x, file }) from `git status --porcelain -z`.
function porcelain(raw) {
  const items = [], parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    items.push({ x: parts[i].slice(0, 2), file: parts[i].slice(3) });
    if (/^[RC]/.test(parts[i])) i++; // a rename carries its old name next
  }
  return items;
}

export function vaultGit(ctx, { gh = realGh, githubUrl = (o, n) => `https://github.com/${o}/${n}.git`, quietMs = QUIET_MS, now = Date.now, hook = async () => {}, maxOut = MAX_OUT } = {}) {
  let cur = new AbortController(), closed = false;
  let chain = Promise.resolve(), ticking = false, lastFp = '', changedAt = now(), nextPushAt = 0, blocked = false;
  let lastPush = null, checked = null, mirrored = null, conflicts = [], mainSha = null, mainSince = 0, merging = false;
  const found = { mirror: [], memory: [], vault: [], push: [] };
  const errs = { watch: null, mirror: null, memory: null, vault: null, push: null, scan: null };

  const serial = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
  // Pathspecs are literal: a file named `*.md` must never match another file.
  // The flag reaches every child as GIT_LITERAL_PATHSPECS=1, hooks included,
  // so the commands that run the vault's own hooks (the whole-vault commit and
  // the merge) go without it: a hook's `git add -- "*.gen"` must still glob.
  const HOOKED = ['--no-optional-locks', '-c', 'core.quotepath=false'];
  const GIT = ['--literal-pathspecs', ...HOOKED];
  // Steps that may be stopped at quit take the current abort signal.
  const g = (dir, args, { hooks = false, ...opts } = {}) => {
    if (cur.signal.aborted) throw new Error('gave up: Deck quit first');
    return run('git', [...(hooks ? HOOKED : GIT), ...args], { cwd: dir, timeoutMs: 120000, abort: cur.signal, maxBuffer: maxOut, ...opts });
  };
  // Output that did not fit is never read as complete: a scan cut short is not a clean scan.
  const ok = async (dir, args, opts) => {
    const r = await g(dir, args, opts);
    if (r.code !== 0) throw new Error(cur.signal.aborted ? 'gave up: Deck quit first' : `git ${args[0]}: ${tail(r)}`);
    if (r.truncated) throw new Error(`git ${args[0]}: output too large to check`);
    return r.stdout;
  };
  // Local steps that must never be cut half way (reset, merge, merge --abort).
  const whole = (dir, args, input, { hooks = false } = {}) => run('git', [...(hooks ? HOOKED : GIT), ...args], { cwd: dir, timeoutMs: 120000, input });
  // Reads: never take index.lock, never stopped at quit. `out` gives null on
  // failure (a probe); `read` throws (a failed status is never a clean tree).
  const out = async (dir, args) => { const r = await run('git', [...GIT, ...args], { cwd: dir, timeoutMs: 30000 }); return r.code === 0 ? r.stdout.trim() : null; };
  const read = async (dir, args) => {
    const r = await run('git', [...GIT, ...args], { cwd: dir, timeoutMs: 30000 });
    if (r.code !== 0 || r.truncated) throw new Error(`git ${args[0]} failed: ${r.truncated ? 'output too large' : tail(r)}`);
    return r.stdout;
  };

  // The git keys belong to the vault state.json records; DECK_VAULT or the
  // ~/vault fallback is mode off.
  const vault = () => {
    const st = ctx.getState(), r = resolveVault({ state: st }), own = r.source === 'state';
    const v = own ? st.vault || {} : {};
    return { dir: r.path, v, own, mode: MODES.includes(v.git) ? v.git : v.created ? 'auto' : 'off' };
  };
  // The vault must be a repository of its own: `add -A` inside a bigger repo would commit that repo.
  async function root(dir) {
    const top = await out(dir, ['rev-parse', '--show-toplevel']);
    if (!top) return { root: null };
    return fs.realpathSync(top) === fs.realpathSync(dir) ? { root: dir } : { root: null, outer: top };
  }
  const changes = async (dir, spec) => porcelain(await read(dir, ['status', '--porcelain', '-z', '--untracked-files=all', ...(spec ? ['--', spec] : [])]));
  const headSha = dir => out(dir, ['rev-parse', '-q', '--verify', 'refs/heads/main']);
  const hasOrigin = async dir => !!(await out(dir, ['rev-parse', '-q', '--verify', 'refs/remotes/origin/main']));
  async function aheadBehind(dir) {
    if (!(await headSha(dir))) return { ahead: 0, behind: null };
    if (await hasOrigin(dir)) { const [a, b] = (await read(dir, ['rev-list', '--left-right', '--count', 'main...refs/remotes/origin/main'])).trim().split(/\s+/).map(Number); return { ahead: a, behind: b }; }
    return { ahead: Number((await read(dir, ['rev-list', '--count', 'main'])).trim()), behind: null };
  }
  async function remoteOf(dir, v) {
    const url = await out(dir, ['remote', 'get-url', 'origin']);
    const slug = slugOf(v.remote) || urlSlug(url);
    if (!slug) return null;
    const pushUrls = ((await out(dir, ['remote', 'get-url', '--push', '--all', 'origin'])) || '').split('\n').filter(Boolean);
    const c = checked && checked.owner === slug.owner && checked.name === slug.name ? checked : null;
    return { url, ...slug, private: c ? c.private : null, checkedAt: c ? c.at : null, pushUrls };
  }
  const pointsAt = (u, o, n) => { const s = urlSlug(u); return u === githubUrl(o, n) || (!!s && `${s.owner}/${s.name}`.toLowerCase() === `${o}/${n}`.toLowerCase()); };

  // Claude Code writing auto memory straight into the vault makes Memory/ live memory, not a mirror.
  function liveMemory(dir) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(claudeConfigDir({ state: ctx.getState() }).path, 'settings.json'), 'utf8'));
      return typeof s.autoMemoryDirectory === 'string' && isInside(path.resolve(expandHome(s.autoMemoryDirectory)), dir);
    } catch { return false; }
  }
  // Memory mirror: what to copy and delete, or why nothing may be touched.
  // Deck never overwrites or deletes a Memory/ file it did not write: a change
  // in Memory/ blocks the mirror unless it is exactly what the mirror would
  // make (a pass cut short before its commit).
  async function mirrorPlan(dir, v) {
    const from = path.resolve(expandHome(v.memoryMirror)), to = path.join(dir, 'Memory');
    const no = why => ({ why, from });
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) return no(`the memory folder ${tildify(from)} is missing; Memory/ is left as it is`);
    if (isInside(from, dir) || isInside(dir, from)) return no('the memory folder and the vault overlap; nothing mirrored');
    if (liveMemory(dir)) return no('Claude Code writes its auto memory into the vault (autoMemoryDirectory); Memory/ is live memory, nothing mirrored');
    const top = lstat(to);
    if (top && !top.isDirectory()) return no('Memory/ is a symlink or a file; nothing mirrored');
    const src = listFiles(from), dst = listFiles(to);
    if (!src.size && dst.size) return no(`the memory folder ${tildify(from)} is empty; Memory/ is left as it is`);
    const same = r => { const d = dst.get(r), s = src.get(r); return d && d.size === s.size && (d.mtimeMs === s.mtimeMs || fs.readFileSync(path.join(from, r)).equals(fs.readFileSync(path.join(to, r)))); };
    const dirty = (await changes(dir, 'Memory')).filter(c => path.basename(c.file) !== '.DS_Store');
    const foreign = dirty.filter(c => { const r = path.relative('Memory', c.file); return src.has(r) ? !same(r) : fs.existsSync(path.join(dir, c.file)); });
    if (foreign.length) return no(`Memory/ has changes Deck did not make (${plural(foreign.length, 'file')}); nothing mirrored`);
    const copy = [...src.keys()].filter(r => !same(r)), del = [...dst.keys()].filter(r => !src.has(r));
    // Files git ignores never show as changes, so they are checked by name.
    const ignored = new Set((await read(dir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', 'Memory'])).split('\0').filter(Boolean).map(f => path.relative('Memory', f)));
    const hidden = [...copy, ...del].filter(r => ignored.has(r));
    if (hidden.length) return no(`Memory/ has files git ignores that the mirror would change (${hidden.join(', ')}); nothing mirrored`);
    for (const r of [...copy, ...del]) {
      for (let d = path.dirname(r); d !== '.'; d = path.dirname(d)) { const s = lstat(path.join(to, d)); if (s && !s.isDirectory()) return no(`Memory/${d} is a symlink or a file; nothing mirrored`); }
      const s = lstat(path.join(to, r));
      if (s && !s.isFile()) return no(`Memory/${r} is not a regular file; nothing mirrored`);
    }
    return { from, to, src, copy, del, dirty: dirty.length };
  }
  async function mirrorStep(dir, v) {
    const p = await mirrorPlan(dir, v);
    errs.mirror = p.why || null;
    found.mirror = [];
    if (p.why) return;
    let copied = 0;
    for (const r of p.copy) {
      const lines = fs.readFileSync(path.join(p.from, r), 'utf8').split('\n'), held = [];
      lines.forEach((l, i) => { const kind = secretIn(l); if (kind) held.push({ file: `Memory/${r}`, line: i + 1, kind }); });
      if (held.length) { found.mirror.push(...held); continue; } // never copied, so never staged
      const dest = path.join(p.to, r), s = p.src.get(r);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(p.from, r), dest);
      fs.utimesSync(dest, s.atime, s.mtime);
      copied++;
    }
    for (const r of p.del) {
      fs.rmSync(path.join(p.to, r));
      for (let d = path.dirname(path.join(p.to, r)); d !== p.to && !fs.readdirSync(d).length; d = path.dirname(d)) fs.rmdirSync(d);
    }
    if (found.mirror.length) errs.mirror = `not mirrored, possible secret at ${where(found.mirror)}`;
    mirrored = { files: p.src.size - new Set(found.mirror.map(h => h.file)).size, at: now() };
    // The vault's pre-commit hook may stage other paths (say `git add -A --
    // Maps/Generated`) into a pathspec commit, so this one skips hooks.
    if (copied || p.del.length || p.dirty) await commit(dir, 'Memory', 'memory', n => `Memory: ${plural(n, 'file')}`, { verify: false });
    else { errs.memory = null; found.memory = []; }
  }

  // What a quiet spell watches: in auto the vault's changes (with each file's
  // size and mtime, so a file still being written resets the clock), in both
  // modes what the mirror would copy or delete.
  async function fingerprint(dir, v, mode) {
    let fp = '';
    if (mode === 'auto') {
      if (!(await root(dir)).root) return 'no repository yet';
      for (const { file } of await changes(dir)) {
        let s = 'gone';
        try { const st = fs.statSync(path.join(dir, file)); s = `${st.size}:${st.mtimeMs}`; } catch {}
        fp += `${file}:${s}\n`;
      }
    }
    if (v.memoryMirror && (await root(dir)).root) {
      const p = await mirrorPlan(dir, v);
      errs.mirror = p.why || errs.mirror;
      if (!p.why) fp += [...p.copy.map(r => `${r}:${p.src.get(r).size}:${p.src.get(r).mtimeMs}`), ...p.del.map(r => `-${r}`), ...(p.dirty ? [`dirty:${p.dirty}`] : [])].map(x => `M/${x}\n`).join('');
    }
    return fp;
  }

  async function identity(dir) {
    if ((await out(dir, ['config', 'user.name'])) && (await out(dir, ['config', 'user.email']))) return;
    await ok(dir, ['config', 'user.name', 'Deck']);
    await ok(dir, ['config', 'user.email', 'deck@localhost']);
  }
  // Takes paths out of the index again. Never stopped at quit. A failure is
  // loud; it stops pushing only when the files left staged hold a hit (a lock
  // another session holds for a moment must not stop pushing for good).
  async function unstage(dir, paths, key, { hit = false } = {}) {
    const r = await whole(dir, ['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], paths.join('\0'));
    if (r.code === 0) return;
    if (hit) blocked = true;
    const e = new Error(`could not unstage ${paths.join(', ')} (${tail(r)}); they are left staged${hit ? ' and pushing is stopped' : ', tried again next pass'}`);
    e.loud = true;
    errs[key] = e.message;
    throw e;
  }
  // Stages `spec`, scans what is staged, holds back files with a hit, commits
  // the rest. Anything else staged (another session's note) stays staged.
  async function commit(dir, spec, key, subject, { verify }) {
    await ok(dir, ['add', '-A', '--', spec]); // a failed add writes no index
    try {
      const ns = (await ok(dir, ['diff', '--cached', '--name-status', '--no-renames', '-z', '--', spec])).split('\0').filter(Boolean);
      const files = [];
      for (let i = 0; i + 1 < ns.length; i += 2) files.push({ st: ns[i], file: ns[i + 1] });
      found[key] = [];
      if (!files.length) { errs[key] = null; return null; }
      found[key] = scanDiff(await ok(dir, ['diff', '--cached', '-U0', '--text', '--no-textconv', '--no-color', '--no-ext-diff', '--no-renames', '--', spec]));
      const held = [...new Set(found[key].map(h => h.file))];
      if (held.length) await unstage(dir, held, key, { hit: true });
      errs[key] = held.length ? `held back, possible secret at ${where(found[key])}` : null;
      const rest = files.filter(f => !held.includes(f.file));
      if (!rest.length) return null;
      await identity(dir);
      await hook('staged', () => cur.abort());
      const body = rest.map(f => `${f.st} ${f.file}`);
      const msg = ['-m', subject(rest.length), '-m', (body.length > 200 ? [...body.slice(0, 200), `and ${body.length - 200} more`] : body).join('\n')];
      // `commit -- <paths>` takes those paths from the working tree, so the
      // held files are never named; a whole-vault commit takes the index.
      if (spec === '.') await ok(dir, ['commit', '-q', ...(verify ? [] : ['--no-verify']), ...msg], { hooks: true });
      else await ok(dir, ['commit', '-q', ...(verify ? [] : ['--no-verify']), ...msg, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: rest.map(f => f.file).join('\0') });
      if (mainSha) mainSha = await headSha(dir); // Deck's own commit does not restart the quiet clock
      return rest;
    } catch (e) {
      if (!e.loud) await unstage(dir, [spec], key);
      throw e;
    }
  }

  const failPush = msg => { errs.push = msg; lastPush = { at: now(), ok: false, error: msg }; nextPushAt = now() + quietMs; };
  async function isPrivate(o, n, timeoutMs = 30000) {
    let vis = null, why = 'no answer';
    try { vis = String(await gh(['api', '--hostname', 'github.com', `repos/${o}/${n}`, '--jq', '.visibility'], { timeoutMs, abort: cur.signal })).trim(); }
    catch (e) { why = cur.signal.aborted ? 'gave up: Deck quit first' : e.message; }
    checked = { owner: o, name: n, private: vis === 'private' ? true : vis ? false : null, at: now() };
    return vis === 'private' ? null : vis ? `${o}/${n} is ${vis}; Deck pushes only to a private repo` : `could not check that ${o}/${n} is private (${why}); no push`;
  }
  // Secrets added by the commits origin does not have, merge resolutions
  // included (remerge shows only what the resolution added, never origin's
  // own content again). A git without remerge falls back to skipping merges.
  async function scanUnpushed(dir, sha) {
    const args = ['log', '-p', '-U0', '--text', '--no-textconv', '--no-color', '--no-ext-diff', '--no-renames', '--format=%x01%H', sha, ...((await hasOrigin(dir)) ? ['--not', 'refs/remotes/origin/main'] : [])];
    try { errs.scan = null; return scanDiff(await ok(dir, [...args.slice(0, 2), '--diff-merges=remerge', ...args.slice(2)])); }
    catch (e) {
      if (!/diff-merges|remerge/.test(e.message)) throw e;
      errs.scan = 'this git cannot show merge resolutions (--diff-merges=remerge); they are not scanned before a push';
      return scanDiff(await ok(dir, [...args.slice(0, 2), '--no-merges', ...args.slice(2)]));
    }
  }
  async function push(dir, v, mode, { manual = false, quitting = false } = {}) {
    if ((blocked || now() < nextPushAt) && !manual) return;
    const r = await remoteOf(dir, v);
    if (!r) { if (manual) failPush('no remote: set a private GitHub repo first'); return; }
    const head = await headSha(dir);
    if (head !== mainSha) { mainSha = head; mainSince = now(); }
    if ((await aheadBehind(dir)).ahead === 0) { if (manual) errs.push = null; return; }
    // Other sessions commit to main all day: push mode waits until it has been still for a quiet spell.
    if (mode === 'push' && !manual && now() - mainSince < quietMs) return;
    if ((await out(dir, ['symbolic-ref', '--short', '-q', 'HEAD'])) !== 'main') return failPush('the vault is not on main; Deck pushes main only');
    if (!r.pushUrls.length) { await ok(dir, ['remote', 'add', 'origin', githubUrl(r.owner, r.name)]); r.pushUrls = [githubUrl(r.owner, r.name)]; }
    const stray = r.pushUrls.find(u => !pointsAt(u, r.owner, r.name));
    if (stray) return failPush(`origin pushes to ${stray}, not ${r.owner}/${r.name}; no push`);
    for (let attempt = 0; attempt < 2; attempt++) {
      // One commit is pinned, scanned and pushed: a commit that lands on main
      // meanwhile waits for the next pass and its own scan.
      const sha = (await read(dir, ['rev-parse', '--verify', 'refs/heads/main'])).trim();
      found.push = await scanUnpushed(dir, sha);
      if (found.push.length) return failPush(`no push: possible secret in an unpushed commit at ${where(found.push)}`);
      const why = await isPrivate(r.owner, r.name); // before every push
      if (why) return failPush(why);
      const p = await g(dir, ['push', '--porcelain', 'origin', `${sha}:refs/heads/main`]);
      if (p.code === 0) { errs.push = null; blocked = false; conflicts = []; lastPush = { at: now(), ok: true, error: null }; return; }
      const said = `${p.stdout}\n${p.stderr}`;
      if (attempt || !/\[rejected\]|non-fast-forward|fetch first/.test(said)) return failPush(cur.signal.aborted ? 'gave up: Deck quit before the push finished' : `push failed: ${said.trim().split('\n').slice(-2).join(' ')}`);
      if (quitting) return failPush('origin has new commits; Deck merges at the next start');
      await ok(dir, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
      const { behind } = await aheadBehind(dir);
      if (mode === 'push') return failPush(`origin has ${plural(behind, 'commit')} this Mac does not; mode push never merges`);
      if ((await changes(dir)).length) return failPush('origin has new commits; Deck merges them only on a clean tree');
      if (closed) return failPush('origin has new commits; Deck merges at the next start'); // no merge starts once quit has begun
      // Tried in memory first: a conflict never touches the working tree.
      const t = await run('git', [...GIT, 'merge-tree', '--write-tree', '--name-only', 'HEAD', 'refs/remotes/origin/main'], { cwd: dir, timeoutMs: 120000 });
      if (t.code === 1) {
        const lines = t.stdout.split('\n');
        conflicts = lines.slice(1, lines.indexOf('') < 0 ? undefined : lines.indexOf('')).filter(Boolean);
        blocked = true;
        return failPush(`pushing stopped: origin/main conflicts with this Mac in ${conflicts.join(', ')}; merge it by hand, then press Push`);
      }
      if (t.code !== 0) return failPush(`merge test failed: ${tail(t)}`);
      await identity(dir);
      merging = true;
      const m = await whole(dir, ['merge', '-q', '--no-edit', 'refs/remotes/origin/main'], undefined, { hooks: true }).finally(() => { merging = false; });
      if (m.code !== 0) {
        const a = await whole(dir, ['merge', '-q', '--abort']);
        if (a.code !== 0) { blocked = true; return failPush(`merge failed (${tail(m)}) and merge --abort failed (${tail(a)}): the vault needs a hand, pushing stopped`); }
        return failPush(`merge failed and was aborted: ${tail(m)}`);
      }
    }
  }

  // One pass: the mirror and its commit, the vault's commit (auto), the push.
  // A failed step is recorded and the next one still runs.
  async function cycle({ commitAll = true, mirrorNow = commitAll, manual = false, quitting = false } = {}) {
    const { dir, v, mode } = vault();
    if (mode === 'off' || !dir) return;
    const r = await root(dir);
    if (!r.root) {
      if (mode !== 'auto' || r.outer || !commitAll) return void (errs.vault = r.outer ? `the vault is inside another git repository (${tildify(r.outer)})` : 'the vault is not a git repository');
      await ok(dir, ['init', '-q', '-b', 'main']);
    }
    const gd = await read(dir, ['rev-parse', '--absolute-git-dir']);
    const mid = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].find(f => fs.existsSync(path.join(gd.trim(), f)));
    if (mid) return void (errs.vault = `the vault is in the middle of a git operation (${mid}); Deck commits and pushes nothing until it is finished`);
    if (mirrorNow && v.memoryMirror) { try { await mirrorStep(dir, v); } catch (e) { if (!e.loud) errs.memory = e.message; } }
    if (mode === 'auto' && commitAll) { try { await commit(dir, '.', 'vault', n => `Vault: ${plural(n, 'note')}`, { verify: true }); } catch (e) { if (!e.loud) errs.vault = e.message; } }
    try { await push(dir, v, mode, { manual, quitting }); } catch (e) { failPush(e.message); }
  }

  async function status() {
    const { dir, v, mode } = vault();
    const st = { repo: null, mode, branch: null, pending: 0, lastCommit: null, remote: null, ahead: null, behind: null, lastPush,
      memoryMirror: v.memoryMirror ? { from: v.memoryMirror, files: mirrored && mirrored.files, at: mirrored && mirrored.at } : null,
      error: null, secrets: Object.values(found).flat(), conflicts, blocked };
    const errors = () => Object.values(errs).filter(Boolean).join('; ') || null;
    if (!dir) return { ...st, error: 'no vault' };
    const r = await root(dir);
    if (!r.root) return { ...st, error: errors() || (r.outer ? `the vault is inside another git repository (${tildify(r.outer)})` : null) };
    try {
      Object.assign(st, { repo: dir, branch: await out(dir, ['symbolic-ref', '--short', '-q', 'HEAD']), pending: (await changes(dir)).length }, await aheadBehind(dir));
    } catch (e) { return { ...st, repo: dir, pending: null, error: [errors(), e.message].filter(Boolean).join('; ') }; }
    const log = await out(dir, ['log', '-1', '--format=%H%x1f%s%x1f%ct', '--name-only']);
    if (log) { const [head, ...files] = log.split('\n').filter(Boolean); const [sha, subject, ct] = head.split('\x1f'); st.lastCommit = { sha, subject, at: Number(ct) * 1000, files }; }
    let rem = await remoteOf(dir, v);
    // Asked again when unknown or older than a quiet spell, so the page knows before a push.
    if (rem && (rem.checkedAt == null || now() - rem.checkedAt >= quietMs) && !closed) { await isPrivate(rem.owner, rem.name, 10000); rem = await remoteOf(dir, v); }
    if (rem) { const { pushUrls, ...shown } = rem; st.remote = shown; }
    return { ...st, error: errors() };
  }
  const notOff = () => { if (vault().mode === 'off') throw new HttpError(409, 'git mode is off'); };

  return {
    status,
    // The quiet timer: a change resets the clock; quiet for quietMs, one commit.
    tick: () => {
      if (ticking || closed) return Promise.resolve();
      ticking = true;
      return serial(async () => {
        try {
          const { dir, v, mode } = vault();
          if (mode === 'off' || !dir) return;
          const fp = await fingerprint(dir, v, mode);
          if (fp !== lastFp) { lastFp = fp; changedAt = now(); }
          const quiet = fp && now() - changedAt >= quietMs;
          await cycle({ commitAll: !!quiet });
          if (quiet) { lastFp = await fingerprint(dir, v, mode); changedAt = now(); }
          errs.watch = null;
        } catch (e) { errs.watch = e.message; }
      }).finally(() => { ticking = false; });
    },
    commitNow: () => serial(() => { notOff(); return cycle(); }),
    pushNow: () => serial(() => { notOff(); blocked = false; nextPushAt = 0; return cycle({ commitAll: false, mirrorNow: true, manual: true }); }),
    // Create's first commit: the vault Deck just made, nothing pushed.
    initCreated: () => serial(async () => { const { dir } = vault(); if (dir && !(await root(dir)).root) { await ok(dir, ['init', '-q', '-b', 'main']); await commit(dir, '.', 'vault', n => `Vault: ${plural(n, 'note')}`, { verify: true }); } }),
    setRemote: (body = {}) => serial(async () => {
      const { dir, own } = vault();
      if (!own) throw new HttpError(409, 'the vault is not one Deck records (DECK_VAULT or the ~/vault fallback); adopt it first');
      if (!dir || !(await root(dir)).root) throw new HttpError(409, 'the vault is not a git repository yet');
      const url = await out(dir, ['remote', 'get-url', 'origin']);
      let slug;
      if (body.create != null) {
        if (!/^[A-Za-z0-9._-]+$/.test(String(body.create))) throw new HttpError(400, 'create needs a repo name');
        if (url) throw new HttpError(409, `origin already points at ${url}; use that repo, or remove origin first`); // before GitHub has a repo
        slug = urlSlug(String(await gh(['repo', 'create', String(body.create), '--private'], { timeoutMs: 60000, abort: cur.signal })).trim().split('\n').pop());
        if (!slug) throw new HttpError(502, 'gh repo create gave no repo URL');
      } else if (!(slug = slugOf(String(body.repo || '')))) throw new HttpError(400, 'repo must be owner/name');
      if (url && !pointsAt(url, slug.owner, slug.name)) throw new HttpError(409, `origin already points at ${url}`);
      if (!url) await ok(dir, ['remote', 'add', 'origin', githubUrl(slug.owner, slug.name)]);
      ctx.saveState(deepMerge(ctx.getState(), { vault: { remote: `${slug.owner}/${slug.name}` } }));
      await isPrivate(slug.owner, slug.name);
    }),
    setMode: mode => {
      if (!MODES.includes(mode)) throw new HttpError(400, `mode must be one of ${MODES.join(', ')}`);
      if (!vault().own) throw new HttpError(409, 'the vault is not one Deck records (DECK_VAULT or the ~/vault fallback); adopt it first');
      ctx.saveState(deepMerge(ctx.getState(), { vault: { git: mode } }));
    },
    // At quit: a running tick is stopped at once (a merge in progress is
    // waited for, within the budget), then one last pass gets what is left of
    // the budget, measured from here on the real clock. Quit never fetches or merges.
    async quit(ms = QUIT_MS) {
      const t0 = Date.now();
      closed = true;
      cur.abort();
      let late;
      const budget = new Promise(r => { late = setTimeout(() => r('late'), ms); });
      const first = await Promise.race([chain.then(() => 'done'), budget]);
      clearTimeout(late);
      if (first === 'late') { errs.push = merging ? 'a merge was still running at quit; Deck did not wait for it' : 'the last pass was still running at quit'; return; }
      cur = new AbortController();
      const t = setTimeout(() => cur.abort(), Math.max(0, ms - (Date.now() - t0)));
      nextPushAt = 0; // the last chance; a block still holds
      try { await serial(() => (vault().mode === 'off' ? null : cycle({ quitting: true }))); }
      catch (e) { errs.push = e.message; } finally { clearTimeout(t); cur.abort(); }
    },
  };
}

let inst = null, timer = null;
export function register(router, ctx, opts) {
  const vg = inst = vaultGit(ctx, opts);
  const status = async () => ({ status: await vg.status() });
  router.add('GET', '/api/vault/git', () => vg.status());
  router.add('POST', '/api/vault/git/commit', async () => { await vg.commitNow(); return status(); });
  router.add('POST', '/api/vault/git/push', async () => { await vg.pushNow(); return status(); });
  router.add('POST', '/api/vault/git/mode', async (req, res, { body }) => { vg.setMode((await body()).mode); return status(); });
  router.add('POST', '/api/vault/git/remote', async (req, res, { body }) => { await vg.setRemote(await body()); return status(); });
  return vg;
}
export const initCreated = () => inst && inst.initCreated();
export function start() { if (inst && !timer) { timer = setInterval(() => inst.tick(), POLL_MS); timer.unref(); } }
export async function stop() { if (!timer) return; clearInterval(timer); timer = null; await inst.quit(); }

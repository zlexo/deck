// Deck Vault, git: the vault's commits and its push to a private GitHub repo.
// Modes (state `vault.git`): `auto` (Deck's own vault: commit after a quiet
// spell and at quit, then push), `push` (push main when it is ahead; never
// commit or merge, except the Memory/ mirror), `off` (status only). Adopted
// vaults start `off`. Every commit is scanned for secrets first; every push
// first asks GitHub whether the repo is private. Never a rebase.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../core/proc.mjs';
import { gh as realGh } from '../core/gh.mjs';
import { deepMerge } from '../core/config.mjs';
import { expandHome, isInside, tildify } from '../core/paths.mjs';
import { HttpError } from '../core/http.mjs';
import { resolveVault } from '../core/vault.mjs';

export const MODES = ['auto', 'push', 'off'];
export const QUIET_MS = 10 * 60e3; // no change for this long, then commit
const POLL_MS = 30e3;
// The gateway gives every feature's stop() 2 s together (V2_STOP_MS); the
// quit commit and push finish inside this or are stopped.
export const QUIT_MS = 1500;

// High-confidence patterns only: a hit blocks the commit.
export const SECRETS = [
  ['Anthropic key', /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|\bsk-[A-Za-z0-9_-]{16,}T3BlbkFJ[A-Za-z0-9_-]{16,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{60,}/],
  ['AWS key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
];

// Secrets in the added lines of a `git diff -U0`, as { file, line, kind }:
// where they are, never what they are.
export function scanDiff(text) {
  const hits = [];
  let file = null, line = 0;
  for (const l of text.split('\n')) {
    if (l.startsWith('+++ ')) { file = l === '+++ /dev/null' ? null : l.slice(6); continue; }
    const h = /^@@ -\S+ \+(\d+)/.exec(l);
    if (h) { line = Number(h[1]); continue; }
    if (!file || !l.startsWith('+')) continue;
    for (const [kind, re] of SECRETS) if (re.test(l)) { hits.push({ file, line, kind }); break; }
    line++;
  }
  return hits;
}

const SLUG = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
const GH_URL = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const parse = re => s => { const m = re.exec(s || ''); return m ? { owner: m[1], name: m[2] } : null; };
const slugOf = parse(SLUG), urlSlug = parse(GH_URL);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

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

export function vaultGit(ctx, { gh = realGh, githubUrl = (o, n) => `https://github.com/${o}/${n}.git`, quietMs = QUIET_MS, now = Date.now } = {}) {
  const ac = new AbortController();
  let chain = Promise.resolve(), ticking = false, lastFp = '', changedAt = now(), nextPushAt = 0, blocked = false;
  let lastPush = null, checked = null, mirrored = null, conflicts = [];
  const found = { memory: [], vault: [] };
  const errs = { mirror: null, memory: null, vault: null, push: null };

  const serial = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
  const g = (dir, args, timeoutMs = 120000) => {
    if (ac.signal.aborted) throw new Error('gave up: Deck quit first');
    return run('git', ['-c', 'core.quotepath=false', ...args], { cwd: dir, timeoutMs, abort: ac.signal });
  };
  const ok = async (dir, args, t) => {
    const r = await g(dir, args, t);
    if (r.code !== 0) throw new Error(ac.signal.aborted ? 'gave up: Deck quit first' : `git ${args[0]}: ${(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').slice(-3).join(' ')}`);
    return r.stdout;
  };
  // Reads: local and quick, so not stopped at quit (status still answers after it).
  const out = async (dir, args) => {
    const r = await run('git', ['-c', 'core.quotepath=false', ...args], { cwd: dir, timeoutMs: 30000 });
    return r.code === 0 ? r.stdout.trim() : null;
  };

  const vault = () => {
    const st = ctx.getState(), r = resolveVault({ state: st }), v = st.vault || {};
    const mode = MODES.includes(v.git) ? v.git : r.source === 'state' && v.created ? 'auto' : 'off';
    return { dir: r.path, v, mode };
  };
  // The vault must be a repository of its own: `add -A` inside a bigger repo would commit that repo.
  async function root(dir) {
    const top = await out(dir, ['rev-parse', '--show-toplevel']);
    if (!top) return { root: null };
    return fs.realpathSync(top) === fs.realpathSync(dir) ? { root: dir } : { root: null, outer: top };
  }
  const changes = async dir => {
    const raw = await out(dir, ['status', '--porcelain', '-z', '--untracked-files=all']) || '';
    const items = [], parts = raw.split('\0');
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      items.push(parts[i].slice(3));
      if (/^[RC]/.test(parts[i])) i++; // a rename carries its old name next
    }
    return items;
  };
  async function aheadBehind(dir) {
    if (!(await out(dir, ['rev-parse', '-q', '--verify', 'refs/heads/main']))) return { ahead: 0, behind: null };
    const lr = await out(dir, ['rev-list', '--left-right', '--count', 'main...refs/remotes/origin/main']);
    if (lr) { const [a, b] = lr.split(/\s+/).map(Number); return { ahead: a, behind: b }; }
    return { ahead: Number(await out(dir, ['rev-list', '--count', 'main'])), behind: null };
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

  // Memory mirror: the plan (files to copy, files to delete), then applying it.
  function mirrorPlan(dir, v) {
    const from = path.resolve(expandHome(v.memoryMirror)), to = path.join(dir, 'Memory');
    let why = null;
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) why = `the memory folder ${tildify(from)} is missing; Memory/ is left as it is`;
    else if (isInside(from, dir) || isInside(dir, from)) why = 'the memory folder and the vault overlap; nothing mirrored';
    if (why) return { why, from };
    const src = listFiles(from), dst = listFiles(to);
    if (!src.size && dst.size) return { why: `the memory folder ${tildify(from)} is empty; Memory/ is left as it is`, from };
    const copy = [...src].filter(([r, s]) => {
      const d = dst.get(r);
      if (!d || d.size !== s.size) return true;
      return d.mtimeMs !== s.mtimeMs && !fs.readFileSync(path.join(from, r)).equals(fs.readFileSync(path.join(to, r)));
    }).map(([r, s]) => `${r}:${s.size}:${s.mtimeMs}`);
    return { from, to, src, copy, del: [...dst.keys()].filter(r => !src.has(r)) };
  }
  function mirror(dir, v) {
    const p = mirrorPlan(dir, v);
    errs.mirror = p.why || null;
    if (p.why) return;
    for (const c of p.copy) {
      const r = c.slice(0, c.indexOf(':')), dest = path.join(p.to, r), s = p.src.get(r);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(p.from, r), dest);
      fs.utimesSync(dest, s.atime, s.mtime);
    }
    for (const r of p.del) {
      fs.rmSync(path.join(p.to, r));
      for (let d = path.dirname(path.join(p.to, r)); d !== p.to && !fs.readdirSync(d).length; d = path.dirname(d)) fs.rmdirSync(d);
    }
    mirrored = { files: p.src.size, at: now() };
  }

  // What a quiet spell watches: in auto the vault's changes (with each file's
  // size and mtime, so a file still being written resets the clock), in both
  // modes what the mirror would copy or delete.
  async function fingerprint(dir, v, mode) {
    let fp = '';
    if (mode === 'auto') {
      if (!(await root(dir)).root) return 'no repository yet';
      for (const f of await changes(dir)) {
        let s = 'gone';
        try { const st = fs.statSync(path.join(dir, f)); s = `${st.size}:${st.mtimeMs}`; } catch {}
        fp += `${f}:${s}\n`;
      }
    }
    if (v.memoryMirror) {
      const p = mirrorPlan(dir, v);
      errs.mirror = p.why || null;
      if (!p.why) fp += [...p.copy, ...p.del.map(r => `-${r}`)].map(x => `M/${x}\n`).join('');
    }
    return fp;
  }

  async function identity(dir) {
    if ((await out(dir, ['config', 'user.name'])) && (await out(dir, ['config', 'user.email']))) return;
    await ok(dir, ['config', 'user.name', 'Deck']);
    await ok(dir, ['config', 'user.email', 'deck@localhost']);
  }
  // Stages `spec`, scans what is staged, commits only `spec`. Anything else
  // staged (another session's note) stays staged and uncommitted.
  async function commit(dir, spec, key, subject) {
    await ok(dir, ['add', '-A', '--', spec]);
    const ns = ((await out(dir, ['diff', '--cached', '--name-status', '--no-renames', '-z', '--', spec])) || '').split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i + 1 < ns.length; i += 2) files.push(`${ns[i]} ${ns[i + 1]}`);
    if (!files.length) { found[key] = []; errs[key] = null; return null; }
    found[key] = scanDiff(await ok(dir, ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--', spec]));
    if (found[key].length) {
      await g(dir, ['reset', '-q', '--', spec]);
      errs[key] = `nothing committed: possible secret at ${found[key].map(h => `${h.file}:${h.line} (${h.kind})`).join(', ')}`;
      return null;
    }
    await identity(dir);
    const body = files.length > 200 ? [...files.slice(0, 200), `and ${files.length - 200} more`] : files;
    await ok(dir, ['commit', '--no-verify', '-q', '-m', subject(files.length), '-m', body.join('\n'), ...(spec === '.' ? [] : ['--', spec])]);
    errs[key] = null;
    return files;
  }

  const failPush = msg => { errs.push = msg; lastPush = { at: now(), ok: false, error: msg }; nextPushAt = now() + quietMs; };
  async function isPrivate(o, n, timeoutMs = 30000) {
    let priv = null, why = 'no answer';
    try {
      const a = String(await gh(['api', `repos/${o}/${n}`, '--jq', '.private'], { timeoutMs, abort: ac.signal })).trim();
      priv = a === 'true' ? true : a === 'false' ? false : null;
    } catch (e) { why = ac.signal.aborted ? 'gave up: Deck quit first' : e.message; }
    checked = { owner: o, name: n, private: priv, at: now() };
    return priv === true ? null : priv === false ? `${o}/${n} is public; Deck pushes only to a private repo` : `could not check that ${o}/${n} is private (${why}); no push`;
  }
  async function push(dir, v, mode, manual) {
    if ((blocked || now() < nextPushAt) && !manual) return;
    const r = await remoteOf(dir, v);
    if (!r) { if (manual) failPush('no remote: set a private GitHub repo first'); return; }
    if ((await aheadBehind(dir)).ahead === 0) { if (manual) errs.push = null; return; }
    if ((await out(dir, ['symbolic-ref', '--short', '-q', 'HEAD'])) !== 'main') return failPush('the vault is not on main; Deck pushes main only');
    if (!r.pushUrls.length) { await ok(dir, ['remote', 'add', 'origin', githubUrl(r.owner, r.name)]); r.pushUrls = [githubUrl(r.owner, r.name)]; }
    const stray = r.pushUrls.find(u => !pointsAt(u, r.owner, r.name));
    if (stray) return failPush(`origin pushes to ${stray}, not ${r.owner}/${r.name}; no push`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const why = await isPrivate(r.owner, r.name); // before every push
      if (why) return failPush(why);
      const p = await g(dir, ['push', '--porcelain', 'origin', 'refs/heads/main:refs/heads/main']);
      if (p.code === 0) { errs.push = null; blocked = false; conflicts = []; lastPush = { at: now(), ok: true, error: null }; return; }
      const said = `${p.stdout}\n${p.stderr}`;
      if (attempt || !/\[rejected\]|non-fast-forward|fetch first/.test(said)) return failPush(ac.signal.aborted ? 'gave up: Deck quit before the push finished' : `push failed: ${said.trim().split('\n').slice(-2).join(' ')}`);
      await ok(dir, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
      const { behind } = await aheadBehind(dir);
      if (mode === 'push') return failPush(`origin has ${plural(behind, 'commit')} this Mac does not; mode push never merges`);
      if ((await changes(dir)).length) return failPush('origin has new commits; Deck merges them only on a clean tree');
      await identity(dir);
      const m = await g(dir, ['merge', '--no-edit', '--no-verify', 'refs/remotes/origin/main']);
      if (m.code !== 0) {
        conflicts = ((await out(dir, ['diff', '--name-only', '--diff-filter=U'])) || '').split('\n').filter(Boolean);
        await g(dir, ['merge', '--abort']);
        blocked = true;
        return failPush(conflicts.length ? `merge aborted, pushing stopped: origin/main conflicts in ${conflicts.join(', ')}` : `merge failed: ${(m.stderr || m.stdout).trim().split('\n').pop()}`);
      }
    }
  }

  // One pass: the mirror and its commit, the vault's commit (auto), the push.
  async function cycle({ commitAll = true, mirrorNow = commitAll, manual = false } = {}) {
    const { dir, v, mode } = vault();
    if (mode === 'off' || !dir) return;
    const r = await root(dir);
    if (!r.root) {
      if (mode !== 'auto' || r.outer || !commitAll) return void (errs.vault = r.outer ? `the vault is inside another git repository (${tildify(r.outer)})` : 'the vault is not a git repository');
      await ok(dir, ['init', '-q', '-b', 'main']);
    }
    const gd = await out(dir, ['rev-parse', '--absolute-git-dir']);
    const mid = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].find(f => fs.existsSync(path.join(gd, f)));
    if (mid) return void (errs.vault = `the vault is in the middle of a git operation (${mid}); Deck commits and pushes nothing until it is finished`);
    if (mirrorNow && v.memoryMirror) {
      mirror(dir, v);
      if (!errs.mirror) await commit(dir, 'Memory', 'memory', n => `Memory: ${plural(n, 'file')}`);
    }
    if (mode === 'auto' && commitAll) await commit(dir, '.', 'vault', n => `Vault: ${plural(n, 'note')}`);
    await push(dir, v, mode, manual);
  }

  async function status() {
    const { dir, v, mode } = vault();
    const st = { repo: null, mode, branch: null, pending: 0, lastCommit: null, remote: null, ahead: null, behind: null, lastPush,
      memoryMirror: v.memoryMirror ? { from: v.memoryMirror, files: mirrored && mirrored.files, at: mirrored && mirrored.at } : null,
      error: Object.values(errs).filter(Boolean).join('; ') || null, secrets: [...found.memory, ...found.vault], conflicts };
    if (!dir) return { ...st, error: 'no vault' };
    const r = await root(dir);
    if (!r.root) return { ...st, error: st.error || (r.outer ? `the vault is inside another git repository (${tildify(r.outer)})` : null) };
    Object.assign(st, { repo: dir, branch: await out(dir, ['symbolic-ref', '--short', '-q', 'HEAD']), pending: (await changes(dir)).length }, await aheadBehind(dir));
    const log = await out(dir, ['log', '-1', '--format=%H%x1f%s%x1f%ct', '--name-only']);
    if (log) { const [head, ...files] = log.split('\n').filter(Boolean); const [sha, subject, ct] = head.split('\x1f'); st.lastCommit = { sha, subject, at: Number(ct) * 1000, files }; }
    let rem = await remoteOf(dir, v);
    // Asked again when unknown or older than a quiet spell, so the page knows before a push.
    if (rem && (rem.checkedAt == null || now() - rem.checkedAt >= quietMs) && !ac.signal.aborted) { await isPrivate(rem.owner, rem.name, 10000); rem = await remoteOf(dir, v); }
    if (rem) { const { pushUrls, ...shown } = rem; st.remote = shown; }
    return st;
  }

  return {
    status,
    // The quiet timer: a change resets the clock; quiet for quietMs, one commit.
    tick: () => {
      if (ticking || ac.signal.aborted) return Promise.resolve();
      ticking = true;
      return serial(async () => {
        const { dir, v, mode } = vault();
        if (mode === 'off' || !dir) return;
        const fp = await fingerprint(dir, v, mode);
        if (fp !== lastFp) { lastFp = fp; changedAt = now(); }
        const quiet = fp && now() - changedAt >= quietMs;
        await cycle({ commitAll: !!quiet });
        if (quiet) { lastFp = await fingerprint(dir, v, mode); changedAt = now(); }
      }).finally(() => { ticking = false; });
    },
    commitNow: () => serial(() => { if (vault().mode === 'off') throw new HttpError(409, 'git mode is off'); return cycle({ manual: false }); }),
    pushNow: () => serial(() => { if (vault().mode === 'off') throw new HttpError(409, 'git mode is off'); blocked = false; nextPushAt = 0; return cycle({ commitAll: false, mirrorNow: true, manual: true }); }),
    // Create's first commit: the vault Deck just made, nothing pushed.
    initCreated: () => serial(async () => { const { dir } = vault(); if (dir && !(await root(dir)).root) { await ok(dir, ['init', '-q', '-b', 'main']); await commit(dir, '.', 'vault', n => `Vault: ${plural(n, 'note')}`); } }),
    setRemote: (body = {}) => serial(async () => {
      const { dir } = vault();
      if (!dir || !(await root(dir)).root) throw new HttpError(409, 'the vault is not a git repository yet');
      let slug;
      if (body.create != null) {
        if (!/^[A-Za-z0-9._-]+$/.test(String(body.create))) throw new HttpError(400, 'create needs a repo name');
        slug = urlSlug(String(await gh(['repo', 'create', String(body.create), '--private'], { timeoutMs: 60000 })).trim().split('\n').pop());
        if (!slug) throw new HttpError(502, 'gh repo create gave no repo URL');
      } else if (!(slug = slugOf(String(body.repo || '')))) throw new HttpError(400, 'repo must be owner/name');
      const url = await out(dir, ['remote', 'get-url', 'origin']);
      if (url && !pointsAt(url, slug.owner, slug.name)) throw new HttpError(409, `origin already points at ${url}`);
      if (!url) await ok(dir, ['remote', 'add', 'origin', githubUrl(slug.owner, slug.name)]);
      ctx.saveState(deepMerge(ctx.getState(), { vault: { remote: `${slug.owner}/${slug.name}` } }));
      await isPrivate(slug.owner, slug.name);
    }),
    // At quit: commit and push now, or stop every git and gh child at the budget.
    async quit(ms = QUIT_MS) {
      const t = setTimeout(() => ac.abort(), ms);
      nextPushAt = 0; // the last chance; a conflict still blocks
      try { await serial(() => (vault().mode === 'off' ? null : cycle())); }
      catch (e) { errs.push = e.message; } finally { clearTimeout(t); ac.abort(); }
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
  router.add('POST', '/api/vault/git/mode', async (req, res, { body }) => {
    const { mode } = await body();
    if (!MODES.includes(mode)) throw new HttpError(400, `mode must be one of ${MODES.join(', ')}`);
    ctx.saveState(deepMerge(ctx.getState(), { vault: { git: mode } }));
    return status();
  });
  router.add('POST', '/api/vault/git/remote', async (req, res, { body }) => { await vg.setRemote(await body()); return status(); });
  return vg;
}
export const initCreated = () => inst && inst.initCreated();
export function start() { if (inst && !timer) { timer = setInterval(() => inst.tick().catch(() => {}), POLL_MS); timer.unref(); } }
export async function stop() { if (!timer) return; clearInterval(timer); timer = null; await inst.quit(); }

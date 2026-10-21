// Shared fixtures for the Reviews tests: temp folders for data, vault and
// root (so no test touches the real state.json, records or vault), a small
// git repo with an "origin" holding PR refs, a fake kit and a fake gh. The
// fakes throw on anything they were not told about, so a test can never
// reach the API or post a status on GitHub.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SAMPLE_STATE, withSample } from '../fixtures/sample-config.mjs';

export function tmpEnv(name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `deck-${name}-`));
  process.env.DECK_DATA = path.join(tmp, 'data');
  process.env.DECK_VAULT = path.join(tmp, 'vault');
  process.env.DECK_ROOT = path.join(tmp, 'root');
  // One state.json for the whole test: the config folder is the root, and it
  // starts as the sample setup (Deck itself ships with no repos configured).
  process.env.DECK_CONFIG = process.env.DECK_ROOT;
  fs.mkdirSync(process.env.DECK_ROOT, { recursive: true });
  fs.writeFileSync(path.join(process.env.DECK_ROOT, 'state.json'), JSON.stringify(SAMPLE_STATE));
  return tmp;
}

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(dir, rel);
    if (text === null) { fs.rmSync(f, { force: true }); continue; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
}

function commit(dir, files, msg) {
  writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

export const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join('\n') + '\n';

// origin (bare) with main, two stacked PRs (7 on main, 8 on 7's branch) and
// GitHub-style refs/pull/N/head; `clone` has main only, so reviewing a PR
// has to fetch its head. Returns the SHAs and the PR objects gh would give.
export function makeFixture(tmp) {
  const work = path.join(tmp, 'work');
  const origin = path.join(tmp, 'origin.git');
  const clone = path.join(tmp, 'clone');
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.email', 't@t');
  git(work, 'config', 'user.name', 't');
  const app = ['function add(a, b) {', '  return a + b;', '}', '', 'function sub(a, b) {', '  return a - b;', '}', ''].join('\n');
  const base = commit(work, {
    'CONTRIBUTING.md': '# Contributing\nRule one: every change has a test.\n',
    'docs/design/0000-foundations.md': '# RFC 0000: Foundations\nNaming is snake_case.\n',
    'docs/design/0002-chunks.md': '# RFC 0002: Chunks\nA chunk is 32 cubed.\n',
    'docs/design/0003-meshing.md': '# RFC 0003: Meshing\nGreedy meshing.\n',
    'src/app.js': app,
    'src/long.js': lines('long', 60),
    'big.txt': lines('big', 3200),
    'package-lock.json': '{ "lockfileVersion": 3 }\n',
  }, 'base');
  git(work, 'checkout', '-qb', 'feat/a');
  const headA = commit(work, {
    'CONTRIBUTING.md': '# Contributing\nRule one: every change has a test.\nRule two: no em dashes.\n',
    'src/app.js': app.replace('return a - b;', 'return b - a; // swapped'),
    'src/new.js': 'export const answer = 42;\n',
    'src/long.js': lines('long', 60).replace('long line 30\n', 'long line 30 changed\n'),
    'big.txt': lines('big', 3200).replace('big line 1500\n', 'big line 1500 changed\n'),
    'package-lock.json': '{ "lockfileVersion": 3, "packages": {} }\n',
  }, 'feat a');
  git(work, 'checkout', '-qb', 'feat/b');
  const headB = commit(work, { 'src/new.js': 'export const answer = 43;\nexport const other = 1;\n' }, 'feat b');
  git(work, 'checkout', '-q', 'main');
  spawnSync('git', ['clone', '-q', '--bare', work, origin]);
  git(origin, 'update-ref', 'refs/pull/7/head', headA);
  git(origin, 'update-ref', 'refs/pull/8/head', headB);
  // --no-local: a local clone would hardlink every object, PR heads included.
  spawnSync('git', ['clone', '-q', '--no-local', '--branch', 'main', '--single-branch', origin, clone]);
  const pr7 = {
    number: 7, title: 'Swap sub and add a module', body: 'Builds on RFC 0002. Closes nothing.',
    headRefOid: headA, headRefName: 'feat/a', baseRefOid: base, baseRefName: 'main',
    isDraft: false, url: 'https://github.com/zlexo/perdix/pull/7', state: 'OPEN', closingIssuesReferences: [],
    createdAt: '2026-10-01T10:00:00Z',
  };
  const pr8 = {
    number: 8, title: 'Change the answer', body: 'Stacked on #7.',
    headRefOid: headB, headRefName: 'feat/b', baseRefOid: headA, baseRefName: 'feat/a',
    isDraft: false, url: 'https://github.com/zlexo/perdix/pull/8', state: 'OPEN', closingIssuesReferences: [],
    createdAt: '2026-10-02T10:00:00Z',
  };
  return { work, origin, clone, base, headA, headB, pr7, pr8, state: withSample({ repos: { perdix: { path: clone } } }) };
}

export class KitError extends Error {
  constructor(kind, message = kind, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

// A kit whose answers are queued per preset: an object is returned as the
// parsed JSON, an Error is thrown, a function is called with the request.
export function fakeKit({ review = [], verify = [], spend = null } = {}) {
  const calls = [];
  const queues = { 'review.normal': review, 'review.risky': review, 'review.verify': verify };
  return {
    calls,
    spendSummary: () => spend,
    PRESETS: { 'review.normal': { model: 'claude-sonnet-5-5' }, 'review.risky': { model: 'claude-opus-5-5' }, 'review.verify': { model: 'claude-sonnet-5-5' } },
    async call(req) {
      calls.push(req);
      const q = queues[req.preset];
      if (!q) throw new Error(`fake kit: unexpected preset ${req.preset}`);
      if (!q.length) throw new Error(`fake kit: no answer queued for ${req.preset}`);
      let a = q.shift();
      if (typeof a === 'function') a = await a(req);
      if (a instanceof Error) throw a;
      return { text: JSON.stringify(a), json: a, model: req.preset === 'review.risky' ? 'claude-opus-5-5' : 'claude-sonnet-5-5', requestId: `req_${calls.length}`, stopReason: 'end_turn', usage: {}, costUsd: 0.1, budget: { level: 'ok' } };
    },
  };
}

// gh by table: pr list per slug, pr view per slug#n, issues per slug#n.
// Status posts are recorded; anything unknown throws.
export function fakeGh({ lists = {}, views = {}, issues = {}, failList = {}, failPost = false } = {}) {
  const posts = [], calls = [];
  async function gh(args) {
    calls.push(args);
    const [a, b] = args;
    if (a === 'pr' && b === 'list') {
      const slug = args[args.indexOf('--repo') + 1];
      if (failList[slug]) throw new Error(failList[slug]);
      return JSON.stringify(lists[slug] || []);
    }
    if (a === 'pr' && b === 'view') {
      const slug = args[args.indexOf('--repo') + 1];
      const v = views[`${slug}#${args[2]}`];
      if (!v) throw new Error(`fake gh: no view for ${slug}#${args[2]}`);
      if (v instanceof Error) throw v;
      return JSON.stringify(v);
    }
    if (a === 'api' && b === '-X') {
      if (failPost) throw new Error('fake gh: post refused');
      const f = k => (args.find(x => x.startsWith(`${k}=`)) || '').slice(k.length + 1);
      posts.push({ path: args[3], state: f('state'), context: f('context'), description: f('description') });
      return '{}';
    }
    if (a === 'api' && /^repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(b)) {
      const m = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(b);
      const v = issues[`${m[1]}#${m[2]}`];
      if (!v) throw new Error('fake gh: HTTP 404');
      return JSON.stringify(v);
    }
    throw new Error(`fake gh: unexpected call ${args.join(' ')}`);
  }
  gh.posts = posts;
  gh.calls = calls;
  return gh;
}

export function putCi(dataDir, repo, sha, status = 'green') {
  const f = path.join(dataDir, 'ci', repo, `${sha}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ v: 1, repo, sha, status, startedAt: 1, jobs: [] }));
}

export function putJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

export const finding = (over = {}) => ({
  severity: 'should_fix', file: 'src/app.js', line_start: 6, line_end: 6, quote: 'return b - a; // swapped',
  problem: 'p', failure_scenario: 's', suggestion: 'g', ...over,
});

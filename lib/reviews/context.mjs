// The reviewer's context, assembled in the concept's fixed order so the
// cache prefix stays stable from one review to the next:
//   1. system prompt            (cached; identical for every review)
//   2. house rules + lessons    (cached; changes when the repo's rules do)
//   3. design context           (cached; the RFCs or issues the PR names)
//   4. stack context            (cached; the diffs of the PRs below it)
//   5. the pull request         (never cached; unique per head)
// The live checkouts belong to other sessions: everything is read from
// commits with `git show` and `git diff`, and a missing commit is fetched
// without touching any ref, FETCH_HEAD included.
import fs from 'node:fs';
import { run } from '../core/proc.mjs';
import { hasCommit, showBlob as showFile } from '../core/git.mjs';
import { expandHome, tildify } from '../core/paths.mjs';
import { vaultFile } from '../core/vault.mjs';
import { SYSTEM_PROMPT } from './prompt.mjs';
import { parseNameStatusZ, splitDiff, annotateChunk, numberLines, splitLines, isGenerated, isBinary } from './diff.mjs';

export const LIMITS = {
  tokens: 120000,          // over this (chars / 4) the PR goes hunks only, flagged partial
  fileBytes: 40 * 1024,    // full text of one changed file
  rulesBytes: 40 * 1024,   // one rules file, and the lessons file
  designDocs: 3,
  designBytes: 60 * 1024,  // one RFC
  issueBytes: 20 * 1024,   // one issue's body
  issueCandidates: 6,      // #N mentions looked up, at most
  stackDepth: 3,
  stackBytes: 60 * 1024,   // one stack PR's diff
};

const REPLACEMENT = String.fromCharCode(0xfffd);
export const estimateTokens = chars => Math.ceil(chars / 4);
const kb = n => `${Math.ceil(n / 1024)} KB`;
const attr = s => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/"/g, '&quot;');

// git with core.quotePath off and the output untrimmed: a diff's last line can
// be a single-space context line, and trimming would eat it.
async function gitOut(args, cwd, timeoutMs = 120000) {
  const r = await run('git', ['-c', 'core.quotePath=false', ...args], { cwd: expandHome(cwd), timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.code !== 0) {
    const why = r.error ? r.error.message : (r.stderr || r.stdout).trim().split('\n').slice(-4).join(' ');
    throw new Error(`git ${args.slice(0, 2).join(' ')} in ${tildify(expandHome(cwd))}: ${why || 'exit ' + r.code}`);
  }
  return r.stdout;
}

// A commit Deck needs and the checkout lacks is fetched into the object store
// only: no remote-tracking ref moves (--refmap=), no FETCH_HEAD is written, so
// another process fetching in the same checkout cannot hand us its SHA.
export async function ensureCommit(repoPath, sha, refspecs) {
  if (await hasCommit(repoPath, sha)) return;
  for (const spec of refspecs) {
    await run('git', ['fetch', '--quiet', '--no-write-fetch-head', '--refmap=', 'origin', spec], { cwd: expandHome(repoPath), timeoutMs: 300000 });
    if (await hasCommit(repoPath, sha)) return;
  }
  throw new Error(`commit ${sha.slice(0, 12)} is not in ${repoPath} and could not be fetched`);
}

export function capText(text, maxBytes) {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text, truncated: false, bytes };
  let cut = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  if (cut.endsWith(REPLACEMENT)) cut = cut.slice(0, -1); // a multibyte character cut in half
  const nl = cut.lastIndexOf('\n');
  if (nl > 0) cut = cut.slice(0, nl);
  return { text: `${cut}\n[truncated: the first ${kb(Buffer.byteLength(cut))} of ${kb(bytes)}]`, truncated: true, bytes };
}

// RFC numbers a Perdix PR names: "RFC 0011", "RFC-11", "RFCs 0006 and 0007",
// "docs/design/0011-horizon.md", a "docs(rfc): 0011 ..." title, an
// "rfc-0011-..." branch. Four digits, zero padded.
export function rfcNumbers(...texts) {
  const s = texts.filter(Boolean).join('\n');
  const out = new Set();
  for (const m of s.matchAll(/\bRFCs?[\s-]*(\d{1,4}(?:\s*(?:,|and|&|\/)\s*(?:RFC[\s-]*)?\d{1,4})*)\b/gi)) {
    for (const n of m[1].match(/\d{1,4}/g)) out.add(n.padStart(4, '0'));
  }
  for (const m of s.matchAll(/docs\/design\/(\d{4})-/g)) out.add(m[1]);
  for (const m of s.matchAll(/\(rfc\):\s*(\d{4})\b/gi)) out.add(m[1]);
  return [...out].sort();
}

// Issues a Modplex or Conduit PR links: the ones it closes first, then #N
// and issue URLs in its title and body, same repo only.
export function issueRefs(pr, slug) {
  const [owner, name] = slug.split('/');
  const out = [];
  const add = n => { n = Number(n); if (Number.isInteger(n) && n > 0 && n !== pr.number && !out.includes(n)) out.push(n); };
  for (const r of pr.closingIssuesReferences || []) {
    const rep = r.repository || {};
    const same = !rep.name || (rep.name === name && (!rep.owner || !rep.owner.login || rep.owner.login === owner));
    if (same) add(r.number);
  }
  const text = `${pr.title || ''}\n${pr.body || ''}`;
  for (const m of text.matchAll(/(?:^|[^\w/#&])#(\d{1,6})\b/g)) add(m[1]);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const m of text.matchAll(new RegExp(`github\\.com/${esc(owner)}/${esc(name)}/issues/(\\d+)`, 'g'))) add(m[1]);
  return out;
}

// The open PRs below this one: the PR whose head branch is this PR's base,
// and so on down, at most three. Bottom of the stack first, so the shared
// part of the prefix comes first.
export function stackChain(pr, openPrs, depth = LIMITS.stackDepth) {
  const chain = [];
  const seen = new Set([pr.number]);
  let cur = pr;
  while (chain.length < depth) {
    const parent = (openPrs || []).find(p => p.headRefName === cur.baseRefName && !seen.has(p.number));
    if (!parent) break;
    chain.push(parent);
    seen.add(parent.number);
    cur = parent;
  }
  return chain.reverse();
}

async function readRules(repo, headSha) {
  const parts = [], files = [];
  for (const rel of repo.rules) {
    const text = await showFile(repo.path, headSha, rel);
    if (text == null || isBinary(text)) continue;
    files.push(rel);
    parts.push(`<rules_file path="${attr(rel)}">\n${capText(text, LIMITS.rulesBytes).text}\n</rules_file>`);
  }
  const lessonsRel = `Knowledge/Review Lessons/${repo.name}.md`;
  let lessons = '';
  try {
    const text = fs.readFileSync(vaultFile(lessonsRel), 'utf8');
    if (text.trim()) {
      lessons = lessonsRel;
      parts.push(`<lessons source="vault: ${attr(lessonsRel)}">\n${capText(text, LIMITS.rulesBytes).text}\n</lessons>`);
    }
  } catch {} // no lessons note yet: empty
  if (!parts.length) parts.push('(no rules files and no lessons found)');
  const text = `<house_rules repo="${attr(repo.name)}">\nThe repository's own rules, read at the pull request's head commit, and the lessons kept for its reviews.\n\n${parts.join('\n\n')}\n</house_rules>`;
  return { text, files, lessons };
}

async function readDesign(repo, pr, headSha, changedPaths, d) {
  const docs = [], refs = [];
  if (repo.design === 'rfc') {
    const nums = rfcNumbers(pr.title, pr.body, pr.headRefName);
    if (nums.length) {
      const listing = await gitOut(['ls-tree', '--name-only', headSha, 'docs/design/'], repo.path);
      const byNum = new Map();
      for (const p of listing.split('\n')) {
        const m = /^docs\/design\/(\d{4})-[^/]*\.md$/.exec(p);
        if (m && !byNum.has(m[1])) byNum.set(m[1], p);
      }
      for (const n of nums) {
        const p = byNum.get(n);
        // A doc the PR changes is in the PR block already, and a rules file is in the rules block.
        if (!p || changedPaths.has(p) || repo.rules.includes(p)) continue;
        if (docs.length >= LIMITS.designDocs) break;
        const text = await showFile(repo.path, headSha, p);
        if (text == null) continue;
        refs.push(p);
        docs.push(`<rfc path="${attr(p)}">\n${capText(text, LIMITS.designBytes).text}\n</rfc>`);
      }
    }
  } else {
    for (const n of issueRefs(pr, repo.slug).slice(0, LIMITS.issueCandidates)) {
      if (docs.length >= LIMITS.designDocs) break;
      let issue;
      try { issue = JSON.parse(await d.gh(['api', `repos/${repo.slug}/issues/${n}`])); } catch { continue; }
      if (!issue || issue.pull_request) continue; // a PR number, not an issue
      refs.push(`#${n}`);
      const body = capText(String(issue.body || '(no description)'), LIMITS.issueBytes).text;
      docs.push(`<issue number="${n}" state="${attr(issue.state)}" title="${attr(issue.title)}">\n${body}\n</issue>`);
    }
  }
  if (!docs.length) return { text: null, refs };
  return { text: `<design_context>\nThe design documents or issues this pull request names, read at its head commit.\n\n${docs.join('\n\n')}\n</design_context>`, refs };
}

async function readStack(repo, pr, openPrs) {
  const out = [];
  for (const s of stackChain(pr, openPrs)) {
    if (!/^[0-9a-f]{40}$/.test(s.headRefOid || '') || !/^[0-9a-f]{40}$/.test(s.baseRefOid || '')) continue;
    await ensureCommit(repo.path, s.headRefOid, [`refs/pull/${s.number}/head`, s.headRefOid]);
    await ensureCommit(repo.path, s.baseRefOid, [`refs/heads/${s.baseRefName}`, s.baseRefOid]);
    const diff = await gitOut(['diff', '-U3', '--no-color', '-M', `${s.baseRefOid}...${s.headRefOid}`], repo.path);
    const files = parseNameStatusZ(await gitOut(['diff', '--name-status', '-z', '-M', `${s.baseRefOid}...${s.headRefOid}`], repo.path));
    out.push({ number: s.number, title: s.title, base: s.baseRefName, head: s.headRefName, diff: capText(diff, LIMITS.stackBytes).text, files: files.map(f => f.path) });
  }
  return out;
}

function stackBlock(s, withDiff) {
  const head = `<stack_pr number="${s.number}" title="${attr(s.title)}" base="${attr(s.base)}" head="${attr(s.head)}">\nAn open pull request below the one under review; it is context, not under review.`;
  return withDiff
    ? `${head}\n<diff>\n${s.diff}\n</diff>\n</stack_pr>`
    : `${head}\nIts diff was left out to fit the context. Files it changes: ${s.files.join(', ') || '(none)'}\n</stack_pr>`;
}

function prBlock(pr, repo, headSha, changed, chunks, files, { hunksOnly, notes }) {
  const diffs = chunks.map(c => {
    if (c.generated) return `${c.lines[0]}\n(generated file: its diff is not shown)`;
    if (c.omitted) return `${c.lines[0]}\n(diff of ${kb(c.annotated.length)} not shown, to fit the context)`;
    return c.annotated;
  }).join('\n');
  const parts = [
    `<pull_request repo="${attr(repo.slug)}" number="${pr.number}" base="${attr(pr.baseRefName)}" head="${attr(pr.headRefName)}" head_sha="${headSha}">`,
  ];
  if (notes.length) parts.push(`<partial_context>\nThe context is partial: ${notes.join('; ')}. Do not report problems in code you were not shown.\n</partial_context>`);
  parts.push(`<title>${pr.title || ''}</title>`);
  parts.push(`<body>\n${(pr.body || '').trim() || '(empty)'}\n</body>`);
  parts.push(`<changed_files>\n${changed.map(f => `${f.status} ${f.oldPath ? `${f.oldPath} -> ` : ''}${f.path}`).join('\n')}\n</changed_files>`);
  parts.push(`<diff>\n${diffs}\n</diff>`);
  if (!hunksOnly) parts.push(`<head_files>\n${files.join('\n')}\n</head_files>`);
  parts.push('</pull_request>');
  return parts.join('\n');
}

// Everything the review call needs, plus what verification and the record
// use. `pr` is gh's view of the PR; `headSha` is the head being reviewed
// (the one CI checked), `pr.baseRefOid` its base.
export async function assembleContext({ repo, pr, headSha, openPrs = [], deps: d }) {
  const baseSha = pr.baseRefOid;
  await ensureCommit(repo.path, headSha, [`refs/pull/${pr.number}/head`, headSha]);
  await ensureCommit(repo.path, baseSha, [`refs/heads/${pr.baseRefName}`, baseSha]);
  const range = `${baseSha}...${headSha}`;

  const changed = parseNameStatusZ(await gitOut(['diff', '--name-status', '-z', '-M', range], repo.path));
  const changedPaths = new Set(changed.flatMap(f => (f.oldPath ? [f.path, f.oldPath] : [f.path])));
  const chunks = splitDiff(await gitOut(['diff', '-U10', '--no-color', '-M', range], repo.path)).map(c => ({
    ...c, generated: !!c.path && isGenerated(c.path), annotated: annotateChunk(c.lines), omitted: false,
  }));

  // Head files: read once, used for the listing here and by verification.
  const headFiles = new Map();
  const readHead = async p => {
    if (!headFiles.has(p)) headFiles.set(p, await showFile(repo.path, headSha, p));
    return headFiles.get(p);
  };
  const files = [];
  let fullCount = 0;
  for (const f of changed) {
    if (f.status === 'D' || isGenerated(f.path)) continue;
    const text = await readHead(f.path);
    if (text == null) continue;
    if (isBinary(text)) { files.push(`<file path="${attr(f.path)}" omitted="binary"/>`); continue; }
    const bytes = Buffer.byteLength(text);
    if (bytes > LIMITS.fileBytes) { files.push(`<file path="${attr(f.path)}" omitted="${kb(bytes)}, over the 40 KB limit; the diff above shows its changes"/>`); continue; }
    fullCount++;
    files.push(`<file path="${attr(f.path)}" lines="${splitLines(text).length}">\n${numberLines(text)}\n</file>`);
  }

  const rules = await readRules(repo, headSha);
  const design = await readDesign(repo, pr, headSha, changedPaths, d);
  const stack = await readStack(repo, pr, openPrs);

  const notes = [];
  let hunksOnly = false, stackDiffs = true, designText = design.text;
  const build = () => {
    const blocks = [{ name: 'system', text: SYSTEM_PROMPT, cache: true }, { name: 'rules', text: rules.text, cache: true }];
    if (designText) blocks.push({ name: 'design', text: designText, cache: true });
    stack.forEach((s, i) => blocks.push({ name: `stack#${s.number}`, text: stackBlock(s, stackDiffs), cache: i === stack.length - 1 }));
    blocks.push({ name: 'pr', text: prBlock(pr, repo, headSha, changed, chunks, files, { hunksOnly, notes }), cache: false });
    return blocks;
  };
  const tokensOf = blocks => estimateTokens(blocks.reduce((n, b) => n + b.text.length, 0));
  let blocks = build();
  // Over the limit: hunks only first (the concept's rule), then the stack's
  // diffs, then the design documents, then the largest file diffs.
  if (tokensOf(blocks) > LIMITS.tokens && fullCount) {
    hunksOnly = true;
    notes.push(`hunks only, the full text of ${fullCount} changed file${fullCount === 1 ? '' : 's'} left out`);
    blocks = build();
  }
  if (tokensOf(blocks) > LIMITS.tokens && stack.length) {
    stackDiffs = false;
    notes.push('the stack diffs left out');
    blocks = build();
  }
  if (tokensOf(blocks) > LIMITS.tokens && designText) {
    designText = `<design_context>\nLeft out to fit the context: ${design.refs.join(', ')}\n</design_context>`;
    notes.push('the design context left out');
    blocks = build();
  }
  if (tokensOf(blocks) > LIMITS.tokens) {
    const order = chunks.filter(c => !c.generated).sort((a, b) => b.annotated.length - a.annotated.length);
    const before = notes.length;
    for (const c of order) {
      if (tokensOf(blocks) <= LIMITS.tokens) break;
      c.omitted = true;
      if (notes.length === before) notes.push('the largest file diffs left out');
      blocks = build();
    }
  }

  const content = blocks.slice(1).map(b => ({ type: 'text', text: b.text, ...(b.cache ? { cache: true } : {}) }));
  return {
    system: [{ text: SYSTEM_PROMPT, cache: true }],
    messages: [{ role: 'user', content }],
    meta: {
      rules: rules.files, lessons: rules.lessons, design: design.refs, stack: stack.map(s => s.number),
      tokensEst: tokensOf(blocks), partial: notes.length > 0, notes,
      blocks: blocks.map(b => ({ name: b.name, chars: b.text.length, cache: !!b.cache })),
    },
    changed,
    changedPaths: [...changedPaths],
    chunkFor: p => { const c = chunks.find(x => x.path === p); return c ? c.annotated : null; },
    readHead,
    rulesText: rules.text,
    designText: design.text,
  };
}

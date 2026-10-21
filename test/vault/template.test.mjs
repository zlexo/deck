// The vault template goes to every new user, so it may hold nothing of the
// person who wrote it. Two scans over every file name and every line:
// generic tells (home paths, e-mail addresses, the author's own vault path),
// and the strings in a private list that never reaches the repo:
// private-strings.local.txt at the repo root (git-ignored; one string per
// line, # for comments) or the file DECK_PRIVATE_STRINGS names. Without the
// list the second scan is skipped and says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = path.join(REPO, 'templates', 'vault');

const TELLS = [
  [/\/(Users|home)\/[^/\s]/, 'a home folder path'],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/, 'an e-mail address'],
  [/~\/vault\b/, 'a path to a vault on the author\'s machine'],
];

function templateLines() {
  const out = [];
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(TEMPLATE, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      out.push({ where: `${r} (its name)`, text: r });
      if (e.isDirectory()) walk(r);
      else fs.readFileSync(path.join(TEMPLATE, r), 'utf8').split('\n').forEach((text, i) => out.push({ where: `${r}:${i + 1}`, text }));
    }
  };
  walk('');
  return out;
}

function privateStrings() {
  const file = process.env.DECK_PRIVATE_STRINGS || path.join(REPO, 'private-strings.local.txt');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
}

test('template: the scan reads every file, the manual included', () => {
  const where = new Set(templateLines().map(l => l.where.split(':')[0]));
  for (const f of ['CLAUDE.md', 'Home.md', path.join('Boards', 'Work.md'), path.join('Templates', 'Project.md')]) assert.ok(where.has(f), f);
});

test('template: no generic tells (home paths, e-mail addresses, ~/vault)', () => {
  const hits = [];
  for (const l of templateLines()) for (const [re, what] of TELLS) if (re.test(l.text)) hits.push(`${l.where}: ${what}: ${l.text.trim()}`);
  assert.deepEqual(hits, []);
});

test('template: none of the strings in the private list', t => {
  const list = privateStrings();
  if (!list) { t.diagnostic('no private-strings.local.txt: the private scan is skipped'); return; }
  const hits = [];
  for (const l of templateLines()) for (const s of list) if (l.text.toLowerCase().includes(s.toLowerCase())) hits.push(`${l.where}: a string from the private list`);
  assert.deepEqual(hits, []);
});

test('template: the manual stays under 150 lines; each note template carries tags', () => {
  assert.ok(fs.readFileSync(path.join(TEMPLATE, 'CLAUDE.md'), 'utf8').split('\n').length < 150);
  for (const f of ['Project.md', 'Daily.md', 'Concept.md'])
    assert.match(fs.readFileSync(path.join(TEMPLATE, 'Templates', f), 'utf8'), /^---\n(.*\n)*tags: \[.+\]\n(.*\n)*---\n/, f);
});

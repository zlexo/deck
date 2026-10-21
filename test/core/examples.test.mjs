import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = JSON.parse(fs.readFileSync(path.join(REPO, 'examples', 'state.example.json'), 'utf8'));

test('examples/state.example.json: every reviewed or CI repo is a configured repo, with a whole entry', () => {
  const ids = Object.keys(example.repos);
  assert.ok(ids.length >= 1);
  for (const [id, r] of Object.entries(example.repos))
    for (const k of ['name', 'slug', 'path', 'project']) assert.ok(r[k], `${id}.${k}`);
  for (const id of Object.keys(example.reviews.repos)) assert.ok(ids.includes(id), `reviews.repos.${id}`);
  for (const [id, c] of Object.entries(example.ci.repos)) {
    assert.ok(ids.includes(id), `ci.repos.${id}`);
    assert.ok(c.jobs.length && c.jobs.every(j => j.name && Array.isArray(j.cmd) && j.cmd.length), `ci.repos.${id}.jobs`);
  }
});

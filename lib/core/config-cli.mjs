// `deck config`: where Deck reads each config item from, and
// `deck config migrate`, which copies a checkout's config (from before the
// move to the config folder) into the config folder. It never deletes the
// checkout's copies: a gateway built before the move still reads them, so they
// go only after Deck.app is rebuilt.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_ITEMS, configDir, configSource, deckRoot, tildify } from './paths.mjs';
import { ensureDir, writeTextAtomic, writeJsonAtomic } from './files.mjs';

const USAGE = `usage:
  deck config                        where each config item is read from
  deck config migrate [--dry-run]    copy the checkout's config into the config folder`;

const parses = buf => { try { JSON.parse(buf.toString('utf8')); return true; } catch { return false; } };

// The files one item holds, relative to `base`: a folder's .json files, or the file itself.
function filesOf(item, base) {
  const p = path.join(base, item);
  let st;
  try { st = fs.statSync(p); } catch { return []; }
  if (!st.isDirectory()) return [item];
  return fs.readdirSync(p).filter(f => f.endsWith('.json')).sort().map(f => path.join(item, f));
}

// What a migration would do, file by file: copy, same (already there, byte
// for byte), or conflict (there, but different: left alone).
export function plan() {
  const from = deckRoot(), to = configDir();
  const steps = [];
  for (const item of CONFIG_ITEMS) {
    for (const rel of filesOf(item, from)) {
      const src = path.join(from, rel), dst = path.join(to, rel);
      const data = fs.readFileSync(src);
      let action = 'copy';
      if (fs.existsSync(dst)) action = fs.readFileSync(dst).equals(data) ? 'same' : 'conflict';
      steps.push({ item, rel, src, dst, action, parses: parses(data) });
    }
  }
  return { from, to, steps };
}

// First run: with no config anywhere (nothing in the config folder and no old
// checkout holding any), the examples are copied in, so Deck opens on
// something it can run. "{deck}" in an example becomes this checkout's path.
// state.json records it, and the home page says where your own tools go.
export function seedFromExamples() {
  if (CONFIG_ITEMS.some(item => configSource(item) !== 'none')) return null;
  const src = path.join(deckRoot(), 'examples');
  if (!fs.existsSync(src)) return null;
  const deck = JSON.stringify(tildify(deckRoot())).slice(1, -1); // safe inside a JSON string
  const copied = [];
  for (const item of ['tools', 'projects', 'folders.json']) {
    for (const rel of filesOf(item, src)) {
      writeTextAtomic(path.join(configDir(), rel), fs.readFileSync(path.join(src, rel), 'utf8').split('{deck}').join(deck));
      copied.push(rel);
    }
  }
  writeJsonAtomic(path.join(configDir(), 'state.json'), { welcome: { seeded: true, dismissed: false } });
  return copied;
}

// A folder that does not exist in the config folder yet is staged next to it
// and renamed into place, so a running gateway never reads half of it.
export function migrate({ dryRun = false } = {}) {
  const p = plan();
  if (dryRun) return p;
  ensureDir(p.to);
  const byItem = new Map();
  for (const s of p.steps.filter(s => s.action === 'copy')) {
    if (!byItem.has(s.item)) byItem.set(s.item, []);
    byItem.get(s.item).push(s);
  }
  for (const [item, steps] of byItem) {
    const dest = path.join(p.to, item);
    const whole = steps[0].rel !== item && !fs.existsSync(dest);
    const stage = whole ? path.join(p.to, `.${item}.${process.pid}.tmp`) : null;
    if (stage) ensureDir(stage);
    for (const s of steps) {
      const target = stage ? path.join(stage, path.basename(s.rel)) : s.dst;
      const tmp = stage ? target : `${s.dst}.${process.pid}.tmp`;
      ensureDir(path.dirname(target));
      fs.copyFileSync(s.src, tmp);
      if (!stage) fs.renameSync(tmp, s.dst);
    }
    if (stage) fs.renameSync(stage, dest);
    for (const s of steps) s.verified = fs.readFileSync(s.dst).equals(fs.readFileSync(s.src));
  }
  return p;
}

function count(item, source) {
  const base = source === 'config' ? configDir() : source === 'checkout' ? deckRoot() : null;
  if (!base) return '';
  const n = filesOf(item, base).length;
  return n === 1 && filesOf(item, base)[0] === item ? '' : `(${n} file${n === 1 ? '' : 's'})`;
}

export function status() {
  return CONFIG_ITEMS.map(item => {
    const source = configSource(item);
    return { item, source, count: count(item, source) };
  });
}

export async function main(args = []) {
  const [sub, ...rest] = args;
  if (!sub) {
    console.log(`config folder: ${tildify(configDir())}`);
    console.log(`checkout:      ${tildify(deckRoot())}`);
    const rows = status();
    for (const r of rows) console.log(`  ${r.item.padEnd(13)} ${r.source.padEnd(9)} ${r.count}`.trimEnd());
    if (rows.some(r => r.source === 'checkout')) console.log('Some items still come from the checkout: run `deck config migrate`.');
    return 0;
  }
  if (sub !== 'migrate' || rest.some(a => a !== '--dry-run')) { console.log(USAGE); return 1; }
  const dryRun = rest.includes('--dry-run');
  const p = migrate({ dryRun });
  console.log(`${dryRun ? 'dry run: ' : ''}${tildify(p.from)} -> ${tildify(p.to)}`);
  if (!p.steps.length) { console.log('Nothing to copy: the checkout holds no config.'); return 0; }
  for (const s of p.steps) {
    const note = s.action === 'conflict' ? '  (differs: left as it is)' : s.verified === false ? '  (COPY DIFFERS)' : '';
    console.log(`  ${s.action.padEnd(9)} ${s.rel}${note}`);
    if (!s.parses) console.log(`  warning   ${s.rel} does not parse as JSON (copied as it is; Deck skips it, as before)`);
  }
  const n = a => p.steps.filter(s => s.action === a).length;
  const bad = p.steps.filter(s => s.verified === false).length;
  console.log(`${n('copy')} ${dryRun ? 'to copy' : 'copied'}, ${n('same')} already there, ${n('conflict')} conflict${n('conflict') === 1 ? '' : 's'}.`
    + (dryRun ? '' : ' The checkout keeps its copies until Deck.app is rebuilt.'));
  return n('conflict') || bad ? 1 : 0;
}

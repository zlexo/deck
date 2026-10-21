// Where Deck v2 keeps things. Never derive a path from import.meta.url under
// lib/: inside the Bun-compiled gateway it points into Bun's virtual
// filesystem, not the checkout. server.js and bin/deck.mjs set the root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root = process.env.DECK_ROOT || path.join(os.homedir(), 'yt', 'deck');

export function setDeckRoot(dir) { if (dir) root = dir; }
export function deckRoot() { return root; }

export function expandHome(p) {
  return typeof p === 'string' ? p.replace(/^~(?=\/|$)/, os.homedir()) : p;
}

export function tildify(p) {
  const home = os.homedir();
  return typeof p === 'string' && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p;
}

// Records, logs and ledgers. DECK_DATA moves it (every test sets it).
export function dataDir() {
  return expandHome(process.env.DECK_DATA || '~/Library/Application Support/Deck');
}
export function dataPath(...parts) { return path.join(dataDir(), ...parts); }

// Deck's own config: the tool and project manifests, the quick folders and
// state.json. It lives outside the checkout, so the repo carries nobody's
// setup. DECK_CONFIG moves it; by default it sits in the data folder.
export const CONFIG_ITEMS = ['tools', 'projects', 'folders.json', 'state.json'];

export function configDir() {
  return expandHome(process.env.DECK_CONFIG || path.join(dataDir(), 'config'));
}

// Where one config item is read from and written to. The config folder wins.
// A checkout that still holds the item (a Deck set up before the move) is the
// fallback until `deck config migrate` copies it over. With neither, the
// config folder, so a first write lands there.
export function configSource(name) {
  if (fs.existsSync(path.join(configDir(), name))) return 'config';
  if (fs.existsSync(path.join(root, name))) return 'checkout';
  return 'none';
}
export function configPath(name) {
  return path.join(configSource(name) === 'checkout' ? root : configDir(), name);
}

// True when `child` is `parent` itself or somewhere below it, compared after
// resolving, so "a/../../b" cannot pass as being inside "a".
export function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

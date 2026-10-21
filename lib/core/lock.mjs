// Cross-process locks: the CLI and the gateway are separate processes and both
// can start a CI run or a review. A lock is a file holding the owner's pid;
// a lock whose pid is gone is stale and gets taken over.
//
// Two races are closed by construction:
// - creating: the content is written to a temp file first and hard-linked into
//   place, so a lock file never exists without its owner in it;
// - taking over a stale lock: the stale file is renamed away and read back
//   before anything is deleted, so a fresh lock created by another process in
//   between is never removed.
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.mjs';
import { pidAlive } from './proc.mjs';

const lockFile = name => dataPath('locks', `${name}.lock`);

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function lockHolder(name) {
  const info = readLock(lockFile(name));
  return info && pidAlive(info.pid) ? info : null;
}

function tryCreate(file, content) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, content);
  try { fs.linkSync(tmp, file); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

// Removes the lock at `file` only if it is (still) stale.
function takeOverStale(file) {
  const parked = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`;
  try { fs.renameSync(file, parked); } catch { return; } // gone already: retry the create
  const info = readLock(parked);
  if (info && pidAlive(info.pid)) {
    // Not stale after all (created between our read and the rename): put it
    // back. If another lock appeared meanwhile, that one stays and this one
    // was already superseded by it.
    try { fs.linkSync(parked, file); } catch {}
  }
  try { fs.unlinkSync(parked); } catch {}
}

// Returns { release } or null when a live process holds the lock.
export function acquireLock(name, info = {}) {
  const file = lockFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = JSON.stringify({ pid: process.pid, ts: Date.now(), ...info });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(file, content)) {
      return {
        release() {
          const held = readLock(file);
          if (held && held.pid === process.pid) { try { fs.unlinkSync(file); } catch {} }
        },
      };
    }
    const holder = readLock(file);
    if (holder && pidAlive(holder.pid)) return null;
    if (!holder) {
      // Unreadable: written by an older version, or torn by a crash. Only a
      // file that has stood unreadable for a while is taken over.
      let age = Infinity;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch {}
      if (age < 10000) return null;
    }
    takeOverStale(file);
  }
  return null;
}

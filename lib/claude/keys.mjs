// API keys live in the macOS Keychain as generic passwords, one per tool
// (service deck-anthropic-<tool>, account $USER), created by hand. The key is
// read at call time and only handed to the SDK client: never written to disk,
// logged, returned by a route, or sent to a page.
import os from 'node:os';
import { run } from '../core/proc.mjs';
import { TOOLS } from './presets.mjs';

const account = () => process.env.USER || os.userInfo().username;

// security exits 44 when the item does not exist.
export async function readKey(tool) {
  const t = TOOLS[tool];
  if (!t) return null;
  const r = await run('/usr/bin/security', ['find-generic-password', '-s', t.service, '-a', account(), '-w'], { timeoutMs: 10000 });
  if (r.code !== 0) return null;
  const key = r.stdout.trim();
  return key || null;
}

// Whether the item exists, without reading the secret.
export async function hasKey(tool) {
  const t = TOOLS[tool];
  if (!t) return false;
  const r = await run('/usr/bin/security', ['find-generic-password', '-s', t.service, '-a', account()], { timeoutMs: 10000 });
  return r.code === 0;
}

export function keychainItem(tool) {
  const t = TOOLS[tool];
  return t ? { service: t.service, account: account() } : null;
}

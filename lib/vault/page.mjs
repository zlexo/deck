// What the Vault page reads beyond PR 1's routes: the board as columns of card
// titles, the apps that use the vault with their one-line status, and opening
// the vault in Obsidian. All read-only towards the vault.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { vaultDir } from '../core/vault.mjs';
import { HttpError } from '../core/http.mjs';

export const BOARD = path.join('Boards', 'Work.md');

// A card's title as the board shows it: wiki links by their label, bold and
// italics unwrapped.
export const cardTitle = s => s
  .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
  .replace(/(\*\*|__)(.+?)\1/g, '$2').trim();

// An Obsidian Kanban board: each `## heading` a column, each top-level
// checkbox under it a card. The front matter, indented lines (a card's
// details), the archive below `***` and the plugin's settings block are not
// cards.
export function parseBoard(text) {
  let body = String(text).replace(/\r\n/g, '\n');
  const fm = /^---\n[\s\S]*?\n---\n/.exec(body);
  if (fm) body = body.slice(fm[0].length);
  const columns = [];
  for (const line of body.split('\n')) {
    if (/^%% kanban:settings/.test(line) || /^\*\*\*\s*$/.test(line)) break;
    const h = /^## (.+?)\s*$/.exec(line);
    if (h) { columns.push({ title: h[1], cards: [] }); continue; }
    const c = /^[-*] \[([ xX])\] (.+)$/.exec(line);
    if (c && columns.length) columns[columns.length - 1].cards.push({ title: cardTitle(c[2]), done: c[1] !== ' ' });
  }
  return columns;
}

function needVault(ctx) {
  const v = vaultDir(ctx.getState());
  if (!v) throw new HttpError(409, 'no vault: create one or adopt a folder (/api/vault)');
  return v;
}

export function board(ctx) {
  const f = path.join(needVault(ctx), BOARD);
  if (!fs.existsSync(f)) return { file: BOARD, exists: false, columns: [] };
  return { file: BOARD, exists: true, columns: parseBoard(fs.readFileSync(f, 'utf8')) };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// The first line of what an app's `status` route answers: a JSON body's
// `status` field, or the text itself. Asked of this Mac only.
export async function appStatus(base, route, { timeoutMs = 1500 } = {}) {
  if (!base) return { status: null, statusError: 'the app has no url' };
  let u;
  try { u = new URL(route, base); } catch { return { status: null, statusError: 'bad status route' }; }
  if (!LOOPBACK.has(u.hostname)) return { status: null, statusError: 'the status route is not on this Mac' };
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { status: null, statusError: `status route answered ${r.status}` };
    const text = await r.text();
    let line = text;
    try { const j = JSON.parse(text); if (j && typeof j.status === 'string') line = j.status; } catch {}
    return { status: line.split('\n')[0].trim().slice(0, 200) || null, statusError: null };
  } catch { return { status: null, statusError: 'not running' }; }
}

// Every app on this Mac whose manifest says `vault: true`.
export async function vaultApps(ctx) {
  const manifests = ctx.loadManifests ? ctx.loadManifests() : {};
  const list = Object.values(manifests).filter(m => m.vault === true);
  const apps = await Promise.all(list.map(async m => {
    const url = ctx.toolUrl ? ctx.toolUrl(m) : null;
    const st = typeof m.status === 'string' && m.status ? await appStatus(url, m.status) : { status: null, statusError: null };
    return { id: m.id, name: m.name || m.id, description: m.description || '', url, statusRoute: m.status || null, ...st };
  }));
  return { apps: apps.sort((a, b) => a.name.localeCompare(b.name)) };
}

export const obsidianUrl = dir => `obsidian://open?path=${encodeURIComponent(dir)}`;

export function register(router, ctx, { open = url => execFile('open', [url]) } = {}) {
  router.add('GET', '/api/vault/board', () => board(ctx));
  router.add('GET', '/api/vault/apps', () => vaultApps(ctx));
  // Through `open`, as the webview has no handler for obsidian:// links.
  router.add('POST', '/api/vault/obsidian', () => {
    const url = obsidianUrl(needVault(ctx));
    open(url);
    return { ok: true, url };
  });
}

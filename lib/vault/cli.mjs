// `deck vault`: Claude Code's connection to the vault from a terminal. It works
// on the files directly, so Deck need not be running.
import { readStateFile } from '../core/config.mjs';
import { claudeStatus, connect, disconnect } from './claude.mjs';

const USAGE = `usage:
  deck vault status                                     the vault's connection to Claude Code
  deck vault connect [--dry-run] [--no-auto-memory]     show the changes, then make them
  deck vault disconnect                                 take out what Connect added`;

// A line diff (longest common subsequence): "-" before only, "+" after only.
export function lineDiff(before, after) {
  const lines = t => (t == null ? [] : t.replace(/\n$/, '').split('\n'));
  const a = lines(before), b = lines(after);
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
    else if (j < b.length && (i === a.length || L[i][j + 1] >= L[i + 1][j])) out.push(`+ ${b[j++]}`);
    else out.push(`- ${a[i++]}`);
  }
  return out.join('\n');
}

function printStatus(s) {
  console.log(`Claude Code ${s.installed ? 'installed' : 'not installed'}; config folder ${s.configDir} (${s.configSource})`);
  console.log(`  connected      ${s.connected ? 'yes' : 'no'}`);
  console.log(`  rules file     ${s.rulesFile ? `${s.rulesFile.path}${s.rulesFile.ours ? '' : ' (not written by Deck)'}` : 'none'}`);
  console.log(`  vault folder   ${s.additionalDirectory ? 'in additionalDirectories' : 'not in additionalDirectories'}`);
  console.log(`  auto memory    ${s.autoMemory.on ? 'into the vault' : s.autoMemory.dir ? `into ${s.autoMemory.dir}` : 'per repository'}; ${s.autoMemory.stopLoading} file(s) under projects/*/memory/`);
  if (s.settingsError) console.log(`  settings.json  does not parse: ${s.settingsError}`);
}

export async function main(args) {
  const [sub, ...flags] = args;
  const known = { status: [], connect: ['--dry-run', '--no-auto-memory'], disconnect: [] };
  if (!known[sub] || flags.some(f => !known[sub].includes(f))) { console.log(USAGE); return sub ? 1 : 0; }
  const state = readStateFile();
  if (sub === 'status') { printStatus(claudeStatus({ state })); return 0; }
  if (sub === 'disconnect') {
    const r = disconnect({ state });
    console.log(r.restored.length ? `restored: ${r.restored.join(', ')}` : 'nothing to take out');
    return 0;
  }
  const dryRun = flags.includes('--dry-run');
  const r = connect({ state, dryRun, autoMemory: !flags.includes('--no-auto-memory') });
  if (!r.changes.length) { console.log('already connected: nothing to change'); return 0; }
  for (const c of r.changes) console.log(`\n${c.path}${c.before == null ? ' (new)' : ''}\n${lineDiff(c.before, c.after)}`);
  if (r.backup) console.log(`\nbackup: ${r.backup}`);
  console.log(dryRun ? '\ndry run: nothing written' : '\nconnected');
  if (!flags.includes('--no-auto-memory') && r.status.autoMemory.stopLoading)
    console.log(`auto memory now goes into the vault; ${r.status.autoMemory.stopLoading} per-repository memory file(s) stop loading`);
  return 0;
}

// gh (GitHub CLI) through toolEnv, so it resolves inside the installed app too.
import { run } from './proc.mjs';

export class GhError extends Error {
  constructor(message, result) { super(message); this.name = 'GhError'; this.result = result; }
}

export async function gh(args, opts = {}) {
  const r = await run('gh', args, { timeoutMs: 60000, ...opts });
  if (r.error || r.code !== 0) {
    const why = r.error ? r.error.message : (r.stderr || r.stdout).trim().split('\n').slice(-4).join(' ');
    throw new GhError(`gh ${args.slice(0, 3).join(' ')}: ${why || 'exit ' + r.code}`, r);
  }
  return r.stdout;
}

export async function ghJson(args, opts) { return JSON.parse(await gh(args, opts)); }

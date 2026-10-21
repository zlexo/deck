#!/usr/bin/env node
// The `deck` command: the review gate, CI runs, the Claude kit's spend, and
// Mod Lab runs from a terminal or a merge script. See docs/v2/contract.md § 11.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDeckRoot } from '../lib/core/paths.mjs';

const root = path.dirname(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))));
process.env.DECK_ROOT ||= root;
setDeckRoot(process.env.DECK_ROOT);

const COMMANDS = {
  review: '../lib/reviews/cli.mjs',
  merge: '../lib/reviews/merge.mjs',
  ci: '../lib/ci/cli.mjs',
  claude: '../lib/claude/cli.mjs',
  modlab: '../lib/modlab/cli.mjs',
  config: '../lib/core/config-cli.mjs',
};

const USAGE = `usage:
  deck review <repo> <pr>                      run a review now
  deck review --check <repo> <pr>              the merge gate (exit 0 mergeable, 2 blocked,
                                               3 no review for budget/API, 4 head changed,
                                               5 no green CI, 6 not reviewed)
  deck review --override <repo> <pr> --reason <text>
  deck merge <repo> <pr> [--dry-run]           merge through the gate (stacks retargeted first)
  deck ci <repo> <pr|sha|main>                 run CI in a throwaway worktree
  deck ci --status <repo> <pr|sha>
  deck claude                                  keys, spend, caps
  deck modlab run <project> [scenario ...]     run a Mod Lab bench through the running Deck
  deck config                                  where each config item is read from
  deck config migrate [--dry-run]              copy the checkout's config into the config folder
repos: the ids in state.json's \`repos\` section (\`deck config\` shows where state.json is)`;

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === '-h' || cmd === '--help' || !COMMANDS[cmd]) {
  console.log(USAGE);
  process.exit(cmd && cmd !== '-h' && cmd !== '--help' ? 1 : 0);
}
let mod;
try { mod = await import(COMMANDS[cmd]); }
catch (e) { console.error(`deck ${cmd}: not available (${e.message})`); process.exit(1); }
if (typeof mod.main !== 'function') { console.error(`deck ${cmd}: not built yet`); process.exit(1); }
try { process.exitCode = await mod.main(rest); }
catch (e) { console.error(`deck ${cmd}: ${e.message}`); process.exitCode = 1; }

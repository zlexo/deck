// deck claude: the route, the CLI's login, keys, this month's spend against the caps, the last calls.
import { status } from './index.mjs';

const usd = v => `$${(Number(v) || 0).toFixed(2)}`;

export async function main() {
  const s = await status();
  console.log(`Claude kit, ${s.spend.month}`);
  const c = s.cli || {};
  console.log(`  route    ${s.route}`);
  console.log(`  cli      ${!c.installed ? 'not installed' : c.loggedIn ? `logged in${c.subscriptionType ? ` (${c.subscriptionType})` : ''}` : 'not logged in: run `claude auth login`'}${c.version ? `, claude ${c.version} at ${c.path}` : ''}`);
  for (const [tool, st] of Object.entries(s.keys)) {
    const k = s.keychain[tool];
    console.log(`  ${tool.padEnd(8)} key ${st.padEnd(7)} spent ${usd(s.spend.byTool[tool])} of ${usd(s.spend.caps[tool])} (${s.spend.levels[tool]})   Keychain: ${k.service} / ${k.account}`);
  }
  console.log(`  total    spent ${usd(s.spend.total)} of ${usd(s.spend.caps.total)} (${s.spend.levels.total}), ${s.spend.calls} calls`);
  if (s.creditsOut) console.log(`  CREDITS OUT since ${new Date(s.creditsOut.ts).toLocaleString()}: ${s.creditsOut.message}`);
  for (const c of s.recent.slice(0, 5)) {
    const cost = !c.ok ? c.error : c.route === 'cli' ? `plan (~${usd(c.est_usd)})` : usd(c.cost_usd);
    console.log(`  ${new Date(c.ts).toLocaleString()}  ${c.route || 'api'}  ${c.tool}/${c.preset}  ${cost}  ${c.ref || ''}`);
  }
  return 0;
}

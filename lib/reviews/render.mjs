// The .md next to each record: the same facts, laid out to read. Rendered
// from the record and its override only, so it can be rewritten at any time
// (an override rewrites it).
const SEV = { blocker: 'Blocker', should_fix: 'Should fix', nit: 'Nit', question: 'Question' };
const short = sha => String(sha || '').slice(0, 7);
const money = n => `$${(Number(n) || 0).toFixed(2)}`;
const when = ts => (ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown');

// A fence longer than any run of backticks inside the quote.
function fenced(text) {
  const runs = String(text).match(/`+/g) || [];
  const n = Math.max(3, ...runs.map(r => r.length + 1));
  return `${'`'.repeat(n)}\n${text}\n${'`'.repeat(n)}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function findingMd(f, i) {
  const out = [`### ${i + 1}. ${SEV[f.severity] || f.severity}: ${f.file}:${f.line_start}${f.line_end !== f.line_start ? `-${f.line_end}` : ''}`, '', fenced(f.quote), ''];
  if (f.problem) out.push(`**Problem.** ${f.problem}`, '');
  if (f.failure_scenario) out.push(`**How it breaks.** ${f.failure_scenario}`, '');
  if (f.suggestion) out.push(`**Suggestion.** ${f.suggestion}`, '');
  if (f.demoted) out.push(`Demoted from ${f.demoted.from} by the verify pass: ${f.demoted.reason}`, '');
  else if (f.verify) out.push(f.verify.real === true ? `Verified real: ${f.verify.why}` : `Not verified: ${f.verify.why}`, '');
  return out.join('\n');
}

export function renderMarkdown(r, override = null) {
  const lines = [`# Review: ${r.repo}#${r.pr} ${r.title || ''}`.trimEnd(), ''];
  lines.push(`- Head: \`${short(r.sha)}\` (${r.head || '?'} into ${r.base || '?'})`);
  if (r.status === 'failed') {
    const e = r.error || {};
    lines.push(`- Status: **not reviewed** (${e.kind || 'error'}${e.message ? `: ${e.message}` : ''})`);
    lines.push('- The gate allows this head on green CI alone; note it in the PR body.');
  } else {
    const findings = r.findings || [];
    const blockers = findings.filter(f => f.severity === 'blocker').length;
    const verdict = { pass: 'pass', pass_with_notes: 'pass with notes', blocked: 'blocked' }[r.verdict] || r.verdict;
    lines.push(`- Verdict: **${verdict}** (${plural(blockers, 'blocker')}, ${plural(findings.length - blockers, 'other finding')}, ${plural((r.dropped || []).length, 'dropped')})`);
    if (override) lines.push(`- Overridden by ${override.who} on ${when(override.ts)}: ${override.reason}`);
  }
  lines.push(`- Model: ${r.model || 'none'} (${r.preset || 'no preset'})${r.status === 'done' ? `, cost ${money(r.costUsd)}` : ''}`);
  const c = r.context || {};
  lines.push(`- Context: rules ${(c.rules || []).join(', ') || 'none'}; lessons ${c.lessons || 'none'}; design ${(c.design || []).join(', ') || 'none'}; stack ${(c.stack || []).map(n => `#${n}`).join(', ') || 'none'}; about ${Math.round((c.tokensEst || 0) / 1000)}k tokens${r.partial ? '; **partial context**' : ''}`);
  if ((r.risky || []).length) lines.push(`- Risky paths (routed to ${r.preset}): ${r.risky.join(', ')}`);
  lines.push(`- Reviewed: ${when(r.finishedAt)}`);
  if (r.githubStatus) lines.push(`- GitHub status: ${r.githubStatus.state} (${r.githubStatus.description})`);
  if (r.status === 'done') {
    lines.push('', '## Summary', '', r.summary || '(none)');
    lines.push('', '## Findings', '');
    if (!(r.findings || []).length) lines.push('None.');
    else lines.push((r.findings || []).map(findingMd).join('\n'));
    if ((r.dropped || []).length) {
      lines.push('', '## Dropped (did not match the head commit)', '');
      for (const d of r.dropped) {
        const f = d.finding || {};
        lines.push(`- ${f.severity || '?'} ${f.file || '?'}:${f.line_start ?? '?'}-${f.line_end ?? '?'}: ${d.reason}. ${f.problem ? `(${String(f.problem).replace(/\s+/g, ' ').trim()})` : ''}`.trimEnd());
      }
    }
  }
  return lines.join('\n') + '\n';
}

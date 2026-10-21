// Every failure the kit can raise, as one class with a `kind` each feature
// branches on (concept § 1, the error table). The mapping from the API's
// errors is in classify(); it never puts a key or a request body in a message.
import Anthropic from '@anthropic-ai/sdk';

export const KINDS = ['BudgetExhausted', 'CreditsOut', 'PlanLimit', 'CliOutdated', 'RateLimited', 'Overloaded', 'AuthMissing', 'BadRequest', 'Refused'];

export class ClaudeError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = kind;
    this.kind = kind;
    Object.assign(this, extra);
  }
}

// A 400 that is really "no money left": the credit balance or the workspace's
// spend limit. The API gives these no error type of their own, so the message
// is the only signal there is.
const SPEND_LIMIT = /credit balance|spend(ing)? limit|usage limit|billing|purchase credits|out of credits/i;

function header(err, name) {
  const h = err && err.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name);
  return h[name] ?? null;
}

export function classify(err) {
  if (err instanceof ClaudeError) return err;
  const requestId = err && (err.requestID || null);
  const status = err && err.status;
  const raw = (err && err.error && err.error.error && err.error.error.message) || (err && err.message) || String(err);
  const message = String(raw).slice(0, 300);
  if (err instanceof Anthropic.APIConnectionError || (!status && err && /connection|timed? ?out|ECONN|ENOTFOUND|fetch failed/i.test(message))) {
    return new ClaudeError('Overloaded', `network: ${message}`, { requestId });
  }
  if (status === 401) return new ClaudeError('AuthMissing', 'the key was rejected (missing or revoked)', { requestId, status });
  if (status === 402) return new ClaudeError('CreditsOut', `billing: ${message}`, { requestId, status });
  if (status === 400 && SPEND_LIMIT.test(message)) return new ClaudeError('CreditsOut', message, { requestId, status });
  if (status === 429) {
    const ra = Number(header(err, 'retry-after'));
    if (Number.isFinite(ra) && ra > 0) return new ClaudeError('RateLimited', `rate limited, retry after ${ra} s`, { requestId, status, retryAfterS: ra });
    // A 429 with no retry-after is the monthly tier cap, not a burst limit.
    return new ClaudeError('CreditsOut', `usage cap reached: ${message}`, { requestId, status });
  }
  if (status >= 500) return new ClaudeError('Overloaded', `${status}: ${message}`, { requestId, status });
  return new ClaudeError('BadRequest', status ? `${status}: ${message}` : message, { requestId, status });
}

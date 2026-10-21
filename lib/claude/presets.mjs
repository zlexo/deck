// The kit's presets and prices, kept in one table (concept § 1). Prices are
// USD per million tokens from the pricing docs, 2026-10-11: cache reads are
// $0.20 on both 5.5 models, cache writes 1.25x input for the 5-minute TTL and
// 2x for the 1-hour TTL. The fallback models a refused request can be served
// by are priced too, so a fallback's cost lands in the ledger.
export const PRICES = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
};

// cache: the TTL for blocks a caller marks `cache: true`, or null to send none.
export const PRESETS = {
  'review.normal': { model: 'claude-sonnet-5-5', effort: 'high', maxTokens: 32000, cache: '1h', use: 'a PR review' },
  'review.risky': { model: 'claude-opus-5-5', effort: 'high', maxTokens: 32000, cache: '1h', use: 'a PR touching a risky path' },
  'review.verify': { model: 'claude-sonnet-5-5', effort: 'low', maxTokens: 4000, cache: null, use: 'second look at a blocker' },
  'modlab.scenario': { model: 'claude-sonnet-5-5', effort: 'medium', maxTokens: 8000, cache: '5m', use: 'a scenario from a sentence' },
  'modlab.crash': { model: 'claude-sonnet-5-5', effort: 'high', maxTokens: 8000, cache: null, use: 'explain a crash' },
};

// Budget buckets and their Keychain items (generic passwords, account $USER).
export const TOOLS = {
  reviews: { service: 'deck-anthropic-reviews', label: 'Reviews' },
  modlab: { service: 'deck-anthropic-modlab', label: 'Mod Lab' },
};

export const DEFAULTS = {
  // auto: the API when the tool's key exists and neither the caps nor the
  // credits are out, else the claude CLI on the user's login. api or cli: only that.
  route: 'auto',
  caps: { reviews: 40, modlab: 10, total: 90 },
  warnAt: [0.5, 0.8],
};

// Above this, requests stream: the SDK refuses long non-streaming requests.
export const STREAM_ABOVE = 16000;

export const BASE_URL = 'https://api.anthropic.com';

// Reviews, the review gate (contract § 6): the runner, the gate, the queue and
// the routes. The record readers are shared with the badges and the pages.
import { registerRoutes } from './routes.mjs';
import { start as startQueue, stop as stopQueue } from './queue.mjs';

export { latestRecord, reviewFor, overrideFor, listReviews } from './records.mjs';
export { checkGate, gateFor, GATE } from './gate.mjs';
export { runReview, applyOverride } from './review.mjs';
export { configureReviews } from './deps.mjs';

export function register(router, ctx) { registerRoutes(router, ctx); }
export function start(ctx) { startQueue(ctx); }
export async function stop() { await stopQueue(); }

/**
 * Wall-clock budgets that survive a busy machine.
 *
 * The full suite runs five workers plus Postgres on the same box, so an
 * absolute "under 25 ms" measured in isolation can become 10x slower without
 * anything being wrong. `scaled()` measures how slow the machine is RIGHT NOW,
 * against a fixed piece of CPU work, and stretches the budget by that factor.
 * A real regression (an O(n^2), a query per row, a key fetch per value) is
 * still far larger than any plausible scale, so these keep failing when they
 * should. Ratio assertions (plugin vs raw, sealed vs plain, measured
 * back-to-back) need no scaling: contention hits both sides.
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** Milliseconds this workload takes on an idle development machine. */
const IDLE_MS = 28;
const CHUNK = Buffer.alloc(64 * 1024, 7);

function calibrateOnce(): number {
  const t0 = performance.now();
  const h = createHash('sha256');
  for (let i = 0; i < 128; i++) h.update(CHUNK); // 8 MB
  h.digest();
  return performance.now() - t0;
}

/** How many times slower than idle the machine is now (never below 1, capped at 25). */
export function slowdown(): number {
  // The minimum of a few short runs is the best estimate of the CPU's speed
  // under the load, ignoring one unlucky scheduling pause.
  const best = Math.min(calibrateOnce(), calibrateOnce(), calibrateOnce());
  return Math.min(25, Math.max(1, best / IDLE_MS));
}

/** A budget in ms, stretched by the current slowdown. */
export function scaled(budgetMs: number): number {
  return budgetMs * slowdown();
}

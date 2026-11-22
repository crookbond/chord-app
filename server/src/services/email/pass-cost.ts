/**
 * What one email costs us to process — a log line per AI pass call.
 *
 * Attribution differs per pass, and that is the whole point of logging it:
 * the classifier spends ONE call on a batch of up to 40 threads, while magics
 * and person-extraction spend one call per thread. Without `perThread` the two
 * numbers are not comparable, and the classifier looks expensive when it is the
 * cheap one.
 *
 * This file only LOGS. The `token_usage` row (the allowance, ADR 0196) is
 * written by the model itself: `getLlmForUser(db, userId, 'email_*')` wraps
 * Chord's key in `withUsageRecording` (ADR 0324). This file used to write that
 * row too, which also charged BYOK users for calls on their own key.
 */
import { logger } from '../../config/logging.js';
import type { LlmTokenUsage } from '../llm/types.js';

export interface PassCost {
  /** Which AI pass — `classify`, `magics`, `magics-deep`, `persons`. */
  pass: string;
  /** Whose mail, for the log line. */
  userId?: string;
  /** Threads this call covered. 1 for per-thread passes, up to the batch size
   *  for the classifier. */
  threads: number;
  model: string;
  /** Wall clock, so a cheap-but-slow pass is still visible. */
  ms: number;
}

/**
 * Collects usage from one `complete()` call and logs it once, per thread.
 *
 * Returns the `onUsage` callback to hand to the provider. A provider that
 * reports nothing never calls it, and `report` then logs `tokens: null` rather
 * than 0 — "we do not know" and "it was free" are different claims, and the
 * mock provider makes the second one true often enough to matter.
 */
export function trackPassCost(): {
  onUsage: (u: LlmTokenUsage) => void;
  report: (cost: PassCost) => void;
} {
  let seen: LlmTokenUsage | null = null;
  return {
    onUsage: (u) => {
      seen = u;
    },
    report: ({ pass, userId, threads, model, ms }) => {
      const total = seen ? seen.promptTokens + seen.completionTokens : null;
      logger.info(`email pass cost: ${pass}`, {
        pass,
        userId,
        threads,
        model,
        ms,
        promptTokens: seen?.promptTokens ?? null,
        completionTokens: seen?.completionTokens ?? null,
        totalTokens: total,
        // The number the benchmark is actually for. Rounded to a tenth — the
        // batch divides unevenly and false precision reads as measurement.
        tokensPerThread:
          total !== null && threads > 0 ? Math.round((total / threads) * 10) / 10 : null,
      });
    },
  };
}

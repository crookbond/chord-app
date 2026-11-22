/**
 * ADR 0324 — every model call made on Chord's key for a user writes a
 * `token_usage` row.
 *
 * Since ADR 0196 that table IS the allowance: remaining = allowance minus the
 * rows since the period began. A call that writes no row is free to the user,
 * paid by Chord, and makes both numbers wrong. `getLlmForUser` wraps Chord's
 * model in this for a named `source`, so a call site records by asking for a
 * model, not by remembering to. A BYOK model is never wrapped (ADR 0193:
 * their key, their cost).
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB, TokenUsageTable } from '../../db/schema.js';
import { newId } from '../../utils/ids.js';
import { recordTokenUsage } from '../tokens.service.js';
import type {
  LlmChunk,
  LlmCompleteOptions,
  LlmMessage,
  LlmService,
  LlmStreamOptions,
  LlmTokenUsage,
} from './types.js';

export type TokenSource = TokenUsageTable['source'];

const METERED = Symbol('chord.meteredSource');

/** The source a model records under, or null when it records nothing (the
 *  user's own key, or no user). For tests and diagnostics. */
export function meteredSource(llm: LlmService): TokenSource | null {
  return (llm as { [METERED]?: TokenSource })[METERED] ?? null;
}

export function withUsageRecording(
  inner: LlmService,
  db: Kysely<DB>,
  userId: string,
  source: TokenSource,
): LlmService {
  const record = async (seen: LlmTokenUsage | null, model: string) => {
    // A provider that reports nothing (the mock) records nothing: unmeasured
    // is not the same claim as free, and a guess must not drain an allowance.
    if (!seen || seen.promptTokens + seen.completionTokens <= 0) return;
    try {
      await recordTokenUsage(db, {
        userId,
        source,
        ref: newId('llm'),
        model,
        promptTokens: seen.promptTokens,
        completionTokens: seen.completionTokens,
        cachedTokens: seen.cachedTokens,
        costUsd: seen.costUsd,
      });
    } catch (err) {
      logger.warn('token usage record failed', { source, userId, err: (err as Error).message });
    }
  };
  // Each provider reports once per call; the last report is the call's total.
  const watch = <O extends LlmCompleteOptions>(opts: O | undefined) => {
    let seen: LlmTokenUsage | null = null;
    const withHook = {
      ...(opts ?? {}),
      onUsage: (u: LlmTokenUsage) => {
        seen = u;
        opts?.onUsage?.(u);
      },
    } as O;
    return { withHook, seen: () => seen, model: opts?.model ?? inner.defaultModel };
  };
  const metered: LlmService & { [METERED]: TokenSource } = {
    [METERED]: source,
    providerName: inner.providerName,
    defaultModel: inner.defaultModel,
    supportsNativeTools: inner.supportsNativeTools,
    async complete(messages: LlmMessage[], opts?: LlmCompleteOptions) {
      const w = watch(opts);
      try {
        return await inner.complete(messages, w.withHook);
      } finally {
        await record(w.seen(), w.model);
      }
    },
    async *stream(messages: LlmMessage[], opts?: LlmStreamOptions): AsyncIterable<LlmChunk> {
      const w = watch(opts);
      try {
        for await (const chunk of inner.stream(messages, w.withHook)) yield chunk;
      } finally {
        await record(w.seen(), w.model);
      }
    },
  };
  return metered;
}

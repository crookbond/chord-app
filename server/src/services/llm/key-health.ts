/**
 * ADR 0252 — what state a user's own model key is in, kept where the Email tab,
 * Settings and the one-time chat nudge can all read it.
 *
 * The chat reply to a failed turn (ADR 0044) already tells the user their key is
 * out of credit, but only when they happen to chat. Every background AI pass
 * (email sorting, suggestions, people, the morning briefing) used to fail with
 * a log line and nothing else, so the first the user knew was the day they
 * asked something. Recording the failure at the one place every BYOK call goes
 * through — the LLM handed out for their key — means no pass has to remember to.
 */
import { sql, type Kysely } from 'kysely';

import type { ByokKeyIssue } from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import { runInBackground } from '../../utils/background.js';
import { describeSystemLlm } from './system-llm.js';
import type { DB } from '../../db/schema.js';
import { byokFailureMessage, byokTopUpUrl, classifyLlmError } from './errors.js';
import type {
  LlmChunk,
  LlmCompleteOptions,
  LlmMessage,
  LlmService,
  LlmStreamOptions,
} from './types.js';

/** What stops while the key is unusable. Said once, in the nudge and the banner.
 *  True because everything AI that Chord does for a BYOK user runs on their key
 *  (ADR 0257). */
export const BYOK_PAUSED_CONSEQUENCE =
  "Until it's fixed, Chord can't answer your messages, sort your email, suggest to-dos from it, or write your morning briefing.";

type IssueKind = 'credit' | 'auth';

/**
 * Record a failure of the user's own key. Only the two kinds that are the
 * user's to fix count: a rate limit or a provider outage says nothing about
 * their key, and flagging it would cry wolf. A repeat of the same kind keeps
 * the original timestamp and its nudge state; a different kind is a new outage.
 */
export async function noteByokKeyFailure(
  db: Kysely<DB>,
  userId: string,
  err: unknown,
): Promise<void> {
  const kind = classifyLlmError(err).kind;
  if (kind !== 'credit' && kind !== 'auth') return;
  const now = new Date().toISOString();
  await db
    .updateTable('users')
    .set({
      byok_key_issue_at: sql<string>`CASE WHEN byok_key_issue IS DISTINCT FROM ${kind}::text THEN ${now}::text ELSE byok_key_issue_at END`,
      byok_key_nudged_at: sql<string | null>`CASE WHEN byok_key_issue IS DISTINCT FROM ${kind}::text THEN NULL ELSE byok_key_nudged_at END`,
      byok_key_issue: kind,
    })
    .where('id', '=', userId)
    .where('model_key_ciphertext', 'is not', null)
    .execute();
}

/** The key works again (or was replaced/removed): forget the outage. */
export async function clearByokKeyIssue(db: Kysely<DB>, userId: string): Promise<void> {
  await db
    .updateTable('users')
    .set({ byok_key_issue: null, byok_key_issue_at: null, byok_key_nudged_at: null })
    .where('id', '=', userId)
    .where('byok_key_issue', 'is not', null)
    .execute();
}

/** The user has already been told about this outage (e.g. by the chat reply). */
export async function markByokKeyNudged(db: Kysely<DB>, userId: string): Promise<void> {
  await db
    .updateTable('users')
    .set({ byok_key_nudged_at: new Date().toISOString() })
    .where('id', '=', userId)
    .where('byok_key_issue', 'is not', null)
    .where('byok_key_nudged_at', 'is', null)
    .execute();
}

/** The wording shared by the chat nudge, the Email tab banner and Settings. */
export function describeByokKeyIssue(
  provider: 'openai' | 'anthropic' | 'gemini' | 'mock',
  kind: IssueKind,
  baseUrl: string | null | undefined,
): { message: string; topUpUrl: string | null } {
  const failure = byokFailureMessage(provider, kind, baseUrl) ?? '⚠️ Your AI key needs attention.';
  return {
    message: `${failure} ${BYOK_PAUSED_CONSEQUENCE}`,
    topUpUrl: kind === 'credit' ? byokTopUpUrl(provider, baseUrl) : null,
  };
}

/** What else a person with a dead key can be offered that actually exists here. */
export function byokFallback(): 'plan' | 'system' | undefined {
  if (env.BILLING_ENABLED) return 'plan';
  return describeSystemLlm() ? 'system' : undefined;
}

export async function getByokKeyIssue(
  db: Kysely<DB>,
  userId: string,
): Promise<ByokKeyIssue | null> {
  const row = await db
    .selectFrom('users')
    .select([
      'model_provider',
      'model_base_url',
      'model_key_ciphertext',
      'byok_key_issue',
      'byok_key_issue_at',
    ])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row?.model_key_ciphertext || !row.byok_key_issue || !row.model_provider) return null;
  const { message, topUpUrl } = describeByokKeyIssue(
    row.model_provider,
    row.byok_key_issue,
    row.model_base_url,
  );
  const fallback = byokFallback();
  return {
    kind: row.byok_key_issue,
    message,
    since: row.byok_key_issue_at ?? new Date(0).toISOString(),
    ...(fallback ? { fallback } : {}),
    ...(topUpUrl ? { topUpUrl } : {}),
  };
}

/**
 * Wrap the LLM handed out for a user's own key so every call reports how it
 * went: a credit/auth failure is recorded, and a call that works clears an
 * outage that was on record. Failures are rethrown untouched.
 */
export function withKeyHealth(
  inner: LlmService,
  db: Kysely<DB>,
  userId: string,
  hadIssue: boolean,
): LlmService {
  let outage = hadIssue;
  const worked = () => {
    if (!outage) return;
    outage = false;
    runInBackground(
      clearByokKeyIssue(db, userId).catch((err) =>
        logger.warn('byok key health: clear failed', { userId, err }),
      ),
    );
  };
  const failed = (err: unknown) => {
    runInBackground(
      noteByokKeyFailure(db, userId, err).catch((e) =>
        logger.warn('byok key health: record failed', { userId, err: e }),
      ),
    );
  };
  return {
    providerName: inner.providerName,
    defaultModel: inner.defaultModel,
    supportsNativeTools: inner.supportsNativeTools,
    async complete(messages: LlmMessage[], opts?: LlmCompleteOptions) {
      try {
        const out = await inner.complete(messages, opts);
        worked();
        return out;
      } catch (err) {
        failed(err);
        throw err;
      }
    },
    async *stream(messages: LlmMessage[], opts?: LlmStreamOptions): AsyncIterable<LlmChunk> {
      try {
        for await (const chunk of inner.stream(messages, opts)) yield chunk;
      } catch (err) {
        failed(err);
        throw err;
      }
      worked();
    },
  };
}

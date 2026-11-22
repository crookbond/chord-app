/**
 * Store a user's own model key (BYOK). One place for the rule both entry points
 * share — the Settings form (`PUT /me/model-key`) and the OpenRouter connect
 * flow (ADR 0235): check the key with one tiny call BEFORE keeping it, so a dead
 * key / wrong model / empty balance surfaces now rather than mid-conversation in
 * front of the group (ADR 0044), then seal it at rest.
 */
import type { Kysely } from 'kysely';

import type { ModelProvider } from '@chord/kernel';

import type { DB } from '../db/schema.js';
import { logger } from '../config/logging.js';
import { sealToken } from '../utils/crypto-tokens.js';
import { assertSafeModelEndpoint, BlockedHostError } from '../utils/ssrf.js';
import { byokFailureMessage, type LlmErrorKind } from './llm/errors.js';
import { validateUserModelKey } from './llm/factory.js';

export interface ModelKeyInput {
  provider: ModelProvider;
  apiKey: string;
  model: string;
  /** OpenAI-compatible endpoint (OpenRouter, Ollama, vLLM, …). */
  baseUrl?: string;
}

export type SaveModelKeyResult =
  | { ok: true; /** Kept although the account has no credit yet. */ unfunded: boolean }
  | { ok: false; kind: LlmErrorKind; message: string };

export async function saveModelKey(
  db: Kysely<DB>,
  userId: string,
  input: ModelKeyInput,
  opts: { keepIfUnfunded?: boolean } = {},
): Promise<SaveModelKeyResult> {
  // ADR 0269 — the validation call below is a request the server makes to a
  // URL the user typed. Screen it first, or saving a key is an SSRF probe.
  if (input.baseUrl) {
    try {
      await assertSafeModelEndpoint(input.baseUrl);
    } catch (err) {
      const message = err instanceof BlockedHostError ? err.message : 'That endpoint cannot be used.';
      return { ok: false, kind: 'other', message };
    }
  }
  const check = await validateUserModelKey({
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
    baseURL: input.baseUrl,
  });
  let unfunded = false;
  if (!check.ok) {
    // A key that is valid but has no money behind it is the user's to top up,
    // not a reason to throw away a key that was just minted for them — the
    // connect flow keeps it and says what is missing.
    if (check.error.kind === 'credit' && opts.keepIfUnfunded) {
      unfunded = true;
    } else {
      // The upstream text is NOT relayed: for a user-supplied endpoint it can
      // be anything that host returns (an internal error page, a stack trace).
      logger.warn('model key validation failed', {
        userId,
        provider: input.provider,
        kind: check.error.kind,
        err: check.error.message,
      });
      const message =
        byokFailureMessage(input.provider, check.error.kind, input.baseUrl) ??
        `Couldn't reach ${input.provider} with that key and model. Check the model name${input.baseUrl ? ' and endpoint URL' : ''}, then try again.`;
      return { ok: false, kind: check.error.kind, message };
    }
  }
  const sealed = sealToken(input.apiKey);
  // A replaced key starts clean. One kept with no credit is the same outage the
  // connect flow just explained, so it is on record (for the banner) but not
  // nudged again.
  const now = new Date().toISOString();
  await db
    .updateTable('users')
    .set({
      model_provider: input.provider,
      model_name: input.model,
      model_base_url: input.baseUrl ?? null,
      model_key_ciphertext: sealed.ciphertext,
      model_key_iv: sealed.iv,
      model_key_tag: sealed.tag,
      byok_key_issue: unfunded ? 'credit' : null,
      byok_key_issue_at: unfunded ? now : null,
      byok_key_nudged_at: unfunded ? now : null,
    })
    .where('id', '=', userId)
    .execute();
  return { ok: true, unfunded };
}

import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { openToken } from '../../utils/crypto-tokens.js';
import { modelEndpointFetch } from '../../utils/ssrf.js';
import { AiConsentRequiredError, hasAiConsent } from '../ai-consent.service.js';
import { type Entitlement, getEntitlement } from '../billing.service.js';
import { AnthropicLlmService } from './anthropic.service.js';
import { type ClassifiedLlmError, classifyLlmError } from './errors.js';
import { GeminiLlmService } from './gemini.service.js';
import { MockLlmService } from './mock.service.js';
import { OpenAICompatService } from './openai.service.js';
import type { LlmCompleteOptions, LlmService, LlmTokenUsage } from './types.js';
import { estimateUsd } from '../tokens.service.js';
import { type TokenSource, withUsageRecording } from './usage-recording.js';
import { withKeyHealth } from './key-health.js';
import { withDateStamp } from './with-date-stamp.js';
import { AllowanceExhaustedError } from './refusal.js';

type UserProvider = 'openai' | 'gemini' | 'anthropic';

interface UserLlmConfig {
  provider: UserProvider;
  apiKey: string;
  model?: string;
  baseURL?: string;
}

/** Build a per-user provider from BYOK config (no date-stamp wrap). */
function buildUserLlm(cfg: UserLlmConfig): LlmService {
  switch (cfg.provider) {
    case 'anthropic':
      return new AnthropicLlmService({ apiKey: cfg.apiKey, model: cfg.model });
    case 'openai':
      return new OpenAICompatService({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseURL: cfg.baseURL,
        // ADR 0269 — the user typed this URL, so every request re-screens it.
        fetch: cfg.baseURL ? modelEndpointFetch() : undefined,
      });
    case 'gemini':
      return new GeminiLlmService({ apiKey: cfg.apiKey, model: cfg.model });
  }
}

/**
 * Validate a BYOK key by making one minimal call before we store it
 * (ADR 0044). Returns the classified failure so the caller can surface an
 * actionable message ("key rejected" / "out of credits" / model wrong).
 */
export async function validateUserModelKey(
  cfg: UserLlmConfig,
): Promise<{ ok: true } | { ok: false; error: ClassifiedLlmError }> {
  try {
    await buildUserLlm(cfg).complete(
      [{ role: 'user', content: 'Reply with the single word: ok' }],
      { maxTokens: 5, temperature: 0 },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: classifyLlmError(err) };
  }
}

let cached: LlmService | undefined;

/**
 * Chord's OWN model. Almost nothing should call this: a user with their own key
 * must have their work run on it (ADR 0257), so reach the model through
 * `getLlmForUser`, the single place that picks the key. A test enforces it.
 */
export function getLlm(): LlmService {
  if (cached) return cached;
  let inner: LlmService;
  switch (env.LLM_PROVIDER) {
    case 'anthropic':
      inner = new AnthropicLlmService();
      break;
    case 'gemini':
      inner = new GeminiLlmService();
      break;
    case 'mock':
      inner = new MockLlmService();
      break;
    case 'openai':
      inner = new OpenAICompatService();
      break;
    case '':
      throw new Error(
        'No LLM provider configured. Set OPENAI_API_KEY or GEMINI_API_KEY in .env, ' +
          'or set LLM_PROVIDER=mock.',
      );
  }
  cached = withDateStamp(inner);
  logger.info(`LLM provider = ${env.LLM_PROVIDER} (${cached.defaultModel})`);
  return cached;
}

/** Test-only: make Chord's own model this one (ADR 0324 tests need a model
 *  that reports usage, which the mock does not). Undo with the reset below. */
export function __setLlmForTests(llm: LlmService): void {
  cached = llm;
}

/** Test-only: drop the cached provider so the next getLlm() re-reads env. */
export function __resetLlmCacheForTests(): void {
  cached = undefined;
  ossCached = undefined;
}

/** A user's stored model key (BYOK), opened. */
export interface UserModelKey extends UserLlmConfig {
  /** ADR 0252: a key issue is already on record for this key. */
  keyIssue: boolean;
}

/**
 * The user's own key, or null when they have none / it won't decrypt (logged,
 * not thrown). Shared by the chat model and the embedder (ADR 0276), so both
 * read one stored key the same way.
 */
export async function readUserModelKey(db: Kysely<DB>, userId: string): Promise<UserModelKey | null> {
  const row = await db
    .selectFrom('users')
    .select([
      'model_provider',
      'model_name',
      'model_base_url',
      'model_key_ciphertext',
      'model_key_iv',
      'model_key_tag',
      'byok_key_issue',
    ])
    .where('id', '=', userId)
    .executeTakeFirst();

  if (!row?.model_provider || !row.model_key_ciphertext || !row.model_key_iv || !row.model_key_tag) {
    return null;
  }
  let apiKey: string;
  try {
    apiKey = openToken({
      ciphertext: row.model_key_ciphertext,
      iv: row.model_key_iv,
      tag: row.model_key_tag,
    });
  } catch (err) {
    logger.warn('per-user model key decrypt failed; falling back to env', { userId, err });
    return null;
  }
  if (row.model_provider !== 'openai' && row.model_provider !== 'gemini' && row.model_provider !== 'anthropic') {
    return null;
  }
  return {
    provider: row.model_provider,
    apiKey,
    model: row.model_name ?? undefined,
    baseURL: row.model_base_url ?? undefined,
    keyIssue: !!row.byok_key_issue,
  };
}

/**
 * Build a user's BYOK provider from their stored key, or null when they have
 * none / it won't decrypt. Not cached — one call per turn.
 */
async function buildByokLlm(
  db: Kysely<DB>,
  userId: string,
): Promise<LlmService | null> {
  const key = await readUserModelKey(db, userId);
  if (!key) return null;
  // Gemini ignores model_base_url (Google SDK has no base-URL hook).
  // ADR 0252 - every call on the user's own key reports back, so an empty or
  // rejected key is on record whichever pass hit it first.
  return withKeyHealth(
    withDateStamp(
      buildUserLlm({ provider: key.provider, apiKey: key.apiKey, model: key.model, baseURL: key.baseURL }),
    ),
    db,
    userId,
    key.keyIssue,
  );
}

/**
 * THE place that picks whose key a model call runs on (ADR 0257): the user's own
 * when they have one, else Chord's (no user, no db, no stored key, or a decrypt
 * failure). Every AI call goes through here so a BYOK user's work is never
 * quietly run - and paid for - on Chord's key. The tier-aware turn path wraps it
 * as `resolveTurnLlm`.
 */
export async function getLlmForUser(
  db: Kysely<DB> | null | undefined,
  userId: string | null | undefined,
  /** ADR 0324 — what the call is for. On Chord's key every call then writes a
   *  `token_usage` row under this source (that table is the allowance, ADR
   *  0196); on the user's own key nothing is recorded (ADR 0193). */
  source: TokenSource,
): Promise<LlmService> {
  if (!userId || !db) return getLlm();
  if (!(await hasAiConsent(db, userId))) return refusingLlm(getLlm());
  const byok = await buildByokLlm(db, userId);
  if (byok) return withAllowanceGate(byok, db, userId);
  return withUsageRecording(withAllowanceGate(getLlm(), db, userId), db, userId, source);
}

/**
 * ADR 0079/0325 — the allowance backstop, beside the consent one. Entry points
 * still check `getEntitlement` first, because a stopped pass often does
 * something else (the briefing's no-model teaser, the "out of tokens" chat
 * message). This only catches a door that forgot: it asks at the first call
 * (not when the model is built, so building one costs nothing) and refuses
 * with `AllowanceExhaustedError` before anything is sent. BYOK is entitled
 * unless the dormant base fee is configured (ADR 0251), so its key keeps
 * working. A `known` entitlement (the bot turn's own read) skips the query.
 *
 * ADR 0332 — the allowance is a dollar budget, and one model handle can make
 * many calls (a bot turn's tool loop, a batch pass). The gate adds up what its
 * own calls cost (the reported cost, else the token estimate) and refuses the
 * next call once that reaches `remainingUsd`, so a user can go over by at
 * most the one call that crossed the line.
 */
function withAllowanceGate(
  inner: LlmService,
  db: Kysely<DB>,
  userId: string,
  known?: Entitlement,
): LlmService {
  if (!env.BILLING_ENABLED) return inner;
  if (known?.entitled && known.remainingUsd === undefined) return inner;
  let verdict: Promise<Entitlement> | undefined = known ? Promise.resolve(known) : undefined;
  let spentUsd = 0;
  const check = async () => {
    verdict ??= getEntitlement(db, userId);
    const ent = await verdict;
    if (!ent.entitled) throw new AllowanceExhaustedError(ent.reason);
    if (ent.remainingUsd !== undefined && spentUsd >= ent.remainingUsd) {
      throw new AllowanceExhaustedError('none');
    }
  };
  const counting = <O extends LlmCompleteOptions>(opts: O | undefined): O =>
    ({
      ...(opts ?? {}),
      onUsage: (u: LlmTokenUsage) => {
        spentUsd += u.costUsd ?? estimateUsd(u.promptTokens + u.completionTokens);
        opts?.onUsage?.(u);
      },
    }) as O;
  return {
    providerName: inner.providerName,
    defaultModel: inner.defaultModel,
    supportsNativeTools: inner.supportsNativeTools,
    async complete(messages, opts) {
      await check();
      return inner.complete(messages, counting(opts));
    },
    async *stream(messages, opts) {
      await check();
      yield* inner.stream(messages, counting(opts));
    },
  };
}

/**
 * ADR 0283 — the backstop for a user who has not agreed: every call throws
 * before anything is sent. Entry points check `hasAiConsent` first, so this
 * only fires for a path that forgot to.
 */
function refusingLlm(base: LlmService): LlmService {
  return {
    providerName: base.providerName,
    defaultModel: base.defaultModel,
    supportsNativeTools: base.supportsNativeTools,
    async complete() {
      throw new AiConsentRequiredError();
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new AiConsentRequiredError();
    },
  };
}

let ossCached: LlmService | null | undefined;

/** The cheap free-tier model (ADR 0063), from the OSS_* env (OpenAI-compatible).
 *  null when unconfigured — callers then bear the premium cost rather than block. */
export function getOssLlm(): LlmService | null {
  if (ossCached !== undefined) return ossCached;
  if (!env.OSS_API_KEY || !env.OSS_BASE_URL || !env.OSS_MODEL) {
    ossCached = null;
    return null;
  }
  ossCached = withDateStamp(
    new OpenAICompatService({ apiKey: env.OSS_API_KEY, baseURL: env.OSS_BASE_URL, model: env.OSS_MODEL }),
  );
  logger.info(`OSS free-tier model = ${env.OSS_MODEL}`);
  return ossCached;
}

export type LlmTier = 'byok' | 'premium' | 'oss';

/**
 * ADR 0063 — resolve the model for a bot turn AND the tier that decides billing:
 *   - `byok`: the user's own key (free, never debited);
 *   - `premium`: the system model — debited 1 credit/turn only when
 *     BILLING_ENABLED and the user has a balance;
 *   - `oss`: the cheap free-tier model when a billing user is out of credits.
 * With BILLING_ENABLED off (default), non-BYOK users are `premium` and the turn
 * path simply never debits — behavior is unchanged from before this ADR.
 */
export async function resolveTurnLlm(
  db: Kysely<DB>,
  userId: string | null | undefined,
  known: { consented?: boolean; entitlement?: Entitlement } = {},
): Promise<{ llm: LlmService; tier: LlmTier }> {
  // Whose key and whether they agreed are each read once here. The bot turn
  // has usually just read both itself and passes them in (`known`), so a turn
  // asks the database each question once.
  if (!userId) return { llm: getLlm(), tier: 'premium' };
  // The pick may read the entitlement itself; the gate then reuses that read.
  const read = { ...known };
  const picked = await pickTurnLlm(db, userId, read);
  return { llm: withAllowanceGate(picked.llm, db, userId, read.entitlement), tier: picked.tier };
}

async function pickTurnLlm(
  db: Kysely<DB>,
  userId: string,
  known: { consented?: boolean; entitlement?: Entitlement },
): Promise<{ llm: LlmService; tier: LlmTier }> {
  let consent = known.consented;
  const consented = async () => (consent ??= await hasAiConsent(db, userId));
  const byokLlm = await buildByokLlm(db, userId);
  if (byokLlm) {
    return { llm: (await consented()) ? byokLlm : refusingLlm(byokLlm), tier: 'byok' };
  }
  const chord = async () => ((await consented()) ? getLlm() : refusingLlm(getLlm()));
  if (!env.BILLING_ENABLED) return { llm: await chord(), tier: 'premium' };
  // Any allowance with room — a plan, grandfathering, or the ADR 0325 free
  // tokens — runs the premium model.
  const ent = (known.entitlement ??= await getEntitlement(db, userId));
  if (ent.balance > 0) return { llm: await chord(), tier: 'premium' };
  // Post-trial, no credits: turns are gated upstream (ADR 0079); this branch
  // now only decides what GET /me/billing displays.
  const oss = getOssLlm();
  if (oss && !(await consented())) return { llm: refusingLlm(oss), tier: 'oss' };
  return oss ? { llm: oss, tier: 'oss' } : { llm: await chord(), tier: 'premium' };
}

/**
 * Provider-agnostic classification of LLM call failures (ADR 0044).
 *
 * The three SDKs (OpenAI, Anthropic, Gemini) report auth / out-of-credit /
 * rate-limit failures with different status codes and payload shapes. We
 * collapse them into one `LlmErrorKind` so both the runtime bot catch and
 * the validate-on-save route can react the same way — chiefly: tell a BYOK
 * user to fix or top up their own key, but only when the failure is
 * actually theirs to fix (auth / credit), not a transient blip.
 */
import { isOpenRouterUrl } from '../../utils/model-host.js';
import type { LlmService } from './types.js';

export type LlmErrorKind = 'auth' | 'credit' | 'rate_limit' | 'other';

export interface ClassifiedLlmError {
  kind: LlmErrorKind;
  status?: number;
  message: string;
}

type ProviderName = LlmService['providerName'];

interface ErrShape {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  type?: unknown;
  message?: unknown;
  error?: unknown;
}

// Substrings (lowercased) that mark an account-funds problem rather than a
// bad key or a transient limit. OpenAI: `insufficient_quota`. Anthropic: a
// 400 whose message is "credit balance is too low". Gemini surfaces quota
// exhaustion as RESOURCE_EXHAUSTED, which is ambiguous with rate-limiting,
// so we only treat it as credit when the message also names billing/quota.
const CREDIT_MARKERS = [
  'insufficient_quota',
  'credit balance is too low',
  'billing_hard_limit_reached',
  'exceeded your current quota',
  'out of credit',
  // OpenRouter answers an empty balance with 402 "Insufficient credits".
  'insufficient credits',
  'more credits',
];

const AUTH_MARKERS = [
  'authentication_error',
  'invalid_api_key',
  'api key not valid',
  'api_key_invalid',
  'permission_denied',
  'unauthorized',
];

const RATE_MARKERS = [
  'rate_limit',
  'rate limit',
  'resource_exhausted',
  'too many requests',
  'overloaded',
];

function readStatus(e: ErrShape): number | undefined {
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  // Some errors only carry the code in the message ("400 ...", "401 ...").
  const m = /^\s*(\d{3})\b/.exec(typeof e.message === 'string' ? e.message : '');
  return m ? Number(m[1]) : undefined;
}

/** Flatten message + nested error payload + code/type into one haystack. */
function haystack(e: ErrShape): string {
  const parts: string[] = [];
  if (typeof e.message === 'string') parts.push(e.message);
  if (typeof e.code === 'string') parts.push(e.code);
  if (typeof e.type === 'string') parts.push(e.type);
  if (e.error !== undefined) {
    try {
      parts.push(typeof e.error === 'string' ? e.error : JSON.stringify(e.error));
    } catch {
      /* circular / unserializable — skip */
    }
  }
  return parts.join(' ').toLowerCase();
}

export function classifyLlmError(err: unknown): ClassifiedLlmError {
  const e = (err ?? {}) as ErrShape;
  const status = readStatus(e);
  const hay = haystack(e);
  const message = typeof e.message === 'string' ? e.message : String(err);

  // Credit first: OpenAI's insufficient_quota is a 429, so it must win over
  // the rate-limit rule below, and Anthropic's is a 400 that would otherwise
  // fall through to `other`.
  if (status === 402 || CREDIT_MARKERS.some((m) => hay.includes(m))) {
    return { kind: 'credit', status, message };
  }
  if (status === 401 || status === 403 || AUTH_MARKERS.some((m) => hay.includes(m))) {
    return { kind: 'auth', status, message };
  }
  if (status === 429 || RATE_MARKERS.some((m) => hay.includes(m))) {
    return { kind: 'rate_limit', status, message };
  }
  return { kind: 'other', status, message };
}

const PROVIDER_LABEL: Record<ProviderName, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google AI',
  mock: 'mock',
};

const BILLING_URL: Partial<Record<ProviderName, string>> = {
  openai: 'https://platform.openai.com/account/billing',
  anthropic: 'https://console.anthropic.com/settings/billing',
  gemini: 'https://aistudio.google.com/app/apikey',
};

/**
 * A user-facing message for a BYOK key failure the user can act on, or
 * `null` for kinds that are not the user's key to fix (transient
 * rate-limits, unknown errors) — the caller falls back to its generic copy.
 */
/** Where the user adds credit for the key's own provider, when we know one. */
export function byokTopUpUrl(provider: ProviderName, baseUrl?: string | null): string | null {
  const viaOpenRouter = isOpenRouterUrl(baseUrl);
  return (viaOpenRouter ? 'https://openrouter.ai/credits' : BILLING_URL[provider]) ?? null;
}

export function byokFailureMessage(
  provider: ProviderName,
  kind: LlmErrorKind,
  /** OpenRouter rides the `openai` provider with its own base URL; without this
   *  its users would be told to top up an OpenAI account they do not have. */
  baseUrl?: string | null,
): string | null {
  const viaOpenRouter = isOpenRouterUrl(baseUrl);
  const label = viaOpenRouter ? 'OpenRouter' : (PROVIDER_LABEL[provider] ?? 'your AI provider');
  if (kind === 'auth') {
    return `⚠️ Your ${label} API key was rejected. Update it in Settings → AI model (paste a new key).`;
  }
  if (kind === 'credit') {
    const url = byokTopUpUrl(provider, baseUrl);
    const topUp = url ? ` Top up at ${url},` : '';
    return `⚠️ Your ${label} API key is out of credits.${topUp} or paste a different key in Settings → AI model.`;
  }
  return null;
}

/**
 * ADR 0283 — who receives a user's data when Chord's AI runs, in words for
 * the consent screen and the chat consent message: the user's own key's
 * provider when they set one, else Chord's.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { isOpenRouterUrl } from '../../utils/model-host.js';
import { readUserModelKey } from './factory.js';
import { describeSystemLlm } from './system-llm.js';

const VENDOR: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  gemini: 'Google (Gemini)',
  'meta-llama': 'Meta',
  mistralai: 'Mistral',
  deepseek: 'DeepSeek',
  'x-ai': 'xAI',
  qwen: 'Alibaba (Qwen)',
};

/** Pure: name the recipient for a provider / model / base URL. */
export function describeRecipient(
  provider: string,
  model: string | null | undefined,
  baseUrl: string | null | undefined,
): string {
  const m = model?.trim() || null;
  if (isOpenRouterUrl(baseUrl)) {
    const slash = m?.indexOf('/') ?? -1;
    if (m && slash > 0) {
      const vendor = VENDOR[m.slice(0, slash)] ?? m.slice(0, slash);
      return `OpenRouter, which passes it to ${vendor} (${m.slice(slash + 1)})`;
    }
    return m ? `OpenRouter (${m})` : 'OpenRouter';
  }
  if (baseUrl && provider !== 'gemini') {
    let host = baseUrl;
    try {
      host = new URL(baseUrl).host;
    } catch {
      /* keep the raw value */
    }
    if (!/api\.openai\.com|api\.anthropic\.com/i.test(host)) {
      return m ? `the AI service at ${host} (${m})` : `the AI service at ${host}`;
    }
  }
  if (provider === 'mock') return 'a test model that runs on Chord’s own server';
  const name = VENDOR[provider] ?? provider;
  return m ? `${name} (${m})` : name;
}

export async function aiRecipient(db: Kysely<DB>, userId: string): Promise<string> {
  const own = await readUserModelKey(db, userId);
  if (own) return `${describeRecipient(own.provider, own.model, own.baseURL)}, using your own key`;
  const sys = describeSystemLlm();
  if (!sys) return 'Chord’s AI provider';
  return describeRecipient(sys.provider, sys.model, sys.baseUrl);
}

/**
 * Whose key embeds a user's mail (ADR 0276). The table in the ADR, one case
 * per row, plus the case the owner asked about: a user on their own Anthropic
 * key while Chord's chat is ALSO on Anthropic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { UserModelKey } from '@/services/llm/factory.js';

let own: UserModelKey | null = null;
vi.mock('@/services/llm/factory.js', () => ({ readUserModelKey: async () => own }));
// Every request a user's own key makes goes through the endpoint screen.
const screened: string[] = [];
vi.mock('@/utils/ssrf.js', () => ({
  modelEndpointFetch: () => async (input: string | URL | Request) => {
    screened.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    throw new Error('blocked');
  },
}));

const { GeminiEmbedder, MockEmbedder, OpenAICompatEmbedder, getEmbedderForUser, fitVector } = await import('@/services/llm/embeddings.js');

type Mutable = {
  -readonly [K in keyof typeof env]: (typeof env)[K];
};
const e = env as Mutable;
const saved = { ...env };
const db = {} as never;

beforeEach(() => {
  e.EMBEDDINGS_ENABLED = true;
  e.LLM_PROVIDER = 'openai';
  e.OPENAI_API_KEY = 'sk-or-chord';
  e.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1';
  e.EMBEDDINGS_API_KEY = '';
  e.EMBEDDINGS_BASE_URL = '';
  e.EMBEDDINGS_MODEL = 'openai/text-embedding-3-small';
  e.EMBEDDINGS_DIMS = 512;
  e.EMBEDDINGS_BYOK_FALLBACK = 'chord';
  own = null;
});
afterEach(() => Object.assign(e, saved));

const key = (k: Partial<UserModelKey>): UserModelKey => ({ provider: 'openai', apiKey: 'sk-user', keyIssue: false, ...k });

describe('getEmbedderForUser', () => {
  it('is off unless EMBEDDINGS_ENABLED', async () => {
    e.EMBEDDINGS_ENABLED = false;
    expect(await getEmbedderForUser(db, 'u')).toBeNull();
  });

  it("uses Chord's key for a user without one, and meters it", async () => {
    const em = await getEmbedderForUser(db, 'u');
    expect(em).toBeInstanceOf(OpenAICompatEmbedder);
    expect(em).toMatchObject({ id: 'text-embedding-3-small@512', paidBy: 'chord', metered: true });
  });

  it('uses their OpenRouter key, making the same vectors as Chord', async () => {
    own = key({ baseURL: 'https://openrouter.ai/api/v1' });
    expect(await getEmbedderForUser(db, 'u')).toMatchObject({ id: 'text-embedding-3-small@512', paidBy: 'user', metered: false });
  });

  it('uses their direct OpenAI key, same vectors again', async () => {
    own = key({});
    expect(await getEmbedderForUser(db, 'u')).toMatchObject({ id: 'text-embedding-3-small@512', paidBy: 'user' });
  });

  it("uses their Gemini key with Google's own model", async () => {
    own = key({ provider: 'gemini' });
    const em = await getEmbedderForUser(db, 'u');
    expect(em).toBeInstanceOf(GeminiEmbedder);
    expect(em).toMatchObject({ id: 'gemini-embedding-001@768', paidBy: 'user', metered: false });
  });

  it("embeds an Anthropic-key user on Chord's key, unmetered", async () => {
    own = key({ provider: 'anthropic' });
    expect(await getEmbedderForUser(db, 'u')).toMatchObject({ paidBy: 'chord', metered: false });
  });

  it('leaves an Anthropic-key user on keyword search when the fallback is off', async () => {
    own = key({ provider: 'anthropic' });
    e.EMBEDDINGS_BYOK_FALLBACK = 'none';
    expect(await getEmbedderForUser(db, 'u')).toBeNull();
  });

  it('does not take a host for OpenRouter because its URL mentions openrouter.ai', async () => {
    own = key({ baseURL: 'https://evil.example/v1?openrouter.ai' });
    expect(await getEmbedderForUser(db, 'u')).toMatchObject({ paidBy: 'chord' });
    own = key({ baseURL: 'https://openrouter.ai.evil.example/api/v1' });
    expect(await getEmbedderForUser(db, 'u')).toMatchObject({ paidBy: 'chord' });
  });

  it("screens every request made with the user's own key", async () => {
    own = key({ baseURL: 'https://openrouter.ai/api/v1' });
    screened.length = 0;
    const em = await getEmbedderForUser(db, 'u');
    await expect(em!.embed(['hello'], 'query')).rejects.toThrow();
    expect(screened[0]).toMatch(/^https:\/\/openrouter\.ai\/api\/v1\/embeddings/);
  });

  it('treats an Ollama-style base URL as a key that cannot embed', async () => {
    own = key({ baseURL: 'http://127.0.0.1:11434/v1' });
    expect(await getEmbedderForUser(db, 'u')).toMatchObject({ paidBy: 'chord' });
  });

  describe('Chord on Anthropic too', () => {
    beforeEach(() => {
      e.LLM_PROVIDER = 'anthropic';
      own = key({ provider: 'anthropic' });
    });

    it('is keyword search only when no embedding key is configured', async () => {
      expect(await getEmbedderForUser(db, 'u')).toBeNull();
    });

    it("works when Chord's embedding key is set apart from its chat model", async () => {
      e.EMBEDDINGS_API_KEY = 'sk-or-embed';
      e.EMBEDDINGS_BASE_URL = 'https://openrouter.ai/api/v1';
      expect(await getEmbedderForUser(db, 'u')).toMatchObject({ id: 'text-embedding-3-small@512', paidBy: 'chord' });
    });
  });

  it('is the stand-in on LLM_PROVIDER=mock', async () => {
    e.LLM_PROVIDER = 'mock';
    expect(await getEmbedderForUser(db, 'u')).toBeInstanceOf(MockEmbedder);
  });
});

describe('fitVector', () => {
  it('cuts to the size asked for and keeps unit length', () => {
    const v = fitVector([3, 4, 12], 2);
    expect(v.length).toBe(2);
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6);
  });
});

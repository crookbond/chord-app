/**
 * ADR 0044 — validate-on-save (validateUserModelKey).
 *
 * The PUT /me/model-key route calls this before persisting a BYOK key so a
 * bad key / wrong model / empty balance is caught at configuration time.
 * We mock the OpenAI provider so the test makes no network call and can
 * drive each failure shape deterministically.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/llm/openai.service.js', () => ({
  OpenAICompatService: class {
    private apiKey: string;
    readonly providerName = 'openai' as const;
    readonly defaultModel = 'gpt-test';
    readonly supportsNativeTools = true;
    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey;
    }
    async complete(): Promise<string> {
      if (this.apiKey === 'good-key') return 'ok';
      if (this.apiKey === 'no-credit') {
        const e = Object.assign(new Error('429 You exceeded your current quota'), {
          status: 429,
          code: 'insufficient_quota',
        });
        throw e;
      }
      const e = Object.assign(new Error('401 Incorrect API key provided'), {
        status: 401,
        code: 'invalid_api_key',
      });
      throw e;
    }
    async *stream(): AsyncIterable<never> {
      // not used by validateUserModelKey
    }
  },
}));

const { validateUserModelKey } = await import('@/services/llm/factory.js');

describe('validateUserModelKey', () => {
  it('accepts a working key', async () => {
    const r = await validateUserModelKey({ provider: 'openai', apiKey: 'good-key', model: 'gpt-test' });
    expect(r.ok).toBe(true);
  });

  it('rejects a bad key as auth', async () => {
    const r = await validateUserModelKey({ provider: 'openai', apiKey: 'bad-key', model: 'gpt-test' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('auth');
  });

  it('rejects an out-of-credit key as credit', async () => {
    const r = await validateUserModelKey({ provider: 'openai', apiKey: 'no-credit', model: 'gpt-test' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('credit');
  });
});

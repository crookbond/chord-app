/**
 * ADR 0044 — LLM error classification + BYOK failure messaging.
 *
 * Each provider reports auth / out-of-credit / rate-limit with its own
 * status code and payload shape; classifyLlmError must collapse them into
 * one kind so the bot turn and the save-time validator react identically.
 */
import { describe, expect, it } from 'vitest';

import { byokFailureMessage, classifyLlmError } from '@/services/llm/errors.js';

describe('classifyLlmError', () => {
  it('OpenAI 401 invalid_api_key → auth', () => {
    const r = classifyLlmError({ status: 401, code: 'invalid_api_key', message: '401 Incorrect API key provided' });
    expect(r.kind).toBe('auth');
    expect(r.status).toBe(401);
  });

  it('OpenAI 429 insufficient_quota → credit (not rate_limit)', () => {
    const r = classifyLlmError({
      status: 429,
      code: 'insufficient_quota',
      message: '429 You exceeded your current quota, please check your plan and billing details.',
    });
    expect(r.kind).toBe('credit');
  });

  it('OpenAI 429 rate_limit_exceeded → rate_limit', () => {
    const r = classifyLlmError({ status: 429, code: 'rate_limit_exceeded', message: '429 Rate limit reached' });
    expect(r.kind).toBe('rate_limit');
  });

  it('Anthropic 401 authentication_error → auth', () => {
    const r = classifyLlmError({
      status: 401,
      error: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      message: '401 authentication_error',
    });
    expect(r.kind).toBe('auth');
  });

  it('Anthropic 400 "credit balance is too low" → credit', () => {
    const r = classifyLlmError({
      status: 400,
      error: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
      message: '400 invalid_request_error',
    });
    expect(r.kind).toBe('credit');
  });

  it('Gemini API_KEY_INVALID → auth', () => {
    const r = classifyLlmError({ status: 400, message: '[400] API key not valid. Please pass a valid API key.' });
    expect(r.kind).toBe('auth');
  });

  it('5xx server error → other (transient, not the user key)', () => {
    const r = classifyLlmError({ status: 503, message: '503 Service Unavailable' });
    expect(r.kind).toBe('other');
  });

  it('generic provider 400 with no funds/auth marker → other', () => {
    // Mirrors the bot-error integration test fixture.
    const r = classifyLlmError(new Error('400 Provider returned error'));
    expect(r.kind).toBe('other');
    expect(r.status).toBe(400);
  });

  it('null / undefined error does not throw', () => {
    expect(classifyLlmError(undefined).kind).toBe('other');
    expect(classifyLlmError(null).kind).toBe('other');
  });
});

describe('classifyLlmError: OpenRouter', () => {
  it('a 402 / "Insufficient credits" is an empty balance, not a bad key', () => {
    expect(classifyLlmError({ status: 402, message: '402 Insufficient credits' }).kind).toBe('credit');
    expect(classifyLlmError({ message: 'This request requires more credits' }).kind).toBe('credit');
  });
});

describe('byokFailureMessage', () => {
  it('auth → tells the user the key was rejected', () => {
    const msg = byokFailureMessage('openai', 'auth');
    expect(msg).toMatch(/rejected/i);
    expect(msg).toMatch(/Settings/);
  });

  it('credit → names the provider and links its billing page', () => {
    const msg = byokFailureMessage('anthropic', 'credit');
    expect(msg).toMatch(/out of credits/i);
    expect(msg).toContain('console.anthropic.com');
  });

  it('OpenRouter (the openai provider with its base URL) is named as itself, not as OpenAI', () => {
    const msg = byokFailureMessage('openai', 'credit', 'https://openrouter.ai/api/v1');
    expect(msg).toContain('OpenRouter');
    expect(msg).toContain('openrouter.ai/credits');
    expect(msg).not.toContain('platform.openai.com');
    // Any other base URL keeps the provider's own wording.
    expect(byokFailureMessage('openai', 'credit', 'https://api.deepseek.com')).toContain('platform.openai.com');
  });

  it('rate_limit / other → null (caller uses generic copy)', () => {
    expect(byokFailureMessage('openai', 'rate_limit')).toBeNull();
    expect(byokFailureMessage('openai', 'other')).toBeNull();
  });
});

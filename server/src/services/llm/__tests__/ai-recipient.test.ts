import { describe, expect, it } from 'vitest';

import { describeRecipient } from '../ai-recipient.js';

describe('describeRecipient (ADR 0283)', () => {
  it('names OpenRouter and the vendor behind the model', () => {
    expect(describeRecipient('openai', 'openai/gpt-4.1-mini', 'https://openrouter.ai/api/v1')).toBe(
      'OpenRouter, which passes it to OpenAI (gpt-4.1-mini)',
    );
    expect(describeRecipient('openai', 'anthropic/claude-sonnet-4.6', 'https://openrouter.ai/api/v1')).toBe(
      'OpenRouter, which passes it to Anthropic (claude-sonnet-4.6)',
    );
  });

  it('does not call a host OpenRouter because the URL mentions it', () => {
    const r = describeRecipient('openai', 'openai/gpt-4.1-mini', 'https://evil.example/v1?openrouter.ai');
    expect(r).not.toMatch(/OpenRouter/);
    expect(r).toContain('evil.example');
  });

  it('names the provider directly on its own endpoint', () => {
    expect(describeRecipient('openai', 'gpt-5.4-mini', null)).toBe('OpenAI (gpt-5.4-mini)');
    expect(describeRecipient('openai', 'gpt-5.4-mini', 'https://api.openai.com/v1')).toBe('OpenAI (gpt-5.4-mini)');
    expect(describeRecipient('gemini', 'gemini-2.5-flash', null)).toBe('Google (Gemini) (gemini-2.5-flash)');
    expect(describeRecipient('anthropic', 'claude-sonnet-4-6', null)).toBe('Anthropic (claude-sonnet-4-6)');
  });

  it('names an unfamiliar host rather than pretending it is OpenAI', () => {
    expect(describeRecipient('openai', 'llama3', 'http://localhost:11434/v1')).toBe(
      'the AI service at localhost:11434 (llama3)',
    );
  });
});

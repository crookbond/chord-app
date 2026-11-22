import { describe, expect, it } from 'vitest';

import type { LlmMessage } from '../../services/llm/types.js';
import {
  debugSnippet,
  maskSender,
  maskSubject,
  promptLogMessages,
  resolvePromptLogMode,
} from '../prompt-log.js';

// The shape that leaked: a bot turn's system prompt carries email subjects
// (digest history) and attachment excerpts, and prompts.log wrote it verbatim.
const messages: LlmMessage[] = [
  { role: 'system', content: 'Attachment excerpt: BitGo invoice total $4,180.00' },
  { role: 'user', content: 'what was that Amex trip cancellation email about?' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'search', args: { query: 'Amex Vail cancellation' } }],
  },
  { role: 'tool', content: '{"hits":[{"subject":"Cancellation: your trip to Vail"}]}', toolName: 'search' },
];

describe('resolvePromptLogMode', () => {
  it('defaults to meta', () => {
    expect(resolvePromptLogMode('', 'development')).toBe('meta');
    expect(resolvePromptLogMode('bogus', 'production')).toBe('meta');
  });

  it('allows full outside production only', () => {
    expect(resolvePromptLogMode('full', 'development')).toBe('full');
    expect(resolvePromptLogMode('FULL', 'production')).toBe('meta');
  });

  it('honours off everywhere', () => {
    expect(resolvePromptLogMode('off', 'production')).toBe('off');
  });
});

describe('promptLogMessages', () => {
  it('meta mode carries no message text, tool args or tool results', () => {
    const logged = JSON.stringify(promptLogMessages(messages, 'meta'));
    expect(logged).not.toContain('BitGo');
    expect(logged).not.toContain('Amex');
    expect(logged).not.toContain('Vail');
    expect(logged).toContain('"search"');
  });

  it('meta mode still says how large each message was', () => {
    const out = promptLogMessages(messages, 'meta') as Array<{ role: string; chars: number }>;
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(out[0]!.chars).toBe(messages[0]!.content.length);
  });

  it('counts text parts of multimodal content and ignores image bytes', () => {
    const out = promptLogMessages(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image', mimeType: 'image/png', base64: 'A'.repeat(5000) },
          ],
        },
      ],
      'meta',
    ) as Array<{ chars: number; parts: number }>;
    expect(out[0]).toMatchObject({ chars: 5, parts: 2 });
  });

  it('full mode is the untouched prompt', () => {
    expect(promptLogMessages(messages, 'full')).toBe(messages);
  });
});

describe('operator-script masking', () => {
  it('hides the subject and the sender local part unless asked', () => {
    const out = `${maskSubject('Cancellation: your trip to Vail', false)} ${maskSender('john@bitgo.example', false)}`;
    expect(out).not.toContain('Vail');
    expect(out).not.toContain('john');
    expect(out).toContain('@bitgo.example');
    expect(out).toContain('31 chars');
  });

  it('shows both with --show-content', () => {
    expect(maskSubject('Hello', true)).toBe('Hello');
    expect(maskSender('a@b.example', true)).toBe('a@b.example');
  });

  it('survives missing values', () => {
    expect(maskSubject(null, false)).toBe('<subject hidden, 0 chars>');
    expect(maskSender(null, false)).toBe('?');
    expect(maskSender('no-at-sign', false)).toBe('?');
  });
});

describe('debugSnippet', () => {
  it('returns nothing in production so a model reply echoing an email is never logged', () => {
    expect(debugSnippet('OCR: confirmation KX8QP2', 100, 'production')).toBeUndefined();
  });

  it('truncates outside production', () => {
    expect(debugSnippet('abcdef', 3, 'development')).toBe('abc');
  });
});

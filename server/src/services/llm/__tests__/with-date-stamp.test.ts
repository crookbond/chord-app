import { describe, expect, it, vi } from 'vitest';

import type { LlmMessage, LlmService, LlmChunk } from '../types.js';
import { withDateStamp, __testing } from '../with-date-stamp.js';

const { withStamp } = __testing;

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('withStamp (message-level injection)', () => {
  it('prepends a TODAY line to an existing string system message', () => {
    const out = withStamp([
      { role: 'system', content: 'You are Chord.' },
      { role: 'user', content: 'hi' },
    ]);
    const sys = out[0];
    expect(sys.role).toBe('system');
    expect(typeof sys.content).toBe('string');
    expect(sys.content as string).toMatch(new RegExp(`^TODAY IS \\w+day ${todayDate()}`));
    expect(sys.content as string).toContain('You are Chord.');
  });

  it('names the weekday and next Monday (Sunday 2026-09-27 → Monday is 9/28)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T16:00:00Z'));
    try {
      const out = withStamp([{ role: 'user', content: 'what is on Monday' }]);
      const text = out[0].content as string;
      expect(text).toMatch(/^TODAY IS Sunday 2026-09-27/);
      expect(text).toContain('Mon 2026-09-28');
      expect(text).not.toContain('Mon 2026-09-29');
    } finally {
      vi.useRealTimers();
    }
  });

  it('inserts a fresh system message when none exists', () => {
    const out = withStamp([{ role: 'user', content: 'hi' }]);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('system');
    expect(out[0].content as string).toMatch(/^TODAY IS /);
    expect(out[1].role).toBe('user');
  });

  it('is idempotent: skips when system already mentions TODAY IS', () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'TODAY IS 2099-01-01. Pretend you are a parrot.' },
      { role: 'user', content: 'hi' },
    ];
    const out = withStamp(messages);
    expect(out).toBe(messages); // identity — no rebuild
  });

  it('handles content-part arrays (multi-modal) by prepending a text part', () => {
    const out = withStamp([
      {
        role: 'system',
        content: [{ type: 'text', text: 'system body' }],
      },
      { role: 'user', content: 'hi' },
    ]);
    const sys = out[0];
    expect(Array.isArray(sys.content)).toBe(true);
    const parts = sys.content as { type: string; text?: string }[];
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toMatch(/^TODAY IS /);
    expect(parts[1].text).toBe('system body');
  });
});

describe('withDateStamp (service wrapper)', () => {
  function makeInner(): { service: LlmService; calls: { messages: LlmMessage[] }[] } {
    const calls: { messages: LlmMessage[] }[] = [];
    const service: LlmService = {
      providerName: 'mock',
      defaultModel: 'test',
      supportsNativeTools: false,
      async complete(messages) {
        calls.push({ messages });
        return 'ok';
      },
      async *stream(messages): AsyncIterable<LlmChunk> {
        calls.push({ messages });
        yield { type: 'done', reason: 'stop' };
      },
    };
    return { service, calls };
  }

  it('stamps complete() calls', async () => {
    const { service, calls } = makeInner();
    const wrapped = withDateStamp(service);
    await wrapped.complete([{ role: 'user', content: 'hi' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].messages[0].role).toBe('system');
    expect(calls[0].messages[0].content as string).toMatch(/^TODAY IS /);
  });

  it('stamps stream() calls', async () => {
    const { service, calls } = makeInner();
    const wrapped = withDateStamp(service);
    // Drain
    for await (const _ of wrapped.stream([{ role: 'user', content: 'hi' }])) {
      void _;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].messages[0].role).toBe('system');
    expect(calls[0].messages[0].content as string).toMatch(/^TODAY IS /);
  });

  it('preserves provider metadata', () => {
    const { service } = makeInner();
    const wrapped = withDateStamp(service);
    expect(wrapped.providerName).toBe(service.providerName);
    expect(wrapped.defaultModel).toBe(service.defaultModel);
    expect(wrapped.supportsNativeTools).toBe(service.supportsNativeTools);
  });
});

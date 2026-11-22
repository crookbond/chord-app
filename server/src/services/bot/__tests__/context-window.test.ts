/**
 * Recency-aware context window: stale messages are dropped (with a floor),
 * long time gaps get a separator, and the triggering message is marked so the
 * LLM answers the latest turn rather than an older one still in the window.
 */
import { describe, expect, it } from 'vitest';

import { __testing } from '@/services/bot/context.js';

const { windowByRecency, formatGap, buildConvo } = __testing;

const DAY = 86_400_000;
const HOUR = 3_600_000;

function row(i: number, ageMs: number, now: number, over: Partial<Record<string, unknown>> = {}) {
  return {
    id: `m${i}`,
    senderId: 'u1',
    kind: 'user',
    body: `msg ${i}`,
    createdAt: new Date(now - ageMs).toISOString(),
    username: 'alice',
    displayName: 'Alice',
    ...over,
  };
}

describe('windowByRecency', () => {
  it('keeps the floor when every message is older than the cutoff', () => {
    const now = Date.now();
    // 30 messages, all 30 days old (older than the cutoff).
    const rows = Array.from({ length: 30 }, (_, i) => row(i, 30 * DAY, now));
    const kept = windowByRecency(rows, now);
    expect(kept).toHaveLength(20);
    // Floor keeps the newest ones (tail of the oldest→newest array).
    expect(kept[kept.length - 1].id).toBe('m29');
  });

  it('drops messages older than the cutoff beyond the floor', () => {
    const now = Date.now();
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => row(i, 30 * DAY, now)), // stale
      ...Array.from({ length: 5 }, (_, i) => row(i + 25, HOUR, now)), // recent
    ];
    const kept = windowByRecency(rows, now);
    // 5 recent are within cutoff; floor (20) pulls in 15 of the stale tail.
    expect(kept).toHaveLength(20);
    expect(kept.every((m) => m.id !== 'm0')).toBe(true);
  });
});

describe('formatGap', () => {
  it('labels multi-day gaps in days', () => {
    expect(formatGap(3 * DAY)).toBe('3 days');
  });
  it('labels sub-day gaps in hours', () => {
    expect(formatGap(18 * HOUR)).toBe('18 hours');
  });
});

describe('buildConvo', () => {
  it('inserts a gap separator for wide gaps and not for close ones', () => {
    const now = Date.now();
    const rows = [
      row(1, 4 * DAY, now), // oldest
      row(2, 1 * DAY, now), // 3 days after m1 → separator
      row(3, 1 * DAY - 5 * 60_000, now), // ~5 min after m2 → no separator
    ];
    const convo = buildConvo(rows, 'm3');
    const seps = convo.filter((c) => c.role === 'system');
    expect(seps).toHaveLength(1);
    expect(seps[0].content).toBe('[3 days later]');
  });

  it('marks only the triggering message', () => {
    const now = Date.now();
    const rows = [row(1, 2 * HOUR, now), row(2, 1 * HOUR, now)];
    const convo = buildConvo(rows, 'm2');
    const marked = convo.filter(
      (c) => typeof c.content === 'string' && c.content.includes('respond to this'),
    );
    expect(marked).toHaveLength(1);
    expect(marked[0].content).toContain('msg 2');
  });

  it('renders bot messages as assistant turns without the marker', () => {
    const now = Date.now();
    const rows = [row(1, 1 * HOUR, now, { kind: 'bot', senderId: null })];
    const convo = buildConvo(rows, 'm1');
    expect(convo).toHaveLength(1);
    expect(convo[0].role).toBe('assistant');
    expect(convo[0].content).toBe('msg 1');
  });
});

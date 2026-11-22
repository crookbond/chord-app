/**
 * sanitizeRemindAt — strips LLM-supplied `remindAt` values that fall
 * within the next 5 minutes (or in the past). Those almost always
 * represent the LLM misreading "remind me to X" as an immediate-fire
 * directive. Tasks without a remindAt are picked up by the daily 7am
 * morning-scan nudge instead.
 */
import { describe, expect, it } from 'vitest';

import { sanitizeRemindAt } from '@/services/bot/executor.js';

describe('sanitizeRemindAt', () => {
  const now = new Date('2026-05-12T18:00:00.000Z');

  it('drops undefined', () => {
    expect(sanitizeRemindAt(undefined, now)).toBeUndefined();
  });

  it('drops times in the past', () => {
    expect(sanitizeRemindAt('2026-05-11T18:00:00.000Z', now)).toBeUndefined();
  });

  it('drops times equal to now', () => {
    expect(sanitizeRemindAt('2026-05-12T18:00:00.000Z', now)).toBeUndefined();
  });

  it('drops times within the immediate-fire window (< 5 min)', () => {
    expect(sanitizeRemindAt('2026-05-12T18:04:59.000Z', now)).toBeUndefined();
  });

  it('keeps times 5+ minutes in the future', () => {
    const t = '2026-05-12T18:05:00.000Z';
    expect(sanitizeRemindAt(t, now)).toBe(t);
  });

  it('keeps times far in the future', () => {
    const t = '2026-05-15T09:00:00.000Z';
    expect(sanitizeRemindAt(t, now)).toBe(t);
  });

  it('drops malformed datetimes', () => {
    expect(sanitizeRemindAt('not a date', now)).toBeUndefined();
    expect(sanitizeRemindAt('', now)).toBeUndefined();
  });
});

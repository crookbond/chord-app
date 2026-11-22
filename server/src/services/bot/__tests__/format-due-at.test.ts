/**
 * formatDueAt — render a stored ISO due timestamp into a human-readable
 * local wall-clock for prose cards bridged to Telegram / Slack. The raw
 * "due 2026-06-07T09:00:00Z" form leaks the storage encoding and confuses
 * users in non-UTC zones; we shift back to their offset.
 *
 * Re-export the helper for testability — it has no side effects.
 */
import { describe, expect, it } from 'vitest';

import { __testing as exec } from '@/services/bot/executor.js';

describe('formatDueAt', () => {
  it('renders UTC time when no tz offset is given', () => {
    expect(exec.formatDueAt('2026-06-07T09:00:00Z', undefined)).toMatch(
      /Sun,? Jun 7 9:00 AM/,
    );
  });

  it('shifts by a positive tz offset (e.g. +05:30)', () => {
    // 09:00 UTC + 5h30m = 14:30 IST same day
    expect(exec.formatDueAt('2026-06-07T09:00:00Z', '+05:30')).toMatch(
      /Sun,? Jun 7 2:30 PM/,
    );
  });

  it('shifts by a negative tz offset (e.g. -07:00 → PDT)', () => {
    // 09:00 UTC - 7h = 02:00 PDT same day
    expect(exec.formatDueAt('2026-06-07T09:00:00Z', '-07:00')).toMatch(
      /Sun,? Jun 7 2:00 AM/,
    );
  });

  it('passes the raw string through for unparseable input', () => {
    expect(exec.formatDueAt('not-a-date', '+00:00')).toBe('not-a-date');
  });

  it('ignores a malformed offset string', () => {
    // Falls back to 0; same result as undefined.
    expect(exec.formatDueAt('2026-06-07T09:00:00Z', 'garbage')).toMatch(
      /Sun,? Jun 7 9:00 AM/,
    );
  });
});

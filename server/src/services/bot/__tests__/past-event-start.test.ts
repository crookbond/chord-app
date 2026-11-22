/**
 * isPastEventStart — the boundary `create_event` refuses on. A calendar entry
 * is something the family still has to show up for, so a start on a date the
 * user has already lived through is treated as a typo and sent back for
 * confirmation rather than written.
 *
 * The cases that matter are the ones on either side of "start of the user's
 * local day": an all-day event for today (floating midnight) must pass, and a
 * date that has actually turned over must not.
 */
import { describe, expect, it } from 'vitest';

import { isPastEventStart } from '@/utils/tz.js';

describe('isPastEventStart', () => {
  // 2026-05-12 18:00Z = 2pm in New York (-04:00), 11am in Los Angeles (-07:00).
  const now = new Date('2026-05-12T18:00:00.000Z');

  it('flags yesterday', () => {
    expect(isPastEventStart('2026-05-11T19:00:00-04:00', '-04:00', now)).toBe(true);
  });

  it('flags a stale year at the same wall-clock date', () => {
    expect(isPastEventStart('2025-05-12T19:00:00-04:00', '-04:00', now)).toBe(true);
  });

  it('allows a later time today', () => {
    expect(isPastEventStart('2026-05-12T19:00:00-04:00', '-04:00', now)).toBe(false);
  });

  // "lunch at noon" typed at 2pm is someone recording a live day, not a
  // mistake — the boundary is the day, not the minute.
  it('allows an earlier time today', () => {
    expect(isPastEventStart('2026-05-12T09:00:00-04:00', '-04:00', now)).toBe(false);
  });

  it('allows tomorrow', () => {
    expect(isPastEventStart('2026-05-13T09:00:00-04:00', '-04:00', now)).toBe(false);
  });

  // ADR 0040 all-day: floating midnight, no offset. A strict `< now` test
  // would reject every all-day event created after midnight local.
  it("allows today's all-day event (floating midnight)", () => {
    expect(isPastEventStart('2026-05-12T00:00:00', '-04:00', now)).toBe(false);
  });

  it('flags an all-day event on a date that turned over', () => {
    expect(isPastEventStart('2026-05-11T00:00:00', '-04:00', now)).toBe(true);
  });

  // 01:00Z on the 13th is still the evening of the 12th in New York.
  it('judges the date in the user zone, not UTC', () => {
    expect(isPastEventStart('2026-05-13T01:00:00Z', '-04:00', now)).toBe(false);
    expect(isPastEventStart('2026-05-12T02:00:00Z', '-04:00', now)).toBe(true);
  });

  it('defaults to UTC when no offset is known', () => {
    expect(isPastEventStart('2026-05-12T02:00:00Z', undefined, now)).toBe(false);
    expect(isPastEventStart('2026-05-11T23:00:00Z', undefined, now)).toBe(true);
  });

  it('lets malformed datetimes through — zod is the shape guard', () => {
    expect(isPastEventStart('not a date', '-04:00', now)).toBe(false);
    expect(isPastEventStart('', '-04:00', now)).toBe(false);
  });
});

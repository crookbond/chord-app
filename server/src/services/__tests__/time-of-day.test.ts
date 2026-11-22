/**
 * parseTimeOfDay / formatTimeOfDay — the loose time parsing that backs the
 * Settings "briefing time" field and the chat "nudge me at 7am" flow. The
 * parser must accept the handful of shapes a user might type and reject
 * nonsense rather than silently picking a wrong time.
 */
import { describe, expect, it } from 'vitest';

import { parseTimeOfDay, formatTimeOfDay } from '@chord/kernel';

describe('parseTimeOfDay', () => {
  it.each([
    ['7', { hour: 7, minute: 0 }],
    ['7a', { hour: 7, minute: 0 }],
    ['7am', { hour: 7, minute: 0 }],
    ['7 AM', { hour: 7, minute: 0 }],
    ['7:30am', { hour: 7, minute: 30 }],
    ['7:30 PM', { hour: 19, minute: 30 }],
    ['12am', { hour: 0, minute: 0 }],
    ['12pm', { hour: 12, minute: 0 }],
    ['12:15 am', { hour: 0, minute: 15 }],
    ['19:00', { hour: 19, minute: 0 }],
    ['0730', { hour: 7, minute: 30 }],
    ['23:59', { hour: 23, minute: 59 }],
    ['  6:05 p.m. ', { hour: 18, minute: 5 }],
  ])('parses %j', (input, expected) => {
    expect(parseTimeOfDay(input)).toEqual(expected);
  });

  it.each(['', 'noon', '25:00', '7:99', '13am', '0pm', 'abc', '99'])(
    'rejects %j',
    (input) => {
      expect(parseTimeOfDay(input)).toBeNull();
    },
  );
});

describe('formatTimeOfDay', () => {
  it.each([
    [7, 0, '7:00 AM'],
    [0, 0, '12:00 AM'],
    [12, 0, '12:00 PM'],
    [19, 30, '7:30 PM'],
    [23, 5, '11:05 PM'],
  ])('formats %i:%i as %s', (h, m, expected) => {
    expect(formatTimeOfDay(h, m)).toBe(expected);
  });

  it('round-trips through parseTimeOfDay', () => {
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 15, 30, 45]) {
        expect(parseTimeOfDay(formatTimeOfDay(h, m))).toEqual({ hour: h, minute: m });
      }
    }
  });
});

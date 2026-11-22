/**
 * Weekday names are dates (ADR 0245).
 *
 * The recorded potluck email, sent Monday 2026-10-12: "For the block potluck
 * this Sunday at noon, could you bring paper plates…". "This Sunday" is
 * 2026-10-18, counted from the day the email was SENT, and "at noon" beside
 * it is a time someone can be free or busy at.
 */
import { describe, expect, it } from 'vitest';

import { mentionedDays, mentionedSlots } from '@/utils/date-mentions.js';

const MON = '2026-10-12'; // the day the recorded emails were sent
const THU = '2026-10-15';
const SUN = '2026-10-18';

const POTLUCK =
  'For the block potluck this Sunday at noon, could you bring paper plates, a fruit salad, and two bottles of sparkling water? Everyone else has mains covered. Thanks, Priya';

describe('weekday names, counted from the day the email was sent', () => {
  it('the potluck: "this Sunday at noon", sent Monday 12 October, is Sunday 18 October at 12:00', () => {
    expect(mentionedDays(POTLUCK, MON)).toEqual(['2026-10-18']);
    expect(mentionedSlots(POTLUCK, MON)).toEqual([{ day: '2026-10-18', minutes: 720 }]);
  });

  it('is the same answer whenever the thread is opened: only the sent day matters', () => {
    // Nothing in the call knows "now"; the anchor is the only clock there is.
    expect(mentionedDays('Potluck on Sunday - what to bring', MON)).toEqual(['2026-10-18']);
    expect(mentionedDays('Potluck on Sunday - what to bring', '2026-10-19')).toEqual(['2026-10-25']);
  });

  it('a bare weekday, "this" and "coming" are the next such day after the sent day', () => {
    expect(mentionedDays('Permission slip due Friday', MON)).toEqual(['2026-10-16']);
    expect(mentionedDays('can you do this Wednesday?', MON)).toEqual(['2026-10-14']);
    expect(mentionedDays('the coming Monday works', MON)).toEqual(['2026-10-19']);
  });

  it('today, tonight and tomorrow', () => {
    expect(mentionedDays('are you around tomorrow?', MON)).toEqual(['2026-10-13']);
    expect(mentionedDays('dinner tonight?', MON)).toEqual([MON]);
    expect(mentionedSlots('call me tomorrow at 2pm', MON)).toEqual([{ day: '2026-10-13', minutes: 840 }]);
  });

  it('written ON that weekday: "this Sunday" is that day, a bare "Sunday" is not resolved', () => {
    expect(mentionedDays('see you this Sunday', SUN)).toEqual([SUN]);
    expect(mentionedDays('see you Sunday', SUN)).toEqual([]);
  });

  it('"next Friday" lists both Fridays and asserts a time on neither', () => {
    expect(mentionedDays('are you free next Friday at 3pm?', THU)).toEqual(['2026-10-16', '2026-10-23']);
    expect(mentionedSlots('are you free next Friday at 3pm?', THU)).toEqual([]);
    expect(mentionedDays('next Friday?', MON)).toEqual(['2026-10-16', '2026-10-23']);
    // Written on a Friday there is only one reading.
    expect(mentionedSlots('next Friday at 3pm?', '2026-10-16')).toEqual([{ day: '2026-10-23', minutes: 900 }]);
  });

  it('"last Friday" is the past and matches nothing', () => {
    expect(mentionedDays('great seeing you last Friday', MON)).toEqual([]);
  });

  it('a weekday beside a written date is that date, not a second day', () => {
    expect(mentionedDays('Dinner Saturday the 24th?', MON)).toEqual(['2026-10-24']);
    expect(mentionedDays('Flight UA 1234 Fri November 20, 2026 depart Newark', MON)).toEqual(['2026-11-20']);
    expect(mentionedDays('check-in Friday November 20, 2026, check-out Tuesday November 24, 2026', MON)).toEqual([
      '2026-11-20',
      '2026-11-24',
    ]);
  });

  it('abbreviations count only where they read as a day', () => {
    expect(mentionedSlots('Fri at 3pm works', MON)).toEqual([{ day: '2026-10-16', minutes: 900 }]);
    expect(mentionedDays('we sat at the back and the sun was out; they wed in May', MON)).toEqual([]);
  });

  it('"Friday at 3" is 3 PM; an hour with two ordinary readings is not guessed', () => {
    expect(mentionedSlots('Friday at 3?', MON)).toEqual([{ day: '2026-10-16', minutes: 15 * 60 }]);
    expect(mentionedSlots('Friday at 9:30?', MON)).toEqual([{ day: '2026-10-16', minutes: 9 * 60 + 30 }]);
    expect(mentionedSlots('Friday at 7?', MON)).toEqual([]);
    expect(mentionedSlots('Friday at 12?', MON)).toEqual([]);
    expect(mentionedSlots('Hi John, Are you free at 9a on 10/26 thanks', MON)).toEqual([
      { day: '2026-10-26', minutes: 540 },
    ]);
  });
});

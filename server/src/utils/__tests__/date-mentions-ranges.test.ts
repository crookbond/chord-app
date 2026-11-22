/**
 * Offered windows, read the way they were written (ADR 0244 addendum).
 *
 * The recording, 5 November 2026: Omar's scheduler offered six days of
 * windows "PT" to a reader in New York. Only the first time beside each date
 * was kept, as a 10:30 on the reader's clock, and the "PT" was dropped.
 */
import { describe, expect, it } from 'vitest';

import { mentionedSlots } from '@/utils/date-mentions.js';

const OMAR = `Hi John & Capri,

Omar is available at the following times in the next few weeks:

  - 11/10: 10:30 AM – 12:00 PM PT
  - 11/12: 3:00 PM – 5:00 PM PT
  - 11/13: 8:00 AM – 12:00 PM PT
  - 11/16: 8:00 AM – 9:30 AM PT, 1:00 PM – 2:00 PM PT
  - 11/17: 8:00 AM – 10:00 AM PT, 2:00 PM – 4:00 PM PT
  - 11/18: 10:30 AM – 12:00 PM PT, 1:00 PM – 2:00 PM PT

Please let me know what works best for you both, and I will send over a calendar invitation.`;

const PT = 'America/Los_Angeles';
const w = (day: string, from: number, to: number) => ({ day, minutes: from, endMinutes: to, timeZone: PT });

describe('offered windows', () => {
  it('reads every window in the recorded email, with its end and its zone', () => {
    expect(mentionedSlots(OMAR, '2026-11-05')).toEqual([
      w('2026-11-10', 630, 720),
      w('2026-11-12', 900, 1020),
      w('2026-11-13', 480, 720),
      w('2026-11-16', 480, 570),
      w('2026-11-16', 780, 840),
      w('2026-11-17', 480, 600),
      w('2026-11-17', 840, 960),
      w('2026-11-18', 630, 720),
      w('2026-11-18', 780, 840),
    ]);
  });

  it('a range whose first end has no AM/PM takes the half that fits', () => {
    expect(mentionedSlots('Oct 26, 11–1 PM (CT)?', '2026-10-12')).toEqual([
      { day: '2026-10-26', minutes: 660, endMinutes: 780, timeZone: 'America/Chicago' },
    ]);
    expect(mentionedSlots('Oct 26, 2-4pm works', '2026-10-12')).toEqual([
      { day: '2026-10-26', minutes: 840, endMinutes: 960 },
    ]);
  });

  it('a zone written once covers every time listed with it', () => {
    expect(mentionedSlots('10/26 at 9am or 2pm Eastern Time', '2026-10-12')).toEqual([
      { day: '2026-10-26', minutes: 540, timeZone: 'America/New_York' },
      { day: '2026-10-26', minutes: 840, timeZone: 'America/New_York' },
    ]);
  });

  it('lowercase "et" in prose is not a zone, and no zone means none', () => {
    expect(mentionedSlots('10/26 at 9am et cetera', '2026-10-12')).toEqual([{ day: '2026-10-26', minutes: 540 }]);
  });
});

describe('zones outside the US', () => {
  const zoneOf = (text: string) => mentionedSlots(text, '2026-11-05').map((s) => s.timeZone);

  it('reads abbreviations and names', () => {
    expect(zoneOf('11/10 at 9am IST')).toEqual(['Asia/Kolkata']);
    expect(zoneOf('11/10, 3pm – 4:30pm CET')).toEqual(['Europe/Paris']);
    expect(zoneOf('11/10 at 10am AEDT')).toEqual(['Australia/Sydney']);
    expect(zoneOf('11/10 at 2pm Japan Standard Time')).toEqual(['Asia/Tokyo']);
    expect(zoneOf('11/10 at 2pm India Time')).toEqual(['Asia/Kolkata']);
  });

  it('"Central European Time" is not US Central', () => {
    expect(zoneOf('11/10 at 9am Central European Time')).toEqual(['Europe/Paris']);
  });

  it('reads UTC/GMT offsets, including the Outlook "(UTC-08:00)" form', () => {
    expect(zoneOf('11/10 at 9am GMT+1')).toEqual(['Etc/GMT-1']);
    expect(zoneOf('Nov 10 10:30 AM-12:00 PM (UTC-08:00) Pacific Time (US & Canada)')).toEqual(['Etc/GMT+8']);
    expect(['+05:30', 'Asia/Kolkata']).toContain(zoneOf('11/10 at 7pm UTC+5:30')[0]);
  });

  it('reads "<city> time" only for a city the place table knows', () => {
    expect(zoneOf('11/10 at 3pm London time')).toEqual(['Europe/London']);
    expect(zoneOf('11/10 at 1pm Lunch time')).toEqual([undefined]);
  });
});

describe('a range with no AM/PM at all', () => {
  // The recording, 17 November 2026: Rob wrote "mostly free tomorrow from
  // 10-1". Neither end said AM or PM, so no window was read and the draft
  // offered all of 10-1 over a 12:00-12:50 meeting.
  const ROB = 'Hi John,\nI am mostly free tomorrow from 10-1. Anything work for you?\n\nBest\nRob';

  it('reads "from 10-1" as 10 AM to 1 PM', () => {
    expect(mentionedSlots(ROB, '2026-11-16')).toEqual([{ day: '2026-11-17', minutes: 600, endMinutes: 780 }]);
  });

  it('reads "between 2 and 4" and "from 9:30 to 11" by working hours', () => {
    expect(mentionedSlots('11/10 between 2 and 4?', '2026-11-05')).toEqual([
      { day: '2026-11-10', minutes: 840, endMinutes: 960 },
    ]);
    expect(mentionedSlots('11/10 from 9:30 to 11 works', '2026-11-05')).toEqual([
      { day: '2026-11-10', minutes: 570, endMinutes: 660 },
    ]);
  });

  it('leaves a bare "10-1" alone, and a start at 7 unguessed', () => {
    expect(mentionedSlots('11/10 we won 10-1', '2026-11-05')).toEqual([]);
    expect(mentionedSlots('11/10 from 7-9', '2026-11-05')).toEqual([]);
  });
});

describe('24-hour ranges', () => {
  it('reads a range on the 24-hour clock', () => {
    expect(mentionedSlots('Nov 10: 14:00 – 15:30 CET', '2026-11-05')).toEqual([
      { day: '2026-11-10', minutes: 840, endMinutes: 930, timeZone: 'Europe/Paris' },
    ]);
    expect(mentionedSlots('11/10 09:00-10:30 works', '2026-11-05')).toEqual([
      { day: '2026-11-10', minutes: 540, endMinutes: 630 },
    ]);
    expect(mentionedSlots('11/10 22:00 to 01:00', '2026-11-05')).toEqual([
      { day: '2026-11-10', minutes: 1320, endMinutes: 1500 },
    ]);
  });

  it('leaves "3:00-4:00" alone: the clock does not say which half of the day', () => {
    expect(mentionedSlots('11/10 3:00-4:00', '2026-11-05')).toEqual([]);
  });
});

describe('a zone written before the time, or once for all of them', () => {
  it('reads "PT: 10:30 AM" and "(ET) 2pm"', () => {
    expect(mentionedSlots('11/10 PT: 10:30 AM', '2026-11-05')).toEqual([
      { day: '2026-11-10', minutes: 630, timeZone: 'America/Los_Angeles' },
    ]);
    expect(mentionedSlots('11/12 (ET) 2pm', '2026-11-05')).toEqual([
      { day: '2026-11-12', minutes: 840, timeZone: 'America/New_York' },
    ]);
  });

  it('"All times are in Pacific Time" covers every time with no zone of its own', () => {
    const text = `All times are in Pacific Time.
  - 11/10: 10:30 AM – 12:00 PM
  - 11/12: 3:00 PM – 5:00 PM
  - 11/13: 9:00 AM ET`;
    expect(mentionedSlots(text, '2026-11-05').map((s) => [s.day, s.timeZone])).toEqual([
      ['2026-11-10', 'America/Los_Angeles'],
      ['2026-11-12', 'America/Los_Angeles'],
      ['2026-11-13', 'America/New_York'],
    ]);
  });

  it('two different declared zones declare nothing', () => {
    const text = 'Times for Sam are in ET, times for Ana are in CET. 11/10 at 9am';
    expect(mentionedSlots(text, '2026-11-05')).toEqual([{ day: '2026-11-10', minutes: 540 }]);
  });
});

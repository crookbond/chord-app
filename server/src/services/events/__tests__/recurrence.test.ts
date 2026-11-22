import { describe, expect, it } from 'vitest';

import {
  buildRrule,
  describeRrule,
  exdatesForGoogle,
  expandLocal,
  looksLikeRecurrenceRequest,
  rruleForGoogle,
  storedStart,
  trimRepeatToRequest,
  validateRepeat,
  type RepeatSpec,
} from '../recurrence.js';

describe('trimRepeatToRequest', () => {
  const START = '2026-10-27T16:00:00';
  // The spec gpt-4.1-mini sent for "every Tuesday" in the 2026-10-24 test run.
  const FILLED: RepeatSpec = {
    count: 1,
    frequency: 'weekly',
    interval: 1,
    monthlyWeek: 1,
    until: '2026-10-25',
    weekdays: ['TU'],
  };

  it('"every Tuesday" keeps weekly on Tuesday and nothing else', () => {
    expect(trimRepeatToRequest(FILLED, ['add Maya swim class every Tuesday at 4pm'], START)).toEqual({
      frequency: 'weekly',
      weekdays: ['TU'],
    });
  });

  it('keeps an interval, an end and a week of the month only when they were said', () => {
    expect(
      trimRepeatToRequest({ frequency: 'weekly', interval: 2 }, ['piano every other Thursday'], START),
    ).toEqual({ frequency: 'weekly', interval: 2 });
    expect(
      trimRepeatToRequest({ ...FILLED, until: '2026-12-15' }, ['swim every Tuesday until December 15'], START),
    ).toEqual({ frequency: 'weekly', weekdays: ['TU'], until: '2026-12-15' });
    expect(
      trimRepeatToRequest({ frequency: 'weekly', count: 10 }, ['swim every Tuesday for 10 weeks'], START),
    ).toEqual({ frequency: 'weekly', count: 10 });
    expect(
      trimRepeatToRequest({ frequency: 'monthly', monthlyWeek: 1 }, ['book club the first Tuesday of every month'], START),
    ).toEqual({ frequency: 'monthly', monthlyWeek: 1 });
    expect(
      trimRepeatToRequest({ frequency: 'monthly', monthlyWeek: 1 }, ['pay rent every month'], START),
    ).toEqual({ frequency: 'monthly' });
  });

  it('an end date before the first occurrence is never kept, even when an end was said', () => {
    expect(trimRepeatToRequest(FILLED, ['every Tuesday until the end of the year'], START).until).toBeUndefined();
  });

  it('daily on chosen days becomes weekly only when days were named', () => {
    expect(
      trimRepeatToRequest({ frequency: 'daily', weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'] }, ['standup every weekday at 9'], START),
    ).toEqual({ frequency: 'weekly', weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'] });
    expect(trimRepeatToRequest({ frequency: 'daily', weekdays: ['SA'] }, ['meds every day at 8'], START)).toEqual({
      frequency: 'daily',
    });
  });

  it('with no words to read, returns the spec unchanged (a contradiction is still refused later)', () => {
    expect(trimRepeatToRequest(FILLED, null, START)).toBe(FILLED);
  });
});

describe('buildRrule (ADR 0217)', () => {
  it('weekly defaults to the first occurrence’s weekday (the prod request)', () => {
    // "nolan sci oly at 330-530pm weekly", starting Wed Sep 30 2026.
    expect(buildRrule({ frequency: 'weekly' }, '2026-09-30T15:30:00')).toBe('FREQ=WEEKLY;BYDAY=WE');
  });

  it('weekly on several days, every 2 weeks, until a date', () => {
    expect(
      buildRrule(
        { frequency: 'weekly', interval: 2, weekdays: ['TH', 'MO'], until: '2026-12-18' },
        '2026-09-28T09:00:00',
      ),
    ).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20261218');
  });

  it('monthly on a date, or on the Nth weekday of the first occurrence', () => {
    expect(buildRrule({ frequency: 'monthly' }, '2026-10-15T19:00:00')).toBe('FREQ=MONTHLY;BYMONTHDAY=15');
    expect(buildRrule({ frequency: 'monthly', monthlyWeek: -1 }, '2026-10-29T19:00:00')).toBe(
      'FREQ=MONTHLY;BYDAY=-1TH',
    );
  });

  it('refuses what it cannot represent', () => {
    expect(() => validateRepeat({ frequency: 'daily', weekdays: ['MO'] })).toThrow();
    expect(() => validateRepeat({ frequency: 'weekly', count: 0 })).toThrow();
    expect(() => validateRepeat({ frequency: 'weekly', until: 'next month' })).toThrow();
  });
});

describe('expandLocal (ADR 0217)', () => {
  it('weekly Wednesdays keep their wall-clock time', () => {
    expect(
      expandLocal({
        firstLocal: '2026-09-30T15:30:00',
        rrule: 'FREQ=WEEKLY;BYDAY=WE',
        fromDate: '2026-09-01',
        toDate: '2026-10-21',
      }),
    ).toEqual([
      '2026-09-30T15:30:00',
      '2026-10-07T15:30:00',
      '2026-10-14T15:30:00',
      '2026-10-21T15:30:00',
    ]);
  });

  it('stays at 3:30 local across the November DST change', () => {
    const [before, after] = expandLocal({
      firstLocal: '2026-10-28T15:30:00',
      rrule: 'FREQ=WEEKLY;BYDAY=WE',
      fromDate: '2026-10-28',
      toDate: '2026-11-04',
    });
    expect(storedStart(before!, 'America/New_York', false)).toBe('2026-10-28T15:30:00-04:00');
    expect(storedStart(after!, 'America/New_York', false)).toBe('2026-11-04T15:30:00-05:00');
  });

  it('several weekdays, starting mid-week, skip days before the first', () => {
    expect(
      expandLocal({
        firstLocal: '2026-09-30T08:00:00', // a Wednesday
        rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
        fromDate: '2026-09-01',
        toDate: '2026-10-06',
      }).map((s) => s.slice(0, 10)),
    ).toEqual(['2026-09-30', '2026-10-02', '2026-10-05']);
  });

  it('COUNT counts an excluded occurrence, so removing one does not add one at the end', () => {
    expect(
      expandLocal({
        firstLocal: '2026-09-30T15:30:00',
        rrule: 'FREQ=WEEKLY;BYDAY=WE;COUNT=3',
        exdates: ['2026-10-07T15:30:00'],
        fromDate: '2026-09-01',
        toDate: '2027-01-01',
      }).map((s) => s.slice(0, 10)),
    ).toEqual(['2026-09-30', '2026-10-14']);
  });

  it('UNTIL is inclusive', () => {
    expect(
      expandLocal({
        firstLocal: '2026-09-30T15:30:00',
        rrule: 'FREQ=WEEKLY;BYDAY=WE;UNTIL=20261014',
        fromDate: '2026-09-01',
        toDate: '2027-01-01',
      }),
    ).toHaveLength(3);
  });

  it('monthly on the 31st skips months without one', () => {
    expect(
      expandLocal({
        firstLocal: '2026-10-31T10:00:00',
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=31',
        fromDate: '2026-10-01',
        toDate: '2027-03-31',
      }).map((s) => s.slice(0, 10)),
    ).toEqual(['2026-10-31', '2026-12-31', '2027-01-31', '2027-03-31']);
  });

  it('last Thursday of each month', () => {
    expect(
      expandLocal({
        firstLocal: '2026-10-29T19:00:00',
        rrule: 'FREQ=MONTHLY;BYDAY=-1TH',
        fromDate: '2026-10-01',
        toDate: '2027-01-31',
      }).map((s) => s.slice(0, 10)),
    ).toEqual(['2026-10-29', '2026-11-26', '2026-12-31', '2027-01-28']);
  });

  it('only returns occurrences inside the window', () => {
    expect(
      expandLocal({
        firstLocal: '2026-01-07T15:30:00',
        rrule: 'FREQ=WEEKLY;BYDAY=WE',
        fromDate: '2026-09-28',
        toDate: '2026-10-08',
      }).map((s) => s.slice(0, 10)),
    ).toEqual(['2026-09-30', '2026-10-07']);
  });
});

describe('Google shapes (ADR 0217)', () => {
  it('a timed UNTIL becomes the end of that local day in UTC', () => {
    expect(rruleForGoogle('FREQ=WEEKLY;BYDAY=WE;UNTIL=20261216', 'America/New_York', false)).toBe(
      'RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20261217T045959Z',
    );
  });

  it('EXDATE carries the zone for a timed series, a date for an all-day one', () => {
    expect(exdatesForGoogle(['2026-10-07T15:30:00'], 'America/New_York', false)).toEqual([
      'EXDATE;TZID=America/New_York:20261007T153000',
    ]);
    expect(exdatesForGoogle(['2026-10-07T00:00:00'], 'America/New_York', true)).toEqual([
      'EXDATE;VALUE=DATE:20261007',
    ]);
  });

  it('describes the rule for the tool reply', () => {
    expect(describeRrule('FREQ=WEEKLY;BYDAY=WE')).toBe('weekly on Wed');
    expect(describeRrule('FREQ=MONTHLY;BYDAY=-1TH;UNTIL=20270601')).toBe(
      'monthly on the last Thu until 2027-06-01',
    );
  });
});

describe('looksLikeRecurrenceRequest', () => {
  it('finds no recurrence language in a plain one-time request (prod, 2026-10)', () => {
    expect(looksLikeRecurrenceRequest('@Chord add call with AHF tomorrow at noon')).toBe(false);
    expect(
      looksLikeRecurrenceRequest(
        '@Chord add to personal calendar - call with AHF at noon tomorrow, invite hannah, victor and scott',
      ),
    ).toBe(false);
  });

  it('finds recurrence words wherever they appear', () => {
    expect(looksLikeRecurrenceRequest('make it a weekly call')).toBe(true);
    expect(looksLikeRecurrenceRequest('this should repeat every Tuesday')).toBe(true);
    expect(looksLikeRecurrenceRequest('set up a daily reminder')).toBe(true);
    expect(looksLikeRecurrenceRequest('can you make this recurring')).toBe(true);
    expect(looksLikeRecurrenceRequest('each week on Friday')).toBe(true);
    expect(looksLikeRecurrenceRequest('every weekday at 9am')).toBe(true);
  });

  it('is case-insensitive and matches whole words only', () => {
    expect(looksLikeRecurrenceRequest('WEEKLY standup')).toBe(true);
    // "everyone" contains "every" as a substring but is not a recurrence word.
    expect(looksLikeRecurrenceRequest('invite everyone to the call')).toBe(false);
  });

  // ADR 0229 — this now decides whether a valid repeat is kept, so the ways
  // people ask for one without saying "every" or "weekly" have to count.
  it('recognises a repeat asked for by day name or habit', () => {
    for (const text of [
      'soccer practice on Tuesdays at 4',
      'gym on weekdays at 6am',
      'date night on weekends',
      'homework help on weeknights',
      'biweekly 1:1 with Sam',
      'bi-weekly payroll check',
      'fortnightly bin day',
      'quarterly taxes',
      'each Friday at 3',
      'each morning at 7',
      'our standing lunch',
      'this is a repeated thing',
      'set up a recurrence for trash day',
    ]) {
      expect(looksLikeRecurrenceRequest(text), text).toBe(true);
    }
  });

  it('does not read one named day, or a plain time, as a repeat', () => {
    for (const text of [
      'add lunch tomorrow at noon to my Outlook calendar',
      'dentist on Tuesday at 3',
      'dinner this weekend',
      'call mom on a weekday',
      'move lunch to 1pm',
      'flight to Denver Friday morning',
    ]) {
      expect(looksLikeRecurrenceRequest(text), text).toBe(false);
    }
  });
});

/**
 * ADR 0228 — Graph events ⇄ the sync engine's shape. Pure, no network.
 */
import { describe, expect, it } from 'vitest';

import {
  isOutlookCalendarKey,
  outlookAccountKeyPrefix,
  outlookCalendarKey,
  parseOutlookCalendarKey,
} from '@/services/outlook-calendar/ids.js';
import {
  exdatesToRemovals,
  googleBodyToGraph,
  graphCalendarRole,
  graphDeltaToResources,
  graphEventToResource,
  rruleToGraphRecurrence,
  type GraphEvent,
} from '@/services/outlook-calendar/map.js';
import { grantsOutlookCalendar } from '@/services/outlook-calendar/enabled.js';

const NY = 'America/New_York';

describe('calendar ids', () => {
  it('round-trips an account and a calendar id that itself contains colons', () => {
    const key = outlookCalendarKey('ema_abc123', 'AAMk:with=colons_and-dashes');
    expect(key).toBe('outlook:ema_abc123:AAMk:with=colons_and-dashes');
    expect(isOutlookCalendarKey(key)).toBe(true);
    expect(parseOutlookCalendarKey(key)).toEqual({
      accountId: 'ema_abc123',
      calendarId: 'AAMk:with=colons_and-dashes',
    });
    expect(key.startsWith(outlookAccountKeyPrefix('ema_abc123'))).toBe(true);
  });

  it('does not mistake a Google or device id for an Outlook one', () => {
    for (const id of ['primary', 'family@group.calendar.google.com', 'BEE3A1B0-1234', null, undefined]) {
      expect(isOutlookCalendarKey(id)).toBe(false);
      expect(parseOutlookCalendarKey(id)).toBeNull();
    }
    expect(parseOutlookCalendarKey('outlook:onlyaccount')).toBeNull();
  });
});

describe('grantsOutlookCalendar', () => {
  it('reads the scope in either form Microsoft returns it', () => {
    expect(grantsOutlookCalendar('openid Mail.ReadWrite Calendars.ReadWrite Mail.Send')).toBe(true);
    expect(grantsOutlookCalendar('https://graph.microsoft.com/Calendars.ReadWrite')).toBe(true);
    expect(grantsOutlookCalendar('openid Mail.ReadWrite Mail.Send')).toBe(false);
    expect(grantsOutlookCalendar('Calendars.Read')).toBe(false);
    expect(grantsOutlookCalendar('Calendars.ReadWrite.Shared')).toBe(false);
  });
});

describe('graphEventToResource', () => {
  const timed: GraphEvent = {
    id: 'ev1',
    '@odata.etag': 'W/"abc"',
    iCalUId: 'uid-1',
    subject: 'Dentist',
    body: { contentType: 'text', content: 'Bring the form\r\n\r\n' },
    location: { displayName: ' 12 Main St ' },
    start: { dateTime: '2026-11-12T19:30:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-11-12T20:30:00.0000000', timeZone: 'UTC' },
    isAllDay: false,
    showAs: 'busy',
    type: 'singleInstance',
    lastModifiedDateTime: '2026-10-01T10:00:00Z',
  };

  it('restates a UTC time in the reader zone, with that date offset', () => {
    const r = graphEventToResource(timed, NY);
    // 12 Nov is after the clocks go back: -05:00, not October's -04:00.
    expect(r.start).toEqual({ dateTime: '2026-11-12T14:30:00-05:00', timeZone: NY });
    expect(r.end).toEqual({ dateTime: '2026-11-12T15:30:00-05:00', timeZone: NY });
    expect(r.summary).toBe('Dentist');
    expect(r.description).toBe('Bring the form');
    expect(r.location).toBe('12 Main St');
    expect(r.iCalUID).toBe('uid-1');
    expect(r.etag).toBe('W/"abc"');
    expect(r.updated).toBe('2026-10-01T10:00:00Z');
    expect(r.status).toBe('confirmed');
    expect(r.transparency).toBe('opaque');
    // Graph has no sequence; the engine must see "no version", not zero.
    expect(r.sequence).toBeUndefined();
    expect(r.recurringEventId).toBeUndefined();
  });

  it('keeps UTC when the reader zone is unknown', () => {
    expect(graphEventToResource(timed, null).start).toEqual({ dateTime: '2026-11-12T19:30:00Z' });
  });

  it('reads an all-day event as dates, end exclusive', () => {
    const r = graphEventToResource(
      {
        id: 'ad',
        subject: 'School closed',
        isAllDay: true,
        start: { dateTime: '2026-11-26T00:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-11-27T00:00:00.0000000', timeZone: 'UTC' },
      },
      NY,
    );
    expect(r.start).toEqual({ date: '2026-11-26' });
    expect(r.end).toEqual({ date: '2026-11-27' });
  });

  it('maps free time, a cancelled meeting and a removed event', () => {
    expect(graphEventToResource({ ...timed, showAs: 'free' }, NY).transparency).toBe('transparent');
    expect(graphEventToResource({ ...timed, showAs: 'tentative' }, NY).transparency).toBe('opaque');
    expect(graphEventToResource({ ...timed, isCancelled: true }, NY).status).toBe('cancelled');
    expect(graphEventToResource({ id: 'gone', '@removed': { reason: 'deleted' } }, NY)).toEqual({
      id: 'gone',
      status: 'cancelled',
    });
  });

  it("maps the mailbox owner's answer to the engine's attendee row", () => {
    const answer = (response: string) =>
      graphEventToResource({ ...timed, responseStatus: { response } }, NY).attendees;
    expect(answer('declined')).toEqual([{ self: true, responseStatus: 'declined' }]);
    expect(answer('accepted')).toEqual([{ self: true, responseStatus: 'accepted' }]);
    expect(answer('tentativelyAccepted')).toEqual([{ self: true, responseStatus: 'tentative' }]);
    expect(answer('notResponded')).toEqual([{ self: true, responseStatus: 'needsAction' }]);
    // Your own event: nothing to answer.
    expect(answer('organizer')).toBeUndefined();
    expect(answer('none')).toBeUndefined();
  });

  it('recognises an event Chord created by its stamp', () => {
    const ours = graphEventToResource({ ...timed, transactionId: 'ce_abc123' }, NY);
    expect(ours.extendedProperties?.private?.chordUid).toBe('ce_abc123');
    const theirs = graphEventToResource({ ...timed, transactionId: 'some-other-app' }, NY);
    expect(theirs.extendedProperties).toBeUndefined();
  });
});

describe('graphDeltaToResources', () => {
  const master: GraphEvent = {
    id: 'M',
    iCalUId: 'uid-series',
    subject: 'Standup',
    type: 'seriesMaster',
    isAllDay: false,
    showAs: 'busy',
    start: { dateTime: '2026-10-05T13:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-05T13:15:00.0000000', timeZone: 'UTC' },
    lastModifiedDateTime: '2026-10-01T09:00:00Z',
  };
  // A delta lists an ordinary occurrence with its id and times only.
  const occurrence: GraphEvent = {
    id: 'O1',
    type: 'occurrence',
    seriesMasterId: 'M',
    start: { dateTime: '2026-10-12T13:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-12T13:15:00.0000000', timeZone: 'UTC' },
  };

  it('drops the master and fills an occurrence from it', () => {
    const { items, missingMasters } = graphDeltaToResources([master, occurrence], NY);
    expect(missingMasters).toEqual([]);
    expect(items).toHaveLength(1);
    const o = items[0]!;
    expect(o.id).toBe('O1');
    expect(o.summary).toBe('Standup');
    expect(o.iCalUID).toBe('uid-series');
    expect(o.recurringEventId).toBe('M');
    expect(o.start).toEqual({ dateTime: '2026-10-12T09:00:00-04:00', timeZone: NY });
    // An unmoved occurrence's original start is its start.
    expect(o.originalStartTime).toEqual(o.start);
    expect(o.updated).toBe('2026-10-01T09:00:00Z');
  });

  it('names a master the pages did not carry, and uses it once supplied', () => {
    const first = graphDeltaToResources([occurrence], NY);
    expect(first.items).toEqual([]);
    expect(first.missingMasters).toEqual(['M']);
    const second = graphDeltaToResources([occurrence], NY, new Map([['M', master]]));
    expect(second.items[0]?.summary).toBe('Standup');
  });

  it('keeps a moved occurrence its own content and its original start', () => {
    const exception: GraphEvent = {
      id: 'X1',
      type: 'exception',
      seriesMasterId: 'M',
      subject: 'Standup (moved)',
      originalStart: '2026-10-19T13:00:00Z',
      start: { dateTime: '2026-10-19T15:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-19T15:15:00.0000000', timeZone: 'UTC' },
    };
    const { items } = graphDeltaToResources([master, exception], NY);
    expect(items[0]?.summary).toBe('Standup (moved)');
    expect(items[0]?.start?.dateTime).toBe('2026-10-19T11:00:00-04:00');
    expect(items[0]?.originalStartTime?.dateTime).toBe('2026-10-19T09:00:00-04:00');
  });

  it('reports a removed event as cancelled, whatever it was', () => {
    const { items } = graphDeltaToResources([{ id: 'M', '@removed': { reason: 'deleted' } }], NY);
    expect(items).toEqual([{ id: 'M', status: 'cancelled' }]);
  });
});

describe('googleBodyToGraph', () => {
  const body = {
    summary: 'Piano',
    description: 'Bring book 2',
    location: 'Studio',
    start: { dateTime: '2026-11-12T16:00:00-05:00', timeZone: NY },
    end: { dateTime: '2026-11-12T17:00:00-05:00', timeZone: NY },
    transparency: 'opaque',
    status: 'confirmed',
    sequence: 3,
    extendedProperties: { private: { chordUid: 'ce_xyz' } },
  };

  it('writes wall time in the event zone, and stamps a new event', () => {
    const { body: g, removals } = googleBodyToGraph(body, true);
    expect(g).toEqual({
      subject: 'Piano',
      body: { contentType: 'text', content: 'Bring book 2' },
      location: { displayName: 'Studio' },
      start: { dateTime: '2026-11-12T16:00:00', timeZone: NY },
      end: { dateTime: '2026-11-12T17:00:00', timeZone: NY },
      isAllDay: false,
      showAs: 'busy',
      transactionId: 'ce_xyz',
    });
    expect(removals).toEqual([]);
  });

  it('leaves showAs and the stamp alone on an edit', () => {
    const { body: g } = googleBodyToGraph(body, false);
    expect(g.showAs).toBeUndefined();
    expect(g.transactionId).toBeUndefined();
    expect(g.subject).toBe('Piano');
  });

  it('sends a zoned time with no named zone as UTC', () => {
    const { body: g } = googleBodyToGraph(
      { summary: 'x', start: { dateTime: '2026-11-12T16:00:00-05:00' }, end: { dateTime: '2026-11-12T22:00:00Z' } },
      true,
    );
    expect(g.start).toEqual({ dateTime: '2026-11-12T21:00:00', timeZone: 'UTC' });
    expect(g.end).toEqual({ dateTime: '2026-11-12T22:00:00', timeZone: 'UTC' });
  });

  it('gives an all-day event the next midnight as its end', () => {
    // The engine sends a one-day all-day event with end == start.
    const { body: g } = googleBodyToGraph(
      { summary: 'Field day', start: { date: '2026-06-05' }, end: { date: '2026-06-05' }, transparency: 'transparent' },
      true,
    );
    expect(g.isAllDay).toBe(true);
    expect(g.start).toEqual({ dateTime: '2026-06-05T00:00:00', timeZone: 'UTC' });
    expect(g.end).toEqual({ dateTime: '2026-06-06T00:00:00', timeZone: 'UTC' });
    expect(g.showAs).toBe('free');
  });

  it('keeps a multi-day all-day end', () => {
    const { body: g } = googleBodyToGraph(
      { summary: 'Trip', start: { date: '2026-06-05' }, end: { date: '2026-06-08' } },
      true,
    );
    expect(g.end).toEqual({ dateTime: '2026-06-08T00:00:00', timeZone: 'UTC' });
  });

  it('turns guests into required attendees', () => {
    const { body: g } = googleBodyToGraph({ ...body, attendees: [{ email: 'a@x.com' }, { email: 'b@y.com' }] }, true);
    expect(g.attendees).toEqual([
      { emailAddress: { address: 'a@x.com' }, type: 'required' },
      { emailAddress: { address: 'b@y.com' }, type: 'required' },
    ]);
  });

  it('rebuilds a weekly rule and lists the removed occurrences', () => {
    const { body: g, removals } = googleBodyToGraph(
      {
        ...body,
        // What the engine sends Google: UNTIL as a UTC instant, EXDATE local.
        recurrence: [
          'RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261218T045959Z',
          `EXDATE;TZID=${NY}:20261126T160000`,
        ],
      },
      true,
    );
    expect(g.recurrence).toEqual({
      pattern: { type: 'weekly', interval: 1, daysOfWeek: ['thursday'], firstDayOfWeek: 'sunday' },
      // 04:59:59Z on the 18th is still the 17th in New York.
      range: { type: 'endDate', startDate: '2026-11-12', endDate: '2026-12-17', recurrenceTimeZone: NY },
    });
    expect(removals).toHaveLength(1);
    // 26 Nov 16:00 New York (standard time) = 21:00Z.
    expect(removals[0]!.startMs).toBe(Date.parse('2026-11-26T21:00:00Z'));
  });
});

describe('rruleToGraphRecurrence', () => {
  const start = '2026-10-07T09:00:00'; // a Wednesday

  it('daily, every other day, for a count', () => {
    expect(rruleToGraphRecurrence('RRULE:FREQ=DAILY;INTERVAL=2;COUNT=5', start, NY)).toEqual({
      pattern: { type: 'daily', interval: 2 },
      range: { type: 'numbered', startDate: '2026-10-07', numberOfOccurrences: 5, recurrenceTimeZone: NY },
    });
  });

  it('weekly with no day named repeats on the start weekday', () => {
    expect(rruleToGraphRecurrence('RRULE:FREQ=WEEKLY', start, NY).pattern).toEqual({
      type: 'weekly',
      interval: 1,
      daysOfWeek: ['wednesday'],
      firstDayOfWeek: 'sunday',
    });
  });

  it('monthly by date and by weekday position', () => {
    expect(rruleToGraphRecurrence('RRULE:FREQ=MONTHLY;BYMONTHDAY=15', start, NY).pattern).toEqual({
      type: 'absoluteMonthly',
      interval: 1,
      dayOfMonth: 15,
    });
    expect(rruleToGraphRecurrence('RRULE:FREQ=MONTHLY;BYDAY=-1FR', start, NY).pattern).toEqual({
      type: 'relativeMonthly',
      interval: 1,
      daysOfWeek: ['friday'],
      index: 'last',
    });
    expect(rruleToGraphRecurrence('RRULE:FREQ=MONTHLY;BYDAY=2TU', start, NY).pattern).toMatchObject({
      type: 'relativeMonthly',
      index: 'second',
      daysOfWeek: ['tuesday'],
    });
  });

  it('yearly on the start date, with no end', () => {
    expect(rruleToGraphRecurrence('RRULE:FREQ=YEARLY', start, NY)).toEqual({
      pattern: { type: 'absoluteYearly', interval: 1, dayOfMonth: 7, month: 10 },
      range: { type: 'noEnd', startDate: '2026-10-07', recurrenceTimeZone: NY },
    });
  });

  it('takes a date-only UNTIL (an all-day series) as written', () => {
    const r = rruleToGraphRecurrence('RRULE:FREQ=WEEKLY;UNTIL=20261218', '2026-10-07T00:00:00', 'UTC');
    expect(r.range).toEqual({ type: 'endDate', startDate: '2026-10-07', endDate: '2026-12-18' });
  });
});

describe('exdatesToRemovals', () => {
  it('reads an all-day removal as that whole day', () => {
    expect(exdatesToRemovals(['EXDATE;VALUE=DATE:20261126'])).toEqual([
      { from: '2026-11-26T00:00:00Z', to: '2026-11-27T00:00:00Z', startMs: null },
    ]);
  });

  it('skips a line it cannot read rather than guessing', () => {
    expect(exdatesToRemovals(['EXDATE:garbage'])).toEqual([]);
  });
});

describe('graphCalendarRole', () => {
  it('owner for your own, writer for a shared editable one, reader otherwise', () => {
    expect(graphCalendarRole({ id: 'a', canEdit: true, owner: { address: 'Me@Outlook.com' } }, 'me@outlook.com')).toBe('owner');
    expect(graphCalendarRole({ id: 'b', canEdit: true, owner: { address: 'spouse@outlook.com' } }, 'me@outlook.com')).toBe('writer');
    expect(graphCalendarRole({ id: 'c', canEdit: false, owner: { address: 'me@outlook.com' } }, 'me@outlook.com')).toBe('reader');
  });
});

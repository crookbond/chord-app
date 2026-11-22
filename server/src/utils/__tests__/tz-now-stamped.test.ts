/**
 * A time after a daylight-saving change, stamped with TODAY's offset
 * (ADR 0244).
 *
 * The recording: on 12 October 2026 (New York on -04:00) the flight email's
 * "Fri November 20, 2026 depart Newark (EWR) 8:15 AM" was staged as
 * `2026-11-20T08:15:00-04:00`. New York is on -05:00 from 1 November, so the
 * card was an hour early.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateNativeCall } from '@/services/bot/bot.service.js';
import { legDatetime } from '@/services/bot/trip_classifier.js';
import { anchorFlightTimes, type EmailSuggestion, type FlightFacts } from '@/services/email/magics.service.js';
import {
  namesATimeZone,
  offsetScheduleNote,
  reanchorNowStampedOffset,
  tzToOffsetMinutes,
} from '@/utils/tz.js';

/** When the demo was recorded: 6:52 PM in New York, daylight time. */
const RECORDED = new Date('2026-10-12T22:52:00Z');
const NY = 'America/New_York';

describe('reanchorNowStampedOffset', () => {
  it('moves the recorded flight time onto the offset New York has on that date', () => {
    expect(reanchorNowStampedOffset('2026-11-20T08:15:00-04:00', NY, RECORDED)).toBe(
      '2026-11-20T08:15:00-05:00',
    );
  });

  it('leaves a date on the same side of the change alone', () => {
    expect(reanchorNowStampedOffset('2026-10-26T09:00:00-04:00', NY, RECORDED)).toBe(
      '2026-10-26T09:00:00-04:00',
    );
  });

  it('leaves any offset that is not today\'s alone: it was chosen', () => {
    // Denver in November, the hotel card from the same recording.
    expect(reanchorNowStampedOffset('2026-11-20T15:00:00-07:00', NY, RECORDED)).toBe(
      '2026-11-20T15:00:00-07:00',
    );
    expect(reanchorNowStampedOffset('2026-11-20T13:15:00Z', NY, RECORDED)).toBe('2026-11-20T13:15:00Z');
  });

  it('works the other way round, from winter into summer', () => {
    const january = new Date('2027-01-15T15:00:00Z');
    expect(reanchorNowStampedOffset('2027-06-10T09:00:00-05:00', NY, january)).toBe(
      '2027-06-10T09:00:00-04:00',
    );
  });

  it('does nothing in a zone that never changes, or with no zone', () => {
    expect(reanchorNowStampedOffset('2026-11-20T08:15:00+05:30', 'Asia/Kolkata', RECORDED)).toBe(
      '2026-11-20T08:15:00+05:30',
    );
    expect(reanchorNowStampedOffset('2026-11-20T08:15:00-04:00', null, RECORDED)).toBe(
      '2026-11-20T08:15:00-04:00',
    );
  });
});

describe('namesATimeZone', () => {
  it('sees a zone the text states outright', () => {
    expect(namesATimeZone('Call at 3pm ET on Dec 5')).toBe(true);
    expect(namesATimeZone('10:00 PST works')).toBe(true);
    expect(namesATimeZone('3pm Eastern time')).toBe(true);
    expect(namesATimeZone('starts 15:00 UTC+1')).toBe(true);
  });
  it('does not see one in the recorded emails', () => {
    expect(namesATimeZone('Fri November 20, 2026 depart Newark (EWR) 8:15 AM arrive Denver (DEN) 10:45 AM')).toBe(false);
    expect(namesATimeZone('Hi John, Are you free at 9a on 10/26 thanks')).toBe(false);
    expect(namesATimeZone('Total paid $486.20. Confirmation KX8QP2')).toBe(false);
    expect(namesATimeZone('Open house 10:00-12:30, then lunch')).toBe(false);
  });
});

describe('offsetScheduleNote', () => {
  it('tells the model when the offset changes and to what', () => {
    expect(offsetScheduleNote(NY, RECORDED)).toBe(
      'UTC-04:00 until 2026-11-01, UTC-05:00 from that date on',
    );
  });
  it('says so when it never changes', () => {
    expect(offsetScheduleNote('Asia/Kolkata', RECORDED)).toBe('UTC+05:30 all year');
  });
});

describe('with the clock at the time of the recording', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(RECORDED);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('legDatetime: a Newark departure stamped with today\'s offset goes on Newark\'s November clock', () => {
    const readerNow = tzToOffsetMinutes(NY)!;
    expect(readerNow).toBe(-240);
    expect(legDatetime('2026-11-20T08:15:00-04:00', 'EWR', undefined, readerNow, NY)).toBe(
      '2026-11-20T08:15:00-05:00',
    );
    // The return leg leaves Denver: 4:30 PM there, whatever the reader's offset.
    expect(legDatetime('2026-11-24T16:30:00-04:00', 'DEN', undefined, readerNow, NY)).toBe(
      '2026-11-24T16:30:00-07:00',
    );
  });

  it('legDatetime: a time already on its airport\'s clock is not touched', () => {
    expect(legDatetime('2026-11-24T16:30:00-07:00', 'DEN', undefined, -240, NY)).toBe(
      '2026-11-24T16:30:00-07:00',
    );
  });

  it('anchorFlightTimes: the "Flight UA 1234" card moves with the departure', () => {
    const flight: FlightFacts = {
      departAt: '2026-11-20T08:15:00-04:00',
      arriveAt: '2026-11-20T10:45:00-04:00',
      origin: 'EWR',
      destination: 'DEN',
      status: null,
    };
    const card: EmailSuggestion = {
      kind: 'event',
      title: 'Flight UA 1234 from Newark to Denver',
      startsAt: '2026-11-20T08:15:00-04:00',
    };
    anchorFlightTimes(flight, [card], NY);
    expect(card).toMatchObject({ startsAt: '2026-11-20T08:15:00-05:00' });
    expect(flight.departAt).toBe('2026-11-20T08:15:00-05:00');
    expect(flight.arriveAt).toBe('2026-11-20T10:45:00-07:00');
  });

  it('chat: an event the model stamps with today\'s offset lands at the time the user said', () => {
    const res = validateNativeCall(
      { id: 'c1', name: 'create_event', args: { title: 'Dentist', startsAt: '2026-12-05T13:00:00-04:00' } },
      '-04:00',
      NY,
    );
    expect(res.ok && res.call.args).toMatchObject({ startsAt: '2026-12-05T13:00:00-05:00' });
  });

  it('chat: an offset is left as written when the user named the zone, and on a travel leg', () => {
    const named = validateNativeCall(
      { id: 'c1', name: 'create_event', args: { title: 'Call', startsAt: '2026-12-05T13:00:00-04:00' } },
      '-04:00',
      NY,
      true,
    );
    expect(named.ok && named.call.args).toMatchObject({ startsAt: '2026-12-05T13:00:00-04:00' });
    const leg = validateNativeCall(
      {
        id: 'c2',
        name: 'add_travel_leg',
        args: {
          origin: 'YHZ',
          destination: 'EWR',
          departAt: '2026-12-05T13:00:00-04:00',
          arriveAt: '2026-12-05T14:30:00-05:00',
        },
      },
      '-04:00',
      NY,
    );
    expect(leg.ok && leg.call.args).toMatchObject({ departAt: '2026-12-05T13:00:00-04:00' });
  });
});

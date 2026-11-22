/**
 * ICS VEVENT normalization: date-only DTSTART → a true all-day event on the
 * named calendar date (never a timed 09:00 server-local event), TZID-anchored
 * times → the correct UTC instant, DTEND carried through as endsAt.
 */
import { describe, expect, it } from 'vitest';

import { parseIcsBuffer } from '../parse.js';

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VEVENT',
  'UID:allday1',
  'SUMMARY:Field Day',
  'DTSTART;VALUE=DATE:20260902',
  'DTEND;VALUE=DATE:20260903',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:timed1',
  'SUMMARY:Parent Night',
  'DTSTART;TZID=America/New_York:20260910T183000',
  'DTEND;TZID=America/New_York:20260910T200000',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseIcsBuffer', () => {
  const result = parseIcsBuffer(Buffer.from(ICS, 'utf8'));

  it('date-only DTSTART becomes an all-day event on the named date', () => {
    const allday = result.events.find((e) => e.uid === 'allday1');
    expect(allday).toBeDefined();
    expect(allday!.allDay).toBe(true);
    expect(allday!.startsAt).toBe('2026-09-02T00:00:00');
    expect(allday!.endsAt).toBeUndefined();
  });

  it('TZID-anchored times resolve to the correct UTC instant with DTEND carried', () => {
    const timed = result.events.find((e) => e.uid === 'timed1');
    expect(timed).toBeDefined();
    expect(timed!.allDay).toBeUndefined();
    // 18:30 America/New_York (EDT, -04:00) → 22:30Z
    expect(Date.parse(timed!.startsAt)).toBe(Date.parse('2026-09-10T22:30:00Z'));
    expect(timed!.endsAt).toBeDefined();
    expect(Date.parse(timed!.endsAt!)).toBe(Date.parse('2026-09-11T00:00:00Z'));
  });

  it('a normal calendar carries its METHOD and no cancellations', () => {
    expect(result.method).toBeNull();
    expect(result.cancelledUids).toEqual([]);
  });

  it('METHOD:CANCEL cancels every VEVENT — even without STATUS:CANCELLED', () => {
    const cancel = parseIcsBuffer(
      Buffer.from(
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'METHOD:CANCEL',
          'BEGIN:VEVENT',
          'UID:meet42',
          'SUMMARY:test',
          'DTSTART;TZID=America/New_York:20260801T090000',
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n'),
        'utf8',
      ),
    );
    expect(cancel.method).toBe('CANCEL');
    expect(cancel.events).toEqual([]); // never importable
    expect(cancel.cancelledUids).toEqual(['meet42']);
  });

  it('STATUS:CANCELLED surfaces the UID as cancelled inside a REQUEST', () => {
    const mixed = parseIcsBuffer(
      Buffer.from(
        [
          'BEGIN:VCALENDAR',
          'METHOD:REQUEST',
          'BEGIN:VEVENT',
          'UID:dead1',
          'SUMMARY:Old slot',
          'STATUS:CANCELLED',
          'DTSTART;TZID=America/New_York:20260801T090000',
          'END:VEVENT',
          'BEGIN:VEVENT',
          'UID:live1',
          'SUMMARY:New slot',
          'DTSTART;TZID=America/New_York:20260801T110000',
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n'),
        'utf8',
      ),
    );
    expect(mixed.method).toBe('REQUEST');
    expect(mixed.cancelledUids).toEqual(['dead1']);
    expect(mixed.events.map((e) => e.uid)).toEqual(['live1']);
  });
});

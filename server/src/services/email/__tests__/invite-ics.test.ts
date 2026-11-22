/**
 * A .ics attachment is a genuine invitation to answer only when it carries
 * an iTIP transaction method (REQUEST/CANCEL/REPLY/…). PUBLISH — and no
 * METHOD at all — is a plain calendar object senders attach to their own
 * confirmations (Expedia, airlines, venues) so "Add to calendar" works;
 * mistaking it for an invite routes the email around the trip classifier
 * (ADR 0158) and the general magics extractor into a bare create_event.
 */
import { describe, expect, it } from 'vitest';

import { probeResultFromIcs } from '../invite-ics.js';

const ics = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8');

const VEVENT_HEADER = ['BEGIN:VEVENT', 'UID:evt1', 'SUMMARY:Evergreen Lodge at Vail'];
const VEVENT_BODY = ['DTSTART;VALUE=DATE:20270211', 'DTEND;VALUE=DATE:20270215', 'END:VEVENT'];

describe('probeResultFromIcs', () => {
  it('METHOD:PUBLISH (a self-contained itinerary entry) is not an invite, but its event still surfaces (ADR 0177)', () => {
    const result = probeResultFromIcs(
      ics(['BEGIN:VCALENDAR', 'METHOD:PUBLISH', ...VEVENT_HEADER, ...VEVENT_BODY, 'END:VCALENDAR']),
    );
    expect(result.isInvite).toBe(false);
    expect(result.event?.uid).toBe('evt1');
  });

  it('no METHOD line at all is not an invite either, but its event still surfaces', () => {
    const result = probeResultFromIcs(
      ics(['BEGIN:VCALENDAR', ...VEVENT_HEADER, ...VEVENT_BODY, 'END:VCALENDAR']),
    );
    expect(result.isInvite).toBe(false);
    expect(result.event?.uid).toBe('evt1');
  });

  it('METHOD:REQUEST is a real invite', () => {
    const result = probeResultFromIcs(
      ics(['BEGIN:VCALENDAR', 'METHOD:REQUEST', ...VEVENT_HEADER, ...VEVENT_BODY, 'END:VCALENDAR']),
    );
    expect(result.isInvite).toBe(true);
    expect(result.event?.uid).toBe('evt1');
  });

  it('METHOD:CANCEL is a real invite (cancellation) and still surfaces the cancelled UID', () => {
    const result = probeResultFromIcs(
      ics(['BEGIN:VCALENDAR', 'METHOD:CANCEL', ...VEVENT_HEADER, ...VEVENT_BODY, 'END:VCALENDAR']),
    );
    expect(result.isInvite).toBe(true);
    expect(result.cancelledUids).toEqual(['evt1']);
  });

  it('METHOD:REPLY (an "Accepted:" answer) is handled, with no event to stage', () => {
    // Prod 2026-11-10: the user's own acceptance staged a second event for
    // the meeting, and confirming it invited the organizer.
    for (const method of ['REPLY', 'COUNTER', 'DECLINECOUNTER']) {
      const result = probeResultFromIcs(
        ics(['BEGIN:VCALENDAR', `METHOD:${method}`, ...VEVENT_HEADER, ...VEVENT_BODY, 'END:VCALENDAR']),
      );
      expect(result.isInvite).toBe(true);
      expect(result.event).toBeNull();
    }
  });

  it('content with no calendar structure at all (no METHOD, no VEVENT) is not an invite', () => {
    // The underlying ICS parser is lenient — garbage text parses to an empty
    // calendar rather than throwing — so this exercises the normal method
    // check, not the try/catch's own safety net. There's nothing
    // invite-shaped here for the trip/magics pipeline to skip.
    const result = probeResultFromIcs(Buffer.from('not a calendar', 'utf8'));
    expect(result.isInvite).toBe(false);
    expect(result.event).toBeNull();
  });
});

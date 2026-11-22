/**
 * Two-way sync reconciliation core (ADR 0040). Pure-function coverage of the
 * SEQUENCE/LWW merge rules, the organizer-only sequence bump, the <5-min free
 * rule, and chord_uid origin detection — no Google, no DB.
 */
import { describe, expect, it } from 'vitest';

import {
  computeTransparency,
  googleDateTimeToIso,
  googleEventToLocalFields,
  isChordOrigin,
  isoToGoogleDateTime,
  localRowToGoogleBody,
  nextSequenceOnLocalEdit,
  reconcileRemote,
  type GoogleEventResource,
  type LocalCopy,
  type RemoteEvent,
} from '@/services/google/two-way-sync.js';

const T0 = '2026-06-01T10:00:00Z';
const T1 = '2026-06-01T11:00:00Z'; // strictly after T0

function local(over: Partial<LocalCopy> = {}): LocalCopy {
  return {
    sequence: 0,
    updatedAt: T0,
    localDirty: false,
    status: 'confirmed',
    deletedAt: null,
    role: 'organizer',
    ...over,
  };
}

function remote(over: Partial<RemoteEvent> = {}): RemoteEvent {
  return { sequence: 0, updated: T0, status: 'confirmed', ...over };
}

describe('reconcileRemote', () => {
  it('mirrors a remote cancellation as a local delete', () => {
    expect(reconcileRemote(local(), remote({ status: 'cancelled' })).kind).toBe('delete-local');
  });

  it('is a noop when both sides are already cancelled', () => {
    expect(
      reconcileRemote(local({ status: 'cancelled' }), remote({ status: 'cancelled' })).kind,
    ).toBe('noop');
  });

  it('pushes a local tombstone that Google still shows as live', () => {
    expect(reconcileRemote(local({ deletedAt: T0 }), remote()).kind).toBe('push-local');
  });

  it('applies remote when it has a higher sequence and no local edit pending', () => {
    expect(reconcileRemote(local({ sequence: 1 }), remote({ sequence: 2 })).kind).toBe(
      'apply-remote',
    );
  });

  it('applies remote on equal sequence when remote was updated later', () => {
    const a = reconcileRemote(local({ sequence: 3, updatedAt: T0 }), remote({ sequence: 3, updated: T1 }));
    expect(a.kind).toBe('apply-remote');
  });

  it('is a noop when local is clean and not behind', () => {
    expect(
      reconcileRemote(local({ sequence: 3, updatedAt: T1 }), remote({ sequence: 3, updated: T0 })).kind,
    ).toBe('noop');
  });

  it('resolves a two-sided conflict to remote when remote is newer (LWW)', () => {
    const a = reconcileRemote(local({ localDirty: true, updatedAt: T0 }), remote({ updated: T1 }));
    expect(a).toMatchObject({ kind: 'conflict-resolved', winner: 'remote' });
  });

  it('resolves a two-sided conflict to local when local is newer (LWW)', () => {
    const a = reconcileRemote(local({ localDirty: true, updatedAt: T1 }), remote({ updated: T0 }));
    expect(a).toMatchObject({ kind: 'conflict-resolved', winner: 'local' });
  });
});

describe('nextSequenceOnLocalEdit', () => {
  it('bumps the organizer copy', () => {
    expect(nextSequenceOnLocalEdit({ role: 'organizer', sequence: 4 })).toBe(5);
  });

  it('leaves an attendee copy untouched', () => {
    expect(nextSequenceOnLocalEdit({ role: 'attendee', sequence: 4 })).toBe(4);
  });
});

describe('computeTransparency (<=5-min free rule)', () => {
  it('marks a sub-5-minute event free', () => {
    expect(
      computeTransparency({ startsAt: '2026-06-01T10:00:00Z', endsAt: '2026-06-01T10:04:00Z' }),
    ).toBe('transparent');
  });

  // Owner, 2026-10-24: a 5-minute entry is a reminder, not time taken.
  it('marks an exactly-5-minute event free', () => {
    expect(
      computeTransparency({ startsAt: '2026-06-01T10:00:00Z', endsAt: '2026-06-01T10:05:00Z' }),
    ).toBe('transparent');
  });

  it('marks a 6-minute event busy', () => {
    expect(
      computeTransparency({ startsAt: '2026-06-01T10:00:00Z', endsAt: '2026-06-01T10:06:00Z' }),
    ).toBe('opaque');
  });

  it('marks a normal-length event busy', () => {
    expect(
      computeTransparency({ startsAt: '2026-06-01T10:00:00Z', endsAt: '2026-06-01T11:00:00Z' }),
    ).toBe('opaque');
  });

  it('treats a no-end event as blocking (1h block, not free)', () => {
    expect(computeTransparency({ startsAt: '2026-06-01T10:00:00Z' })).toBe('opaque');
  });

  it('marks a 0-duration event free (e.g. a birthday marker)', () => {
    expect(
      computeTransparency({ startsAt: '2026-06-02T09:00:00-04:00', endsAt: '2026-06-02T09:00:00-04:00' }),
    ).toBe('transparent');
  });

  it('treats an all-day event as free', () => {
    expect(
      computeTransparency({ startsAt: '2026-06-01T00:00:00', endsAt: '2026-06-02T00:00:00', allDay: true }),
    ).toBe('transparent');
  });
});

describe('isChordOrigin', () => {
  it('detects our own events by the chord_uid stamp', () => {
    expect(isChordOrigin({ extendedProperties: { private: { chordUid: 'ce_abc' } } })).toBe(true);
  });

  it('treats foreign events without the stamp as not ours', () => {
    expect(isChordOrigin({ extendedProperties: { private: {} } })).toBe(false);
    expect(isChordOrigin({})).toBe(false);
  });
});

describe('google ⇄ local date mapping', () => {
  it('maps a timed event keeping its IANA timezone', () => {
    expect(googleDateTimeToIso({ dateTime: '2026-07-04T18:00:00-04:00', timeZone: 'America/New_York' })).toEqual({
      iso: '2026-07-04T18:00:00-04:00',
      allDay: false,
      tz: 'America/New_York',
    });
  });

  it('maps an all-day event to floating midnight', () => {
    expect(googleDateTimeToIso({ date: '2026-07-01' })).toEqual({
      iso: '2026-07-01T00:00:00',
      allDay: true,
      tz: null,
    });
  });

  it('round-trips all-day back to a Google date', () => {
    expect(isoToGoogleDateTime('2026-07-01T00:00:00', true)).toEqual({ date: '2026-07-01' });
  });

  it('keeps a timed datetime with its tz', () => {
    expect(isoToGoogleDateTime('2026-07-04T18:00:00-04:00', false, 'America/New_York')).toEqual({
      dateTime: '2026-07-04T18:00:00-04:00',
      timeZone: 'America/New_York',
    });
  });

  it('still catches a genuinely floating midnight with no allDay flag', () => {
    expect(isoToGoogleDateTime('2026-07-01T00:00:00', false)).toEqual({ date: '2026-07-01' });
  });

  // Regression: a Resy reservation confirmed in Chord and never reached
  // Google Calendar. `localRowToGoogleBody`'s default-duration fallback
  // computes a missing endsAt via `new Date(...).toISOString()` (always
  // Z-suffixed) — a 7pm-or-later local start plus the 1h default can land
  // exactly on UTC midnight. The old regex treated that Z-suffixed INSTANT
  // the same as a floating date, so `end` silently became `{date}` while
  // `start` stayed `{dateTime}` — Google rejects the mismatch outright
  // ("Start and end times must either both be date or both be dateTime")
  // and the push gave up permanently (ADR 0103), with the event looking
  // "confirmed" in Chord while never existing on the real calendar.
  it('does not mistake a real Z-suffixed midnight instant for a floating date', () => {
    expect(isoToGoogleDateTime('2026-09-23T00:00:00.000Z', false)).toEqual({
      dateTime: '2026-09-23T00:00:00.000Z',
    });
  });

  it('does not mistake an offset-suffixed midnight instant for a floating date', () => {
    expect(isoToGoogleDateTime('2026-06-05T00:00:00-04:00', false)).toEqual({
      dateTime: '2026-06-05T00:00:00-04:00',
    });
  });
});

describe('googleEventToLocalFields', () => {
  it('captures identity, content, and Google transparency verbatim', () => {
    const remote: GoogleEventResource = {
      id: 'g_1',
      iCalUID: 'uid-1@google.com',
      status: 'confirmed',
      summary: '  Dinner  ',
      location: 'Home',
      start: { dateTime: '2026-07-04T18:00:00-04:00' },
      end: { dateTime: '2026-07-04T20:00:00-04:00' },
      sequence: 3,
      etag: '"etag-abc"',
      transparency: 'transparent',
      extendedProperties: { private: { chordUid: 'ce_xyz' } },
    };
    const f = googleEventToLocalFields(remote);
    expect(f).toMatchObject({
      ical_uid: 'uid-1@google.com',
      chord_uid: 'ce_xyz',
      gcal_event_id: 'g_1',
      etag: '"etag-abc"',
      sequence: 3,
      title: 'Dinner',
      all_day: 0,
      status: 'confirmed',
      transparency: 'transparent',
    });
  });

  it('keeps who is on it: organizer and guests, lowercased, once each', () => {
    const f = googleEventToLocalFields({
      id: 'g_3',
      start: { dateTime: '2026-11-12T10:30:00-05:00' },
      organizer: { email: 'Mark.Clark@postoakgroup.co' },
      attendees: [
        { email: 'mark.clark@postoakgroup.co', organizer: true },
        { email: 'john@neuralads.ai' },
        { self: true, responseStatus: 'accepted' },
      ],
    });
    expect(f.guest_emails).toEqual(['mark.clark@postoakgroup.co', 'john@neuralads.ai']);
    expect(googleEventToLocalFields({ id: 'g_4', start: { date: '2026-07-01' } }).guest_emails).toBeNull();
  });

  it('falls back to the event id when there is no iCalUID, defaults untitled, all-day is free', () => {
    const f = googleEventToLocalFields({ id: 'g_2', start: { date: '2026-07-01' } });
    expect(f.ical_uid).toBe('g_2');
    expect(f.chord_uid).toBeNull();
    expect(f.title).toBe('(untitled)');
    expect(f.all_day).toBe(1);
    expect(f.transparency).toBe('transparent'); // ADR 0040 — all-day = free
  });
});

describe('localRowToGoogleBody', () => {
  it('stamps chord_uid and applies the <5-min free rule', () => {
    const body = localRowToGoogleBody({
      title: 'Quick check-in',
      starts_at: '2026-07-04T18:00:00-04:00',
      ends_at: '2026-07-04T18:03:00-04:00', // 3 min -> free
      all_day: 0,
      sequence: 2,
      chord_uid: 'ce_abc',
    });
    expect(body.summary).toBe('Quick check-in');
    expect(body.transparency).toBe('transparent');
    expect(body.sequence).toBe(2);
    expect(body.extendedProperties).toEqual({ private: { chordUid: 'ce_abc' } });
  });

  it('omits the stamp when there is no chord_uid (foreign-origin edit)', () => {
    const body = localRowToGoogleBody({
      title: 'Meeting',
      starts_at: '2026-07-04T18:00:00-04:00',
      ends_at: '2026-07-04T19:00:00-04:00',
      all_day: 0,
    });
    expect(body.transparency).toBe('opaque');
    expect(body.extendedProperties).toBeUndefined();
  });

  it('pushes a no-end event as a 1-hour block (not 0-duration) so it round-trips as blocking', () => {
    const start = '2026-06-02T09:00:00-04:00';
    const body = localRowToGoogleBody({ title: 'Meet Nona', starts_at: start });
    expect(body.transparency).toBe('opaque'); // no-end blocks
    const expectedEnd = new Date(Date.parse(start) + 60 * 60 * 1000).toISOString();
    expect((body.end as { dateTime?: string }).dateTime).toBe(expectedEnd);
  });

  // Regression (prod, Resy "Dinner at Veerays" reservation): a no-end event
  // starting 7pm Eastern lands its computed 1h-default end at exactly UTC
  // midnight — the old isoToGoogleDateTime treated that as a floating
  // all-day date, so `end` became `{date}` while `start` stayed `{dateTime}`
  // and Google's events.insert rejected the whole body. Both must resolve
  // to the SAME shape.
  it('keeps start and end the same shape even when the computed end lands on UTC midnight', () => {
    const body = localRowToGoogleBody({
      title: 'Dinner at Veerays',
      starts_at: '2026-09-22T19:00:00-04:00',
      location: 'Veerays, 213 E 45th St, New York, NY 10017',
    });
    expect(body.start).toEqual({ dateTime: '2026-09-22T19:00:00-04:00' });
    expect(body.end).toEqual({ dateTime: '2026-09-23T00:00:00.000Z' });
  });

  // ADR 0295 — guests live on the provider event; the push never sends them,
  // so a patch leaves the provider's list as it is.
  it('never carries an attendees array', () => {
    const base = { title: 'Sync', starts_at: '2026-07-04T18:00:00-04:00', all_day: 0 };
    expect(localRowToGoogleBody(base)).not.toHaveProperty('attendees');
  });
});

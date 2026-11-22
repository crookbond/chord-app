/**
 * ADR 0346 - a conflict is different people at the same time; the same
 * meeting is the same meeting even when an assistant dropped off or the
 * organizer added a colleague.
 */
import { describe, expect, it } from 'vitest';

import { meetingRelation, type CalendarSide, type MeetingSide } from '@chord/kernel';

const H = 3600_000;
const T0 = Date.parse('2026-11-18T15:00:00Z'); // 10:00 New York
const ME = 'john@example.com';
const opts = { self: [ME, 'JOHN@work.example'] };

const meeting = (over: Partial<MeetingSide> = {}): MeetingSide => ({
  startMs: T0,
  endMs: T0 + H,
  title: 'Intro with Rob',
  people: ['rob@acme.com', 'ana.assistant@acme.com', ME],
  ...over,
});
const event = (over: Partial<CalendarSide> = {}): CalendarSide => ({
  id: 'e1',
  startMs: T0,
  endMs: T0 + H,
  title: 'Something',
  people: [],
  ...over,
});

describe('meetingRelation', () => {
  it('the same people at the same time is the same meeting, whatever the titles', () => {
    expect(meetingRelation(meeting(), event({ title: 'Acme / Neural sync', people: ['rob@acme.com', ME] }), opts)).toBe(
      'same',
    );
  });

  it('their invite with the assistant dropped and a colleague added is still the same meeting', () => {
    const invite = event({ title: 'Rob <> John', people: ['rob@acme.com', 'cfo@acme.com', ME] });
    expect(meetingRelation(meeting({ people: ['rob@acme.com', ME] }), invite, opts)).toBe('same');
  });

  it('the same invite UID or the same email thread is the same meeting at any time', () => {
    expect(meetingRelation(meeting({ uids: ['ABC@google.com'] }), event({ startMs: T0 + 5 * H, endMs: T0 + 6 * H, uids: ['abc@google.com'] }), opts)).toBe('same');
    expect(meetingRelation(meeting({ threadKey: 'gmail:t1' }), event({ threadKey: 'gmail:t1', startMs: T0 + 9 * H, endMs: T0 + 10 * H }), opts)).toBe('same');
  });

  it('a lunch with other people inside the slot is a conflict', () => {
    // The recording: Rob offered 10-1; John had a 12:00-12:50 meeting.
    const lunch = event({ title: 'Lunch meeting', startMs: T0 + 2 * H, endMs: T0 + 2 * H + 50 * 60_000, people: ['sam@other.org', ME] });
    expect(meetingRelation(meeting({ endMs: T0 + 3 * H }), lunch, opts)).toBe('conflict');
  });

  it('back to back is not an overlap', () => {
    expect(meetingRelation(meeting(), event({ startMs: T0 + H, endMs: T0 + 2 * H, people: ['sam@other.org'] }), opts)).toBe('none');
  });

  it('a pre-meeting with part of the team running into the start is related, not a conflict', () => {
    const team = ['rob@acme.com', 'lee@neural.ai', 'kim@neural.ai', ME];
    const prep = event({ title: 'Team sync', startMs: T0 - 30 * 60_000, endMs: T0 + 15 * 60_000, people: ['lee@neural.ai', ME] });
    expect(meetingRelation(meeting({ people: team }), prep, opts)).toBe('related');
    const titled = event({ title: 'Prep for Acme', startMs: T0 - 30 * 60_000, endMs: T0 + 10 * 60_000, people: ['zed@neural.ai'] });
    expect(meetingRelation(meeting({ people: team }), titled, opts)).toBe('related');
  });

  it('a prep that covers the whole meeting is not a prep', () => {
    const team = ['rob@acme.com', 'lee@neural.ai', ME];
    const all = event({ title: 'Team sync', startMs: T0 - 30 * 60_000, endMs: T0 + 2 * H, people: ['lee@neural.ai', 'kim@neural.ai'] });
    expect(meetingRelation(meeting({ people: team }), all, opts)).toBe('unsure');
  });

  it('a block of your own with no guests is asked about, not assumed', () => {
    expect(meetingRelation(meeting(), event({ title: 'Gym', people: [] }), opts)).toBe('personal_block');
    // A guestless event the user made for this meeting reads as the same one.
    expect(meetingRelation(meeting(), event({ title: 'Call with Rob', people: [] }), opts)).toBe('same');
  });

  it('only the user on an event is no guests: their own addresses never count', () => {
    expect(meetingRelation(meeting(), event({ title: 'Focus', people: [ME, 'john@work.example'] }), opts)).toBe(
      'personal_block',
    );
  });

  it('one shared person at a partly overlapping time is a question', () => {
    const other = event({ title: 'Budget', startMs: T0 + 20 * 60_000, endMs: T0 + 80 * 60_000, people: ['rob@acme.com', 'x@y.com', 'z@y.com'] });
    expect(meetingRelation(meeting({ people: ['rob@acme.com', 'q@acme.com', 'r@acme.com'] }), other, opts)).toBe('unsure');
  });

  it('robots and rooms are nobody', () => {
    const room = event({ title: 'Board review', people: ['b1@resource.calendar.google.com', 'noreply@acme.com'] });
    expect(meetingRelation(meeting(), room, opts)).toBe('personal_block');
  });
});

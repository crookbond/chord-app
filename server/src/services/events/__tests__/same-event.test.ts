import { describe, expect, it } from 'vitest';

import {
  isSameEvent,
  mergeDescriptions,
  mergeEventDetails,
  removePassenger,
  samePeople,
} from '../same-event.js';

const at = '2026-11-20T21:30:00-05:00';
const end = '2026-11-21T22:15:00+05:30';

describe('same time, same people (prod 2026-11-10)', () => {
  // Mark's invite as pulled from Outlook, and the card Chord staged for it.
  const marksInvite = {
    title: 'Follow up: Neural Ads/ Post Oak Group',
    startsAt: '2026-11-12T10:30:00-05:00',
    endsAt: '2026-11-12T11:00:00-05:00',
    location: 'Google Meet (instructions in description)',
    googleCalendarId: 'outlook:ema_x:cal',
    guestEmails: ['mark.clark@postoakgroup.co', 'john@neuralads.ai'],
  };
  const chordCard = {
    title: 'Introductory Meeting with Mark Clark',
    startsAt: '2026-11-12T15:30:00Z',
    endsAt: '2026-11-12T16:00:00Z',
    guestEmails: ['Mark.Clark@postoakgroup.co'],
  };

  it('is one meeting whatever each calls it', () => {
    expect(isSameEvent(marksInvite, chordCard)).toBe(true);
    expect(isSameEvent(chordCard, marksInvite)).toBe(true);
  });

  it('holds across calendars too', () => {
    expect(isSameEvent(marksInvite, { ...chordCard, googleCalendarId: 'family@group.calendar.google.com' })).toBe(true);
  });

  it('someone else on the card is a different meeting', () => {
    expect(isSameEvent(marksInvite, { ...chordCard, guestEmails: ['someone@else.example'] })).toBe(false);
  });

  it('a different time is a different meeting', () => {
    expect(isSameEvent(marksInvite, { ...chordCard, startsAt: '2026-11-12T16:30:00Z', endsAt: '2026-11-12T17:00:00Z' })).toBe(false);
  });

  it('with nobody on one side, the titles still decide', () => {
    expect(samePeople(marksInvite.guestEmails, [])).toBe(false);
    expect(isSameEvent(marksInvite, { ...chordCard, guestEmails: null })).toBe(false);
  });
});

describe('isSameEvent', () => {
  it('two differently worded emails about one flight are one event', () => {
    expect(
      isSameEvent(
        { title: 'AI 102 JFK→DEL', startsAt: at, endsAt: end, isTravelLeg: true },
        { title: 'Flight to Delhi', startsAt: at, endsAt: end },
      ),
    ).toBe(true);
  });

  it('compares instants, not how the time was written', () => {
    expect(
      isSameEvent(
        { title: 'Air India flight to Delhi', startsAt: '2026-11-21T02:30:00Z' },
        { title: 'AI102 flight', startsAt: at },
      ),
    ).toBe(true);
  });

  it('a different flight number at the same time is a different flight', () => {
    expect(
      isSameEvent(
        { title: 'AI 102 JFK→DEL', startsAt: at, endsAt: end },
        { title: 'UA 82 EWR→DEL', startsAt: at, endsAt: end },
      ),
    ).toBe(false);
  });

  it('a different route at the same time is a different flight', () => {
    expect(
      isSameEvent(
        { title: 'Flight JFK→DEL', startsAt: at },
        { title: 'Flight JFK→BOM', startsAt: at },
      ),
    ).toBe(false);
  });

  it('a moved flight is not the same event', () => {
    expect(
      isSameEvent(
        { title: 'AI 102 JFK→DEL', startsAt: at },
        { title: 'AI 102 JFK→DEL', startsAt: '2026-11-20T22:10:00-05:00' },
      ),
    ).toBe(false);
  });

  it('a different end time is not the same event', () => {
    expect(
      isSameEvent(
        { title: 'Dentist', startsAt: at, endsAt: '2026-11-20T22:00:00-05:00' },
        { title: 'Dentist', startsAt: at, endsAt: '2026-11-20T23:00:00-05:00' },
      ),
    ).toBe(false);
  });

  it('two explicitly different calendars are not the same event', () => {
    expect(
      isSameEvent(
        { title: 'Dentist', startsAt: at, googleCalendarId: 'family@group.calendar.google.com' },
        { title: 'Dentist', startsAt: at, googleCalendarId: 'work@example.com' },
      ),
    ).toBe(false);
    expect(
      isSameEvent(
        { title: 'Dentist', startsAt: at, googleCalendarId: 'primary' },
        { title: 'Dentist', startsAt: at, googleCalendarId: 'work@example.com' },
      ),
    ).toBe(true);
  });

  it('ordinary events need most of their words in common', () => {
    expect(
      isSameEvent(
        { title: 'Parent-teacher conference', startsAt: at },
        { title: 'Conference with teacher (parent)', startsAt: at },
      ),
    ).toBe(true);
    expect(
      isSameEvent({ title: 'Soccer practice', startsAt: at }, { title: 'Piano lesson', startsAt: at }),
    ).toBe(false);
  });

  it('the same title in two different places is two events', () => {
    expect(
      isSameEvent(
        { title: 'Team dinner', startsAt: at, location: 'Carbone' },
        { title: 'Team dinner', startsAt: at, location: 'Via Carota' },
      ),
    ).toBe(false);
  });

  it("a child's flight matches the parent's event for the same flight", () => {
    expect(
      isSameEvent(
        { title: 'Maya — AI 102 JFK→DEL', startsAt: at, endsAt: end },
        { title: 'AI 102 JFK→DEL', startsAt: at, endsAt: end },
      ),
    ).toBe(true);
  });
});

describe('merging details', () => {
  it('two itineraries on one flight: each passenger keeps their own confirmation', () => {
    expect(
      mergeDescriptions(
        'Passenger: STONE SIMON MR · Confirmation: 6XK2PQ\n• Itinerary 73541634338201\n• Open in Gmail: https://mail.example/a',
        'Passenger: STONE ALICE MS · Confirmation: 9ZZ4TT\n• Itinerary 73541634338999\n• Open in Gmail: https://mail.example/b',
      ),
    ).toBe(
      'Passenger: STONE SIMON MR · Confirmation: 6XK2PQ\n' +
        '• Itinerary 73541634338201\n' +
        '• Open in Gmail: https://mail.example/a\n' +
        'Passenger: STONE ALICE MS · Confirmation: 9ZZ4TT\n' +
        '• Itinerary 73541634338999\n' +
        '• Open in Gmail: https://mail.example/b',
    );
  });

  it("a second email about one passenger adds to that passenger's block only", () => {
    expect(
      mergeDescriptions(
        'Passenger: A One · Confirmation: 111AAA\n• Itinerary 1\nPassenger: B Two\nGate closes 40 min before',
        'Passenger: b two · Confirmation: 222BBB\n• Itinerary 2\n• Itinerary 2',
      ),
    ).toBe(
      'Passenger: A One · Confirmation: 111AAA\n• Itinerary 1\n' +
        'Passenger: B Two · Confirmation: 222BBB\n• Itinerary 2\n' +
        'Gate closes 40 min before',
    );
  });

  it('does not list one passenger twice, and learns a confirmation it lacked', () => {
    expect(
      mergeDescriptions('Passenger: John Doe', 'Passenger: john doe · Confirmation: 6XK2PQ'),
    ).toBe('Passenger: John Doe · Confirmation: 6XK2PQ');
  });

  it('reads the older comma list and does not repeat a confirmation bare', () => {
    expect(
      mergeDescriptions(
        'Passengers: John Doe, Alice Stone\nConfirmation: 6XK2PQ',
        'Passenger: John Doe · Confirmation: 6XK2PQ',
      ),
    ).toBe('Passenger: John Doe · Confirmation: 6XK2PQ\nPassenger: Alice Stone');
  });

  it('takes one passenger off without touching the other', () => {
    expect(
      removePassenger(
        'Passenger: A One · Confirmation: 111AAA\n• Itinerary 1\nPassenger: B Two · Confirmation: 222BBB\n• Itinerary 2\nGate closes 40 min before',
        'b two',
      ),
    ).toBe('Passenger: A One · Confirmation: 111AAA\n• Itinerary 1\nGate closes 40 min before');
  });

  it('fills what is missing and reports nothing when nothing is new', () => {
    const existing = { title: 'Flight to Delhi', startsAt: at };
    expect(
      mergeEventDetails(existing, {
        title: 'AI 102 JFK→DEL',
        startsAt: at,
        endsAt: end,
        location: 'JFK → DEL',
        description: 'Confirmation: 6XK2PQ',
      }),
    ).toEqual({
      title: 'AI 102 JFK→DEL',
      endsAt: end,
      location: 'JFK → DEL',
      description: 'Confirmation: 6XK2PQ',
    });
    const full = { title: 'AI 102 JFK→DEL', startsAt: at, endsAt: end, location: 'JFK → DEL' };
    expect(mergeEventDetails(full, { title: 'Flight to Delhi', startsAt: at })).toBeNull();
  });

  it('never overwrites a detail that is already there', () => {
    const patch = mergeEventDetails(
      { title: 'Dentist', startsAt: at, location: '12 Main St' },
      { title: 'Dentist appointment', startsAt: at, location: 'Main Street Dental' },
    );
    expect(patch).toBeNull();
  });
});

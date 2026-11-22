/**
 * Which calendar gets a video call by default, which kind, and what counts as
 * asking for one (kernel/src/video-call.ts, ADR 0319/0323).
 */
import { describe, expect, it } from 'vitest';

import {
  canAddVideoCall,
  looksLikeVideoCallRequest,
  videoCallDefaultFor,
  videoCallKindNamed,
  videoCallLabel,
} from '@chord/kernel';

describe('videoCallDefaultFor', () => {
  it('gives the login Google account its own calendars a Meet', () => {
    expect(videoCallDefaultFor({ calendarId: 'primary' })).toBe('google_meet');
    expect(videoCallDefaultFor({ calendarId: 'family@group.calendar.google.com' })).toBe('google_meet');
    expect(videoCallDefaultFor({ calendarId: 'primary', provider: 'google' })).toBe('google_meet');
  });

  it("gives an attached Gmail's calendar a Meet (ADR 0313)", () => {
    expect(videoCallDefaultFor({ calendarId: 'gacct:acct_1:primary' })).toBe('google_meet');
    expect(
      videoCallDefaultFor({ calendarId: 'gacct:acct_1:work@group.calendar.google.com', provider: 'google' }),
    ).toBe('google_meet');
  });

  // ADR 0323 flipped this: an Outlook / 365 calendar used to get no default
  // because Chord could not make a Teams meeting. It can, so it does — and
  // still never a Meet, which is the half ADR 0319 decided.
  it('gives an Outlook / 365 calendar a Teams meeting, and never a Meet', () => {
    expect(videoCallDefaultFor({ calendarId: 'outlook:acct_2:AAMkAD' })).toBe('teams');
    expect(videoCallDefaultFor({ calendarId: 'outlook:acct_2:AAMkAD', provider: 'outlook' })).toBe('teams');
    // A bare id on a row Chord knows is Outlook is still Outlook.
    expect(videoCallDefaultFor({ calendarId: 'AAMkAD', provider: 'outlook' })).toBe('teams');
  });

  it('gives a phone-mirrored calendar no default', () => {
    expect(
      videoCallDefaultFor({ calendarId: 'BEE3A1B0-0000-0000-0000-000000000001', provider: 'device' }),
    ).toBeNull();
  });

  it('gives no default when there is no calendar (an IMAP mailbox, a Chord-only event)', () => {
    expect(videoCallDefaultFor({ calendarId: null })).toBeNull();
    expect(videoCallDefaultFor({ calendarId: '   ' })).toBeNull();
    expect(videoCallDefaultFor({})).toBeNull();
  });

  it('gives no default to a provider key added since this was written', () => {
    expect(videoCallDefaultFor({ calendarId: 'caldav:acct_3:cal' })).toBeNull();
  });

  it('canAddVideoCall follows the same rule', () => {
    expect(canAddVideoCall({ calendarId: 'primary' })).toBe(true);
    expect(canAddVideoCall({ calendarId: 'outlook:a:b' })).toBe(true);
    expect(canAddVideoCall({ calendarId: 'x', provider: 'device' })).toBe(false);
    expect(canAddVideoCall({ calendarId: 'caldav:a:b' })).toBe(false);
    expect(canAddVideoCall({ calendarId: null })).toBe(false);
  });

  // A phone-mirrored Outlook calendar is read, not written: the provider the
  // caller knows wins over what the key looks like, both ways.
  it('a device provider beats an outlook-shaped key', () => {
    expect(videoCallDefaultFor({ calendarId: 'outlook:a:b', provider: 'device' })).toBeNull();
  });
});

describe('videoCallLabel', () => {
  it('names each kind the way its own provider does', () => {
    expect(videoCallLabel('google_meet')).toBe('Google Meet');
    expect(videoCallLabel('teams')).toBe('Teams meeting');
  });
});

describe('looksLikeVideoCallRequest', () => {
  it('reads a real request', () => {
    for (const text of [
      'add a google meet',
      'can you put a video call link on it',
      'make it a zoom',
      'send a teams link',
      'add the dial-in',
      'make it virtual please',
      'we will do it remotely',
      'meet over video',
      'add a meeting link',
      'set up a video conference',
      'hangout with Karl at 4',
    ]) {
      expect(looksLikeVideoCallRequest(text), text).toBe(true);
    }
  });

  it('does not read an ordinary meeting as one', () => {
    for (const text of [
      'set up a meeting with Sarah tomorrow at 3',
      'add dinner with the Does on Friday',
      'book a call with Bill at 9am',
      "let's meet at the cafe",
      'put the school concert on the calendar',
    ]) {
      expect(looksLikeVideoCallRequest(text), text).toBe(false);
    }
  });
});

describe('the kind the words named', () => {
  it.each([
    ['add to Neural Calendar - Call with Gautam @ A91 at 830a. Teams meeting.', 'teams'],
    ['call with Sam on MS Teams', 'teams'],
    ['set up a Google Meet with Sam', 'google_meet'],
    ['add a video call', null],
    ['zoom with Sam at 3', null],
  ])('%s', (text, want) => {
    expect(videoCallKindNamed(text)).toBe(want);
  });

  it('"on Teams" asks for a call', () => {
    expect(looksLikeVideoCallRequest('chat with Sam on Teams at 3')).toBe(true);
    expect(looksLikeVideoCallRequest('Teams meeting.')).toBe(true);
  });
});

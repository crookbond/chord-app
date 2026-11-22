/**
 * Who may be auto-replied to (ADR 0124). RFC 3834 is mostly a list of things
 * an auto-responder must NOT answer, because each one is a way to start a loop
 * or to tell a mailing list about your holiday.
 */
import { describe, expect, it } from 'vitest';

import { autoReplySkipReason, autoReplySubject, vacationActive } from '@chord/kernel';

const ctx = { myEmails: ['me@example.com'], repliedSenders: new Set<string>() };
const human = {
  fromEmail: 'friend@example.com',
  toEmails: ['me@example.com'],
};

describe('autoReplySkipReason', () => {
  it('answers ordinary mail addressed to me', () => {
    expect(autoReplySkipReason(human, ctx)).toBeNull();
  });

  it('never answers something already automatic', () => {
    // The loop this prevents is two responders talking to each other forever.
    expect(autoReplySkipReason({ ...human, autoSubmitted: 'auto-replied' }, ctx)).toBe(
      'auto_submitted',
    );
    // Only an explicit "no" clears it; absence is the normal case for human mail.
    expect(autoReplySkipReason({ ...human, autoSubmitted: 'no' }, ctx)).toBeNull();
  });

  it('never answers a mailing list', () => {
    expect(autoReplySkipReason({ ...human, precedence: 'bulk' }, ctx)).toBe('bulk');
    expect(autoReplySkipReason({ ...human, listUnsubscribe: '<mailto:u@l.example>' }, ctx)).toBe(
      'bulk',
    );
    expect(autoReplySkipReason({ ...human, bulk: true }, ctx)).toBe('bulk');
  });

  it('never answers an address no human reads', () => {
    for (const from of [
      'no-reply@shop.example',
      'noreply@shop.example',
      'do-not-reply@shop.example',
      'MAILER-DAEMON@mail.example',
    ]) {
      expect(autoReplySkipReason({ ...human, fromEmail: from }, ctx)).toBe('no_reply_address');
    }
  });

  it('never answers mail that was not addressed to me', () => {
    // Arrived via a list or a bcc: answering tells a room of strangers.
    expect(
      autoReplySkipReason({ ...human, toEmails: ['someone-else@example.com'] }, ctx),
    ).toBe('not_addressed_to_me');
  });

  it('answers mail where I am only on cc', () => {
    expect(
      autoReplySkipReason(
        { fromEmail: 'friend@example.com', toEmails: ['x@example.com'], ccEmails: ['me@example.com'] },
        ctx,
      ),
    ).toBeNull();
  });

  it('answers when the provider gave us no recipients at all', () => {
    // Absence of evidence is not evidence of a bcc.
    expect(autoReplySkipReason({ fromEmail: 'friend@example.com' }, ctx)).toBeNull();
  });

  it('never answers myself', () => {
    expect(autoReplySkipReason({ ...human, fromEmail: 'ME@example.com' }, ctx)).toBe('self');
  });

  it('answers a given sender once per holiday', () => {
    const seen = { myEmails: ctx.myEmails, repliedSenders: new Set(['friend@example.com']) };

    expect(autoReplySkipReason(human, seen)).toBe('already_replied');
  });

  it('refuses a message with no usable sender', () => {
    expect(autoReplySkipReason({ fromEmail: null }, ctx)).toBe('no_sender');
    expect(autoReplySkipReason({ fromEmail: 'garbage' }, ctx)).toBe('no_sender');
  });
});

describe('vacationActive', () => {
  const now = '2026-08-25T12:00:00.000Z';

  it('is off when disabled, whatever the dates say', () => {
    expect(vacationActive({ enabled: false, startsAt: null, endsAt: null }, now)).toBe(false);
  });

  it('runs until turned off when no dates are given', () => {
    expect(vacationActive({ enabled: true }, now)).toBe(true);
  });

  it('respects a window', () => {
    expect(
      vacationActive({ enabled: true, startsAt: '2026-08-26T00:00:00.000Z' }, now),
    ).toBe(false);
    expect(vacationActive({ enabled: true, endsAt: '2026-08-24T00:00:00.000Z' }, now)).toBe(false);
    expect(
      vacationActive(
        { enabled: true, startsAt: '2026-08-24T00:00:00.000Z', endsAt: '2026-08-30T00:00:00.000Z' },
        now,
      ),
    ).toBe(true);
  });
});

describe('autoReplySubject', () => {
  it('adds one Re:, however many the sender stacked up', () => {
    expect(autoReplySubject('Re: Re: Fwd: dinner')).toBe('Re: dinner');
    expect(autoReplySubject('dinner')).toBe('Re: dinner');
  });

  it('copes with no subject', () => {
    expect(autoReplySubject(null)).toBe('Re: your message');
  });
});

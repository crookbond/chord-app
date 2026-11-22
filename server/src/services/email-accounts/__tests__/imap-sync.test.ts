import { describe, expect, it } from 'vitest';

import {
  firstReference,
  imapFlagsToLabels,
  imapLocationFromNativeMessageId,
  imapNativeMessageId,
  imapSentNativeMessageId,
  imapThreadNativeId,
  normalizeSubject,
  parseImapCursor,
  uidFromNativeMessageId,
} from '@/services/email-accounts/imap-sync.js';

describe('imap-sync pure helpers', () => {
  it('normalizes subjects across Re/Fwd chains', () => {
    expect(normalizeSubject('Re: RE: Fwd: Picture   day')).toBe('picture day');
    expect(normalizeSubject('  AW: hello ')).toBe('hello');
    expect(normalizeSubject(null)).toBe('');
  });

  it('roots a thread on the References chain', () => {
    const root = imapThreadNativeId({
      messageId: '<a@x>',
      inReplyTo: null,
      references: null,
      subject: 'Trip',
      fromEmail: 'a@x.com',
    });
    const reply = imapThreadNativeId({
      messageId: '<b@x>',
      inReplyTo: '<a@x>',
      references: '<a@x>',
      subject: 'Re: Trip',
      fromEmail: 'b@x.com',
    });
    const deepReply = imapThreadNativeId({
      messageId: '<c@x>',
      inReplyTo: '<b@x>',
      references: '<a@x> <b@x>',
      subject: 'Re: Re: Trip',
      fromEmail: 'a@x.com',
    });
    expect(reply).toBe(root);
    expect(deepReply).toBe(root);
  });

  it('falls back to normalized subject when headers are absent', () => {
    const a = imapThreadNativeId({
      messageId: null,
      inReplyTo: null,
      references: null,
      subject: 'Re: Lunch Friday',
      fromEmail: 'x@y.com',
    });
    expect(a).toBe('subj:lunch friday');
  });

  it('round-trips uid native ids and rejects synthesized ones', () => {
    expect(uidFromNativeMessageId(imapNativeMessageId(42))).toBe(42);
    expect(uidFromNativeMessageId('sent-abc')).toBeNull();
  });

  it('tells an INBOX UID from a Sent UID, since the two number spaces overlap', () => {
    expect(imapLocationFromNativeMessageId(imapNativeMessageId(7))).toEqual({ folder: 'inbox', uid: 7 });
    expect(imapLocationFromNativeMessageId(imapSentNativeMessageId(7))).toEqual({ folder: 'sent', uid: 7 });
    expect(uidFromNativeMessageId(imapSentNativeMessageId(7))).toBeNull();
    expect(imapLocationFromNativeMessageId('sent-abc')).toBeNull();
  });

  it('maps flags to the synthesized label set', () => {
    expect(imapFlagsToLabels([])).toEqual(['INBOX', 'UNREAD']);
    expect(imapFlagsToLabels(['\\Seen'])).toEqual(['INBOX']);
    expect(imapFlagsToLabels(['\\Seen'], { inInbox: false })).toEqual([]);
  });

  it('parses cursors defensively', () => {
    expect(parseImapCursor(JSON.stringify({ uidValidity: '7', lastUid: 12 }))).toEqual({
      uidValidity: '7',
      lastUid: 12,
    });
    expect(parseImapCursor('garbage')).toBeNull();
    expect(parseImapCursor(null)).toBeNull();
  });

  it('extracts the first reference token', () => {
    expect(firstReference('<a@x> <b@x>')).toBe('<a@x>');
    expect(firstReference('')).toBeNull();
  });
});

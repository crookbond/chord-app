/**
 * Who a thread is "from" when nobody says (ADR 0060 / 0108).
 *
 * A thread's sender is not stored by anyone: it is derived from the newest
 * message, and each message's sender is parsed out of a raw header that may be
 * missing, bare, quoted, or several addresses long. Search, the list, the
 * autocomplete and the bulk gate all read that derived value, so its edge
 * cases are pinned here. No DB, no Google.
 */
import { describe, expect, it } from 'vitest';

import {
  aggregateThread,
  parseAddress,
  parseAddressList,
  type ThreadMessageView,
} from '../gmail-sync.js';

describe('parseAddress: a header that is missing or degenerate', () => {
  it('returns nothing for a missing header', () => {
    expect(parseAddress(undefined)).toEqual({ name: null, email: null });
    expect(parseAddress('')).toEqual({ name: null, email: null });
  });

  it('returns nothing for whitespace', () => {
    expect(parseAddress('   ')).toEqual({ name: null, email: null });
  });

  it('keeps a name that has no address, with a null email', () => {
    expect(parseAddress('Ms Chen')).toEqual({ name: 'Ms Chen', email: null });
  });
});

describe('parseAddress: address-only forms', () => {
  it('reads <addr> with no display name as a null name', () => {
    expect(parseAddress('<chen@school.example>')).toEqual({
      name: null,
      email: 'chen@school.example',
    });
  });

  it('treats an empty quoted name as no name', () => {
    expect(parseAddress('"" <chen@school.example>')).toEqual({
      name: null,
      email: 'chen@school.example',
    });
  });

  it('lowercases and trims the address', () => {
    expect(parseAddress('  Chen <  CHEN@School.Example >  ')).toEqual({
      name: 'Chen',
      email: 'chen@school.example',
    });
  });

  it('keeps a display name that contains punctuation and non-ascii letters', () => {
    expect(parseAddress('"Núñez, José" <jose@x.example>')).toEqual({
      name: 'Núñez, José',
      email: 'jose@x.example',
    });
  });

  it('does not decode an RFC 2047 encoded-word: the raw form is the name', () => {
    // Pinned as a known limit. The provider normally hands us decoded headers,
    // but a raw one reaches search and the list exactly as written.
    expect(parseAddress('=?UTF-8?Q?Jos=C3=A9?= <jose@x.example>')).toEqual({
      name: '=?UTF-8?Q?Jos=C3=A9?=',
      email: 'jose@x.example',
    });
  });
});

describe('parseAddress: a From header with more than one address', () => {
  it('keeps only the last address and lets the name absorb the rest', () => {
    // Pinned. A From with several mailboxes is rare (RFC 5322 allows it), and
    // the reader gets one sender either way; what matters is that the address
    // is a real one and never the whole header.
    const p = parseAddress('A <a@x.example>, B <b@x.example>');
    expect(p.email).toBe('b@x.example');
    expect(p.name).toBe('A <a@x.example>, B');
  });
});

describe('parseAddressList', () => {
  it('is empty for a missing header', () => {
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList('')).toEqual([]);
  });

  it('drops entries that have no address', () => {
    expect(parseAddressList('Undisclosed recipients, a@x.example')).toEqual(['a@x.example']);
  });

  it('survives a quoted comma inside a display name', () => {
    expect(parseAddressList('"Doe, John" <j@x.example>, b@y.example')).toEqual([
      'j@x.example',
      'b@y.example',
    ]);
  });

  it('lowercases every address', () => {
    expect(parseAddressList('A <A@X.EXAMPLE>, B@Y.EXAMPLE')).toEqual([
      'a@x.example',
      'b@y.example',
    ]);
  });
});

describe('aggregateThread: the thread sender is the newest message sender', () => {
  const view = (over: Partial<ThreadMessageView>): ThreadMessageView => ({
    internalDate: '2026-09-01T10:00:00.000Z',
    subject: 'Permission slip',
    snippet: 'snip',
    fromName: 'Ms Chen',
    fromEmail: 'chen@school.example',
    labelIds: ['INBOX'],
    isUnread: false,
    ...over,
  });

  it('takes the name AND address from the newest message', () => {
    const agg = aggregateThread([
      view({ internalDate: '2026-09-01T10:00:00.000Z', fromName: 'Ms Chen', fromEmail: 'chen@school.example' }),
      view({ internalDate: '2026-09-02T10:00:00.000Z', fromName: 'Office', fromEmail: 'office@school.example' }),
    ]);
    expect(agg.fromName).toBe('Office');
    expect(agg.fromEmail).toBe('office@school.example');
  });

  it('does not depend on the order the messages arrive in', () => {
    const older = view({ internalDate: '2026-09-01T10:00:00.000Z', fromEmail: 'chen@school.example' });
    const newer = view({ internalDate: '2026-09-02T10:00:00.000Z', fromEmail: 'office@school.example' });
    expect(aggregateThread([newer, older]).fromEmail).toBe('office@school.example');
    expect(aggregateThread([older, newer]).fromEmail).toBe('office@school.example');
  });

  it('when the newest message is one the user sent, the thread is "from" the user', () => {
    // The sent copy mirrors with no display name. There is no fallback to the
    // last inbound sender, so a plain search for the person's name still finds
    // the thread only because their earlier messages are searched too.
    const agg = aggregateThread([
      view({ internalDate: '2026-09-01T10:00:00.000Z', fromName: 'Ms Chen', fromEmail: 'chen@school.example' }),
      view({
        internalDate: '2026-09-02T10:00:00.000Z',
        fromName: null,
        fromEmail: 'me@family.example',
        labelIds: ['SENT'],
      }),
    ]);
    expect(agg.fromName).toBeNull();
    expect(agg.fromEmail).toBe('me@family.example');
  });

  it('keeps an empty-string name as empty rather than coercing it to null', () => {
    const agg = aggregateThread([view({ fromName: '', fromEmail: 'chen@school.example' })]);
    expect(agg.fromName).toBe('');
    expect(agg.fromEmail).toBe('chen@school.example');
  });

  it('on a date tie, the message listed last wins', () => {
    const t = '2026-09-02T10:00:00.000Z';
    const agg = aggregateThread([
      view({ internalDate: t, fromEmail: 'first@x.example' }),
      view({ internalDate: t, fromEmail: 'second@x.example' }),
    ]);
    expect(agg.fromEmail).toBe('second@x.example');
  });

  it('has no sender for a thread with no messages', () => {
    const agg = aggregateThread([]);
    expect(agg.fromName).toBeNull();
    expect(agg.fromEmail).toBeNull();
  });

  it('a message with no sender yields a null sender, not a stale one', () => {
    const agg = aggregateThread([
      view({ internalDate: '2026-09-01T10:00:00.000Z', fromName: 'Ms Chen', fromEmail: 'chen@school.example' }),
      view({ internalDate: '2026-09-02T10:00:00.000Z', fromName: null, fromEmail: null }),
    ]);
    expect(agg.fromName).toBeNull();
    expect(agg.fromEmail).toBeNull();
  });
});

import { randomBytes } from 'node:crypto';

import {
  base64ToBytes,
  bytesToBase64,
  detailForDevice,
  deviceMailToPrune,
  emptyDeviceMailIndex,
  goneFromInbox,
  inboxListStorage,
  keptOnDevice,
  isDeviceSealed,
  openDeviceText,
  parseDeviceMailIndex,
  sealDeviceText,
  suspectedForDevice,
  threadsToPrefetch,
  unreadReconcile,
  utf8Length,
  withinDeviceKeep,
  type DeviceMailIndex,
  type EmailThreadDetail,
  type EmailThreadSummary,
} from '@chord/kernel';
import { describe, expect, it } from 'vitest';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function row(id: string, ageDays: number, extra: Partial<EmailThreadSummary> = {}): EmailThreadSummary {
  return {
    id,
    subject: id,
    snippet: '',
    fromName: null,
    fromEmail: null,
    lastMessageAt: daysAgo(ageDays),
    messageCount: 1,
    isUnread: false,
    isArchived: false,
    labelIds: ['INBOX'],
    ...extra,
  } as EmailThreadSummary;
}

function index(entries: [string, number, number?][]): DeviceMailIndex {
  const idx = emptyDeviceMailIndex();
  for (const [id, age, bytes = 10] of entries) {
    idx.entries[id] = { lastMessageAt: daysAgo(age), bytes, storedAt: NOW, summary: row(id, age) };
  }
  return idx;
}

describe('withinDeviceKeep', () => {
  it('keeps 30 days and no more', () => {
    expect(withinDeviceKeep(daysAgo(29.9), NOW)).toBe(true);
    expect(withinDeviceKeep(daysAgo(30), NOW)).toBe(true);
    expect(withinDeviceKeep(daysAgo(30.1), NOW)).toBe(false);
    expect(withinDeviceKeep('not a date', NOW)).toBe(false);
  });
});

describe('threadsToPrefetch', () => {
  it('fetches new and changed threads in the window, newest first, up to the limit', () => {
    const list = [
      row('old', 40),
      row('stored-same', 2),
      row('stored-changed', 1),
      row('new-a', 3),
      row('new-b', 0.5),
      row('archived', 1, { isArchived: true }),
      row('trashed', 1, { labelIds: ['TRASH'] }),
    ];
    const idx = index([
      ['stored-same', 2],
      ['stored-changed', 4],
    ]);
    expect(threadsToPrefetch(list, idx, NOW)).toEqual(['new-b', 'stored-changed', 'new-a']);
    expect(threadsToPrefetch(list, idx, NOW, 2)).toEqual(['new-b', 'stored-changed']);
  });
});

describe('goneFromInbox', () => {
  const idx = index([
    ['still-here', 1],
    ['archived-elsewhere', 2],
    ['older-than-page', 9],
  ]);

  it('drops stored threads that should be on the page but are not', () => {
    const page = [row('still-here', 1), row('other', 5)];
    expect(goneFromInbox(idx, page, false)).toEqual(['archived-elsewhere']);
  });

  it('when the list ended, anything not on it is gone', () => {
    const page = [row('still-here', 1), row('other', 5)];
    expect(goneFromInbox(idx, page, true).sort()).toEqual(['archived-elsewhere', 'older-than-page']);
  });

  it('an empty page proves nothing unless the list ended', () => {
    expect(goneFromInbox(idx, [], false)).toEqual([]);
    expect(goneFromInbox(idx, [], true)).toHaveLength(3);
  });
});

describe('deviceMailToPrune', () => {
  it('drops past the window, then the oldest past the byte and count limits', () => {
    const idx = index([
      ['a', 1, 40],
      ['b', 2, 40],
      ['c', 3, 40],
      ['expired', 31, 1],
    ]);
    expect(deviceMailToPrune(idx, NOW).sort()).toEqual(['expired']);
    expect(deviceMailToPrune(idx, NOW, { maxBytes: 100 }).sort()).toEqual(['c', 'expired']);
    expect(deviceMailToPrune(idx, NOW, { maxThreads: 1 }).sort()).toEqual(['b', 'c', 'expired']);
  });
});

describe('index parsing and the stored copy', () => {
  it('a damaged index reads as empty', () => {
    expect(parseDeviceMailIndex('{oops')).toEqual(emptyDeviceMailIndex());
    expect(parseDeviceMailIndex(JSON.stringify({ version: 2, entries: {} }))).toEqual(emptyDeviceMailIndex());
    const idx = index([['a', 1]]);
    expect(parseDeviceMailIndex(JSON.stringify(idx))).toEqual(idx);
  });

  it('never writes the image token', () => {
    const d = { thread: row('t', 1), messages: [], imageToken: 'secret' } as EmailThreadDetail;
    expect(detailForDevice(d)).not.toHaveProperty('imageToken');
  });

  it('measures UTF-8 bytes', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('—')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
    expect(utf8Length('😀')).toBe(Buffer.byteLength('😀'));
  });
});

describe('sealing', () => {
  it('base64 matches Node for every length', () => {
    for (let n = 0; n < 40; n++) {
      const b = randomBytes(n);
      expect(bytesToBase64(b)).toBe(b.toString('base64'));
      expect(Buffer.from(base64ToBytes(b.toString('base64')))).toEqual(b);
    }
  });

  it('round-trips text, including non-ASCII, under the same key', () => {
    const key = randomBytes(32);
    const text = JSON.stringify({ subject: 'Café — 😀 plans', body: '<p>Hi</p>'.repeat(500) });
    const sealed = sealDeviceText(key, randomBytes(12), text);
    expect(isDeviceSealed(sealed)).toBe(true);
    expect(sealed).not.toContain('Café');
    expect(openDeviceText(key, sealed)).toBe(text);
  });

  it('a wrong key, an altered file or a plain file opens to null', () => {
    const key = randomBytes(32);
    const sealed = sealDeviceText(key, randomBytes(12), 'hello');
    expect(openDeviceText(randomBytes(32), sealed)).toBeNull();
    const flipped = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(openDeviceText(key, flipped)).toBeNull();
    expect(openDeviceText(key, '{"plain":true}')).toBeNull();
  });

  it('two seals of the same text differ (fresh nonce)', () => {
    const key = randomBytes(32);
    expect(sealDeviceText(key, randomBytes(12), 'x')).not.toBe(sealDeviceText(key, randomBytes(12), 'x'));
  });
});

describe('unread mail (ADR 0304)', () => {
  function unreadIndex(entries: [string, number, boolean, number?][]): DeviceMailIndex {
    const idx = emptyDeviceMailIndex();
    for (const [id, age, unread, bytes = 10] of entries) {
      idx.entries[id] = { lastMessageAt: daysAgo(age), bytes, storedAt: NOW, summary: row(id, age, { isUnread: unread }) };
    }
    return idx;
  }

  it('keeps unread mail at any age, read mail only within the window', () => {
    expect(keptOnDevice({ lastMessageAt: daysAgo(200), isUnread: true }, NOW)).toBe(true);
    expect(keptOnDevice({ lastMessageAt: daysAgo(200), isUnread: false }, NOW)).toBe(false);
    expect(keptOnDevice({ lastMessageAt: daysAgo(2), isUnread: false }, NOW)).toBe(true);
  });

  it('fetches unread first, old unread included, each newest first, asked once', () => {
    const inbox = [row('read-new', 0.1), row('unread-new', 1, { isUnread: true }), row('read-old', 40)];
    const unread = [row('unread-new', 1, { isUnread: true }), row('unread-old', 60, { isUnread: true })];
    expect(threadsToPrefetch([...inbox, ...unread], emptyDeviceMailIndex(), NOW)).toEqual([
      'unread-new',
      'unread-old',
      'read-new',
    ]);
    expect(threadsToPrefetch([...inbox, ...unread], emptyDeviceMailIndex(), NOW, 2)).toEqual([
      'unread-new',
      'unread-old',
    ]);
  });

  it('never drops an old unread email for read mail; past maxUnread the oldest unread go', () => {
    const idx = unreadIndex([
      ['unread-old', 90, true, 40],
      ['unread-older', 120, true, 40],
      ['read-new', 1, false, 40],
      ['read-old', 40, false, 1],
    ]);
    expect(deviceMailToPrune(idx, NOW).sort()).toEqual(['read-old']);
    // Over the byte limit, read mail goes before unread.
    expect(deviceMailToPrune(idx, NOW, { maxBytes: 85 }).sort()).toEqual(['read-new', 'read-old']);
    expect(deviceMailToPrune(idx, NOW, { maxUnread: 1 }).sort()).toEqual(['read-old', 'unread-older']);
  });

  it('an old stored email missing from the unread list was read or removed elsewhere', () => {
    const idx = unreadIndex([
      ['still-unread', 40, true],
      ['read-elsewhere', 50, true],
      ['beyond-the-list', 300, true],
      ['recent', 1, true],
    ]);
    const unread = [row('still-unread', 40, { isUnread: true }), row('other', 100, { isUnread: true })];
    const partial = unreadReconcile(idx, { inbox: [row('recent', 1)], unread, unreadComplete: false }, NOW);
    expect(partial.noLongerUnread).toEqual(['read-elsewhere']);
    expect(partial.states['recent'].isUnread).toBe(false);
    expect(partial.states['read-elsewhere'].isUnread).toBe(false);
    expect(partial.states['still-unread'].isUnread).toBe(true);
    const ended = unreadReconcile(idx, { inbox: [], unread, unreadComplete: true }, NOW);
    expect(ended.noLongerUnread.sort()).toEqual(['beyond-the-list', 'read-elsewhere']);
  });
});

describe('suspected spam stays off the device (ADR 0304)', () => {
  const detail = (extra: Partial<EmailThreadDetail> = {}, level?: 'none' | 'caution' | 'danger') =>
    ({
      thread: row('t', 1, { isUnread: true }),
      messages: [{ id: 'm', senderCheck: level ? { level, signals: [] } : undefined }],
      ...extra,
    }) as unknown as EmailThreadDetail;

  it('ordinary and caution-level mail is kept; danger, an advisory or SPAM is not', () => {
    expect(suspectedForDevice(detail())).toBe(false);
    expect(suspectedForDevice(detail({}, 'caution'))).toBe(false);
    expect(suspectedForDevice(detail({}, 'danger'))).toBe(true);
    expect(suspectedForDevice(detail({ readAdvisory: { summary: 'phish' } } as never))).toBe(true);
    expect(suspectedForDevice(detail({ thread: row('t', 1, { labelIds: ['SPAM'] }) }))).toBe(true);
  });

  it('a SPAM row is never fetched', () => {
    const list = [row('spam', 1, { isUnread: true, labelIds: ['SPAM'] }), row('ok', 1, { isUnread: true })];
    expect(threadsToPrefetch(list, emptyDeviceMailIndex(), NOW)).toEqual(['ok']);
  });
});

describe('inboxListStorage', () => {
  // email/index.tsx wrote the inbox list (subjects, senders, snippets) to
  // AsyncStorage - localStorage - on web, where ADR 0304 keeps mail in memory.
  it('never keeps the list in browser storage', () => {
    expect(inboxListStorage({ web: true, sealedReady: false })).toBe('none');
    expect(inboxListStorage({ web: true, sealedReady: true })).toBe('none');
  });

  it('seals it on a phone with the key store, plain only without one', () => {
    expect(inboxListStorage({ web: false, sealedReady: true })).toBe('sealed');
    expect(inboxListStorage({ web: false, sealedReady: false })).toBe('plain');
  });
});

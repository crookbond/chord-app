/**
 * ADR 0109 — bulk is how mail was SENT.
 *
 * The tests that matter here are the negatives. A shipping notice carries no
 * unsubscribe header by design, and an Evite carries one — so the rule has to
 * be readable as "bulk-sent", never as "unimportant".
 */
import { describe, expect, it } from 'vitest';

import { isBulkSender, isBulkThread } from '@/services/email/bulk.js';
import { normalizeMessage } from '@/services/google/gmail-sync.js';

const msg = (over: Partial<Parameters<typeof isBulkSender>[0]> = {}) => ({
  listUnsubscribe: null,
  listId: null,
  labelIds: [] as string[],
  ...over,
});

describe('isBulkSender', () => {
  it('takes any of the three signals', () => {
    expect(isBulkSender(msg({ listUnsubscribe: '<https://x.example/u?id=9>' }))).toBe(true);
    expect(isBulkSender(msg({ listId: '<parents.school.example>' }))).toBe(true);
    expect(isBulkSender(msg({ labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }))).toBe(true);
  });

  it('does not read a missing header as proof of anything', () => {
    // Transactional mass mail is exempt from the RFC 8058 mandate, so the
    // retailer that sends the newsletter sends this one bare.
    expect(isBulkSender(msg({ labelIds: ['INBOX', 'CATEGORY_UPDATES'] }))).toBe(false);
    expect(isBulkSender(msg())).toBe(false);
    expect(isBulkSender(msg({ listUnsubscribe: '   ' }))).toBe(false);
  });

  it('calls an Evite bulk, which is why bulk alone must never demote', () => {
    const evite = msg({
      listUnsubscribe: '<mailto:unsub@evite.com>',
      labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
    });
    expect(isBulkSender(evite)).toBe(true);
  });
});

describe('isBulkThread', () => {
  it('is bulk only when every message is', () => {
    const blast = msg({ listUnsubscribe: '<https://x.example/u>' });
    expect(isBulkThread([blast, blast])).toBe(true);
    expect(isBulkThread([])).toBe(false);
  });

  it('one ordinary message makes the thread a conversation', () => {
    // The user replying to a newsletter is engagement; the reply carries no
    // list headers, and the whole thread stops being bulk.
    const blast = msg({ listUnsubscribe: '<https://x.example/u>' });
    const reply = msg({ labelIds: ['SENT'] });
    expect(isBulkThread([blast, reply])).toBe(false);
  });
});

describe('normalizeMessage', () => {
  const raw = (headers: { name: string; value: string }[]) => ({
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX'],
    snippet: 'hello',
    internalDate: '1750000000000',
    payload: { headers: [{ name: 'From', value: 'News <news@x.example>' }, ...headers] },
  });

  it('lifts the list headers off the metadata payload', () => {
    const nm = normalizeMessage(
      raw([
        { name: 'List-Unsubscribe', value: '<https://x.example/u?id=9>' },
        { name: 'List-Id', value: '<news.x.example>' },
      ]),
    );
    expect(nm.listUnsubscribe).toBe('<https://x.example/u?id=9>');
    expect(nm.listId).toBe('<news.x.example>');
  });

  it('reports null when the sender set neither', () => {
    const nm = normalizeMessage(raw([]));
    expect(nm.listUnsubscribe).toBeNull();
    expect(nm.listId).toBeNull();
  });
});

/**
 * Who "Reply all" on a calendar event writes to (kernel/src/event-reply-all.ts,
 * ADR 0306).
 */
import { describe, expect, it } from 'vitest';

import { eventComposeHref, eventReplyAllRecipients } from '@chord/kernel';

describe('eventReplyAllRecipients', () => {
  it('puts the organizer first, then each guest once, lowercased', () => {
    expect(eventReplyAllRecipients(['B@x.com', 'c@x.com', 'b@x.com'], 'Host@x.com')).toEqual([
      'host@x.com',
      'b@x.com',
      'c@x.com',
    ]);
  });

  it('leaves out the writer and anything that is not an address', () => {
    expect(eventReplyAllRecipients(['me@x.com', 'Karl Dale', ''], 'ME@x.com', ['me@x.com'])).toEqual([]);
  });

  it('copes with nothing known', () => {
    expect(eventReplyAllRecipients(null, null)).toEqual([]);
  });
});

describe('eventComposeHref', () => {
  it('addresses the composer and uses the event title as subject', () => {
    expect(eventComposeHref(['a@x.com', 'b@x.com'], 'Dinner & drinks')).toBe(
      '/email/compose?to=a%40x.com%2C%20b%40x.com&subject=Dinner%20%26%20drinks',
    );
  });

  it('omits an empty subject', () => {
    expect(eventComposeHref(['a@x.com'], '  ')).toBe('/email/compose?to=a%40x.com');
  });
});

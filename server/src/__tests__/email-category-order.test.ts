import { describe, expect, it } from 'vitest';

import { applyCategoryOrder, applyUnreadFirstOrder } from '@chord/kernel';

interface Card {
  title: string;
  unread: number;
}

const card = (title: string, unread = 0): Card => ({ title, unread });
const order = (cards: Card[], pinned: string[]): string[] =>
  applyUnreadFirstOrder(cards, (c) => c.title, (c) => c.unread, pinned).map((c) => c.title);

describe('applyUnreadFirstOrder', () => {
  /**
   * The reported case: the user pins the categories they care about, and a
   * category with mail nobody has read sits below them until they scroll.
   */
  it('puts a category with unread mail above a pinned one that is read', () => {
    const cards = [card('School', 3), card('Finance'), card('Trips')];
    expect(applyCategoryOrder(cards, (c) => c.title, ['Finance', 'Trips']).map((c) => c.title)).toEqual(
      ['Finance', 'Trips', 'School'],
    );
    expect(order(cards, ['Finance', 'Trips'])).toEqual(['School', 'Finance', 'Trips']);
  });

  it('keeps the user order inside the unread half', () => {
    const cards = [card('School', 5), card('Finance', 1), card('Trips', 2)];
    expect(order(cards, ['Finance', 'Trips'])).toEqual(['Finance', 'Trips', 'School']);
  });

  it('keeps the user order among the read ones, below every unread one', () => {
    const cards = [card('School', 1), card('Receipts'), card('Finance'), card('Trips')];
    expect(order(cards, ['Finance', 'Trips'])).toEqual(['School', 'Finance', 'Trips', 'Receipts']);
  });

  it('falls back to exactly where the user put it once a category is read', () => {
    const pinned = ['Finance', 'Trips'];
    const read = [card('School'), card('Finance'), card('Trips')];
    expect(order(read, pinned)).toEqual(['Finance', 'Trips', 'School']);
    expect(order(read, pinned)).toEqual(applyCategoryOrder(read, (c) => c.title, pinned).map((c) => c.title));
  });

  it('is the plain user order when every category is unread, or none is', () => {
    const allUnread = [card('School', 1), card('Finance', 2), card('Trips', 3)];
    const none = [card('School'), card('Finance'), card('Trips')];
    for (const cards of [allUnread, none]) {
      expect(order(cards, ['Trips'])).toEqual(
        applyCategoryOrder(cards, (c) => c.title, ['Trips']).map((c) => c.title),
      );
    }
  });

  it('keeps the order it was given when nothing is pinned', () => {
    const cards = [card('School', 2), card('Finance'), card('Trips', 1)];
    expect(order(cards, [])).toEqual(['School', 'Trips', 'Finance']);
  });

  it('matches a pin however the title is cased or spaced', () => {
    const cards = [card('School', 1), card('Finance'), card('Trips')];
    expect(order(cards, ['  trips  '])).toEqual(['School', 'Trips', 'Finance']);
  });
});

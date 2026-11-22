/**
 * ADR 0094 — the one list-name rule.
 *
 * The bug these lock down: `get_list` stemmed and prefix-matched while the
 * write behind `add_list_item` compared with a raw `=`, so the bot read
 * "Restaurants" and then created "restaurants" beside it. Read and write now
 * call `resolveListName`, so anything asserted here holds on both sides.
 */
import { describe, expect, it } from 'vitest';

import { listNameKey, listNameLooseMatch, resolveListName } from '@chord/kernel';

const lists = (...names: string[]) => names.map((name) => ({ name }));

describe('listNameKey', () => {
  it('collapses the casings and phrasings people actually use', () => {
    const same = ['Restaurants', 'restaurants', 'RESTAURANTS', 'restaurant list', 'Restaurant'];
    const keys = new Set(same.map(listNameKey));
    expect(keys.size).toBe(1);
  });

  it('stems plurals so grocery and groceries are one list', () => {
    expect(listNameKey('Groceries')).toBe(listNameKey('grocery'));
    expect(listNameKey('Books')).toBe(listNameKey('book'));
  });

  it.each([
    // The `es`-stripping stemmer this replaced failed every one of these:
    // it took two characters off an `e` stem, so "Notes" keyed as "not"
    // while "Note" kept its "e", and `ies -> y` turned "Movies" into "movy".
    ['Notes', 'Note'],
    ['Running Notes', 'Running Note'],
    ['Movies', 'Movie'],
    ['Recipes', 'Recipe'],
    ['Places', 'Place'],
    ['Stories', 'Story'],
    ['Parties', 'Party'],
    // These the old rule already handled - they must not regress.
    ['To-dos', 'To-do'],
    ['Dishes', 'Dish'],
    ['Boxes', 'Box'],
    ['Glasses', 'Glass'],
  ])('folds %s and %s onto one key', (plural, singular) => {
    expect(listNameKey(plural)).toBe(listNameKey(singular));
  });

  it('drops a possessive rather than leaving a ghost token', () => {
    // "Nolan's" tokenizes to ["nolan", "s"], and "s" folds to nothing.
    // Left in, it padded the key with a double space.
    expect(listNameKey("Nolan's reading list")).toBe('nolan reading');
  });

  it('keeps genuinely different names apart', () => {
    expect(listNameKey('Books to read')).not.toBe(listNameKey('Books to buy'));
    expect(listNameKey('Costco')).not.toBe(listNameKey('Walmart'));
  });

  it('falls back to raw text when a name stems to nothing', () => {
    // "List" is all filler; without the fallback its key would be '' and it
    // would merge with every other punctuation-only name.
    expect(listNameKey('List')).not.toBe(listNameKey('!!!'));
  });
});

describe('listNameLooseMatch', () => {
  it('finds a longer list from a shorter query', () => {
    expect(listNameLooseMatch('Books to read', 'books')).toBe(true);
    expect(listNameLooseMatch('Groceries', 'grocery list')).toBe(true);
  });

  it('does not match an unrelated list', () => {
    expect(listNameLooseMatch('Costco', 'books')).toBe(false);
  });
});

describe('resolveListName', () => {
  it('resolves across casing — the veeray case', () => {
    const r = resolveListName(lists('Restaurants'), 'restaurant list');
    expect(r.status).toBe('resolved');
    expect(r.status === 'resolved' && r.match.name).toBe('Restaurants');
  });

  it('prefers the exact key over a longer prefix match', () => {
    const r = resolveListName(lists('Books', 'Books to read'), 'books');
    expect(r.status === 'resolved' && r.match.name).toBe('Books');
  });

  it('reports ambiguity rather than guessing between two fits', () => {
    const r = resolveListName(lists('Books to read', 'Books to buy'), 'books');
    expect(r.status).toBe('ambiguous');
    expect(r.status === 'ambiguous' && r.candidates.map((c) => c.name)).toEqual([
      'Books to read',
      'Books to buy',
    ]);
  });

  it('returns none when nothing matches, so the caller creates', () => {
    expect(resolveListName(lists('Costco'), 'restaurants').status).toBe('none');
  });

  it('takes the first row when two lists share a key', () => {
    // Only reachable for rows predating migration 042. Callers pass
    // oldest-first, so the original keeps growing instead of the fork.
    const r = resolveListName(lists('Restaurants', 'restaurants'), 'Restaurants');
    expect(r.status === 'resolved' && r.match.name).toBe('Restaurants');
  });

  it('treats an empty query as no match, never as a wildcard', () => {
    expect(resolveListName(lists('Costco'), '   ').status).toBe('none');
    expect(resolveListName(lists('Costco'), 'list').status).toBe('none');
  });
});

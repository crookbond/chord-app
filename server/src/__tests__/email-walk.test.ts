/**
 * Reported 2026-10-27: on the email list with Unread on, putting emails away
 * one after another walked back through emails already read. The reader went
 * to the next email, or the one above when there was none, and the list kept
 * a row it had marked read - so each removal landed on an email just read.
 */
import { describe, expect, it } from 'vitest';
import { afterRemoveTarget, nextInWalk, type EmailWalk } from '@chord/kernel';

const walk = (scope: EmailWalk['scope'], read: string[] = []): EmailWalk => ({
  ids: ['a', 'b', 'c', 'd'],
  scope,
  read: new Set(read),
});

describe('the unread walk', () => {
  it('putting the last unread email away goes back to the list, not to one just read', () => {
    // Opened a, b, c in turn (each read on open), now on d, the last.
    expect(afterRemoveTarget(walk('unread', ['a', 'b', 'c']), 'd')).toBeNull();
  });

  it('skips an email read since the walk began', () => {
    // b was opened earlier and is read; from a, the next waiting is c.
    expect(nextInWalk(walk('unread', ['b']), 'a')).toBe('c');
    expect(afterRemoveTarget(walk('unread', ['a', 'b']), 'a')).toBe('c');
  });

  it('a category walk behaves the same', () => {
    expect(afterRemoveTarget(walk('category', ['a', 'b', 'c']), 'd')).toBeNull();
    expect(nextInWalk(walk('category', ['b']), 'a')).toBe('c');
  });
});

describe('an email already archived or trashed', () => {
  // Prod 2026-10-27 12:53 UTC: the same two IMAP threads were trashed four
  // times each within seconds; every repeat failed ("Command failed"), as
  // the messages had already left the inbox.
  const removed = (scope: EmailWalk['scope'], gone: string[], read: string[] = []): EmailWalk => ({
    ...walk(scope, read),
    removed: new Set(gone),
  });

  it('is not next, in any order', () => {
    expect(nextInWalk(removed('list', ['b']), 'a')).toBe('c');
    expect(nextInWalk(removed('unread', ['b']), 'a')).toBe('c');
    expect(nextInWalk(removed('category', ['b']), 'a')).toBe('c');
  });

  it('is not where putting the last email away leads', () => {
    // On d, the last; c above it was trashed a moment ago.
    expect(afterRemoveTarget(removed('list', ['c']), 'd')).toBe('b');
    expect(afterRemoveTarget(removed('list', ['a', 'b', 'c']), 'd')).toBeNull();
  });
});

describe('the plain list', () => {
  it('goes to the next email, read or not', () => {
    expect(nextInWalk(walk('list', ['b']), 'a')).toBe('b');
  });

  it('putting the last one away shows the one above (ADR 0218)', () => {
    expect(afterRemoveTarget(walk('list', ['c']), 'd')).toBe('c');
  });

  it('an email not in the order has no neighbour', () => {
    expect(nextInWalk(walk('list'), 'z')).toBeNull();
    expect(afterRemoveTarget(walk('unread'), 'z')).toBeNull();
  });
});

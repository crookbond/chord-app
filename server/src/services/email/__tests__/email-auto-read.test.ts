/**
 * The reader marks an email read message by message, as each one is seen.
 *
 * Prod 2026-11-10: thread emt_ZfkbOtRTAbZN was open on screen, the user
 * replied (15:37), a new message arrived (15:41) and the reader re-read the
 * thread unread - and never marked it read, because it marked the whole
 * thread once on open and remembered that it had. It stayed unread until
 * reopened at 15:55.
 */
import { describe, expect, it } from 'vitest';

import { messagesOnScreen, messagesToMarkRead } from '@chord/kernel';

const open = () => true;

describe('messagesOnScreen', () => {
  // Three 400px cards in a 700px view.
  const boxes = [
    { id: 'm1', y: 0, height: 400 },
    { id: 'm2', y: 400, height: 400 },
    { id: 'm3', y: 800, height: 400 },
  ];

  it('counts the cards inside the view, not the one below it', () => {
    expect(messagesOnScreen(boxes, 0, 700)).toEqual(['m1', 'm2']);
  });

  it('scrolling to the bottom reaches the last card', () => {
    expect(messagesOnScreen(boxes, 500, 700)).toEqual(['m2', 'm3']);
  });

  it('a sliver at the edge is not seen', () => {
    expect(messagesOnScreen(boxes, 0, 820)).toEqual(['m1', 'm2']);
  });

  it('a short card counts when all of it is in view', () => {
    expect(messagesOnScreen([{ id: 'm1', y: 10, height: 30 }], 0, 700)).toEqual(['m1']);
  });

  it('nothing before the view has a size', () => {
    expect(messagesOnScreen(boxes, 0, 0)).toEqual([]);
  });
});

describe('messagesToMarkRead', () => {
  const msgs = (...m: Array<[string, boolean]>) => m.map(([id, isUnread]) => ({ id, isUnread }));

  it('marks the unread messages on screen, and only those', () => {
    const thread = msgs(['m1', true], ['m2', true], ['m3', true]);
    expect(messagesToMarkRead(thread, ['m1', 'm2'], open, new Set())).toEqual(['m1', 'm2']);
  });

  it('scrolling through a reopened thread marks every message', () => {
    const thread = msgs(['m1', true], ['m2', true], ['m3', true]);
    const sent = new Set<string>();
    for (const screen of [['m1'], ['m1', 'm2'], ['m2', 'm3']]) {
      for (const id of messagesToMarkRead(thread, screen, open, sent)) sent.add(id);
    }
    expect([...sent].sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('a reply arriving while the email is open is marked once it is on screen', () => {
    // Opened and read m1; the user replied; then the sender answered (m3).
    const sent = new Set(['m1']);
    const thread = msgs(['m1', false], ['sent1', false], ['m3', true]);
    expect(messagesToMarkRead(thread, ['m1', 'sent1', 'm3'], open, sent)).toEqual(['m3']);
  });

  it('leaves a manual "Mark unread" alone', () => {
    const thread = msgs(['m1', true], ['m2', true]);
    expect(messagesToMarkRead(thread, ['m1', 'm2'], open, new Set(['m1', 'm2']))).toEqual([]);
  });

  it('does not mark a message folded to one line', () => {
    const thread = msgs(['m1', true], ['m2', true]);
    expect(messagesToMarkRead(thread, ['m1', 'm2'], (id) => id === 'm2', new Set())).toEqual(['m2']);
  });
});

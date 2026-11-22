/**
 * ADR 0250 — an opened thread starts at its unread mail, not at the top.
 */
import { describe, expect, it } from 'vitest';

import { threadOpenPlan } from '@chord/kernel';

const m = (id: string, isUnread = false) => ({ id, isUnread });

describe('threadOpenPlan', () => {
  it('lands on the one new reply at the bottom of a long thread', () => {
    expect(threadOpenPlan([m('a'), m('b'), m('c'), m('d', true)])).toEqual({ open: ['d'], scrollTo: 'd' });
  });

  it('opens every unread message and lands on the earliest, so new replies read in order', () => {
    expect(threadOpenPlan([m('a'), m('b', true), m('c'), m('d', true)])).toEqual({
      open: ['b', 'd'],
      scrollTo: 'b',
    });
  });

  it('starts at the top when the unread mail is the first message', () => {
    expect(threadOpenPlan([m('a', true), m('b', true)])).toEqual({ open: ['a', 'b'], scrollTo: null });
  });

  it('opens the newest message when nothing is unread', () => {
    expect(threadOpenPlan([m('a'), m('b'), m('c')])).toEqual({ open: ['c'], scrollTo: 'c' });
    expect(threadOpenPlan([m('a')])).toEqual({ open: ['a'], scrollTo: null });
    expect(threadOpenPlan([])).toEqual({ open: [], scrollTo: null });
  });
});

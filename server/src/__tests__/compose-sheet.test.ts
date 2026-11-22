import { describe, expect, it } from 'vitest';
import {
  composeFromAccount,
  composeLayout,
  composePopoutSize,
  sheetDragStarts,
  sheetSwipeDismisses,
} from '@chord/kernel';

describe('composeFromAccount', () => {
  it('opens on the mailbox selected in the list, over the chat default', () => {
    expect(composeFromAccount('acct-yahoo', 'acct-outlook')).toBe('acct-yahoo');
    expect(composeFromAccount('acct-yahoo', null)).toBe('acct-yahoo');
  });

  it('reads the primary chip as the primary Gmail (null)', () => {
    expect(composeFromAccount('primary', 'acct-outlook')).toBeNull();
  });

  it('keeps the chat default when All mailboxes are shown', () => {
    expect(composeFromAccount(undefined, 'acct-outlook')).toBe('acct-outlook');
    expect(composeFromAccount('', null)).toBeNull();
    expect(composeFromAccount(undefined, undefined)).toBeUndefined();
  });
});

describe('composeLayout', () => {
  it('floats a window only on a wide web page', () => {
    expect(composeLayout('web', 1280)).toBe('popout');
    expect(composeLayout('web', 500)).toBe('sheet');
    expect(composeLayout('ios', 1280)).toBe('sheet');
    expect(composeLayout('android', 900)).toBe('sheet');
  });
});

describe('composePopoutSize', () => {
  it('stays inside the window', () => {
    expect(composePopoutSize({ width: 1440, height: 900 }, false)).toEqual({ width: 560, height: 640 });
    expect(composePopoutSize({ width: 800, height: 600 }, false)).toEqual({ width: 560, height: 552 });
    expect(composePopoutSize({ width: 1440, height: 900 }, true)).toEqual({ width: 1000, height: 852 });
  });
});

describe('sheet swipe', () => {
  it('closes on a long pull or a quick flick down, never up', () => {
    expect(sheetSwipeDismisses(130, 0.1)).toBe(true);
    expect(sheetSwipeDismisses(40, 1.4)).toBe(true);
    expect(sheetSwipeDismisses(40, 0.2)).toBe(false);
    expect(sheetSwipeDismisses(10, 2)).toBe(false);
    expect(sheetSwipeDismisses(-200, 3)).toBe(false);
  });

  it('starts only on a clearly downward drag, so header buttons still tap', () => {
    expect(sheetDragStarts(0, 20)).toBe(true);
    expect(sheetDragStarts(2, 5)).toBe(false);
    expect(sheetDragStarts(30, 20)).toBe(false);
    expect(sheetDragStarts(0, -30)).toBe(false);
  });
});

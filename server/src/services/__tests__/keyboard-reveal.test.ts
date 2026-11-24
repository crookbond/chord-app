/**
 * ADR 0297 - how far a screen scrolls so the focused text box sits above the
 * keyboard. Kernel has no harness of its own, so the rule is tested here.
 */
import { describe, expect, it } from 'vitest';

import { androidKeyboardOverlap, keyboardRevealDelta } from '@chord/kernel';

const phone = { windowHeight: 800, keyboardHeight: 300 };

describe('keyboardRevealDelta', () => {
  it('a box behind the keyboard scrolls up to sit above it', () => {
    // Box 700-740, keyboard from 500, 24 margin: move 740 - 476 = 264.
    expect(keyboardRevealDelta({ ...phone, boxTop: 700, boxHeight: 40 })).toBe(264);
  });

  it('a box already above the keyboard does not move', () => {
    expect(keyboardRevealDelta({ ...phone, boxTop: 200, boxHeight: 40 })).toBe(0);
  });

  it('nothing moves while the keyboard is down', () => {
    expect(keyboardRevealDelta({ ...phone, keyboardHeight: 0, boxTop: 780, boxHeight: 40 })).toBe(0);
  });

  it('a box taller than the room left keeps its top in view', () => {
    // A 400-tall note box at 300: fitting its bottom would push its top off screen.
    expect(keyboardRevealDelta({ ...phone, boxTop: 300, boxHeight: 400, visibleTop: 90 })).toBe(186);
  });
});

describe('androidKeyboardOverlap', () => {
  // Pixel-class phone, edge-to-edge (Android 15+): 915dp tall, 40dp status
  // bar, keyboard top at 555dp. The chat screen runs to the bottom of the
  // screen, so measureInWindow (which starts below the status bar) reads
  // its bottom as 875, not 915.
  const chat = { viewBottomInWindow: 875, keyboardScreenY: 555, statusBarHeight: 40 };

  it('pads by the whole covered part, status bar included', () => {
    // Without the status bar this read 320 and the 56dp composer sat
    // under the keyboard (prod, 2026-11-23).
    expect(androidKeyboardOverlap(chat)).toBe(360);
  });

  it('pads nothing when the window already shrank to the keyboard', () => {
    // Older Android resizes the window: the view now ends at the keyboard.
    expect(androidKeyboardOverlap({ ...chat, viewBottomInWindow: 515 })).toBe(0);
  });

  it('never pads negative', () => {
    expect(androidKeyboardOverlap({ ...chat, viewBottomInWindow: 400 })).toBe(0);
  });
});

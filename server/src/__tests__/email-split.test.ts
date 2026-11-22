import { describe, expect, it } from 'vitest';
import {
  DIVIDER_WIDTH,
  PANE_MIN,
  READER_MIN,
  SPLIT_MIN_WINDOW,
  clampPaneWidth,
  defaultPaneWidth,
  draggedPaneWidth,
  splitFits,
  storedPaneWidth,
} from '@chord/kernel';

describe('email split pane (ADR 0320)', () => {
  it('only splits a window with room for both panes', () => {
    expect(splitFits(SPLIT_MIN_WINDOW)).toBe(true);
    expect(splitFits(SPLIT_MIN_WINDOW - 1)).toBe(false);
    expect(splitFits(390)).toBe(false); // a phone
    // The threshold has to leave both minimums room, or the default would
    // open the pane at a width the clamp immediately takes back.
    expect(SPLIT_MIN_WINDOW - DIVIDER_WIDTH - READER_MIN).toBeGreaterThanOrEqual(PANE_MIN);
  });

  it('defaults to half, and half is legal at the narrowest split window', () => {
    expect(defaultPaneWidth(1400)).toBe(700);
    expect(defaultPaneWidth(SPLIT_MIN_WINDOW)).toBe(Math.round(SPLIT_MIN_WINDOW / 2));
  });

  it('keeps the reader usable whatever width is asked for', () => {
    expect(clampPaneWidth(1200, 20)).toBe(PANE_MIN);
    expect(clampPaneWidth(1200, 5000)).toBe(1200 - DIVIDER_WIDTH - READER_MIN);
    // A window that shrank after the width was stored: the pane gives way,
    // never the reader.
    expect(storedPaneWidth(1000, 900)).toBe(1000 - DIVIDER_WIDTH - READER_MIN);
    expect(storedPaneWidth(1600, 700)).toBe(700);
    // Narrower than any split window: the pane bottoms out rather than
    // returning a negative width.
    expect(storedPaneWidth(500, 700)).toBe(PANE_MIN);
  });

  it('falls back to half when nothing was stored or the value is junk', () => {
    expect(storedPaneWidth(1400, null)).toBe(700);
    expect(storedPaneWidth(1400, Number.NaN)).toBe(700);
  });

  it('moves a drag by the distance dragged, within the same bounds', () => {
    expect(draggedPaneWidth(1400, 500, 120)).toBe(620);
    expect(draggedPaneWidth(1400, 500, -400)).toBe(PANE_MIN);
    expect(draggedPaneWidth(1400, 500, 900)).toBe(1400 - DIVIDER_WIDTH - READER_MIN);
  });
});

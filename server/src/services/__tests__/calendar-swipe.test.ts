/**
 * The calendar's sideways swipe (kernel/src/calendar-swipe.ts): which way a
 * finished drag moves the day, multi-day or month view.
 */
import { describe, expect, it } from 'vitest';

import { calendarSwipeStep } from '@chord/kernel';

describe('calendarSwipeStep', () => {
  it('swiping left (finger right-to-left) goes to the next day', () => {
    expect(calendarSwipeStep({ dx: -120, dy: 5, vx: 0 })).toBe(1);
  });

  it('swiping right (finger left-to-right) goes to the previous day', () => {
    expect(calendarSwipeStep({ dx: 120, dy: 5, vx: 0 })).toBe(-1);
  });

  it('a mostly vertical drag is the grid scrolling, not a swipe', () => {
    expect(calendarSwipeStep({ dx: 60, dy: 200, vx: 0 })).toBe(0);
  });

  it('a short slow drag does nothing; a short fast flick counts', () => {
    expect(calendarSwipeStep({ dx: 30, dy: 0, vx: 100 })).toBe(0);
    expect(calendarSwipeStep({ dx: -30, dy: 0, vx: -900 })).toBe(1);
    expect(calendarSwipeStep({ dx: 30, dy: 0, vx: 900 })).toBe(-1);
  });

  it('a flick whose speed points the other way from where the finger ended does nothing', () => {
    expect(calendarSwipeStep({ dx: 30, dy: 0, vx: -900 })).toBe(0);
  });
});

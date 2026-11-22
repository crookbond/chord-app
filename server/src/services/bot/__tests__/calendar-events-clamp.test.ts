/**
 * Regression: a large school-year/season calendar PDF returned more events
 * than the schema cap, which made the whole payload fail validation and drop
 * EVERY event. The classifier now clamps to the cap instead.
 */
import { describe, expect, it } from 'vitest';

import { __testing } from '@/services/bot/trip_classifier.js';

const { clampCalendarEvents, CALENDAR_EVENTS_MAX } = __testing;

const makeEvents = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ title: `Event ${i}`, startsAt: '2026-09-09' }));

describe('clampCalendarEvents', () => {
  it('clamps an over-cap calendar to the cap (instead of rejecting it)', () => {
    const out = clampCalendarEvents({ kind: 'calendar', events: makeEvents(CALENDAR_EVENTS_MAX + 25) });
    expect((out.events as unknown[]).length).toBe(CALENDAR_EVENTS_MAX);
  });

  it('leaves a within-cap calendar untouched', () => {
    const events = makeEvents(12);
    const out = clampCalendarEvents({ kind: 'calendar', events });
    expect((out.events as unknown[]).length).toBe(12);
    expect(out.events).toBe(events); // same reference — no copy
  });

  it('ignores non-calendar payloads', () => {
    const flight = { kind: 'flight', legs: [{ origin: 'SEA' }] };
    expect(clampCalendarEvents(flight)).toBe(flight);
  });

  it('ignores a calendar with a non-array events field', () => {
    const weird = { kind: 'calendar', events: 'nope' };
    expect(clampCalendarEvents(weird)).toBe(weird);
  });
});

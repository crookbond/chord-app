/**
 * Reported: a flight leaving Delhi at 1:50am and landing in New York at 9:00am,
 * read by someone in New York, went on the calendar as 1:50am - 9:00am New
 * York time. The arrival was right only because it lands in the reader's zone;
 * the departure had been given the reader's clock instead of Delhi's.
 */
import { describe, expect, it } from 'vitest';

import { legDatetime } from '@/services/bot/trip_classifier.js';

const NY = 'America/New_York';
const EST = -300;

describe('legDatetime', () => {
  it('anchors a bare departure to the origin airport, with no zone stated', () => {
    expect(legDatetime('2026-11-10T01:50:00', 'DEL', undefined, EST, NY)).toBe('2026-11-10T01:50:00+05:30');
  });

  it("keeps the arrival on the destination's clock", () => {
    expect(legDatetime('2026-11-10T09:00:00', 'JFK', undefined, EST, NY)).toBe('2026-11-10T09:00:00-05:00');
  });

  it('puts the reported flight on the calendar at 3:20pm the day before, for 17h40', () => {
    const departAt = legDatetime('2026-11-10T01:50:00', 'DEL', undefined, EST, NY);
    const arriveAt = legDatetime('2026-11-10T09:00:00', 'JFK', undefined, EST, NY);
    expect(new Date(departAt).toISOString()).toBe('2026-11-09T20:20:00.000Z');
    expect((Date.parse(arriveAt) - Date.parse(departAt)) / 60000).toBe(17 * 60 + 40);
  });

  it("re-anchors a time the model stamped with the reader's own offset", () => {
    expect(legDatetime('2026-11-10T01:50:00-05:00', 'DEL', undefined, EST, NY)).toBe('2026-11-10T01:50:00+05:30');
    expect(legDatetime('2026-11-10T01:50-05:00', 'DEL', undefined, EST, NY)).toBe('2026-11-10T01:50:00+05:30');
  });

  it('leaves an offset that was chosen on purpose alone', () => {
    expect(legDatetime('2026-11-10T01:50:00+05:30', 'DEL', undefined, EST, NY)).toBe('2026-11-10T01:50:00+05:30');
    expect(legDatetime('2026-11-09T20:20:00Z', 'DEL', undefined, EST, NY)).toBe('2026-11-09T20:20:00Z');
    expect(legDatetime('2026-11-10T01:50:00+01:00', 'DEL', undefined, EST, NY)).toBe('2026-11-10T01:50:00+01:00');
  });

  it("uses the reader's offset on the leg's own date, not today's", () => {
    // July is daylight time in New York (-04:00); the flat fallback says -05:00.
    expect(legDatetime('2026-07-10T01:50:00-04:00', 'DEL', undefined, EST, NY)).toBe('2026-07-10T01:50:00+05:30');
  });

  it('prefers the airport over a zone the model stated wrongly', () => {
    expect(legDatetime('2026-11-10T01:50:00', 'DEL', NY, EST, NY)).toBe('2026-11-10T01:50:00+05:30');
  });

  it("falls back to the model's zone, then the reader's, for a place it does not know", () => {
    expect(legDatetime('2026-11-10T01:50:00', 'Kochi', 'Asia/Kolkata', EST, NY)).toBe('2026-11-10T01:50:00+05:30');
    expect(legDatetime('2026-11-10T01:50:00', 'Kochi', 'Not/AZone', EST, NY)).toBe('2026-11-10T01:50:00-05:00');
    expect(legDatetime('2026-11-10T01:50:00', 'Kochi', undefined, EST, NY)).toBe('2026-11-10T01:50:00-05:00');
  });
});

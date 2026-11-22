/**
 * ADR 0190 — the pure "what makes one trip" rules. Dates and routes are the
 * real ones from ownertest@gmail.com's prod trips, so a rule that would have
 * glued or split a real journey fails here.
 */
import { describe, expect, it } from 'vitest';

import { chainConnects, chainSeams, departAtMs, sameFlight } from '../chain.js';

const leg = (origin: string, destination: string, departAt: string) => ({ origin, destination, departAt });

describe('chainSeams — when a chain continues', () => {
  it('a chain ends when the traveler gets back to where it started', () => {
    // LGA→DEN, DEN→JFK closes the loop (JFK and LGA are one metro), so the
    // next flight out of New York is a NEW trip, not more of this one.
    const seams = chainSeams([
      leg('LGA', 'DEN', '2027-02-11T20:55:00-05:00'),
      leg('DEN', 'JFK', '2027-02-15T17:50:00-07:00'),
      leg('LGA', 'LAX', '2027-02-20T09:00:00-05:00'),
    ]);
    expect(seams).toEqual([true, false]);
  });

  it('a long silence ends the chain: Ben\'s May arrival is not part of his September trip', () => {
    const seams = chainSeams([
      leg("Chicago O'Hare International", 'New York La Guardia', '2026-05-30T14:40:00-05:00'),
      leg('LGA', 'MDW', '2026-09-24T15:25:00-04:00'), // 117 days later
    ]);
    expect(seams).toEqual([false]);
  });

  it('landing home and flying out again two months later is two trips, not one in transit', () => {
    // Real: Ben's ORD→LGA on 30 May, then the family's JFK→DOH on 1 Aug —
    // 63 days with the second leg leaving from where the first ended.
    const seams = chainSeams([
      leg("Chicago O'Hare International", 'New York La Guardia', '2026-05-30T14:40:00-05:00'),
      leg('JFK', 'DOH', '2026-08-01T22:00:00-04:00'),
    ]);
    expect(seams).toEqual([false]);
  });

  it('...while his September outbound and November return are one trip (57 days)', () => {
    const seams = chainSeams([
      leg('LGA', 'MDW', '2026-09-24T15:25:00-04:00'),
      leg('ORD', 'LGA', '2026-11-20T20:20:00-06:00'),
    ]);
    expect(seams).toEqual([true]);
  });

  it('an open one-way keeps going: Delhi to New York, then a hop out of LaGuardia', () => {
    const seams = chainSeams([
      leg('DEL', 'EWR', '2026-10-12T01:50:00+05:30'),
      leg('LGA', 'YYZ', '2026-10-24T08:45:00-04:00'),
      leg('YYZ', 'LGA', '2026-11-15T14:00:00-05:00'),
      leg('JFK', 'DEL', '2026-11-25T10:00:00-05:00'),
    ]);
    expect(seams).toEqual([true, true, true]);
  });

  it('a leg that leaves from somewhere else is a different journey', () => {
    expect(chainSeams([
      leg('LGA', 'DEN', '2026-02-11T20:55:00-05:00'),
      leg('MIA', 'LAX', '2026-02-16T09:00:00-05:00'),
    ])).toEqual([false]);
  });
});

describe('chainConnects — joining new legs to a trip already on file', () => {
  const homeLoop = [
    leg('LGA', 'DEN', '2027-02-11T20:55:00-05:00'),
    leg('DEN', 'LGA', '2027-02-15T17:50:00-07:00'),
  ];

  it('never reopens a closed round trip for the next one out of the same city', () => {
    expect(chainConnects(homeLoop, [leg('LGA', 'LAX', '2027-02-20T09:00:00-05:00')])).toBe(false);
  });

  it('joins a return leg onto an open outbound', () => {
    expect(chainConnects([homeLoop[0]!], [homeLoop[1]!])).toBe(true);
  });

  it('a re-send of a leg already on the trip is not a new leg', () => {
    expect(chainConnects(homeLoop, homeLoop)).toBe(true);
  });
});

describe('sameFlight', () => {
  it('compares the instant, not the printed offset', () => {
    // The real Ben pair: one leg, restated with a different zone.
    expect(
      sameFlight(
        leg('ORD', 'LGA', '2026-11-20T20:20:00-06:00'),
        leg('ORD', 'LGA', '2026-11-20T21:20:00-05:00'),
      ),
    ).toBe(true);
  });

  it('needs the same route AND the same instant', () => {
    const a = leg('JFK', 'DOH', '2026-08-01T22:00:00-04:00');
    expect(sameFlight(a, leg('JFK', 'DOH', '2026-08-02T22:00:00-04:00'))).toBe(false);
    expect(sameFlight(a, leg('JFK', 'DXB', '2026-08-01T22:00:00-04:00'))).toBe(false);
  });

  it('a malformed time never counts as the same flight', () => {
    expect(departAtMs('not a date')).toBe(0);
    expect(sameFlight(leg('A', 'B', 'nope'), leg('A', 'B', 'nope'))).toBe(false);
  });
});

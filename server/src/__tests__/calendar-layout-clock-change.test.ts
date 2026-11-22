/**
 * The day grid on a day the clocks change (found 2026-10-31, the eve of the US
 * fall-back). The grid's rows are clock hours, but blocks were placed by
 * minutes ELAPSED since local midnight and the day ended at midnight + 24h. On
 * the 25-hour day a 9:00 event sat in the 10:00 row and 23:00-24:00 was cut
 * off; on the 23-hour day the reverse.
 *
 * Device-local times are the process's, so the zone is set here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clipBlockToDay, legsForDay, localDayBounds, type TripStatus } from '@chord/kernel';

const HH = 48;
let savedTz: string | undefined;

beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

const fallBack = () => new Date(2026, 10, 1); // Sun 1 Nov 2026, 25 hours
const springForward = () => new Date(2027, 2, 14); // Sun 14 Mar 2027, 23 hours

describe('day grid on a clock-change day', () => {
  it('the zone took effect (guards the rest from passing vacuously)', () => {
    const { dayStart, dayEnd } = localDayBounds(fallBack());
    expect((dayEnd - dayStart) / 3_600_000).toBe(25);
    const spring = localDayBounds(springForward());
    expect((spring.dayEnd - spring.dayStart) / 3_600_000).toBe(23);
  });

  it('9:00 on the fall-back day sits in the 9:00 row', () => {
    const r = clipBlockToDay(new Date(2026, 10, 1, 9, 0), new Date(2026, 10, 1, 10, 0), fallBack(), HH);
    expect(r.top).toBe(9 * HH);
    expect(r.height).toBe(HH - 2);
  });

  it('23:00-24:00 on the fall-back day is not cut off', () => {
    const r = clipBlockToDay(new Date(2026, 10, 1, 23, 0), new Date(2026, 10, 2, 0, 0), fallBack(), HH);
    expect(r.top).toBe(23 * HH);
    expect(r.height).toBe(HH - 2);
  });

  it('9:00 on the spring-forward day sits in the 9:00 row', () => {
    const r = clipBlockToDay(new Date(2027, 2, 14, 9, 0), new Date(2027, 2, 14, 10, 0), springForward(), HH);
    expect(r.top).toBe(9 * HH);
  });

  it('a block running past midnight ends at the bottom of the grid', () => {
    const r = clipBlockToDay(new Date(2027, 2, 14, 22, 0), new Date(2027, 2, 15, 1, 0), springForward(), HH);
    expect(r.top).toBe(22 * HH);
    expect(r.height).toBe(2 * HH - 2);
  });

  it('a flight leaving at 23:30 on the fall-back day is on that day', () => {
    const trips = [
      {
        trip: { id: 't' },
        legs: [
          {
            id: 'l',
            departAt: new Date(2026, 10, 1, 23, 30).toISOString(),
            arriveAt: new Date(2026, 10, 2, 7, 0).toISOString(),
          },
        ],
      },
    ] as unknown as TripStatus[];
    expect(legsForDay(trips, fallBack()).map((l) => l.id)).toEqual(['l']);
  });
});

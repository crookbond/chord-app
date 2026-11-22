/**
 * Reported 2026-11-19: the calendar drew every trip flight twice, once as its
 * own calendar event (ADR 0158) and again as the trip's leg block. The real
 * rows: Delta 2503 ORD→LGA, the leg-made event on the Family calendar, and a
 * family member's pulled copy of it that carries only the trip it is filed
 * under (no leg uid).
 */
import { describe, expect, it } from 'vitest';

import { legsNotOnCalendar, type CalendarEventForLeg } from '@chord/kernel';

const leg = {
  id: 'leg_RuA1wmoJuhQ6',
  tripId: 'tr_Nxu10rUAmS26',
  origin: 'ORD',
  destination: 'LGA',
  departAt: '2026-11-20T21:20:00-05:00',
  flightNo: '2503',
};

describe('a flight with its own calendar event is drawn once', () => {
  it('the leg-made event hides the leg', () => {
    const events: CalendarEventForLeg[] = [
      {
        startsAt: '2026-11-21T02:20:00Z',
        title: 'Delta 2503 ORD→LGA',
        location: 'ORD → LGA',
        externalUid: 'chord:travel_leg:leg_RuA1wmoJuhQ6',
      },
    ];
    expect(legsNotOnCalendar([leg], events)).toEqual([]);
  });

  it("a pulled copy filed under the leg's trip hides it", () => {
    expect(
      legsNotOnCalendar([leg], [{ startsAt: '2026-11-21T02:20:00Z', title: 'Anything', tripId: 'tr_Nxu10rUAmS26' }]),
    ).toEqual([]);
  });

  it('an event naming the flight number at that moment hides it', () => {
    expect(
      legsNotOnCalendar([leg], [{ startsAt: '2026-11-21T02:20:00Z', title: 'Ben DL2503 home' }]),
    ).toEqual([]);
  });

  it('something else at that moment does not', () => {
    expect(
      legsNotOnCalendar([leg], [{ startsAt: '2026-11-21T02:20:00Z', title: 'Dinner with the Patels' }]),
    ).toEqual([leg]);
  });

  it('the same flight at another time does not', () => {
    expect(
      legsNotOnCalendar(
        [leg],
        [{ startsAt: '2026-11-21T02:25:00Z', title: 'Delta DL2503 ORD→LGA', externalUid: 'chord:travel_leg:leg_xV0ni' }],
      ),
    ).toEqual([leg]);
  });
});

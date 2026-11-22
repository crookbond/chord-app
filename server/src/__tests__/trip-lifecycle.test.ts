/**
 * ADR 0046 — trip-archive classification. Pure kernel helpers shared with the
 * mobile Trips/Files tabs; exercised here because mobile has no test runner.
 */
import { describe, expect, it } from 'vitest';

import {
  isTripArchived,
  archivedSourceDocIds,
  isoDay,
  type TripStatus,
} from '@chord/kernel';

const trip = (
  startDate: string,
  endDate: string,
  opts: { legDoc?: string; stayDoc?: string } = {},
): TripStatus => ({
  trip: {
    id: `t-${startDate}`,
    groupId: 'g1',
    name: 'Trip',
    destination: 'Dest',
    startDate,
    endDate,
    participants: [],
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
  },
  legs: opts.legDoc
    ? [
        {
          id: 'l1',
          tripId: `t-${startDate}`,
          personaId: null,
          mode: 'flight',
          origin: 'A',
          destination: 'B',
          departAt: `${startDate}T09:00:00Z`,
          arriveAt: `${startDate}T12:00:00Z`,
          sourceDocId: opts.legDoc,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ]
    : [],
  accommodations: opts.stayDoc
    ? [
        {
          id: 'a1',
          tripId: `t-${startDate}`,
          propertyName: 'Hotel',
          checkinDate: startDate,
          checkoutDate: endDate,
          sourceDocId: opts.stayDoc,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ]
    : [],
  reservations: [],
  participantNames: [],
  narrative: '',
  gaps: [],
  legGaps: [],
});

describe('isTripArchived', () => {
  const today = '2026-06-08';

  it('archives a trip whose last day has passed', () => {
    expect(isTripArchived('2026-06-07', today)).toBe(true);
  });

  it('keeps a trip ending today live (boundary is exclusive)', () => {
    expect(isTripArchived('2026-06-08', today)).toBe(false);
  });

  it('keeps a future trip live', () => {
    expect(isTripArchived('2026-09-01', today)).toBe(false);
  });
});

describe('isoDay', () => {
  it('formats a date as YYYY-MM-DD', () => {
    expect(isoDay(new Date('2026-06-08T15:47:00Z'))).toBe('2026-06-08');
  });
});

describe('archivedSourceDocIds', () => {
  const today = '2026-06-08';

  it('collects source docs from past trips only', () => {
    const past = trip('2026-01-10', '2026-01-20', { legDoc: 'att-past-leg', stayDoc: 'att-past-stay' });
    const future = trip('2026-09-01', '2026-09-05', { legDoc: 'att-future-leg' });
    const ids = archivedSourceDocIds([past, future], today);
    expect([...ids].sort()).toEqual(['att-past-leg', 'att-past-stay']);
    expect(ids.has('att-future-leg')).toBe(false);
  });

  it('ignores legs/stays without a source doc', () => {
    const past = trip('2026-01-10', '2026-01-20');
    expect(archivedSourceDocIds([past], today).size).toBe(0);
  });

  it('returns an empty set when there are no trips', () => {
    expect(archivedSourceDocIds([], today).size).toBe(0);
  });
});

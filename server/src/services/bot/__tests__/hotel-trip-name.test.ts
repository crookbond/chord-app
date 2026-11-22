/**
 * A hotel-only trip is titled after its CITY ("Trip to Vail"), never the
 * property name — a cancelled-and-rebooked hotel must read as the same trip,
 * not a new one named after whichever property happened to be booked last.
 */
import { describe, expect, it } from 'vitest';

import { hotelTripCity } from '@/services/bot/trip_classifier.js';

describe('hotelTripCity', () => {
  it('prefers the classifier-supplied city', () => {
    expect(hotelTripCity({ propertyName: 'Residence Inn by Marriott Vail', city: 'Vail' })).toBe('Vail');
  });

  it('falls back to parsing the city out of a full street address', () => {
    expect(
      hotelTripCity({
        propertyName: 'Residence Inn by Marriott Vail',
        address: '1783 N. Frontage Road, Vail, CO, United States of America, 81657',
      }),
    ).toBe('Vail');
  });

  it('falls back to a bare "City, ST" address', () => {
    expect(hotelTripCity({ propertyName: 'Some Hotel', address: 'Vail, CO' })).toBe('Vail');
  });

  it('returns undefined (caller falls back to the property name) with no address or city', () => {
    expect(hotelTripCity({ propertyName: 'Residence Inn by Marriott Vail' })).toBeUndefined();
  });
});

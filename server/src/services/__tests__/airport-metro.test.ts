/**
 * Airport → metro matching for trip-leg continuity (get_trip_status's
 * legGaps). The whole reason this table exists: a NYC itinerary departing
 * LGA and returning to JFK is not a broken connection, it's how the metro
 * works — exact string equality on airport codes would flag it as one.
 */
import { describe, expect, it } from 'vitest';

import { resolveMetro, sameMetro } from '@chord/kernel';

describe('resolveMetro', () => {
  it('resolves bare IATA codes', () => {
    expect(resolveMetro('JFK')).toBe('nyc');
    expect(resolveMetro('lga')).toBe('nyc');
    expect(resolveMetro('DEN')).toBe('DEN');
  });

  it('resolves an embedded code in parentheses', () => {
    expect(resolveMetro('New York (JFK)')).toBe('nyc');
    expect(resolveMetro('Newark Liberty (EWR)')).toBe('nyc');
  });

  it('resolves a bare city name, with or without a state/country suffix', () => {
    expect(resolveMetro('New York')).toBe('nyc');
    expect(resolveMetro('New York, NY')).toBe('nyc');
    expect(resolveMetro('Denver, CO')).toBe('DEN');
    expect(resolveMetro('Vail')).toBe('EGE');
  });

  it('resolves a named airport that is not the metro\'s own display city', () => {
    expect(resolveMetro('LaGuardia Airport')).toBe('nyc');
    expect(resolveMetro("O'Hare International Airport")).toBe('chicago');
    expect(resolveMetro('Heathrow')).toBe('london');
  });

  it('returns null for unrecognized text rather than guessing', () => {
    expect(resolveMetro('Grandma\'s House')).toBeNull();
    expect(resolveMetro('')).toBeNull();
    expect(resolveMetro(null)).toBeNull();
    expect(resolveMetro(undefined)).toBeNull();
  });
});

describe('sameMetro', () => {
  it('treats a metro\'s airports as interchangeable', () => {
    expect(sameMetro('LGA', 'JFK')).toBe(true);
    expect(sameMetro('EWR', 'New York')).toBe(true);
    expect(sameMetro("O'Hare", 'Midway')).toBe(true);
  });

  it('resolves the "<city> <airport>" spellings real prod itineraries print', () => {
    // Real strings from ownertest@gmail.com's trips: the same leg was stored with
    // ORD/LGA and, restated, with these.
    expect(sameMetro("Chicago O'Hare International", 'ORD')).toBe(true);
    expect(sameMetro('New York La Guardia', 'LGA')).toBe(true);
    expect(sameMetro('New York La Guardia', 'JFK')).toBe(true);
  });

  it('flags a real mismatch between two known places', () => {
    expect(sameMetro('LGA', 'DEN')).toBe(false);
    expect(sameMetro('Denver', 'Vail')).toBe(false);
  });

  it('returns null (not false) when either side is unrecognized — never a false positive', () => {
    expect(sameMetro('LGA', 'Grandma\'s House')).toBeNull();
    expect(sameMetro('Nowhereville', 'Nowhereland')).toBeNull();
  });
});

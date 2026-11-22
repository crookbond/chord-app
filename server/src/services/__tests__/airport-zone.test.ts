/**
 * A ticket prints each time on the clock of the airport it happens at. This
 * is the lookup that says which clock.
 */
import { describe, expect, it } from 'vitest';

import { airportTimeZone } from '@chord/kernel';

describe('airportTimeZone', () => {
  it('resolves the two ends of the reported flight', () => {
    expect(airportTimeZone('DEL')).toBe('Asia/Kolkata');
    expect(airportTimeZone('JFK')).toBe('America/New_York');
  });

  it('resolves what a document prints, not only a bare code', () => {
    expect(airportTimeZone('Delhi')).toBe('Asia/Kolkata');
    expect(airportTimeZone('New York (EWR)')).toBe('America/New_York');
    expect(airportTimeZone('New York La Guardia')).toBe('America/New_York');
    expect(airportTimeZone('Denver, CO')).toBe('America/Denver');
  });

  it("answers null for a place it does not know - never a guess", () => {
    expect(airportTimeZone('XQZ')).toBeNull();
    expect(airportTimeZone('Somewhere Regional')).toBeNull();
    expect(airportTimeZone(null)).toBeNull();
    expect(airportTimeZone('')).toBeNull();
  });

  it('names a zone the runtime accepts for every airport it knows', () => {
    for (const code of ['LHR', 'CDG', 'NRT', 'SYD', 'HNL', 'PHX', 'IND', 'EZE', 'NBO', 'YYC', 'DOH', 'HBE']) {
      const tz = airportTimeZone(code);
      expect(tz, code).not.toBeNull();
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz! }), code).not.toThrow();
    }
  });
});

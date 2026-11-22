/**
 * PR-F — URL builder unit tests for the four deep-link providers.
 * Pure functions; no DB, no LLM. Asserts on hostname + key params so we
 * notice if a provider's accepted query shape drifts under our feet.
 */
import { describe, expect, it } from 'vitest';

import { buildExternalAction } from '@/services/bot/external-actions.js';
import { toolSchemas } from '@/services/bot/tools.js';

/**
 * ADR 0138 widened the builder to `BuiltAction | null` so `flight_status` can
 * refuse an airline it cannot name. Every kind asserted here always builds, so
 * they unwrap through this rather than each carrying a null check.
 */
function built(...args: Parameters<typeof buildExternalAction>) {
  const r = buildExternalAction(...args);
  if (!r) throw new Error(`expected a built action for ${args[0]}`);
  return r;
}

describe('buildExternalAction — restaurant', () => {
  it('a NAMED restaurant opens its Google Maps place page (ADR 0153)', () => {
    // Maps' place panel carries the "Reserve a table" button, which routes to
    // whatever system the restaurant uses — an OpenTable search 0-results for
    // a Resy-only place, and a dead card reads as Chord's mistake.
    const r = built('restaurant', {
      restaurantName: 'Lilia',
      city: 'Brooklyn',
      partySize: 4,
      dateTime: '2026-06-12T19:00:00-04:00',
    });
    expect(r.provider).toBe('Google Maps');
    const u = new URL(r.url);
    expect(u.hostname).toBe('www.google.com');
    expect(u.pathname).toBe('/maps/search/');
    expect(u.searchParams.get('query')).toBe('Lilia Brooklyn');
    // Party size / time have no Maps param — they stay in the subtitle.
    expect(r.meta).toContain('Lilia');
    expect(r.meta).toContain('4 guests');
    expect(r.meta).toContain('19:00');
  });

  it('an UNNAMED request opens a Google Maps "restaurants in <city>" search (ADR 0153)', () => {
    const r = built('restaurant', {
      city: 'Brooklyn',
      partySize: 4,
      dateTime: '2026-06-12T19:00:00-04:00',
    });
    expect(r.provider).toBe('Google Maps');
    const u = new URL(r.url);
    expect(u.hostname).toBe('www.google.com');
    expect(u.pathname).toBe('/maps/search/');
    expect(u.searchParams.get('query')).toBe('restaurants in Brooklyn');
    // Party size / time have no Maps URL param — they stay in the subtitle.
    expect(r.meta).toContain('4 guests');
  });

  it('handles a single-guest party as singular', () => {
    const r = built('restaurant', { partySize: 1 });
    expect(r.meta).toContain('1 guest');
    expect(r.meta).not.toContain('1 guests');
  });

  it('a bare "restaurants" search when nothing is given', () => {
    const r = built('restaurant', {});
    expect(r.provider).toBe('Google Maps');
    expect(new URL(r.url).searchParams.get('query')).toBe('restaurants');
    expect(r.meta).toBe('');
  });

  it('encodes spaces and unicode safely in the place query', () => {
    const r = built('restaurant', { restaurantName: 'Café Münch — Söder' });
    const u = new URL(r.url);
    expect(u.searchParams.get('query')).toBe('Café Münch — Söder');
  });
});

describe('buildExternalAction — takeout', () => {
  it('routes to doordash.com with the restaurant name slugged into the path', () => {
    const r = built('takeout', { restaurantName: 'Pure Thai' });
    expect(r.provider).toBe('DoorDash');
    const u = new URL(r.url);
    expect(u.hostname).toBe('www.doordash.com');
    expect(u.pathname).toBe('/search/store/Pure+Thai/');
    expect(r.meta).toContain('Pure Thai');
  });

  it('falls back to the city when no restaurant name is given', () => {
    const r = built('takeout', { city: 'Brooklyn' });
    const u = new URL(r.url);
    expect(u.pathname).toBe('/search/store/Brooklyn/');
  });

  it('returns the bare doordash home page when nothing is provided', () => {
    const r = built('takeout', {});
    expect(r.url).toBe('https://www.doordash.com/');
    expect(r.meta).toBe('');
  });
});

describe('buildExternalAction — find_person', () => {
  it('returns the iCloud Find My URL with the person name surfaced as meta', () => {
    const r = built('find_person', { q: 'Alice' });
    expect(r.provider).toBe('Find My');
    expect(r.url).toBe('https://www.icloud.com/find/');
    expect(r.meta).toBe('Looking for Alice');
  });

  it('falls back to restaurantName slot when q is missing', () => {
    const r = built('find_person', { restaurantName: 'Ananya' });
    expect(r.meta).toBe('Looking for Ananya');
  });

  it('returns the bare URL with empty meta when no name is given', () => {
    const r = built('find_person', {});
    expect(r.url).toBe('https://www.icloud.com/find/');
    expect(r.meta).toBe('');
  });

  it('emits findmy:// as the native-app deep link alongside the web URL', () => {
    // The Chord mobile app tries appUrl first (Linking.canOpenURL), then
    // falls back to url. Bridged surfaces ignore appUrl. Pin both so a
    // regression on either field shows up loud.
    const r = built('find_person', { q: 'Alice' });
    expect(r.appUrl).toBe('findmy://');
    expect(r.url).toBe('https://www.icloud.com/find/');
  });
});

describe('buildExternalAction — map', () => {
  it('routes to the universal Google Maps search URL', () => {
    const r = built('map', { q: 'Eiffel Tower, Paris' });
    expect(r.provider).toBe('Google Maps');
    const u = new URL(r.url);
    expect(u.hostname).toBe('www.google.com');
    expect(u.pathname).toBe('/maps/search/');
    expect(u.searchParams.get('api')).toBe('1');
    expect(u.searchParams.get('query')).toBe('Eiffel Tower, Paris');
    expect(r.meta).toBe('Eiffel Tower, Paris');
  });

  it('falls back to restaurantName / activity / city when q is missing', () => {
    const r = built('map', { restaurantName: 'Consulate' });
    const u = new URL(r.url);
    expect(u.searchParams.get('query')).toBe('Consulate');
  });

  it('returns a usable URL with no query fields', () => {
    const r = built('map', {});
    expect(() => new URL(r.url)).not.toThrow();
    expect(r.meta).toBe('');
  });
});

describe('buildExternalAction — recipe', () => {
  it('routes to allrecipes.com with the search term encoded', () => {
    const r = built('recipe', { q: 'thai green curry' });
    expect(r.provider).toBe('AllRecipes');
    const u = new URL(r.url);
    expect(u.hostname).toBe('www.allrecipes.com');
    expect(u.pathname).toBe('/search');
    expect(u.searchParams.get('q')).toBe('thai green curry');
    expect(r.meta).toBe('thai green curry');
  });

  it('falls back to activity when q is missing', () => {
    const r = built('recipe', { activity: 'biryani' });
    const u = new URL(r.url);
    expect(u.searchParams.get('q')).toBe('biryani');
  });

  it('returns the bare AllRecipes home page when no term is given', () => {
    const r = built('recipe', {});
    expect(r.url).toBe('https://www.allrecipes.com/');
    expect(r.meta).toBe('');
  });

  it('encodes spaces and unicode safely', () => {
    const r = built('recipe', { q: 'Café Münch — Söder' });
    const u = new URL(r.url);
    expect(u.searchParams.get('q')).toBe('Café Münch — Söder');
  });
});

describe('buildExternalAction — flight', () => {
  it('routes to google.com/travel/flights', () => {
    const r = built('flight', {
      origin: 'SEA',
      destination: 'JFK',
      departDate: '2026-08-01',
      returnDate: '2026-08-08',
    });
    expect(r.provider).toBe('Google Flights');
    const u = new URL(r.url);
    expect(u.hostname).toBe('www.google.com');
    expect(u.pathname).toBe('/travel/flights');
    expect(r.meta).toContain('SEA → JFK');
    expect(r.meta).toContain('depart 2026-08-01');
    expect(r.meta).toContain('return 2026-08-08');
  });

  it('falls back to one-way meta when only destination is set', () => {
    const r = built('flight', { destination: 'JFK' });
    expect(r.meta).toContain('to JFK');
    expect(r.meta).not.toContain('→');
  });

  it('carries destination and both dates into the URL, not just the meta (ADR 0153)', () => {
    const r = built('flight', {
      origin: 'BOS',
      destination: 'Lisbon',
      departDate: '2026-05-03',
      returnDate: '2026-05-10',
    });
    const q = new URL(r.url).searchParams.get('q') ?? '';
    expect(q).toContain('from BOS');
    expect(q).toContain('to Lisbon');
    expect(q).toContain('2026-05-03');
    expect(q).toContain('2026-05-10');
  });
});

describe('buildExternalAction — flight_status (ADR 0138)', () => {
  it('builds a FlightAware link from a designator', () => {
    const r = built('flight_status', { flightNumber: 'UA512' });
    expect(r.provider).toBe('FlightAware');
    expect(r.url).toBe('https://www.flightaware.com/live/flight/UAL512');
  });

  it('accepts the spaced form people actually type', () => {
    expect(built('flight_status', { flightNumber: 'dl 1231' }).url).toBe(
      'https://www.flightaware.com/live/flight/DAL1231',
    );
  });

  // The whole point of the table: no ICAO ident, no correct URL, so no link.
  // A dead-ending tracker reads as Chord's mistake, not as a gap.
  it('refuses an airline it cannot name rather than guessing', () => {
    expect(buildExternalAction('flight_status', { flightNumber: 'ZZ999' })).toBeNull();
  });

  // A leg stores the airline in words ("Southwest Airlines" + "2714"), and
  // that is how the flights block used to print it.
  it('accepts an airline spelled out in words', () => {
    expect(built('flight_status', { flightNumber: 'Southwest Airlines 2714' }).url).toBe(
      'https://www.flightaware.com/live/flight/SWA2714',
    );
  });

  // Prod 2026-09-24: the model passed the user's United mileage number.
  it('refuses a mileage number', () => {
    expect(buildExternalAction('flight_status', { flightNumber: 'GL779135' })).toBeNull();
  });

  it('refuses when no flight number was supplied', () => {
    expect(buildExternalAction('flight_status', {})).toBeNull();
  });

  it('is a different question from `flight`, which searches for one to buy', () => {
    expect(built('flight', { origin: 'SEA', destination: 'JFK' }).provider).toBe('Google Flights');
  });
});

describe('buildExternalAction — hotel', () => {
  it('routes to Google Travel with a "hotels in <city>" query; dates ride the meta (ADR 0153)', () => {
    const r = built('hotel', {
      city: 'Tokyo',
      checkinDate: '2026-09-10',
      checkoutDate: '2026-09-15',
    });
    expect(r.provider).toBe('Google Hotels');
    const u = new URL(r.url);
    expect(u.hostname).toBe('www.google.com');
    expect(u.pathname).toBe('/travel/search');
    expect(u.searchParams.get('q')).toBe('hotels in Tokyo');
    expect(r.meta).toContain('Tokyo');
    expect(r.meta).toContain('2026-09-10 → 2026-09-15');
  });

  it('bare "hotels" query when no city is given', () => {
    const r = built('hotel', {});
    expect(new URL(r.url).searchParams.get('q')).toBe('hotels');
  });

  it('strips the datetime suffix from a check-in date in the meta', () => {
    const r = built('hotel', { checkinDate: '2026-09-10T00:00:00Z' });
    expect(r.meta).toContain('from 2026-09-10');
  });
});

describe('buildExternalAction — activity', () => {
  it('routes to Google Travel things-to-do with a combined term (ADR 0153)', () => {
    const r = built('activity', { activity: 'cooking class', city: 'Rome' });
    expect(r.provider).toBe('Google Things to do');
    const u = new URL(r.url);
    expect(u.hostname).toBe('www.google.com');
    expect(u.pathname).toBe('/travel/search');
    expect(u.searchParams.get('q')).toBe('cooking class in Rome');
  });

  it('falls back to "things to do in <city>" when no activity is named', () => {
    expect(new URL(built('activity', { city: 'Rome' }).url).searchParams.get('q')).toBe(
      'things to do in Rome',
    );
  });

  it('bare "things to do" when nothing is given', () => {
    expect(new URL(built('activity', {}).url).searchParams.get('q')).toBe('things to do');
  });
});

describe('suggest_external_action — input validation', () => {
  const schema = toolSchemas.suggest_external_action;

  it('accepts the minimum payload (kind + label)', () => {
    expect(schema.safeParse({ kind: 'restaurant', label: 'Book' }).success).toBe(true);
  });

  it('rejects unknown kind', () => {
    expect(schema.safeParse({ kind: 'pizza', label: 'Book' }).success).toBe(false);
  });

  it('accepts kind=recipe with a query.q term', () => {
    expect(
      schema.safeParse({
        kind: 'recipe',
        label: 'Search on AllRecipes',
        query: { q: 'thai green curry' },
      }).success,
    ).toBe(true);
  });

  it('rejects empty label', () => {
    expect(schema.safeParse({ kind: 'restaurant', label: '' }).success).toBe(false);
  });

  it('rejects partySize 0 / negative / non-integer', () => {
    for (const partySize of [0, -1, 1.5]) {
      const r = schema.safeParse({
        kind: 'restaurant',
        label: 'Book',
        query: { partySize },
      });
      expect(r.success).toBe(false);
    }
  });

  it('rejects partySize over the max (50)', () => {
    expect(
      schema.safeParse({
        kind: 'restaurant',
        label: 'Book',
        query: { partySize: 999 },
      }).success,
    ).toBe(false);
  });

  it('rejects malformed checkinDate', () => {
    expect(
      schema.safeParse({
        kind: 'hotel',
        label: 'Find a hotel',
        query: { checkinDate: '13/45/2026' },
      }).success,
    ).toBe(false);
  });

  it('accepts a full datetime in checkinDate (sliced to YYYY-MM-DD)', () => {
    expect(
      schema.safeParse({
        kind: 'hotel',
        label: 'Find a hotel',
        query: { checkinDate: '2026-09-10T00:00:00Z' },
      }).success,
    ).toBe(true);
  });

  it('defaults query to empty object when omitted', () => {
    const r = schema.safeParse({ kind: 'flight', label: 'Find flights' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.query).toEqual({});
  });
});

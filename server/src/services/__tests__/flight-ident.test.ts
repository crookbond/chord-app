import { describe, expect, it } from 'vitest';

import { airlineName, findFlight, flightTrackingUrl } from '@chord/kernel';

describe('findFlight', () => {
  it('resolves a cued designator to its ICAO ident', () => {
    const f = findFlight('Confirmation KX8QP2. Flight UA 512 departs Fri 6:40am, seat 14C.');
    expect(f?.ident).toBe('UAL512');
    expect(f?.number).toBe('512');
    expect(f?.airline).toBe('United Airlines');
    expect(f?.url).toBe('https://www.flightaware.com/live/flight/UAL512');
  });

  it('takes the sender as corroboration when the text gives no cue', () => {
    const f = findFlight('Your trip DL1231 is confirmed.', 'no-reply@e.delta.com');
    expect(f?.ident).toBe('DAL1231');
  });

  it('takes the airline being named as corroboration', () => {
    const f = findFlight('JetBlue has rebooked you onto B6 415.', 'trips@tripit.com');
    expect(f?.ident).toBe('JBU415');
  });

  // ADR 0133's rule, restated: a bare designator is an order number until
  // something vouches for it, and `Order` is not a cue.
  it('rejects an order number that happens to look like a designator', () => {
    expect(findFlight('Order AA1234 confirmed.', 'orders@shop.example')).toBeNull();
  });

  it('rejects a designator with no cue, no sender and no airline named', () => {
    expect(findFlight('Room B6 415 is ready for check-in.')).toBeNull();
  });

  it('never matches a record locator', () => {
    expect(findFlight('Your confirmation code is KX8QP2.')).toBeNull();
  });

  it('does not let an ordinary sentence corroborate itself', () => {
    // "United" alone is not an alias precisely so this cannot resolve.
    expect(findFlight('Shipping within the United States. Order UA1234.')).toBeNull();
  });

  it('is case-sensitive, so prose does not become a designator', () => {
    expect(findFlight('Please reply to 500 of our members by Friday.')).toBeNull();
  });

  it('keeps the number but refuses a URL for an airline it cannot name', () => {
    const f = findFlight('Flight PM230 departs at noon.');
    expect(f?.number).toBe('230');
    expect(f?.airline).toBeNull();
    expect(f?.ident).toBeNull();
    expect(f?.url).toBeNull();
  });

  it('rejects an unknown code with no cue, where nothing can vouch for it', () => {
    expect(findFlight('Unit PM230 has shipped.')).toBeNull();
  });

  it('prefers a resolvable flight over an unresolvable one', () => {
    const f = findFlight('Flight PM230 was rebooked to flight UA512.');
    expect(f?.ident).toBe('UAL512');
  });

  it('drops leading zeros for the ident but keeps them in the printed number', () => {
    const f = findFlight('Flight AF 009 to Paris.');
    expect(f?.number).toBe('009');
    expect(f?.ident).toBe('AFR9');
    expect(f?.url).toBe('https://www.flightaware.com/live/flight/AFR9');
  });

  it('does not fire on a cue word too far from the number', () => {
    expect(findFlight(`Flight information ${'-'.repeat(45)} AA1234`)).toBeNull();
  });

  it('returns null on empty text', () => {
    expect(findFlight('')).toBeNull();
  });
});

describe('flightTrackingUrl', () => {
  it('accepts a bare number plus an IATA carrier', () => {
    expect(flightTrackingUrl('UA', '512')).toBe('https://www.flightaware.com/live/flight/UAL512');
  });

  it('accepts a carrier name', () => {
    expect(flightTrackingUrl('United Airlines', '512')).toBe(
      'https://www.flightaware.com/live/flight/UAL512',
    );
  });

  it('accepts a flight number that already carries its designator', () => {
    expect(flightTrackingUrl('UA', 'UA512')).toBe('https://www.flightaware.com/live/flight/UAL512');
    expect(flightTrackingUrl(null, 'WN 1234')).toBe(
      'https://www.flightaware.com/live/flight/SWA1234',
    );
  });

  it('refuses an airline it does not know', () => {
    expect(flightTrackingUrl('XX', '1')).toBeNull();
    expect(flightTrackingUrl('Some Regional Air', '1')).toBeNull();
  });

  it('refuses when the embedded designator conflicts with a known carrier', () => {
    expect(flightTrackingUrl('United Airlines', 'XX512')).toBeNull();
  });

  it('refuses a missing or unusable number', () => {
    expect(flightTrackingUrl('UA', null)).toBeNull();
    expect(flightTrackingUrl('UA', '')).toBeNull();
    expect(flightTrackingUrl('UA', 'not-a-flight')).toBeNull();
  });
});

describe('airlineName', () => {
  it('resolves a code or a name, and refuses anything else', () => {
    expect(airlineName('B6')).toBe('JetBlue Airways');
    expect(airlineName('JetBlue')).toBe('JetBlue Airways');
    expect(airlineName('ZZ')).toBeNull();
  });
});

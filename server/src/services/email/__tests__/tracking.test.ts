/**
 * ADR 0135 — a tracking number names its own carrier, so the link is a
 * template rather than a model call.
 */
import { describe, expect, it } from 'vitest';

import { findTracking, trackingForStatedNumber, trackingUrl } from '@/services/email/tracking.js';

describe('findTracking', () => {
  it('recognises each carrier by the shape of its number', () => {
    expect(findTracking('Your package 1Z999AA10123456784 is on its way')).toMatchObject({
      carrier: 'UPS',
      number: '1Z999AA10123456784',
    });
    expect(findTracking('Label 9400111899223197428490')).toMatchObject({ carrier: 'USPS' });
    expect(findTracking('Tracking 123456789012')).toMatchObject({ carrier: 'FedEx' });
    expect(findTracking('AWB 1234567890')).toMatchObject({ carrier: 'DHL' });
  });

  it('builds the carrier’s own tracking URL', () => {
    const t = findTracking('1Z999AA10123456784')!;
    expect(t.url).toBe('https://www.ups.com/track?tracknum=1Z999AA10123456784');
    expect(trackingUrl('FedEx', '123456789012')).toContain('fedex.com/fedextrack');
    // An unknown carrier gets no invented URL.
    expect(trackingUrl('Hermes', '123')).toBeNull();
  });

  it('lets the sender settle a shape two carriers share', () => {
    // 20 digits is a valid FedEx label AND a valid USPS one; the sender knows.
    const twenty = '12345678901234567890';
    expect(findTracking(`Tracking ${twenty}`, 'ship@fedex.com')?.carrier).toBe('FedEx');
    expect(findTracking(`Tracking ${twenty}`, 'noreply@usps.com')?.carrier).toBe('USPS');
    // Subdomains count — shipping mail rarely comes from the bare domain.
    expect(findTracking(`Tracking ${twenty}`, 'auto@email.fedex.com')?.carrier).toBe('FedEx');
  });

  it('finds nothing rather than guessing', () => {
    expect(findTracking('Your order has shipped!')).toBeNull();
    expect(findTracking('')).toBeNull();
    // An order number is not a tracking number; too short to be any carrier.
    expect(findTracking('Order #12345')).toBeNull();
  });

  it('will not call a bare number a tracking number on shape alone', () => {
    // ADR 0133. A 12-digit run is a valid FedEx label AND a perfectly ordinary
    // order number; 10 digits is also a phone number. A wrong carrier link is
    // worse than no link, because it looks like an answer.
    expect(findTracking('Order 123456789012 confirmed')).toBeNull();
    expect(findTracking('Call 8005551234 with questions')).toBeNull();
    expect(findTracking('Your invoice total is 123456789012345')).toBeNull();
  });

  it('accepts a bare number once something corroborates it', () => {
    // Any one of three: the sender is the carrier, the carrier is named, or
    // the number is labelled where it appears.
    expect(findTracking('Package 123456789012 shipped', 'ship@fedex.com')?.carrier).toBe('FedEx');
    expect(findTracking('Your FedEx package, number 123456789012')?.carrier).toBe('FedEx');
    expect(findTracking('Tracking number: 123456789012')?.carrier).toBe('FedEx');
  });

  it('still reads an unmistakable shape with nothing around it', () => {
    // 1Z and the USPS 9[1-5] prefix name themselves, so they never needed a cue.
    expect(findTracking('1Z999AA10123456784')?.carrier).toBe('UPS');
    expect(findTracking('9400111899223197428490')?.carrier).toBe('USPS');
  });

  it('does not let a cue several sentences away vouch for a number', () => {
    // The cue has to be where the number is, or every order confirmation that
    // mentions shipping anywhere would qualify.
    const far = 'Tracking is available once we ship. ' + 'x'.repeat(60) + ' Order 123456789012';

    expect(findTracking(far)).toBeNull();
  });
});

describe('carriers beyond the big four', () => {
  it('recognises Amazon Logistics and links to Amazon’s own page', () => {
    expect(findTracking('Your package TBA305477112000 is out for delivery')).toMatchObject({
      carrier: 'Amazon',
      url: 'https://track.amazon.com/tracking/TBA305477112000',
    });
  });

  it('takes an international (S10) number only when its check digit holds', () => {
    // Serial 12345678 → check digit 5; the suffix names the postal operator.
    expect(findTracking('Parcel RA123456785US shipped')?.carrier).toBe('USPS');
    expect(findTracking('Parcel RA123456785CA shipped')?.carrier).toBe('Canada Post');
    expect(findTracking('Parcel RA123456785GB shipped')?.carrier).toBe('Royal Mail');
    // Same shape, wrong check digit: a reference code, not a tracking number.
    expect(findTracking('Parcel RA123456789US shipped')).toBeNull();
  });
});

describe('trackingForStatedNumber — a number the user hands over', () => {
  it('identifies the carrier from the shape, tolerating label spacing', () => {
    expect(trackingForStatedNumber('1z 999 aa1 01234 56784')).toEqual({
      ok: true,
      ref: {
        carrier: 'UPS',
        number: '1Z999AA10123456784',
        url: 'https://www.ups.com/track?tracknum=1Z999AA10123456784',
      },
    });
    expect(trackingForStatedNumber('9400 1118 9922 3197 4284 90')).toMatchObject({
      ok: true,
      ref: { carrier: 'USPS' },
    });
  });

  it('treats "track this" as the label, so a bare 12-digit number is FedEx', () => {
    // In an email this needs corroboration (ADR 0133); the user saying it is one.
    expect(trackingForStatedNumber('123456789012')).toMatchObject({ ok: true, ref: { carrier: 'FedEx' } });
    expect(trackingForStatedNumber('1234567890')).toMatchObject({ ok: true, ref: { carrier: 'DHL' } });
  });

  it('asks rather than guesses when two carriers share the shape', () => {
    expect(trackingForStatedNumber('12345678901234567890')).toEqual({
      ok: false,
      reason: 'ambiguous',
      carriers: ['USPS', 'FedEx'],
    });
    expect(trackingForStatedNumber('12345678901234567890', 'fed ex')).toMatchObject({
      ok: true,
      ref: { carrier: 'FedEx', url: 'https://www.fedex.com/fedextrack/?trknbr=12345678901234567890' },
    });
  });

  it('takes a named carrier at its word, even for a shape the table lacks', () => {
    expect(trackingForStatedNumber('ABC12345678', 'UPS')).toMatchObject({
      ok: true,
      ref: { carrier: 'UPS', number: 'ABC12345678' },
    });
  });

  it('builds nothing for an unknown carrier or an unrecognisable number', () => {
    expect(trackingForStatedNumber('C12345678901234', 'OnTrac')).toEqual({
      ok: false,
      reason: 'unrecognized',
    });
    expect(trackingForStatedNumber('ABC12345678')).toEqual({ ok: false, reason: 'unrecognized' });
    expect(trackingForStatedNumber('order #5')).toEqual({ ok: false, reason: 'unrecognized' });
  });
});

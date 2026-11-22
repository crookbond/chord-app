/**
 * ADR 0212 — what leaves the phone for a `contact.lookup`: only entries whose
 * name matches the query, with a birthday in the `important_dates` shape.
 */
import { describe, expect, it } from 'vitest';
import { deviceBirthdayToIsoDate, matchDeviceContacts } from '@chord/kernel';

describe('deviceBirthdayToIsoDate', () => {
  it('turns the 0-based month into a real one', () => {
    expect(deviceBirthdayToIsoDate({ day: 14, month: 2, year: 2014 })).toBe('2014-03-14');
  });

  it('writes an unknown year as 0000', () => {
    expect(deviceBirthdayToIsoDate({ day: 1, month: 0 })).toBe('0000-01-01');
  });

  it('drops a birthday it cannot place', () => {
    expect(deviceBirthdayToIsoDate(null)).toBeUndefined();
    expect(deviceBirthdayToIsoDate({ day: 3, month: 12 })).toBeUndefined();
  });
});

describe('matchDeviceContacts', () => {
  const book = [
    { name: 'Advait Kumar', emails: [{ email: 'ak@example.com' }] },
    { name: 'Ben Doe', emails: [{ email: 'ben@example.com' }, { email: 'BEN@example.com' }], phoneNumbers: [{ number: '555-0102' }] },
    { firstName: 'Priya', lastName: 'Shah', phoneNumbers: [{ number: '555-0199' }] },
    { name: 'Doe Plumbing' },
  ];

  it('sends only entries whose name matches every word asked about', () => {
    const out = matchDeviceContacts('Ben', book);
    expect(out.map((m) => m.name)).toEqual(['Ben Doe']);
    expect(out[0]!.emails).toEqual(['ben@example.com']);
    expect(out[0]!.phones).toEqual(['555-0102']);
  });

  it('matches on first + last name when the OS gives no display name', () => {
    expect(matchDeviceContacts('priya shah', book).map((m) => m.name)).toEqual(['Priya Shah']);
  });

  it('puts an exact full-name match first', () => {
    const out = matchDeviceContacts('doe', [...book, { name: 'Doe' }]);
    expect(out[0]!.name).toBe('Doe');
  });

  it('matches nothing for an empty query', () => {
    expect(matchDeviceContacts('  ', book)).toEqual([]);
  });
});

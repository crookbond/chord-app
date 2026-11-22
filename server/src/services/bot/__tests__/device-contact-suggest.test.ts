/**
 * ADR 0114 / 0157 addenda — phone contacts in the recipient field and as
 * event invitees, matched on the device.
 */
import { describe, expect, it } from 'vitest';
import {
  mergeRecipientSuggestions,
  parseGuestAddresses,
  pickInviteeFromDevice,
  suggestDeviceRecipients,
  type EmailRecipientSuggestion,
} from '@chord/kernel';

const book = [
  { name: 'Karl Dale', emails: [{ email: 'Karl@Media.example' }, { email: 'karl@home.com' }] },
  { firstName: 'Kara', lastName: 'Smith', emails: [{ email: 'ksmith@x.com' }] },
  { name: 'Milo Rao', emails: [] },
  { name: 'Ruth Chen', emails: [{ email: 'not-an-email' }, { email: 'ruth@chen.org' }] },
];

describe('suggestDeviceRecipients', () => {
  it('offers every address of a contact whose name starts with what was typed', () => {
    expect(suggestDeviceRecipients('kar', book).map((s) => s.email)).toEqual([
      'karl@media.example',
      'karl@home.com',
      'ksmith@x.com',
    ]);
  });

  it('matches several words against the name, in any order', () => {
    expect(suggestDeviceRecipients('dale ka', book).map((s) => s.email)).toEqual([
      'karl@media.example',
      'karl@home.com',
    ]);
  });

  it('matches the start of an address, after name matches', () => {
    const rows = suggestDeviceRecipients('ru', book);
    expect(rows).toEqual([{ email: 'ruth@chen.org', name: 'Ruth Chen', source: 'contacts' }]);
  });

  it('skips contacts without a usable address and needs two characters', () => {
    expect(suggestDeviceRecipients('milo', book)).toEqual([]);
    expect(suggestDeviceRecipients('k', book)).toEqual([]);
  });
});

describe('mergeRecipientSuggestions', () => {
  it('keeps the server order, adds phone rows after, one per address', () => {
    const server: EmailRecipientSuggestion[] = [
      { email: 'karl@home.com', name: null, source: 'correspondent' },
      { email: 'boss@work.com', name: 'Boss', source: 'person' },
    ];
    const device = suggestDeviceRecipients('kar', book);
    expect(mergeRecipientSuggestions(server, device)).toEqual([
      { email: 'karl@home.com', name: 'Karl Dale', source: 'correspondent' },
      { email: 'boss@work.com', name: 'Boss', source: 'person' },
      { email: 'karl@media.example', name: 'Karl Dale', source: 'contacts' },
      { email: 'ksmith@x.com', name: 'Kara Smith', source: 'contacts' },
    ]);
  });
});

describe('parseGuestAddresses', () => {
  it('keeps addresses, lowercased and once each, and returns the rest', () => {
    expect(parseGuestAddresses('Karl@Media.example, karl@media.example; Ruth <RUTH@chen.org>, Milo ,')).toEqual({
      emails: ['karl@media.example', 'ruth@chen.org'],
      invalid: ['Milo'],
    });
  });
});

describe('pickInviteeFromDevice', () => {
  it('takes the only contact found, at its first address', () => {
    expect(
      pickInviteeFromDevice('Karl', [
        { name: 'Karl Dale', emails: ['Karl@Media.example', 'karl@home.com'], phones: [] },
      ]),
    ).toEqual({ kind: 'email', email: 'karl@media.example', name: 'Karl Dale' });
  });

  it('asks when two contacts fit the name', () => {
    expect(
      pickInviteeFromDevice('Karl', [
        { name: 'Karl Dale', emails: ['k@a.com'], phones: [] },
        { name: 'Karl Mehta', emails: ['k@b.com'], phones: [] },
      ]),
    ).toEqual({
      kind: 'ambiguous',
      candidates: [
        { name: 'Karl Dale', email: 'k@a.com' },
        { name: 'Karl Mehta', email: 'k@b.com' },
      ],
    });
  });

  it('prefers the one whose full name is exactly what was asked', () => {
    expect(
      pickInviteeFromDevice('karl dale', [
        { name: 'Karl Dale', emails: ['k@a.com'], phones: [] },
        { name: 'Karl Dale-Shah', emails: ['k@b.com'], phones: [] },
      ]),
    ).toEqual({ kind: 'email', email: 'k@a.com', name: 'Karl Dale' });
  });

  it('finds nothing in contacts that have no address', () => {
    expect(pickInviteeFromDevice('Milo', [{ name: 'Milo Rao', emails: [], phones: ['555'] }])).toEqual({
      kind: 'none',
    });
  });
});

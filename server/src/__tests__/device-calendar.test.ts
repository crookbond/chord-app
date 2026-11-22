import { describe, expect, it } from 'vitest';

import { isGoogleBackedSource, pickAndroidWriteCalendar } from '@chord/kernel';

// What expo-calendar reports on each platform for the same Google account.
const IPHONE_GOOGLE = { name: 'Google (ann@gmail.com)', type: 'caldav' };
const ANDROID_GOOGLE = { name: 'ann@gmail.com', type: 'com.google' };

describe('isGoogleBackedSource', () => {
  it('recognises a Google account on an iPhone and on Android', () => {
    expect(isGoogleBackedSource(IPHONE_GOOGLE)).toBe(true);
    expect(isGoogleBackedSource(ANDROID_GOOGLE)).toBe(true);
  });

  it('does not mistake phone-only or other accounts for Google', () => {
    expect(isGoogleBackedSource({ name: 'Chord', type: 'LOCAL' })).toBe(false);
    expect(isGoogleBackedSource({ name: 'On My iPhone', type: 'local' })).toBe(false);
    expect(isGoogleBackedSource({ name: 'ann@contoso.com', type: 'com.android.exchange' })).toBe(false);
    expect(isGoogleBackedSource({ name: 'Holidays', type: 'subscribed' })).toBe(false);
    expect(isGoogleBackedSource(undefined)).toBe(false);
  });
});

describe('pickAndroidWriteCalendar', () => {
  const chord = { id: 'c', title: 'Chord', isPrimary: false, allowsModifications: true, source: { name: 'Chord', type: 'LOCAL' } };
  const holidays = {
    id: 'h',
    title: 'Holidays in United States',
    isPrimary: false,
    allowsModifications: false,
    source: ANDROID_GOOGLE,
  };
  const family = { id: 'f', title: 'Family', isPrimary: false, allowsModifications: true, source: ANDROID_GOOGLE };
  const primary = { id: 'p', title: 'ann@gmail.com', isPrimary: true, allowsModifications: true, source: ANDROID_GOOGLE };
  const samsung = { id: 's', title: 'My calendar', isPrimary: true, allowsModifications: true, source: { name: 'My calendar', type: 'LOCAL' } };

  it("prefers the Google account's own calendar, so the event reaches Google", () => {
    expect(pickAndroidWriteCalendar([chord, holidays, samsung, family, primary], 'Chord')).toBe('p');
  });

  it('takes another writable Google calendar when the primary one is not writable', () => {
    expect(pickAndroidWriteCalendar([holidays, family, samsung], 'Chord')).toBe('f');
  });

  it("falls back to the phone's primary calendar, never a read-only one or Chord's own", () => {
    expect(pickAndroidWriteCalendar([chord, holidays, samsung], 'Chord')).toBe('s');
    expect(pickAndroidWriteCalendar([chord, holidays], 'Chord')).toBeNull();
  });
});

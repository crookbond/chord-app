/**
 * Phone-calendar rules shared by the device write (ADR 0057) and the device
 * pull (ADR 0072). They live in kernel so they can be tested; the mobile
 * workspace has no test harness.
 */

/** What expo-calendar reports about the account a calendar belongs to. */
export interface DeviceCalendarSourceLike {
  name?: string;
  type?: string;
}

export interface DeviceCalendarLike {
  id: string;
  title: string;
  isPrimary?: boolean;
  allowsModifications?: boolean;
  source?: DeviceCalendarSourceLike;
}

/** Android's account type for a Google account's calendars. */
export const ANDROID_GOOGLE_ACCOUNT_TYPE = 'com.google';

/**
 * A phone calendar that is really a Google calendar. An iPhone holds one as a
 * CalDAV account, recognised by its name; an Android phone holds one under
 * Android's Google account type, whose name is the account's address.
 */
export function isGoogleBackedSource(source: DeviceCalendarSourceLike | undefined): boolean {
  const type = source?.type ?? '';
  if (type === ANDROID_GOOGLE_ACCOUNT_TYPE) return true;
  const name = (source?.name ?? '').toLowerCase();
  return type === 'caldav' && (name.includes('google') || name.includes('gmail') || name.includes('@'));
}

/**
 * ADR 0263 - the Android choice of where Chord writes an event, the same
 * order the iPhone uses (ADR 0057): a writable Google calendar first, its
 * account's primary calendar before the others, so the phone syncs the event
 * up to Google; then the phone's primary writable calendar. Null means none,
 * and the caller falls back to a calendar of Chord's own on the phone.
 */
export function pickAndroidWriteCalendar(
  calendars: DeviceCalendarLike[],
  ownCalendarTitle: string,
): string | null {
  const writable = calendars.filter(
    (c) => c.allowsModifications !== false && c.title !== ownCalendarTitle,
  );
  const google = writable.filter((c) => isGoogleBackedSource(c.source));
  return (
    google.find((c) => c.isPrimary)?.id ??
    google[0]?.id ??
    writable.find((c) => c.isPrimary)?.id ??
    null
  );
}
